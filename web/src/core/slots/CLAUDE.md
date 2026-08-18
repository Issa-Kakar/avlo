# Slots — App-Wide Dense-Id Fabric

Every live object owns one u32 `handle.slot` (< 2^30) for its `objectsById`
lifetime. This module is the allocator plus the two global slot-keyed columns;
every other slot-keyed structure (ZRankTable ranks, lock-table owner/locked
columns) is a consumer that sizes off `slotHighWater()` / `slotCapacity()`.

## Files

- `slot-table.ts` — module-level state, LEAF (type-only imports + the frozen
  `KIND_CODE` const from `core/types/objects`; lock-table pattern). Allocator
  (`acquireSlot`/`releaseSlot` — LIFO free list sized in lockstep with
  capacity, so release never grows), slot→handle reverse map
  (`getHandlesBySlot`), interleaved global bbox column (`getBBoxColumn`,
  minX,minY,maxX,maxY at `slot * 4`), numeric kind column (`getKindCodes`,
  `K_*` code at `slot` — the renderer's int draw dispatch + transform-kernel
  meta), `registerHandle` (seed all three), `writeSlotBBox` (column update),
  `writeSlotKind` (RDM kind-keychange branch only, paired with the
  `handle.kind` mirror), `resetSlotTable` (hydrate top + RDM destroy).
- `slot-table.selftest.ts` — standalone esbuild+node runner (command in its
  header). Allocator/column oracle checks + ZRankTable churn-vs-brute-sort +
  `sortU32Range` vs `Array.sort`.

## Writer discipline

- `acquireSlot`/`releaseSlot`/`registerHandle`: **RoomDocManager only**
  (upsertHandle first-insert, observer Phase A delete, hydrate passes). Every
  `acquireSlot()` is paired with `lockSlotAcquired(slot)` at the call site —
  explicit rather than folded in, because lock-table imports this module
  (`fillRemoteLockedBoxes` reads the column) and the fold would create a
  runtime cycle.
- `writeSlotBBox`: **RoomDocManager `upsertHandle` only** — the middle leg of
  the tripartite bbox write (`copyBbox` tuple → `writeSlotBBox` column →
  `spatialTree.update` tree); the three always move together, only there.
- Phase A delete order: `spatialTree.remove(slot)` → `lockSlotReleased` →
  `zOrder.noteRemove` → `transformEvictSlot` → `releaseSlot` LAST — a slot is
  freed only after every slot-keyed consumer has finalized (Phase B of the
  same fire can recycle it, and a late tree remove would delete the recycled
  entry; a late gesture-map read would route the recycled object into a dead
  gesture entry).

## Contracts

- **Live-slots-only indexing.** Release nulls the reverse-map entry (a
  retained ref would root a deleted Y.Map) but leaves the bbox lane STALE.
  Consumers must only index live slots — the one async reader (lock-veil
  microtask) is covered because Phase A prunes peer records before the free.
- **Fetch-per-frame/loop refs.** `getHandlesBySlot`/`getBBoxColumn` return
  live refs; growth (doubling, in `acquireSlot`) replaces the arrays — refetch
  after any acquire (`getLockOwners` idiom).
- **`slot * 4` indexing, never `slot << 2`** — ToInt32 wrapping under shift
  turns a slot ≥ 2^30 into a small VALID index (`2**30 << 2 === 0`), silently
  corrupting another slot's lanes; the multiply stays exact and degrades to an
  inert out-of-bounds miss. (Negatives miss under both forms.)
- The acquire→register null window is synchronous inside one observer fire /
  hydrate pass — unobservable.

## Consumers today

ZRankTable (rebuild walks the reverse map; rank arrays sized to capacity),
lock-table (`fillRemoteLockedBoxes` copies veil boxes straight from the
column), the spatial tree (`spatialTree` is keyed by slot; RDM's hydrate bulk
load feeds `load(count, ids, boxes)` the column directly — its ITEM-indexed
layout coincides with the slot-indexed column while slots are dense, i.e.
post-hydrate; the WS repack uses `rebuild()`), renderer + pickers (query
results are slots; handles recovered via the reverse map, clip/hit envelopes
read off the column, draw dispatch off the kind column, sorted rank keys via
`slotsByRank`), the transform engine (`_slotGesture` sparse map + freeze
lanes sized/read off the columns; `transformEvictSlot` is its Phase A hook),
and `invalidateWorldSlot` (RenderLoop reads the dirty rect off the column).
