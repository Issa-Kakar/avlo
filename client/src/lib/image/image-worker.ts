/**
 * Image Worker — handles ALL heavy image operations off the main thread.
 *
 * Two instances run: primary (upload queue + ingest + decode) and decoder (decode only).
 * Decode requests hash-routed by assetId from main thread. Each worker tracks latestGen
 * per assetId for staleness — superseded decodes are discarded immediately.
 *
 * Responsibilities:
 * - Cache API writes (local ingest blobs)
 * - Magic byte validation + SHA-256 hashing (primary only)
 * - Bitmap decode (createImageBitmap with dynamic resize for mip levels)
 * - Server upload (PUT /api/assets/:key, primary only, sequential queue with exponential backoff)
 * - IDB for upload queue metadata only (primary only)
 *
 * Reads via Cache API first, then fetch() as fallback (network or SW-intercepted).
 * This makes the worker self-sufficient regardless of SW presence (critical for dev mode).
 * Only ImageBitmaps cross back to main thread via Transferable (zero-copy).
 */

import { validateImage } from '@avlo/shared';

// ============================================================
// Message Types
// ============================================================

export type WorkerInbound =
  | { type: 'init'; role: 'primary' | 'decoder' }
  | { type: 'ingest'; id: string; blob: Blob }
  | {
      type: 'hydrate';
      visible: { assetId: string; level: 0 | 1 | 2; width: number; height: number; gen: number }[];
      prefetch: string[];
    }
  | {
      type: 'decode';
      assetId: string;
      level: 0 | 1 | 2;
      width: number;
      height: number;
      gen: number;
    }
  | { type: 'enqueue-upload'; assetId: string }
  | { type: 'delete-asset'; assetId: string }
  | { type: 'online' }
  | { type: 'drain-uploads' }
  | { type: 'cancel'; assetId: string }
  | { type: 'clear' };

export type WorkerOutbound =
  | {
      type: 'ingested';
      id: string;
      assetId: string;
      w: number;
      h: number;
      mime: string;
      bitmap: ImageBitmap;
      level: 0;
    }
  | { type: 'bitmap'; assetId: string; bitmap: ImageBitmap; level: 0 | 1 | 2; gen: number }
  | { type: 'uploaded'; assetId: string }
  | { type: 'error'; id?: string; assetId?: string; message: string; gen?: number };

// ============================================================
// IDB Layer (upload queue only)
// ============================================================

const DB_NAME = 'avlo-assets';
const DB_VERSION = 2;
const UPLOADS_STORE = 'uploads';

interface UploadEntry {
  retries: number;
  lastAttempt: number;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(UPLOADS_STORE)) db.createObjectStore(UPLOADS_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      dbPromise = null;
      reject(req.error);
    };
  });
  return dbPromise;
}

async function tx(store: string, mode: IDBTransactionMode): Promise<IDBObjectStore> {
  const db = await openDB();
  return db.transaction(store, mode).objectStore(store);
}

function idbOp<T>(
  fn: (store: IDBObjectStore) => IDBRequest,
): (store: IDBObjectStore) => Promise<T> {
  return (store) =>
    new Promise((resolve, reject) => {
      const req = fn(store);
      req.onsuccess = () => resolve(req.result as T);
      req.onerror = () => reject(req.error);
    });
}

async function getUploadEntry(assetId: string): Promise<UploadEntry | null> {
  const store = await tx(UPLOADS_STORE, 'readonly');
  const entry = await idbOp<UploadEntry | undefined>((s) => s.get(assetId))(store);
  return entry ?? null;
}

async function putUploadEntry(assetId: string, entry: UploadEntry): Promise<void> {
  const store = await tx(UPLOADS_STORE, 'readwrite');
  await idbOp<void>((s) => s.put(entry, assetId))(store);
}

async function removeUploadEntry(assetId: string): Promise<void> {
  const store = await tx(UPLOADS_STORE, 'readwrite');
  await idbOp<void>((s) => s.delete(assetId))(store);
}

async function getAllPendingUploadIds(): Promise<string[]> {
  const store = await tx(UPLOADS_STORE, 'readonly');
  return idbOp<string[]>((s) => s.getAllKeys() as IDBRequest<string[]>)(store);
}

// ============================================================
// Cache API Helpers
// ============================================================

const ASSET_CACHE = 'avlo-assets';

function assetUrl(id: string): string {
  return `/api/assets/${id}`;
}

async function deleteCachedAsset(id: string): Promise<void> {
  const cache = await caches.open(ASSET_CACHE);
  await cache.delete(assetUrl(id));
}

/**
 * Read an asset blob: cache-first, then network.
 * Works with or without Service Worker — checks Cache API directly first.
 * Caches network responses so future reads are local (essential in dev mode without SW).
 */
async function readAssetBlob(assetId: string): Promise<Blob | null> {
  const url = assetUrl(assetId);
  const cache = await caches.open(ASSET_CACHE);

  // Direct cache read (works regardless of SW presence)
  const cached = await cache.match(url);
  if (cached) return cached.blob();

  // Fall back to network (SW intercepts in prod; direct to server in dev)
  try {
    const resp = await fetch(url);
    if (!resp.ok) return null;
    // Cache the network response for future reads
    cache.put(url, resp.clone());
    return resp.blob();
  } catch {
    return null;
  }
}

// ============================================================
// Fetch Dedup
// ============================================================

const fetchPromises = new Map<string, Promise<Blob | null>>();

async function getAssetBlob(assetId: string): Promise<Blob | null> {
  const inflight = fetchPromises.get(assetId);
  if (inflight) return inflight;
  const promise = readAssetBlob(assetId);
  fetchPromises.set(assetId, promise);
  try {
    return await promise;
  } finally {
    fetchPromises.delete(assetId);
  }
}

// ============================================================
// Role & Staleness
// ============================================================

let role: 'primary' | 'decoder' = 'decoder';
const latestGen = new Map<string, number>();

// ============================================================
// Helpers
// ============================================================

function post(msg: WorkerOutbound, transfer?: Transferable[]): void {
  (self as unknown as Worker).postMessage(msg, transfer ?? []);
}

function errorMsg(message: string, id?: string, assetId?: string, gen?: number): void {
  post({ type: 'error', id, assetId, message, gen });
}

const HEX_LUT = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));

async function sha256Hex(buffer: ArrayBuffer): Promise<string> {
  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
  const bytes = new Uint8Array(hashBuffer);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) hex += HEX_LUT[bytes[i]];
  return hex;
}

// ============================================================
// Decode
// ============================================================

/**
 * Decode a blob at the requested mip level using dynamic resize and send bitmap to main thread.
 * Level 0: full-res decode. Level 1/2: createImageBitmap with resizeWidth/resizeHeight.
 * Three staleness checks (before fetch, after fetch, after decode) to discard superseded requests.
 */
async function decodeAndSend(
  assetId: string,
  level: 0 | 1 | 2,
  width: number,
  height: number,
  gen: number,
): Promise<void> {
  latestGen.set(assetId, Math.max(gen, latestGen.get(assetId) ?? -1));
  if (latestGen.get(assetId) !== gen) return;

  const blob = await getAssetBlob(assetId);
  if (!blob) throw new Error('asset not available');

  if (latestGen.get(assetId) !== gen) return;

  const bitmap =
    level === 0
      ? await createImageBitmap(blob)
      : await createImageBitmap(blob, {
          resizeWidth: width,
          resizeHeight: height,
          resizeQuality: 'medium',
        });

  if (latestGen.get(assetId) !== gen) {
    bitmap.close();
    return;
  }

  post({ type: 'bitmap', assetId, bitmap, level, gen }, [bitmap]);
}

// ============================================================
// Upload Queue (fully in-worker, primary only)
// ============================================================

const BASE_DELAY_MS = 1000;
const MAX_BACKOFF_MS = 60_000;
const SAFETY_INTERVAL_MS = 30_000;

let uploading = false;
let resetBackoff = false;

async function uploadOne(assetId: string, entry: UploadEntry): Promise<void> {
  // Read blob from cache (or network fallback)
  const blob = await readAssetBlob(assetId);
  if (!blob) {
    // Blob not available anywhere — drop upload entry
    await removeUploadEntry(assetId);
    return;
  }

  try {
    const resp = await fetch(assetUrl(assetId), { method: 'PUT', body: blob });

    if (resp.ok || resp.status === 409) {
      await removeUploadEntry(assetId);
      post({ type: 'uploaded', assetId });
      return;
    }

    const body = await resp.text().catch(() => '');

    // 4xx = permanent failure (bad format, too large, hash mismatch) — don't retry
    if (resp.status >= 400 && resp.status < 500) {
      console.warn('[image-worker] upload rejected (permanent):', assetId, resp.status, body);
      await removeUploadEntry(assetId);
      return;
    }

    throw new Error(`upload ${resp.status}: ${body}`);
  } catch (err) {
    console.warn('[image-worker] upload failed:', assetId, err);
    await putUploadEntry(assetId, {
      retries: entry.retries + 1,
      lastAttempt: Date.now(),
    });
  }
}

async function drainUploads(): Promise<void> {
  if (uploading) return;
  uploading = true;
  const ignoreBackoff = resetBackoff;
  resetBackoff = false;

  try {
    const ids = await getAllPendingUploadIds();
    for (const assetId of ids) {
      const entry = await getUploadEntry(assetId);
      if (!entry) continue;

      // Exponential backoff (no max retries — offline-first means retry forever)
      if (!ignoreBackoff && entry.lastAttempt > 0) {
        const delay = Math.min(BASE_DELAY_MS * Math.pow(2, entry.retries), MAX_BACKOFF_MS);
        const elapsed = Date.now() - entry.lastAttempt;
        if (elapsed < delay) continue;
      }

      await uploadOne(assetId, entry);
    }
  } finally {
    uploading = false;
  }
}

// ============================================================
// Message Handler
// ============================================================

self.onmessage = async (e: MessageEvent<WorkerInbound>) => {
  const msg = e.data;

  switch (msg.type) {
    case 'init': {
      role = msg.role;
      if (role === 'primary') {
        setInterval(drainUploads, SAFETY_INTERVAL_MS);
      }
      break;
    }

    case 'cancel': {
      latestGen.delete(msg.assetId);
      break;
    }

    case 'clear': {
      latestGen.clear();
      break;
    }

    case 'ingest': {
      if (role !== 'primary') break;
      const { id, blob } = msg;
      try {
        const buffer = await blob.arrayBuffer();
        const bytes = new Uint8Array(buffer);
        const { valid, mimeType: detectedMime } = validateImage(bytes);
        if (!valid) {
          errorMsg('unsupported image format', id);
          return;
        }
        const mime = detectedMime || blob.type || 'image/png';
        const assetId = await sha256Hex(buffer);

        // Dedup: check if already cached
        const cache = await caches.open(ASSET_CACHE);
        const existing = await cache.match(assetUrl(assetId));
        if (existing) {
          const cachedBlob = await existing.blob();
          const bitmap = await createImageBitmap(cachedBlob);
          post(
            {
              type: 'ingested',
              id,
              assetId,
              w: bitmap.width,
              h: bitmap.height,
              mime,
              bitmap,
              level: 0,
            },
            [bitmap],
          );
          return;
        }

        // New asset: decode + cache full blob
        const ingestBlob = new Blob([buffer], { type: mime });
        const fullBitmap = await createImageBitmap(ingestBlob);
        const w = fullBitmap.width;
        const h = fullBitmap.height;

        await cache.put(
          assetUrl(assetId),
          new Response(ingestBlob, {
            headers: { 'Content-Type': mime },
          }),
        );

        post({ type: 'ingested', id, assetId, w, h, mime, bitmap: fullBitmap, level: 0 }, [
          fullBitmap,
        ]);
      } catch (err) {
        errorMsg(err instanceof Error ? err.message : 'ingest failed', id);
      }
      break;
    }

    case 'hydrate': {
      const { visible, prefetch } = msg;
      // Fire-and-forget per item — results stream as each decode completes
      for (const { assetId, level, width, height, gen } of visible) {
        decodeAndSend(assetId, level, width, height, gen).catch((err) =>
          errorMsg(err instanceof Error ? err.message : 'hydrate failed', undefined, assetId, gen),
        );
      }
      // Offscreen: just fetch blob into cache (fire-and-forget)
      for (const assetId of prefetch) {
        getAssetBlob(assetId).catch(() => {});
      }
      break;
    }

    case 'decode': {
      decodeAndSend(msg.assetId, msg.level, msg.width, msg.height, msg.gen).catch((err) =>
        errorMsg(
          err instanceof Error ? err.message : 'decode failed',
          undefined,
          msg.assetId,
          msg.gen,
        ),
      );
      break;
    }

    case 'enqueue-upload': {
      if (role !== 'primary') break;
      try {
        const existing = await getUploadEntry(msg.assetId);
        if (existing) return; // Idempotent
        await putUploadEntry(msg.assetId, { retries: 0, lastAttempt: 0 });
        drainUploads();
      } catch (err) {
        console.warn('[image-worker] enqueue-upload failed:', msg.assetId, err);
      }
      break;
    }

    case 'delete-asset': {
      if (role !== 'primary') break;
      await deleteCachedAsset(msg.assetId).catch(() => {});
      await removeUploadEntry(msg.assetId).catch(() => {});
      break;
    }

    case 'online': {
      if (role !== 'primary') break;
      resetBackoff = true;
      drainUploads();
      break;
    }

    case 'drain-uploads': {
      if (role !== 'primary') break;
      drainUploads();
      break;
    }
  }
};
