# Object Lifecycle — Y.Doc → handle → caches → dirty rect

**Read this before touching:** `runtime/room-doc-manager.ts`, `core/geometry/bbox.ts`,
`core/types/objects.ts`, anything that mutates `objectsById` / the spatial index / `z`,
or any code that runs inside the deep observer. Also read it before adding an `ObjectKind`.

**Companion doc:** `docs/rendering-and-caches.md` — what the caches this pipeline populates
actually hold, and how pixels come out the other end. Subsystem internals (text layout, code
tokenization, connector routing, spatial queries, image decode) live in their own
`CLAUDE.md`s and are **not** repeated here; this doc owns the seam between them.

Primary sources: `runtime/room-doc-manager.ts` (the whole pipeline), `runtime/room-runtime.ts`
(module-level access), `core/types/objects.ts` (`ObjectHandle`), `core/geometry/bbox.ts`
(per-kind bbox dispatch), `core/spatial/object-spatial-index.ts`, `core/z-order/z-rank-table.ts`.

---

## 1. The model

One object = **one `Y.Map` inside the top-level `objects` map**, plus exactly one
**`ObjectHandle`** mirroring it on the client. The Y.Map is the only source of truth that
syncs; everything else — handle, bbox, spatial index, z-rank, layout caches, Path2D — is
locally derived state rebuilt from it.

```
objects: Y.Map<Y.Map<unknown>>        ← CRDT truth, syncs over WS, persists to IDB
   │
   └─ observeDeep ──► RoomDocManager  ← the ONLY writer of everything below
         ├─ objectsById: Map<string, ObjectHandle>
         ├─ spatialIndex: ObjectSpatialIndex (rbush; the handle IS the item)
         ├─ zOrder: ZRankTable        (SoA Uint32 ranks, handle.slot indexes it)
         ├─ connectorRouter           (routed polylines + shape→connector reverse map)
         └─ subsystem caches          (text / code / bookmark / image / geometry)
```

Per-kind field schemas live in the root `CLAUDE.md` → *Y.Doc Structure*. This doc covers
what happens to those fields, not what they are.

### `ObjectHandle` — a live reference that IS the rbush item

```ts
interface ObjectHandle {
  id: string;
  kind: ObjectKind;          // mirror of y.get('kind')
  y: Y.Map<unknown>;         // LIVE reference — never a snapshot
  bbox: BBoxTuple;           // [minX,minY,maxX,maxY], computed locally, never in Y
  minX; minY; maxX; maxY;    // rbush envelope — mirrors bbox[0..3]
  z: ZKey;                   // mirror of y.get('z')
  slot: number;              // index into ZRankTable._ranks
}
```

`objectsById.get(id)` and a spatial query return **the same object**. There is no copy, no
sync step between the two access paths. rbush reads its envelope through the default
`toBBox(item) => item`, which is why the four mirror fields exist alongside `bbox`.

The wrapper object persists for the id's entire lifetime — the same `ObjectHandle` reference
survives every observer fire until deletion. Consumers that need a bbox **snapshot across
fires must clone at read time** (`[...handle.bbox]`); `transform.ts`, `connector-topology.ts`
and `image-manager.ts` all do.

### Mutation invariants — violate these and the spatial tree silently desyncs

| Field | Only legal writer | Notes |
|---|---|---|
| `bbox` + `minX/minY/maxX/maxY` | `applyHandleBBox(handle, src)`, **called only from `spatialIndex.updateHandleBBox`** | Written atomically as one unit. Never `handle.bbox[N] = …`, never `copyBbox(src, handle.bbox)`. |
| `kind` | the observer's `kind` keychange branch | In-place cross-kind conversion (`tools/selection/convert-kind.ts`). Evicts OLD-kind caches first. |
| `z` | the observer's `z` keychange branch | Paired with `zOrder.noteZChanged(oldZ, newZ)`. |
| `slot` | `zOrder.acquireSlot()` at handle creation | Never reassigned on a live handle. Returns to the free list on delete; a later object may reuse it. |
| `y` | never | Set once at `createHandle`. |

**Why the `applyHandleBBox` contract is absolute:** rbush's `remove(handle)` descends the
tree using the handle's *current* envelope to find the leaf. If you mutate the mirrors before
removing, `remove` walks to the wrong subtree, silently no-ops, and the stale entry leaks
forever — every subsequent viewport query returns a phantom. `updateHandleBBox` encapsulates
the only correct order: `remove(handle)` → `applyHandleBBox(handle, newBBox)` → `insert(handle)`.

**`ObjectSpatialIndex` has exactly one writer.** `grep 'spatialIndex\.(insert|remove|load|clear|updateHandleBBox)'`
should match only inside `runtime/room-doc-manager.ts`. Everyone else reads via
`getSpatialIndex()`. See `core/spatial/CLAUDE.md` for the query API.

### Three geometry classes

Not every kind stores its geometry the same way. This distinction drives the whole bbox
dispatch and is the #1 thing agents get wrong.

| Class | Kinds | Where geometry lives | How to read the frame |
|---|---|---|---|
| **Stored** | `shape`, `image` (`frame`), `stroke` (`points`) | The Y.Map | `getFrame(y)` / `getPoints(y)` |
| **Derived** | `text`, `note`, `code`, `bookmark` | A subsystem layout cache, keyed by id | `getTextFrame(id)` / `getCodeFrame(id)` / `getBookmarkFrame(id)` — `FrameTuple \| null` |
| **Routed** | `connector` | `ConnectorRouter`'s route cache; the Y.Map holds only endpoint refs (a point or a `StoredAnchor`) | `getConnectorRoute(id)` → `Point[] \| null` |

Derived kinds have **no `frame` key in Y at all** — width/fontSize/content imply it, and the
layout engine computes it. A derived frame is `null` only on a genuine cache miss (see §5).

Use `frameOf(handle)` (`core/geometry/frame-of.ts`) instead of hand-writing this switch — it
is a mapped dispatch over `BindableKind` and returns `null` for `stroke`/`connector`. Adding a
new bindable kind is one line there.

**Connectors also carry an optional rich-text label** stored on the connector Y.Map under the
shape-label keys (`content: Y.XmlFragment`, `fontSize`, `fontFamily`, `labelColor`). It
layouts through `textLayoutCache` keyed by the *connector* id and unions into the connector's
bbox — see `core/connectors/connector-label.ts`.

### `computeBBoxFor{,Into}` — the per-kind bbox dispatch

`core/geometry/bbox.ts` is the single entry point. `computeBBoxForInto(id, kind, yMap, out)`
writes into a caller-owned tuple (the observer passes a pooled scratch); `computeBBoxFor`
is the allocating cold-path wrapper used by hydration.

| kind | bbox source | padding | side effect | fallback when props are unreadable |
|---|---|---|---|---|
| `stroke` | min/max over `points` | `width * 0.5 + 1` | — | `< 1` point → `[0,0,0,0]` |
| `shape` | `frame` | `width * 0.5 + 1` | — | no frame → `[0,0,0,0]`, still padded |
| `image` | `frame` | none (bbox === frame) | `ensureImageMeta(id, y)` | no frame → `[0,0,0,0]` |
| `text` | `computeTextBBox(id, props)` | italic overhang horizontally, ±2 vertically | populates `textLayoutCache` + frame | props null → raw **unpadded** `getFrame` rect; **cache not populated** |
| `note` | `computeNoteBBox(id, props)` | directional shadow pads (scale-relative) | populates `textLayoutCache` + frame | props null → raw `origin` + `NOTE_WIDTH × scale` square; **cache not populated** |
| `code` | `computeCodeBBoxInto(id, y, out)` | none (frame === bbox) | populates `codeSystem` + frame | props null → `[ox, oy, ox+1, oy+1]`; **cache not populated** |
| `bookmark` | `computeBookmarkBBox(id, props)` | shadow ratios × width | populates `bookmarkCache` + frame | props null → `[0,0,0,0]`; **cache not populated** |
| `connector` | `getConnectorRoute(id)` min/max, then `unionConnectorLabelBBoxInto` | stroke half-width, or arrow-cap extent when either cap is `'arrow'` | reads the route the router built | `< 2` points → `[0,0,0,0]` |

**Stroke and shape width IS part of the bbox.** A width-only edit changes the bbox, which is
what drives geometry eviction. Do not "optimize" the padding away.

Three things about this dispatch that are easy to get wrong:

- **`computeBBoxForInto` has exactly one caller** — Phase B of the observer. **`computeBBoxFor`
  also has exactly one** — hydrate pass 1. If you need a bbox anywhere else, you almost
  certainly want `handle.bbox` or `frameOf(handle)` instead.
- **The `connector` arm is currently unreachable from the pipeline.** Phase B routes connectors
  to `router.computeBBox`, Phase C and hydrate pass 2 to `router.rerouteCanonical`. The arm is
  correct and kept for direct callers, but don't reason about connector bboxes from it.
- **The `props === null` fallbacks do not populate the cache.** They are the one structural way
  a live handle can exist with a permanently-null derived frame. Unreachable in practice (every
  kind is created in one atomic `transact` with a complete field set) — but it is why "handle
  exists ⇒ caches populated" is an ordering discipline, not a proof.

`bboxEquals` is an exact four-way `===`, no epsilon. Sub-pixel geometry churn therefore counts
as a bbox change and re-publishes rects; that is intentional (WYSIWYG beats a saved rect).

Two of these branches allocate internally: `computeTextBBox` / `computeNoteBBox` /
`computeBookmarkBBox` return a fresh tuple that `copyBbox` folds into `out`. Only `code` is a
true `*Into`. That is a known gap, not a design choice.

---

## 2. `RoomDocManager` — construction, hydration, teardown

Public fields are **non-null from construction**: `objects`, `objectsById`, `spatialIndex`,
`connectorRouter`, `zOrder`. Consumers type against the `IRoomDocManager` interface and reach
it through `runtime/room-runtime.ts` getters, never by holding the instance.

### Init — synchronous constructor, async continuation

The constructor is synchronous: `getUserId()` (**throws** if identity is unresolved, which
aborts construction so `connectRoom` never assigns `activeRoom`), `new Y.Doc({ guid: roomId })`,
`ydoc.getMap('objects')`, `ensureImageWorkers()` (synchronous; spins the image decode pool up in
parallel with IDB/WS, and throws if the page isn't cross-origin-isolated), then `void this.init()`.

`init()` runs strictly in order, re-checking `destroyed` after the await and before the WS:

1. **IndexedDB provider** — `new IndexeddbPersistence(ROOM_DOC_DB_PREFIX + roomId, ydoc)`,
   awaited against a **1 s timeout race**, with the rejection swallowed. A slow or failing IDB
   never blocks the room: hydrate then runs on a partial doc and the remainder arrives through
   the deep observer, which by then is attached.
2. **Hydrate** — `hydrateObjectsFromY()` (below).
3. **Attach the deep observer** — *after* hydrate. Hydrate does a bulk build with different
   rules (bulk rbush load, dense slot packing) and would fight a live observer.
4. **UndoManager** — `new Y.UndoManager([objects], { trackedOrigins: new Set([userId]), captureTimeout: 500 })`,
   then `bindUndoManagerToHistoryStore` wires its stack events into `history-store`.
5. **WebSocket provider** — see §6.

> **The `await` in step 1 is load-bearing, not just a courtesy.** Hydrate reaches back through
> module getters that resolve via `getActiveRoomDoc()` — the connector router's route context,
> and `hydrateImages()` calling `getHandle`. `room-runtime` only assigns `activeRoom` *after*
> the constructor returns, and `getActiveRoom()` throws when it is null. Making `init()`
> synchronous would break hydrate.

### Hydration — two passes, then bulk load

`hydrateObjectsFromY()` clears everything (`objectsById`, `spatialIndex`, `connectorRouter`,
`zOrder`, `clearAllObjectCaches()`) and rebuilds:

- **Pass 1 — everything except connectors.** For each object: `computeBBoxFor` (which
  populates that kind's subsystem cache as a side effect) → `createHandle(..., slot = -1)`.
  Connectors get only `registerConnector(id, yObj)` here (anchor ids + the reverse
  shape→connectors map) and are queued.
- **Pass 2 — connectors.** Now that every bindable frame exists, `rerouteCanonical(id, yObj, bbox)`
  routes each connector and mutates the bbox tuple in place. **Hydrate is the one exception
  to the no-placeholder-bbox rule:** if routing fails the bbox stays `[0,0,0,0]` and the next
  observer fire (e.g. the anchor shape arriving over WS) corrects it.
- `spatialIndex.load(handles)` — one bulk rbush pack, far better tree shape than N inserts.
- `zOrder.load(objectsById.values())` — assigns the `slot = -1` sentinels dense indices `[0..N-1]`.
- `hydrateImages()` then `invalidateWorldAll()`.

Objects with no `z` key throw. That is intentional: `z` is mandatory and a missing one means
a writer bypassed the creation pattern.

### Teardown — `destroy()`, strict order

IDB provider destroy → `detach()` presence (signals departure **while the WS is still open**)
→ WS `disconnect()` + `destroy()` → unbind history → destroy UndoManager → `unobserveDeep` →
`spatialIndex.clear()` → `connectorRouter.clear()` → `zOrder.clear()` → clear UI selection →
`resetRoomSession()` → `clearAllObjectCaches()` → `terminateCodeWorkers()` →
`objectsById.clear()` → `ydoc.destroy()`.

Three things about teardown:

- `dispose(value, fn)` **swallows every teardown throw** and nulls the field, so the chain
  always completes — and a broken step is invisible.
- `terminateCodeWorkers()` is deliberately *not* inside `clearAllObjectCaches()` — that also
  runs on hydrate, which must not kill the Lezer worker pool.
- **Image workers are not terminated.** They are session-scoped and `ensureImageWorkers()` is
  idempotent, so they survive room switches. (`clearImageManager()` runs from
  `CanvasRuntime.stop()`, a different lifecycle.)

---

## 3. The deep observer — the single CRDT-driven update path

`objects.observeDeep(cb)`. Yjs dispatches at **end of transaction**, so the callback is
**synchronous and main-thread**. By the time it returns:

- every handle exists and its bbox is current,
- every subsystem cache is consistent,
- every visible dirty rect has been published.

No awaits, no microtasks, no window in which Y state and renderable state disagree. **Do not
introduce an `await` into this path.**

The callback signature declares a transaction argument but **never binds it. There is zero
origin filtering** — local edits, remote WS edits, IDB replay and undo/redo all take the
identical path. Any "only for local edits" logic would need a signature change first.

> **Non-reentrancy is a discipline, not a structural guarantee — and it is what makes the
> module-level scratches below safe.** Phase A calls `selection.onObjectsDeleted`, which can
> reach `TextTool.commitAndClose()` / `CodeTool.commitAndClose()`, both of which contain
> `transact()` calls. What actually prevents corruption is Phase A's ordering:
> `objectsById.delete(id)` runs *before* the selection notification, so `getHandle()` inside
> `commitAndClose` returns `undefined` and every `transact` branch short-circuits (TextTool
> also carries its own `closing` re-entry guard). A genuinely re-entrant fire would `.clear()`
> the accumulators mid-`applyObjectChanges` and the outer phases would then iterate the inner
> fire's sets. **Anything you add to the selection bridge must not open a `transact()`.**

### Per-fire scratch (module-level, cleared at the top of each fire)

`_touchedIds`, `_deletedIds`, `_bboxChangedIds`, `_kindChangedIds` (all `Set<string>`) and
`_newBBoxScratch` (one `BBoxTuple`) — **instance fields, allocated once per manager**, not per
fire. `_newBBoxScratch` is cloned into `handle.bbox` by `createHandle` / `applyHandleBBox`; it
never leaks into `objectsById`.

Clear points differ: the observer clears `_touchedIds` / `_deletedIds` / `_kindChangedIds` at
the top of each fire; `applyObjectChanges` clears `_bboxChangedIds` at *its* top (so after an
early-return fire it still holds the previous fire's contents — harmless, but don't read it
from anywhere else).

There is a sixth per-fire value: `vp = getVisibleBoundsTuple()`, captured once and threaded
into every publish. **It is a module-level scratch owned by `camera-store`** — any nested call
to `getVisibleBoundsTuple()` during `applyObjectChanges` would overwrite the tuple `vp` aliases.

### Pass 1 — inline routing

Walks the raw `Y.YEvent[]` and routes each edit to its subsystem hook **before** the bulk
phase reads that subsystem. This ordering is load-bearing: `compute*BBox` then reads
already-fresh caches, and Phase C can drain reroutes in the same fire instead of needing a
second pass.

**Top-level `objects` map events:**

| change | action |
|---|---|
| `delete` | `deleted.add(id)`, `router.onObjectDeleted(id)` |
| add/update | `touched.add(id)`; if `kind === 'connector'` → `router.onConnectorAdded(id, yObj)` |

**Nested events** — `touched.add(id)` unconditionally, then, for a direct key change on the
object's own map (`path.length === 1`):

| key changed | action |
|---|---|
| `kind` | `removeObjectCaches(id, OLD kind)` → `handle.kind = kind` → `_kindChangedIds.add(id)` → `router.onBindableChanged(id)`; if the new kind is `shape`, eagerly re-tokenize + layout the label so `getInlineStyles` is warm for the menu |
| `start` / `end` / `connectorType` (connector) | `router.onConnectorEdited(id, yObj, startEnd)` — queues a reroute |
| `startCap` / `endCap` (connector) | `evictGeometry(id)` — caps bake into the cached Path2D |
| `content` removed (connector) | `textLayoutCache.evict(id)` — drops a stranded label entry so Phase B's bbox shrinks back to the polyline |
| `shapeType` (shape) | `evictGeometry(id)` **and** `router.onBindableChanged(id)` |
| `z` | `zOrder.noteZChanged(handle.z, newZ)` + `handle.z = newZ`. A z-only edit has no bbox impact, so Phase B would no-op — this branch is what keeps sort sites consistent |

**Nested `content` events** (`path[1] === 'content'`):
`code` + `Y.YTextEvent` → `codeSystem.handleContentChange(id, ev, lang)`; otherwise, if the
value is a `Y.XmlFragment` → `textLayoutCache.invalidateContent(id, content)` (covers text,
note, shape labels, connector labels).

If both `touched` and `deleted` end up empty the fire returns early.

### Pass 2 — `applyObjectChanges()`

Reads the viewport once (`getVisibleBoundsTuple()`, a scratch tuple) and passes it down;
every dirty-rect publish goes through `invalidateIfVisible(bbox, vp)`, which culls
off-screen rects before calling `invalidateWorldBBox`.

**Phase A · deletions.** Per id: `spatialIndex.remove(handle)` (identity removal — envelope
mirrors still describe the live entry) → `zOrder.releaseSlot(handle.slot, handle.z)` →
`removeObjectCaches(id, handle.kind)` → `invalidateIfVisible(handle.bbox, vp)` →
`objectsById.delete(id)`. Then, once, `selection.onObjectsDeleted(deleted)`.

**Phase B · touched.** Ids deleted in this same fire fall out on the `objects.get(id)` miss. A
missing `kind` is read as `'stroke'`. Then:
- **connector**: skip if `router.isQueuedForReroute(id)` (Phase C owns it). Otherwise this is
  a style-only edit — `router.computeBBox(id, yObj, scratch)` (route unchanged, but caps/width
  can move the bbox) → `upsertHandle(..., alwaysEvict = false)`. **A falsy `computeBBox` — no
  cached route — `continue`s without upserting at all**, so the connector gets no handle this
  fire.
- **everything else**: `computeBBoxForInto(id, kind, yObj, scratch)` — ★ **this is the
  cache-population hook**, see `docs/rendering-and-caches.md` — then `upsertHandle`. If the
  bbox changed and `!isUnbindableKind(kind)` (two `===` checks, faster than the bindable Set
  lookup on this hot path), `router.onBindableChanged(id)` queues reroutes for attached
  connectors. That fires on first insert too, so a connector whose anchor shape arrives late
  over WS reroutes correctly.

Phase B must run before Phase C: Phase C reads bindable handles through `frameOf`, and needs
the post-Phase-B view.

**Phase B's iteration order is observable.** `isQueuedForReroute` reads a queue Phase B itself
mutates. A connector visited *before* its anchor shape takes the style-only branch and gets
upserted; the shape then queues it and Phase C upserts it again — two upserts and two dirty-rect
publishes in one fire. Correct, just not free.

**Phase C · drain the reroute queue.** For each id from `router.drainRerouteQueue()`:
`router.rerouteCanonical(id, yObj, scratch)` (routes *and* writes the bbox) →
`upsertHandle(..., alwaysEvict = true)` — a connector's route can change while its bbox does
not, and the cached `ConnectorPaths` would otherwise survive. Each drained id is added to
`touched` so the post-phase selection refresh covers ids queued by Phase B's propagation.

Routing failure leaves the handle untouched; the next fire corrects it.

Finally: `selection.onObjectsKindChanged(_kindChangedIds)` **before**
`selection.onObjectsChanged(touched, changed)` — `refreshStyles` must run against the
recomputed selection composition.

### `upsertHandle` — the only bbox writer

```
first insert:  read+assert z → zOrder.acquireSlot() → createHandle (clones the scratch into
               an owned tuple) → zOrder.noteAdd(z) → objectsById.set → spatialIndex.insert
               → evictGeometry → invalidate new rect → return true

update:        bboxChanged = !bboxEquals(handle.bbox, newBBox)
               if (bboxChanged) invalidate PREV rect      ← handle.bbox still holds OLD values
                                spatialIndex.updateHandleBBox(handle, newBBox)
               if (bboxChanged || alwaysEvict) evictGeometry(id)
               invalidate NEW rect                        ← ALWAYS
               return bboxChanged
```

Two things are non-negotiable:

1. **Publish the previous rect before `updateHandleBBox`.** rbush needs the old envelope to
   find the leaf, and the dirty rect needs the old area to erase it.
2. **The new rect is always invalidated**, even when the bbox is unchanged — content can
   change visually (colour, text, opacity, code output) without moving.

Returning `bboxChanged` is what drives bindable→connector propagation and selection
bookkeeping upstream. Don't discard it. Note `alwaysEvict` **only** forces the `evictGeometry`
call — it does not force an rbush update and does not make the return value `true`.

### Traps

- **Extension observers fire before the deep observer.** The Tiptap `TextCollaboration`
  observer sees `handle.kind` still holding the OLD kind during a cross-kind conversion, which
  is why `TextTool.syncProps` bails when `'kind'` is in the changed keys.
- **`upsertHandle` throws on a missing `z`** — from inside Y's transaction cleanup. Both hydrate
  passes throw too. That is deliberate: a missing `z` means a writer bypassed the creation
  pattern.
- **`handle.y` is never refreshed after `createHandle`.** A top-level `objects.set(existingId, newMap)`
  routes exactly like an add, but the update branch of `upsertHandle` doesn't rebind `y`. No
  current call site does this — it is latent, not live. Don't be the first.
- **Phase B reads `kind` from Y, not from the handle.** If the two ever diverge you get a bbox
  computed for the new kind while the renderer and spatial layer dispatch on the old one.

---

## 4. Mutating the doc

**Always `transact(fn)` from `runtime/room-runtime.ts`**, never `getActiveRoomDoc().mutate(fn)`.
`transact` returns whatever `fn` returns (`T | undefined` — `undefined` when the room is
destroyed), so callers skip the `let foo; transact(() => { foo = … })` dance.

`transact` tags the transaction with `userId`, which is exactly the origin the UndoManager
tracks. `transactPyOutput` (same file, origin `PY_RUN_ORIGIN`) is the escape hatch: a distinct
origin keeps the write **out of the undo stack** while still persisting to IDB and
broadcasting over WS — both are origin-agnostic. Its only consumer is Python run output, so
Cmd+Z after a run undoes the last *edit*, never the output.

**Never touch derived state by hand.** Creating, mutating or deleting objects means writing to
the Y.Map and letting the observer do the rest. Specifically, never call from application code:
`objectsById.set/delete`, `spatialIndex.*`, `applyHandleBBox`, `zOrder.acquireSlot/releaseSlot`,
or any cache's `evict`. If you find yourself wanting to, the bug is upstream.

The canonical creation pattern (single `transact`, build the `Y.Map`, set shared + per-kind
fields, `getObjects().set(id, m)` last) and the `z`-key generators are in the root
`CLAUDE.md` → *Creating an object*.

---

## 5. "Handle exists ⇒ caches populated"

Because Phase B calls `computeBBoxForInto` for every touched non-connector, and the derived
branches populate their subsystem cache as a side effect, this invariant holds:

> If `objectsById.has(id)`, that id's layout cache entry exists.

So `getTextFrame(id)` / `getCodeFrame(id)` / `getBookmarkFrame(id)` returning `null` means a
genuine map miss — an id never observed, or one already deleted (its cache entry was dropped
alongside the handle in Phase A). Within an id's lifetime the caches stay populated. Code that
reads a derived frame does not need a "maybe not laid out yet" branch.

Exceptions and their reasons are catalogued in `docs/rendering-and-caches.md` (lazy Path2D,
lazy shape labels, async image bitmaps, async Lezer spans).

---

## 6. Providers, connection, and session plumbing

`RoomDocManager` also owns the WebSocket lifecycle — it is the client end of the sync worker.

**Provider.** `y-partyserver`'s `YProvider(host, roomId, ydoc, { prefix, maxBackoffTime: 10_000, resyncInterval: -1 })`.
`host` is `SYNC_HOST ?? window.location.host` — the remote `sync.<domain>`, or the Vite host
locally so the `/sync` proxy forwards the upgrade. `prefix` (not `party`) bakes the path
verbatim: `/${SYNC_WS_PREFIX}/rooms/${roomId}`. The connection is cross-origin to the SPA and
gated server-side by the CSWSH Origin allowlist in sync's `on-before-connect`.

**First sync per connection → `repackSpatialIndex()`.** The `'sync'` event fires with the
remote state applied; the index is cleared and bulk-`load`ed for optimal tree packing. It
touches nothing else — not `objectsById`, not `zOrder`, not caches, not the router.

**Presence owns the connection flags.** `attach(provider, cb)` (`runtime/presence/`) wires the
awareness, and *its* callback is the only writer of `wsConnected` (what `isConnected()` reads)
and the only thing that resets `wsRepacked = false` on disconnect. If the presence wiring
changes, repack-per-connection silently degrades to repack-once-ever.

**Close-code policy.** The stock provider reconnects on *every* close. `4401` and `4403` are
terminal:
- `4401` (unauthenticated) → record access + `disconnect()`. Possibly transient; nothing
  destructive.
- `4403` (private, not owner) → additionally `removeRoom(roomId)`, patch the cached rooms row
  to `permission: 'private'` for an instant hide, invalidate the rooms query, **delete the
  y-indexeddb data via `clearData()`** (which unhooks the update listener before deleting so
  the live doc can't re-persist), and navigate to `/home`. Leaving an interactive canvas open
  after persistence is gone would silently discard every further edit.

**Server pushes** arrive as prefixed custom messages: `mode:` → `setRoomMode`, `title:` →
`setRoomTitle`, `owner:` → `setRoomIsOwner` + persisted fact, `perm:` → Zod-parsed
`setRoomPermission` + persisted fact. The store-side semantics are in the root `CLAUDE.md`
Stores table (`room-session-store`, `room-list-store`).

---

## 7. Adding a new `ObjectKind` — the full touch list

Verified by enumerating every per-kind dispatch (`grep -rn "case 'bookmark'"` is the reference
sweep — `bookmark` is the newest kind, so it appears at every required site).

**Required:**

| File | What to add |
|---|---|
| `core/types/objects.ts` | `OBJECT_KINDS` entry, a `XxxProps` interface, and `BINDABLE_KINDS` if connectors may attach |
| `core/accessors.ts` | a bulk `getXxxProps(y)` accessor (per-field accessors only if genuinely needed elsewhere) |
| `core/geometry/bbox.ts` | a `computeBBoxForInto` branch — **and it must populate the kind's cache if the frame is derived** |
| `core/geometry/frame-of.ts` | one entry in `FRAME_BY_KIND` (bindable kinds only) |
| `core/spatial/hit-dispatch.ts` | three arms — point / rect / circle. See `core/spatial/CLAUDE.md` for the tight-framed fast path vs the padded helpers |
| `renderer/layers/objects.ts` | a `drawObject` case and a `renderScaleEntry` case |
| `renderer/render-accessors.ts` | a `readXxxRender(y)` returning a module scratch |
| `renderer/object-cache.ts` | a `removeObjectCaches` case, and clear it in `clearAllObjectCaches` |
| `tools/selection/transform.ts` | scale-behaviour + apply-table entries (see `tools/selection/CLAUDE.md`) |
| `tools/selection/connector-topology.ts` | a `fillFrameFromBind` case (bindable kinds only) |
| `tools/selection/selection-utils.ts` | `kindCounts` entry + whatever style composition applies |
| root `CLAUDE.md` | the schema line under *Y.Doc Structure* |

**Kind-agnostic — nothing to do:** `core/z-order/` (drives off `slot`/`z`),
`core/clipboard/` (deep-clones Y.Maps; only `connector` is special-cased), `EraserTool`
(routes through `hit-dispatch`), `core/connectors/` snap + reroute (kind-agnostic via
`isBindableKind` + `frameOf`), and `RoomDocManager` itself.

**If the new kind has a derived frame**, it also needs a layout cache with `evict(id)` /
`clear()` and a `getXxxFrame(id)` reader — model it on `core/bookmark/bookmark-render.ts`,
the smallest complete example.
