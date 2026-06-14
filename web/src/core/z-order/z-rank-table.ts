import type { ZKey } from '@avlo/shared';
import type { ObjectHandle } from '@/core/types/objects';

/**
 * Stable-index lookup of `handle.z` lex-rank for hot-path int comparators.
 *
 * SoA layout: `_ranks[handle.slot]` = position in sort. Slots are pooled —
 * `acquireSlot()` returns either a recycled slot from `_freeSlots` or appends
 * a fresh one. `releaseSlot()` returns the slot to the pool on delete.
 *
 * Sort comparators capture the live `_ranks` reference. When `_ranks` grows
 * (doubled in `acquireSlot`), comparators are rebound via `_rebindComparators`
 * so the captures point at the new array.
 *
 * Dirty flag elides redundant rebuilds: every `acquireSlot` / `releaseSlot` /
 * `noteZChanged` sets `_dirty = true`; `ensureRanksValid` early-returns when
 * clean. Sort sites call `ensureRanksValid` before sorting — clean-frame
 * cost is one boolean check.
 */
export class ZRankTable {
  private _ranks: Uint32Array = new Uint32Array(64);
  private _handleCount = 0;
  private _freeSlots: Int32Array = new Int32Array(64);
  private _freeCount = 0;
  private _sortedHandles: ObjectHandle[] = [];
  private _dirty = true;
  private _maxZ: ZKey | null = null;
  private _minZ: ZKey | null = null;
  private _maxZInvalid = true;
  private _minZInvalid = true;
  private _handleAscCmp!: (a: ObjectHandle, b: ObjectHandle) => number;
  private _handleDescCmp!: (a: ObjectHandle, b: ObjectHandle) => number;

  constructor() {
    this._rebindComparators();
  }

  private _rebindComparators(): void {
    const ranks = this._ranks;
    this._handleAscCmp = (a, b) => ranks[a.slot] - ranks[b.slot];
    this._handleDescCmp = (a, b) => ranks[b.slot] - ranks[a.slot];
  }

  /** Return a stable slot for a new handle. Doubles `_ranks` if exhausted. */
  acquireSlot(): number {
    this._dirty = true;
    if (this._freeCount > 0) return this._freeSlots[--this._freeCount];
    const slot = this._handleCount++;
    if (slot >= this._ranks.length) {
      const next = new Uint32Array(this._ranks.length * 2);
      next.set(this._ranks);
      this._ranks = next;
      this._rebindComparators();
    }
    return slot;
  }

  /** Return a slot to the pool. Caller passes the deleted handle's z so we can flag bound invalidation. */
  releaseSlot(slot: number, z: ZKey): void {
    if (this._freeCount >= this._freeSlots.length) {
      const next = new Int32Array(this._freeSlots.length * 2);
      next.set(this._freeSlots);
      this._freeSlots = next;
    }
    this._freeSlots[this._freeCount++] = slot;
    this._dirty = true;
    if (z === this._maxZ) this._maxZInvalid = true;
    if (z === this._minZ) this._minZInvalid = true;
  }

  /** Inform table of a newly-inserted z. Updates running max/min cheaply. */
  noteAdd(z: ZKey): void {
    this._dirty = true;
    if (this._maxZ === null || z > this._maxZ) this._maxZ = z;
    if (this._minZ === null || z < this._minZ) this._minZ = z;
  }

  /** Inform table of an edited z. Updates running max/min cheaply. */
  noteZChanged(oldZ: ZKey, newZ: ZKey): void {
    this._dirty = true;
    if (this._maxZ === null || newZ > this._maxZ) this._maxZ = newZ;
    if (this._minZ === null || newZ < this._minZ) this._minZ = newZ;
    if (oldZ === this._maxZ && newZ !== this._maxZ) this._maxZInvalid = true;
    if (oldZ === this._minZ && newZ !== this._minZ) this._minZInvalid = true;
  }

  /** Bulk load during hydration. Single sort, single rank assignment. */
  load(handles: Iterable<ObjectHandle>): void {
    this._sortedHandles.length = 0;
    for (const h of handles) {
      h.slot = this.acquireSlot();
      this._sortedHandles.push(h);
    }
    this._dirty = true;
    this._maxZInvalid = true;
    this._minZInvalid = true;
    this._rebuild();
  }

  /** Idempotent per-frame rebuild trigger. Sort sites call before sorting. */
  ensureRanksValid(handles: Iterable<ObjectHandle>): void {
    if (!this._dirty) return;
    this._rebuild(handles);
  }

  private _rebuild(handles?: Iterable<ObjectHandle>): void {
    if (handles !== undefined) {
      this._sortedHandles.length = 0;
      for (const h of handles) this._sortedHandles.push(h);
    }
    // Secondary id-asc tie-break: jittered FI makes z collisions astronomically rare but not impossible.
    // Hot-path comparator stays branchless (ranks subtraction); tie-break lives in rebuild only.
    this._sortedHandles.sort((a, b) => (a.z < b.z ? -1 : a.z > b.z ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

    const ranks = this._ranks;
    const sorted = this._sortedHandles;
    const n = sorted.length;
    for (let i = 0; i < n; i++) ranks[sorted[i].slot] = i;

    if (this._maxZInvalid) {
      this._maxZ = n > 0 ? sorted[n - 1].z : null;
      this._maxZInvalid = false;
    }
    if (this._minZInvalid) {
      this._minZ = n > 0 ? sorted[0].z : null;
      this._minZInvalid = false;
    }
    this._dirty = false;
  }

  maxZ(): ZKey | null {
    return this._maxZ;
  }
  minZ(): ZKey | null {
    return this._minZ;
  }
  /** Live reference — reread per sort call; grows replace the array. */
  getRanks(): Uint32Array {
    return this._ranks;
  }
  get handleAscCmp() {
    return this._handleAscCmp;
  }
  get handleDescCmp() {
    return this._handleDescCmp;
  }

  /** Tear-down: reset all internal state. Owned by RoomDocManager.destroy(). */
  clear(): void {
    this._ranks = new Uint32Array(64);
    this._freeSlots = new Int32Array(64);
    this._handleCount = 0;
    this._freeCount = 0;
    this._sortedHandles.length = 0;
    this._maxZ = null;
    this._minZ = null;
    this._maxZInvalid = true;
    this._minZInvalid = true;
    this._dirty = true;
    this._rebindComparators();
  }
}
