/**
 * Image Worker — handles ALL heavy image operations off the main thread.
 *
 * Responsibilities:
 * - IDB management (avlo-assets: blobs + uploads stores)
 * - Magic byte validation + SHA-256 hashing
 * - CDN fetch (blob download when not in IDB)
 * - Server upload (PUT /api/assets/:key, sequential queue with exponential backoff)
 * - Bitmap decode (createImageBitmap) with mip variant generation
 * - Mip blob pre-generation via OffscreenCanvas
 *
 * Main thread never touches IDB, raw blobs, CDN fetches, hashing, or upload HTTP calls.
 * Only ImageBitmaps cross back via Transferable (zero-copy).
 *
 * State machine:
 *   Per-asset fetch: (none) → fetchPromises entry → CDN fetch → IDB store → (done, entry removed)
 *   Per-asset decode: ensureInIdb → read IDB → createImageBitmap → transfer bitmap
 *   Upload queue: IDB uploads store is source of truth. Existence = needs upload.
 *
 * Error handling:
 *   - CDN 404/5xx: throws → main thread uses time-based cooldown before retry
 *   - Corrupt blob (createImageBitmap fails): throws → main thread marks as errored
 *   - IDB errors: propagate → main thread handles via cooldown retry
 *   - Mip generation failures: non-fatal (stored without mips, decodes work at full res)
 *   - Upload 4xx: permanent failure, removed from queue (no retry)
 *   - Upload 5xx / network error: exponential backoff (1s base, 60s cap, no max retries)
 */

import { validateImage } from '@avlo/shared';
import type { FrameTuple, WorldBounds } from '@avlo/shared';

// ============================================================
// Message Types
// ============================================================

export type WorkerInbound =
  | { type: 'ingest'; id: string; blob: Blob }
  | { type: 'hydrate'; assets: { assetId: string; frame: FrameTuple; level: 0 | 1 | 2 }[]; viewport: WorldBounds }
  | { type: 'ensure'; assetId: string }
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
// IDB Layer
// ============================================================

const DB_NAME = 'avlo-assets';
const DB_VERSION = 1;
const BLOBS_STORE = 'blobs';
const UPLOADS_STORE = 'uploads';

interface BlobEntry {
  blob: Blob;
  half?: Blob;
  quarter?: Blob;
  w: number;
  h: number;
  mime: string;
}

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
      if (!db.objectStoreNames.contains(BLOBS_STORE)) db.createObjectStore(BLOBS_STORE);
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

/**
 * Read blob entry, normalizing old format ({ blob, mimeType, size, storedAt })
 * to new format ({ blob, half?, quarter?, w, h, mime }).
 * w === 0 signals old entry needing dimension backfill.
 */
async function getBlobEntry(assetId: string): Promise<BlobEntry | null> {
  const store = await tx(BLOBS_STORE, 'readonly');
  const raw = await idbOp<Record<string, unknown> | undefined>((s) => s.get(assetId))(store);
  if (!raw || !(raw.blob instanceof Blob)) return null;

  return {
    blob: raw.blob,
    half: raw.half instanceof Blob ? raw.half : undefined,
    quarter: raw.quarter instanceof Blob ? raw.quarter : undefined,
    w: typeof raw.w === 'number' ? raw.w : 0,
    h: typeof raw.h === 'number' ? raw.h : 0,
    mime:
      typeof raw.mime === 'string'
        ? raw.mime
        : typeof raw.mimeType === 'string'
          ? raw.mimeType
          : 'image/png',
  };
}

async function putBlobEntry(assetId: string, entry: BlobEntry): Promise<void> {
  const store = await tx(BLOBS_STORE, 'readwrite');
  await idbOp<void>((s) => s.put(entry, assetId))(store);
}

async function deleteBlobEntry(assetId: string): Promise<void> {
  const store = await tx(BLOBS_STORE, 'readwrite');
  await idbOp<void>((s) => s.delete(assetId))(store);
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
 * Uses 2-step downscale (full → half canvas → quarter) for better quality.
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

function pickBlobForLevel(entry: BlobEntry, level: 0 | 1 | 2): Blob {
  if (level === 0) return entry.blob;
  if (level === 1) return entry.half ?? entry.blob;
  return entry.quarter ?? entry.half ?? entry.blob;
}

// ============================================================
// Fetch Dedup + Ensure
// ============================================================

/**
 * In-flight CDN fetch promises, keyed by assetId.
 * Coalesces concurrent ensure/decode requests for the same asset into one fetch.
 * Entries are deleted in the finally block after completion (success or failure).
 */
const fetchPromises = new Map<string, Promise<void>>();

async function fetchAndStore(assetId: string): Promise<void> {
  const resp = await fetch(`/api/assets/${assetId}`);
  if (!resp.ok) throw new Error(`CDN fetch ${resp.status}`);
  const blob = await resp.blob();

  // Validate magic bytes
  const bytes = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
  const { valid, mimeType: detectedMime } = validateImage(bytes);
  const mime = valid ? detectedMime : blob.type || 'image/png';

  // Decode once for dimensions + mip source
  const fullBitmap = await createImageBitmap(blob);
  const w = fullBitmap.width;
  const h = fullBitmap.height;

  // Generate mips (non-fatal)
  const mips = await generateMips(fullBitmap, mime);
  fullBitmap.close();

  await putBlobEntry(assetId, { blob, ...mips, w, h, mime });
}

/**
 * Ensure blob is in IDB (fetch from CDN if missing). Coalesces concurrent calls.
 *
 * Handles old IDB format migration (entries without w/h → backfill dimensions + mips).
 * Handles corrupt blobs (failed createImageBitmap → delete + re-fetch from CDN).
 *
 * Race condition safety: re-checks fetchPromises after async IDB read to prevent
 * duplicate fetches when multiple callers pass the initial check concurrently.
 */
async function ensureInIdb(assetId: string): Promise<void> {
  // Fast path: already fetching
  let inflight = fetchPromises.get(assetId);
  if (inflight) return inflight;

  // Check IDB
  const entry = await getBlobEntry(assetId);
  if (entry) {
    if (entry.w > 0) return; // Valid entry with dimensions

    // Old format: backfill dimensions + mips
    try {
      const bitmap = await createImageBitmap(entry.blob);
      const w = bitmap.width;
      const h = bitmap.height;
      const mips = await generateMips(bitmap, entry.mime);
      bitmap.close();
      await putBlobEntry(assetId, { ...entry, w, h, ...mips });
      return;
    } catch {
      // Corrupt blob in IDB — delete and re-fetch from CDN
      console.warn('[image-worker] corrupt blob in IDB, will re-fetch:', assetId);
      await deleteBlobEntry(assetId).catch(() => {});
    }
  }

  // Re-check after awaits — another caller may have started a fetch while we were reading IDB
  inflight = fetchPromises.get(assetId);
  if (inflight) return inflight;

  const promise = fetchAndStore(assetId);
  fetchPromises.set(assetId, promise);
  try {
    await promise;
  } finally {
    fetchPromises.delete(assetId);
  }
}

// ============================================================
// Decode
// ============================================================

async function decodeAndSend(assetId: string, level: 0 | 1 | 2): Promise<void> {
  const entry = await getBlobEntry(assetId);
  if (!entry) throw new Error('no blob in IDB after ensure');
  const blob = pickBlobForLevel(entry, level);
  const bitmap = await createImageBitmap(blob);
  post({ type: 'bitmap', assetId, bitmap, level }, [bitmap]);
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
  const blobEntry = await getBlobEntry(assetId);
  if (!blobEntry) {
    // Blob was deleted (e.g., asset removed from board) — drop upload entry
    await removeUploadEntry(assetId);
    return;
  }

  try {
    const resp = await fetch(`/api/assets/${assetId}`, { method: 'PUT', body: blobEntry.blob });

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

        // Dedup: check IDB for existing complete entry
        const existing = await getBlobEntry(assetId);
        if (existing && existing.w > 0) {
          const bitmap = await createImageBitmap(existing.blob);
          post(
            { type: 'ingested', id, assetId, w: existing.w, h: existing.h, mime: existing.mime, bitmap, level: 0 },
            [bitmap],
          );
          return;
        }

        // Decode for dimensions + mip generation
        const ingestBlob = new Blob([buffer], { type: mime });
        const fullBitmap = await createImageBitmap(ingestBlob);
        const w = fullBitmap.width;
        const h = fullBitmap.height;

        // Generate mips (non-fatal)
        const mips = await generateMips(fullBitmap, mime);

        // Store in IDB
        await putBlobEntry(assetId, { blob: ingestBlob, ...mips, w, h, mime });

        // Transfer bitmap to main thread (fullBitmap is neutered after transfer)
        post({ type: 'ingested', id, assetId, w, h, mime, bitmap: fullBitmap, level: 0 }, [fullBitmap]);
      } catch (err) {
        errorMsg(err instanceof Error ? err.message : 'ingest failed', id);
      }
      break;
    }

    case 'hydrate': {
      const { assets, viewport } = msg;
      for (const { assetId, frame, level } of assets) {
        const visible = frameBoundsIntersect(frame, viewport);
        if (visible) {
          // Ensure + decode visible assets
          (async () => {
            try {
              await ensureInIdb(assetId);
              await decodeAndSend(assetId, level);
            } catch (err) {
              errorMsg(err instanceof Error ? err.message : 'hydrate decode failed', undefined, assetId);
            }
          })();
        } else {
          // Just ensure non-visible assets are cached in IDB
          ensureInIdb(assetId).catch((err) => {
            errorMsg(err instanceof Error ? err.message : 'hydrate ensure failed', undefined, assetId);
          });
        }
      }
      break;
    }

    case 'ensure': {
      ensureInIdb(msg.assetId).catch((err) => {
        errorMsg(err instanceof Error ? err.message : 'ensure failed', undefined, msg.assetId);
      });
      break;
    }

    case 'decode': {
      (async () => {
        try {
          await ensureInIdb(msg.assetId);
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
      await deleteBlobEntry(msg.assetId).catch(() => {});
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
