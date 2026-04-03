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

### Canvas System
| File | Responsibility |
|------|----------------|
| `canvas/Canvas.tsx` | Thin React wrapper — mounts DOM, creates runtime |
| `canvas/CanvasRuntime.ts` | Central orchestrator — events, subscriptions, tool dispatch, edge scroll |
| `canvas/SurfaceManager.ts` | DOM refs (contexts, editorHost) + resize/DPR + deferred canvas resize |
| `canvas/InputManager.ts` | DOM event forwarder (pointer events → canvas, wheel → container for overlay passthrough) |
| `canvas/tool-registry.ts` | Self-constructing tool singletons + lookup helpers |
| `canvas/room-runtime.ts` | Module-level room context — `connectRoom()` / `disconnectRoom()` + imperative getters |
| `canvas/invalidation-helpers.ts` | Setter/getter pattern for render loop invalidation |
| `canvas/ContextMenuController.ts` | Imperative singleton: floating-ui positioning, show/hide lifecycle |
| `canvas/keyboard-manager.ts` | All keybindings: tool switches, Cmd modifiers, spacebar pan, zoom, arrow pan |
| `canvas/cursor-tracking.ts` | Last cursor world position + pointer modifier state (shift/ctrl) |
| `canvas/edge-scroll.ts` | Auto-pan near viewport edges during select/connector/shape drags |
| `canvas/arrow-key-pan.ts` | Continuous arrow key panning with easeInQuad acceleration |

### Core Files
| File | Responsibility |
|------|----------------|
| `lib/room-doc-manager.ts` | Y.Doc lifecycle, providers, spatial index, snapshot publishing |
| `renderer/RenderLoop.ts` | Base canvas 60 FPS, inline dirty rect tracking (Float64Array buffer), FPS throttling |
| `renderer/OverlayRenderLoop.ts` | Preview + presence rendering, full clear each frame |
| `renderer/layers/objects.ts` | Object rendering dispatch, transform preview, fill-aware Z-order |
| `renderer/layers/selection-overlay.ts` | Selection overlay: highlights, marquee, box, circular handles |
| `renderer/object-cache.ts` | Geometry cache (Path2D or ConnectorPaths) by object ID |
| `lib/utils/shape-path.ts` | Build Path2D from frame tuple (rect, ellipse, diamond, roundedRect) |
| `lib/utils/selection-utils.ts` | Selection composition, bounds, style computation |
| `lib/utils/selection-actions.ts` | Selection mutations (color, fill, width, shape, text formatting, code language/fontSize) |

### Tools (zero-arg singletons via `tool-registry.ts`)
| File | Notes |
|------|-------|
| `lib/tools/types.ts` | PointerTool interface + PreviewData types |
| `lib/tools/SelectTool.ts` | Selection, translate, scale, connector endpoints, code/text editing entry |
| `lib/tools/DrawingTool.ts` | Pen, highlighter, AND shape drawing |
| `lib/tools/EraserTool.ts` | Geometry-aware hit testing + deletion |
| `lib/tools/TextTool.ts` | WYSIWYG rich text + sticky notes, Tiptap DOM overlay. **Docs:** `lib/text/CLAUDE.md` |
| `lib/tools/PanTool.ts` | Viewport panning (dedicated + MMB + spacebar) |
| `lib/tools/ConnectorTool.ts` | Elbow + straight connectors + snapping |
| `lib/tools/CodeTool.ts` | Code blocks, CodeMirror overlay. **Docs:** `lib/code/CLAUDE.md` |

### Subsystem Docs (detailed CLAUDE.md in each)
| Folder | Coverage |
|--------|----------|
| `lib/connectors/` | Elbow A* + straight routing, snap, topology, reroute API |
| `lib/code/` | RunSpans model, two-tier tokenization, CodeMirror, canvas renderer |
| `lib/text/` | Layout engine, three-tier cache, TextCollaboration, shape labels, sticky notes |
| `lib/image/` | Offline-first image pipeline, mip levels, two web workers, viewport management |
| `lib/bookmark/` | URL bookmarks: unfurl pipeline, OG metadata, placeholder lifecycle |
| `components/context-menu/` | Selection-aware toolbar: bars by kind, mutation dispatch |

### Clipboard
| File | Responsibility |
|------|----------------|
| `lib/clipboard/clipboard-serializer.ts` | Serialize/deserialize Y.Map objects + Y.XmlFragment to JSON |
| `lib/clipboard/clipboard-actions.ts` | Copy, paste (internal/external + rich text + images + URL→bookmark), cut, duplicate, selectAll |

Full keyboard/clipboard changelog: `docs/CLIPBOARD_KEYBOARD_CHANGELOG.md`

### Stores
| File | Responsibility |
|------|----------------|
| `stores/camera-store.ts` | Camera state, coordinate transforms, canvas element, pointer capture |
| `stores/device-ui-store.ts` | Toolbar state, drawing settings, cursor management (persisted) |
| `stores/selection-store.ts` | Selection state, transform state, connector topology (ephemeral) |

### Geometry (`lib/geometry/`)
`bounds.ts` (WorldBounds ops), `transform.ts` (scale math, frame transforms), `hit-testing.ts` (shared SelectTool + EraserTool, marquee intersection), `recognize-open-stroke.ts` (shape recognition), `geometry-helpers.ts` (corner/edge detection)

### Shared Package (`packages/shared/src/`)
| File | Responsibility |
|------|----------------|
| `types/geometry.ts` | BBoxTuple, FrameTuple, WorldBounds, Frame + converters |
| `types/objects.ts` | ObjectKind, ObjectHandle, IndexEntry, DirtyPatch |
| `accessors/object-accessors.ts` | Typed Y.Map accessors (getColor, getFrame, getTextProps, getCodeProps, getImageProps, getNoteProps, getBookmarkProps, etc.) |
| `spatial/object-spatial-index.ts` | RBush R-tree wrapper |
| `utils/bbox.ts` | BBox computation with stroke width inflation |
| `utils/url-utils.ts` | `normalizeUrl()`, `isValidHttpUrl()`, `extractDomain()` |
| `utils/image-validation.ts` | Magic byte validation (PNG/JPEG/WebP/GIF/ICO), `parseImageDimensions()`, `isSvg()` |

### Service Worker & Image Pipeline
| File | Responsibility |
|------|----------------|
| `sw.ts` | Service Worker: cache-first `/api/assets/*`, app shell caching, network-first HTML |
| `lib/image/image-manager.ts` | Main-thread bitmap cache, viewport-driven decode, two-worker routing |
| `lib/image/image-worker.ts` | Web Worker (2 instances): decode, ingest, upload queue, bookmark unfurl |
| `lib/image/image-actions.ts` | `createImageFromBlob()`, `openImageFilePicker()`, SVG rasterization |

### Server (`worker/src/`)
| File | Responsibility |
|------|----------------|
| `index.ts` | Hono app: CORS, asset routes, unfurl route, `partyserverMiddleware()` for Yjs sync |
| `assets.ts` | `PUT /api/assets/:key` (validate + R2 store), `GET /api/assets/:key` (edge-cached R2 proxy) |
| `unfurl.ts` | `GET /api/unfurl?url=` — HTMLRewriter OG extraction, image→R2, SSRF guard, edge cache 7d |

### UI (`components/`)
`RoomPage.tsx` (main view, layout), `ToolPanel.tsx` (toolbar + inspector), `ZoomControls.tsx`, `Toast.tsx`, `UsersModal.tsx`, `UserAvatarCluster.tsx`, `icons/index.tsx`

---

## Architecture Overview

### System Hierarchy
```
Route beforeLoad           → connectRoom(roomId) → room-runtime.ts
RoomPage cleanup effect    → disconnectRoom(roomId)

Canvas.tsx (~95 lines) - THIN REACT WRAPPER
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
├── RenderLoop            - base canvas 60fps, inline dirty rect optimization
├── OverlayRenderLoop     - preview + presence, full clear each frame
├── ZoomAnimator          - smooth zoom (step, pinch, zoom-to-fit)
├── InputManager          - dumb DOM event forwarder
├── keyboard-manager      - attach/detach lifecycle (keydown, keyup, blur)
│
├── Subscriptions:
│   ├── camera-store      → tool.onViewChange() on pan/zoom (guarded by isEdgeScrolling)
│   └── snapshot          → dirty rect invalidation, cache eviction
│
└── Event Handlers:
    ├── handlePointerDown → storePointerModifiers → spacebar pan check → tool dispatch / MMB pan
    ├── handlePointerMove → cursor tracking + edge scroll update + tool.move()
    ├── handlePointerUp   → tool.end() + stop edge scroll
    ├── handleWheel       → zoom via ZoomAnimator (with velocity boost + Ctrl pinch)
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
├── room-runtime.ts           → getActiveRoomDoc(), getActiveRoomId(), getCurrentSnapshot()
├── camera-store.ts           → worldToCanvas/screenToWorld, getVisibleWorldBounds()
├── device-ui-store.ts        → activeTool, drawingSettings, cursor management
├── SurfaceManager.ts         → getBaseContext(), getOverlayContext(), getEditorHost()
└── invalidation-helpers.ts   → invalidateWorld(bounds), invalidateOverlay()
```

### Data Flow
```
Y.Doc (source of truth)
   ↓ observers
RoomDocManager (objectsById, spatialIndex, dirtyPatch)
   ↓ subscribeSnapshot()
CanvasRuntime
   ├─ cache.evictMany(dirtyPatch.evictIds)
   ├─ renderLoop.invalidateWorld(bounds)
   └─ overlayLoop.invalidateAll()
         ↓
   RenderLoop (base canvas, dirty-rect optimized)
   OverlayRenderLoop (preview + presence, full clear)
         ↑
   Camera Store (scale, pan, viewport) - self-subscribed
```

### Snapshot (the immutable view)
```typescript
interface Snapshot {
  docVersion: number;
  objectsById: ReadonlyMap<string, ObjectHandle>;  // Live Y.Map references
  spatialIndex: ObjectSpatialIndex | null;          // R-tree for viewport queries + hit testing
  dirtyPatch?: DirtyPatch | null;                   // { rects: WorldBounds[], evictIds: string[] }
  createdAt: number;
}
```
Published by RoomDocManager on every Y.Doc change. Read by: RenderLoop (draw visible objects), OverlayRenderLoop (presence), CanvasRuntime (cache eviction + dirty rect invalidation), tools via `getCurrentSnapshot()`. `spatialIndex` is the same live R-tree instance — queries return `IndexEntry[]` sorted by ULID for Z-order.

### Write Path
```
Tool.begin/move/end() → user gesture
   → tool.commit() → roomDoc.mutate(() => { roomDoc.objects.set(...) })
   → ydoc.transact() → Y.Map.set()
   → Observer fires → applyObjectChanges() → dirtyPatch computed
   → Snapshot published → CanvasRuntime invalidates dirty rects
```

### Event Flow
```
User pointer event → InputManager → CanvasRuntime
   ├─ screenToWorld(clientX, clientY) → world coords
   ├─ storePointerModifiers(e) → cursor-tracking (shift/ctrl state)
   ├─ updatePresenceCursor() → room-runtime
   ├─ updateEdgeScroll() → auto-pan near viewport edges
   └─ getCurrentTool().begin/move/end(worldX, worldY)
         ↓
Tool updates internal state
   ├─ invalidateOverlay() → preview changed
   └─ invalidateWorld(bounds) → geometry changed
```

---

## PointerTool Interface

All tools implement `PointerTool` (defined in `lib/tools/types.ts`):

```typescript
interface PointerTool {
  canBegin(): boolean;
  begin(pointerId, worldX, worldY): void;
  move(worldX, worldY): void;         // Also hover when idle
  end(worldX?, worldY?): void;
  cancel(): void;
  isActive(): boolean;
  getPointerId(): number | null;
  getPreview(): PreviewData | null;    // For overlay rendering
  onPointerLeave(): void;
  onViewChange(): void;                // React to pan/zoom
  destroy(): void;
}
```

**Key design:** All tools receive **world coordinates**. Zero-arg constructors — dependencies read from stores at runtime (settings frozen at `begin()`, roomDoc read at `commit()`).

---

## Room Runtime (`room-runtime.ts`)

Module-level room context for imperative access. `connectRoom(roomId)` called from route `beforeLoad`, `disconnectRoom(roomId)` from RoomPage cleanup. Fail-fast (throws if no room).

Key exports: `connectRoom()`, `disconnectRoom()`, `getActiveRoomDoc()`, `getActiveRoomId()`, `getCurrentSnapshot()`, `getCurrentPresence()`, `hasActiveRoom()`, `updatePresenceCursor()`, `clearPresenceCursor()`, `getConnectorsForShape(shapeId)`

---

## Invalidation Helpers

Setter/getter pattern breaks circular dependencies between CanvasRuntime and tools:
- `setWorldInvalidator(fn)` / `setOverlayInvalidator(fn)` — registered by CanvasRuntime.start()
- `invalidateWorld(bounds)` / `invalidateOverlay()` — called by tools, safe no-ops if unregistered
- `holdPreviewForOneFrame()` — prevents flash on commit

---

## Canvas Runtime Initialization

```
start(config):
  1. SurfaceManager — DOM refs, contexts, resize observer (deferred canvas resize)
  2. RenderLoop + OverlayRenderLoop — self-subscribing, register invalidation helpers
  3. ZoomAnimator
  4. InputManager — DOM event forwarding
  5. keyboard-manager.attach() — keybindings (keydown, keyup, window blur)
  6. Camera subscription → tool.onViewChange() (guarded by isEdgeScrolling)
  7. Snapshot subscription → cache eviction + dirty rect invalidation

stop():
  Teardown all: keyboard-manager.detach(), stopEdgeScroll(), unsubscribe everything
```

Edge scroll: `updateEdgeScroll()` on pointermove, `stopEdgeScroll()` on pointerup/cancel/lost-capture. Only active during select/connector/shape tool drags.

Spacebar pan: `isSpacebarPanMode()` routes left-click to panTool and suppresses tool hover during hold.

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
  color, width, opacity, ownerId, createdAt }
```
Detailed connector docs in `lib/connectors/CLAUDE.md`.

**Note** (sticky note, auto-sizing text via TextTool):
```typescript
{ id, kind: 'note', origin: [topLeftX, topLeftY], scale: number,
  fontFamily, align, alignV: 'top'|'center'|'bottom',
  fillColor: string,             // Default '#FEF3AC'
  content: Y.XmlFragment, ownerId, createdAt }
// No fontSize (auto-derived from content + scale), no width (= NOTE_WIDTH × scale).
// No color (hardcoded '#1a1a1a'). Origin always top-left (not shifted by alignment).
```
Detailed note docs in `lib/text/CLAUDE.md`.

**Image** (content-addressed, offline-first):
```typescript
{ id, kind: 'image', assetId: string,    // SHA-256 hex (64 chars)
  frame: [x, y, w, h],
  naturalWidth: number, naturalHeight: number, mimeType: string,
  opacity?: number, ownerId, createdAt }
// Default 400wu wide, aspect-ratio-preserving height. Content-addressed: same file = same assetId.
```
Detailed image docs in `lib/image/CLAUDE.md`.

**Bookmark** (URL card with OG metadata):
```typescript
{ id, kind: 'bookmark', url: string, domain: string,
  frame: [x, y, w, h],                   // Fixed width 300wu, variable height
  title?: string, description?: string,   // Set by unfurl worker
  ogImageAssetId?: string, ogImageWidth?: number, ogImageHeight?: number,
  faviconAssetId?: string, ownerId, createdAt }
// No unfurlStatus field — state determined by which optional fields are present.
// Offline/failed unfurls create text objects instead (never enter bookmark pipeline).
```
Detailed bookmark docs in `lib/bookmark/CLAUDE.md`.

### ObjectHandle (Live Reference)
```typescript
interface ObjectHandle {
  id: string;              // ULID
  kind: ObjectKind;
  y: Y.Map<unknown>;      // LIVE Y.Map reference
  bbox: BBoxTuple;         // [minX, minY, maxX, maxY]
}
```

---

## Shared Package Types & Accessors

### Geometry Types (`types/geometry.ts`)
```typescript
type BBoxTuple = [minX, minY, maxX, maxY];      // ObjectHandle storage
type FrameTuple = [x, y, w, h];                   // Y.Map storage for shapes

interface WorldBounds { minX, minY, maxX, maxY }   // Logic operations
interface Frame { x, y, w, h }                     // Logic operations
```
Converters: `tupleToFrame()`, `frameToTuple()`, `frameToWorldBounds()`, `bboxTupleToWorldBounds()`, `worldBoundsToBBoxTuple()`, `worldBoundsToFrame()`

### Typed Y.Map Accessors (`object-accessors.ts`)
Prefer typed accessors from `@avlo/shared` over raw `.get()`:
```typescript
// Common
getColor(y, fallback?), getOpacity(y, fallback?), getWidth(y, fallback?)

// Geometry
getFrame(y) → FrameTuple | null
getFrameObject(y) → Frame | null
getPoints(y) → [number, number][]

// Shape-specific
getShapeType(y), getFillColor(y)

// Connector-specific
getStart(y), getEnd(y), getStartAnchor(y), getEndAnchor(y)
getStartCap(y), getEndCap(y), getConnectorType(y)

// Text-specific — bulk accessor preferred
getTextProps(y) → TextProps | null  // { content, origin, fontSize, fontFamily, align, width }
getFontSize(y), getFontFamily(y), getOrigin(y), getAlign(y), getTextWidth(y), getContent(y)

// Code-specific — bulk accessor preferred
getCodeProps(y) → CodeProps | null  // { content: Y.Text, origin, fontSize, width, language }
getLanguage(y), getCodeText(y)

// Note-specific — bulk accessor preferred
getNoteProps(y) → NoteProps | null  // { content, origin, scale, fontFamily, align, alignV, fillColor }

// Image-specific — bulk accessor preferred
getImageProps(y) → ImageProps | null  // { assetId, frame, naturalWidth, naturalHeight, mimeType }
getAssetId(y), getNaturalDimensions(y)

// Bookmark-specific — bulk accessor preferred
getBookmarkProps(y) → BookmarkProps | null  // { url, domain, frame, title?, description?, ogImageAssetId?, ... }
getBookmarkUrl(y)

// Exported types
type TextAlign = 'left' | 'center' | 'right'
type TextAlignV = 'top' | 'center' | 'bottom'
type TextWidth = 'auto' | number
type FontFamily = 'Grandstander' | 'Inter' | 'Lora' | 'JetBrains Mono'
type CodeLanguage = 'javascript' | 'typescript' | 'python'
interface StoredAnchor { id: string; side: Dir; anchor: [number, number] }
```

---

## RoomDocManager

### Two-Epoch Model
1. **Rebuild:** `hydrateObjectsFromY()` → walk Y.Map → build handles → `bulkLoad()` spatial index + connector lookup
2. **Steady-State:** Deep observer → incremental `objectsById` + `spatialIndex` + connector lookup → `dirtyPatch` → snapshot

### Key Methods
```typescript
mutate(fn: () => void)      // Transact with userId origin — access roomDoc.objects directly
undo() / redo()             // Y.UndoManager (500ms capture)
subscribeSnapshot(cb)       // Doc changes
subscribePresence(cb)       // Presence changes
```

### Deep Observer
- `observeDeep()` on objects Y.Map for incremental updates
- **Text/Note:** `field === 'content'` → `textLayoutCache.invalidateContent(id)`, fontSize/scale → invalidateLayout
- **Code:** `Y.YTextEvent` → `codeSystem.handleContentChange(id, ev, lang)`
- **Bookmark:** `invalidateBookmarkLayout(id)` on deletion, `clearBookmarkLayouts()` on rebuild
- **Connectors:** updates connector lookup reverse map (shapeId → Set<connectorId>)
- **BBox:** per-kind computation (`computeTextBBox`, `computeNoteBBox`, `computeCodeBBox`, `computeBookmarkHeight`, or from frame/points)

---

## Rendering Pipeline

### Two-Canvas Architecture
- **Base Canvas:** World content, dirty-rect optimized, 60 FPS (30 on mobile)
- **Overlay Canvas:** Full clear each frame — preview, presence, selection UI
- SelectTool renders transformed objects on base canvas for correct Z-order

### RenderLoop
Dirty rect tracking inlined via `Float64Array` buffer (max 10 rects, zero allocation). Coalesces overlapping rects in-place. Promotes to full clear when: dirty area > 33% of canvas, translucent objects visible, or canvas resized. Deferred canvas resize applied at frame start via `SurfaceManager.applyPendingResize()`.

### Object Rendering Dispatch (`objects.ts`)
```typescript
switch (handle.kind) {
  case 'stroke':    // Path2D from cache
  case 'shape':     // buildShapePathFromFrame() + optional label via drawText()
  case 'text':      // getTextProps() → textLayoutCache.getLayout() → renderTextLayout()
  case 'note':      // getNoteProps() → getNoteLayout() → renderNoteBody() + renderTextLayout()
  case 'code':      // getCodeProps() → codeSystem.getLayout() → renderCodeLayout()
  case 'connector': // ConnectorPaths from cache
  case 'image':     // getBitmap(assetId) → ctx.drawImage() or gray placeholder
  case 'bookmark':  // drawBookmark() — two layouts (full card with OG image, text-only card)
}
```
During scale transforms: code/text/note get `drawScaledPreview()` (uniform) or `drawReflowedPreview()` (E/W). Images uniform-scale only. Bookmarks fixed-size (translate only).

### Coordinate Spaces
- **World:** Logical document coords
- **CSS pixels:** Browser coords
- **Device pixels:** Physical pixels (CSS × DPR)

```typescript
worldToCanvas: [(x - pan.x) * scale, (y - pan.y) * scale]
canvasToWorld: [x / scale + pan.x, y / scale + pan.y]
```

---

## Camera Store (`camera-store.ts`)

Centralized Zustand store for camera/viewport state.

### State & Actions
```typescript
interface CameraState {
  scale: number;                    // Zoom level (1.0 = 100%)
  pan: { x: number; y: number };    // World offset
  cssWidth: number; cssHeight: number; dpr: number;
}
// Actions: setScale, setPan, setScaleAndPan, setViewport, resetView
// Automatic clamping: MIN_ZOOM/MAX_ZOOM, MAX_PAN_DISTANCE
```

### Module-Level Functions
```typescript
setCanvasElement(el) / getCanvasElement() / getCanvasRect()
capturePointer(id) / releasePointer(id)

// Coordinate transforms
worldToCanvas(wx, wy), canvasToWorld(cx, cy)
screenToCanvas(clientX, clientY), screenToWorld(clientX, clientY)
worldToClient(wx, wy)
getVisibleWorldBounds(), getViewportInfo()
```

### Usage
```typescript
// Imperative (tools, render loops):
const { scale, pan } = useCameraStore.getState();
// Reactive (React):
const scale = useCameraStore(selectScale);
```

---

## Device UI Store

```typescript
interface DeviceUIState {
  activeTool: 'pen'|'highlighter'|'eraser'|'text'|'pan'|'select'|'shape'|'connector'|'code'|'note';
  drawingSettings: { size: 4|7|10|13; color: string; opacity: number; fill: boolean };
  textSize: number;                    // Default 24
  connectorSize: 2|4|6|8;
  connectorStartCap, connectorEndCap, connectorType;
  shapeVariant: 'diamond'|'rectangle'|'ellipse';
  fillColor: string;                   // Shape fill
  // Text defaults (persisted)
  textColor, textAlign, textFontFamily, highlightColor, textFillColor;
  // Note defaults (persisted)
  noteAlign, noteAlignV, noteFontFamily;
  // Shape label defaults (persisted)
  shapeAlign, shapeAlignV;
  codeLineNumbers: boolean;
  cursorOverride: string | null;
}
```

---

## Selection Store

```typescript
interface SelectionState {
  selectedIds: string[];
  mode: 'none' | 'standard' | 'connector';     // 1 connector → 'connector', else 'standard'
  selectionKind: 'none' | 'strokesOnly' | 'shapesOnly' | 'textOnly' | 'codeOnly' | 'notesOnly' | 'connectorsOnly' | 'imagesOnly' | 'bookmarksOnly' | 'mixed';
  transform: TransformState;        // 'none' | TranslateTransform | ScaleTransform | EndpointDragTransform
  marquee: MarqueeState;
  connectorTopology: ConnectorTopology | null;
  textReflow: TextReflowState | null;    // E/W text reflow during scale
  codeReflow: CodeReflowState | null;    // E/W code reflow during scale
  codeEditingId: string | null;          // Code object being edited via CodeMirror
}
```

### ConnectorTopology
Computed atomically in `beginTranslate`/`beginScale` via `computeConnectorTopology()`. Per-connector strategy: `'translate'` (both endpoints move, ctx.translate on cached Path2D) or `'reroute'` (A* each frame). `objects.ts` reads `topology.reroutes` for preview; commit writes final points.

```typescript
interface ConnectorTopology {
  entries: ConnectorTopologyEntry[];     // strategy + per-endpoint specs
  translateIdSet: Set<string>;           // O(1) skip A* check
  originalFrames: Map<string, FrameTuple>;
  reroutes: Map<string, [number, number][] | null>;  // Mutable per-frame cache
  prevBboxes: Map<string, WorldBounds>;  // Dirty rect tracking
}
```

---

## SelectTool

**File:** `lib/tools/SelectTool.ts` — all object kinds: shapes, strokes, text, notes, code, images, bookmarks, connectors with endpoint editing.

### State Machine
```typescript
type Phase = 'idle' | 'pendingClick' | 'marquee' | 'translate' | 'scale' | 'endpointDrag';
```
- **Standard mode:** handles → scale, objects → translate, background → marquee
- **Connector mode (1 connector):** endpoint dots → `endpointDrag` with live A* + snapping
- **Shift/Ctrl+click:** Additive/subtractive multi-select

### Transform Behavior
| Kind | Corner / N·S (kind-only) | E / W | Mixed N·S |
|------|--------------------------|-------|-----------|
| **Strokes** | Uniform scale (width scales WYSIWYG) | — | Edge-pin translate |
| **Shapes** | Non-uniform scale (stroke unchanged) | Non-uniform scale | Non-uniform scale |
| **Text** | Uniform (fontSize + origin + width) | Reflow (width change, auto→fixed) | Edge-pin translate |
| **Notes** | Uniform (scale + origin) | Reflow (scale change) | Edge-pin translate |
| **Code** | Uniform (fontSize + width + origin) | Reflow (width + layout recompute) | Edge-pin translate |
| **Connectors** | Via topology (translate or reroute) | Via topology | Via topology |
| **Images** | Uniform scale (aspect ratio preserved) | Uniform scale | Edge-pin translate |
| **Bookmarks** | Fixed size, position-only translate | Fixed size, edge-pin translate | Edge-pin translate |

### Code/Text/Note Editing Entry
- Double-click text/note/shape label → `textTool.startEditing(id)` or `textTool.startLabelEditing(id)`
- Double-click code block → `codeTool.startEditing(id)` (with `justClosedCodeId` guard)
- `codeEditingId` blocks handle hit testing, hover cursors, hides resize handles

### Hit Testing (`geometry/hit-testing.ts`)
Fill-aware Z-order (unfilled interiors transparent), endpoint dots for connector mode, marquee geometry intersection.

---

## Other Tools

### DrawingTool
Handles pen, highlighter, AND shape drawing. HoldDetector (600ms) for shape recognition. Click-to-place: 180wu fixed shape. Settings frozen at `begin()`.

### EraserTool
Geometry-aware hit testing, deletes all object kinds.

### TextTool
WYSIWYG rich text with Tiptap DOM overlay + canvas rendering. Origin-based positioning, auto/fixed width, three-tier layout cache. Shape labels and sticky notes supported (note tool maps to TextTool). **Details:** `lib/text/CLAUDE.md`

### CodeTool
Code blocks with CodeMirror DOM overlay. Screen-space rendering (world × scale in px). Two-tier tokenization (sync regex + Lezer workers). Per-session UndoManager. **Details:** `lib/code/CLAUDE.md`

### PanTool
Viewport panning. Also used for MMB pan and spacebar ephemeral pan.

### ConnectorTool
Elbow A* + straight connectors with shape snapping. Ctrl suppresses snapping. **Details:** `lib/connectors/CLAUDE.md`

---

## Keyboard, Clipboard & Edge Scroll

Standalone imperative modules. Full changelog: `docs/CLIPBOARD_KEYBOARD_CHANGELOG.md`.

- **keyboard-manager:** Tool switches (`v`/`p`/`e`/`t`/`n`/`h`/`a`), `i` opens image file picker (one-shot). Cmd+C/V/X/D/A/Z, Cmd+B/I/H formatting, spacebar ephemeral pan, Ctrl+±/0 zoom, arrow key pan, Enter to edit, Delete/Backspace. Guard hierarchy: input focus > modifiers > gesture-active > bare keys.
- **clipboard-actions:** Internal paste (full-fidelity duplication with ID remap + connector anchor remap), external paste (plain + rich text + images + URL→bookmark), smart duplicate placement (tries 4 directions via spatial index), zoom-to-fit for out-of-view content.
- **edge-scroll:** Auto-pan during select/connector/shape drags. 40px edge zone, proximity² speed, 120ms delay + 300ms easeInQuad ramp. Tool re-dispatch after each pan. Stopped on pointerup/cancel.
- **cursor-tracking:** `getLastCursorWorld()` for paste placement. `isShiftPointer()`/`isCtrlOrMetaPointer()` for multi-select. `isCtrlHeld()` for connector snap suppression.

---

## Image & Bookmark Systems (Summary)

Detailed docs in `lib/image/CLAUDE.md` and `lib/bookmark/CLAUDE.md`.

**Images:** Offline-first with content-addressed R2 storage. Two web workers (hash-routed decode parallelism), generation-based mip superseding (3 levels), Service Worker cache-first asset serving. Viewport-driven: only decode visible images, evict off-screen bitmaps. Entry points: drag-drop, paste, `i` key file picker. All network I/O in workers.

**Bookmarks:** Paste URL → HTML placeholder (local-only) → worker unfurl → atomic Y.Doc write. Unfurl extracts OG/Twitter metadata via HTMLRewriter, stores images to R2 (content-addressed). Offline/failed → text object fallback. Two card layouts: full (OG image + metadata) and text-only. No re-unfurl, no editing — failures are final.

**Service Worker (`sw.ts`):** Cache-first for `/api/assets/*` (immutable, content-addressed) and app shell (`/assets/*`, `/fonts/*`). Network-first for HTML navigation. Workers self-sufficient via Cache API (works without SW in dev). `skipWaiting()` + `clients.claim()` for instant activation.
