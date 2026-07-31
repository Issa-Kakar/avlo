import type { BBoxTuple } from '../types/geometry';
import type { ObjectHandle } from '../types/objects';

/**
 * Slot table — the app-wide dense-id fabric. Every live object owns one u32
 * `slot` (< 2^30) for its `objectsById` lifetime; parallel columns keyed by
 * that slot give every subsystem O(1) SoA access without string maps:
 *
 *   `_handles`  slot → ObjectHandle reverse map (the inverse of `handle.slot`)
 *   `_bboxes`   interleaved minX,minY,maxX,maxY at `slot * 4` — the global
 *               bbox column (veil worker payloads; future FlatRTree bulk load,
 *               whose item-indexed `load()` layout coincides with this column
 *               exactly while slots are dense, i.e. post-hydrate)
 *
 * Consumers with their own slot-keyed columns (ZRankTable ranks, lock-table
 * owner/locked columns) size off `slotHighWater()` / `slotCapacity()`.
 *
 * WRITER DISCIPLINE
 * - `acquireSlot`/`releaseSlot`/`registerHandle`: RoomDocManager only (handle
 *   create/delete + hydrate). Callers pair every `acquireSlot()` with
 *   `lockSlotAcquired(slot)` — the lock columns grow in lockstep but live in
 *   the sibling leaf `core/locks/lock-table.ts`, which must stay importable
 *   from here-adjacent consumers without a runtime cycle, so the pairing is
 *   explicit at the call sites rather than folded in.
 * - `writeSlotBBox`: `ObjectSpatialIndex.updateHandleBBox` only — the sole
 *   post-creation bbox writer path, immediately after `applyHandleBBox`, so
 *   tuple + 4 mirrors + column always move together.
 *
 * LIFECYCLE
 * - Release nulls the reverse-map entry (a retained ref would root a deleted
 *   Y.Map — GC leak) but leaves the bbox lane STALE. Contract: consumers only
 *   index live slots. The one async reader (the veil microtask) reads slots
 *   from peer records that observer Phase A prunes synchronously before the
 *   slot is freed — see `fillRemoteLockedBoxes`.
 * - Between `acquireSlot()` and `registerHandle()` the slot's reverse-map cell
 *   is stale/null. The window is synchronous inside one observer fire /
 *   hydrate pass — no consumer can observe it.
 * - `_free` is sized in lockstep with `_cap`, so release NEVER grows
 *   (`_freeCount ≤ _next ≤ _cap` structurally).
 *
 * INDEXING RULE: column offsets are `slot * 4`, never `slot << 2` — a negative
 * int32 slot smuggled into a shift wraps to a huge index and the typed-array
 * store/read silently misses; the multiply keeps it a visible negative.
 *
 * LEAF MODULE — type-only imports. Fellow leaves (lock-table) and hot
 * consumers (renderer, pickers) import module getters directly; getters return
 * live refs under the fetch-per-frame/loop contract (`getLockOwners` idiom:
 * refetch after any acquire — growth replaces the arrays).
 */

const INITIAL_CAP = 256;

let _cap = INITIAL_CAP;
/** High-water mark: slots [0, _next) have been handed out at least once. */
let _next = 0;
let _free = new Int32Array(INITIAL_CAP);
let _freeCount = 0;
let _handles: (ObjectHandle | null)[] = new Array(INITIAL_CAP).fill(null);
let _bboxes = new Float64Array(INITIAL_CAP * 4);

/**
 * Hand out a dense slot — LIFO-recycled else fresh. Grows every column
 * together (bbox lanes copied — live boxes must survive growth).
 * Callers pair with `lockSlotAcquired(slot)` — see room-doc-manager.
 */
export function acquireSlot(): number {
  if (_freeCount > 0) return _free[--_freeCount];
  const slot = _next++;
  if (slot >= _cap) {
    const cap = _cap * 2;
    const free = new Int32Array(cap);
    free.set(_free);
    _free = free;
    const boxes = new Float64Array(cap * 4);
    boxes.set(_bboxes);
    _bboxes = boxes;
    for (let i = _cap; i < cap; i++) _handles.push(null);
    _cap = cap;
  }
  return slot;
}

/** Return a slot to the pool. Nulls the reverse map; bbox lane left stale (see header). */
export function releaseSlot(slot: number): void {
  _handles[slot] = null;
  _free[_freeCount++] = slot;
}

/** Seed reverse map + bbox column for a fresh handle. Called by RoomDocManager
 *  immediately after every `createHandle`. */
export function registerHandle(h: ObjectHandle): void {
  _handles[h.slot] = h;
  const b = h.bbox;
  const o = h.slot * 4;
  _bboxes[o] = b[0];
  _bboxes[o + 1] = b[1];
  _bboxes[o + 2] = b[2];
  _bboxes[o + 3] = b[3];
}

/** Mirror a live handle's new bbox into the column. Called ONLY by
 *  `ObjectSpatialIndex.updateHandleBBox`, right after `applyHandleBBox`. */
export function writeSlotBBox(slot: number, b: Readonly<BBoxTuple>): void {
  const o = slot * 4;
  _bboxes[o] = b[0];
  _bboxes[o + 1] = b[1];
  _bboxes[o + 2] = b[2];
  _bboxes[o + 3] = b[3];
}

/** Live ref — fetch per frame/loop; refetch after any acquire. `null` = freed slot. */
export function getHandlesBySlot(): readonly (ObjectHandle | null)[] {
  return _handles;
}

/** Live ref — same fetch-per-frame/loop contract. Stride 4 at `slot * 4`. */
export function getBBoxColumn(): Float64Array {
  return _bboxes;
}

/** Slots [0, slotHighWater()) have existed; live ⊆ that range. */
export function slotHighWater(): number {
  return _next;
}

export function slotCapacity(): number {
  return _cap;
}

/** Room teardown + hydrate top — realloc everything at INITIAL_CAP. */
export function resetSlotTable(): void {
  _cap = INITIAL_CAP;
  _next = 0;
  _free = new Int32Array(INITIAL_CAP);
  _freeCount = 0;
  _handles = new Array(INITIAL_CAP).fill(null);
  _bboxes = new Float64Array(INITIAL_CAP * 4);
}
