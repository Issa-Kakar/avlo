/**
 * ImageManager — Central orchestrator for image assets.
 *
 * Manages the full lifecycle: IDB → decode → bitmap cache → viewport eviction.
 * Module-level singleton. Synchronous getBitmap() for render path;
 * async requestLoad() for on-demand fetching.
 */

import { getBlob, putBlob, hasBlob } from './asset-cache';
import type { DecodeRequest, WorkerResponse } from './image-decode-worker';

// === Types ===

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

// === State ===

const assets = new Map<string, AssetEntry>();
let worker: Worker | null = null;
let workerIdCounter = 0;
const pendingDecodes = new Map<string, { assetId: string; resolve: (bmp: ImageBitmap) => void; reject: (err: Error) => void }>();

// Invalidation callback — set by CanvasRuntime
let onBitmapReady: ((assetId: string) => void) | null = null;

// Asset URL base — set during init
let assetsBaseUrl = '/api/assets';

// === Worker Lifecycle ===

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
    pendingDecodes.set(id, { assetId: id, resolve, reject });
    getWorker().postMessage({ type: 'decode', id, blob } satisfies DecodeRequest);
  });
}

// === Public API ===

/** Synchronous bitmap access for render path. Returns null if not ready. */
export function getBitmap(assetId: string): ImageBitmap | null {
  return assets.get(assetId)?.bitmap ?? null;
}

/** Trigger async load: IDB check → CDN fetch → worker decode → invalidate. */
export function requestLoad(assetId: string): void {
  const existing = assets.get(assetId);
  if (existing && existing.status !== 'error') return;

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
  } catch {
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
      mimeType: file.type || 'image/png',
    };
  }

  // Store blob in IDB (idempotent)
  const blob = new Blob([buffer], { type: file.type });
  if (!(await hasBlob(assetId))) {
    await putBlob(assetId, blob, file.type || 'image/png');
  }

  // Decode
  const bitmap = await decodeBlob(blob);
  assets.set(assetId, { status: 'ready', bitmap, fetchPromise: null });

  return {
    assetId,
    naturalWidth: bitmap.width,
    naturalHeight: bitmap.height,
    mimeType: file.type || 'image/png',
  };
}

/** Bulk request on room hydration. Non-blocking. */
export function prefetchBatch(assetIds: string[]): void {
  for (const id of assetIds) {
    requestLoad(id);
  }
}

/** Close bitmaps not in the visible set to free GPU memory. */
export function evictDistant(visibleAssetIds: Set<string>): void {
  for (const [id, entry] of assets) {
    if (entry.bitmap && !visibleAssetIds.has(id)) {
      entry.bitmap.close();
      entry.bitmap = null;
      entry.status = 'pending'; // Can re-decode from IDB
      entry.fetchPromise = null;
    }
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
