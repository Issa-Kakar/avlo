/**
 * ImageManager — Central orchestrator for image assets.
 *
 * Manages the full lifecycle: IDB persistence, decode worker, bitmap cache,
 * viewport eviction, and persistent upload queue. Module-level singleton.
 *
 * Synchronous getBitmap() for render path; async requestLoad() for on-demand fetching.
 * Upload queue survives tab crashes via IDB. Content-addressed, so operations are idempotent.
 */

import type { DecodeRequest, WorkerResponse } from './image-decode-worker';
import { validateImage } from '@avlo/shared';

// ============================================================
// Section 1 — IDB Layer
// ============================================================

const DB_NAME = 'avlo-assets';
const DB_VERSION = 1;
const BLOBS_STORE = 'blobs';
const UPLOADS_STORE = 'uploads';

type UploadStatus = 'pending' | 'uploading' | 'failed';

interface BlobEntry {
  blob: Blob;
  mimeType: string;
  size: number;
  storedAt: number;
}

interface UploadEntry {
  status: UploadStatus;
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

function tx(store: string, mode: IDBTransactionMode): Promise<IDBObjectStore> {
  return openDB().then((db) => db.transaction(store, mode).objectStore(store));
}

function idbOp<T>(fn: (store: IDBObjectStore) => IDBRequest): (store: IDBObjectStore) => Promise<T> {
  return (store) => new Promise((resolve, reject) => {
    const req = fn(store);
    req.onsuccess = () => resolve(req.result as T);
    req.onerror = () => reject(req.error);
  });
}

// Blob store
async function getBlob(assetId: string): Promise<Blob | null> {
  const store = await tx(BLOBS_STORE, 'readonly');
  const entry = await idbOp<BlobEntry | undefined>((s) => s.get(assetId))(store);
  return entry?.blob ?? null;
}

async function putBlob(assetId: string, blob: Blob, mimeType: string): Promise<void> {
  const store = await tx(BLOBS_STORE, 'readwrite');
  const entry: BlobEntry = { blob, mimeType, size: blob.size, storedAt: Date.now() };
  await idbOp<void>((s) => s.put(entry, assetId))(store);
}

// Upload store
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

async function getAllPendingUploads(): Promise<string[]> {
  const store = await tx(UPLOADS_STORE, 'readonly');
  return idbOp<string[]>((s) => s.getAllKeys() as IDBRequest<string[]>)(store);
}

// ============================================================
// Section 2 — Decode Worker
// ============================================================

let worker: Worker | null = null;
let workerIdCounter = 0;
const pendingDecodes = new Map<string, { resolve: (bmp: ImageBitmap) => void; reject: (err: Error) => void }>();

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('./image-decode-worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
      const msg = e.data;
      const pending = pendingDecodes.get(msg.id);
      if (!pending) return;
      pendingDecodes.delete(msg.id);

      if (msg.type === 'decoded') {
        pending.resolve(msg.bitmap);
      } else {
        pending.reject(new Error(msg.message));
      }
    };
  }
  return worker;
}

function decodeBlob(blob: Blob): Promise<ImageBitmap> {
  const id = String(++workerIdCounter);
  return new Promise<ImageBitmap>((resolve, reject) => {
    pendingDecodes.set(id, { resolve, reject });
    getWorker().postMessage({ type: 'decode', id, blob } satisfies DecodeRequest);
  });
}

// ============================================================
// Section 3 — Bitmap Cache + Load Pipeline
// ============================================================

type AssetStatus = 'pending' | 'fetching' | 'decoding' | 'ready' | 'error';

interface AssetEntry {
  status: AssetStatus;
  bitmap: ImageBitmap | null;
  fetchPromise: Promise<void> | null;
}

export interface IngestResult {
  assetId: string;
  naturalWidth: number;
  naturalHeight: number;
  mimeType: string;
}

const assets = new Map<string, AssetEntry>();

// Invalidation callback — set by CanvasRuntime
let onBitmapReady: ((assetId: string) => void) | null = null;

// Asset URL base — set during init
let assetsBaseUrl = '/api/assets';

/** Synchronous bitmap access for render path. Returns null if not ready. */
export function getBitmap(assetId: string): ImageBitmap | null {
  return assets.get(assetId)?.bitmap ?? null;
}

/** Trigger async load: IDB check → CDN fetch → worker decode → invalidate. */
export function requestLoad(assetId: string): void {
  const existing = assets.get(assetId);
  // Allow re-decode from IDB after eviction (status === 'pending')
  if (existing && existing.status !== 'error' && existing.status !== 'pending') return;

  const entry: AssetEntry = { status: 'pending', bitmap: null, fetchPromise: null };
  assets.set(assetId, entry);

  entry.fetchPromise = loadPipeline(assetId, entry);
}

async function loadPipeline(assetId: string, entry: AssetEntry): Promise<void> {
  try {
    // 1. Check IDB
    let blob = await getBlob(assetId);

    // 2. Fetch from CDN if not cached
    if (!blob) {
      entry.status = 'fetching';
      const resp = await fetch(`${assetsBaseUrl}/${assetId}`);
      if (!resp.ok) throw new Error(`fetch ${resp.status}`);
      blob = await resp.blob();
      await putBlob(assetId, blob, blob.type);
    }

    // 3. Decode
    entry.status = 'decoding';
    const bitmap = await decodeBlob(blob);

    entry.status = 'ready';
    entry.bitmap = bitmap;
    entry.fetchPromise = null;

    // 4. Invalidate render
    onBitmapReady?.(assetId);
  } catch (err) {
    console.warn('[image] load failed:', assetId, err);
    entry.status = 'error';
    entry.fetchPromise = null;
  }
}

/**
 * Ingest a local file: hash → IDB → decode.
 * Returns immediately usable metadata. Bitmap is cached in memory.
 */
export async function ingest(file: Blob): Promise<IngestResult> {
  const buffer = await file.arrayBuffer();

  // Fail-fast: validate magic bytes before hashing/storing
  const bytes = new Uint8Array(buffer);
  const { valid, mimeType: detectedMime } = validateImage(bytes);
  if (!valid) throw new Error('unsupported image format');
  const mimeType = detectedMime || file.type || 'image/png';

  // SHA-256 hash
  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
  const hashArray = new Uint8Array(hashBuffer);
  let assetId = '';
  for (let i = 0; i < hashArray.length; i++) {
    assetId += hashArray[i].toString(16).padStart(2, '0');
  }

  // Dedup: check memory cache
  const existing = assets.get(assetId);
  if (existing?.status === 'ready' && existing.bitmap) {
    return {
      assetId,
      naturalWidth: existing.bitmap.width,
      naturalHeight: existing.bitmap.height,
      mimeType,
    };
  }

  // Store blob in IDB (idempotent — content-addressed, so put is a no-op for same key)
  const blob = new Blob([buffer], { type: mimeType });
  await putBlob(assetId, blob, mimeType);

  // Decode
  const bitmap = await decodeBlob(blob);
  assets.set(assetId, { status: 'ready', bitmap, fetchPromise: null });

  return {
    assetId,
    naturalWidth: bitmap.width,
    naturalHeight: bitmap.height,
    mimeType,
  };
}

/** Bulk request on room hydration. Non-blocking. */
export function prefetchBatch(assetIds: string[]): void {
  for (const id of assetIds) {
    requestLoad(id);
  }
}

/** Evict off-viewport bitmaps + trigger load for visible ones. */
export function updateViewport(visibleAssetIds: Set<string>): void {
  for (const [id, entry] of assets) {
    if (entry.bitmap && !visibleAssetIds.has(id)) {
      entry.bitmap.close();
      entry.bitmap = null;
      entry.status = 'pending';
      entry.fetchPromise = null;
    }
  }
  for (const id of visibleAssetIds) {
    requestLoad(id);
  }
}

/** Room teardown: close all bitmaps, clear caches. */
export function clear(): void {
  for (const entry of assets.values()) {
    entry.bitmap?.close();
  }
  assets.clear();
  pendingDecodes.clear();
}

/** Register invalidation callback (called by CanvasRuntime). */
export function setOnBitmapReady(cb: ((assetId: string) => void) | null): void {
  onBitmapReady = cb;
}

/** Set the base URL for asset fetching. */
export function setAssetsBaseUrl(url: string): void {
  assetsBaseUrl = url;
}

// ============================================================
// Section 4 — Upload Queue
// ============================================================

const BASE_DELAY_MS = 1000;
const MAX_BACKOFF_MS = 60_000;

let processing = false;
let resetBackoff = false;

/** Enqueue an asset for upload. Idempotent. */
export async function enqueue(assetId: string): Promise<void> {
  const existing = await getUploadEntry(assetId);
  if (existing) return;
  await putUploadEntry(assetId, { status: 'pending', retries: 0, lastAttempt: 0 });
  processQueue();
}

async function processQueue(): Promise<void> {
  if (processing) return;
  processing = true;

  const ignoreBackoff = resetBackoff;
  resetBackoff = false;

  try {
    const ids = await getAllPendingUploads();
    for (const assetId of ids) {
      const entry = await getUploadEntry(assetId);
      if (!entry) continue;

      // Exponential backoff (no max retries — offline-first means retry forever)
      if (entry.status === 'failed' && !ignoreBackoff) {
        const delay = Math.min(BASE_DELAY_MS * Math.pow(2, entry.retries), MAX_BACKOFF_MS);
        const elapsed = Date.now() - entry.lastAttempt;
        if (elapsed < delay) continue;
      }

      await uploadOne(assetId, entry);
    }
  } finally {
    processing = false;
  }
}

async function uploadOne(assetId: string, entry: UploadEntry): Promise<void> {
  const blob = await getBlob(assetId);
  if (!blob) {
    await removeUploadEntry(assetId);
    return;
  }

  await putUploadEntry(assetId, { ...entry, status: 'uploading', lastAttempt: Date.now() });

  try {
    const resp = await fetch(`/api/assets/${assetId}`, { method: 'PUT', body: blob });

    if (resp.ok || resp.status === 409) {
      await removeUploadEntry(assetId);
      return;
    }

    // Read server error body for diagnostics
    const body = await resp.text().catch(() => '');

    // 4xx = permanent failure (bad format, too large) — don't retry
    if (resp.status >= 400 && resp.status < 500) {
      console.warn('[image] upload rejected (permanent):', assetId, resp.status, body);
      await removeUploadEntry(assetId);
      return;
    }

    throw new Error(`upload ${resp.status}: ${body}`);
  } catch (err) {
    console.warn('[image] upload failed:', assetId, err);
    await putUploadEntry(assetId, {
      status: 'failed',
      retries: entry.retries + 1,
      lastAttempt: Date.now(),
    });
  }
}

/**
 * Start the upload queue lifecycle. Registers online listener + safety interval.
 * Drains leftovers from prior sessions on first call.
 * Returns cleanup function for teardown.
 */
export function startUploadQueue(): () => void {
  const onOnline = () => { resetBackoff = true; processQueue(); };
  window.addEventListener('online', onOnline);
  const intervalId = setInterval(processQueue, 30_000);

  // Drain leftovers immediately
  processQueue();

  return () => {
    window.removeEventListener('online', onOnline);
    clearInterval(intervalId);
  };
}
