# Architecture Redesign — Ground Up

Reasoning and direction for decoupling the system. Not a task list — each section captures the _why_ and the target patterns. Implementation requires fresh sessions with focused scope.

**Core philosophy:** Module-level singletons for read access, room-scoped lifecycle for write/ownership, direct access over indirection. Y.Doc IS the shared mutable state container — don't wrap it in another stateful container.

---

## Completed: Flat Y.Doc (Phase 3)

`ydoc.getMap('root').get('objects')` → `ydoc.getMap('objects')`. Top-level, always exists, no seeding.

Eliminated: `initializeYjsStructures()`, meta guard in `mutate()`, 5-second WS grace delay, `getRoot()`/`getMeta()`/`getObjects()` private methods, deferred observer attachment. `mutate()` is now 3 lines. See `docs/REFACTOR_CHANGELOG.md` Phase 3 for details.

---

## Direction: Module Decomposition

### The problem

The Snapshot bundles five things so it can travel through one subscription:

```typescript
interface Snapshot {
  docVersion: number;           // Only used by... nothing meaningful
  objectsById: Map<...>;       // Used by tools, renderer, hit testing
  spatialIndex: ObjectSpatialIndex;  // Used by tools, renderer, viewport queries
  dirtyPatch?: DirtyPatch;     // Used only by CanvasRuntime
  createdAt: number;           // Unused
}
```

Every consumer does `getCurrentSnapshot().spatialIndex?.query(bounds)` — three levels of indirection plus a null guard. Tools access `getCurrentSnapshot().objectsById.get(id)` dozens of times per gesture. The Snapshot is an unnecessary allocation that creates coupling between unrelated consumers.

### Spatial index as module-level singleton

The spatial index is app infrastructure, not room-owned state. There's one room at a time, one index.

```
// lib/spatial-index.ts (move from packages/shared — workers don't use it)
const index = new ObjectSpatialIndex();
export function getSpatialIndex(): ObjectSpatialIndex { return index; }
```

Always exists. Between rooms, it's empty — queries return `[]`. That's the correct answer. No null checks anywhere. Room observer calls `bulkLoad()` on connect, `clear()` on disconnect.

Tools go from `getCurrentSnapshot().spatialIndex?.query(bounds)` to `getSpatialIndex().query(bounds)`.

### objectsById as module-level singleton

Same pattern:

```
// lib/objects-registry.ts
const objectsById = new Map<string, ObjectHandle>();
export function getObject(id: string): ObjectHandle | undefined { return objectsById.get(id); }
export function getObjectsById(): ReadonlyMap<string, ObjectHandle> { return objectsById; }
```

Tools go from `getCurrentSnapshot().objectsById.get(id)` to `getObject(id)`.

### Kill the Snapshot -> dirty bus

With objectsById and spatialIndex as singletons, the Snapshot collapses to a notification channel:

```
type DirtyListener = (patch: { rects: WorldBounds[] }) => void;
export function subscribeDirty(cb: DirtyListener): () => void;
export function emitDirty(patch): void;
```

CanvasRuntime subscribes to dirty patches. The observer emits them. No Snapshot object, no version counter, no `getCurrentSnapshot()` calls.

### Evictions at the source

Cache eviction is a side effect of object deletion. Handle it in the observer, not in a downstream consumer reading evictIds from a patch:

```
// In observer, on deletion:
objectCache.evict(id);
objectsById.delete(id);
spatialIndex.remove(id);
dirtyRects.push(bboxToBounds(handle.bbox));
```

DirtyPatch shrinks to just `{ rects: WorldBounds[] }`. No `evictIds` field.

### Move types out of shared

`packages/shared` should contain only what's genuinely shared between client and worker:

**Keep in shared:** geometry types, object kind types, Y.Map accessors, bbox computation, url-utils, image-validation

**Move to client:** ObjectSpatialIndex, ObjectHandle, IndexEntry, connector lookup — anything that builds derived state for the canvas rendering pipeline. Workers don't do spatial queries or hold ObjectHandles.

---

## Direction: Room Connection

### Composition root, not god class

RoomDocManager conflates things with different lifetimes and different consumers. IDB provider is fire-and-forget (nothing references it after setup). UndoManager is user-session scoped. Spatial index is a consumer of the doc, not a peer of it.

The better pattern is a setup function that returns a lean handle:

```
connectRoom(roomId) -> RoomHandle {
  objects,     // for mutations (the Y.Map)
  undo,        // for Cmd+Z
  mutate(fn),  // convenience: ydoc.transact(fn, userId)
  close(),     // tears down everything
}
```

What's NOT on the handle: `doc`, `idb`, `ws`, `spatialIndex`, `objectsById`. IDB/WS are fire-and-forget inside the closure. Spatial index and objectsById are module-level singletons — tools import them directly. The return surface is tiny.

All fields non-null from construction. No `if (this.websocketProvider)`, no `if (this.indexeddbProvider)`, no `if (this.spatialIndex)`. The handle is either alive or closed. Binary state.

### No two-step init

`connectRoom()` wires everything and returns. No `open()` to call later. The function returns, the system is running. IDB syncs async, WS connects async, but the wiring is synchronous. The observer fires when data arrives, whenever that is.

### IDB + WS timing: idempotent rebuild

IDB is fast (~30-50ms). Worth waiting for so the first render has local data. WS sync brings the authoritative state and should trigger a rebuild for optimal RBush tree structure.

```
let indexBuilt = false;

function rebuildIndex() {
  hydrateAll(objects);  // walk Y.Map -> objectsById + spatialIndex.bulkLoad()
  indexBuilt = true;
  emitDirty({ rects: [FULL_WORLD] });
}

// Observer: incremental after first build
objects.observeDeep((events) => {
  if (!indexBuilt) return;
  applyIncrementalChanges(events);
});

// IDB -> first bulk load
Promise.race([idb.whenSynced, timeout(2_000)]).then(() => rebuildIndex());

// WS synced -> rebuild with complete state
ws.on('synced', () => rebuildIndex());
```

Scenarios:

- **Returning user:** IDB loads fast -> first render with local data. WS syncs small delta -> observer handles incrementally. `synced` fires -> rebuild for clean tree.
- **First-time user:** IDB loads instantly (empty) -> empty canvas. WS syncs full state -> observer processes incrementally until `synced` fires -> rebuild with everything, optimal tree.
- **Reconnect after disconnect:** Index already built. WS re-syncs delta -> observer handles incrementally. `synced` fires -> rebuild catches missed changes.

`rebuildIndex()` is idempotent and cheap (<10ms for typical rooms). Calling it twice is fine. The "wasted" IDB-only build costs ~10ms and gives the user something to see while WS catches up.

### WS 'synced' behavior

`synced` fires once per successful sync handshake (sync step 2 completes — server sends diff based on client's state vector). On reconnect (network drop, DO hibernation wakeup), the provider re-syncs and fires `synced` again. Each re-sync is a chance to reconcile — the rebuild catches any delta from the disconnect period.

PartyServer DOs hibernate when idle (no connections). Wakeup triggers a normal sync handshake. No missed changes during hibernation — the DO was idle.

---

## Direction: Presence Redesign

Two data paths, completely separated. The module decomposition above is prerequisite infrastructure.

### Four concerns, different characteristics

| Concern  | Frequency                       | Consumer                     | Allocation budget      |
| -------- | ------------------------------- | ---------------------------- | ---------------------- |
| Send     | ~20hz while moving, 0 when idle | Network (awareness protocol) | N/A                    |
| Receive  | ~20hz per peer                  | Mutable state                | Zero — mutate in place |
| Render   | 60fps during animation          | Canvas overlay               | Zero — reuse objects   |
| React UI | On join/leave only              | Components                   | New array ref (rare)   |

### Principle: Two data paths, completely separated

React needs a stable peer list that only changes on join/leave/name/color. It must NOT re-render when cursors move.

The renderer needs mutable cursor positions it reads imperatively every frame. Zero allocation.

These cannot be the same data structure. The current `PresenceView` conflates them — every cursor update creates a new Map, which triggers React subscriptions. `UserAvatarCluster` re-renders on every cursor move because `useMemo([presence.users])` always triggers (Map identity changes).

### Ownership

**`presence.ts` — module-level, no class:**

- Throttled local cursor sending (20hz, 50ms, leading+trailing)
- `peerCursors: Map<clientId, {x, y}>` — mutated in place, read by renderer
- `peerInfo: Map<clientId, {userId, name, color}>` — stable refs, read by Zustand selector
- Zustand store with `peerList` for React (same pattern as selection-store)
- Awareness 'change' wiring + disconnect cleanup
- Receives the YProvider via `init(provider)` — provider owns awareness internally
- Does NOT own: interpolation state (renderer's job), connection state (YAGNI)

**`presence-cursors.ts` — renderer layer:**

- Display positions: `Map<clientId, Float64Array(2)>` — interpolation state
- Cursor bitmap cache: `Map<key, OffscreenCanvas>` — pre-rendered arrow+label
- `drawCursors(ctx, dt): boolean` — returns true if still animating (self-sustaining invalidation)

**Room connection (`connectRoom`):**

- Does NOT own awareness (YProvider creates it, presence.ts wires it)
- Does NOT own presence state or sending
- Does NOT own presence rendering

### Sending: 20hz throttle + 0.5 quantization

Custom 15-line throttle (leading+trailing, no dependency). Pre-dedup: if quantized position matches last pending position, skip. No RAF — timeout-based throttle gives precise control over network rate independent of display rate.

### Receiving: mutable maps + fine-grained React notification

```
function handleChange({ added, updated, removed }) {
  // HOT PATH: cursor positions mutated in place (zero allocation)
  // WARM PATH: peer info checked for actual changes before replacing
  // COLD PATH: usePresenceStore.setState({ peerList }) only on structural changes
  // Always: invalidateOverlay()
}
```

`usePresenceStore.setState()` only fires on join/leave/name/color. Cursor-only updates: zero React re-renders.

### Rendering: exponential smoothing + bitmap cache

Each frame, exponential lerp toward target position (tau=25ms, ~99% convergence in 100ms):

```
alpha = 1 - exp(-dt / 25)
display += (target - display) * alpha
```

Pre-rendered cursor bitmaps (arrow + name label on OffscreenCanvas). One `ctx.drawImage()` per visible cursor per frame. No path commands, no measureText, no state saves.

Self-sustaining animation: `drawCursors()` returns boolean -> overlay self-invalidates while cursors are moving. When all converge, rendering stops. Next awareness update -> `invalidateOverlay()` -> cycle restarts.

No external RAF loop. No animation deadline. No `presenceAnimDeadlineMs`. The render loop's own invalidation mechanism IS the animation driver.

### Connection state

Nobody needs it reactively right now. No UI shows "connected." Add `connected: boolean` to the presence store when needed. One line. Don't build it until needed.

---

## Direction: Infrastructure

### Pre-constructed render loops

RenderLoop and OverlayRenderLoop are app infrastructure, not room-scoped. Pre-construct as module-level singletons, start/stop when Canvas mounts:

```
// renderer/render-loop.ts
const renderLoop = new RenderLoop();
export { renderLoop };

// CanvasRuntime.start() -> renderLoop.start(baseCtx)
// CanvasRuntime.stop()  -> renderLoop.stop()
```

The render loop doesn't hold room state — it reads from spatial index, objectsById, camera store each frame. When the room changes, the data changes, the loop picks it up. No reconstruction, no null checks.

### Code splitting

Vite splits at `import()` boundaries. Three concrete wins:

**Editor overlays (biggest win):** CodeMirror and Tiptap are ~200KB+ combined. Lazy-load on first double-click:

```
// CodeTool.ts
const { createCodeEditor } = await import('./code-editor-setup');
```

Vite creates a separate chunk. First use loads it, subsequent uses are cached.

**Route splitting (TanStack Router native):** Landing page, auth page, room page — each gets its own chunk via `lazy` route definitions. Canvas code doesn't load until room navigation.

**Tool splitting:** Not worth it. Entire tool system is ~40KB. Async overhead outweighs savings.

### TanStack Router

Room lifecycle maps to route lifecycle. Room connection is not a DOM concern:

```
Route('/room/$roomId', {
  beforeLoad: ({ params }) => {
    const handle = connectRoom(params.roomId);
    setActiveRoom(handle);
    return { handle };
  },
  onLeave: () => {
    getActiveRoom()?.close();
    setActiveRoom(null);
  },
  component: RoomPage,
});
```

Canvas still uses `useLayoutEffect` for DOM refs (canvas elements, editorHost). Clean separation: **route owns data lifecycle, component owns DOM lifecycle.**

If you want the first paint to have IDB data, `beforeLoad` can be async — await the IDB promise race. TanStack Router shows a pending state while it runs. By the time Canvas mounts, local data is loaded.

---

## Design Principles

### Three lifetimes

```
APP LIFETIME (module-level singletons, exist forever):
  camera-store, device-ui-store, selection-store, tool-registry, object-cache
  spatial-index         <- always exists, sometimes empty
  objects-registry      <- always exists, sometimes empty
  render-loop           <- pre-constructed, start/stop
  overlay-loop          <- pre-constructed, start/stop
  dirty bus             <- pub/sub for invalidation

ROOM LIFETIME (created per connectRoom, destroyed on close):
  Y.Doc, IDB provider, WS provider, UndoManager
  Objects observer (writes to spatial index + objects registry + emits dirty)
  Presence system (module-level init/destroy per room)

REQUEST LIFETIME (ephemeral):
  DirtyPatch (per observer batch, consumed immediately)
  Tool gesture state (begin -> move -> end)
```

### Direct access over indirection

| Before                                                                | After                                                |
| --------------------------------------------------------------------- | ---------------------------------------------------- |
| `getCurrentSnapshot().spatialIndex?.query(bounds)`                    | `getSpatialIndex().query(bounds)`                    |
| `getCurrentSnapshot().objectsById.get(id)`                            | `getObject(id)`                                      |
| `roomDoc.mutate((ydoc) => { ydoc.getMap('root').get('objects')... })` | `roomDoc.mutate(() => { roomDoc.objects.set(...) })` |
| `subscribe(snap => { snap.dirtyPatch?.rects... })`                    | `subscribeDirty(patch => { patch.rects... })`        |

### No null fields, no deferred init

Everything needed by the room is created in `connectRoom()`. No "if provider exists" guards. No "if spatial index is initialized" checks. Singletons always exist (empty between rooms). Handle fields are all non-null.

### Side effects at the source

Cache eviction, layout cache invalidation, connector lookup updates — these happen in the observer when the change is detected, not downstream in a consumer reading a patch.

### Module-level singletons for shared read access

Anything read by multiple subsystems (tools, renderer, hit testing) lives at module scope with a getter. Room lifecycle populates/clears it. No threading state through subscriptions or snapshots.

---

## Ownership: Who Owns What

### `presence.ts` — module-level, no class

```
Owns:
  - Throttled local cursor sending
  - peerCursors: mutable Map<clientId, {x, y}> (mutated in place)
  - peerInfo: mutable Map<clientId, {userId, name, color}> (stable object refs)
  - Zustand store with peerList for React (selector pattern, same as selection-store)
  - Awareness 'change' wiring + disconnect cleanup

Receives:
  - The YProvider via init(provider) — provider owns the awareness instance
  - Access provider.awareness for read/write, provider.ws if ever needed for backpressure
```

Why module-level, not a class:

- One room per tab. No multi-instance need.
- Matches camera-store, room-runtime, tool-registry pattern.
- Simpler than constructing/destroying class instances.

## Receiving: Mutable Maps, Fine-Grained React Notification

### Listen on 'change' events

The provider sends on 'change'. We receive on 'change'. Both filter clock-only renewals. The check interval is disabled on both client and server, so 'change' and 'update' fire at the same times anyway. 'change' is semantically correct.

### Two separate data structures

```typescript
// ---- HOT PATH: cursor positions, mutated in place, read by renderer ----
// The {x,y} objects are created once per peer and REUSED. Never recreated.
const peerCursors = new Map<number, { x: number; y: number }>();

// ---- WARM PATH: peer identity, stable refs, read by React via Zustand ----
const peerInfo = new Map<number, { userId: string; name: string; color: string }>();
```

### Zustand store for React (same pattern as selection-store)

```typescript
import { create } from 'zustand';

interface PeerEntry {
  clientId: number;
  userId: string;
  name: string;
  color: string;
}

export const usePresenceStore = create<{ peerList: PeerEntry[] }>(() => ({
  peerList: [],
}));
```

Components use selectors — same pattern as `useSelectionStore`:

```typescript
// UserAvatarCluster — only re-renders when peer list changes
const peers = usePresenceStore((s) => s.peerList);

// Could select just count if that's all you need
const peerCount = usePresenceStore((s) => s.peerList.length);
```

`peerList` array reference only changes on join/leave/name/color. Cursor moves: zero React re-renders. Zero. No `useSyncExternalStore`, no manual subscription plumbing. Just Zustand with selectors, consistent with every other store.

## Open Questions

1. **Smoothing tau value:** 25ms is snappy. Tune by feel — 15ms for snappier, 40ms for smoother.

2. **Provider destruction cascade:** Verify `provider.destroy()` cleans up awareness + WS. If not, destroy explicitly.

3. **UndoManager scope:** With `ydoc.getMap('objects')` (done) and eventual presence extraction, verify Tiptap's ySyncPluginKey origin still works.

4. **Cursor bitmap shape:** The exact arrow + label design needs work. Bitmap approach makes iteration easy.

5. **RBush rebuild frequency:** `synced` fires on each reconnect. Verify rebuild cost stays <10ms for large rooms (1000+ objects). If not, gate on delta size.

6. **TanStack Router prefetch:** Does prefetching a room route trigger `beforeLoad`? If so, does that prematurely connect to a room? May need to defer connection to the component.

7. **Code splitting measurement:** Profile actual bundle sizes before splitting. CodeMirror+Tiptap are the obvious targets. Measure first, split second.
