# Architecture Redesign — Ground Up

Reasoning and direction for decoupling the system. Not a task list — each section captures the _why_ and the target state. Implementation planned per-session with focused scope.

**Core philosophy:** Module-level singletons for read access, room-scoped lifecycle for write/ownership, direct access over indirection. Y.Doc IS the shared mutable state container — don't wrap it in another stateful container.

---

## Completed

### Flat Y.Doc (Phase 3)

`ydoc.getMap('root').get('objects')` → `ydoc.getMap('objects')`. Top-level, always exists, no seeding.

Eliminated: `initializeYjsStructures()`, meta guard in `mutate()`, 5-second WS grace delay, `getRoot()`/`getMeta()`/`getObjects()` private methods, deferred observer attachment. `mutate()` is now 3 lines. See `docs/REFACTOR_CHANGELOG.md` Phase 3.

### Clean Up `packages/shared` (Phase 4)

Gutted from 19 files to 4. Types, accessors, spatial index, bbox utils all moved to client. Shared now only exports identifiers (`RoomId`, `UserId`, `StrokeId`, `TextId`) + 3 utility modules (`ulid`, `url-utils`, `image-validation`). ~47 client files rewritten with new import paths. See `docs/REFACTOR_CHANGELOG.md` Phase 4.

### TanStack Router Migration (Phase 5)

Replaced react-router-dom with TanStack Router. File-based routing with auto code splitting. Room connection moved from React component tree to route `beforeLoad`. Registry/provider/ref-counting pattern eliminated — `connectRoom()`/`disconnectRoom()` in `room-runtime.ts` is the entire room lifecycle API.

Deleted: `App.tsx`, `room-doc-registry.ts`, `room-doc-registry-context.tsx`, `use-room-doc.ts`, `use-snapshot.ts`. See `docs/REFACTOR_CHANGELOG.md` Phase 5.

---

## Direction: Module Decomposition

### The problem

The Snapshot bundles multiple concerns so they can travel through one subscription:

```typescript
// Current — types/snapshot.ts
interface Snapshot {
  docVersion: number;
  objectsById: ReadonlyMap<string, ObjectHandle>;
  spatialIndex: ObjectSpatialIndex | null;
  dirtyPatch?: DirtyPatch | null; // { rects: WorldBounds[], evictIds: string[] }
  createdAt: number;
}
```

Every consumer does `getCurrentSnapshot().spatialIndex?.query(bounds)` — three levels of indirection plus a null guard. Tools access `getCurrentSnapshot().objectsById.get(id)` dozens of times per gesture. The Snapshot is an unnecessary indirection layer that couples unrelated consumers.

Only one consumer actually needs the full Snapshot object: CanvasRuntime (for dirty rect invalidation). Tools, renderers, and hit testing only need `objectsById` and `spatialIndex` — they don't care about versions or dirty patches.

### Spatial index and objectsById — direct access, always non-null

Currently `spatialIndex` is created lazily (first `publishSnapshotNow()` call) and exposed only via Snapshot. `objectsById` is a private Map exposed the same way. Both should be non-null from construction and directly accessible — the question is whether they live as module-level singletons or as RoomDocManager fields exported via getters from `room-runtime.ts`.

Module-level singleton pattern:

```
const index = new ObjectSpatialIndex();
export function getSpatialIndex(): ObjectSpatialIndex { return index; }
```

Room-owned but directly exported pattern:

```
// RoomDocManager creates in constructor, room-runtime re-exports
export function getSpatialIndex() { return getActiveRoomDoc().spatialIndex; }
```

The RBush tree is technically room-scoped state (it's rebuilt from room data, cleared on disconnect). Whether the instance itself is room-owned or app-lifetime with room-driven clear/rebuild is an open decision. Either way, the access pattern for consumers is the same: `getSpatialIndex().query(bounds)` — no null checks, no snapshot indirection.

Same applies to `objectsById`. Either pattern eliminates the current `getCurrentSnapshot().objectsById.get(id)` indirection.

### Snapshot simplification

Only one consumer needs the full Snapshot subscription: CanvasRuntime (for dirty rect invalidation). The Snapshot can simplify to a dirty notification channel:

```
type DirtyListener = (patch: { rects: WorldBounds[] }) => void;
```

No `evictIds` in the patch — cache eviction happens at the source (see below). `objectsById` and `spatialIndex` accessed directly, not bundled into the snapshot. `docVersion` and `createdAt` are unused.

### Cache eviction at the source

Cache eviction is a side effect of object deletion/modification. Handle it in the RoomDocManager observer when the change is detected, not downstream in CanvasRuntime reading `evictIds` from a dirty patch:

```
// In RoomDocManager observer, on deletion:
objectCache.evict(id);
textLayoutCache.remove(id);
codeSystem.remove(id);
invalidateBookmarkLayout(id);
objectsById.delete(id);
spatialIndex.remove(id);
dirtyRects.push(bboxToBounds(handle.bbox));
```

Currently CanvasRuntime does this in its snapshot subscription (line ~143 of CanvasRuntime.ts). Moving it to the source eliminates the `evictIds` field from DirtyPatch entirely.

---

## Direction: RoomDocManager Simplification

### Keep the class, reduce encapsulation

RoomDocManager stays as a class — it genuinely owns the Y.Doc, providers, and observer lifecycle. But it currently over-encapsulates: `objectsById` and `spatialIndex` are private fields exposed only through Snapshot subscriptions. They should be directly accessible (whether room-owned or module-level) and non-null from construction.

### Current gate system (4 gates)

```typescript
// Current — room-doc-manager.ts
private gates = {
  idbReady: false,        // IndexedDB provider synced
  wsConnected: false,     // WebSocket connected
  wsSynced: false,        // WebSocket synced (unused beyond setting it)
  firstSnapshot: false,   // First snapshot published (unused beyond setting it)
};
```

`wsSynced` and `firstSnapshot` are set but never read as guards. `idbReady` gates the objects observer + UndoManager attachment. `wsConnected` gates awareness sending.

Target: reduce to the gates that are actually load-bearing. The awareness system (being extracted) will own its own connection-aware sending logic, so `wsConnected` may leave with it.

### What stays in RoomDocManager

- Y.Doc, IDB provider, WS provider ownership and lifecycle
- Objects deep observer (two-epoch: rebuild + incremental)
- UndoManager
- `mutate()` convenience wrapper
- `objects` field (the Y.Map)

### What gets extracted or exported

- `objectsById` → directly accessible, non-null from construction (ownership TBD — room-owned field or module singleton)
- `spatialIndex` → directly accessible, non-null from construction (ownership TBD — same question)
- Awareness/presence system → separate module (see below)
- Cache eviction → called directly from observer, not piped through dirty patch
- Connector lookup → stays (it's observer-driven), but reverse map could become module-level

---

## Direction: Presence Redesign

### Current state

All awareness logic lives inside RoomDocManager (~300 lines): sending, receiving, interpolation, presence view building, animation timing. This conflates room document concerns with presence rendering concerns.

Current awareness sending: timer-based scheduling at 15Hz with backpressure, sends full state every tick even if only cursor moved. Current interpolation: linear lerp with `PeerSmoothing` structs inside RoomDocManager. Current cursor rendering: immediate-mode path commands + `measureText` each frame (~95 lines in `presence-cursors.ts`).

### Extract to separate module

Awareness becomes its own module (`lib/presence.ts` or similar), not part of RoomDocManager. It receives the Y.Awareness instance from the room connection and manages its own lifecycle.

### Event-driven sending

Current approach schedules sends on a timer (15Hz base, 8Hz degraded). New approach: mark dirty on cursor change, send via throttle (leading+trailing). No regular interval — if nothing changed, nothing sends. Awareness already broadcasts full state diffs, so we don't need to re-send unchanged fields like user profile info on every tick.

### Flatter awareness type

Current `Awareness` interface sends `userId`, `name`, `color`, `cursor`, `seq` on every state update. Profile fields (`name`, `color`) rarely change — they only need to be sent once (on connect) and when actually modified. The wire format should separate identity from cursor position.

### Listen to 'change' events

Switch from the current 'update' event to 'change' events on awareness. Both fire at the same times in our setup (check interval disabled on client and server), but 'change' is semantically correct — it filters clock-only renewals.

### Two data paths (unchanged from original)

React needs a stable peer list that changes on join/leave/name/color. The renderer needs mutable cursor positions read imperatively every frame.

### Animation controller pattern for cursor interpolation

Cursor interpolation becomes an `AnimationJob` registered with the existing `AnimationController` singleton. The animation controller already has the infrastructure: `frame(ctx, now, dt)` returns boolean for self-sustaining invalidation, push-based via `setInvalidator()`.

This means interpolation state lives in the renderer layer (the animation job), not in RoomDocManager. The presence module writes target positions to mutable maps; the animation job reads them and smooths toward targets each frame.

### Exponential smoothing (not linear lerp)

Replace the current linear lerp window (`INTERP_WINDOW_MS = 66ms`, start/end times, `displayStart`/`last` positions) with exponential smoothing:

```
alpha = 1 - exp(-dt / tau)
display += (target - display) * alpha
```

Tau needs careful tuning. The overlay loop runs on native RAF (~16.6ms at 60fps, ~8.3ms at 120fps, variable under load). Exponential smoothing is frame-rate independent by design (`dt` absorbs timing), but the visual feel changes with frame rate — fast frames mean smaller alpha per step, more visible smoothing. Tau ~25ms is a starting point; actual value needs tuning on real hardware at real frame rates. If a peer jumps (gap in sequence), the exponential will converge quickly enough that explicit snap logic may be unnecessary.

### Bitmap cursor cache

Pre-render cursor arrow + name label onto `OffscreenCanvas`, keyed by `(name, color)`. One `ctx.drawImage()` per visible cursor per frame instead of path commands + `measureText` + `roundRect`. Cache invalidates on name/color change (rare). This replaces the current `drawCursorPointer()` + `drawNameLabel()` in `presence-cursors.ts`.

### Zustand store for peer list

React components (`UserAvatarCluster`) subscribe to a Zustand store for the peer list. Store only updates on join/leave/name/color — cursor-only updates produce zero React re-renders. Potentially partialized with the device-ui store as a non-persisted partition to avoid proliferating stores (currently 3 stores + user-profile-manager singleton).

---

## Direction: Store Consolidation & Room-Scoped State

### Camera store: per-room persistence

Scale and pan should persist per roomId, keyed in localStorage. When navigating to a room, restore the last viewport. localStorage reads are synchronous — no async needed, no loader, fits naturally into `connectRoom()` or a camera-store side effect.

### Selection store: clear on room changes

Currently nothing clears selection state when switching rooms. The `key={roomId}` remount handles React component state, but the Zustand selection store is global and survives remounts. `connectRoom()` or `disconnectRoom()` should clear selection (selectedIds, transform, marquee, topology, editing IDs).

### UserId migration to Zustand

`userProfileManager` is a hand-rolled singleton with localStorage persistence and pub/sub. localStorage is synchronous, so this can become a Zustand store (or a partition of an existing store) with `persist` middleware. Simplifies the access pattern — components and imperative code both use `useProfileStore.getState()`.

### Potential store partitioning

Four separate state containers (camera, selection, device-ui, profile) may be reducible. Non-persisted ephemeral state (selection, presence peer list, cursor override) could share a store. Persisted per-device state (tool settings, text defaults, profile) could share another. Per-room persisted state (camera viewport) is its own concern. Explore whether partializing stores with Zustand `persist` middleware's `partialize` option is cleaner than 4+ independent stores.

---

## Direction: Infrastructure

### Pre-constructed render loops

RenderLoop and OverlayRenderLoop are currently constructed fresh in every `CanvasRuntime.start()` and destroyed in `stop()`. They should be module-level singletons with `start()`/`stop()` lifecycle:

```
// renderer/render-loop.ts
const renderLoop = new RenderLoop();
export { renderLoop };

// CanvasRuntime.start() → renderLoop.start()
// CanvasRuntime.stop()  → renderLoop.stop()
```

The render loop doesn't hold room state — it reads from spatial index, objectsById, camera store each frame. When the room changes, the data changes, the loop picks it up. No reconstruction, no null checks. The AnimationController is already a module-level singleton — render loops should match.

---

## Design Principles

### Three lifetimes

```
APP LIFETIME (module-level singletons, exist forever):
  camera-store, device-ui-store, selection-store, tool-registry, object-cache
  render-loop           ← pre-constructed, start/stop
  overlay-loop          ← pre-constructed, start/stop
  animation-controller  ← already singleton
  dirty bus             ← pub/sub for invalidation

ROOM LIFETIME (created per connectRoom, destroyed on close):
  Y.Doc, IDB provider, WS provider, UndoManager
  objectsById, spatialIndex  ← non-null, directly accessible (ownership TBD)
  Objects observer (populates objectsById + spatialIndex, evicts caches)
  Presence system (init/destroy per room, owns awareness wiring)

REQUEST LIFETIME (ephemeral):
  Dirty rects (per observer batch, consumed immediately by CanvasRuntime)
  Tool gesture state (begin → move → end)
  Animation job frames (cursor interpolation, eraser trail)
```

### Direct access over indirection

| Before                                               | After                                             |
| ---------------------------------------------------- | ------------------------------------------------- |
| `getCurrentSnapshot().spatialIndex?.query(bounds)`   | `getSpatialIndex().query(bounds)` (no null check) |
| `getCurrentSnapshot().objectsById.get(id)`           | `getObject(id)` (direct, no snapshot)             |
| `roomDoc.mutate(() => { roomDoc.objects.set(...) })` | unchanged (still clean)                           |
| `subscribe(snap => { snap.dirtyPatch?.rects... })`   | `subscribeDirty(patch => { patch.rects... })`     |

### No null fields, no deferred init

Singletons always exist (empty between rooms). Handle fields are all non-null from construction. No `if (this.websocketProvider)`, no `if (this.spatialIndex)`. Binary state: alive or closed.

### Side effects at the source

Cache eviction, layout cache invalidation, connector lookup updates — these happen in the observer when the change is detected, not downstream in a consumer reading a patch.

---

## Current State Reference

Snapshot of the codebase as of Phase 5 completion, for future session context.

### RoomDocManager (`lib/room-doc-manager.ts`, ~1365 lines)

- **Gates:** 4 gates (`idbReady`, `wsConnected`, `wsSynced`, `firstSnapshot`). Only `idbReady` and `wsConnected` are load-bearing.
- **Awareness:** ~300 lines of sending, receiving, interpolation, presence view building. Timer-based 15Hz send. Linear lerp interpolation with `PeerSmoothing` structs. Backpressure detection on WS buffer.
- **Snapshot:** Published synchronously on every Y.Doc `updateV2` event. Contains live references to `objectsById` Map and `spatialIndex` (both private fields). `DirtyPatch` carries `rects: WorldBounds[]` and `evictIds: string[]`.
- **Cache eviction:** `evictIds` piped through DirtyPatch to CanvasRuntime, which calls `objectCache.evictMany()`. Text/code/bookmark caches evicted in observer directly.
- **Observer:** Two-epoch (rebuild via `hydrateObjectsFromY` + incremental via `applyObjectChanges`). `needsSpatialRebuild` flag. Connector lookup updated in observer.

### Render Loops

- **RenderLoop** and **OverlayRenderLoop**: constructed fresh each `CanvasRuntime.start()`, destroyed on `stop()`. No constructor params.
- **AnimationController**: already a module-level singleton (`getAnimationController()`). Lazy-initialized. Only job registered: `EraserTrailAnimation`.
- **Overlay frame order:** full clear → world-space tool preview → screen-space cursors → animation jobs.

### Presence Cursors (`renderer/layers/presence-cursors.ts`, ~95 lines)

- Immediate-mode: `drawCursorPointer()` draws arrow via path commands, `drawNameLabel()` draws rounded rect + `measureText` + `fillText`.
- Reads `getCurrentPresence()` imperatively, converts world→canvas per cursor.
- Exported functions for future animation job reuse.

### Stores

| Store                | Persisted              | Room-scoped | Clears on room change    |
| -------------------- | ---------------------- | ----------- | ------------------------ |
| camera-store         | No                     | No          | No                       |
| selection-store      | No                     | No          | No (only on tool switch) |
| device-ui-store      | Yes (localStorage, v4) | No          | No                       |
| user-profile-manager | Yes (localStorage, v1) | No          | N/A (global identity)    |

### Awareness Wire Format

```typescript
// Sent via yAwareness.setLocalState() on every tick:
{ userId, name, color, cursor?: { x, y }, seq }
```

All fields re-sent every time. `seq` is monotonically incrementing. Mobile skips cursor. Quantized to 0.5 world units.

---

## Open Questions

1. **Smoothing tau value:** 25ms is snappy. Tune by feel — 15ms for snappier, 40ms for smoother.

2. **Store partitioning:** Is partialized device-ui + presence store cleaner than separate stores? Need to weigh persistence middleware complexity vs cognitive overhead of 4+ stores.

3. **Camera persistence granularity:** localStorage per roomId could accumulate stale entries. LRU eviction? Max entries? Or just let it grow (room count is practically bounded).

4. **Selection clear timing:** Should selection clear in `connectRoom()` (before component mounts) or in `disconnectRoom()` (during cleanup)? Former is safer — guarantees clean state for the new room.

5. **Awareness identity separation:** How to avoid re-sending `name`/`color` every tick while staying compatible with Yjs awareness protocol (which broadcasts full state). May need to split into awareness state (cursor+seq) vs a one-time identity handshake, or accept the bandwidth and just reduce send frequency.

6. **Provider destruction cascade:** Verify `provider.destroy()` cleans up awareness + WS. If not, destroy explicitly.

7. **objectsById/spatialIndex ownership:** Room-owned fields (created in constructor, exported via room-runtime getters) vs module-level singletons (always exist, populated/cleared by room). Both give the same consumer API. Room-owned is more truthful (they ARE room data). Module-level avoids the "no active room" throw path. Decision impacts whether room-runtime re-exports them or a separate module holds them.

8. **Cursor bitmap invalidation:** OffscreenCanvas keyed by `(name, color)` — should the cache be bounded? Peers come and go. Weak references or explicit cleanup on peer departure.
