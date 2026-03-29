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

import type { WorldBounds, FrameTuple } from '@avlo/shared';
import {
  getAssetId,
  getFrame,
  getNaturalDimensions,
  bboxToBounds,
  frameTupleIntersectsBounds,
} from '@avlo/shared';
import type { WorkerInbound, WorkerOutbound } from './image-worker';
import { invalidateWorld } from '@/canvas/invalidation-helpers';
import { hasActiveRoom, getCurrentSnapshot } from '@/canvas/room-runtime';
import { useCameraStore, getVisibleWorldBounds } from '@/stores/camera-store';
import { useSelectionStore } from '@/stores/selection-store';
import type * as Y from 'yjs';
import type { ObjectKind } from '@avlo/shared';
import { handleUnfurlResult, handleUnfurlFailed } from '@/lib/bookmark/bookmark-unfurl';
import { repositionAllPlaceholders } from '@/lib/bookmark/bookmark-placeholder';

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
const inflightIngests = new Map<
  string,
  { resolve: (result: IngestResult) => void; reject: (err: Error) => void }
>();

// ============================================================
// Helpers
// ============================================================

function padViewport(vb: WorldBounds): WorldBounds {
  const vw = vb.maxX - vb.minX;
  const vh = vb.maxY - vb.minY;
  return {
    minX: vb.minX - vw * 2.25,
    minY: vb.minY - vh * 2.25,
    maxX: vb.maxX + vw * 2.25,
    maxY: vb.maxY + vh * 2.25,
  };
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

/** Invalidate canvas region for decoded bitmap. O(1) via cached bounds, gated on actual viewport. */
function invalidateBitmapRegion(assetId: string): void {
  // Fast path: pre-computed union bounds from most recent manageImageViewport tick.
  // Only invalidate if actually visible — off-viewport bitmaps sit in the map silently
  // until the user scrolls to them (the render pass will draw them naturally).
  const info = _assetInfo.get(assetId);
  if (info) {
    const vb = getVisibleWorldBounds();
    const b = info.bounds;
    if (b.maxX >= vb.minX && b.minX <= vb.maxX && b.maxY >= vb.minY && b.minY <= vb.maxY) {
      invalidateWorld(b);
    }
    return;
  }
  // Fallback for bitmaps arriving before first render tick (hydration):
  // simple bounds intersection, no spatial query
  if (!hasActiveRoom()) return;
  try {
    const snapshot = getCurrentSnapshot();
    if (!snapshot) return;
    const vb = getVisibleWorldBounds();
    for (const handle of snapshot.objectsById.values()) {
      if (handle.kind !== 'image' && handle.kind !== 'bookmark') continue;
      const handleAssetId =
        handle.kind === 'image'
          ? getAssetId(handle.y)
          : ((handle.y.get('ogImageAssetId') as string | undefined) ??
            (handle.y.get('faviconAssetId') as string | undefined));
      if (handleAssetId !== assetId) continue;
      const [minX, minY, maxX, maxY] = handle.bbox;
      if (maxX >= vb.minX && minX <= vb.maxX && maxY >= vb.minY && minY <= vb.maxY) {
        invalidateWorld(bboxToBounds(handle.bbox));
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

/** Per-asset info reused each frame to avoid allocations. Includes union bounds for O(1) invalidation. */
interface AssetInfo {
  ppsp: number;
  nw: number;
  nh: number;
  bounds: WorldBounds;
}
const _assetInfo = new Map<string, AssetInfo>();

/** Register or merge asset info for viewport management. */
function registerAssetInfo(
  assetId: string,
  ppsp: number,
  nw: number,
  nh: number,
  bMinX: number,
  bMinY: number,
  bMaxX: number,
  bMaxY: number,
): void {
  const prev = _assetInfo.get(assetId);
  if (!prev) {
    _assetInfo.set(assetId, {
      ppsp,
      nw,
      nh,
      bounds: { minX: bMinX, minY: bMinY, maxX: bMaxX, maxY: bMaxY },
    });
  } else {
    if (ppsp > prev.ppsp) {
      prev.ppsp = ppsp;
      prev.nw = nw;
      prev.nh = nh;
    }
    const pb = prev.bounds;
    if (bMinX < pb.minX) pb.minX = bMinX;
    if (bMinY < pb.minY) pb.minY = bMinY;
    if (bMaxX > pb.maxX) pb.maxX = bMaxX;
    if (bMaxY > pb.maxY) pb.maxY = bMaxY;
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

  let snapshot;
  try {
    snapshot = getCurrentSnapshot();
  } catch {
    return;
  }
  if (!snapshot?.spatialIndex) return;

  const vb = getVisibleWorldBounds();
  const padded = padViewport(vb);
  const visible = snapshot.spatialIndex.query(padded);

  const { scale } = useCameraStore.getState();
  const dpr = window.devicePixelRatio || 1;

  _assetInfo.clear();

  for (const entry of visible) {
    if (entry.kind === 'bookmark') {
      const handle = snapshot.objectsById.get(entry.id);
      if (!handle) continue;
      const ogId = handle.y.get('ogImageAssetId') as string | undefined;
      const favId = handle.y.get('faviconAssetId') as string | undefined;
      const frame = getFrame(handle.y);
      if (!frame) continue;
      const [bMinX, bMinY, bMaxX, bMaxY] = handle.bbox;
      // OG image + favicon: always level 0, no mip levels needed
      for (const aid of [ogId, favId]) {
        if (!aid) continue;
        registerAssetInfo(aid, Infinity, frame[2], frame[2], bMinX, bMinY, bMaxX, bMaxY);
      }
      continue;
    }
    if (entry.kind !== 'image') continue;
    const handle = snapshot.objectsById.get(entry.id);
    if (!handle) continue;
    const assetId = getAssetId(handle.y);
    if (!assetId) continue;
    const frame = getFrame(handle.y);
    if (!frame) continue;

    const dims = getNaturalDimensions(handle.y);
    const nw = dims ? dims[0] : frame[2];
    const nh = dims ? dims[1] : frame[3];
    const ppsp = (frame[2] * scale * dpr) / nw;
    const [bMinX, bMinY, bMaxX, bMaxY] = handle.bbox;

    registerAssetInfo(assetId, ppsp, nw, nh, bMinX, bMinY, bMaxX, bMaxY);
  }

  // During scale transforms, force full-res for selected images (crisp preview)
  const { transform: selTransform, kindCounts, selectedIdSet } = useSelectionStore.getState();
  if (selTransform.kind === 'scale' && kindCounts.images > 0) {
    for (const id of selectedIdSet) {
      const handle = snapshot.objectsById.get(id);
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
 * Manager splits visible vs offscreen, computes decode dimensions for visible.
 * Uses exact viewport (no padding) for decode visibility.
 * Distributes items across workers by hash routing, assigns gen per visible item.
 */
export function hydrateImages(objects: Y.Map<Y.Map<unknown>>): void {
  const { scale } = useCameraStore.getState();
  const dpr = window.devicePixelRatio || 1;
  const vb = getVisibleWorldBounds();

  // Collect per-assetId: best level (min level = highest quality) + natural dims + representative frame
  const assetMap = new Map<
    string,
    { frame: FrameTuple; level: 0 | 1 | 2; nw: number; nh: number }
  >();

  objects.forEach((yObj) => {
    const kind = yObj.get('kind') as ObjectKind;
    if (kind === 'bookmark') {
      const ogId = yObj.get('ogImageAssetId') as string | undefined;
      const favId = yObj.get('faviconAssetId') as string | undefined;
      const frame = yObj.get('frame') as FrameTuple | undefined;
      if (!frame) return;
      for (const aid of [ogId, favId]) {
        if (!aid) continue;
        assetMap.set(aid, { frame, level: 0, nw: frame[2], nh: frame[3] });
      }
      return;
    }
    if (kind !== 'image') return;
    const assetId = yObj.get('assetId') as string | undefined;
    const frame = yObj.get('frame') as FrameTuple | undefined;
    if (!assetId || !frame) return;

    const nw = (yObj.get('naturalWidth') as number) ?? frame[2];
    const nh = (yObj.get('naturalHeight') as number) ?? frame[3];
    const ppsp = (frame[2] * scale * dpr) / nw;
    const level = ppspToLevel(ppsp);

    const existing = assetMap.get(assetId);
    if (!existing || level < existing.level) {
      assetMap.set(assetId, { frame, level, nw, nh });
    }
  });

  if (assetMap.size === 0) return;

  // Group by worker via hash routing
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

  for (const [assetId, { frame, level, nw, nh }] of assetMap) {
    const idx = assetId.charCodeAt(0) & 1;
    if (frameTupleIntersectsBounds(frame, vb)) {
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
