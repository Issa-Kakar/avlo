# AVLO Codebase Guide
**Purpose:** Offline-first collaborative whiteboard with Yjs CRDT sync.
**Stack:** React/TS/Canvas + Yjs + Cloudflare Workers/R2

## Subsystems

Each ships its own `CLAUDE.md` (file map + notes): `core/{text,code,connectors,image,bookmark,clipboard,spatial,geometry/recognizer}`, `tools/selection`, `runtime/{input,presence}`, `components/context-menu`. Reading any file in one pulls its whole doc — be deliberate. Cross-kind concerns (`RoomDocManager`, `computeBBoxFor`, render pipeline) live here.

## Commands & Aliases
```bash
cd /home/issak/dev/avlo && npm run typecheck    # typecheck all workspaces (must run from repo root)
cd /home/issak/dev/avlo && npm run dev          # client :3000 + worker :8787 — ask before starting
```
> In the `avlo-parallel` worktree, swap the path to `/home/issak/dev/avlo-parallel` — each worktree operates on its own checked-out branch.

- `@avlo/shared` → `packages/shared/src/*`
- `@/*` → `client/src/*`

## Best Practices

- **Reuse before invention.** Bbox/frame/handle/accessor primitives exist — grep `core/geometry/bounds.ts`, `core/accessors.ts`, `core/types/`, `utils/` first. A named 3-line helper beats inline reinvention.
- **Low-friction modules.** Cross-module data flows through module-level getters (`getHandle`, `frameOf`, `getSpatialIndex`, `getVisibleBoundsTuple`). Over-encapsulation is the enemy.
- **Fewest lines for full robustness.** No defensive checks at trusted boundaries, no backwards-compat shims, no half-finished abstractions.

## Invariants

- **Dirty-rect ↔ WYSIWYG.** Base canvas only repaints rects published via `invalidateWorld{,BBox}`. Every publish MUST cover what's painted (or will be), padded for stroke + caps. Placeholder bailouts (`[0,0,0,0]`, unpadded frame, partial union) leave stale pixels until pan/zoom — eight months of bugs say so. If unavoidable, invalidate **union of old + new bbox** and document why.
- **Zero allocation on hot paths.** Render frame / observer fire / pointer move / reroute — reuse module scratches, use the `*Mut`/`*Into(out)` variant of every geometric primitive. No per-call `Set`/`Map`/`{}`/`[]`.
- **Monomorphism on hot paths.** Stable object shapes, typed-array inner loops (`Float64Array` over `[number,number][]`), no arity-varying option bags — unless unavoidable.
- **Hot paths: performance over defensiveness.** Drop null guards, try/catch, and re-validation when the upstream contract already covers them. Defensive code belongs at boundaries, not in inner loops.

---

## File Map

All paths relative to `client/src/` unless noted.

### Runtime (`runtime/`)
| File | Responsibility |
|------|----------------|
| `CanvasRuntime.ts` | Central orchestrator — events, subscriptions, tool dispatch |
| `SurfaceManager.ts` | DOM refs (contexts, editorHost) + resize/DPR + deferred canvas resize |
| `InputManager.ts` | DOM event forwarder + modifier state (shift/ctrl/meta) |
| `tool-registry.ts` | Self-constructing tool singletons + lookup helpers |
| `room-runtime.ts` | Module-level room context — `connectRoom`/`disconnectRoom` + imperative getters |
| `room-doc-manager.ts` | Y.Doc lifecycle, providers, spatial index, deep observer, presence wiring |
| `ContextMenuController.ts` | Imperative singleton: floating-ui positioning, show/hide |
| `keyboard-manager.ts` | All keybindings: tool switches, Cmd modifiers, spacebar pan, zoom, arrow pan |
| `cursor-tracking.ts` | Last cursor world position (for paste placement) |
| `presence/presence.ts` | Awareness lifecycle, cursor send/receive, peer state (mutable Map) |
| `viewport/zoom.ts` | Smooth zoom animations (step, pinch, zoom-to-fit, reset) |
| `viewport/edge-scroll.ts` | Auto-pan near viewport edges during drags |
| `viewport/arrow-key-pan.ts` | Continuous arrow key panning with easeInQuad acceleration |

### Renderer (`renderer/`)
| File | Responsibility |
|------|----------------|
| `RenderLoop.ts` | Base canvas singleton, dirty-rect tracking (`Float64Array`), exports `invalidateWorld{,BBox,All}` |
| `OverlayRenderLoop.ts` | Overlay canvas singleton, full clear each frame, exports `invalidateOverlay` |
| `types.ts` | `FRAME_CONFIG`, Perfect Freehand options, `getSvgPathFromStroke` |
| `geometry-cache.ts` | Path2D (strokes/shapes) + ConnectorPaths cache, shapeType-aware staleness |
| `object-cache.ts` | Unified eviction: `removeObjectCaches(id, kind)`, `clearAllObjectCaches()` |
| `layers/objects.ts` | Object rendering dispatch, transform preview, fill-aware Z-order |
| `layers/selection-overlay.ts` | Selection highlights, bbox, circular handles (marquee owned by SelectTool) |
| `layers/tool-preview.ts` | Active-tool preview dispatcher |
| `layers/connector-preview.ts` | In-flight connector overlay |
| `layers/connector-render-atoms.ts` | Shared connector draw atoms (`paintConnector`, `drawAnchorDot`, dash guides) |
| `layers/shape-preview.ts` | In-flight shape draw (line/rect/ellipse/diamond/roundedRect) |
| `layers/stroke-preview.ts` | In-flight Perfect Freehand stroke |
| `layers/eraser-dim.ts` | Dim hovered objects under eraser via 'screen' blend |
| `layers/handle-stamp.ts` | Resize-handle bitmap stamp — pre-rendered offscreen, blitted (no per-frame `shadowBlur`) |
| `animation/AnimationController.ts` | Singleton animation job manager — push-based invalidation |
| `animation/CursorAnimationJob.ts` | Remote cursor animation (interpolated positions) |
| `animation/EraserTrailAnimation.ts` | Decaying eraser-stroke trail |
| `animation/cursor-bitmap.ts` | Offscreen cursor bitmap stamp |

### Tools (`tools/` — zero-arg singletons via `tool-registry.ts`)
| File | Notes |
|------|-------|
| `types.ts` | `PointerTool` interface + `PreviewData` union |
| `selection/SelectTool.ts` | Selection state machine, translate, scale, connector endpoints, code/text editing entry |
| `selection/transform.ts` | `TransformController` (scale/translate/endpoint drag), entry system, per-kind dispatch tables |
| `selection/types.ts` | Shared selection types (`TransformState`, entry/dispatch helpers) |
| `selection/selection-utils.ts` | Composition, bounds, declarative `foldField` over the field table |
| `selection/selection-actions.ts` | Mutation wrappers — each a 1-3 line `applyField`/`toggleField`/`adjustByPresets` |
| `selection/selection-field-table.ts` | `FieldDescriptor<V>` table + `foldField`/`applyField`/`toggleField`/`adjustByPresets` primitives |
| `selection/connector-topology.ts` | `buildTopology` — graph of attached connectors per selected shape |
| `DrawingTool.ts` | Pen, highlighter, shape drawing. `hold-detector.ts` (550ms) fires the $P recognizer on dwell |
| `EraserTool.ts` | Geometry-aware hit testing + deletion |
| `TextTool.ts` | WYSIWYG rich text + sticky notes, Tiptap DOM overlay (`core/text/`) |
| `PanTool.ts` | Viewport panning (dedicated + MMB + spacebar) |
| `ConnectorTool.ts` | Elbow + straight connectors + snapping (`core/connectors/`) |
| `CodeTool.ts` | Code blocks, CodeMirror overlay (`core/code/`) |

### Core (`core/`)
| File | Responsibility |
|------|----------------|
| `accessors.ts` | Typed Y.Map accessors (per-field + per-kind bulk `getXxxProps`) |
| `types/objects.ts` | `ObjectKind`, `ObjectHandle`, `IndexEntry`, prop types, `BindableKind`/`BINDABLE_KINDS`/`isBindable*` |
| `types/geometry.ts` | `BBoxTuple`, `FrameTuple`, `WorldBounds`, `Frame` + converters |
| `types/handles.ts` | `HandleId` taxonomy (corner/side), type guards, `scaleOrigin`, `handleCursor` |
| `index.ts` | Type re-export barrel |
| `geometry/bbox.ts` | `computeBBoxFor(id, kind, yMap)` — unified per-kind dispatch; `computeConnectorBBoxFromPoints{,Into}` |
| `geometry/bounds.ts` | BBox/frame tuple helpers, WorldBounds ops, mutating offset primitives (`offset*`, `copy*`, `*Mut`) |
| `geometry/frame-of.ts` | `frameOf(handle)` — mapped dispatch to per-subsystem frame getter for any bindable kind |
| `geometry/shape-path.ts` | Build Path2D from frame tuple |
| `geometry/scale-system.ts` | Pure math atoms: `uniformFactor`, `preservePosition`, `edgePinPosition1D`, `computeReflowWidth` |
| `geometry/hit-primitives.ts` | Pure tuple-first hit math: point/segment/polyline/shape/rect/circle atoms |
| `geometry/recognizer/` | $P/$Q shape recognizer — 550ms-hold match. Entry: `recognize.ts`, `hold-detector.ts`. See CLAUDE.md |
| `spatial/` | Hit testing + region queries. Entry: `object-query.ts` (picker facade), `handle-hit.ts`. See CLAUDE.md |
| `connectors/` | Elbow A* + straight routing, snap. Entry: `connector-router.ts`, `snap.ts`, `reroute-connector.ts`, `anchor-atoms.ts`, `connector-paths.ts`, `constants.ts`. See CLAUDE.md |
| `text/` | Layout engine + three-tier cache + sticky notes. Entry: `text-system.ts`, `sticky-note.ts`, `font-config.ts`, `font-loader.ts`. See CLAUDE.md |
| `code/` | Two-tier tokenization + CodeMirror + canvas renderer. Entry: `code-system.ts`, `code-tokens.ts`, `lezer-worker.ts`, `code-theme.ts`. See CLAUDE.md |
| `image/` | Offline-first pipeline + 2 web workers. Entry: `image-manager.ts`, `image-actions.ts`, `image-worker.ts`. See CLAUDE.md |
| `bookmark/` | URL unfurl + OG metadata. Entry: `bookmark-render.ts`, `bookmark-actions.ts`, `bookmark-unfurl.ts`, `bookmark-placeholder.ts`. See CLAUDE.md |
| `clipboard/` | Nonce-based clipboard + serializer. Entry: `clipboard-actions.ts`, `clipboard-serializer.ts`. See CLAUDE.md |

### Stores
| File | Responsibility |
|------|----------------|
| `camera-store.ts` | Camera state, coordinate transforms, canvas element, pointer capture, per-room persistence |
| `device-ui-store.ts` | Toolbar state, drawing settings, user identity, cursor management (persisted) |
| `selection-store.ts` | Selection state, transform state |
| `presence-store.ts` | Peer identities + count (Zustand, for React components only) |

### Utils + Shared
| File | Responsibility |
|------|----------------|
| `utils/math.ts` | `clamp`, `clamp01`, `hypot2` — branchless inline forms |
| `utils/dispose.ts` | `dispose<T>(value, fn): null` — single-line teardown chain |
| `utils/color.ts` | `createFillFromStroke(stroke, mixRatio)` |
| `utils/generate-user-profile.ts` | Random adjective+animal name + color palette |
| `packages/shared/src/types/identifiers.ts` | `RoomId`, `UserId`, `StrokeId`, `TextId` |
| `packages/shared/src/utils/ulid.ts` | `ulid()` |
| `packages/shared/src/utils/url-utils.ts` | `normalizeUrl`, `isValidHttpUrl`, `extractDomain` |
| `packages/shared/src/utils/image-validation.ts` | `validateImage`, `isSvg`, `parseImageDimensions` |

### Server (`worker/src/`)
| File | Responsibility |
|------|----------------|
| `index.ts` | Hono app: CORS, asset routes, unfurl route, `partyserverMiddleware()` for Yjs sync |
| `assets.ts` | `PUT/GET /api/assets/:key` — R2 store + edge-cached proxy |
| `unfurl.ts` | `GET /api/unfurl?url=` — HTMLRewriter OG extraction, image→R2, SSRF guard, edge cache 7d |
| `parties/room.ts` | `RoomDurableObject` — hibernate-aware, debounced V2 snapshot to R2 |

### Routes + UI
`routes/__root.tsx`, `routes/index.tsx`, `routes/room.$roomId.tsx` (calls `connectRoom` in `beforeLoad`).
`components/Canvas.tsx` (thin React wrapper), `RoomPage.tsx`, `TopBar.tsx`, `ToolPanel.tsx`, `ZoomControls.tsx`, `UserAvatarCluster.tsx`, `Toast.tsx`, `ErrorBoundary.tsx`, `icons/`, `context-menu/` (own CLAUDE.md).
Service Worker: `sw.ts` (cache-first `/api/assets/*`, app shell).

---

## Architecture Overview

```
Route beforeLoad         → connectRoom(roomId)   → room-runtime.ts
RoomPage cleanup effect  → disconnectRoom(roomId)

Canvas.tsx (thin React wrapper — mounts DOM, creates runtime)
  └── new CanvasRuntime().start({ container, baseCanvas, overlayCanvas, editorHost })

CanvasRuntime (the brain)
  ├── SurfaceManager   — DOM refs + resize/DPR + deferred canvas resize
  ├── renderLoop       — base canvas, dirty-rect optimized (native rAF)
  ├── overlayLoop      — preview + presence + animation jobs, full clear each frame
  ├── InputManager     — pointer + keyboard + modifier state
  ├── camera subscription → tool.onViewChange() (guarded by isEdgeScrolling)
  └── pointer dispatch → spacebar/MMB pan check → tool.begin/move/end

tool-registry.ts (self-constructing singletons)
  pen/highlighter/shape → drawingTool   text/note → textTool
  eraser, select, pan, connector, code → respective singletons
  image → one-shot file picker (no persistent tool)
```

### Data flow

```
Y.Doc (source of truth)
   ↓ observers (Y.Map.observeDeep)
RoomDocManager.applyObjectChanges()
   ├─ computeBBoxFor(id, kind, yMap)
   ├─ evictGeometry(id) + per-kind layout cache evict
   └─ invalidateWorldBBox(bbox)      [base canvas]
         ↓
   RenderLoop (dirty-rect base)
   OverlayRenderLoop (full-clear overlay)
         ↑
   camera-store (scale, pan, viewport) — self-subscribed
```

### Write path

```
Tool.begin/move/end()              → user gesture
  → tool.commit() via transact(()=> getObjects().set(...))
  → ydoc.transact(fn, userId)
  → deep observer fires applyObjectChanges()
  → handle upsert + cache evict + invalidateWorldBBox()
```

### Event flow

```
Pointer event → InputManager → CanvasRuntime
  ├─ screenToWorld(clientX, clientY)
  ├─ updatePresenceCursor()
  ├─ updateEdgeScroll() (auto-pan near edges)
  └─ getCurrentTool().begin/move/end(worldX, worldY)
       ↓
  Tool updates internal state
    ├─ invalidateOverlay()      preview changed
    └─ invalidateWorldBBox()    geometry changed
```

---

## Routing (TanStack Router)

File-based with auto code splitting. Three routes; auto-generated `routeTree.gen.ts`.
- `beforeLoad` calls `connectRoom(roomId)` — creates Y.Doc, starts providers, restores camera (not code-split — runs while component chunk downloads)
- `RoomPage` cleanup effect calls `disconnectRoom(roomId)` on unmount
- `key={roomId}` on `RoomCanvas` forces full remount on room switch
- `getRouteApi('/room/$roomId').useParams()` for `roomId` in components

---

## PointerTool Interface

All tools implement `PointerTool` (`tools/types.ts`): `canBegin`, `begin(pointerId, worldX, worldY)`, `move` (also hover), `end`, `cancel`, `isActive`, `getPointerId`, `getPreview` → overlay rendering, `onPointerLeave`, `onViewChange`, `destroy`. Zero-arg constructors — dependencies read from stores at runtime (settings frozen at `begin()`).

---

## Room Runtime (`runtime/room-runtime.ts`)

Module-level room context. `connectRoom(roomId)` from route `beforeLoad`, `disconnectRoom(roomId)` from RoomPage cleanup. Fail-fast (throws if no room).

**Key exports:** `connectRoom`/`disconnectRoom`/`hasActiveRoom`, `getHandle(id)`/`getHandleKind(id)`/`getBbox(id)`/`getObjectsById()`/`getSpatialIndex()`/`getObjects()`, `transact<T>(fn): T | undefined`/`undo()`/`redo()`. Re-exports from `connector-router`: `getConnectorRoute(id)`, `getAttachedConnectors(shapeId)`, `detachConnectorFromShape`.

Prefer `getHandle(id)` over `getObjectsById().get(id)`. Prefer `transact(fn)` over `getActiveRoomDoc().mutate(fn)` — `transact` returns whatever `fn` returns, so callers can elide the `let foo; transact(()=>{ foo = ... })` dance.

---

## Invalidation — Singleton Render Loops

Module-level singletons, safe no-ops before `start()`. Tools and observers import directly.
- **RenderLoop:** `invalidateWorld(bounds)`, `invalidateWorldBBox(bbox)`, `invalidateWorldAll()`
- **OverlayRenderLoop:** `invalidateOverlay()`

---

## Y.Doc Structure (v2)

```ts
Y.Doc { guid: roomId }
└─ objects: Y.Map<Y.Map<unknown>>      // top-level, always exists — all objects by ULID

type ObjectKind = 'stroke' | 'shape' | 'text' | 'connector' | 'code' | 'image' | 'note' | 'bookmark';
```

### Schemas

All objects share `{ id (ULID), kind, ownerId, createdAt }`. **Color semantics:** `color` = stroke color (shape/stroke/connector) or text color (text); `fillColor` = background always; shapes use `labelColor` for label text. Per-kind fields:

- **Stroke** (pen/highlighter) — `{ tool: 'pen'|'highlighter', color, width, opacity, points: [number,number][] }`
- **Shape** (rect/ellipse/diamond/roundedRect) — `{ shapeType, color, width, opacity, fillColor?, frame: [x,y,w,h], content?: Y.XmlFragment, fontSize?, fontFamily?, labelColor? }`. Label fields added on first edit, removed if empty on close.
- **Text** — `{ origin: [anchorX, baseline], fontSize, fontFamily, color, align, width: 'auto'|number, fillColor?, content: Y.XmlFragment }`. Frame derived (`getTextFrame(id)`). Delta attrs: bold, italic, highlight (`{color}` or presence → `'#ffd43b'`).
- **Code** — `{ origin: [topLeftX, topLeftY], fontSize, width: number, language, content: Y.Text, lineNumbers?, title?, headerVisible?, outputVisible?, output? }`. Origin = top-left (unlike text). Frame via `getCodeFrame(id)`.
- **Connector** — `{ connectorType: 'elbow'|'straight', start: ConnectorEndpoint, end: ConnectorEndpoint, startCap, endCap, color, width }`. **No geometry stored** — endpoints are point/anchor refs; routed polyline lives in `ConnectorRouter` cache (`getConnectorRoute(id)`). Always opacity 1.
- **Note** — `{ origin: [topLeftX, topLeftY], scale, fontFamily, align, alignV, fillColor, content: Y.XmlFragment }`. No fontSize/width (derived from content + scale). Text color hardcoded `#1a1a1a`; `fillColor` per-instance, default `#FEF3AC`.
- **Image** — `{ assetId: 64-hex, frame, naturalWidth, naturalHeight, mimeType, opacity? }`. Content-addressed (same file → same `assetId`).
- **Bookmark** — `{ url, domain, origin, height, scale?, title?, description?, ogImageAssetId?, ogImageWidth?, ogImageHeight?, faviconAssetId? }`. Frame derived (`getBookmarkFrame(id)`). State implied by which optional fields are set.

### ObjectHandle (live reference)
```ts
interface ObjectHandle {
  id: string;            // ULID
  kind: ObjectKind;
  y: Y.Map<unknown>;     // LIVE reference
  bbox: BBoxTuple;       // [minX, minY, maxX, maxY] — computed locally
}
```

### Stored vs derived geometry

- **Stored in Y.Map:** shape/image `frame`, stroke `points`.
- **Derived from layout/origin/scale** (subsystem-cached, accessed via getter): text/note `getTextFrame(id)` (`core/text/text-system.ts`), code `getCodeFrame(id)` (`core/code/code-system.ts`), bookmark `getBookmarkFrame(id)` (`core/bookmark/bookmark-render.ts`).
- **Connectors are a third class.** Y.Map stores endpoint refs only (`start`/`end`: point or `StoredAnchor`); the routed polyline lives in `ConnectorRouter`'s local cache, populated by the deep observer on every relevant input change. Read via `getConnectorRoute(id)`.

All frame getters return `FrameTuple | null` (null before first layout). `computeBBoxFor(id, kind, yMap)` (`core/geometry/bbox.ts`) dispatches to the right subsystem on hydration + every observer fire.

**Global helpers** (use before reaching into a subsystem):
- `frameOf(handle)` — `core/geometry/frame-of.ts` — single dispatch over every bindable kind.
- `getHandleShapeType(handle)` — `core/accessors.ts` — `shapeType` for shapes, `'rect'` for every other bindable.
- `BINDABLE_KINDS` / `isBindableKind` / `isBindableHandle` / `isUnbindableKind` — `core/types/objects.ts`.

---

## Types & Accessors

**Geometry types** (`core/types/geometry.ts`): `BBoxTuple = [minX,minY,maxX,maxY]`, `FrameTuple = [x,y,w,h]`, `Point = [x,y]`. Object forms: `WorldBounds`, `Frame`. Converters: `tupleToFrame`, `frameToTuple`, `frameToWorldBounds`, `bboxTupleToWorldBounds`, `worldBoundsToBBoxTuple`, `worldBoundsToFrame`, `frameTupleIntersectsBounds`.

**Bounds helpers** (`core/geometry/bounds.ts`): `expandBBox`, `expandBBoxEnvelope`, `unionBBox`, `pointsToBBox{,Mut}`, `translateBBox`, `frameToBbox{,Mut}`, `bboxToFrame{,Mut}`, `copyBbox`, `copyFrame`, `bboxCenter`, `bboxSize`, `frameCenter`, `fillFrameCenter`, `unionBounds`, `expandEnvelope`, `translateBounds`, `scaleBoundsAround`, `expandBounds`, `offsetPoint`, `offsetBBox`, `offsetFrame`, `offsetPoints`, `setBBoxXYWH`, `boundsIntersect`. Most have in-place `*Mut`/`*Into` mirrors — use them on hot paths.

**Typed Y.Map accessors** (`core/accessors.ts`): prefer over raw `.get()`.
- Common: `getColor`, `getOpacity`, `getWidth`, `getFrame`, `getOrigin`, `getPoints`
- Per-kind bulk (preferred): `getStrokeProps`, `getShapeProps`, `getTextProps`, `getCodeProps`, `getNoteProps`, `getImageProps`, `getBookmarkProps`
- Connector: `getStart`, `getEnd`, `getStartCap`, `getEndCap`, `getConnectorType`, `getConnectorProps`, `getRouteInputs`
- Text/code: `getFontSize`, `getFontFamily`, `getAlign`, `getAlignV`, `getContent`, `getCodeText`, `getTextWidth`, `getLanguage`, `getHeaderVisible`, `getOutputVisible`, `getCodeOutput`
- Shape: `getShapeType`, `getHandleShapeType`, `getFillColor`, `getLabelColor`, `hasLabel`
- Image/bookmark: `getAssetId`, `getNaturalDimensions`, `getBookmarkUrl`, `getBookmarkAssetIds`
- Key types: `TextAlign`, `TextAlignV`, `TextWidth`, `FontFamily` (4 fonts), `CodeLanguage`, `StoredAnchor` (elbow/straight variants), `ConnectorCap`, `ConnectorType`

---

## RoomDocManager

Public fields (non-null from construction): `objectsById`, `spatialIndex`, `connectorRouter`. Sync constructor + async init: IDB sync → hydrate (non-connectors first, connectors second so bindable frames exist for routing) → `observeDeep` → UndoManager → WS provider (first `'sync'` → `repackSpatialIndex`).

**`applyObjectChanges`** (deep observer body) — three phases, reusing private scratch sets (`_touchedIds`/`_deletedIds`/`_bboxChangedIds`/`_dirtyBBoxes`) — zero alloc per fire:

- **A — deletions.** `spatial.remove` → `removeObjectCaches` → media unregister → push old bbox.
- **B — touched.** Connector queued for reroute → skip (defer to C). Else bbox via `computeBBoxFor` (non-connector) or `router.computeBBox` (style-only connector) → upsert handle → evict on bbox change → bindable bbox change calls `router.onBindableChanged`.
- **C — drain `router.drainRerouteQueue`.** Reroute → upsert → always evict.

Then `flushDirtyBBoxes` viewport-filters and calls `invalidateWorldBBox`.

Mutation: prefer `transact(fn)` (room-runtime) over `mutate(fn)`.

---

## Cache Architecture

- **Geometry** (`renderer/geometry-cache.ts`): Path2D (strokes/shapes) + ConnectorPaths. Auto-detects shapeType changes.
- **Layout:** `textLayoutCache` (three-tier, SOA-pooled — allocation-free reflow), `codeSystem` (two-tier tokenization + layout), `bookmarkCache` (text wrapping).
- **Connector routes** (`core/connectors/connector-router.ts`): local route cache owned by `RoomDocManager.connectorRouter`. Fresh `Point[]` per relevant input change.
- **Unified eviction:** `removeObjectCaches(id, kind)` on delete, `clearAllObjectCaches()` on room teardown.
- **Tool teardown:** Tools owning per-object DOM/state (TextTool, CodeTool) tear down on object deletion via `dispose()` chains.

---

## Rendering Pipeline

### Two-canvas architecture
- **Base canvas:** World content, dirty-rect optimized, native rAF.
- **Overlay canvas:** Full clear each invalidation — tool preview, selection UI, presence cursors, animation jobs.
- `SelectTool` renders transformed objects on the base canvas for correct Z-order during translate/scale.

### Object dispatch (`renderer/layers/objects.ts`)
Switch on `handle.kind`: stroke/shape/connector via geometry cache (Path2D / ConnectorPaths), text/note/code via layout caches, image via `getBitmap()`, bookmark via `drawBookmark()`. During scale (`renderScaleEntry`, behavior from `getScaleBehavior`): shape rebuilds frame; image bitmap at scaled frame; stroke uses cached Path2D with `ctx.scale(factor)`; text/code reflow on E/W sides else `ctx.scale(ratio)` on cached layout; note/bookmark `ctx.scale(out.scale/frozen.scale)` around `out.origin`. Edge-pin (multi-select side handle) falls back to `renderTranslatedEntry`. Details in `tools/selection/CLAUDE.md`.

Per-frame hoisting in `drawObjects`: editing IDs, hovered Open-button id, translate `dx/dy`, topology `connEntries` Map, viewport bounds — read once, used per-object. Module scratches (`_candidateIds`, `_previewScratch`) for zero alloc.

### Overlay loop animation
`AnimationController` (`renderer/animation/`) is a push-based singleton: jobs return `true` from `frame()` to request another rAF; controller calls `invalidate()` from the loop. Built-in jobs: `CursorAnimationJob` (interpolated remote cursors), `EraserTrailAnimation` (decaying trail). Registered once in `OverlayRenderLoop.start()`.

### Coordinate spaces
World (logical) → CSS pixels (browser) → Device pixels (CSS × DPR). Transforms: `worldToCanvas: (x - pan.x) * scale`, `canvasToWorld: x / scale + pan.x`.

---

## Camera Store (`stores/camera-store.ts`)

Zustand store: `scale`, `pan`, `cssWidth`, `cssHeight`, `dpr`, `roomCameras`, `currentRoomId`. Per-room camera persistence via `setRoom(roomId)` — saves outgoing, restores incoming (localStorage, 1Hz debounce — no `persist` middleware).

**Module-level functions:** `worldToCanvas`, `canvasToWorld`, `screenToWorld`, `screenToCanvas`, `worldToClient`, `getVisibleWorldBounds` (object form), `getVisibleBoundsTuple` (scratch readonly tuple — hot path), `setCanvasElement`, `getCanvasElement`, `capturePointer`, `releasePointer`, `isMobile`, `subscribeCamera`, `getViewTransform`, `createViewTransform`.

Imperative: `useCameraStore.getState()`. Reactive: `useCameraStore(selector)`. Constants: `MIN_ZOOM`, `MAX_ZOOM`.

---

## Device UI Store (`stores/device-ui-store.ts`)

Persisted Zustand store. `activeTool`, `drawingSettings` (size/color/opacity/fill), user identity (`userId`/`userName`/`userColor` — generated on first visit), per-tool defaults (text, note, shape, connector, code), `cursorOverride`.

Imperative getters: `getUserId()` (used for `ownerId`, undo tracking, presence self-filter), `getUserProfile()` → `{ userId, name, color }`, `setCursorOverride`, `applyCursor`. Constants: `TEXT_FONT_SIZE_PRESETS`, `TEXT_FONT_FAMILIES`, `TEXT_COLOR_PALETTE`, `HIGHLIGHT_COLORS`.

---

## Selection System

Detailed in `tools/selection/CLAUDE.md`: state machine, per-kind transform behavior, connector topology, hit testing (Z-order, handles, endpoints), text/code reflow, dirty rect optimization, commit paths.

**Key entry points:** `SelectTool` (state machine + commits, owns marquee state), `tools/selection/transform.ts` (TransformController, dispatch tables, owns built topology), `connector-topology.ts` (`buildTopology`), `selection-store.ts` (Zustand state), `core/spatial/object-query.ts` (picker facade shared with EraserTool/TextTool/CodeTool/snap), `core/spatial/handle-hit.ts` (resize handles + endpoint dots), `core/geometry/scale-system.ts` (pure scale math), `core/types/handles.ts` (handle taxonomy), `renderer/layers/objects.ts` (transform preview rendering), `renderer/layers/selection-overlay.ts` (highlights, handles, endpoint dots).

---

## Other Tools

**DrawingTool** — pen, highlighter, AND shape drawing. HoldDetector (550ms, `core/geometry/recognizer/hold-detector.ts`) fires $P recognizer (`core/geometry/recognizer/`) for shape snap. Click-to-place: 180wu fixed shape. Settings frozen at `begin()`.

**EraserTool** — geometry-aware hit testing, deletes all object kinds.

**TextTool** — WYSIWYG rich text with Tiptap DOM overlay + canvas rendering. Origin-based positioning, auto/fixed width, three-tier layout cache. Shape labels and sticky notes supported (note tool maps to TextTool). See `core/text/CLAUDE.md`.

**CodeTool** — code blocks with CodeMirror DOM overlay. Screen-space rendering (world × scale in px). Two-tier tokenization (sync regex + Lezer workers). Per-session UndoManager. See `core/code/CLAUDE.md`.

**PanTool** — viewport panning. Also used for MMB pan and spacebar ephemeral pan.

**ConnectorTool** — elbow A* + straight connectors with shape snapping. Ctrl suppresses snapping. See `core/connectors/CLAUDE.md`.

---

## Keyboard, Clipboard, Presence, Image, Bookmark

See subsystem CLAUDE.mds: `runtime/input/`, `core/clipboard/`, `runtime/presence/`, `core/image/`, `core/bookmark/`. Service Worker (`sw.ts`) is cache-first for `/api/assets/*` + app shell, network-first for HTML.
