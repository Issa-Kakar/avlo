/**
 * ImageManager — Thin main-thread coordinator for image assets.
 *
 * All heavy work (IDB, CDN fetch, hashing, upload, decode) runs in two image-worker instances.
 * Worker 0 (primary): upload queue + ingest + decode. Worker 1 (decoder): decode only.
 * Decode requests are hash-routed by assetId for consistent per-asset worker affinity.
 *
 * State:
 *   bitmaps: Map<assetId, { bitmap, level }> — decoded bitmaps at current mip level
 *   pending: Map<assetId, { gen, level }> — in-flight decode requests with generation tracking
 *   errors:  Map<assetId, timestamp> — failed assets with cooldown-based retry (15s)
 *   inflightIngests: Map<id, { resolve, reject }> — ingest promise tracking
 *
 * Generation-based staleness: when mip level changes during zoom, a new decode request
 * supersedes the old one immediately (no waiting). Workers discard stale results.
 *
 * Invariant: spatial index IS the source of truth for visibility.
 * No tracking maps — everything derived at query time from snapshot.
 */

import type { BBoxTuple } from '../types/geometry';
import { getAssetId, getFrame, getNaturalDimensions } from '../accessors';
import type { WorkerInbound, WorkerOutbound } from './image-worker';
import { invalidateWorldBBox } from '@/renderer/RenderLoop';
import { hasActiveRoom, getObjectsById, getSpatialIndex, getHandle } from '@/runtime/room-runtime';
import { useCameraStore, getVisibleBoundsTuple } from '@/stores/camera-store';
import { useSelectionStore } from '@/stores/selection-store';
import type { ObjectHandle } from '../types/objects';
import { handleUnfurlResult, handleUnfurlFailed } from '../bookmark/bookmark-unfurl';
import { repositionAllPlaceholders } from '../bookmark/bookmark-placeholder';
import { getBookmarkFrame } from '../bookmark/bookmark-render';

// ============================================================
// Workers
// ============================================================

const workers: [Worker, Worker] = [
  new Worker(new URL('./image-worker.ts', import.meta.url), { type: 'module' }),
  new Worker(new URL('./image-worker.ts', import.meta.url), { type: 'module' }),
];

workers[0].postMessage({ type: 'init', role: 'primary' } satisfies WorkerInbound);
workers[1].postMessage({ type: 'init', role: 'decoder' } satisfies WorkerInbound);

/** Hash-route by assetId first char for consistent per-asset worker affinity. */
function workerFor(assetId: string): Worker {
  return workers[assetId.charCodeAt(0) & 1];
}

/** Post a message to the primary worker. Used by bookmark-unfurl for unfurl commands. */
export function postToPrimary(msg: WorkerInbound): void {
  workers[0].postMessage(msg);
}

// ============================================================
// State
// ============================================================

export interface IngestResult {
  assetId: string;
  naturalWidth: number;
  naturalHeight: number;
  mimeType: string;
}

/** Decoded bitmaps at current mip level. One bitmap per assetId in memory at a time. */
const bitmaps = new Map<string, { bitmap: ImageBitmap; level: number }>();

/** In-flight decode requests with generation tracking for staleness. */
const pending = new Map<string, { gen: number; level: number }>();
let genCounter = 0;

/**
 * AssetIds that failed to decode/fetch, with timestamp of last error.
 * Prevents infinite decode→error→decode loops. Retried after ERROR_COOLDOWN_MS.
 * Cleared on successful bitmap receipt (self-healing when CDN becomes available).
 */
const errors = new Map<string, number>();
const ERROR_COOLDOWN_MS = 15_000;

/** Ingest promise tracking — maps worker request ID to promise handlers. */
let ingestIdCounter = 0;
const inflightIngests = new Map<string, { resolve: (result: IngestResult) => void; reject: (err: Error) => void }>();

// ============================================================
// Helpers
// ============================================================

function padViewport(vb: Readonly<[number, number, number, number]>): BBoxTuple {
  const [minX, minY, maxX, maxY] = vb;
  const vw = maxX - minX;
  const vh = maxY - minY;
  return [minX - vw * 2.25, minY - vh * 2.25, maxX + vw * 2.25, maxY + vh * 2.25];
}

function ppspToLevel(ppsp: number): 0 | 1 | 2 {
  return ppsp > 0.5 ? 0 : ppsp > 0.25 ? 1 : 2;
}

function levelDivisor(level: 0 | 1 | 2): number {
  return level === 0 ? 1 : level === 1 ? 2 : 4;
}

function mipDim(natural: number, div: number): number {
  return Math.max(1, Math.round(natural / div));
}

// ============================================================
// Worker Message Handler
// ============================================================

function handleWorkerMessage(e: MessageEvent<WorkerOutbound>): void {
  const msg = e.data;

  switch (msg.type) {
    case 'ingested': {
      // Close previous bitmap if exists (dedup: same assetId ingested twice)
      const old = bitmaps.get(msg.assetId);
      if (old) old.bitmap.close();
      bitmaps.set(msg.assetId, { bitmap: msg.bitmap, level: msg.level });
      errors.delete(msg.assetId);

      // Resolve the ingest promise
      const entry = inflightIngests.get(msg.id);
      if (entry) {
        inflightIngests.delete(msg.id);
        entry.resolve({
          assetId: msg.assetId,
          naturalWidth: msg.w,
          naturalHeight: msg.h,
          mimeType: msg.mime,
        });
      }

      // Targeted invalidation for any visible objects with this assetId
      invalidateBitmapRegion(msg.assetId);
      break;
    }

    case 'bitmap': {
      // Guard: if room was torn down while decode was in-flight, discard
      if (!hasActiveRoom()) {
        msg.bitmap.close();
        return;
      }

      // Staleness check: discard if gen doesn't match current pending request
      const p = pending.get(msg.assetId);
      if (!p || p.gen !== msg.gen) {
        msg.bitmap.close();
        return;
      }

      const old = bitmaps.get(msg.assetId);
      if (old) old.bitmap.close();
      bitmaps.set(msg.assetId, { bitmap: msg.bitmap, level: msg.level });
      pending.delete(msg.assetId);
      errors.delete(msg.assetId); // Clear error on success (self-healing)

      invalidateBitmapRegion(msg.assetId);
      break;
    }

    case 'uploaded': {
      // Informational — no action needed on main thread
      break;
    }

    case 'unfurled': {
      handleUnfurlResult(msg.objectId, msg.data);
      break;
    }

    case 'unfurl-failed': {
      handleUnfurlFailed(msg.objectId, msg.permanent);
      break;
    }

    case 'error': {
      // Resolve/reject ingest promise if this was an ingest error
      if (msg.id) {
        const entry = inflightIngests.get(msg.id);
        if (entry) {
          inflightIngests.delete(msg.id);
          entry.reject(new Error(msg.message));
        }
      }

      // Mark asset as errored with timestamp for cooldown-based retry
      if (msg.assetId) {
        // Only process if gen matches (don't set cooldown for superseded requests)
        if (msg.gen != null) {
          const p = pending.get(msg.assetId);
          if (!p || p.gen !== msg.gen) return; // stale error
        }
        pending.delete(msg.assetId);
        errors.set(msg.assetId, Date.now());
      }
      break;
    }
  }
}

for (const w of workers) w.onmessage = handleWorkerMessage;

/** Invalidate canvas region for decoded bitmap. O(1) via cached bbox, gated on actual viewport. */
function invalidateBitmapRegion(assetId: string): void {
  // Fast path: pre-computed union bbox from most recent manageImageViewport tick.
  // Only invalidate if actually visible — off-viewport bitmaps sit in the map silently
  // until the user scrolls to them (the render pass will draw them naturally).
  const info = _assetInfo.get(assetId);
  if (info) {
    const vb = getVisibleBoundsTuple();
    const b = info.bbox;
    if (b[2] >= vb[0] && b[0] <= vb[2] && b[3] >= vb[1] && b[1] <= vb[3]) {
      invalidateWorldBBox(b);
    }
    return;
  }
  // Fallback for bitmaps arriving before first render tick (hydration):
  // simple bbox intersection, no spatial query
  if (!hasActiveRoom()) return;
  try {
    const vb = getVisibleBoundsTuple();
    for (const handle of getObjectsById().values()) {
      if (handle.kind !== 'image' && handle.kind !== 'bookmark') continue;
      const handleAssetId =
        handle.kind === 'image'
          ? getAssetId(handle.y)
          : ((handle.y.get('ogImageAssetId') as string | undefined) ?? (handle.y.get('faviconAssetId') as string | undefined));
      if (handleAssetId !== assetId) continue;
      const b = handle.bbox;
      if (b[2] >= vb[0] && b[0] <= vb[2] && b[3] >= vb[1] && b[1] <= vb[3]) {
        invalidateWorldBBox(b);
      }
    }
  } catch {
    // No active room or snapshot — stale bitmap, ignore
  }
}

// ============================================================
// Public API
// ============================================================

/** Synchronous bitmap access for render path. Returns null if not decoded. */
export function getBitmap(assetId: string): ImageBitmap | null {
  return bitmaps.get(assetId)?.bitmap ?? null;
}

/** Per-asset info reused each frame to avoid allocations. Includes union bbox for O(1) invalidation. */
interface AssetInfo {
  ppsp: number;
  nw: number;
  nh: number;
  bbox: BBoxTuple;
}
const _assetInfo = new Map<string, AssetInfo>();

/** Register or merge asset info for viewport management. */
function registerAssetInfo(assetId: string, ppsp: number, nw: number, nh: number, bbox: BBoxTuple): void {
  const prev = _assetInfo.get(assetId);
  if (!prev) {
    // COPY: handle.bbox is shared with the spatial-index R-tree — never mutate
    _assetInfo.set(assetId, { ppsp, nw, nh, bbox: [bbox[0], bbox[1], bbox[2], bbox[3]] });
  } else {
    if (ppsp > prev.ppsp) {
      prev.ppsp = ppsp;
      prev.nw = nw;
      prev.nh = nh;
    }
    const pb = prev.bbox;
    if (bbox[0] < pb[0]) pb[0] = bbox[0];
    if (bbox[1] < pb[1]) pb[1] = bbox[1];
    if (bbox[2] > pb[2]) pb[2] = bbox[2];
    if (bbox[3] > pb[3]) pb[3] = bbox[3];
  }
}

/**
 * Viewport management — called from RenderLoop.tick() every frame.
 *
 * Reads camera store + snapshot internally. No parameters.
 * 1. Queries spatial index with 3× padded viewport
 * 2. Computes per-image ppsp → needed mip level + target decode dimensions
 * 3. Requests decode for visible assets without correct mip (supersedes stale requests)
 * 4. Evicts bitmaps for assets no longer visible, cancels in-flight decodes
 *
 * Complexity: O(visible images) per frame. Only image entries from spatial index are processed.
 */
export function manageImageViewport(): void {
  if (!hasActiveRoom()) return;

  let spatialIndex;
  try {
    spatialIndex = getSpatialIndex();
  } catch {
    return;
  }
  const padded = padViewport(getVisibleBoundsTuple());
  const visible = spatialIndex.queryBBox(padded);

  const { scale } = useCameraStore.getState();
  const dpr = window.devicePixelRatio || 1;

  _assetInfo.clear();

  for (const entry of visible) {
    if (entry.kind === 'bookmark') {
      const handle = getHandle(entry.id);
      if (!handle) continue;
      const ogId = handle.y.get('ogImageAssetId') as string | undefined;
      const favId = handle.y.get('faviconAssetId') as string | undefined;
      const frame = getBookmarkFrame(handle.id);
      if (!frame) continue;
      // OG image + favicon: always level 0, no mip levels needed
      for (const aid of [ogId, favId]) {
        if (!aid) continue;
        registerAssetInfo(aid, Infinity, frame[2], frame[2], handle.bbox);
      }
      continue;
    }
    if (entry.kind !== 'image') continue;
    const handle = getHandle(entry.id);
    if (!handle) continue;
    const assetId = getAssetId(handle.y);
    if (!assetId) continue;
    const frame = getFrame(handle.y);
    if (!frame) continue;

    const dims = getNaturalDimensions(handle.y);
    const nw = dims ? dims[0] : frame[2];
    const nh = dims ? dims[1] : frame[3];
    const ppsp = (frame[2] * scale * dpr) / nw;

    registerAssetInfo(assetId, ppsp, nw, nh, handle.bbox);
  }

  // During scale transforms, force full-res for selected images (crisp preview)
  const { transform: selTransform, kindCounts, selectedIdSet } = useSelectionStore.getState();
  if (selTransform.kind === 'scale' && kindCounts.image > 0) {
    for (const id of selectedIdSet) {
      const handle = getHandle(id);
      if (!handle || handle.kind !== 'image') continue;
      const aid = getAssetId(handle.y);
      if (!aid) continue;
      const info = _assetInfo.get(aid);
      if (info) info.ppsp = Infinity;
    }
  }

  // Decode — request decode for visible assets that need it
  const now = Date.now();
  for (const [assetId, info] of _assetInfo) {
    // Skip assets in error cooldown
    const lastError = errors.get(assetId);
    if (lastError && now - lastError < ERROR_COOLDOWN_MS) continue;

    const neededLevel = ppspToLevel(info.ppsp);
    const cached = bitmaps.get(assetId);
    const p = pending.get(assetId);

    // Send decode if: no bitmap or worse quality, AND no pending request for this level
    // cached.level > neededLevel = cached is worse than needed (level 0=best, 2=worst)
    // Never downgrade — higher-quality bitmaps stay until eviction
    if ((!cached || cached.level > neededLevel) && (!p || p.level !== neededLevel)) {
      const div = levelDivisor(neededLevel);
      const width = neededLevel === 0 ? 0 : mipDim(info.nw, div);
      const height = neededLevel === 0 ? 0 : mipDim(info.nh, div);
      const gen = ++genCounter;
      pending.set(assetId, { gen, level: neededLevel });
      workerFor(assetId).postMessage({
        type: 'decode',
        assetId,
        level: neededLevel,
        width,
        height,
        gen,
      } satisfies WorkerInbound);
    }
  }

  // Eviction — close bitmaps for assets no longer in viewport, cancel in-flight decodes
  for (const [assetId, entry] of bitmaps) {
    if (!_assetInfo.has(assetId)) {
      entry.bitmap.close();
      bitmaps.delete(assetId);
      if (pending.has(assetId)) {
        workerFor(assetId).postMessage({ type: 'cancel', assetId } satisfies WorkerInbound);
        pending.delete(assetId);
      }
    }
  }

  // Reposition bookmark loading placeholders to follow camera
  repositionAllPlaceholders();
}

/**
 * Ingest a local file: validate → hash → IDB → decode → bitmap.
 * Decodes immediately (user expects instant display after drop/paste).
 * Returns metadata for Y.Doc object creation.
 */
export function ingest(file: Blob): Promise<IngestResult> {
  const id = String(++ingestIdCounter);
  return new Promise<IngestResult>((resolve, reject) => {
    inflightIngests.set(id, { resolve, reject });
    workers[0].postMessage({ type: 'ingest', id, blob: file } satisfies WorkerInbound);
  });
}

/**
 * Hydrate images on room join.
 * Receives pre-filtered image+bookmark handles from RoomDocManager.hydrateObjectsFromY.
 * Splits visible vs offscreen via handle.bbox, computes decode dimensions, distributes
 * across workers by hash routing, assigns gen per visible item.
 */
export function hydrateImages(handles: ObjectHandle[]): void {
  if (handles.length === 0) return;

  const { scale } = useCameraStore.getState();
  const dpr = window.devicePixelRatio || 1;
  const vb = getVisibleBoundsTuple();

  // Per-assetId: best level (min level = highest quality) + natural dims + representative bbox
  const assetMap = new Map<string, { bbox: BBoxTuple; level: 0 | 1 | 2; nw: number; nh: number }>();

  for (const handle of handles) {
    if (handle.kind === 'bookmark') {
      const ogId = handle.y.get('ogImageAssetId') as string | undefined;
      const favId = handle.y.get('faviconAssetId') as string | undefined;
      // Bookmarks always level 0 (ppsp Infinity); nw/nh unused for level 0 decode
      if (ogId) assetMap.set(ogId, { bbox: handle.bbox, level: 0, nw: 0, nh: 0 });
      if (favId) assetMap.set(favId, { bbox: handle.bbox, level: 0, nw: 0, nh: 0 });
      continue;
    }
    // image — bbox === frame, so bbox width is the exact frame width
    const assetId = getAssetId(handle.y);
    if (!assetId) continue;
    const dims = getNaturalDimensions(handle.y);
    if (!dims) continue;
    const [nw, nh] = dims;
    const frameW = handle.bbox[2] - handle.bbox[0];
    const ppsp = (frameW * scale * dpr) / nw;
    const level = ppspToLevel(ppsp);
    const existing = assetMap.get(assetId);
    if (!existing || level < existing.level) {
      assetMap.set(assetId, { bbox: handle.bbox, level, nw, nh });
    }
  }

  if (assetMap.size === 0) return;

  const byWorker: [
    {
      visible: { assetId: string; level: 0 | 1 | 2; width: number; height: number; gen: number }[];
      prefetch: string[];
    },
    {
      visible: { assetId: string; level: 0 | 1 | 2; width: number; height: number; gen: number }[];
      prefetch: string[];
    },
  ] = [
    { visible: [], prefetch: [] },
    { visible: [], prefetch: [] },
  ];

  for (const [assetId, { bbox, level, nw, nh }] of assetMap) {
    const idx = assetId.charCodeAt(0) & 1;
    const isVisible = bbox[2] >= vb[0] && bbox[0] <= vb[2] && bbox[3] >= vb[1] && bbox[1] <= vb[3];
    if (isVisible) {
      const div = levelDivisor(level);
      const gen = ++genCounter;
      byWorker[idx].visible.push({
        assetId,
        level,
        width: level === 0 ? 0 : mipDim(nw, div),
        height: level === 0 ? 0 : mipDim(nh, div),
        gen,
      });
      pending.set(assetId, { gen, level });
    } else {
      byWorker[idx].prefetch.push(assetId);
    }
  }

  for (let i = 0; i < 2; i++) {
    if (byWorker[i].visible.length > 0 || byWorker[i].prefetch.length > 0) {
      workers[i].postMessage({
        type: 'hydrate',
        visible: byWorker[i].visible,
        prefetch: byWorker[i].prefetch,
      } satisfies WorkerInbound);
    }
  }
}

/** Enqueue asset for upload. Fire-and-forget. */
export function enqueue(assetId: string): void {
  workers[0].postMessage({ type: 'enqueue-upload', assetId } satisfies WorkerInbound);
}

/** Room teardown: close all bitmaps, clear all state, notify workers. */
export function clear(): void {
  for (const entry of bitmaps.values()) {
    entry.bitmap.close();
  }
  bitmaps.clear();
  pending.clear();
  errors.clear();
  inflightIngests.clear();
  for (const w of workers) w.postMessage({ type: 'clear' } satisfies WorkerInbound);
}

// ============================================================
// Module-level init (runs once on import)
// ============================================================

window.addEventListener('online', () => {
  workers[0].postMessage({ type: 'online' } satisfies WorkerInbound);
});

// Drain pending uploads from prior sessions
workers[0].postMessage({ type: 'drain-uploads' } satisfies WorkerInbound);
