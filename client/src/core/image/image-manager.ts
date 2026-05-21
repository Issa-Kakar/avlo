/**
 * ImageManager — Thin main-thread coordinator for image assets.
 *
 * All heavy work (IDB, CDN fetch, hashing, upload, decode) runs in two image-worker instances.
 * Worker 0 (primary): upload queue + ingest + decode. Worker 1 (decoder): decode only.
 * Decode requests are hash-routed by assetId for consistent per-asset worker affinity.
 *
 * Per-frame loop (`manageImageViewport`): zero Y.Map reads, zero steady-state allocations.
 *   - The per-object asset digest lives in subsystem caches owned elsewhere: image
 *     assetId + natural dims in `image-cache.ts`, bookmark og/favicon ids in
 *     `bookmarkCache`'s layout. Both populated by the `computeBBoxFor` dispatch.
 *   - `_assetInfo` lives across frames; entries mark/sweep via `_frameMark` instead of
 *     clear/repopulate. Steady-state allocations: zero.
 *   - During translate/scale, the selected images' transform-output bbox is layered into
 *     the visibility pass (still gated on the padded viewport — Ctrl+A doesn't
 *     force-decode every image in the room). Fixes the edge-scroll eviction bug.
 *   - Decodes dispatched in priority order: New (no bitmap) > Upgrade (worse cached) >
 *     Downgrade (2-level hysteresis, cached + 2 ≤ needed). New-in-view bitmaps land
 *     before downgrades of already-rendered images.
 *
 * Generation-based staleness: when mip level changes, a new decode supersedes the old
 * immediately. Workers discard stale results.
 */

import { invalidateWorldBBox } from '@/renderer/RenderLoop';
import { getHandle, getSpatialIndex, hasActiveRoom } from '@/runtime/room-runtime';
import { getVisibleBoundsTuple, useCameraStore } from '@/stores/camera-store';
import { useSelectionStore } from '@/stores/selection-store';
import { getScaleEntry, getTransformMode } from '@/tools/selection/transform';
import { repositionAllPlaceholders } from '../bookmark/bookmark-placeholder';
import { bookmarkCache } from '../bookmark/bookmark-render';
import { handleUnfurlFailed, handleUnfurlResult } from '../bookmark/bookmark-unfurl';
import type { BBoxTuple } from '../types/geometry';
import { forEachImageMeta, getImageMeta } from './image-cache';
import type { WorkerInbound, WorkerOutbound } from './image-worker';

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

// Scratch tuple — overwritten each call. Safe because rbush queryBBox reads
// the bounds synchronously into its scratch envelope and doesn't retain.
const _paddedScratch: BBoxTuple = [0, 0, 0, 0];
function padViewport(vb: Readonly<[number, number, number, number]>): BBoxTuple {
  const vw = vb[2] - vb[0];
  const vh = vb[3] - vb[1];
  _paddedScratch[0] = vb[0] - vw * 2.25;
  _paddedScratch[1] = vb[1] - vh * 2.25;
  _paddedScratch[2] = vb[2] + vw * 2.25;
  _paddedScratch[3] = vb[3] + vh * 2.25;
  return _paddedScratch;
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

function bboxIntersects(a: Readonly<BBoxTuple>, b: Readonly<BBoxTuple>): boolean {
  return a[2] >= b[0] && a[0] <= b[2] && a[3] >= b[1] && a[1] <= b[3];
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
      void handleUnfurlResult(msg.objectId, msg.data);
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
    if (bboxIntersects(b, vb)) invalidateWorldBBox(b);
    return;
  }
  // Fallback for bitmaps arriving before first render tick (hydration):
  // iterate the media-only caches, not all objects.
  if (!hasActiveRoom()) return;
  const vb = getVisibleBoundsTuple();
  forEachImageMeta((id, meta) => {
    if (meta.assetId !== assetId) return;
    const handle = getHandle(id);
    if (!handle) return;
    if (bboxIntersects(handle.bbox, vb)) invalidateWorldBBox(handle.bbox);
  });
  bookmarkCache.forEachLayout((id, layout) => {
    if (layout.ogImageAssetId !== assetId && layout.faviconAssetId !== assetId) return;
    const handle = getHandle(id);
    if (!handle) return;
    if (bboxIntersects(handle.bbox, vb)) invalidateWorldBBox(handle.bbox);
  });
}

// ============================================================
// Public API
// ============================================================

/** Synchronous bitmap access for render path. Returns null if not decoded. */
export function getBitmap(assetId: string): ImageBitmap | null {
  return bitmaps.get(assetId)?.bitmap ?? null;
}

/**
 * Per-asset info that persists across frames. Mark/sweep via `markedAtFrame`:
 * each frame bumps `_frameMark`; visible assets get `markedAtFrame = _frameMark`;
 * the sweep deletes any entry whose mark is stale (and evicts its bitmap).
 * `ppsp` is max-aggregated across all objects sharing an assetId; `bbox` is unioned.
 */
interface AssetInfo {
  ppsp: number;
  nw: number;
  nh: number;
  bbox: BBoxTuple;
  markedAtFrame: number;
}
const _assetInfo = new Map<string, AssetInfo>();
let _frameMark = 0;

/** Decode-request scratch — length-reset each frame, sorted by priority before dispatch. */
enum Priority {
  New = 0,
  Upgrade = 1,
  Downgrade = 2,
}
interface DecodeRequest {
  assetId: string;
  level: 0 | 1 | 2;
  nw: number;
  nh: number;
  priority: Priority;
}
const _decodeQueue: DecodeRequest[] = [];

/**
 * Mark an asset as visible this frame. First mark resets the entry; subsequent marks aggregate
 * (max ppsp, union bbox). Coords passed as 4 numbers to avoid a tuple-construction at the
 * spatial-index call site (rbush items expose flat min/maxX/Y on the ObjectHandle itself).
 */
function markAsset(assetId: string, ppsp: number, nw: number, nh: number, x0: number, y0: number, x1: number, y1: number): void {
  let info = _assetInfo.get(assetId);
  if (!info) {
    info = { ppsp, nw, nh, bbox: [x0, y0, x1, y1], markedAtFrame: _frameMark };
    _assetInfo.set(assetId, info);
    return;
  }
  if (info.markedAtFrame !== _frameMark) {
    info.markedAtFrame = _frameMark;
    info.ppsp = ppsp;
    info.nw = nw;
    info.nh = nh;
    info.bbox[0] = x0;
    info.bbox[1] = y0;
    info.bbox[2] = x1;
    info.bbox[3] = y1;
    return;
  }
  if (ppsp > info.ppsp) {
    info.ppsp = ppsp;
    info.nw = nw;
    info.nh = nh;
  }
  const b = info.bbox;
  if (x0 < b[0]) b[0] = x0;
  if (y0 < b[1]) b[1] = y0;
  if (x1 > b[2]) b[2] = x1;
  if (y1 > b[3]) b[3] = y1;
}

/**
 * Viewport management — called from RenderLoop.tick() every frame.
 *
 * 1. Mark phase A (spatial): query padded viewport, mark each visible image+bookmark
 *    asset using the observer-maintained meta caches (no Y.Map reads).
 * 2. Mark phase B (transform overlay): for translate/scale gestures, also mark selected
 *    images using their transform-output bbox — still gated on padded viewport, so
 *    Ctrl+A → scale doesn't force decode of off-screen images. Fixes edge-scroll
 *    bitmap-eviction bug (stored bbox can leave the padded zone while the transformed
 *    bbox is still on screen).
 * 3. Sweep: delete unmarked entries; evict their bitmaps; cancel their in-flight decodes.
 * 4. Dispatch: classify each marked asset (New / Upgrade / Downgrade-with-hysteresis),
 *    sort by priority asc, send decode messages in that order. Worker processes FIFO →
 *    new-in-view bitmaps arrive before downgrades of already-rendered images.
 *
 * Complexity: O(visible images) per frame. Zero Y.Map reads. Zero allocations in
 * steady state (entries reuse, scratch arrays length-reset).
 */
export function manageImageViewport(): void {
  if (!hasActiveRoom()) return;

  ++_frameMark;

  const vb = getVisibleBoundsTuple();
  const padded = padViewport(vb);

  const { scale } = useCameraStore.getState();
  const dpr = window.devicePixelRatio || 1;

  // === MARK PHASE A: spatial visibility ===
  // Spatial query returns ObjectHandle[] (the handle IS the rbush item) — id/kind/min/max
  // resolve on the handle directly, no getHandle() needed per result. hasActiveRoom guard
  // above already covers the no-room case.
  const visible = getSpatialIndex().queryBBox(padded);
  for (const entry of visible) {
    if (entry.kind === 'image') {
      const meta = getImageMeta(entry.id);
      if (!meta) continue;
      const w = entry.maxX - entry.minX;
      const ppsp = (w * scale * dpr) / meta.nw;
      markAsset(meta.assetId, ppsp, meta.nw, meta.nh, entry.minX, entry.minY, entry.maxX, entry.maxY);
    } else if (entry.kind === 'bookmark') {
      const layout = bookmarkCache.getLayoutById(entry.id);
      if (!layout) continue;
      // Bookmarks always decode at level 0; nw/nh unused for level 0 (worker uses width=0,height=0).
      if (layout.ogImageAssetId) markAsset(layout.ogImageAssetId, Infinity, 1, 1, entry.minX, entry.minY, entry.maxX, entry.maxY);
      if (layout.faviconAssetId) markAsset(layout.faviconAssetId, Infinity, 1, 1, entry.minX, entry.minY, entry.maxX, entry.maxY);
    }
  }

  // === MARK PHASE B: transform overlay ===
  // During translate/scale, the stored spatial-index bbox can lag the live transform
  // output bbox. Re-mark selected images using their transform-output bbox, but only
  // if it still intersects the padded viewport (Ctrl+A → scale must respect viewport).
  const mode = getTransformMode();
  if (mode === 'scale' || mode === 'translate') {
    const { selectedIdSet, kindCounts } = useSelectionStore.getState();
    if (kindCounts.image > 0) {
      for (const id of selectedIdSet) {
        const meta = getImageMeta(id);
        if (!meta) continue;
        const tEntry = getScaleEntry('image', id);
        if (!tEntry) continue;
        const b = tEntry.out.bbox;
        if (!bboxIntersects(b, padded)) continue;
        const w = b[2] - b[0];
        const ppsp = mode === 'scale' ? Infinity : (w * scale * dpr) / meta.nw;
        markAsset(meta.assetId, ppsp, meta.nw, meta.nh, b[0], b[1], b[2], b[3]);
      }
    }
  }

  // === SWEEP: evict unmarked assets ===
  for (const [assetId, info] of _assetInfo) {
    if (info.markedAtFrame === _frameMark) continue;
    _assetInfo.delete(assetId);
    const bm = bitmaps.get(assetId);
    if (bm) {
      bm.bitmap.close();
      bitmaps.delete(assetId);
    }
    if (pending.has(assetId)) {
      workerFor(assetId).postMessage({ type: 'cancel', assetId } satisfies WorkerInbound);
      pending.delete(assetId);
    }
  }

  // === DISPATCH: priority-sorted decode requests ===
  _decodeQueue.length = 0;
  const now = Date.now();
  for (const [assetId, info] of _assetInfo) {
    // (Sweep already removed unmarked entries, so info is fresh.)
    const lastError = errors.get(assetId);
    if (lastError && now - lastError < ERROR_COOLDOWN_MS) continue;

    const neededLevel = ppspToLevel(info.ppsp);
    const cached = bitmaps.get(assetId);
    const p = pending.get(assetId);

    let priority: Priority;
    if (!cached) {
      priority = Priority.New;
    } else if (cached.level > neededLevel) {
      priority = Priority.Upgrade;
    } else if (neededLevel >= cached.level + 2) {
      // 2-level hysteresis — only downgrade on a large zoom-out
      priority = Priority.Downgrade;
    } else {
      continue;
    }

    if (p && p.level === neededLevel) continue; // already in flight at correct level

    _decodeQueue.push({ assetId, level: neededLevel, nw: info.nw, nh: info.nh, priority });
  }

  _decodeQueue.sort((a, b) => a.priority - b.priority);

  for (const req of _decodeQueue) {
    const div = levelDivisor(req.level);
    const width = req.level === 0 ? 0 : mipDim(req.nw, div);
    const height = req.level === 0 ? 0 : mipDim(req.nh, div);
    const gen = ++genCounter;
    pending.set(req.assetId, { gen, level: req.level });
    workerFor(req.assetId).postMessage({
      type: 'decode',
      assetId: req.assetId,
      level: req.level,
      width,
      height,
      gen,
    } satisfies WorkerInbound);
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
 * Hydrate images on room join. Reads `imageCache` + `bookmarkCache` (RoomDocManager's
 * `computeBBoxFor` hydrate pass populates both before calling this).
 * Splits visible vs offscreen via handle.bbox, distributes across workers by hash routing.
 */
export function hydrateImages(): void {
  const { scale } = useCameraStore.getState();
  const dpr = window.devicePixelRatio || 1;
  const vb = getVisibleBoundsTuple();

  // Per-assetId: best level + nw/nh + representative bbox
  const assetMap = new Map<string, { bbox: BBoxTuple; level: 0 | 1 | 2; nw: number; nh: number }>();

  forEachImageMeta((id, meta) => {
    const handle = getHandle(id);
    if (!handle) return;
    const frameW = handle.bbox[2] - handle.bbox[0];
    const ppsp = (frameW * scale * dpr) / meta.nw;
    const level = ppspToLevel(ppsp);
    const existing = assetMap.get(meta.assetId);
    if (!existing || level < existing.level) {
      assetMap.set(meta.assetId, { bbox: handle.bbox, level, nw: meta.nw, nh: meta.nh });
    }
  });

  bookmarkCache.forEachLayout((id, layout) => {
    const handle = getHandle(id);
    if (!handle) return;
    if (layout.ogImageAssetId) assetMap.set(layout.ogImageAssetId, { bbox: handle.bbox, level: 0, nw: 0, nh: 0 });
    if (layout.faviconAssetId) assetMap.set(layout.faviconAssetId, { bbox: handle.bbox, level: 0, nw: 0, nh: 0 });
  });

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
    const isVisible = bboxIntersects(bbox, vb);
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
  _assetInfo.clear();
  _decodeQueue.length = 0;
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
