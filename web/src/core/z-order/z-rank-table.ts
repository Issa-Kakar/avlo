import type { ZKey } from '@avlo/shared';
import { getHandlesBySlot, slotCapacity, slotHighWater } from '../slots/slot-table';
import type { ObjectHandle } from '../types/objects';

/**
 * Stable-index lookup of `handle.z` lex-rank for hot-path u32 sort keys.
 *
 * SoA layout over the app-wide slot space (`core/slots/slot-table.ts` owns the
 * allocator — this table is a consumer): `_ranks[handle.slot]` = position in
 * the (z, id)-sorted live set; `_slotsByRank[rank]` = the inverse permutation,
 * valid `[0, liveCount)` after `ensureRanksValid()`. Both are live refs —
 * reread per sort site, rebuild may replace the arrays.
 *
 * Dirty flag elides redundant rebuilds: `noteAdd` / `noteRemove` /
 * `noteZChanged` set `_dirty`; `ensureRanksValid()` early-returns when clean
 * AND `_ranks` covers the slot high-water mark. The capacity half of that
 * gate is structural safety, not a live code path: today every acquire site
 * calls `noteAdd` in the same block (fresh slots always arrive dirty), but a
 * future acquire path that forgot would otherwise hand out-of-bounds slots to
 * the rank readers. One extra load+compare per clean frame.
 *
 * `maxZ()`/`minZ()` self-heal: deleting or moving the extreme flags it
 * invalid (`noteRemove`/`noteZChanged`), and the getters trigger the rebuild
 * themselves — callers never observe a stale bound. `noteAdd` never sets the
 * invalid flags, so the hot create path stays O(1).
 */
export class ZRankTable {
  private _ranks: Uint32Array = new Uint32Array(64);
  private _slotsByRank: Uint32Array = new Uint32Array(64);
  private _sortedHandles: ObjectHandle[] = [];
  private _dirty = true;
  private _maxZ: ZKey | null = null;
  private _minZ: ZKey | null = null;
  private _maxZInvalid = true;
  private _minZInvalid = true;

  /** Inform table of a newly-inserted z. Updates running max/min cheaply. */
  noteAdd(z: ZKey): void {
    this._dirty = true;
    if (this._maxZ === null || z > this._maxZ) this._maxZ = z;
    if (this._minZ === null || z < this._minZ) this._minZ = z;
  }

  /** Inform table of a deleted handle's z — flags extreme invalidation. */
  noteRemove(z: ZKey): void {
    this._dirty = true;
    if (z === this._maxZ) this._maxZInvalid = true;
    if (z === this._minZ) this._minZInvalid = true;
  }

  /** Inform table of an edited z. Updates running max/min cheaply. */
  noteZChanged(oldZ: ZKey, newZ: ZKey): void {
    this._dirty = true;
    if (this._maxZ === null || newZ > this._maxZ) this._maxZ = newZ;
    if (this._minZ === null || newZ < this._minZ) this._minZ = newZ;
    if (oldZ === this._maxZ && newZ !== this._maxZ) this._maxZInvalid = true;
    if (oldZ === this._minZ && newZ !== this._minZ) this._minZInvalid = true;
  }

  /** Idempotent per-frame rebuild trigger. Sort sites call before reading ranks. */
  ensureRanksValid(): void {
    if (!this._dirty && this._ranks.length >= slotHighWater()) return;
    this._rebuild();
  }

  private _rebuild(): void {
    if (this._ranks.length < slotCapacity()) {
      // No copy: the writeback below rewrites every live entry; dead cells are
      // garbage by contract (rank readers only index live slots post-ensure).
      this._ranks = new Uint32Array(slotCapacity());
      this._slotsByRank = new Uint32Array(slotCapacity());
    }

    const bySlot = getHandlesBySlot();
    const hw = slotHighWater();
    const sorted = this._sortedHandles;
    sorted.length = 0;
    for (let s = 0; s < hw; s++) {
      const h = bySlot[s];
      if (h !== null) sorted.push(h);
    }
    // Secondary id-asc tie-break: jittered FI makes z collisions astronomically rare but not impossible.
    // Hot-path consumers compare packed rank keys; tie-break lives in rebuild only.
    sorted.sort((a, b) => (a.z < b.z ? -1 : a.z > b.z ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

    const ranks = this._ranks;
    const slotsByRank = this._slotsByRank;
    const n = sorted.length;
    for (let i = 0; i < n; i++) {
      const slot = sorted[i].slot;
      ranks[slot] = i;
      slotsByRank[i] = slot;
    }

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
    if (this._maxZInvalid) this.ensureRanksValid();
    return this._maxZ;
  }
  minZ(): ZKey | null {
    if (this._minZInvalid) this.ensureRanksValid();
    return this._minZ;
  }
  /** Live reference — reread per sort call; rebuild may replace the array. */
  getRanks(): Uint32Array {
    return this._ranks;
  }
  /** Inverse permutation rank → slot. Valid `[0, liveCount)` after `ensureRanksValid()`. Live ref. */
  getSlotsByRank(): Uint32Array {
    return this._slotsByRank;
  }

  /** Tear-down: reset all internal state. Owned by RoomDocManager.destroy(). */
  clear(): void {
    this._ranks = new Uint32Array(64);
    this._slotsByRank = new Uint32Array(64);
    this._sortedHandles.length = 0;
    this._maxZ = null;
    this._minZ = null;
    this._maxZInvalid = true;
    this._minZInvalid = true;
    this._dirty = true;
  }
}
