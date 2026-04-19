# AVLO Codebase Guide
**Purpose:** Offline-first collaborative whiteboard with Yjs CRDT sync.
**Stack:** React/TS/Canvas + Yjs + Cloudflare Workers/R2

## Commands & Aliases
```bash
npm run dev          # Client :3000 + Worker :8787 (DON'T START WITHOUT PERMISSION)
npm run typecheck    # Type check all workspaces (RUN FROM ROOT!)
```
- `@avlo/shared` → `packages/shared/src/*`
- `@/*` → `client/src/*`

## Best Practices
- Always prefer **getters** over parameter passing — data should be accessible where needed
- Minimize object creation and parameter bloat; derive or access what already exists
- Avoid over-encapsulation; this system needs low-friction data access across modules
- Fewest lines of code while maintaining full robustness

---

## File Map

All paths relative to `client/src/` unless noted.

### Runtime System (`runtime/`)
| File | Responsibility |
|------|----------------|
| `runtime/CanvasRuntime.ts` | Central orchestrator — events, subscriptions, tool dispatch |
| `runtime/SurfaceManager.ts` | DOM refs (contexts, editorHost) + resize/DPR + deferred canvas resize |
| `runtime/InputManager.ts` | DOM event forwarder + modifier state tracking (shift/ctrl/meta) |
| `runtime/tool-registry.ts` | Self-constructing tool singletons + lookup helpers |
| `runtime/room-runtime.ts` | Module-level room context — `connectRoom()` / `disconnectRoom()` + imperative getters |
| `runtime/room-doc-manager.ts` | Y.Doc lifecycle, providers, spatial index, snapshot publishing, presence wiring |
| `runtime/ContextMenuController.ts` | Imperative singleton: floating-ui positioning, show/hide lifecycle |
| `runtime/keyboard-manager.ts` | All keybindings: tool switches, Cmd modifiers, spacebar pan, zoom, arrow pan |
| `runtime/cursor-tracking.ts` | Last cursor world position (for paste placement) |
| `runtime/presence/presence.ts` | Awareness lifecycle, cursor send/receive, peer state (mutable Map) |
| `runtime/viewport/zoom.ts` | Smooth zoom animations (step, pinch, zoom-to-fit, reset) |
| `runtime/viewport/edge-scroll.ts` | Auto-pan near viewport edges during drags |
| `runtime/viewport/arrow-key-pan.ts` | Continuous arrow key panning with easeInQuad acceleration |

### Renderer (`renderer/`)
| File | Responsibility |
|------|----------------|
| `renderer/RenderLoop.ts` | Base canvas singleton, dirty rect tracking (Float64Array), exports `invalidateWorld/BBox/All` |
| `renderer/OverlayRenderLoop.ts` | Overlay canvas singleton, full clear each frame, exports `invalidateOverlay` |
| `renderer/layers/objects.ts` | Object rendering dispatch, transform preview, fill-aware Z-order |
| `renderer/layers/selection-overlay.ts` | Selection overlay: highlights, marquee, box, circular handles |
| `renderer/geometry-cache.ts` | Path2D (strokes/shapes) + ConnectorPaths cache, shapeType-aware staleness |
| `renderer/object-cache.ts` | Unified cache dispatcher: `removeObjectCaches(id, kind)`, `clearAllObjectCaches()` |

### Tools (`tools/` — zero-arg singletons via `tool-registry.ts`)
| File | Notes |
|------|-------|
| `tools/types.ts` | PointerTool interface + PreviewData types |
| `tools/selection/SelectTool.ts` | Selection state machine, translate, scale, connector endpoints, code/text editing entry |
| `tools/selection/transform.ts` | TransformController, entry system, mapped per-kind dispatch tables |
| `tools/selection/types.ts` | Shared selection types (TransformState, entry/dispatch helpers) |
| `tools/selection/selection-utils.ts` | Selection composition, bounds, style computation |
| `tools/selection/selection-actions.ts` | Selection mutations (color, fill, width, shape, text formatting, code language/fontSize) |
| `tools/selection/connector-topology.ts` | Builds the connector topology graph (attached connectors per selected shape) |
| `tools/DrawingTool.ts` | Pen, highlighter, AND shape drawing |
| `tools/EraserTool.ts` | Geometry-aware hit testing + deletion |
| `tools/TextTool.ts` | WYSIWYG rich text + sticky notes, Tiptap DOM overlay. **Docs:** `core/text/CLAUDE.md` |
| `tools/PanTool.ts` | Viewport panning (dedicated + MMB + spacebar) |
| `tools/ConnectorTool.ts` | Elbow + straight connectors + snapping |
| `tools/CodeTool.ts` | Code blocks, CodeMirror overlay. **Docs:** `core/code/CLAUDE.md` |

### Core (`core/`)
| File | Responsibility |
|------|----------------|
| `core/accessors.ts` | Typed Y.Map accessors (getColor, getFrame, getTextProps, getCodeProps, getImageProps, getNoteProps, getBookmarkProps, etc.) |
| `core/types/geometry.ts` | `BBoxTuple`, `FrameTuple`, `WorldBounds`, `Frame` + converters |
| `core/types/objects.ts` | `ObjectKind`, `ObjectHandle`, `IndexEntry` + all prop types + `BindableKind`/`BINDABLE_KINDS`/`isBindableHandle`/`INTERIOR_PAINT` |
| `core/index.ts` | Type re-exports for convenience |
| `core/geometry/bbox.ts` | `computeBBoxFor(id, kind, yMap)` — unified per-kind dispatch |
| `core/geometry/bounds.ts` | BBox/frame tuple helpers, WorldBounds operations, mutating offset primitives |
| `core/geometry/scale-system.ts` | Pure math atoms: `uniformFactor` (handle-aware), `preservePosition`, `edgePinPosition1D`, `computeReflowWidth` (no state) |
| `core/types/handles.ts` | `HandleId` taxonomy (corner/side), type guards, `scaleOrigin`, `handleCursor` |
| `core/geometry/hit-primitives.ts` | Pure tuple-first hit math: point/segment/polyline/shape/rect/circle atoms (no handles, no Y.Map) |
| `core/geometry/frame-of.ts` | `frameOf(handle)` — mapped dispatch to the right frame getter for any bindable kind |
| `core/geometry/shape-path.ts` | Build Path2D from frame tuple |
| `core/spatial/object-spatial-index.ts` | Pure RBush wrapper; tuple-first `queryBBox(bbox)` + `queryRadius(x,y,r)` with scratch-bbox reuse |
| `core/spatial/kind-capability.ts` | Per-kind capability table: `hitPoint` (returns `Paint` class), `hitRect`, `hitCircle` + bindable flag |
| `core/spatial/object-query.ts` | Picker facade — 3 point-pickers + region-membership. Owns `Radius`, `Region`, envelope/prefilter/sort pipeline. **Only module** in `core/` that imports `getHandle`/`getSpatialIndex` from `room-runtime`. |
| `core/spatial/handle-hit.ts` | Non-spatial sibling: nearest resize-handle / connector-endpoint-dot probes (not in rbush) |
| `core/text/sticky-note.ts` | Note constants/geometry, auto-font-size pipeline (`layoutNoteContent`, `getNoteLayout`, `getNoteDerivedFontSize`), 9-slice shadow cache, `renderNoteBody` (shared w/ bookmarks), `drawStickyNote`, `computeNoteBBox`. **Docs:** `core/text/CLAUDE.md` |

### Subsystem Docs (detailed CLAUDE.md in each)
| Folder | Coverage |
|--------|----------|
| `core/connectors/` | Elbow A* + straight routing, snap, topology, reroute API |
| `core/code/` | RunSpans model, two-tier tokenization, CodeMirror, canvas renderer |
| `core/text/` | Layout engine, three-tier cache, TextCollaboration, shape labels, sticky notes |
| `core/image/` | Offline-first image pipeline, mip levels, two web workers, viewport management |
| `core/bookmark/` | URL bookmarks: unfurl pipeline, OG metadata, placeholder lifecycle |
| `core/clipboard/` | Nonce-based clipboard, serialization, internal/external paste, smart duplicate |
| `core/spatial/` | Hit testing + region queries: pipeline, kind capabilities, picker facade, non-facade consumers |
| `runtime/input/` | Keyboard shortcuts, InputManager, modifier state, zoom, edge scroll, arrow pan |
| `tools/selection/` | SelectTool state machine, transforms per-kind, hit testing, connector topology, overlay |
| `components/context-menu/` | Selection-aware toolbar: bars by kind, mutation dispatch |

### Stores
| File | Responsibility |
|------|----------------|
| `stores/camera-store.ts` | Camera state, coordinate transforms, canvas element, pointer capture, per-room persistence |
| `stores/device-ui-store.ts` | Toolbar state, drawing settings, user identity, cursor management (persisted) |
| `stores/selection-store.ts` | Selection state, transform state, connector topology (ephemeral) |
| `stores/presence-store.ts` | Peer identities + count (Zustand, for React components only) |

### Shared Package (`packages/shared/src/`) — minimal, 4 files
| File | Responsibility |
|------|----------------|
| `types/identifiers.ts` | `RoomId`, `UserId`, `StrokeId`, `TextId` |
| `utils/ulid.ts` | `ulid()` |
| `utils/url-utils.ts` | `normalizeUrl()`, `isValidHttpUrl()`, `extractDomain()` |
| `utils/image-validation.ts` | `validateImage()`, `isSvg()`, `parseImageDimensions()` |

### Service Worker & Image Pipeline
| File | Responsibility |
|------|----------------|
| `sw.ts` | Service Worker: cache-first `/api/assets/*`, app shell caching, network-first HTML |
| `core/image/image-manager.ts` | Main-thread bitmap cache, viewport-driven decode, two-worker routing |
| `core/image/image-worker.ts` | Web Worker (2 instances): decode, ingest, upload queue, bookmark unfurl |
| `core/image/image-actions.ts` | `createImageFromBlob()`, `openImageFilePicker()`, SVG rasterization |

### Server (`worker/src/`)
| File | Responsibility |
|------|----------------|
| `index.ts` | Hono app: CORS, asset routes, unfurl route, `partyserverMiddleware()` for Yjs sync |
| `assets.ts` | `PUT /api/assets/:key` (validate + R2 store), `GET /api/assets/:key` (edge-cached R2 proxy) |
| `unfurl.ts` | `GET /api/unfurl?url=` — HTMLRewriter OG extraction, image→R2, SSRF guard, edge cache 7d |

### Routes (`routes/`)
`__root.tsx` (root layout, `<Outlet />`), `index.tsx` (redirect → `/room/dev`), `room.$roomId.tsx` (room route, `beforeLoad: connectRoom`)

### UI (`components/`)
`Canvas.tsx` (thin React wrapper — mounts DOM, creates runtime), `RoomPage.tsx` (main view, layout), `TopBar.tsx` (logo, board name, settings), `ToolPanel.tsx` (toolbar + inspector), `ZoomControls.tsx`, `UserAvatarCluster.tsx` (presence avatars), `Toast.tsx`, `ErrorBoundary.tsx`, `icons/index.tsx`

---

## Architecture Overview

### System Hierarchy
```
Route beforeLoad           → connectRoom(roomId) → room-runtime.ts
RoomPage cleanup effect    → disconnectRoom(roomId)

Canvas.tsx (~100 lines) - THIN REACT WRAPPER
│   Only does: mount DOM, create runtime
│
└── new CanvasRuntime().start({ container, baseCanvas, overlayCanvas, editorHost })
                │
                ▼
 CanvasRuntime.ts - THE BRAIN
│   Owns all subsystems, handles events, manages subscriptions
│
├── SurfaceManager        - DOM refs + resize/DPR + deferred canvas resize
│   ├── baseCtx, overlayCtx (module-level getters)
│   ├── editorHost (module-level getter)
│   └── setCanvasElement() → camera-store
│
├── renderLoop (singleton) - base canvas 60fps, inline dirty rect optimization
├── overlayLoop (singleton) - preview + presence, full clear each frame
├── InputManager          - DOM event + keyboard forwarder + modifier state
│
├── Subscriptions:
│   ├── camera-store      → tool.onViewChange() on pan/zoom (guarded by isEdgeScrolling)
│   └── snapshot          → overlay invalidation
│
└── Event Handlers:
    ├── handlePointerDown → spacebar pan check → tool dispatch / MMB pan
    ├── handlePointerMove → cursor tracking + edge scroll update + tool.move()
    ├── handlePointerUp   → tool.end() + stop edge scroll
    ├── handleWheel       → zoom (with velocity boost + Ctrl pinch)
    └── handlePointerLeave → clear presence, tool.onPointerLeave()

                │
                ▼
tool-registry.ts - SELF-CONSTRUCTING SINGLETONS
│   pen/highlighter/shape → drawingTool (same instance)
│   eraser → eraserTool, text/note → textTool, pan → panTool
│   select → selectTool, connector → connectorTool, code → codeTool
│   image → one-shot file picker (no persistent tool)
│
│   Exports: getCurrentTool(), getToolById(), getActivePreview()
│            canStartMMBPan(), panTool, textTool, codeTool

                │
                ▼
Module Registries - IMPERATIVE ACCESS
├── room-runtime.ts       → getHandle(id), getObjectsById(), getSpatialIndex(), transact(fn), undo/redo
├── camera-store.ts       → worldToCanvas/screenToWorld, getVisibleWorldBounds(), setRoom(roomId)
├── device-ui-store.ts    → activeTool, drawingSettings, getUserId(), getUserProfile(), cursor management
├── SurfaceManager.ts     → getBaseContext(), getOverlayContext(), getEditorHost()
├── RenderLoop.ts         → invalidateWorld(bounds), invalidateWorldBBox(bbox), invalidateWorldAll()
└── OverlayRenderLoop.ts  → invalidateOverlay()
```

### Data Flow
```
Y.Doc (source of truth)
   ↓ observers
RoomDocManager
   └─ applyObjectChanges() → evictGeometry(id) + invalidateWorldBBox(bbox)  [base canvas]
         ↓
   RenderLoop (base canvas, dirty-rect optimized)
   OverlayRenderLoop (preview + presence, full clear)
         ↑
   Camera Store (scale, pan, viewport) - self-subscribed
```

### Data Access
Canonical imperative getters live in `runtime/room-runtime.ts`: `getObjectsById()`, `getSpatialIndex()`, `getHandle(id)`, `getBbox(id)`. RoomDocManager's deep observer publishes per-object geometry changes directly via `evictGeometry` + `invalidateWorldBBox` — there is no top-level snapshot object or `subscribeSnapshot` channel.

### Write Path
```
Tool.begin/move/end() → user gesture
   → tool.commit() → transact(() => { getObjects().set(...) })
   → ydoc.transact() → Y.Map.set()
   → Deep observer → applyObjectChanges() → evictGeometry(id) + invalidateWorldBBox()
```

### Event Flow
```
User pointer event → InputManager → CanvasRuntime
   ├─ screenToWorld(clientX, clientY) → world coords
   ├─ updatePresenceCursor() → presence module
   ├─ updateEdgeScroll() → auto-pan near viewport edges
   └─ getCurrentTool().begin/move/end(worldX, worldY)
         ↓
Tool updates internal state
   ├─ invalidateOverlay() → preview changed
   └─ invalidateWorld(bounds) → geometry changed
```

---

## Routing (TanStack Router)

File-based routing with auto code splitting. Three route files in `routes/`, auto-generated `routeTree.gen.ts`.
- `beforeLoad` calls `connectRoom(roomId)` — creates Y.Doc, starts providers, restores camera (not code-split — runs while component chunk downloads)
- `RoomPage` cleanup effect calls `disconnectRoom(roomId)` on unmount
- `key={roomId}` on Canvas forces full remount on room switch
- Components access `roomId` via `getRouteApi('/room/$roomId').useParams()`

---

## PointerTool Interface

All tools implement `PointerTool` (`tools/types.ts`): `canBegin`, `begin(pointerId, worldX, worldY)`, `move` (also hover), `end`, `cancel`, `isActive`, `getPointerId`, `getPreview` → overlay rendering, `onPointerLeave`, `onViewChange`, `destroy`. Zero-arg constructors — dependencies read from stores at runtime (settings frozen at `begin()`).

---

## Room Runtime (`runtime/room-runtime.ts`)

Module-level room context. `connectRoom(roomId)` from route `beforeLoad`, `disconnectRoom(roomId)` from RoomPage cleanup. Fail-fast (throws if no room).

Key exports: `connectRoom`/`disconnectRoom`/`hasActiveRoom`, `getHandle(id)`/`getHandleKind(id)`/`getBbox(id)`/`getObjectsById()`/`getSpatialIndex()`/`getObjects()`, `transact(fn)`/`undo()`/`redo()`, `getConnectorsForShape(shapeId)`.

Prefer `getHandle(id)` over `getObjectsById().get(id)` and `transact(fn)` over `getActiveRoomDoc().mutate(fn)`.

---

## Invalidation — Singleton Render Loops

Module-level singletons, safe no-ops before `start()`. Tools and observers import directly.
- **RenderLoop:** `invalidateWorld(bounds)`, `invalidateWorldBBox(bbox)`, `invalidateWorldAll()`
- **OverlayRenderLoop:** `invalidateOverlay()`

---

## Y.Doc Structure (v2)

```typescript
Y.Doc { guid: roomId }
└─ objects: Y.Map<Y.Map<any>>       // Top-level, always exists — all objects by ULID
```

### Object Kinds
```typescript
type ObjectKind = 'stroke' | 'shape' | 'text' | 'connector' | 'code' | 'image' | 'note' | 'bookmark';
```

### Object Schemas

**Stroke** (pen/highlighter):
```typescript
{ id, kind: 'stroke', tool: 'pen'|'highlighter', color, width, opacity,
  points: [number, number][], ownerId, createdAt }
```

**Shape** (rect/ellipse/diamond/roundedRect):
```typescript
{ id, kind: 'shape', shapeType, color, width, opacity, fillColor?,
  frame: [x, y, w, h],
  // Optional label fields (added on first edit, removed if empty on close):
  content?: Y.XmlFragment, fontSize?: number, fontFamily?: FontFamily, labelColor?: string,
  ownerId, createdAt }
```

**Text** (origin-based positioning, rich text via Y.XmlFragment):
```typescript
{ id, kind: 'text', origin: [anchorX, baseline], fontSize, fontFamily, color,
  align: 'left'|'center'|'right',
  width: 'auto' | number,       // 'auto' = max-content, number = fixed wrapping width
  fillColor?,                    // Optional background fill
  content: Y.XmlFragment, ownerId, createdAt }
// No stored frame. Derived via computeTextBBox(), read via getTextFrame(id) from text-system.ts.
// Origin: origin[0] = alignment anchor, origin[1] = first line baseline.
// Delta attributes: bold, italic, highlight (multicolor: { color: '#hex' } or presence → '#ffd43b')
```

**Code** (origin-based positioning, Y.Text content, CodeMirror editing):
```typescript
{ id, kind: 'code', origin: [topLeftX, topLeftY], fontSize, width: number,
  language: 'javascript' | 'typescript' | 'python',
  content: Y.Text, ownerId, createdAt }
// No stored frame. Derived via computeCodeBBox(), read via getCodeFrame(id) from code-system.ts.
// Origin = top-left corner (unlike text's anchor+baseline). Width always number (no 'auto').
```

**Connector** (elbow A* routing or straight point-to-point):
```typescript
{ id, kind: 'connector',
  points: [number, number][],  // Full routed path (ready to render)
  start: [number, number], end: [number, number],
  startAnchor?: { id, side: Dir, anchor: [0-1, 0-1] },  // Shape anchoring
  endAnchor?: { id, side: Dir, anchor: [0-1, 0-1] },
  connectorType?: 'straight',  // Only stored when not 'elbow' (default)
  startCap, endCap: 'none'|'arrow',
  color, width, ownerId, createdAt }
// Connectors always render at opacity 1 — no opacity field stored.
```
Detailed connector docs in `core/connectors/CLAUDE.md`.

**Note** (sticky note, auto-sizing text via TextTool):
```typescript
{ id, kind: 'note', origin: [topLeftX, topLeftY], scale: number,
  fontFamily, align, alignV: 'top'|'center'|'bottom',
  fillColor: string,             // Default '#FEF3AC'
  content: Y.XmlFragment, ownerId, createdAt }
// No fontSize (auto-derived from content + scale), no width (= NOTE_WIDTH × scale).
// No color (hardcoded '#1a1a1a'). Origin always top-left (not shifted by alignment).
```
Detailed note docs in `core/text/CLAUDE.md`.

**Image** (content-addressed, offline-first):
```typescript
{ id, kind: 'image', assetId: string,    // SHA-256 hex (64 chars)
  frame: [x, y, w, h],
  naturalWidth: number, naturalHeight: number, mimeType: string,
  opacity?: number, ownerId, createdAt }
// Default 400wu wide, aspect-ratio-preserving height. Content-addressed: same file = same assetId.
```
Detailed image docs in `core/image/CLAUDE.md`.

**Bookmark** (URL card with OG metadata):
```typescript
{ id, kind: 'bookmark', url: string, domain: string,
  origin: [x, y],                        // Top-left position
  height: number,                        // Card height at base scale
  scale?: number,                        // Uniform scale (default 1)
  title?: string, description?: string,   // Set by unfurl worker
  ogImageAssetId?: string, ogImageWidth?: number, ogImageHeight?: number,
  faviconAssetId?: string, ownerId, createdAt }
// No stored frame. Derived: [origin[0], origin[1], 300*scale, height*scale].
// No unfurlStatus field — state determined by which optional fields are present.
// Offline/failed unfurls create text objects instead (never enter bookmark pipeline).
```
Detailed bookmark docs in `core/bookmark/CLAUDE.md`.

### ObjectHandle (Live Reference)
```typescript
interface ObjectHandle {
  id: string;              // ULID
  kind: ObjectKind;
  y: Y.Map<unknown>;      // LIVE Y.Map reference
  bbox: BBoxTuple;         // [minX, minY, maxX, maxY]
}
```

### Stored vs Derived Geometry

Shape, image, stroke, connector store geometry directly in Y.Doc (`frame`, `points`). Text, code, note, bookmark derive frames from layout/origin/scale — not stored. Each subsystem caches its computed frame and exposes a getter:

| Kind | Frame Getter | Source Module |
|------|-------------|---------------|
| text | `getTextFrame(id)` | `core/text/text-system.ts` |
| code | `getCodeFrame(id)` | `core/code/code-system.ts` |
| note | `getTextFrame(id)` (shared with text) | `core/text/text-system.ts` |
| bookmark | `getBookmarkFrame(id)` | `core/bookmark/bookmark-render.ts` |

All return `FrameTuple | null` (`null` before first layout). `computeBBoxFor(id, kind, yMap)` dispatches to the correct subsystem's `computeXxxBBox()` — called by RoomDocManager on hydration and Y.Doc changes. Frame getters are used by hit testing, selection bounds, connectors, and overlay rendering.

**Global helpers** (prefer over inline dispatch):
- `frameOf(handle)` from `@/core/geometry/frame-of` — resolves the frame of any bindable handle via mapped dispatch. Returns `null` for unbindable kinds or unhydrated frames.
- `getHandleShapeType(handle)` from `@/core/accessors` — returns `shapeType` for shape handles, `'rect'` for every other bindable kind.
- `BINDABLE_KINDS` / `isBindableKind` / `isBindableHandle` / `INTERIOR_PAINT` from `@/core/types/objects` — the canonical set of connectable kinds and their interior-paint flags (used by snap pre-filter and the per-kind `hitPoint` cap).

---

## Types & Accessors

### Geometry Types (`@/core/types/geometry`)
Tuple forms for storage: `BBoxTuple = [minX, minY, maxX, maxY]`, `FrameTuple = [x, y, w, h]`. Object forms for logic: `WorldBounds { minX, minY, maxX, maxY }`, `Frame { x, y, w, h }`. Converters: `tupleToFrame`, `frameToTuple`, `frameToWorldBounds`, `bboxTupleToWorldBounds`, `worldBoundsToBBoxTuple`, `worldBoundsToFrame`.

### Typed Y.Map Accessors (`@/core/accessors`)
Prefer typed accessors over raw `.get()`. Pattern: `getXxxProps(y) → XxxProps | null` bulk accessor per kind, plus individual field accessors.
- **Common:** `getColor`, `getOpacity`, `getWidth`, `getFrame` (shape/image — stored), `getOrigin` (text/code/note/bookmark), `getPoints`
- **Per-kind bulk (preferred):** `getStrokeProps`, `getShapeProps`, `getTextProps`, `getCodeProps`, `getNoteProps`, `getImageProps`, `getBookmarkProps`
- **Text/code fields:** `getFontSize`, `getFontFamily`, `getAlign`, `getContent` (Y.XmlFragment), `getCodeText` (Y.Text), `getTextWidth` (`'auto' | number`)
- **Connector:** `getStart`, `getEnd`, `getStartAnchor`, `getEndAnchor`, `getStartCap`, `getEndCap`, `getConnectorType`
- **Key types:** `TextAlign`, `TextAlignV`, `TextWidth`, `FontFamily` (4 fonts), `CodeLanguage` (js/ts/python), `StoredAnchor`

---

## RoomDocManager

Synchronous constructor, async init (fire-and-forget). `objectsById` and `spatialIndex` are public fields, non-null from construction.

**Init:** IDB sync (1s timeout) → hydrate objects + `bulkLoad` spatial index → setup deep observer (AFTER hydrate) → attach UndoManager → init WS provider + presence. WS first sync triggers `repackSpatialIndex()` for optimal packing.

**Key methods:** `mutate(fn)` (prefer `transact()` from room-runtime), `undo()`/`redo()`.

**Deep observer:** `observeDeep()` on objects Y.Map → `computeBBoxFor(id, kind, yMap)` + `evictGeometry(id)` + kind-specific cache invalidation (text layout, code tokens, bookmark layout) + `invalidateWorldBBox(bbox)`. Connector lookup updated on topology changes. Deletions → `removeObjectCaches(id, kind)`.

---

## Cache Architecture

- **Geometry:** `renderer/geometry-cache.ts` — Path2D (strokes/shapes) + ConnectorPaths. Auto-detects shapeType changes.
- **Layout:** `textLayoutCache` (three-tier), `codeSystem` (two-tier tokenization + layout), `bookmarkCache` (text wrapping)
- **Unified eviction:** `removeObjectCaches(id, kind)` on delete, `clearAllObjectCaches()` on room teardown

---

## Rendering Pipeline

### Two-Canvas Architecture
- **Base Canvas:** World content, dirty-rect optimized, (NATIVE RAF NOW)
- **Overlay Canvas:** Full clear each frame invalidation — preview, presence, selection UI
- SelectTool renders transformed objects on base canvas for correct Z-order

### RenderLoop (singleton: `renderLoop`)
Module-level singleton, started/stopped by CanvasRuntime. Dirty-rect optimized with automatic full-clear promotion.

### Object Rendering Dispatch (`objects.ts`)
Switch on `handle.kind`: stroke/shape/connector use geometry cache (Path2D/ConnectorPaths), text/note/code use layout caches, image uses `getBitmap()`, bookmark uses `drawBookmark()`. During scale transforms: code/text/note get scaled/reflowed previews, images uniform-scale only, bookmarks translate only.

### Coordinate Spaces
World (logical) → CSS pixels (browser) → Device pixels (CSS × DPR). Transforms: `worldToCanvas: (x - pan.x) * scale`, `canvasToWorld: x / scale + pan.x`.

---

## Camera Store (`camera-store.ts`)

Zustand store: `scale`, `pan`, `cssWidth`, `cssHeight`, `dpr`. Per-room camera persistence via `setRoom(roomId)` (saves outgoing → restores incoming, localStorage-backed).

Module-level functions: `worldToCanvas`, `canvasToWorld`, `screenToWorld`, `screenToCanvas`, `worldToClient`, `getVisibleWorldBounds` (object form), `getVisibleBoundsTuple` (scratch-tuple form — readonly, hot path), `setCanvasElement`, `capturePointer`, `releasePointer`. Imperative: `useCameraStore.getState()`. Reactive: `useCameraStore(selector)`.

---

## Device UI Store

Persisted Zustand store: `activeTool`, `drawingSettings` (size/color/opacity/fill), user identity (`userId`/`userName`/`userColor` — generated on first visit), per-tool defaults (text, note, shape, connector, code settings), `cursorOverride`.

Imperative getters: `getUserId()` (used by tools for `ownerId`, undo tracking, presence self-filter), `getUserProfile()` → `{ userId, name, color }` (awareness wire format).


---

## Selection System

Detailed docs in `tools/selection/CLAUDE.md`. Covers state machine, per-kind transform behavior, connector topology, hit testing (Z-order, handles, endpoints), text/code reflow, dirty rect optimization, and commit paths.

**Key files:** `SelectTool.ts` (state machine + commits), `tools/selection/transform.ts` (TransformController, entry system, dispatch tables), `selection-store.ts` (Zustand store + topology builder), `selection-utils.ts` (composition, bounds, styles), `selection-actions.ts` (context menu mutations), `core/spatial/object-query.ts` (picker facade shared with EraserTool/TextTool/CodeTool/snap), `core/spatial/handle-hit.ts` (resize handles + endpoint dots), `core/geometry/scale-system.ts` (pure scale math), `core/types/handles.ts` (handle taxonomy), `renderer/layers/objects.ts` (transform preview rendering), `renderer/layers/selection-overlay.ts` (highlights, handles, endpoint dots).

---

## Other Tools

### DrawingTool
Handles pen, highlighter, AND shape drawing. HoldDetector (600ms) for shape recognition. Click-to-place: 180wu fixed shape. Settings frozen at `begin()`.

### EraserTool
Geometry-aware hit testing, deletes all object kinds.

### TextTool
WYSIWYG rich text with Tiptap DOM overlay + canvas rendering. Origin-based positioning, auto/fixed width, three-tier layout cache. Shape labels and sticky notes supported (note tool maps to TextTool). **Details:** `core/text/CLAUDE.md`

### CodeTool
Code blocks with CodeMirror DOM overlay. Screen-space rendering (world × scale in px). Two-tier tokenization (sync regex + Lezer workers). Per-session UndoManager. **Details:** `core/code/CLAUDE.md`

### PanTool
Viewport panning. Also used for MMB pan and spacebar ephemeral pan.

### ConnectorTool
Elbow A* + straight connectors with shape snapping. Ctrl suppresses snapping. **Details:** `core/connectors/CLAUDE.md`

---

## Keyboard, Clipboard & Viewport

Detailed docs: `runtime/input/CLAUDE.md`, `core/clipboard/CLAUDE.md`.

---

## Presence System

Detailed docs in `runtime/presence/CLAUDE.md`. Three-layer split: network (`presence.ts`), identity store (`presence-store.ts`), rendering (`CursorAnimationJob`). Wired via `RoomDocManager` → `attach(provider)`/`detach()`, cursor updates from `CanvasRuntime`.

---

## Image & Bookmark Systems

Detailed docs in `core/image/CLAUDE.md` and `core/bookmark/CLAUDE.md`.

**Images:** Offline-first, content-addressed R2 storage, two web workers, viewport-driven decode/eviction. All network I/O in workers.

**Bookmarks:** Paste URL → placeholder → worker unfurl → Y.Doc write. Offline/failed → text fallback.

**Service Worker (`sw.ts`):** Cache-first `/api/assets/*` + app shell. Network-first HTML.

---

