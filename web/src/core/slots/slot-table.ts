import type { BBoxTuple } from '../types/geometry';
import { KIND_CODE, type ObjectHandle } from '../types/objects';

/**
 * Slot table — the app-wide dense-id fabric. Every live object owns one u32
 * `slot` (< 2^30) for its `objectsById` lifetime; parallel columns keyed by
 * that slot give every subsystem O(1) SoA access without string maps:
 *
 *   `_handles`  slot → ObjectHandle reverse map (the inverse of `handle.slot`)
 *   `_bboxes`   interleaved minX,minY,maxX,maxY at `slot * 4` — the global
 *               bbox column (veil worker payloads; renderer clip tests;
 *               tight-framed hit fns; the spatial tree's hydrate bulk load —
 *               FlatRTree's item-indexed `load()` layout coincides with this
 *               column exactly while slots are dense, i.e. post-hydrate)
 *   `_kinds`    numeric kind code (KIND_CODE / K_*) at `slot` — int dispatch
 *               for the renderer's draw switch + transform kernels
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
 * - `writeSlotBBox`: RoomDocManager `upsertHandle` only — the middle leg of
 *   the sole post-creation bbox writer path (tuple via `copyBbox`, column
 *   here, tree via `spatialTree.update`), so all three always move together.
 * - `writeSlotKind`: RoomDocManager's kind-keychange branch only (in-place
 *   cross-kind conversion) — moves together with the `handle.kind` mirror.
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
 * INDEXING RULE: column offsets are `slot * 4`, never `slot << 2`. ToInt32
 * wrapping under shift turns a slot ≥ 2^30 into a SMALL VALID index
 * (`2**30 << 2 === 0` — slot 0's lanes) — silent cross-slot corruption; the
 * multiply stays exact, so a broken slot degrades to an out-of-bounds miss
 * (inert no-op). Negative slots miss silently under BOTH forms — the rule
 * buys nothing there. Perf-identical: TurboFan strength-reduces the multiply.
 *
 * LEAF MODULE — type-only imports + the KIND_CODE const (a frozen record from
 * `core/types/objects`, itself a leaf already upstream via the ObjectHandle
 * type import — no cycle). Fellow leaves (lock-table) and hot consumers
 * (renderer, pickers) import module getters directly; getters return live
 * refs under the fetch-per-frame/loop contract (`getLockOwners` idiom:
 * refetch after any acquire — growth replaces the arrays).
 */

const INITIAL_CAP = 256;

let _cap = INITIAL_CAP;
/** High-water mark: slots [0, _next) have been handed out at least once. */
let _next = 0;
let _free = new Int32Array(INITIAL_CAP);
let _freeCount = 0;
// PACKED_ELEMENTS by construction: V8's Array#fill fast path makes a FULL-range
// fill over `new Array(n)` packed (verified via %DebugPrint); growth appends
// sequentially and all stores are in-bounds non-hole values. Don't "simplify"
// to a bare `new Array(n)` without the fill — that one stays HOLEY forever.
let _handles: (ObjectHandle | null)[] = new Array(INITIAL_CAP).fill(null);
let _bboxes = new Float64Array(INITIAL_CAP * 4);
let _kinds = new Uint8Array(INITIAL_CAP);

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
    const kinds = new Uint8Array(cap);
    kinds.set(_kinds);
    _kinds = kinds;
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
  _kinds[h.slot] = KIND_CODE[h.kind];
  const b = h.bbox;
  const o = h.slot * 4;
  _bboxes[o] = b[0];
  _bboxes[o + 1] = b[1];
  _bboxes[o + 2] = b[2];
  _bboxes[o + 3] = b[3];
}

/** Mirror a live handle's new bbox into the column. Called ONLY by
 *  RoomDocManager `upsertHandle`, right after its `copyBbox` tuple write. */
export function writeSlotBBox(slot: number, b: Readonly<BBoxTuple>): void {
  const o = slot * 4;
  _bboxes[o] = b[0];
  _bboxes[o + 1] = b[1];
  _bboxes[o + 2] = b[2];
  _bboxes[o + 3] = b[3];
}

/** Mirror a live handle's new kind code into the column. Called ONLY by
 *  RoomDocManager's kind-keychange branch (in-place cross-kind conversion),
 *  together with the `handle.kind` mirror write. */
export function writeSlotKind(slot: number, code: number): void {
  _kinds[slot] = code;
}

/** Live ref — fetch per frame/loop; refetch after any acquire. `null` = freed slot. */
export function getHandlesBySlot(): readonly (ObjectHandle | null)[] {
  return _handles;
}

/** Live ref — same fetch-per-frame/loop contract. Kind code (K_*) at `slot`. */
export function getKindCodes(): Uint8Array {
  return _kinds;
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
  _kinds = new Uint8Array(INITIAL_CAP);
}
