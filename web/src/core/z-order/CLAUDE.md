# Z-Order

Fractional z-key generation lives in `@avlo/shared/z-order` (cross-runtime).
This folder is client-side only: the rank table for fast sort + the bring/send
actions.

## Files

- `z-rank-table.ts` — SoA `Uint32Array` ranks + slot pool + rebound comparators.
  Owned by `RoomDocManager`; accessed via `getZOrder()` (room-runtime).
- `z-actions.ts` — `bringSelectedToFront`, `sendSelectedToBack`,
  `bringSelectedForward`, `sendSelectedBackward`. Wired into keyboard-manager.

## Invariants

- `handle.slot` immutable post-creation.
- `handle.z` mutated only by the observer (room-doc-manager z-key-edit branch).
- Hot-path comparators are closures over `_ranks`; rebind on grow.
- `ensureRanksValid` called at sort sites (`renderer/layers/objects.ts`,
  `core/spatial/object-query.ts:sortTopFirst`); idempotent per frame.
