/**
 * ImageManager — Thin main-thread coordinator for image assets.
 *
 * All heavy work (IDB, CDN fetch, hashing, upload, decode) runs in a demand-scaled
 * pool of identical image-worker instances (one baseline, grows under decode backlog
 * to a hardware ceiling, idle extras self-retire). Decode COMMANDS travel through
 * a SharedArrayBuffer control plane (`image-sab.ts`) — this thread writes desired
 * `{gen, level, w, h}` into a slot and pushes the slot onto a work-stealing ring;
 * any idle worker grabs it. There is no per-decode message and no static routing:
 *   - Cancel/evict  = write `needLevel = -1` + bump the slot's gen. The worker sees
 *                     it at its next `Atomics.load` — instant, lock-free, no message.
 *   - Clear (room)  = bump the global epoch. In-flight decodes abandon at a checkpoint.
 *   - Staleness     = the slot table IS the pending set (`needGen`/`needLevel`); a
 *                     decode is in-flight while `doneGen !== needGen`.
 * Only the decoded ImageBitmap crosses back, by `postMessage` + Transferable
 * (GPU-backed — can't live in a SAB). Worker 0 also handles ingest / upload /
 * unfurl / prefetch (rare, ordered, carry Blobs).
 *
 * Per-frame loop (`manageImageViewport`): zero Y.Map reads, zero steady-state
 * allocations. Per-object asset digests live in subsystem caches owned elsewhere
 * (`image-cache.ts`, `bookmarkCache`); `_assetInfo` persists across frames via
 * mark/sweep with `_frameMark`. In steady state (everything cached at the right
 * level) nothing is classified, pushed, or allocated.
 */

import { hexToBytesInto } from '@avlo/shared';
import { assertCrossOriginIsolated } from '@/core/sab';
import { getBBoxColumn, getHandlesBySlot } from '@/core/slots/slot-table';
import { spatialTree } from '@/core/spatial/spatial-tree';
import { invalidateWorldBBox } from '@/renderer/RenderLoop';
import { getHandle, hasActiveRoom } from '@/runtime/room-runtime';
import { getVisibleBoundsTuple, useCameraStore } from '@/stores/camera-store';
import { useSelectionStore } from '@/stores/selection-store';
import { getTransformModeCode, readGestureOutBBox } from '@/tools/selection/transform';
import { repositionAllPlaceholders } from '../bookmark/bookmark-placeholder';
import { bookmarkCache } from '../bookmark/bookmark-render';
import { handleUnfurlFailed, handleUnfurlResult } from '../bookmark/bookmark-unfurl';
import type { BBoxTuple } from '../types/geometry';
import { forEachImageMeta, getImageMeta } from './image-cache';
import {
  allocImageSab,
  bumpEpoch,
  EVICTED,
  F_DONE_GEN,
  F_NEED_GEN,
  F_NEED_H,
  F_NEED_LEVEL,
  F_NEED_W,
  type ImageSab,
  SLOT_COUNT,
} from './image-sab';
import type { WorkerInbound, WorkerOutbound } from './image-worker';

// ============================================================
// Workers + SAB control plane
// ============================================================

// A demand-scaled pool of identical image-worker instances (loop-spawned from one URL — Vite
// bundles it once). Created lazily via ensureImageWorkers() (from RoomDocManager construction)
// so a bare module import spawns NO workers. Worker 0 is "primary" (ingest + upload + unfurl +
// prefetch) and permanent; extras spawn under decode backlog and self-retire when idle.
//
// Baseline is a SINGLE worker: decode-loop stealing, ingest, upload, unfurl and prefetch all
// bottom out in async / off-thread primitives (createImageBitmap, crypto.subtle.digest, fetch,
// Cache API, IndexedDB), and the futex keeps the event loop live while parked — so they
// cooperatively interleave on one event loop with no job blocking another. Correctness is
// independent of worker count (work-stealing + slot-table-as-truth); extra workers only add
// PARALLEL decode throughput, which growPoolToBacklog() restores on demand. Steady state is one
// idle isolate instead of a hardware-max pool of them. Flip BASE_WORKERS to 2 to trade an idle
// isolate for zero cold-burst spin-up latency on the first parallel decode.
const BASE_WORKERS = 1;
// Ceiling reached only under load: same clamp the old fixed pool used, now demand-gated.
const MAX_WORKERS = Math.min(4, Math.max(2, (navigator.hardwareConcurrency || 4) - 1));
// An extra worker idle (no decode) for this long self-terminates back toward the base.
const IDLE_EXIT_MS = 10_000;

/** Index-stable pool. `workers[0]` is permanent; `null` = a retired/never-spawned extra slot. */
let workers: (Worker | null)[] = [];
/** === workers[0]. Permanent, non-null after ensureImageWorkers(); target of all message-driven work. */
let primary!: Worker;
/** Count of live (non-null) workers — grow/retire bookkeeping, floored at BASE_WORKERS. */
let liveWorkers = 0;
let workersReady = false;

/** The shared command/cancel/staleness plane. Allocated once in ensureImageWorkers(). */
let imageSab!: ImageSab;

/** assetId → slot index. The slot table holds each asset's desired gen/level/dims + hash. */
const registry = new Map<string, number>();
/** Free slot indices (stack). Initialized in ensureImageWorkers(), reset on clear(). */
const freeSlots: number[] = [];
/** Per-slot last gen pushed to a ring — dedups duplicate ring entries within/across frames. */
let queuedGen!: Int32Array;

/**
 * Spawn the image worker pool if not already up. Idempotent + session-scoped. Called from
 * RoomDocManager construction (synchronously, in parallel with its async init) so the first
 * image bitmap is ready ASAP. Asserts cross-origin isolation (the SAB + Atomics.waitAsync
 * contract) — the isolation headers are set in both dev and prod, so a throw here means a
 * misconfiguration, not a runtime fallback.
 */
export function ensureImageWorkers(): void {
  if (workersReady) return;

  // Assert BEFORE marking ready: a missing-isolation throw then leaves workersReady=false, so it
  // re-throws in every RoomDocManager ctor (clean abort — hasActiveRoom stays false) instead of
  // poisoning the module (later rooms would early-return with imageSab still undefined).
  assertCrossOriginIsolated();
  workersReady = true;
  imageSab = allocImageSab();
  queuedGen = new Int32Array(SLOT_COUNT);
  resetFreeList();

  workers = [];
  liveWorkers = 0;
  for (let i = 0; i < BASE_WORKERS; i++) spawnWorker(i);
  primary = workers[0] as Worker;
  // Drain uploads queued in a prior session, now that a room exists.
  primary.postMessage({ type: 'drain-uploads' } satisfies WorkerInbound);
}

/**
 * Spawn one work-stealing worker at `index` and wire it to the shared SAB. Base workers
 * (`index < BASE_WORKERS`) get `idleExitMs = 0` (permanent); extras get IDLE_EXIT_MS so they
 * self-retire when idle. The SAB is shared by reference (never transferred / neutered) — every
 * worker maps the same memory.
 */
function spawnWorker(index: number): void {
  const w = new Worker(new URL('./image-worker.ts', import.meta.url), { type: 'module' });
  w.onmessage = handleWorkerMessage;
  w.onerror = (ev) => console.error('[image-worker] onerror', index, ev.message);
  w.onmessageerror = (ev) => console.error('[image-worker] onmessageerror', index, ev);
  const idleExitMs = index >= BASE_WORKERS ? IDLE_EXIT_MS : 0;
  w.postMessage({ type: 'init', index, sab: imageSab.sab, idleExitMs } satisfies WorkerInbound);
  workers[index] = w;
  liveWorkers++;
}

/**
 * Grow the pool toward the current decode backlog — called after each dispatch (peak ring
 * depth). Spawns extra work-stealing workers, up to MAX_WORKERS, so a media-heavy hydration or
 * a big scroll-in fans out instead of draining single-file. The `pending > liveWorkers` gate
 * skips trivial backlog the live workers clear promptly (no thrash on casual single-image
 * scroll-in) yet fires on any real burst — or on a stalled worker, whose undrained backlog trips
 * it next frame. Extras self-retire once idle, returning to BASE_WORKERS. Cheap when maxed or
 * caught up (two atomic loads + early return).
 */
function growPoolToBacklog(): void {
  if (liveWorkers >= MAX_WORKERS) return;
  const pending = imageSab.highRing.depth() + imageSab.lowRing.depth();
  if (pending <= liveWorkers) return; // the live workers can absorb this backlog promptly
  const target = Math.min(MAX_WORKERS, pending);
  let index = BASE_WORKERS;
  while (liveWorkers < target) {
    while (workers[index]) index++; // first free slot (reuses indices left by retired extras)
    spawnWorker(index);
  }
}

/** Post a message to the primary worker (worker 0). Used by bookmark-unfurl for unfurl commands. */
export function postToPrimary(msg: WorkerInbound): void {
  primary.postMessage(msg);
}

function resetFreeList(): void {
  freeSlots.length = 0;
  for (let i = SLOT_COUNT - 1; i >= 0; i--) freeSlots.push(i); // pop → 0,1,2,…
}

// Reused scratch for the assetId-hex → 32 SHA-256 bytes conversion on slot alloc (zero per-call alloc).
const _hashScratch = new Uint8Array(32);

/** Allocate a slot for a new asset and write its 32 hash bytes once. Returns -1 if exhausted. */
function allocSlot(assetId: string): number {
  const slot = freeSlots.pop();
  if (slot === undefined) return -1;
  registry.set(assetId, slot);
  hexToBytesInto(assetId, _hashScratch);
  imageSab.slots.setHash(slot, _hashScratch);
  return slot;
}

function freeSlot(assetId: string, slot: number): void {
  registry.delete(assetId);
  freeSlots.push(slot);
}

/** A decode is in flight at `level` while we've asked for it and no worker has stamped done yet. */
function isSlotInFlight(slot: number, level: number): boolean {
  return (
    imageSab.slots.load(slot, F_NEED_LEVEL) === level && imageSab.slots.load(slot, F_DONE_GEN) !== imageSab.slots.load(slot, F_NEED_GEN)
  );
}

// Reused [slot, gen] record so ring pushes allocate nothing.
const _pushRec = new Int32Array(2);
function pushDecode(slot: number, gen: number, high: boolean): boolean {
  _pushRec[0] = slot;
  _pushRec[1] = gen;
  return (high ? imageSab.highRing : imageSab.lowRing).tryPush(_pushRec);
}

let _warnedExhaustion = false;
function warnSlotExhaustion(): void {
  if (_warnedExhaustion) return;
  _warnedExhaustion = true;
  console.warn('[image-manager] slot table exhausted (>512 visible assets) — overflow retries next frame');
}

let _warnedRingFull = false;
function warnRingFull(): void {
  if (_warnedRingFull) return;
  _warnedRingFull = true;
  console.warn('[image-manager] decode ring full — overflow retries next frame');
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

// Scratch tuple — overwritten each call. Safe because spatialTree.query reads
// the four scalars synchronously and doesn't retain them.
const _paddedScratch: BBoxTuple = [0, 0, 0, 0];
// Gesture out-bbox copy target for the transform mark phase (readGestureOutBBox).
const _gestureBBoxScratch: BBoxTuple = [0, 0, 0, 0];
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

/** Write a slot's desired level + decode dims for `level`, derived from natural dims. */
function writeNeed(slot: number, level: 0 | 1 | 2, nw: number, nh: number): void {
  const div = levelDivisor(level);
  imageSab.slots.store(slot, F_NEED_LEVEL, level);
  imageSab.slots.store(slot, F_NEED_W, level === 0 ? 0 : mipDim(nw, div));
  imageSab.slots.store(slot, F_NEED_H, level === 0 ? 0 : mipDim(nh, div));
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

      // Staleness: the slot's gen is the current intent. No slot (evicted) or a moved-on gen ⇒ stale.
      const slot = registry.get(msg.assetId);
      if (slot === undefined || imageSab.slots.load(slot, F_NEED_GEN) !== msg.gen) {
        msg.bitmap.close();
        return;
      }

      const old = bitmaps.get(msg.assetId);
      if (old) old.bitmap.close();
      bitmaps.set(msg.assetId, { bitmap: msg.bitmap, level: msg.level });
      errors.delete(msg.assetId); // Clear error on success (self-healing)

      invalidateBitmapRegion(msg.assetId);
      break;
    }

    case 'uploaded': {
      // Informational — no action needed on main thread
      break;
    }

    case 'worker-exit': {
      // An idle extra self-terminated. Free its slot so growPoolToBacklog can reuse the index.
      if (workers[msg.index]) {
        workers[msg.index] = null;
        liveWorkers--;
      }
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
        const slot = registry.get(msg.assetId);
        if (msg.gen != null) {
          // Only process if gen matches (don't set cooldown for superseded requests)
          if (slot === undefined || imageSab.slots.load(slot, F_NEED_GEN) !== msg.gen) return; // stale error
          // Stamp doneGen so the failed request is no longer "in flight" — the cooldown gates
          // retry; without this the slot would look perpetually pending and never re-dispatch.
          imageSab.slots.store(slot, F_DONE_GEN, msg.gen);
        }
        errors.set(msg.assetId, Date.now());
      }
      break;
    }
  }
}

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
 * the sweep deletes any entry whose mark is stale (and evicts its bitmap + slot).
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
 * spatial call site (boxes read straight off the global bbox column at `slot * 4`).
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
 * 3. Sweep: delete unmarked entries; evict their bitmaps; free their slots (writes
 *    needLevel = -1 + bumps gen so any in-flight decode abandons — replaces the cancel message).
 * 4. Dispatch: classify each marked asset (New / Upgrade / Downgrade-with-hysteresis),
 *    sort by priority asc, then write each slot's desired level/dims, bump its gen, and
 *    push it onto the high (New) or low (Upgrade/Downgrade) ring. ONE futex signal for the
 *    whole batch wakes the idle workers.
 *
 * Complexity: O(visible images) per frame. Zero Y.Map reads. Zero allocations in
 * steady state (entries reuse; scratch arrays length-reset; nothing classified/pushed).
 */
export function manageImageViewport(): void {
  if (!hasActiveRoom()) return;

  ++_frameMark;

  const vb = getVisibleBoundsTuple();
  const padded = padViewport(vb);

  const { scale } = useCameraStore.getState();
  const dpr = window.devicePixelRatio || 1;

  // === MARK PHASE A: spatial visibility ===
  // Wide-twin query fills `spatialTree.results` with slots; kind/id resolve via the
  // slot reverse map, boxes straight off the global bbox column (`slot * 4` lanes).
  // hasActiveRoom guard above already covers the no-room case.
  const n = spatialTree.query(padded[0], padded[1], padded[2], padded[3]);
  const res = spatialTree.results;
  const bySlot = getHandlesBySlot();
  const col = getBBoxColumn();
  for (let i = 0; i < n; i++) {
    const slot = res[i];
    const entry = bySlot[slot]!;
    if (entry.kind === 'image') {
      const meta = getImageMeta(entry.id);
      if (!meta) continue;
      const b = slot * 4;
      const w = col[b + 2] - col[b];
      const ppsp = (w * scale * dpr) / meta.nw;
      markAsset(meta.assetId, ppsp, meta.nw, meta.nh, col[b], col[b + 1], col[b + 2], col[b + 3]);
    } else if (entry.kind === 'bookmark') {
      const layout = bookmarkCache.getLayoutById(entry.id);
      if (!layout) continue;
      const b = slot * 4;
      // Bookmarks always decode at level 0; nw/nh unused for level 0 (worker uses width=0,height=0).
      if (layout.ogImageAssetId) markAsset(layout.ogImageAssetId, Infinity, 1, 1, col[b], col[b + 1], col[b + 2], col[b + 3]);
      if (layout.faviconAssetId) markAsset(layout.faviconAssetId, Infinity, 1, 1, col[b], col[b + 1], col[b + 2], col[b + 3]);
    }
  }

  // === MARK PHASE B: transform overlay ===
  // During translate/scale, the stored spatial-index bbox can lag the live transform
  // output bbox. Re-mark selected images using their gesture out-bbox lanes, but only
  // if it still intersects the padded viewport (Ctrl+A → scale must respect viewport).
  const mc = getTransformModeCode();
  if (mc === 1 || mc === 2) {
    const { selectedIdSet, kindCounts } = useSelectionStore.getState();
    if (kindCounts.image > 0) {
      for (const id of selectedIdSet) {
        const meta = getImageMeta(id);
        if (!meta) continue;
        const h = getHandle(id);
        if (!h || h.kind !== 'image') continue;
        if (!readGestureOutBBox(h.slot, _gestureBBoxScratch)) continue;
        const b = _gestureBBoxScratch;
        if (!bboxIntersects(b, padded)) continue;
        const w = b[2] - b[0];
        const ppsp = mc === 1 ? Infinity : (w * scale * dpr) / meta.nw;
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
    const slot = registry.get(assetId);
    if (slot !== undefined) {
      imageSab.slots.store(slot, F_NEED_LEVEL, EVICTED);
      imageSab.slots.bump(slot, F_NEED_GEN); // supersede any in-flight decode
      freeSlot(assetId, slot);
    }
  }

  // === CLASSIFY: priority per marked asset ===
  _decodeQueue.length = 0;
  const now = Date.now();
  for (const [assetId, info] of _assetInfo) {
    // (Sweep already removed unmarked entries, so info is fresh.)
    const lastError = errors.get(assetId);
    if (lastError && now - lastError < ERROR_COOLDOWN_MS) continue;

    const neededLevel = ppspToLevel(info.ppsp);
    const cached = bitmaps.get(assetId);
    const slot = registry.get(assetId);

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

    // Already requested at this exact level and no worker has finished it → leave it.
    if (slot !== undefined && isSlotInFlight(slot, neededLevel)) continue;

    _decodeQueue.push({ assetId, level: neededLevel, nw: info.nw, nh: info.nh, priority });
  }

  _decodeQueue.sort((a, b) => a.priority - b.priority);

  // === DISPATCH: write intent + push to lane, then ONE signal for the batch ===
  let signal = false;
  for (const req of _decodeQueue) {
    let slot = registry.get(req.assetId);
    if (slot === undefined) {
      slot = allocSlot(req.assetId);
      if (slot < 0) {
        warnSlotExhaustion();
        continue; // overflow asset retries next frame as slots free
      }
    }
    writeNeed(slot, req.level, req.nw, req.nh);
    const gen = imageSab.slots.bump(slot, F_NEED_GEN);
    if (queuedGen[slot] === gen) continue; // already queued this exact request
    if (pushDecode(slot, gen, req.priority === Priority.New)) {
      queuedGen[slot] = gen;
      signal = true;
    } else {
      // Ring full: clear the in-flight marker so next frame re-dispatches (else doneGen
      // stays behind needGen and the slot looks perpetually pending).
      imageSab.slots.store(slot, F_DONE_GEN, gen);
      warnRingFull();
    }
  }
  if (signal) imageSab.futex.signal();

  // Fan out to more workers if a backlog is building; unconditional (not gated on `signal`) so a
  // stalled worker's undrained ring still trips growth. Cheap when caught up or maxed.
  growPoolToBacklog();

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
    primary.postMessage({ type: 'ingest', id, blob: file } satisfies WorkerInbound);
  });
}

/**
 * Hydrate images on room join. Reads `imageCache` + `bookmarkCache` (RoomDocManager's
 * `computeBBoxFor` hydrate pass populates both before calling this). Visible assets get a
 * slot + a push to the high lane (work-stealing distributes them across the pool — no by-hash
 * split). Offscreen assets are cache-warmed via a single prefetch message to worker 0.
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

  let signal = false;
  let prefetch: string[] | null = null;
  for (const [assetId, { bbox, level, nw, nh }] of assetMap) {
    if (bboxIntersects(bbox, vb)) {
      let slot = registry.get(assetId);
      if (slot === undefined) slot = allocSlot(assetId);
      if (slot < 0) {
        warnSlotExhaustion();
        continue;
      }
      writeNeed(slot, level, nw, nh);
      const gen = imageSab.slots.bump(slot, F_NEED_GEN);
      if (queuedGen[slot] === gen) continue;
      if (pushDecode(slot, gen, true)) {
        queuedGen[slot] = gen;
        signal = true;
      } else {
        // Ring full → clear the in-flight marker so manageImageViewport re-dispatches next tick.
        imageSab.slots.store(slot, F_DONE_GEN, gen);
      }
    } else {
      (prefetch ??= []).push(assetId);
    }
  }
  if (signal) imageSab.futex.signal();
  if (prefetch) primary.postMessage({ type: 'prefetch', assetIds: prefetch } satisfies WorkerInbound);
  // A room join can surface many visible assets at once — fan out immediately for the burst.
  growPoolToBacklog();
}

/** Enqueue asset for upload. Fire-and-forget. */
export function enqueue(assetId: string): void {
  primary.postMessage({ type: 'enqueue-upload', assetId } satisfies WorkerInbound);
}

/**
 * Room teardown: close all bitmaps, clear all state, abandon in-flight decodes.
 * Bumping the global epoch makes every worker mid-decode bail at its next checkpoint;
 * resetting the rings + registry + free-list readies the plane for the next room.
 */
export function clear(): void {
  for (const entry of bitmaps.values()) {
    entry.bitmap.close();
  }
  bitmaps.clear();
  errors.clear();
  inflightIngests.clear();
  _assetInfo.clear();
  _decodeQueue.length = 0;
  registry.clear();
  if (workersReady) {
    resetFreeList();
    queuedGen.fill(0);
    imageSab.highRing.reset();
    imageSab.lowRing.reset();
    bumpEpoch(imageSab.ctrl); // in-flight decodes abandon at their next checkpoint
    imageSab.futex.signal(); // wake any parked worker so it re-checks (now-empty) rings
  }
}

// ============================================================
// Module-level init (runs once on import)
// ============================================================

// Online → resume the upload drain. Registered at module scope (cheap; spawns no worker) so it's
// live even on a future landing/dashboard entry, but guarded on `workersReady`: with no room
// opened this session there's no pool and nothing in-memory to drain (prior-session IDB uploads
// drain when the first RoomDocManager calls ensureImageWorkers()).
window.addEventListener('online', () => {
  if (workersReady) primary.postMessage({ type: 'online' } satisfies WorkerInbound);
});
