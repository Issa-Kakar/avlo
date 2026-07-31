# Locks — Ephemeral Grabs + the Durable `locked` Property

Two lock concepts share this module's SoA table:

**Ephemeral grabs.** While a user transforms (full inject set = selection ∪ attached
connectors), types in a text/code/shape-label/note editor, or sweeps the eraser (locked on
first hit), peers cannot select, edit, or erase those objects — rendered greyed-out on their
screens. Advisory + ephemeral: never in the Y.Doc, never in awareness (whole-state churn); a
dedicated binary message (`MSG_LOCK = 76`) on the Yjs WebSocket with the room DO as
authoritative arbiter.

**Durable `locked` object property.** `locked: 1` on the object's Y.Map (unlock deletes the
key; toggled by the context-menu LockButton → `toggleSelectedLocked`, tracked + undoable both
directions, stopCapturing-isolated as its own undo step). Locked objects are inert — invisible
to marquee + eraser (`queryHandleIds`) and the text/code create-tool pick (`pickTopmostOfKind`),
no transforms, no editor entry, no mutating keyboard shortcuts, dropped by the AI executor,
stripped on paste/duplicate — but STILL click-pickable (`pickTopmostPaint` passes `lf: null`):
a stationary click solo-selects (SelectTool `end()` locked branch; drag diverts to marquee) and
the context menu collapses to the active LockButton, whose second press unlocks. No veil, no
render change beyond hidden handles/dots/flow buttons (`selectionLocked` in selection-store).
Mirrored into `_locked: Uint8Array` (0/1, slot-keyed) by the room observer ONLY: `locked`
keychange branch + `upsertHandle` first-insert seed + hydrate seed; cleared in
`lockSlotReleased`/`resetLockTable`, grown in `ensureLockCapacity`. Same one-compare guard
idiom (`lf[slot] === 1`); separate column because a peer grab and a durable lock can coexist.
Connector stickiness is untouched — reroute is observer-driven and lock-agnostic; new
connectors may still snap/attach to locked shapes (attach never mutates the target).

## File Map

| File | Responsibility |
|---|---|
| `lock-table.ts` | The SoA table + entire client API. `lockOwner: Uint32Array` keyed by `handle.slot` (`0`=unlocked · `1`=mine · `≥2`=server peer key), `lockedPos: Int32Array` (slot → index in its owner's dense list, -1 free) + per-peer dense `slots` list (swap-remove, presence-renderer idiom; slots-only — the slot fabric's reverse map killed the parallel `ids` copy), `_locked: Uint8Array` (durable-lock mirror — `getLockedFlags`/`isLockedObject`/`isLockedId`/`setLockedFlag`), `fillRemoteLockedBoxes(out)` (veil payload — copies every remote-locked bbox straight from the global slot column, `core/slots/slot-table.ts`). Local sources (`LOCK_SRC_TRANSFORM/TEXT_EDITOR/CODE_EDITOR/ERASER`), reaction hooks, dim-layer bridge, slot lifecycle. |
| `lock-protocol.ts` | Wire plumbing: `provider.messageHandlers[MSG_LOCK]` registration, receive buffering until 'sync', full-replace egress (immediate on release, 50ms coalesce on growth, presence backpressure), 15s lease resend, `attachLocks`/`detachLocks`. |
| `packages/shared/src/lock-protocol.ts` | Cross-runtime wire format + caps + codecs (`decodeLockSetBody` is THE server-side network-boundary validator). |
| `workers/sync/src/room.ts` | DO authority: per-conn `lockKey` (attachment-persisted), `#lockOwner`/`#locks` in-memory tables, first-wins `#applyLockSet`, editor-only broadcast/snapshot, release on close/eviction/permission-demote, lazy 45s lease sweep (no alarms — hibernation empties the tables; leases rebuild). |
| `renderer/lock-veil/` | The grey-filter veil — a dedicated worker-owned canvas layer (`transferControlToOffscreen`) between base and overlay. `lock-veil.ts` (main): lazy session-scoped worker + canvas, microtask-coalesced `fillRemoteLockedBoxes` copy out of the global slot bbox column (no id interning, no room-runtime import) → one transferred Float64Array, camera posts gated on `hasRemoteLocks()`. `lock-veil-worker.ts`: draws one translucent grey rect per bbox (single-path fill — overlaps don't double-darken), viewport cull, 0×0 backing store while idle. No overlay coupling, no main-thread veil painting. |

## The guard (hot path)

Every guard is one load + one unsigned compare, branch-predictable (column is ~all zeros):

```ts
const lo = getLockOwners();      // live ref — refetch per frame/query/loop, never cache across a grow
if (lo[handle.slot] > 1) continue;   // blocked ⇔ remote-locked
```

Guard sites: `object-query.ts` `collectHits`/`queryHandleIds` (pickers — `pickTopmostBindable`
passes `null`: snap-attach never mutates the target), `transform.ts` freeze loops + `commit()` +
endpoint drag, `connector-topology.ts` attached-discovery + `commitTopology`, `EraserTool`
accumulate + `commitErase`, editor entries + PHASE-3 mount fences, `connector-router.ts`
`detachConnectorFromShape`/`renormalizeAttachedAnchors`.

The durable column rides the same sites (`lf[slot] === 1` beside each `lo[slot] > 1`, or
`isLockedObject`/`isLockedId` beside `isRemoteLocked`/`isRemoteLockedId`) with three deltas:
`pickTopmostPaint` does NOT filter it (click-select stays live), `connector-topology.ts`
attached-discovery does NOT check it (a locked attached connector must keep rerouting —
reroute is cache-only; commit writes only free sides), and two keyboard chokepoints replace
scattered guards (`keyboard-manager.ts`: hoisted `locked` in `handleModifierShortcut`, one
early-return in `handleBareKey`) plus a `selectAll` filter.

## Invariants

- **Untouchable + prune ⇒ zero-guard call sites (EPHEMERAL locks only).** Outside an active
  transform gesture, `selectedIds` never contains a remote-locked id: pickers filter locked
  ids out of click/marquee, and the `onRemoteLocksApplied` subscriber in `selection-store.ts`
  prunes locks that land on an existing selection (deferred to gesture end while transforming —
  keyboard Guard 7 + hidden context menu block selection mutations mid-gesture). Consequently
  `selection-actions.ts`, `z-actions.ts`, `convert-kind.ts`, clipboard cut, and keyboard
  delete need NO per-callsite guards — do not add defensive re-checks there.
  A DURABLY-locked id, by contrast, IS deliberately selectable (solo click / kept multi after
  lock-all — all-or-nothing via `reconcileLockedSelection`, partial remote locks pruned,
  `_persistLockPending` defers mid-gesture). The compensating guards are `selectionLocked`
  gating: the collapsed lock-only menu + the two keyboard chokepoints — the per-callsite
  zero-guard rule for `selection-actions`/`z-actions`/`convert-kind` still stands (unreachable
  while `selectionLocked`).
- **Conflict policy: optimistic local + server first-wins + commit-time heal.** Local locks
  are claimed synchronously at gesture begin (`lockOwner[slot] = 1`) and announced; the DO
  grants by arrival order. A loser gets no denial message — the winner's earlier broadcast
  overwrites the loser's optimistic `1` with the peer key, and every commit path skips
  entries with `owner > 1`. Only three mid-gesture reactions: editor force-close, selection
  prune, eraser-accum purge.
- **Ids on the wire, slots in the table.** Frames carry stable ULIDs, interned fresh per
  frame via `objectsById`; unknown/deleted → entry dropped (Yjs is authority — a lock on a
  deleted object is a no-op). Slots recycle LIFO without zeroing, so `lockSlotReleased` must
  run in observer Phase A (before Phase B can reacquire) and release's `=== 1` check must
  never be "simplified" away — it protects a peer key that won arbitration mid-gesture.
- **PeerLocks liveness invariant: `rec.slots ⊆ live slots with owner ≥ 2`.** Phase A's
  `lockSlotReleased → removeFromPeer` prunes synchronously BEFORE the slot is freed, so the
  veil microtask never sees a freed slot. Load-bearing since the `ids` copy died: the old
  per-id `byId.get` miss degraded gracefully (skip); a stale slot in `fillRemoteLockedBoxes`
  would silently paint a recycled slot's bbox.
- **Ordering.** After first sync, per-connection TCP ordering guarantees a peer's creation
  update precedes its lock on that object. The connect snapshot always lands BEFORE the
  client's `synced` flips — `lock-protocol.ts` buffers per-peer until 'sync' (full-replace ⇒
  last-wins coalescing is correct).
- **Rendering never touches the base canvas OR the overlay.** The veil is its own
  worker-rendered canvas layer; lock transitions call `markLockVeilDirty()` (→ the injected
  `notifyLockVeil`, microtask-coalesced). The one hot-path hook: `upsertHandle` pokes the
  veil when a locked object's geometry changes (one compare).
- **Viewers are excluded end-to-end.** The DO ignores their LOCK frames and skips them in
  broadcast/snapshot; permission flips release (editor→viewer) or snapshot (viewer→editor).

## Accepted edges (documented, not bugs)

- Undo/redo vs locks: `RoomDocManagerImpl.undo/redo` gate on the TOP stack item's touched-id
  meta (stamped per StackItem by the observer snapshot → 'stack-item-added'/'stack-item-updated';
  ids captured pre-Phase-C so derived reroutes don't pollute) — silent no-op while any touched
  id is EPHEMERALLY remote-locked, self-resolving at the peer's gesture end. Durable locks
  deliberately do NOT gate history (undo writes through them, Figma semantics — keeps every
  stack item reachable and lock/unlock cleanly undoable). Residual: yjs's `popStackItem` loops
  past zero-change items to the next one unvetted (needs a peer-delete/overwrite race AND a
  lock below) — degrades to baseline CRDT merge, the pre-gate behavior.
- Editor force-close runs `commitAndClose`, whose empty-label cleanup may touch the
  just-locked object — the force-close IS the sanctioned heal.
- Reconnect while the old socket lingers: re-announce is denied until the old conn's close
  releases (≤ lease window); commit guards cover it.
- Race-loss window (~RTT): loser's preview renders undimmed until gesture end; commit skips
  the lost entries.
- A crashed holder's grey lingers on fully-idle clients until the next room event triggers
  the lazy sweep, or CF closes the dead socket → `onClose`.
- DO hibernation empties the lock tables; each holder's ≤15s lease rebuilds them (first-wins
  can be momentarily wrong in that window — commit guards heal).

## Future

A per-grab `lockKind: Uint8Array` (ephemeral) could still ride alongside — grow in
`ensureLockCapacity`, clear in the same release paths, exactly as `_locked` now does.
