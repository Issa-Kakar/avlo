/**
 * ImageManager — Thin main-thread coordinator for image assets.
 *
 * All heavy work (IDB, CDN fetch, hashing, upload, decode) runs in image-worker.ts.
 * This module only manages in-memory bitmap references and viewport-driven decode requests.
 *
 * State:
 *   bitmaps: Map<assetId, { bitmap, level }> — decoded bitmaps at current mip level
 *   pending: Set<assetId> — in-flight decode requests (prevents duplicate worker messages)
 *   errors:  Map<assetId, timestamp> — failed assets with cooldown-based retry (15s)
 *   inflightIngests: Map<id, { resolve, reject }> — ingest promise tracking
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
import type * as Y from 'yjs';
import type { ObjectKind } from '@avlo/shared';

// ============================================================
// Worker
// ============================================================

const worker = new Worker(new URL('./image-worker.ts', import.meta.url), { type: 'module' });

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

/** AssetIds with in-flight decode requests — prevents duplicate worker messages. */
const pending = new Set<string>();

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
    minX: vb.minX - vw * 0.25,
    minY: vb.minY - vh * 0.25,
    maxX: vb.maxX + vw * 0.25,
    maxY: vb.maxY + vh * 0.25,
  };
}

function ppspToLevel(ppsp: number): 0 | 1 | 2 {
  return ppsp > 0.5 ? 0 : ppsp > 0.25 ? 1 : 2;
}

function levelDivisor(level: 0 | 1 | 2): number {
  return level === 0 ? 1 : level === 1 ? 2 : 4;
}

// ============================================================
// Worker Message Handler
// ============================================================

worker.onmessage = (e: MessageEvent<WorkerOutbound>) => {
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
        pending.delete(msg.assetId);
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
        pending.delete(msg.assetId);
        errors.set(msg.assetId, Date.now());
      }
      break;
    }
  }
};

/** Query spatial index for objects with this assetId and invalidate their regions. */
function invalidateBitmapRegion(assetId: string): void {
  if (!hasActiveRoom()) return;
  try {
    const snapshot = getCurrentSnapshot();
    if (!snapshot?.spatialIndex) return;
    const vb = getVisibleWorldBounds();
    const padded = padViewport(vb);
    const entries = snapshot.spatialIndex.query(padded);
    for (const entry of entries) {
      if (entry.kind !== 'image') continue;
      const handle = snapshot.objectsById.get(entry.id);
      if (handle && getAssetId(handle.y) === assetId) {
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

/** Per-asset info reused each frame to avoid allocations. */
interface AssetInfo {
  ppsp: number;
  nw: number;
  nh: number;
}
const _assetInfo = new Map<string, AssetInfo>();

/**
 * Viewport management — called from RenderLoop.tick() every frame.
 *
 * Reads camera store + snapshot internally. No parameters.
 * 1. Queries spatial index with 1.5× padded viewport
 * 2. Computes per-image ppsp → needed mip level + target decode dimensions
 * 3. Requests decode for visible assets without correct mip (dedup via pending)
 * 4. Evicts bitmaps for assets no longer visible
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

    const prev = _assetInfo.get(assetId);
    if (!prev || ppsp > prev.ppsp) {
      _assetInfo.set(assetId, { ppsp, nw, nh });
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

    if ((!cached || cached.level !== neededLevel) && !pending.has(assetId)) {
      const div = levelDivisor(neededLevel);
      const width = neededLevel === 0 ? 0 : Math.round(info.nw / div);
      const height = neededLevel === 0 ? 0 : Math.round(info.nh / div);
      worker.postMessage({
        type: 'decode',
        assetId,
        level: neededLevel,
        width,
        height,
      } satisfies WorkerInbound);
      pending.add(assetId);
    }
  }

  // Eviction — close bitmaps for assets no longer in viewport
  for (const [assetId, entry] of bitmaps) {
    if (!_assetInfo.has(assetId)) {
      entry.bitmap.close();
      bitmaps.delete(assetId);
      pending.delete(assetId); // Allow fresh request on scroll-back
    }
  }
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
    worker.postMessage({ type: 'ingest', id, blob: file } satisfies WorkerInbound);
  });
}

/**
 * Hydrate images on room join.
 * Manager splits visible vs offscreen, computes decode dimensions for visible.
 * Uses exact viewport (no padding) for decode visibility.
 * Pre-adds visible assetIds to pending to prevent duplicate decode on first manageImageViewport tick.
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
    if ((yObj.get('kind') as ObjectKind) !== 'image') return;
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

  // Manager-side split: visible (exact viewport) vs prefetch
  const visible: { assetId: string; level: 0 | 1 | 2; width: number; height: number }[] = [];
  const prefetch: string[] = [];

  for (const [assetId, { frame, level, nw, nh }] of assetMap) {
    if (frameTupleIntersectsBounds(frame, vb)) {
      const div = levelDivisor(level);
      visible.push({
        assetId,
        level,
        width: level === 0 ? 0 : Math.round(nw / div),
        height: level === 0 ? 0 : Math.round(nh / div),
      });
      pending.add(assetId);
    } else {
      prefetch.push(assetId);
    }
  }

  worker.postMessage({ type: 'hydrate', visible, prefetch } satisfies WorkerInbound);
}

/** Enqueue asset for upload. Fire-and-forget. */
export function enqueue(assetId: string): void {
  worker.postMessage({ type: 'enqueue-upload', assetId } satisfies WorkerInbound);
}

/** Room teardown: close all bitmaps, clear all state. */
export function clear(): void {
  for (const entry of bitmaps.values()) {
    entry.bitmap.close();
  }
  bitmaps.clear();
  pending.clear();
  errors.clear();
  inflightIngests.clear();
}

// ============================================================
// Module-level init (runs once on import)
// ============================================================

window.addEventListener('online', () => {
  worker.postMessage({ type: 'online' } satisfies WorkerInbound);
});

// Drain pending uploads from prior sessions
worker.postMessage({ type: 'drain-uploads' } satisfies WorkerInbound);
