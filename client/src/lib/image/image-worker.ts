/**
 * Image Worker — handles ALL heavy image operations off the main thread.
 *
 * Responsibilities:
 * - Cache API writes (local ingest blobs + generated mip variants)
 * - Magic byte validation + SHA-256 hashing
 * - Bitmap decode (createImageBitmap) with mip variant generation
 * - Mip blob pre-generation via OffscreenCanvas
 * - Server upload (PUT /api/assets/:key, sequential queue with exponential backoff)
 * - IDB for upload queue metadata only
 *
 * Reads via Cache API first, then fetch() as fallback (network or SW-intercepted).
 * This makes the worker self-sufficient regardless of SW presence (critical for dev mode).
 * Writes to Cache API for local ingest blobs, generated mip variants, and network responses.
 * Only ImageBitmaps cross back to main thread via Transferable (zero-copy).
 */

import { validateImage } from '@avlo/shared';
import type { FrameTuple, WorldBounds } from '@avlo/shared';

// ============================================================
// Message Types
// ============================================================

export type WorkerInbound =
  | { type: 'ingest'; id: string; blob: Blob }
  | { type: 'hydrate'; assets: { assetId: string; frame: FrameTuple; level: 0 | 1 | 2 }[]; viewport: WorldBounds }
  | { type: 'decode'; assetId: string; level: 0 | 1 | 2 }
  | { type: 'enqueue-upload'; assetId: string }
  | { type: 'delete-asset'; assetId: string }
  | { type: 'online' }
  | { type: 'drain-uploads' };

export type WorkerOutbound =
  | { type: 'ingested'; id: string; assetId: string; w: number; h: number; mime: string; bitmap: ImageBitmap; level: 0 }
  | { type: 'bitmap'; assetId: string; bitmap: ImageBitmap; level: 0 | 1 | 2 }
  | { type: 'uploaded'; assetId: string }
  | { type: 'error'; id?: string; assetId?: string; message: string };

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

function idbOp<T>(fn: (store: IDBObjectStore) => IDBRequest): (store: IDBObjectStore) => Promise<T> {
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

function mipUrl(id: string, level: 1 | 2): string {
  return `/api/assets/${id}?mip=${level === 1 ? 'half' : 'quarter'}`;
}

async function cacheBlob(url: string, blob: Blob): Promise<void> {
  const cache = await caches.open(ASSET_CACHE);
  await cache.put(url, new Response(blob, {
    headers: { 'Content-Type': blob.type || 'application/octet-stream' },
  }));
}

async function deleteCachedAsset(id: string): Promise<void> {
  const cache = await caches.open(ASSET_CACHE);
  await Promise.all([
    cache.delete(assetUrl(id)),
    cache.delete(mipUrl(id, 1)),
    cache.delete(mipUrl(id, 2)),
  ]);
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
// Helpers
// ============================================================

function post(msg: WorkerOutbound, transfer?: Transferable[]): void {
  (self as unknown as Worker).postMessage(msg, transfer ?? []);
}

function errorMsg(message: string, id?: string, assetId?: string): void {
  post({ type: 'error', id, assetId, message });
}

async function sha256Hex(buffer: ArrayBuffer): Promise<string> {
  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
  const hashArray = new Uint8Array(hashBuffer);
  let hex = '';
  for (let i = 0; i < hashArray.length; i++) {
    hex += hashArray[i].toString(16).padStart(2, '0');
  }
  return hex;
}

function frameBoundsIntersect(frame: FrameTuple, vp: WorldBounds): boolean {
  return (
    frame[0] < vp.maxX &&
    frame[0] + frame[2] > vp.minX &&
    frame[1] < vp.maxY &&
    frame[1] + frame[3] > vp.minY
  );
}

// ============================================================
// Mip Generation
// ============================================================

/**
 * Generate half and quarter resolution blobs from a decoded bitmap.
 * Non-fatal: returns empty object on failure (caller stores without mips).
 * Uses 2-step downscale (full -> half canvas -> quarter) for better quality.
 */
async function generateMips(
  fullBitmap: ImageBitmap,
  mime: string,
): Promise<{ half?: Blob; quarter?: Blob }> {
  const w = fullBitmap.width;
  const h = fullBitmap.height;
  const result: { half?: Blob; quarter?: Blob } = {};
  const outputType =
    mime === 'image/jpeg' || mime === 'image/png' || mime === 'image/webp' ? mime : 'image/png';

  let halfCanvas: OffscreenCanvas | null = null;

  try {
    if (w >= 512) {
      const hw = Math.round(w / 2);
      const hh = Math.round(h / 2);
      halfCanvas = new OffscreenCanvas(hw, hh);
      const ctx = halfCanvas.getContext('2d')!;
      ctx.drawImage(fullBitmap, 0, 0, hw, hh);
      result.half = await halfCanvas.convertToBlob({ type: outputType });
    }

    if (w >= 1024) {
      const qw = Math.round(w / 4);
      const qh = Math.round(h / 4);
      const quarterCanvas = new OffscreenCanvas(qw, qh);
      const ctx = quarterCanvas.getContext('2d')!;
      // 2-step downscale: draw from half canvas for better quality
      ctx.drawImage(halfCanvas ?? fullBitmap, 0, 0, qw, qh);
      result.quarter = await quarterCanvas.convertToBlob({ type: outputType });
    }
  } catch (err) {
    console.warn('[image-worker] mip generation failed (non-fatal):', err);
  }

  return result;
}

// ============================================================
// Ensure Fetched + Mips
// ============================================================

/**
 * In-flight ensure promises, keyed by assetId.
 * Coalesces concurrent decode requests for the same asset into one fetch + mip gen.
 */
const ensurePromises = new Map<string, Promise<void>>();

/** Tracks assets where mip generation was attempted this session (avoids re-checking small images). */
const mipsAttempted = new Set<string>();

/**
 * Ensure full blob is available and mips are generated.
 * Reads cache-first via readAssetBlob (works with or without SW).
 */
async function ensureFetched(assetId: string): Promise<void> {
  if (mipsAttempted.has(assetId)) return;

  let inflight = ensurePromises.get(assetId);
  if (inflight) return inflight;

  const promise = (async () => {
    // Check if mips already exist in cache
    const cache = await caches.open(ASSET_CACHE);
    if (await cache.match(mipUrl(assetId, 1))) {
      mipsAttempted.add(assetId);
      return;
    }

    // Read full blob (cache-first, then network)
    const blob = await readAssetBlob(assetId);
    if (!blob) throw new Error('asset not available');

    // Generate mips
    const bitmap = await createImageBitmap(blob);
    const mime = blob.type || 'image/png';
    const mips = await generateMips(bitmap, mime);
    bitmap.close();

    if (mips.half) await cacheBlob(mipUrl(assetId, 1), mips.half);
    if (mips.quarter) await cacheBlob(mipUrl(assetId, 2), mips.quarter);
    mipsAttempted.add(assetId);
  })();

  ensurePromises.set(assetId, promise);
  try {
    await promise;
  } finally {
    ensurePromises.delete(assetId);
  }
}

// ============================================================
// Decode
// ============================================================

/**
 * Decode a blob at the requested mip level and send bitmap to main thread.
 * Full-res: readAssetBlob (cache-first). Mips: direct cache read (worker-generated).
 */
async function decodeAndSend(assetId: string, level: 0 | 1 | 2): Promise<void> {
  let blob: Blob | undefined;

  if (level === 0) {
    const result = await readAssetBlob(assetId);
    if (!result) throw new Error('asset not available');
    blob = result;
  } else {
    // Mip: direct cache read (worker-generated data, never on network)
    const cache = await caches.open(ASSET_CACHE);
    const mipResp = await cache.match(mipUrl(assetId, level));
    if (mipResp) {
      blob = await mipResp.blob();
    } else if (level === 2) {
      // Quarter not generated — try half
      const halfResp = await cache.match(mipUrl(assetId, 1));
      if (halfResp) blob = await halfResp.blob();
    }

    if (!blob) {
      // No mips at all — fall back to full res
      const result = await readAssetBlob(assetId);
      if (!result) throw new Error('asset not available');
      blob = result;
    }
  }

  const bitmap = await createImageBitmap(blob);
  post({ type: 'bitmap', assetId, bitmap, level }, [bitmap]);
}

// ============================================================
// Concurrency Helper
// ============================================================

async function runConcurrent<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        await fn(items[idx]);
      }
    }),
  );
}

// ============================================================
// Upload Queue (fully in-worker)
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

// 30s safety interval — catches any uploads that fell through the cracks
setInterval(drainUploads, SAFETY_INTERVAL_MS);

// ============================================================
// Message Handler
// ============================================================

self.onmessage = async (e: MessageEvent<WorkerInbound>) => {
  const msg = e.data;

  switch (msg.type) {
    case 'ingest': {
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
            { type: 'ingested', id, assetId, w: bitmap.width, h: bitmap.height, mime, bitmap, level: 0 },
            [bitmap],
          );
          return;
        }

        // New asset: decode + mip gen
        const ingestBlob = new Blob([buffer], { type: mime });
        const fullBitmap = await createImageBitmap(ingestBlob);
        const w = fullBitmap.width;
        const h = fullBitmap.height;
        const mips = await generateMips(fullBitmap, mime);

        // Cache: full blob + mips (worker writes, SW serves on future fetches)
        await cacheBlob(assetUrl(assetId), ingestBlob);
        if (mips.half) await cacheBlob(mipUrl(assetId, 1), mips.half);
        if (mips.quarter) await cacheBlob(mipUrl(assetId, 2), mips.quarter);

        post({ type: 'ingested', id, assetId, w, h, mime, bitmap: fullBitmap, level: 0 }, [fullBitmap]);
      } catch (err) {
        errorMsg(err instanceof Error ? err.message : 'ingest failed', id);
      }
      break;
    }

    case 'hydrate': {
      const { assets, viewport } = msg;
      const visible = assets.filter((a) => frameBoundsIntersect(a.frame, viewport));
      const offscreen = assets.filter((a) => !frameBoundsIntersect(a.frame, viewport));

      // Visible first: ensure + decode (6 concurrent)
      runConcurrent(visible, 6, async ({ assetId, level }) => {
        try {
          await ensureFetched(assetId);
          await decodeAndSend(assetId, level);
        } catch (err) {
          errorMsg(err instanceof Error ? err.message : 'hydrate failed', undefined, assetId);
        }
      });

      // Offscreen: just ensure fetched (4 concurrent, fire-and-forget)
      runConcurrent(offscreen, 4, async ({ assetId }) => {
        ensureFetched(assetId).catch((err) =>
          errorMsg(err instanceof Error ? err.message : 'hydrate ensure failed', undefined, assetId),
        );
      });
      break;
    }

    case 'decode': {
      (async () => {
        try {
          await ensureFetched(msg.assetId);
          await decodeAndSend(msg.assetId, msg.level);
        } catch (err) {
          errorMsg(err instanceof Error ? err.message : 'decode failed', undefined, msg.assetId);
        }
      })();
      break;
    }

    case 'enqueue-upload': {
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
      mipsAttempted.delete(msg.assetId);
      await deleteCachedAsset(msg.assetId).catch(() => {});
      await removeUploadEntry(msg.assetId).catch(() => {});
      break;
    }

    case 'online': {
      resetBackoff = true;
      drainUploads();
      break;
    }

    case 'drain-uploads': {
      drainUploads();
      break;
    }
  }
};
