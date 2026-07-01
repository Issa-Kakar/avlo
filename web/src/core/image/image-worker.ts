/**
 * Image Worker — handles ALL heavy image operations off the main thread.
 *
 * N identical instances form a hardware-scaled, work-stealing decode pool. Decode
 * COMMANDS arrive through a SharedArrayBuffer control plane (`image-sab.ts`), not
 * postMessage: each worker `tryPop`s the next slot from a shared priority ring
 * (high lane = New, low lane = Upgrade/Downgrade), reads the desired
 * gen/level/dims + hash straight from shared memory, and re-reads intent at every
 * `await` checkpoint — so a superseding mip change or eviction is seen as a single
 * `Atomics.load`, never a queued cancel message. Only the decoded ImageBitmap
 * crosses back, by `postMessage` + Transferable (GPU-backed, can't live in a SAB).
 *
 * Worker 0 is also "primary": ingest (hash + validate + decode), the R2 upload
 * queue, bookmark unfurl, and cache prefetch. Those stay on postMessage (rare,
 * ordered, carry Blobs).
 *
 * Reads via Cache API first, then `fetch()` (network or SW-intercepted) — self-
 * sufficient regardless of SW presence (critical for dev mode).
 */

import { imagesClient } from '@avlo/api-client/images';
import { unfurlClient } from '@avlo/api-client/unfurl';
import { bytesToHex, validateImage } from '@avlo/shared';
import {
  EVICTED,
  F_DONE_GEN,
  F_DONE_LEVEL,
  F_NEED_GEN,
  F_NEED_H,
  F_NEED_LEVEL,
  F_NEED_W,
  type ImageSab,
  loadEpoch,
  mapImageSab,
} from './image-sab';

// ============================================================
// Message Types
// ============================================================

export type WorkerInbound =
  | { type: 'init'; index: number; sab: SharedArrayBuffer; idleExitMs: number } // idleExitMs>0 ⇒ self-retiring extra
  | { type: 'ingest'; id: string; blob: Blob } // worker 0
  | { type: 'prefetch'; assetIds: string[] } // worker 0 — cache-warm offscreen assets (no decode)
  | { type: 'enqueue-upload'; assetId: string } // worker 0
  | { type: 'delete-asset'; assetId: string } // worker 0
  | { type: 'online' } // worker 0
  | { type: 'drain-uploads' } // worker 0
  | { type: 'unfurl'; objectId: string; url: string }; // worker 0

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
  | {
      type: 'unfurled';
      objectId: string;
      data: {
        title?: string;
        description?: string;
        ogImageAssetId?: string;
        ogImageWidth?: number;
        ogImageHeight?: number;
        faviconAssetId?: string;
        faviconSvgBase64?: string;
      };
    }
  | { type: 'unfurl-failed'; objectId: string; permanent: boolean }
  | { type: 'error'; id?: string; assetId?: string; message: string; gen?: number }
  | { type: 'worker-exit'; index: number }; // a self-retiring extra is closing — free its pool slot

// ============================================================
// IDB Layer (upload queue only)
// ============================================================

const DB_NAME = 'avlo-assets';
const DB_VERSION = 3;
const UPLOADS_STORE = 'uploads';
const UNFURLS_STORE = 'unfurls';

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
      if (!db.objectStoreNames.contains(UNFURLS_STORE)) db.createObjectStore(UNFURLS_STORE);
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
  return imagesClient[':key'].$url({ param: { key: id } }).toString();
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
    // Cache.put() rejects on 206 (spec-mandated) — only persist 200s. Fire-and-
    // forget with a swallowed rejection so an unexpected write failure doesn't
    // surface as an unhandled rejection.
    if (resp.status === 200) cache.put(url, resp.clone()).catch(() => {});
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
// Identity
// ============================================================

let workerIndex = -1; // 0 ⇒ also "primary" (ingest + upload + unfurl + prefetch)
let idleExitMs = 0; // 0 ⇒ permanent (base worker, parks forever); >0 ⇒ extra that self-retires after this idle span

// ============================================================
// Helpers
// ============================================================

function post(msg: WorkerOutbound, transfer?: Transferable[]): void {
  (self as unknown as Worker).postMessage(msg, transfer ?? []);
}

function errorMsg(message: string, id?: string, assetId?: string, gen?: number): void {
  post({ type: 'error', id, assetId, message, gen });
}

async function sha256Hex(buffer: ArrayBuffer): Promise<string> {
  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
  return bytesToHex(new Uint8Array(hashBuffer));
}

// ============================================================
// SAB Decode Loop (work-stealing)
// ============================================================

/** A decode is superseded once its slot's gen has moved on or the epoch was bumped (room teardown). */
function isStale(s: ImageSab, slot: number, gen: number, startEpoch: number): boolean {
  return s.slots.load(slot, F_NEED_GEN) !== gen || loadEpoch(s.ctrl) !== startEpoch;
}

/**
 * Decode one slot at its CURRENT desired level and post the bitmap. The three
 * staleness checkpoints (before fetch, after fetch, after decode) are plain
 * `Atomics.load` comparisons against the slot's gen + the global epoch — whichever
 * superseding request or eviction landed most recently is seen in one read.
 */
async function decodeSlot(s: ImageSab, slot: number, gen: number): Promise<void> {
  const startEpoch = loadEpoch(s.ctrl);
  if (s.slots.load(slot, F_NEED_GEN) !== gen) return; // a fresher record for this slot exists / will be popped
  const level = s.slots.load(slot, F_NEED_LEVEL);
  if (level === EVICTED) return;
  const width = s.slots.load(slot, F_NEED_W);
  const height = s.slots.load(slot, F_NEED_H);
  const assetId = bytesToHex(s.slots.hashView(slot));

  if (isStale(s, slot, gen, startEpoch)) return; // checkpoint 1 — before fetch
  const blob = await getAssetBlob(assetId);
  if (isStale(s, slot, gen, startEpoch)) return; // checkpoint 2 — after fetch
  if (!blob) {
    errorMsg('asset not available', undefined, assetId, gen);
    return;
  }

  let bitmap: ImageBitmap;
  try {
    bitmap =
      level === 0
        ? await createImageBitmap(blob)
        : await createImageBitmap(blob, { resizeWidth: width, resizeHeight: height, resizeQuality: 'medium' });
  } catch (err) {
    if (!isStale(s, slot, gen, startEpoch)) errorMsg(err instanceof Error ? err.message : 'decode failed', undefined, assetId, gen);
    return;
  }

  if (isStale(s, slot, gen, startEpoch)) {
    // checkpoint 3 — after decode
    bitmap.close();
    return;
  }
  s.slots.store(slot, F_DONE_GEN, gen);
  s.slots.store(slot, F_DONE_LEVEL, level);
  post({ type: 'bitmap', assetId, bitmap, level: level as 0 | 1 | 2, gen }, [bitmap]);
}

/**
 * Steal work forever: drain the high lane then the low lane; when both are empty,
 * park on the futex (non-blocking — `postMessage` and `createImageBitmap` keep
 * running) until the producer signals. The seq snapshot + empty re-check before
 * waiting closes the lost-wakeup gap.
 *
 * A self-retiring extra (`idleExitMs > 0`) parks with that timeout: a `'timed-out'`
 * wake with both rings still empty means it sat idle the full span with no work, so it
 * closes — the pool falls back to its permanent base. This is the one branch where the
 * worker provably holds no in-flight decode (the last `decodeSlot` fully awaited before
 * we looped), so no slot is left stuck. A push racing the empty-check is safe: the
 * producer's `futex.signal()` wakes the parked base worker(s), which steal it.
 */
async function decodeLoop(s: ImageSab): Promise<void> {
  const rec = new Int32Array(2); // reused [slot, gen]
  for (;;) {
    if (s.highRing.tryPop(rec) || s.lowRing.tryPop(rec)) {
      try {
        await decodeSlot(s, rec[0], rec[1]);
      } catch (err) {
        console.error('[image-worker] decode error', err);
      }
      continue;
    }
    const seq = s.futex.loadSeq();
    if (!s.highRing.isEmpty() || !s.lowRing.isEmpty()) continue;
    const status = await s.futex.wait(seq, idleExitMs || undefined);
    if (idleExitMs && status === 'timed-out' && s.highRing.isEmpty() && s.lowRing.isEmpty()) {
      post({ type: 'worker-exit', index: workerIndex });
      self.close();
      return;
    }
  }
}

// ============================================================
// Upload Queue (fully in-worker, worker 0 only)
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
    // credentials:'include' so the .avlo.io cookie rides cross-origin to the images
    // worker's auth gate (H13); same-origin in dev sends it anyway.
    const resp = await fetch(assetUrl(assetId), { method: 'PUT', body: blob, credentials: 'include' });

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
        const delay = Math.min(BASE_DELAY_MS * 2 ** entry.retries, MAX_BACKOFF_MS);
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
// Unfurl (worker 0 only, direct fetch — no IDB queue)
// ============================================================

type UnfurlData = Extract<WorkerOutbound, { type: 'unfurled' }>['data'];

async function unfurlDirect(objectId: string, url: string): Promise<void> {
  try {
    const resp = await unfurlClient.index.$get({ query: { url } });
    console.warn('[image-worker] unfurl response:', objectId, resp.status);
    if (resp.status === 200) {
      const raw = (await resp.json()) as UnfurlData & { url?: string; domain?: string };
      const { url: _u, domain: _d, ...data } = raw;
      post({ type: 'unfurled', objectId, data });
    } else {
      post({ type: 'unfurl-failed', objectId, permanent: true });
    }
  } catch (err) {
    console.warn('[image-worker] unfurl fetch error:', objectId, err);
    post({ type: 'unfurl-failed', objectId, permanent: true });
  }
}

// ============================================================
// Message Handler
// ============================================================

self.onmessage = async (e: MessageEvent<WorkerInbound>) => {
  const msg = e.data;

  switch (msg.type) {
    case 'init': {
      workerIndex = msg.index;
      idleExitMs = msg.idleExitMs;
      const sab = mapImageSab(msg.sab);
      if (workerIndex === 0) setInterval(drainUploads, SAFETY_INTERVAL_MS);
      void decodeLoop(sab); // steal decodes forever (base) / until idle (extra)
      break;
    }

    case 'ingest': {
      if (workerIndex !== 0) break;
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

        post({ type: 'ingested', id, assetId, w, h, mime, bitmap: fullBitmap, level: 0 }, [fullBitmap]);
      } catch (err) {
        errorMsg(err instanceof Error ? err.message : 'ingest failed', id);
      }
      break;
    }

    case 'prefetch': {
      // Offscreen hydrate assets: warm the cache so a scroll-in decodes instantly. No bitmap.
      for (const assetId of msg.assetIds) getAssetBlob(assetId).catch(() => {});
      break;
    }

    case 'enqueue-upload': {
      if (workerIndex !== 0) break;
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
      if (workerIndex !== 0) break;
      await deleteCachedAsset(msg.assetId).catch(() => {});
      await removeUploadEntry(msg.assetId).catch(() => {});
      break;
    }

    case 'online': {
      if (workerIndex !== 0) break;
      resetBackoff = true;
      drainUploads();
      break;
    }

    case 'drain-uploads': {
      if (workerIndex !== 0) break;
      drainUploads();
      break;
    }

    case 'unfurl': {
      if (workerIndex !== 0) break;
      unfurlDirect(msg.objectId, msg.url);
      break;
    }
  }
};
