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

## Best Practices:
- Always prefer a **"getter"** (get(insert info)), **primitive leaning**, efficient architecture and implementation
- Goal is to minimize excessive parameters/props, always ensure the leanest yet robust approach, reducing unnecessary bloat and excessive object creation(especially when it already exists, or can be derived/accessed)
- Data should be easily accessible throughout the codebase for areas that need it, over-encapsulation without a purpose should be avoided, as this distributed system has to manage state and data and rendering: Communication and data access must have as little friction as possible.
- Approaches should be as little lines of code possible to achieve the goal while maintaining full robustness

---

## File Map

### Canvas System (7 files)
| File | Responsibility |
|------|----------------|
| `client/src/canvas/Canvas.tsx` | Thin React wrapper - mounts DOM, sets room context, creates runtime |
| `client/src/canvas/CanvasRuntime.ts` | Central orchestrator - events, subscriptions, tool dispatch |
| `client/src/canvas/SurfaceManager.ts` | DOM refs (contexts, editorHost) + resize/DPR observation |
| `client/src/canvas/InputManager.ts` | Dumb DOM event forwarder |
| `client/src/canvas/tool-registry.ts` | Self-constructing tool singletons + lookup helpers |
| `client/src/canvas/room-runtime.ts` | Module-level room context for imperative access |
| `client/src/canvas/invalidation-helpers.ts` | Setter/getter pattern for render loop invalidation |

### Core Files
| File | Responsibility |
|------|----------------|
| `client/src/lib/room-doc-manager.ts` | Y.Doc lifecycle, providers, spatial index, snapshot publishing |
| `client/src/renderer/RenderLoop.ts` | Base canvas 60 FPS Event-driven loop, dirty rect optimization, self-subscribing |
| `client/src/renderer/OverlayRenderLoop.ts` | Preview + presence rendering, self-subscribing |
| `client/src/renderer/layers/objects.ts` | Object rendering dispatch, transform preview, fill-aware Z-order |
| `client/src/lib/text/text-system.ts` | Text layout engine (tokenizer + flow engine), cache, renderer, BBox computation |
| `client/src/lib/text/extensions.ts` | Custom TextCollaboration extension (replaces @tiptap/extension-collaboration) |
| `client/src/renderer/layers/selection-overlay.ts` | Selection preview rendering: highlights, marquee, box, circular handles |
| `client/src/renderer/DirtyRectTracker.ts` | Dirty rect accumulation, promotion to full clear |
| `client/src/renderer/object-cache.ts` | Geometry cache (Path2D or ConnectorPaths) by object ID |
| `client/src/lib/utils/shape-path.ts` | Build Path2D from frame tuple (rect, ellipse, diamond, roundedRect) |

### Tools (All zero-arg constructors, singleton pattern)
| File | Status |
|------|--------|
| `client/src/lib/tools/types.ts` | PointerTool interface + all preview types |
| `client/src/lib/tools/SelectTool.ts` | **Full** - Selection, translate, scale, connector endpoint editing |
| `client/src/lib/tools/DrawingTool.ts` | **Full** - Pen, highlighter, AND shape drawing |
| `client/src/lib/tools/EraserTool.ts` | **Full** - Geometry-aware hit testing |
| `client/src/lib/tools/TextTool.ts` | **Full** - WYSIWYG rich text with Tiptap DOM overlay + canvas rendering |
| `client/src/lib/tools/PanTool.ts` | **Full** - Viewport panning |
| `client/src/lib/tools/ConnectorTool.ts` | **Full** - Orthogonal connector drawing + snapping |

### Connectors (Orthogonal Routing System)
**Docs:** `docs/CONNECTOR_ROUTING_SYSTEM_V2.md`, `docs/CONNECTOR_SELECT_CHANGELOG.md`

| File | Responsibility |
|------|----------------|
| `client/src/lib/connectors/types.ts` | Dir, Terminal, SnapTarget, RoutingContext, Grid types, Bounds |
| `client/src/lib/connectors/constants.ts` | SNAP_CONFIG, ROUTING_CONFIG, arrow sizing formulas |
| `client/src/lib/connectors/connector-utils.ts` | Shape frame helpers, direction resolution, path simplification |
| `client/src/lib/connectors/snap.ts` | Shape snapping with edge detection, midpoint hysteresis |
| `client/src/lib/connectors/reroute-connector.ts` | High-level routing API for SelectTool with endpoint overrides |
| `client/src/lib/connectors/routing-context.ts` | Centerlines, dynamic AABBs, stub computation, grid construction |
| `client/src/lib/connectors/routing-astar.ts` | A* pathfinding with segment intersection checking |
| `client/src/lib/connectors/connector-paths.ts` | Pure path builders (polyline, arrows) shared by cache and preview |
| `client/src/lib/connectors/connector-lookup.ts` | Reverse map: shapeId → connectorIds (for rerouting/cleanup) |
| `client/src/lib/connectors/index.ts` | Re-exports all public API |
| `client/src/renderer/layers/connector-preview.ts` | Preview rendering: polyline, arrows, anchor dots |

### Stores
| File | Responsibility |
|------|----------------|
| `client/src/stores/camera-store.ts` | Camera state, coordinate transforms, canvas element registry, pointer capture |
| `client/src/stores/device-ui-store.ts` | Toolbar state, drawing settings, cursor management (persisted) |
| `client/src/stores/selection-store.ts` | Selection state, transform state, connector topology (ephemeral) |

#### Selection Store Details
```typescript
interface SelectionState {
  selectedIds: string[];
  mode: SelectionMode;              // Derived in setSelection: 1 connector → 'connector', else 'standard'
  selectionKind: SelectionKind;     // 'strokesOnly' | 'shapesOnly' | 'connectorsOnly' | 'mixed'
  transform: TransformState;        // 'none' | TranslateTransform | ScaleTransform | EndpointDragTransform
  marquee: MarqueeState;
  connectorTopology: ConnectorTopology | null;
}

interface ConnectorTopology {
  entries: ConnectorTopologyEntry[];     // Unified: strategy='translate'|'reroute', per-endpoint specs
  translateIdSet: Set<string>;           // O(1): skip A* for these
  originalFrames: Map<string, FrameTuple>;  // Cached at begin for frame overrides
  reroutes: Map<string, [number, number][] | null>;  // Mutable per-frame cache
  prevBboxes: Map<string, WorldBounds>;  // Mutable: dirty rect tracking
}
```
**Topology lifecycle:** Computed atomically inside `beginTranslate`/`beginScale` via `computeConnectorTopology()`. SelectTool reads it for rerouting in `invalidateTransformPreview()`, commits from it in `commitTranslate`/`commitScale`.

### Geometry Modules
| File | Responsibility |
|------|----------------|
| `client/src/lib/geometry/index.ts` | Barrel exports for all geometry utilities |
| `client/src/lib/geometry/bounds.ts` | WorldBounds manipulation: union, translate, scale, envelope |
| `client/src/lib/geometry/transform.ts` | Scale math, frame transforms, uniform scale with position preservation |
| `client/src/lib/geometry/hit-testing.ts` | Shared hit testing (SelectTool + EraserTool), marquee intersection |
| `client/src/lib/geometry/recognize-open-stroke.ts` | Shape recognition pipeline |
| `client/src/lib/geometry/geometry-helpers.ts` | Corner/edge detection, PCA analysis |

### Shared Package
| File | Responsibility |
|------|----------------|
| `packages/shared/src/types/geometry.ts` | Standardized types: BBoxTuple, FrameTuple, WorldBounds, Frame + converters |
| `packages/shared/src/types/objects.ts` | ObjectKind, ObjectHandle, IndexEntry, DirtyPatch (re-exports geometry types) |
| `packages/shared/src/accessors/object-accessors.ts` | Typed Y.Map accessors: getColor, getFrame, getPoints, etc. |
| `packages/shared/src/spatial/object-spatial-index.ts` | RBush R-tree wrapper |
| `packages/shared/src/utils/bbox.ts` | BBox computation with stroke width inflation |
| `packages/shared/src/types/snapshot.ts` | Snapshot, ViewTransform interfaces |

### UI (`client/src/components/`)
| File | Responsibility |
|------|----------------|
| `RoomPage.tsx` + `RoomPage.css` | Main room view, micro clusters, layout, design tokens |
| `ToolPanel.tsx` + `ToolPanel.css` | Toolbar + inspector UI |
| `ZoomControls.tsx` + `ZoomControls.css` | Floating zoom controls |
| `Toast.tsx` | Toast notification system |
| `UsersModal.tsx` | Users list modal |
| `UserAvatarCluster.tsx` | Avatar cluster in top-right |
| `SelectionContextMenu.tsx` + `.css` | Selection context menu (demo) |
| `icons/index.tsx` | SVG icon components |

---

## Architecture Overview

### System Hierarchy
```
Canvas.tsx (~95 lines) - THIN REACT WRAPPER
│   Only does: mount DOM, set room context, create runtime
│
├── setActiveRoom(roomId, roomDoc)     → room-runtime.ts
└── new CanvasRuntime().start({ container, baseCanvas, overlayCanvas, editorHost })
                │
                ▼
 CanvasRuntime.ts (~280 lines) - THE BRAIN
│   Owns all subsystems, handles events, manages subscriptions
│
├── SurfaceManager        - ALL DOM refs + resize/DPR observation
│   ├── baseCtx, overlayCtx (module-level)
│   ├── editorHost (module-level)
│   ├── setCanvasElement() → camera-store
│   └── applyCursor() → device-ui-store
│
├── RenderLoop            - base canvas 60fps, dirty rect optimization
├── OverlayRenderLoop     - preview + presence, full clear each frame
├── ZoomAnimator          - smooth zoom transitions
├── InputManager          - dumb DOM event forwarder
│
├── Subscriptions:
│   ├── camera-store      → tool.onViewChange() on pan/zoom
│   └── snapshot          → dirty rect invalidation, cache eviction
│
└── Event Handlers:
    ├── handlePointerDown → tool dispatch or MMB pan
    ├── handlePointerMove → presence cursor + tool.move()
    ├── handlePointerUp   → tool.end()
    ├── handleWheel       → zoom via ZoomAnimator
    └── handlePointerLeave → clear presence, tool.onPointerLeave()

                │
                ▼
tool-registry.ts - SELF-CONSTRUCTING SINGLETONS
│   Tools created at module load, persist for app lifetime
│
├── drawingTool  (handles: pen, highlighter, shape)
├── eraserTool
├── textTool
├── panTool      (used by both dedicated mode AND MMB)
└── selectTool

                │
                ▼
Module Registries - IMPERATIVE ACCESS PATTERNS
├── room-runtime.ts           → getActiveRoomDoc(), presence helpers
├── camera-store.ts           → transforms, viewport, pointer capture, canvas element
├── device-ui-store.ts        → tool state, cursor management (applyCursor, setCursorOverride)
├── SurfaceManager.ts         → getBaseContext(), getOverlayContext(), getEditorHost()
└── invalidation-helpers.ts   → invalidateWorld(), invalidateOverlay()
```

### Data Flow
```
Y.Doc (source of truth)
   ↓ observers
RoomDocManager (objectsById, spatialIndex, dirtyPatch)
   ↓ RAF For Awareness Interpolation
Snapshot (immutable view)
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

### Write Path
```
Tool.begin/move/end() → user gesture
   → tool.commit() → getActiveRoomDoc().mutate(fn)
   → ydoc.transact() → Y.Map.set()
   → Observer fires → applyObjectChanges() → dirtyPatch computed
   → Snapshot published → CanvasRuntime invalidates dirty rects
```

### Event Flow
```
User pointer event
   ↓
InputManager (dumb forwarder)
   ↓
CanvasRuntime.handlePointerDown/Move/Up()
   ├─ screenToWorld(clientX, clientY) → world coords
   ├─ updatePresenceCursor(worldX, worldY) → room-runtime
   └─ getCurrentTool().begin/move/end(worldX, worldY)
         ↓
Tool updates internal state
   ├─ invalidateOverlay() → preview changed
   └─ invalidateWorld(bounds) → geometry changed (during transforms)
         ↓
Render loops schedule next frame
```

---

## PointerTool Interface

All tools implement this unified interface (defined in `lib/tools/types.ts`):

```typescript
interface PointerTool {
  canBegin(): boolean;                              // Can start new gesture?
  begin(pointerId, worldX, worldY): void;           // Start gesture
  move(worldX, worldY): void;                       // Update (also hover when idle)
  end(worldX?, worldY?): void;                      // Complete gesture
  cancel(): void;                                   // Abort without commit
  isActive(): boolean;                              // Gesture in progress?
  getPointerId(): number | null;                    // Active pointer ID
  getPreview(): PreviewData | null;                 // For overlay rendering
  onPointerLeave(): void;                           // Clear hover state
  onViewChange(): void;                             // React to pan/zoom
  destroy(): void;                                  // Cleanup
}
```

**Key Design:** All tools receive **world coordinates** from CanvasRuntime. Tools that need screen coords (like PanTool) convert internally via `worldToCanvas()`.

---

## Tool Registry & Singletons

### Self-Constructing Pattern
Tools are created once at module load and persist for app lifetime:

```typescript
// tool-registry.ts - constructed at import time
const drawingTool = new DrawingTool();    // handles pen, highlighter, shape
const eraserTool = new EraserTool();
const textTool = new TextTool();
const panTool = new PanTool();
const selectTool = new SelectTool();
const connectorTool = new ConnectorTool();
```

### Tool Map (ToolId → Instance)
```typescript
const toolMap = {
  'pen' → drawingTool,         // Same instance!
  'highlighter' → drawingTool,  // Same instance!
  'shape' → drawingTool,        // Same instance!
  'eraser' → eraserTool,
  'text' → textTool,
  'pan' → panTool,
  'select' → selectTool,
  'connector' → connectorTool,
  // 'image' and 'code' intentionally omitted (no impl)
}
```

### Exported Helpers
```typescript
getCurrentTool(): PointerTool | undefined  // Reads activeTool from device-ui-store
getToolById(toolId): PointerTool | undefined
getActivePreview(): PreviewData | null     // For OverlayRenderLoop
canStartMMBPan(): boolean                  // Blocks MMB if tool gesture active
export { panTool }                         // Direct export for MMB pan
```

### Zero-Arg Constructor Pattern
All tools have zero-arg constructors. Dependencies read at runtime:

```typescript
class DrawingTool implements PointerTool {
  constructor() {
    // NO dependencies passed in
    this.resetState();
  }

  begin(pointerId, worldX, worldY) {
    // Read settings from store AT GESTURE START
    const uiState = useDeviceUIStore.getState();
    this.frozenSettings = { size: uiState.drawingSettings.size, ... };
  }

  commit() {
    // Get roomDoc AT COMMIT TIME
    const roomDoc = getActiveRoomDoc();
    roomDoc.mutate((ydoc) => { ... });
  }
}
```

---

## Room Runtime (`room-runtime.ts`)

Module-level room context for imperative access. Eliminates prop drilling.

### Set by Canvas.tsx
```typescript
// In Canvas.tsx useLayoutEffect:
setActiveRoom({ roomId, roomDoc });
// On unmount:
setActiveRoom(null);
```

### Exports
```typescript
setActiveRoom(context: { roomId, roomDoc } | null): void
getActiveRoom(): RoomContext                    // Throws if no room!
getActiveRoomDoc(): IRoomDocManager             // Convenience
getActiveRoomId(): RoomId
hasActiveRoom(): boolean                        // Guard check
getCurrentSnapshot(): Snapshot                  // Doc-only (no presence)
getCurrentPresence(): PresenceView              // Presence-only
getGateStatus(): GateStatus

// Presence helpers
updatePresenceCursor(worldX, worldY): void     // Called from CanvasRuntime.handlePointerMove
clearPresenceCursor(): void                     // Called from CanvasRuntime.handlePointerLeave

// Connector lookup (re-exported from connectors/)
getConnectorsForShape(shapeId): ReadonlySet<string> | undefined  // For SelectTool, EraserTool
hasConnectorLookup(): boolean
```

**Fail-Fast Design:** `getActiveRoomDoc()` throws if no room set, encouraging crash-early over silent failures.

---

## Invalidation Helpers

Setter/getter pattern breaks circular dependencies between CanvasRuntime and tools.

```typescript
// Module-level function references (initially null)
let worldInvalidator: ((bounds) => void) | null = null;
let overlayInvalidator: (() => void) | null = null;

// Setters (called by CanvasRuntime.start())
setWorldInvalidator(fn)    // → renderLoop.invalidateWorld
setOverlayInvalidator(fn)  // → overlayLoop.invalidateAll

// Public API (called by tools, safe no-ops if not registered)
invalidateWorld(bounds)    // Optional call
invalidateOverlay()        // Optional call
holdPreviewForOneFrame()   // Prevents flash on commit
```

---

## Canvas Runtime Initialization

### start() Sequence
```typescript
start(config: RuntimeConfig): void {
  // 1. SurfaceManager - handles all DOM refs
  this.surfaceManager = new SurfaceManager(container, baseCanvas, overlayCanvas, editorHost);
  this.surfaceManager.start();
  //   ├─ Get 2D contexts → store in module-level baseCtx, overlayCtx
  //   ├─ setCanvasElement(baseCanvas) → camera-store
  //   ├─ applyCursor() → initial cursor from device-ui-store
  //   └─ ResizeObserver + DPR listener

  // 2. Render loops (self-subscribing to camera store)
  this.renderLoop = new RenderLoop();
  this.renderLoop.start();
  setWorldInvalidator((bounds) => this.renderLoop.invalidateWorld(bounds));

  this.overlayLoop = new OverlayRenderLoop();
  this.overlayLoop.start();
  setOverlayInvalidator(() => this.overlayLoop.invalidateAll());
  setHoldPreviewFn(() => this.overlayLoop.holdPreviewForOneFrame());

  // 3. Zoom animation
  this.zoomAnimator = new ZoomAnimator();

  // 4. Input manager (dumb DOM event forwarder)
  this.inputManager = new InputManager(this);
  this.inputManager.attach();

  // 5. Camera subscription → tool.onViewChange()
  this.cameraUnsub = useCameraStore.subscribe(
    (state) => ({ scale: state.scale, pan: state.pan }),
    () => getCurrentTool()?.onViewChange()
  );

  // 6. Snapshot subscription → dirty rect invalidation
  this.snapshotUnsub = roomDoc.subscribeSnapshot((snapshot) => {
    if (snapshot.dirtyPatch) {
      cache.evictMany(snapshot.dirtyPatch.evictIds);
      for (const bounds of snapshot.dirtyPatch.rects) {
        if (boundsIntersect(bounds, viewport)) {
          this.renderLoop.invalidateWorld(bounds);
        }
      }
    }
  });
}
```

---

## Y.Doc Structure (v2)

```typescript
Y.Doc { guid: roomId }
└─ root: Y.Map
   ├─ v: 2                          // Schema version
   ├─ meta: Y.Map                   // TTL timestamps
   ├─ objects: Y.Map<Y.Map<any>>    // All objects by ULID
   ├─ code: Y.Map                   // Legacy (future migration)
   └─ outputs: Y.Array              // Legacy (future migration)
```

### Object Kinds
```typescript
type ObjectKind = 'stroke' | 'shape' | 'text' | 'connector';
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
  frame: [x, y, w, h], ownerId, createdAt }
```

**Text** (origin-based positioning, rich text via Y.XmlFragment):
```typescript
{ id, kind: 'text', origin: [anchorX, baseline], fontSize, color,
  align: 'left'|'center'|'right',
  width: 'auto' | number,       // TextWidth — 'auto' or fixed width in world units
  content: Y.XmlFragment, ownerId, createdAt }
// NOTE: No stored 'frame'. Frame is derived in TextLayoutCache via computeTextBBox().
// Use getTextFrame(objectId) from text-system.ts to read the cached derived frame.
// Delta attributes: bold, italic, highlight (multicolor: { color: '#hex' } or presence → '#ffd43b')
```

**Connector** (orthogonal routing with optional shape anchoring):
```typescript
{
  id, kind: 'connector',
  points: [number, number][],  // Full routed path (ready to render)
  start: [number, number],     // Start endpoint position
  end: [number, number],       // End endpoint position
  startAnchor?: {              // Only if start is anchored to a shape
    id: string,                // Target shape ID
    side: 'N'|'E'|'S'|'W',     // Edge direction
    anchor: [number, number],  // Normalized position [0-1, 0-1]
  },
  endAnchor?: { ... },         // Same structure for end
  startCap: 'none'|'arrow',
  endCap: 'none'|'arrow',
  color, width, opacity, ownerId, createdAt
}
```
**Note:** Detailed connector docs in `docs/CONNECTOR_ROUTING_SYSTEM_V2.md`

### ObjectHandle (Live Reference)
```typescript
interface ObjectHandle {
  id: string;                              // ULID
  kind: ObjectKind;
  y: Y.Map<unknown>;                       // LIVE Y.Map reference!
  bbox: BBoxTuple;                         // [minX, minY, maxX, maxY] - computed locally
}
```
**CRITICAL:** `handle.y` is live. Prefer typed accessors from `@avlo/shared` instead of raw `.get()` for easier usage:
```typescript
import { getColor, getFrame, getPoints, getWidth } from '@avlo/shared';
const color = getColor(handle.y);      // Returns string with fallback
const frame = getFrame(handle.y);      // Returns FrameTuple | null
const points = getPoints(handle.y);    // Returns [number, number][]
```

---

## Shared Package Types & Accessors

### Standardized Geometry Types (`types/geometry.ts`)
```typescript
// TUPLE TYPES 
type BBoxTuple = [minX: number, minY: number, maxX: number, maxY: number];  // Storage in ObjectHandle
type FrameTuple = [x: number, y: number, w: number, h: number]; // Storage in Y.map for Shape/Text

// OBJECT REPRESENTATIONS (for logic)
interface WorldBounds { minX, minY, maxX, maxY }
interface Frame { x, y, w, h }
```

**Converters:** `tupleToFrame()`, `frameToTuple()`, `frameToWorldBounds()`, `bboxTupleToWorldBounds()`, `worldBoundsToBBoxTuple()`, `worldBoundsToFrame()`

### Typed Y.Map Accessors (`accessors/object-accessors.ts`)
Eliminates repetitive casting - getters return typed values with fallbacks:
```typescript
// Common
getColor(y, fallback?)       → string
getOpacity(y, fallback?)     → number
getWidth(y, fallback?)       → number

// Geometry
getFrame(y)                  → FrameTuple | null
getFrameObject(y)            → Frame | null
getPoints(y)                 → [number, number][]

// Shape-specific
getShapeType(y)              → string ('rect' default)
getFillColor(y)              → string | undefined

// Connector-specific
getStart(y), getEnd(y)       → [number, number] | undefined
getStartAnchor(y), getEndAnchor(y) → StoredAnchor | undefined
getStartCap(y), getEndCap(y) → 'arrow' | 'none'

// Text-specific
getFontSize(y), getOrigin(y), getAlign(y), getTextWidth(y), getContent(y)
getTextProps(y)              → TextProps | null  // All text properties in one call

// Text types (exported from accessors)
type TextAlign = 'left' | 'center' | 'right'
type TextWidth = 'auto' | number
interface TextProps { content: Y.XmlFragment, origin, fontSize, align: TextAlign, width: TextWidth }
```

### StoredAnchor (Connector Anchoring)
```typescript
interface StoredAnchor {
  id: string;                    // Target shape ID
  side: Dir;                     // 'N' | 'E' | 'S' | 'W'
  anchor: [number, number];      // Normalized position [0-1, 0-1]
}
```

---

## RoomDocManager

### Two-Epoch Model
1. **Rebuild Epoch:** `hydrateObjectsFromY()` → walk Y.Map → build handles → `bulkLoad()` spatial index + `hydrateConnectorLookup()`
2. **Steady-State Epoch:** Deep observer → incremental `objectsById` + `spatialIndex` + connector lookup updates → compute `dirtyPatch`

### Key Methods
```typescript
mutate(fn: (ydoc) => void)  // Transact with userId origin
undo() / redo()             // Y.UndoManager (500ms capture)
subscribeSnapshot(cb)       // Doc-only (no presence)
subscribePresence(cb)       // Presence-only
```

### Maintained Indices
- **spatialIndex:** R-tree for viewport queries and hit testing
- **connector-lookup:** Reverse map (shapeId → Set<connectorId>) for efficient anchor rerouting/cleanup

### Deep Observer & BBox Computation
Objects Y.Map uses `observeDeep()` for incremental updates. On connector add/update/delete, also updates connector lookup maps. For text objects: `field === 'content'` → `textLayoutCache.invalidateContent(id)`, `field === 'fontSize'` → `textLayoutCache.invalidateLayout(id)`. Width changes handled by comparison-based detection in `getLayout()`. BBox uses `getTextProps(yObj)` → `computeTextBBox(id, props)`.

## Rendering Pipeline

### Two-Canvas Architecture
- **Base Canvas:** World content, dirty-rect optimized, 60 FPS
- **Overlay Canvas:** Full clear, overlays + preview + presence, pointer-events: none
- Unlike other tools, Select Tool renders transformed objects on base canvas for proper z order
### Object Rendering
```typescript
for (entry of sortedByULID) {
  const handle = objectsById.get(entry.id);
  const path = cache.getOrBuild(id, handle);
  // Read styles via typed accessors
  ctx.fillStyle = getColor(handle.y);
  ctx.fill(path);
}
```
- Text rendering via `drawText()` in `objects.ts`: uses `getTextProps()` → `textLayoutCache.getLayout()` → `renderTextLayout()`
- Shape paths via `lib/utils/shape-path.ts`: `buildShapePathFromFrame(shapeType, frame)`
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
  pan: { x: number; y: number };    // World offset in world units
  cssWidth: number;                 // Viewport CSS width
  cssHeight: number;                // Viewport CSS height
  dpr: number;                      // Device pixel ratio
}

// Actions: setScale, setPan, setScaleAndPan, setViewport, resetView
// All with automatic clamping (MIN_ZOOM/MAX_ZOOM, MAX_PAN_DISTANCE)
```

### Module-Level Canvas Reference
```typescript
setCanvasElement(el)   // Called by SurfaceManager.start()
getCanvasElement()     // Raw element access
getCanvasRect()        // Bounding rect for coordinate conversion

// Pointer capture helpers
capturePointer(pointerId)   // Called by CanvasRuntime.handlePointerDown
releasePointer(pointerId)   // Called by CanvasRuntime.handlePointerUp
```

### Pure Transform Functions (Exported)
```typescript
worldToCanvas(worldX, worldY): [number, number]
canvasToWorld(canvasX, canvasY): [number, number]
screenToCanvas(clientX, clientY): [number, number] | null  // null if unmounted
screenToWorld(clientX, clientY): [number, number] | null
worldToClient(worldX, worldY): [number, number]

getVisibleWorldBounds(): { minX, minY, maxX, maxY }
getViewportInfo(): { pixelWidth, pixelHeight, cssWidth, cssHeight, dpr }
getViewTransform(): ViewTransform  // Compatibility helper
```

### Usage Patterns
```typescript
// Imperative access (tools, event handlers, render loops):
const { scale, pan } = useCameraStore.getState();
useCameraStore.getState().setPan({ x: newX, y: newY });

// Reactive (React components):
const scale = useCameraStore(selectScale);

// Pointer capture (used by CanvasRuntime):
capturePointer(e.pointerId);
releasePointer(e.pointerId);
```

---

## Device UI Store & Cursor Management

### State
```typescript
interface DeviceUIState {
  activeTool: 'pen'|'highlighter'|'eraser'|'text'|'pan'|'select'|'shape'|'image'|'code';
  drawingSettings: { size: 10|14|18|22; color: string; opacity: number; fill: boolean };
  highlighterOpacity: 0.45;  // Fixed
  textSize: 20|30|40|50;
  shapeVariant: 'diamond'|'rectangle'|'ellipse'|'arrow';
  cursorOverride: string | null;  // e.g., 'grabbing' during pan
}
```


## Other Tools

### DrawingTool
- Handles pen, highlighter, AND forced shape drawing
- HoldDetector (600ms) triggers shape recognition (box/circle only)
- Forced snap mode for toolbar shapes (rect/ellipse/diamond)
- Click-to-place: 180 world-unit fixed shape
- Settings frozen at `begin()`, except `fill` read live

### EraserTool

### TextTool
**Docs:** `client/src/lib/text/CLAUDE.md`
- WYSIWYG: Tiptap DOM overlay during editing, canvas rendering on commit
- Custom TextCollaboration extension (fixes @tiptap/extension-collaboration memory leak)
- Origin-based positioning: `origin[0]` = alignment anchor, `origin[1]` = first line baseline
- Auto-width (max-content) and fixed-width (text wrapping) modes via `TextWidth = 'auto' | number`
- Canvas layout engine: tokenizer + flow engine matching CSS `pre-wrap` + `break-word`
- Three-tier cache: content → measurement → flow (width change only re-flows)
- Derived frame in `TextLayoutCache` (no stored frame in Y.Map), read via `getTextFrame(id)`

### PanTool

### SelectTool

**File:** `client/src/lib/tools/SelectTool.ts` (~1355 lines)
**Status:** Full — shapes, strokes, text, and connectors with endpoint editing.

#### Selection Modes & Kinds
```typescript
type SelectionMode = 'none' | 'standard' | 'connector';  // UX paradigm
type SelectionKind = 'none' | 'strokesOnly' | 'shapesOnly' | 'connectorsOnly' | 'mixed';
```

| Selection | Mode | UX |
|-----------|------|-----|
| 1 connector | `connector` | Endpoint dots, drag to reconnect, no selection box |
| 2+ connectors | `standard` | Selection box + handles, scale transforms |
| Shapes/strokes/mixed | `standard` | Selection box + handles |

#### State Machine
```typescript
type Phase = 'idle' | 'pendingClick' | 'marquee' | 'translate' | 'scale' | 'endpointDrag';
```
- **Standard mode:** hit tests handles → scale, objects → translate, background → marquee
- **Connector mode:** hit tests endpoint dots → `endpointDrag` phase with live A* rerouting + snapping
- **Anchored connectors:** Drag body starts marquee (can't translate anchored connector body)

#### Connector Topology Integration
When shapes transform, attached connectors reroute via `ConnectorTopology` (computed in store at `beginTranslate`/`beginScale`):
- **Strategy:** `'translate'` (both endpoints move → ctx.translate on cached Path2D) or `'reroute'` (A* each frame)
- **EndpointSpec:** `string` = frame override (shapeId), `true` = free position override, `null` = canonical
- **Render:** `objects.ts` reads `topology.reroutes` for preview; commit writes final points

#### Transform Behavior (Strokes/Shapes)
- **Strokes:** Uniform scale, position preserved, width scales WYSIWYG
- **Shapes:** Non-uniform scale, stroke width unchanged
- **Mixed + side handle:** Strokes translate (edge-pin), shapes scale

#### Hit Testing (`geometry/hit-testing.ts`)
- Fill-aware Z-order: unfilled interiors transparent
- Endpoint dots: `hitTestEndpointDots()` for connector mode
- Marquee: geometry intersection (not just bbox)

---

## Preview Types

```typescript
type PreviewData = StrokePreview | EraserPreview | PerfectShapePreview | SelectionPreview | ConnectorPreview;

interface SelectionPreview {  // Selection Box/Handles/Highlights are drawn on Overlay Canvas/loop
  kind: 'selection';
  selectionBounds: WorldRect | null;  // null in connector mode
  marqueeRect: WorldRect | null;
  handles: { id: HandleId; x, y }[];  // null in connector mode or while transforming
  isTransforming: boolean;
  selectedIds: string[];
  // Connector mode: overlay renders endpoint dots instead of selection box
}

interface ConnectorPreview {
  kind: 'connector';
  points: [number, number][];        // Full routed path
  color, width, opacity;             // Styling
  startCap, endCap: 'arrow' | 'none';
  // Snap state (dots only appear when actually snapped)
  snapShapeId: string | null;
  snapShapeFrame, snapShapeType, snapSide, snapPosition;
  activeMidpointSide: Dir | null;
  // Endpoint states
  fromIsAttached, toIsAttached: boolean;
  fromPosition, toPosition: [number, number] | null;
}
```

---

## NOT Implemented Yet / Planned

- **Text resize handles:** Select tool E/W side handles to interactively set fixed width
- **Text scale transforms:** Font size scaling during select transforms
- **Code Block Tool:** Placeholder in toolbar, shows "coming soon" toast
- **Shape labels:** Text inside shapes
- **Images**
