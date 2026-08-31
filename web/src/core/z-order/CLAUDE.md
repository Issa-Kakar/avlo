# Z-Order

Fractional z-key generation lives in `@avlo/shared/z-order` (cross-runtime).
This folder is client-side only: the rank table for fast sort + the bring/send
actions.

## Files

- `z-rank-table.ts` — `ZRankTable`: SoA `Uint32Array` ranks over the app-wide
  slot space (`core/slots/slot-table.ts` owns the allocator — this table is a
  consumer, not the owner) + `_slotsByRank`, the rank→slot inverse permutation
  written back on every rebuild. Owned by `RoomDocManager`; accessed via
  `getZOrder()` (room-runtime).
- `z-actions.ts` — `bringSelectedToFront`, `sendSelectedToBack`,
  `bringSelectedForward`, `sendSelectedBackward`. Wired into keyboard-manager.
  Cold keyboard paths: they sort `ObjectHandle[]` with a module-local `rankAsc`
  comparator over the last-fetched ranks column (`_ranks = zOrder.getRanks()`
  per action) — hot paths (renderer, pickers) use packed u32 keys +
  `sortU32Range` instead and never see a comparator.

## API essentials

- `ensureRanksValid()` — ZERO-ARG, idempotent. Early-returns when
  `!dirty && ranks.length >= slotHighWater()`; otherwise rebuilds by walking
  the slot table's reverse map (skip nulls), sorting by (z, id-tiebreak), and
  writing both `_ranks[slot] = rank` and `_slotsByRank[rank] = slot`. The
  capacity half of the gate is structural safety against a future acquire path
  that forgets `noteAdd` — today acquire + `noteAdd` are same-block.
- `getRanks()` / `getSlotsByRank()` — live refs, reread per sort site (rebuild
  may realloc without copying — dead cells are garbage by contract, rank
  readers only index live slots post-ensure). `slotsByRank` is valid
  `[0, liveCount)` after ensure.
- `noteAdd(z)` / `noteRemove(z)` / `noteZChanged(old, new)` — O(1) dirty +
  running max/min upkeep. `noteRemove`/`noteZChanged` flag the extreme invalid
  when they touch it; `noteAdd` never does (hot create path stays O(1)).
- `maxZ()` / `minZ()` — SELF-HEALING: first line triggers `ensureRanksValid()`
  when the running extreme was invalidated, so callers (z-key generators) never
  observe a stale bound, even immediately after deleting/moving the extreme.

## Invariants

- `handle.slot` immutable post-creation; allocation/release live in
  `core/slots/slot-table.ts` (RDM calls `acquireSlot`/`releaseSlot`; this
  table only reads the reverse map + high-water).
- `handle.z` mutated only by the observer (room-doc-manager z-key-edit branch),
  which calls `noteZChanged` in the same breath.
- No comparators, no closure rebinding: hot sort sites
  (`renderer/layers/objects.ts`, `core/spatial/object-query.ts`) pack ranks
  into u32 keys and sort with `utils/sort-u32`; only the cold z-actions keep a
  3-line module-local comparator.
- `ensureRanksValid()` called at every sort site before reading
  ranks/slotsByRank; clean-frame cost is one boolean + one compare.
- Hydrate no longer bulk-loads the table — RDM calls `noteAdd` per object and
  the first frame's ensure performs the initial sort (same total work).

Verified by `core/slots/slot-table.selftest.ts` (randomized churn vs a brute
(z, id)-sort oracle, inverse-permutation exactness, extreme self-heal).
