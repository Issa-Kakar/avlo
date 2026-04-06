# Refactor Changelog

Incremental cleanup and architectural improvements. Architectural direction tracked in `docs/ARCHITECTURE_REDESIGN.md`.

---

## Phase 8: BBox Consolidation, Renderer Optimization, Cache Unification

Three concerns cleaned up: `computeBBoxFor` now owns all bbox dispatch (text/note/code no longer special-cased at call sites), the renderer drops legacy indirection (`ViewTransform`, `ViewportInfo`, LOD, per-frame `new Set`), and the object cache system is split into geometry cache + unified dispatcher with shapeType-aware staleness detection.

### `computeBBoxFor` consolidation

Signature changed from `(kind, yMap)` to `(id, kind, yMap)`. Text, note, and code cases now call `computeTextBBox`/`computeNoteBBox`/`computeCodeBBox` internally — callers no longer need to branch on kind before calling bbox computation.

**RoomDocManager simplified:** Both `applyObjectChanges()` and `hydrateObjectsFromY()` had 10-line if/else chains dispatching to kind-specific bbox functions with fallbacks. Replaced by single `computeBBoxFor(id, kind, yObj)` calls. Removed 5 bbox-related imports.

### `drawObjects` signature + render loop optimization

**New signature:** `drawObjects(ctx, snapshot, clipWorldRects?)` — removed `viewTransform: ViewTransform` and `viewport: ViewportInfo` params. `drawObjects` reads camera state internally via `getVisibleWorldBounds()`.

**Deleted:**

- `shouldSkipLOD()` function — 2px diagonal threshold was unreachable in practice
- `ViewportInfo` interface from `renderer/types.ts`
- `getViewportInfo()` from `camera-store.ts` (zero consumers)
- `ViewTransform` construction in `RenderLoop.tick()` (8 lines)

**Render loop optimization:**

- `selectedIdSet` read directly from store (was `new Set(selectionState.selectedIds)` per frame)
- Candidate collection uses `string[]` + `Set<string>` instead of `IndexEntry[]` + `Map<string, IndexEntry>`
- `candidateIds.sort()` — default string sort is correct for ULIDs (same as `a.id < b.id` comparator)
- Handle lookup via `objectsById.get(id)` in render loop (was redundant: `IndexEntry` carried same data)

### Bulk accessor helpers

Added `StrokeProps`/`getStrokeProps()` and `ShapeProps`/`getShapeProps()` to `object-accessors.ts`. `drawStroke` and `drawShape` in `objects.ts` use destructured props.

### Cache system — shapeType-aware geometry + unified dispatcher

**Problem:** Shape objects required brute-force `cache.evict(id)` on every property change (even color/opacity) because the geometry cache couldn't detect shapeType changes (rect→diamond). The cache system was split across files with inconsistent naming (`remove` vs `evict` vs `invalidate`).

**New `renderer/geometry-cache.ts`:** Extracted from `ObjectRenderCache` class. Standalone functions (`getPath`, `getConnectorPaths`, `evictGeometry`, `clearGeometry`). Key change: stores `shapeType` alongside geometry — `getOrBuild` auto-detects shapeType mismatches and rebuilds, eliminating the `if (kind === 'shape') cache.evict(id)` hack in the observer. Removed dead `case 'text': case 'image': return new Path2D()`.

**Naming standardization:**

- `textLayoutCache.remove(id)` → `evict(id)`
- `codeSystem.remove(id)` → `evict(id)`
- Bookmark: bare functions wrapped into `bookmarkCache` object with `evict(id)` / `clear()`

**New `renderer/object-cache.ts`** (rewritten): Two exported functions:

- `removeObjectCaches(id, kind)` — object deleted → evict geometry + kind-specific layout cache
- `clearAllObjectCaches()` — room teardown → clear everything (geometry + text + code + bookmark + connector lookup)

**RoomDocManager simplified:**

- Deletion: 5-line cache dispatch → `removeObjectCaches(id, handle.kind)`
- Update: `cache.evict(id)` → `evictGeometry(id)`, removed shape hack
- Hydration: 4 clear calls → `clearAllObjectCaches()`
- Destroy: 5 cache clears → `clearAllObjectCaches()`

**CanvasRuntime:** Removed `getObjectCacheInstance().clear()` from `stop()` — geometry cache cleared by `clearAllObjectCaches()` in `RoomDocManager.destroy()`.

**Renderer layers** (`eraser-dim.ts`, `selection-overlay.ts`, `connector-preview.ts`): `getObjectCacheInstance()` → direct `getPath`/`getConnectorPaths` imports from `geometry-cache.ts`.

### Files changed

| File                                   | Action                                      | Delta |
| -------------------------------------- | ------------------------------------------- | ----- |
| `renderer/geometry-cache.ts`           | **Created**                                 | +140  |
| `renderer/object-cache.ts`             | Rewritten (unified dispatcher)              | −180  |
| `lib/geometry/bbox.ts`                 | Signature change + text/note/code dispatch  | +30   |
| `lib/object-accessors.ts`              | Added StrokeProps, ShapeProps               | +29   |
| `renderer/layers/objects.ts`           | Signature, optimization, prop destructuring | −55   |
| `renderer/RenderLoop.ts`               | Removed ViewTransform/viewport construction | −20   |
| `renderer/types.ts`                    | Deleted ViewportInfo                        | −16   |
| `stores/camera-store.ts`               | Deleted getViewportInfo()                   | −20   |
| `lib/room-doc-manager.ts`              | Simplified bbox + cache dispatch + teardown | −40   |
| `canvas/CanvasRuntime.ts`              | Removed geometry cache clear                | −3    |
| `lib/text/text-system.ts`              | remove() → evict()                          | ±0    |
| `lib/code/code-system.ts`              | remove() → evict()                          | ±0    |
| `lib/bookmark/bookmark-render.ts`      | Added bookmarkCache object                  | +9    |
| `renderer/layers/eraser-dim.ts`        | Direct geometry-cache imports               | −3    |
| `renderer/layers/selection-overlay.ts` | Direct geometry-cache imports               | −3    |
| `renderer/layers/connector-preview.ts` | Direct geometry-cache imports               | −2    |
| `renderer/layers/index.ts`             | **Deleted** — single re-export barrel       | −2    |
| `renderer/RenderLoop.ts`               | Import directly from `./layers/objects`     | ±0    |

**Net: −136 lines** (excluding new geometry-cache.ts)

---

## Phase 7: Direct Exports, Singleton Render Loops, Per-Room Camera Persistence

Three independent changes reducing verbosity across 20+ files, making render loops self-managing, and persisting camera state per room.

### Part 1: Direct exports from room-runtime

Eliminated the verbose `getCurrentSnapshot().objectsById.get(id)` pattern (40+ sites across 16 files) and `getActiveRoomDoc().mutate(fn)` pattern (~15 sites across 10 files).

**IRoomDocManager interface** — added `readonly objectsById` and `readonly spatialIndex` (were private on impl).

**New room-runtime exports:**

| Export              | Replaces                                         |
| ------------------- | ------------------------------------------------ |
| `getHandle(id)`     | `getCurrentSnapshot().objectsById.get(id)`       |
| `getHandleKind(id)` | `getCurrentSnapshot().objectsById.get(id)?.kind` |
| `getBbox(id)`       | `getCurrentSnapshot().objectsById.get(id)?.bbox` |
| `getObjectsById()`  | `getCurrentSnapshot().objectsById`               |
| `getSpatialIndex()` | `getCurrentSnapshot().spatialIndex`              |
| `transact(fn)`      | `getActiveRoomDoc().mutate(fn)`                  |
| `undo()` / `redo()` | `getActiveRoomDoc().undo()` / `.redo()`          |

**Files updated (16):** SelectTool, EraserTool, ConnectorTool, DrawingTool, TextTool, CodeTool, selection-store, snap, reroute-connector, image-manager, image-actions, bookmark-unfurl, clipboard-actions, selection-actions, keyboard-manager, ToolPanel, ContextMenu, connector-preview.

**Not changed:** Files that receive `Snapshot` as a function parameter (hit-testing, objects.ts, selection-overlay, RenderLoop) — Snapshot interface retains `objectsById`/`spatialIndex` fields.

### Part 2: Render loops as self-constructing singletons

**RenderLoop** — moved `visibilitychange` listener from constructor → `start()`/`stop()`. Wires `setWorldInvalidator`, `setWorldBBoxInvalidator`, `setFullClearFn` in `start()`, clears in `stop()`. Merged `destroy()` into `stop()`. Exported as `export const renderLoop = new RenderLoop()`.

**OverlayRenderLoop** — wires `setOverlayInvalidator`, `setHoldPreviewFn` in `start()`, clears in `stop()`. Merged `destroy()` (including `destroyAnimationController()`) into `stop()`. Exported as `export const overlayLoop = new OverlayRenderLoop()`.

**CanvasRuntime simplified** — removed `RenderLoop`/`OverlayRenderLoop` class fields and construction. `start()` calls `renderLoop.start(); overlayLoop.start()`. `stop()` calls `renderLoop.stop(); overlayLoop.stop()`. Removed all `setWorldInvalidator`/`setOverlayInvalidator`/`setHoldPreviewFn` import and wiring (render loops own this now).

### Part 3: Per-room camera persistence

All logic in `camera-store.ts` — no separate module.

**New state:** `roomCameras: Record<string, { scale, pan }>` (persisted), `currentRoomId: string | null` (ephemeral).

**New action:** `setRoom(roomId)` — saves outgoing camera to `roomCameras`, restores incoming. Called by `connectRoom()` in `room-runtime.ts`.

**Persistence:** `zustand/middleware/persist` with `partialize` — only `roomCameras` hits localStorage (`avlo.camera.v1`). Scale, pan, viewport dimensions, DPR, and currentRoomId are all ephemeral.

**Debounced sync:** `useCameraStore.subscribe()` writes camera to `roomCameras` at most once per second after last pan/zoom. `setRoom()` flushes immediately on room switch.

### ESLint + gitignore

- Added `.wrangler/**`, `**/.wrangler/**`, `**/.tanstack/**` to ESLint ignores
- Added `.tanstack/` / `*/.tanstack/` to `.gitignore`

### Files changed

| File                             | Action                                                   | Delta |
| -------------------------------- | -------------------------------------------------------- | ----- |
| `lib/room-doc-manager.ts`        | Added fields to interface, private→readonly              | +3    |
| `canvas/room-runtime.ts`         | Added 8 convenience exports + setRoom call               | +40   |
| `renderer/RenderLoop.ts`         | Singleton, self-wiring, merged destroy                   | +10   |
| `renderer/OverlayRenderLoop.ts`  | Singleton, self-wiring, merged destroy                   | +5    |
| `canvas/CanvasRuntime.ts`        | Removed render loop fields + wiring                      | −25   |
| `stores/camera-store.ts`         | persist middleware, roomCameras, setRoom, debounced sync | +55   |
| `canvas/invalidation-helpers.ts` | No change (setters already existed)                      | ±0    |
| 16 consumer files                | Pattern replacements                                     | −50   |
| `eslint.config.js`               | Added .wrangler/.tanstack ignores                        | +3    |
| `.gitignore`                     | Added .tanstack                                          | +3    |

---

## Phase 6: RoomDocManager — Spatial Index, Dirty Rects, Lifecycle

Eliminated gate system, DirtyPatch indirection, lazy-null spatialIndex, and deferred cache eviction. RoomDocManager now constructs spatialIndex non-null from the start, evicts caches and invalidates dirty rects directly in the observer, and uses a simple async init flow with two-phase spatial index loading (IDB bulk load + WS repack).

### Type changes

- **Deleted:** `DirtyPatch` interface from `types/objects.ts`
- **`Snapshot`:** removed `dirtyPatch`, `createdAt`, `spatialIndex` is now non-null (`ObjectSpatialIndex`, not `| null`)
- `createEmptySnapshot()` constructs a real `ObjectSpatialIndex` instance

### New invalidation helpers (`canvas/invalidation-helpers.ts`)

| Export                                               | Purpose                                                     |
| ---------------------------------------------------- | ----------------------------------------------------------- |
| `invalidateWorldBBox(bbox: BBoxTuple)`               | BBoxTuple-native dirty rect — avoids WorldBounds allocation |
| `invalidateWorldAll()`                               | Full base-canvas clear — used after hydration rebuild       |
| `setWorldBBoxInvalidator(fn)` / `setFullClearFn(fn)` | Registered by CanvasRuntime                                 |

### RenderLoop (`renderer/RenderLoop.ts`)

Added `invalidateWorldBBox(bbox: BBoxTuple)` — reads tuple indices directly, same coalesce/promote logic as `invalidateWorld`.

### CanvasRuntime simplified

- Wires `setWorldBBoxInvalidator` + `setFullClearFn` in `start()`/`stop()`
- Snapshot subscription reduced to: `holdPreviewForOneFrame()` + `overlayLoop.invalidateAll()` — no dirtyPatch processing
- Removed imports: `boundsIntersect`, `getVisibleWorldBounds` (moved to RoomDocManager)

### RoomDocManager rewritten

**Deleted infrastructure:**

- 4-gate system (`gates`, `gateTimeouts`, `gateCallbacks`) → replaced by `wsConnected: boolean`
- `openGate()`, `closeGate()`, `whenGateOpen()`, `handleIDBReady()` methods
- `dirtyRects: WorldBounds[]`, `cacheEvictIds: Set<string>` — replaced by direct eviction in observer
- `needsSpatialRebuild: boolean` — observer attached after hydrate, no guard needed
- `sawAnyDocUpdate: boolean`, `firstSnapshot` gate logic

**New lifecycle:**

```
constructor() → synchronous, fire-and-forget void this.init()
init():
  1. await IDB (1s timeout via Promise.race)
  2. initConnectorLookup + hydrateObjectsFromY + publishSnapshotNow
  3. setupObjectsObserver (AFTER hydrate)
  4. attachUndoManager
  5. initializeWebSocketProvider
```

**New methods:**

- `repackSpatialIndex()` — `clear()` + `bulkLoad()` from objectsById, called once per WS connection on `'synced'`
- `flushDirtyBBoxes(bboxes)` — viewport intersection check on BBoxTuples, calls `invalidateWorldBBox` directly

**Observer changes (applyObjectChanges):**

- Direct `cache.evict(id)` replaces `cacheEvictIds.add(id)`
- Local `dirtyBBoxes: BBoxTuple[]` replaces `this.dirtyRects.push(bboxToBounds(...))`
- `flushDirtyBBoxes()` at end — inline AABB viewport check, zero WorldBounds allocation
- Removed `if (this.spatialIndex)` null guards

**Hydration changes:**

- Added `getObjectCacheInstance().clear()` alongside text/code/bookmark cache clears
- Added `invalidateWorldAll()` at end — signals full base-canvas clear

**publishSnapshotNow simplified:** 10 lines (was 50). No lazy spatialIndex creation, no DirtyPatch construction, no gate logic.

### Consumer null-guard removals (7 files)

Removed `spatialIndex` null checks from all consumers — spatialIndex is always non-null:

- `lib/geometry/hit-testing.ts` (3 functions)
- `renderer/layers/objects.ts`
- `lib/connectors/snap.ts`
- `lib/tools/EraserTool.ts`
- `lib/tools/SelectTool.ts` (2 locations)
- `lib/image/image-manager.ts`
- `lib/clipboard/clipboard-actions.ts`

### Files changed

| File                                 | Action                                                     | Delta |
| ------------------------------------ | ---------------------------------------------------------- | ----- |
| `types/objects.ts`                   | Deleted `DirtyPatch`, removed `WorldBounds` import         | −6    |
| `types/snapshot.ts`                  | Non-null spatialIndex, removed createdAt/dirtyPatch        | ±0    |
| `canvas/invalidation-helpers.ts`     | Added BBox invalidator + full clear                        | +15   |
| `renderer/RenderLoop.ts`             | Added `invalidateWorldBBox` method                         | +20   |
| `canvas/CanvasRuntime.ts`            | Simplified snapshot subscription, new invalidator wiring   | −15   |
| `lib/room-doc-manager.ts`            | Core rewrite: gates → boolean, async init, direct eviction | −120  |
| `lib/geometry/hit-testing.ts`        | Removed 3 null guards                                      | −6    |
| `renderer/layers/objects.ts`         | Removed null guard                                         | −1    |
| `lib/connectors/snap.ts`             | Removed null guard                                         | −2    |
| `lib/tools/EraserTool.ts`            | Removed null guard                                         | −4    |
| `lib/tools/SelectTool.ts`            | Removed 2 null guards                                      | −6    |
| `lib/image/image-manager.ts`         | Removed null guard                                         | −1    |
| `lib/clipboard/clipboard-actions.ts` | Removed null guard                                         | −1    |

---

## Phase 5: TanStack Router Migration & Route-Driven Room Lifecycle

Replaced react-router-dom with TanStack Router. Room connection moved from React component tree to route `beforeLoad`. Registry/provider/ref-counting pattern eliminated in favor of `connectRoom()`/`disconnectRoom()` in `room-runtime.ts`.

### New files

| File                      | Purpose                                                  |
| ------------------------- | -------------------------------------------------------- |
| `routes/__root.tsx`       | Root layout — `<Outlet />`                               |
| `routes/index.tsx`        | `/` → redirect to `/room/dev`                            |
| `routes/room.$roomId.tsx` | `beforeLoad: connectRoom(roomId)`, component: `RoomPage` |
| `router.ts`               | `createRouter({ routeTree })` + type registration        |
| `routeTree.gen.ts`        | Auto-generated by TanStackRouterVite plugin (committed)  |

### Deleted files

| File                                | Reason                                                        |
| ----------------------------------- | ------------------------------------------------------------- |
| `App.tsx`                           | Routes moved to `routes/`, no registry provider needed        |
| `lib/room-doc-registry.ts`          | Registry class replaced by `connectRoom()`/`disconnectRoom()` |
| `lib/room-doc-registry-context.tsx` | React context provider no longer needed                       |
| `hooks/use-room-doc.ts`             | Registry-based hook no longer needed                          |
| `hooks/use-snapshot.ts`             | Zero consumers                                                |

### `room-runtime.ts` rewritten

- `setActiveRoom()` removed — replaced by `connectRoom(roomId)` / `disconnectRoom(roomId?)`
- `connectRoom()` is idempotent (same roomId = no-op), auto-disconnects previous room
- `disconnectRoom()` takes optional roomId guard for safe stale cleanup from useEffect
- Constructs `RoomDocManagerImpl` directly (no registry indirection)

### `main.tsx` rewritten

`BrowserRouter` + `App` → `RouterProvider(router)`. Font loading preserved in async `init()`.

### `RoomPage.tsx` rewritten

- `getRouteApi('/room/$roomId').useParams()` for type-safe params
- `key={roomId}` on `RoomCanvas` forces full remount on room switch
- `useEffect` cleanup: `disconnectRoom(roomId)` with guard
- No `roomId` validation needed — TanStack Router guarantees param

### `Canvas.tsx` simplified

- Removed `roomId` prop, `useRoomDoc()` call, `setActiveRoom()` useLayoutEffect
- Zero room knowledge — pure DOM + CanvasRuntime lifecycle

### `use-presence.ts` simplified

- Removed `roomId` param — reads from `getActiveRoomDoc()` singleton
- Empty deps `[]` — safe because parent remounts via `key={roomId}`

### `UserAvatarCluster.tsx` simplified

- Removed `roomId` prop — `usePresence()` called without args

### `vite.config.ts` updated

`tanstackRouter()` plugin added (before `react()`) with `autoCodeSplitting: true`. Room chunk (Y.js + CodeMirror + Tiptap + Canvas + tools) lazy-loads on room navigation.

### Dependency changes

```bash
npm uninstall react-router-dom
npm install @tanstack/react-router
npm install -D @tanstack/router-plugin
```

### Test config cleanup

Removed orphaned `vitest.config.ts` and `playwright.config.ts` from root (no test suites currently active).

---

## Phase 4: Clean Up `packages/shared`

Gutted `packages/shared` from 19 files to 5. Types, accessors, spatial index, and bbox utils moved to client — shared now only exports identifiers + 3 utility modules used by the worker.

### Dead code deleted

- `types/room.ts` — legacy `Stroke`, `TextBlock`, `CodeCell`, `Meta`
- `types/commands.ts` — legacy command pattern
- `types/validation.ts` — validators for dead command types
- `test-utils/generators.ts` — never imported
- `__tests__/config.test.ts` — tests for dead config

### Grid system deleted

- `renderer/layers/index.ts`: removed `drawBackground()`, `drawDotLayer()`, `lerp()`, `invLerp()`, `gridAlpha()` (~146 lines)
- `renderer/RenderLoop.ts`: removed `drawBackground` call — CSS `backgroundColor: '#f8f9fa'` on base canvas handles fill
- `CANVAS_STYLE_CONFIG` no longer exists

### `config.ts` deleted (422 lines), constants inlined

| Constant                                   | New location                                                                  |
| ------------------------------------------ | ----------------------------------------------------------------------------- |
| `MIN_ZOOM`, `MAX_ZOOM`, `MAX_PAN_DISTANCE` | `canvas/constants.ts` (new, shared by camera-store, transforms, ZoomControls) |
| `MAX_CANVAS_DIMENSION`                     | `canvas/SurfaceManager.ts` (sole consumer)                                    |
| 6 stroke simplification constants          | `lib/tools/simplification.ts` (sole consumer)                                 |
| 4 awareness constants                      | `lib/room-doc-manager.ts` (sole consumer)                                     |

All other config objects (`WEBRTC_CONFIG`, `BACKOFF_CONFIG`, `RATE_LIMIT_CONFIG`, `QUEUE_CONFIG`, `OFFLINE_THRESHOLD_CONFIG`, `PWA_CONFIG`, `TEXT_CONFIG`, `DEBUG_CONFIG`) were unused — deleted outright.

### Types moved to `client/src/types/`

| File           | Notes                                                               |
| -------------- | ------------------------------------------------------------------- |
| `geometry.ts`  | Standalone, no changes                                              |
| `objects.ts`   | Removed re-exports of geometry (consumers import geometry directly) |
| `snapshot.ts`  | `Snapshot`, `ViewTransform`, `createEmptySnapshot`                  |
| `awareness.ts` | Changed `./identifiers` import → `@avlo/shared`                     |

### Library files moved to client

| From (shared)                     | To (client)                           | Import changes                                            |
| --------------------------------- | ------------------------------------- | --------------------------------------------------------- |
| `accessors/object-accessors.ts`   | `lib/object-accessors.ts`             | geometry import → `@/types/geometry`                      |
| `utils/bbox.ts`                   | `lib/geometry/bbox.ts`                | types → `@/types/*`, accessors → `@/lib/object-accessors` |
| `spatial/object-spatial-index.ts` | `lib/spatial/object-spatial-index.ts` | types → `@/types/objects`                                 |

`rbush` + `@types/rbush` added to client `package.json`.

### ~47 client files rewritten

All `@avlo/shared` imports split to new local paths:

| New import               | Symbols                                                                                                                         |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `@/types/geometry`       | `BBoxTuple`, `FrameTuple`, `WorldBounds`, `Frame`, converters                                                                   |
| `@/types/objects`        | `ObjectKind`, `ObjectHandle`, `IndexEntry`, `DirtyPatch`                                                                        |
| `@/types/snapshot`       | `Snapshot`, `ViewTransform`, `createEmptySnapshot`                                                                              |
| `@/types/awareness`      | `Awareness`, `PresenceView`                                                                                                     |
| `@/lib/object-accessors` | All 40+ accessors + types (`Dir`, `StoredAnchor`, `TextAlign`, `FontFamily`, `CodeLanguage`, etc.)                              |
| `@/lib/geometry/bbox`    | `computeBBoxFor`, `computeConnectorBBoxFromPoints`, `bboxEquals`, `bboxToBounds`                                                |
| `@/lib/spatial`          | `ObjectSpatialIndex`                                                                                                            |
| `@avlo/shared` (kept)    | `RoomId`, `UserId`, `ulid`, `normalizeUrl`, `extractDomain`, `isValidHttpUrl`, `validateImage`, `isSvg`, `parseImageDimensions` |

Re-export files updated: `lib/connectors/types.ts`, `lib/text/text-system.ts`, `stores/device-ui-store.ts`.

### Shared package final state (5 files)

```
types/identifiers.ts       # RoomId, UserId, StrokeId, TextId
utils/ulid.ts              # ulid()
utils/url-utils.ts         # normalizeUrl, extractDomain, isValidHttpUrl
utils/image-validation.ts  # validateImage, isSvg, parseImageDimensions
index.ts                   # barrel
```

`package.json` deps trimmed: removed `rbush`, `@types/rbush`, `zod`. Kept `ulid`.

Files importing `@avlo/shared`: ~12 (down from ~59).

---

## Phase 3: Flatten Y.Doc — Top-Level Objects Map

Eliminated the triple-nested `ydoc.getMap('root').get('objects')` pattern. Objects map is now top-level via `ydoc.getMap('objects')` — a Yjs guarantee that always exists, never needs seeding.

### Y.Doc structure

```
Before:                               After:
Y.Doc { guid: roomId }                Y.Doc { guid: roomId }
└─ root: Y.Map                        └─ objects: Y.Map<Y.Map<any>>
   ├─ v: 2
   ├─ meta: Y.Map
   └─ objects: Y.Map<Y.Map<any>>
```

### RoomDocManager changes

- **New public field:** `readonly objects: YObjects` on interface + class, initialized as `ydoc.getMap('objects')`
- **Deleted:** `getRoot()`, `getMeta()`, `getObjects()` private methods — replaced by public `this.objects`
- **Deleted:** `initializeYjsStructures()` — no seeding needed for top-level maps
- **Deleted:** `delay()` helper, `YMeta` type alias
- **Simplified constructor:** single `whenGateOpen('idbReady')` block (was two blocks with WS grace period + meta seed)
- **Simplified `mutate()`:** `if (destroyed) return; ydoc.transact(fn, userId)` — was 20+ lines with meta guard + deferred write + replay
- **Removed meta guard** from `publishSnapshotNow()`
- All internal `this.getObjects()` calls → `this.objects`

### Mutate pattern at callsites

```typescript
// Before (~35 occurrences across 11 files):
roomDoc.mutate((ydoc) => {
  const objects = ydoc.getMap('root').get('objects') as Y.Map<Y.Map<any>>;
  objects.set(id, yMap);
});

// After:
roomDoc.mutate(() => {
  roomDoc.objects.set(id, yMap);
});
```

### room-runtime.ts

Added `getObjects()` convenience getter (re-exports `getActiveRoomDoc().objects`).

### Files changed

| File                                    | Action                                | Delta |
| --------------------------------------- | ------------------------------------- | ----- |
| `lib/room-doc-manager.ts`               | Rewritten (core)                      | −110  |
| `canvas/room-runtime.ts`                | Added getter                          | +12   |
| `lib/tools/DrawingTool.ts`              | Callsites                             | −9    |
| `lib/tools/SelectTool.ts`               | Callsites + removed Y import          | −15   |
| `lib/tools/TextTool.ts`                 | Callsites                             | −7    |
| `lib/tools/ConnectorTool.ts`            | Callsites                             | −4    |
| `lib/tools/EraserTool.ts`               | Callsites + removed Y import          | −5    |
| `lib/tools/CodeTool.ts`                 | Callsites                             | −2    |
| `lib/clipboard/clipboard-actions.ts`    | Callsites                             | −6    |
| `lib/bookmark/bookmark-unfurl.ts`       | Callsites                             | −4    |
| `lib/image/image-actions.ts`            | Callsites                             | −3    |
| `lib/utils/selection-actions.ts`        | Callsites                             | −3    |
| `lib/__tests__/phase6-teardown.test.ts` | Updated to new API                    | ±0    |
| `CLAUDE.md`                             | Updated Y.Doc structure + mutate docs | ±0    |

**Net: −126 lines**

---

## Phase 2: Presence/Awareness Cleanup (pre-redesign)

Strip dead awareness fields, eliminate redundant gates, delete undesigned UI, simplify accessors.

### Shared types stripped

- `Awareness` interface: removed `activity`, `ts`, `aw_v`. Kept `userId`, `name`, `color`, `cursor?`, `seq`.
- `PresenceView` user shape: removed `activity` and `lastSeen`.

### UsersModal deleted

- Deleted `UsersModal.tsx` (undesigned, placeholder modal)
- `RoomPage.tsx`: removed modal state, import, JSX
- `UserAvatarCluster.tsx`: removed `onShowModal` prop, `onClick` handler, activity in tooltip
- Barrel export cleaned

### RoomDocManager interface + field cleanup

- Interface: removed `getGateStatus()`, `isIndexedDBReady()`, `updateActivity()`; added `isConnected(): boolean`
- Deleted `localActivity` field and constructor init
- Removed `activity` from `lastSentAwareness` comparison type

### `awarenessReady` gate eliminated

`awarenessReady` opened/closed exactly when `wsConnected` did. All references replaced:

- Removed `awarenessReady: false` from `gates` object
- `sendAwareness()` / `updateCursor()`: `gates.awarenessReady` → `gates.wsConnected`
- `openGate()` cross-checks: `awarenessReady` refs → `wsConnected`
- `_onWebSocketStatus` connected: merged awareness dirty/send into `wsConnected` open block
- `_onWebSocketStatus` disconnected: merged cursor clear + `setLocalState(null)` into `wsConnected` close block

### Dead awareness fields stripped from send path

- `setLocalState()`: removed `activity`, `ts`, `aw_v`. Sends `userId`, `name`, `color`, `cursor`, `seq`.
- `sendAwareness()` comparison: removed `activity ===` check
- `buildPresenceView()`: removed `activity` and `lastSeen` from user map

### Dead methods deleted, `isConnected()` added

- Deleted `updateActivity()`, `getGateStatus()`, `isIndexedDBReady()` implementations
- Added `isConnected(): boolean` (reads `gates.wsConnected`)

### BBox computation simplified

Both `applyObjectChanges()` and `hydrateObjectsFromY()` had verbose `.get()` fallback chains for note/text when typed accessors returned null. Replaced with `computeBBoxFor(kind, yObj)` as generic fallback — clean ternaries instead of 24-line if/else blocks.

### room-runtime.ts cleaned

- Removed `GateStatus` type export
- Removed `getGateStatus()` wrapper function

### Files changed

| File                                          | Action      | Delta |
| --------------------------------------------- | ----------- | ----- |
| `packages/shared/src/types/awareness.ts`      | Edit        | −5    |
| `client/src/components/UsersModal.tsx`        | **Deleted** | −193  |
| `client/src/components/RoomPage.tsx`          | Edit        | −8    |
| `client/src/components/UserAvatarCluster.tsx` | Edit        | −4    |
| `client/src/components/index.ts`              | Edit        | −1    |
| `client/src/lib/room-doc-manager.ts`          | Edit        | −106  |
| `client/src/canvas/room-runtime.ts`           | Edit        | −12   |

**Net: −329 lines**

---

## Phase 1: Overlay Render Loop & Animation System

Thins the overlay loop, removes dead code, establishes a standard animation pattern, and eliminates prop drilling.

---

## Animation System

### `AnimationJob` interface simplified

- `update()` + `render()` + `isActive()` → single `frame(ctx, now, dt): boolean`
- Return `true` = need another frame. Return `false` = done.
- Removed `viewport: ViewportInfo` and `view: ViewTransform` params — jobs read from camera store imperatively
- Jobs handle their own coordinate space (`ctx.save()` / `setTransform` / `ctx.restore()`)

### `AnimationController` push-based invalidation

- `tick()` + `render()` + `hasActiveAnimations()` → single `run(ctx, now)`
- Delta time computed internally (controller owns `lastTickTime`)
- `setInvalidator(fn)` wired once by OverlayRenderLoop — controller calls it if any job needs more frames
- Overlay loop never polls `hasActiveAnimations()` — the controller pushes

### `EraserTrailAnimation` adapted

- Merged `update()` + `render()` into `frame()`
- Handles own DPR transform internally
- Tool-facing API unchanged: `start()`, `addPoint()`, `stop()` — EraserTool needs zero changes

---

## Preview System Extracted

### New `renderer/layers/tool-preview.ts`

All preview dispatch + hold-one-frame mechanism moved out of OverlayRenderLoop:

- `drawToolPreview(ctx)` — routes to stroke/eraser/shape/selection/connector preview renderers
- `holdPreviewForOneFrame()` — prevents single-frame flash on commit
- `clearPreviewCache()` — called on tool switch
- Zero params except `ctx` — reads preview from `getActivePreview()`, scale from camera store, snapshot from room-runtime internally

### `holdPreviewForOneFrame` wiring simplified

- Was: `setHoldPreviewFn(() => this.overlayLoop?.holdPreviewForOneFrame())`
- Now: `setHoldPreviewFn(holdPreviewForOneFrame)` — imported directly from tool-preview.ts
- Snapshot subscriber in CanvasRuntime also calls it directly

---

## Dead Code Removed

### `TextPreview` type deleted

- Removed `TextPreview` interface from `lib/tools/types.ts`
- Removed from `PreviewData` union
- The overlay loop's text preview branch (~30 lines of dashed-box + crosshair rendering) was dead code

### Cursor trail system gutted

`presence-cursors.ts` reduced from ~356 lines to ~95 lines. Deleted:

- `CursorTrail` / `TrailProfile` interfaces
- `cursorTrails` / `peerProfiles` Maps
- `DEFAULT_TRAIL_PROFILE` + all trail constants
- `clearCursorTrails()`, `setPeerTrailProfile()`, `resetPeerTrailProfile()`
- `catmullRom()`, `resampleTrail()`, `drawTrailLaser()`, `prefersReducedMotion()`
- Peer cleanup loop

### `drawPresenceOverlays` indirection removed

- Deleted from `renderer/layers/index.ts` — was a gate-check wrapper around `drawCursors()`
- Gate checks removed as preparation for awareness redesign (gates will be eliminated entirely)

### `clearCursorTrails` references removed

- Import + 2 call sites in `room-doc-manager.ts` (teardown + disconnect handler)

---

## OverlayRenderLoop Simplified

~333 lines → ~130 lines. The new `frame()`:

```
clear → world transform → drawToolPreview(ctx) → drawCursors(ctx) → controller.run(ctx, now)
```

### Removed from the class

- `cachedPreview` / `holdPreviewOneFrame` fields (moved to tool-preview.ts)
- `holdPreviewForOneFrame()` method (moved to tool-preview.ts)
- All 6 per-preview-branch `setTransform` calls (single world transform applied once)
- `getGateStatus()` call + gate checks
- `getCurrentPresence()` / `getCurrentSnapshot()` calls
- `getViewTransform()` / `getViewportInfo()` calls
- `animController.tick()` call
- `animController.hasActiveAnimations()` polling

### Kept

- Camera subscription (invalidate on pan/zoom)
- Tool change subscription (clear preview cache)
- `invalidateAll()` / `schedule()` mechanism
- Canvas resize detection

---

## `drawCursors` — zero-param, self-contained

```typescript
export function drawCursors(ctx: CanvasRenderingContext2D): void;
```

- Reads presence from `getCurrentPresence()`, view transform from `getViewTransform()`, DPR from camera store
- Handles own screen-space DPR transform (`save/setTransform/restore`)
- `drawCursorPointer` and `drawNameLabel` exported for future cursor interpolation animation job
- No gate checks — preparation for gate elimination in presence redesign

---

## Files Changed

| File                                       | Action      | Lines                         |
| ------------------------------------------ | ----------- | ----------------------------- |
| `canvas/animation/AnimationController.ts`  | Rewritten   | 100 (was 166)                 |
| `canvas/animation/EraserTrailAnimation.ts` | Rewritten   | 105 (was 177)                 |
| `canvas/animation/index.ts`                | Updated     | exports unchanged             |
| `renderer/layers/tool-preview.ts`          | **Created** | ~65                           |
| `renderer/OverlayRenderLoop.ts`            | Rewritten   | ~130 (was 333)                |
| `renderer/layers/presence-cursors.ts`      | Rewritten   | ~95 (was 356)                 |
| `renderer/layers/index.ts`                 | Edited      | removed drawPresenceOverlays  |
| `lib/tools/types.ts`                       | Edited      | removed TextPreview           |
| `canvas/CanvasRuntime.ts`                  | Edited      | 3 lines changed               |
| `lib/room-doc-manager.ts`                  | Edited      | removed import + 2 call sites |
