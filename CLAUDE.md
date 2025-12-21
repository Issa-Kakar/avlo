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
| `client/src/renderer/layers/objects.ts` | Object rendering dispatch, transform preview |
| `client/src/renderer/DirtyRectTracker.ts` | Dirty rect accumulation, promotion to full clear |
| `client/src/renderer/object-cache.ts` | Path2D cache by object ID |

### Tools (All zero-arg constructors, singleton pattern)
| File | Status |
|------|--------|
| `client/src/lib/tools/types.ts` | PointerTool interface + all preview types |
| `client/src/lib/tools/SelectTool.ts` | **Full** - Selection, translate, scale transforms |
| `client/src/lib/tools/DrawingTool.ts` | **Full** - Pen, highlighter, AND shape drawing |
| `client/src/lib/tools/EraserTool.ts` | **Full** - Geometry-aware hit testing |
| `client/src/lib/tools/TextTool.ts` | **PLACEHOLDER** - Will be completely replaced |
| `client/src/lib/tools/PanTool.ts` | **Full** - Viewport panning |

### Stores
| File | Responsibility |
|------|----------------|
| `client/src/stores/camera-store.ts` | Camera state, coordinate transforms, canvas element registry, pointer capture |
| `client/src/stores/device-ui-store.ts` | Toolbar state, drawing settings, cursor management (persisted) |
| `client/src/stores/selection-store.ts` | Selection IDs, transform state, marquee (ephemeral) |

### Geometry Modules
| File | Responsibility |
|------|----------------|
| `client/src/lib/geometry/scale-transform.ts` | Scale math for SelectTool transforms |
| `client/src/lib/geometry/hit-test-primitives.ts` | Shared hit testing (SelectTool + EraserTool) |
| `client/src/lib/geometry/recognize-open-stroke.ts` | Shape recognition pipeline |
| `client/src/lib/geometry/geometry-helpers.ts` | Corner/edge detection, PCA analysis |

### Shared Package
| File | Responsibility |
|------|----------------|
| `packages/shared/src/spatial/object-spatial-index.ts` | RBush R-tree wrapper |
| `packages/shared/src/utils/bbox.ts` | BBox computation with stroke width inflation |
| `packages/shared/src/types/objects.ts` | ObjectKind, ObjectHandle, IndexEntry, DirtyPatch |
| `packages/shared/src/types/snapshot.ts` | Snapshot, ViewTransform interfaces |

### UI
| File | Responsibility |
|------|----------------|
| `client/src/pages/components/ToolPanel.tsx` | Toolbar + inspector UI |

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
const drawingTool = new DrawingTool();  // handles pen, highlighter, shape
const eraserTool = new EraserTool();
const textTool = new TextTool();
const panTool = new PanTool();
const selectTool = new SelectTool();
```

### Tool Map (ToolId → Instance)
```typescript
const toolMap = {
  'pen' → drawingTool,        // Same instance!
  'highlighter' → drawingTool, // Same instance!
  'shape' → drawingTool,       // Same instance!
  'eraser' → eraserTool,
  'text' → textTool,
  'pan' → panTool,
  'select' → selectTool,
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

**Text** (placeholder - will be replaced):
```typescript
{ id, kind: 'text', frame: [x,y,w,h], text: string, color, fontSize,
  fontFamily, fontWeight, fontStyle, textAlignH, opacity, ownerId, createdAt }
```

**Connector** (basic polyline only - sticky connectors NOT implemented yet):
```typescript
{ id, kind: 'connector', points: [number,number][], startCap?, endCap?,
  color, width, opacity, ownerId, createdAt }
// PLANNED but NOT implemented: fromId, toId, anchors, routing
```

### ObjectHandle (Live Reference)
```typescript
interface ObjectHandle {
  id: string;                              // ULID
  kind: ObjectKind;
  y: Y.Map<any>;                           // LIVE Y.Map reference!
  bbox: [minX, minY, maxX, maxY];          // Computed locally
}
```
**CRITICAL:** `handle.y` is live - rendering reads directly via `handle.y.get('color')`.

---

## RoomDocManager

### Two-Epoch Model
1. **Rebuild Epoch:** `hydrateObjectsFromY()` → walk Y.Map → build handles → `bulkLoad()` spatial index
2. **Steady-State Epoch:** Deep observer → incremental `objectsById` + `spatialIndex` updates → compute `dirtyPatch`

### Gates (Initialization Sequence)
| Gate | Opens When | Timeout |
|------|-----------|---------|
| `idbReady` | IndexedDB loaded | 2s |
| `wsConnected` | WebSocket opens | 5s |
| `wsSynced` | First Y.Doc sync | 10s |
| `awarenessReady` | WS connected | - |
| `firstSnapshot` | First doc snapshot | - |

### Key Methods
```typescript
mutate(fn: (ydoc) => void)  // Transact with userId origin
undo() / redo()             // Y.UndoManager (500ms capture)
subscribeSnapshot(cb)       // Doc-only (no presence)
subscribePresence(cb)       // Presence-only
```

### Deep Observer & BBox Computation
Objects Y.Map uses `observeDeep()` for incremental updates:
```typescript
objects.observeDeep(this.objectsObserver);  // Attached after rebuild epoch

// applyObjectChanges() processes touched/deleted IDs
// computeBBoxFor(kind, yObj) dispatches by ObjectKind:
// - stroke/connector: iterate points, add width*0.5+1 padding
// - shape: frame + strokeWidth*0.5+1 padding
// - text: frame only (no padding)
```
BBox includes stroke width → width change = bbox change = cache eviction.

---

## Rendering Pipeline

### Two-Canvas Architecture
- **Base Canvas:** World content, dirty-rect optimized, 60 FPS (8 FPS hidden tab)
- **Overlay Canvas:** Full clear, preview + presence, pointer-events: none

### Render Loop Self-Subscription
Both render loops subscribe to camera-store internally:
```typescript
// RenderLoop subscribes to viewport + transform changes
this.cameraUnsubscribe = useCameraStore.subscribe(
  (state) => ({ scale, panX, panY, cssWidth, cssHeight, dpr }),
  (curr, prev) => {
    if (viewportChanged) this.dirtyTracker.invalidateAll();
    if (transformChanged) this.dirtyTracker.notifyTransformChange();
    this.markDirty();
  }
);

// OverlayRenderLoop also subscribes to tool changes
this.toolUnsubscribe = useDeviceUIStore.subscribe((state) => {
  if (state.activeTool !== lastTool) {
    this.cachedPreview = null;
    this.invalidateAll();
  }
});
```

### Dirty Rect Flow
```
CanvasRuntime.snapshotSubscription()
   → cache.evictMany(evictIds)
   → renderLoop.invalidateWorld(bounds)
   → DirtyRectTracker accumulates
   → Promotion check (>max rects allowed OR >33% area → full clear)
   → RenderLoop.tick() clears + clips
   → drawObjects() spatial queries clip region
```

### Object Rendering
```typescript
for (entry of sortedByULID) {
  const handle = objectsById.get(entry.id);
  const path = cache.getOrBuild(id, handle);
  // Read styles LIVE from Y.Map
  ctx.fillStyle = handle.y.get('color');
  ctx.fill(path);
}
```

### Transform Preview in objects.ts
During active SelectTool transforms, `drawObjects()` reads selection state:
```typescript
const selectionState = useSelectionStore.getState();
const isTransforming = transform.kind !== 'none';

// For selected objects during transform:
if (transform.kind === 'translate') {
  ctx.translate(transform.dx, transform.dy);
  drawObject(ctx, handle);  // Uses cached Path2D
} else if (transform.kind === 'scale') {
  renderSelectedObjectWithScaleTransform(ctx, handle, transform);
}
```
Non-selected objects render from snapshot; selected objects render with live transform state.

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

### Cursor Management Functions
```typescript
// Compute base cursor from active tool
function computeBaseCursor(): string {
  switch (activeTool) {
    case 'eraser': return 'url("/cursors/avloEraser.cur") 16 16, auto';
    case 'pan': return 'grab';
    case 'select': return 'default';
    case 'text': return 'text';
    default: return 'crosshair';  // pen, highlighter, shape
  }
}

// Apply cursor to canvas (priority: override > tool-based)
export function applyCursor(): void {
  const canvas = getCanvasElement();
  if (!canvas) return;
  const override = useDeviceUIStore.getState().cursorOverride;
  canvas.style.cursor = override ?? computeBaseCursor();
}

// Set manual override (pass null to clear)
export function setCursorOverride(cursor: string | null): void {
  useDeviceUIStore.getState().setCursorOverride(cursor);
  // Note: setCursorOverride action calls applyCursor() internally
}
```

### Self-Subscription Pattern
At module load, device-ui-store subscribes to itself:
```typescript
useDeviceUIStore.subscribe((state, prevState) => {
  if (state.activeTool !== prevState.activeTool) {
    applyCursor();  // Auto-update cursor on tool change
  }
});
```

### Cursor Usage by Tools
```typescript
// PanTool
begin() { setCursorOverride('grabbing'); }
end()   { setCursorOverride(null); }

// SelectTool (handle hover)
handleHoverCursor() {
  const handle = hitTestHandle(worldX, worldY);
  setCursorOverride(handle ? 'nwse-resize' : null);
  applyCursor();
}
```

---

## SelectTool (Full Documentation)

### State Machine
```typescript
type Phase = 'idle' | 'pendingClick' | 'marquee' | 'translate' | 'scale';
```

### Down Target Classification
```typescript
type DownTarget = 'none' | 'handle' | 'objectInSelection'
                | 'objectOutsideSelection' | 'selectionGap' | 'background';
```

| Target | Click | Drag |
|--------|-------|------|
| `handle` | No-op | Scale transform |
| `objectInSelection` | Drill down | Translate |
| `objectOutsideSelection` | Select it | Select + Translate |
| `selectionGap` | Deselect | Translate |
| `background` | Deselect | Marquee |

### Handle System
```typescript
type HandleId = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';
type HandleKind = 'corner' | 'side';  // Computed from HandleId
```

Scale origin is **opposite** edge/corner from dragged handle.

### Selection Kinds
```typescript
type SelectionKind = 'none' | 'strokesOnly' | 'shapesOnly' | 'mixed';
```

### Transform Behaviors

| Selection | Handle | Strokes | Shapes |
|-----------|--------|---------|--------|
| strokesOnly | Corner | Uniform scale, position preserved | N/A |
| strokesOnly | Side | Uniform scale (single axis) | N/A |
| shapesOnly | Corner | N/A | Non-uniform (independent X/Y) |
| shapesOnly | Side | N/A | Non-uniform (single axis) |
| mixed | Corner | Uniform, position preserved | Uniform, position preserved |
| mixed | Side | **Translate only** (edge-pin) | Non-uniform |

### Two Bounds for Scale
- **originBounds** (geometry-only): For position math, no stroke padding
- **bboxBounds** (padded): For dirty rect invalidation

### Key Geometry Functions (scale-transform.ts)
```typescript
computeUniformScaleNoThreshold(scaleX, scaleY): number
computePreservedPosition(cx, cy, originBounds, origin, uniformScale): [x, y]
computeStrokeTranslation(handle, originBounds, scaleX, scaleY, origin, handleId): {dx, dy}
```

### Hit Testing (hit-test-primitives.ts)
```typescript
pointToSegmentDistance(px, py, x1, y1, x2, y2): number
strokeHitTest(px, py, points, radius): boolean
pointInDiamond(px, py, top, right, bottom, left): boolean
ellipseIntersectsRect(cx, cy, rx, ry, rect): boolean
polylineIntersectsRect(points, rect): boolean
```

### Selection Store (selection-store.ts)
```typescript
interface SelectionState {
  selectedIds: string[];
  mode: 'none' | 'single' | 'multi';
  transform: { kind: 'none' } | TranslateTransform | ScaleTransform;
  marquee: { active: boolean; anchor: [x,y] | null; current: [x,y] | null };
}
```

---

## Other Tools

### DrawingTool
- Handles pen, highlighter, AND forced shape drawing
- HoldDetector (600ms) triggers shape recognition (box/circle only)
- Forced snap mode for toolbar shapes (rect/ellipse/diamond)
- Click-to-place: 180 world-unit fixed shape
- Settings frozen at `begin()`, except `fill` read live

### EraserTool
- Fixed 10px radius (not configurable)
- Geometry-aware hit testing per shapeType
- `hitNow` (current frame) vs `hitAccum` (gesture total)
- Atomic deletion on pointer-up

### TextTool (PLACEHOLDER)
- DOM overlay contenteditable
- Returns `null` preview (DOM IS the preview)
- **Will be completely replaced**

### PanTool
- Screen-space delta → world pan offset via camera store
- Reads scale/pan from `useCameraStore.getState()`, calls `setPan()`
- Sets cursor override: `setCursorOverride('grabbing')` on begin, `null` on end

---

## Preview Types

```typescript
type PreviewData = StrokePreview | EraserPreview | PerfectShapePreview | SelectionPreview;

interface SelectionPreview {
  kind: 'selection';
  selectionBounds: WorldRect | null;
  marqueeRect: WorldRect | null;
  handles: { id: HandleId; x, y }[];
  isTransforming: boolean;
  selectedIds: string[];
}
```

---

## NOT Implemented / Planned

- **Connector Tool:** Sticky arrows to shapes (just basic polyline exists)
- **Text Tool:** Full replacement planned (current is placeholder DOM overlay)
- **Code Block Tool:** Placeholder in toolbar, shows "coming soon" toast
- **Shape labels:** Text inside shapes
- **Images**

---

## Spatial Index

```typescript
class ObjectSpatialIndex {
  insert(id, bbox, kind): void;
  update(id, oldBBox, newBBox, kind): void;
  remove(id, bbox): void;
  query(bounds): IndexEntry[];
  bulkLoad(handles): void;
}
```

**BBox includes stroke width:** `width * 0.5 + 1` inflation.

---

## Awareness & Presence

```typescript
{ userId, name, color, cursor?: {x,y}, activity: 'idle'|'drawing'|'typing',
  seq: number, ts: number, aw_v: 1 }
```
- Send rate: 15 Hz (8 Hz under backpressure)
- Cursor interpolation with 66ms window
- Presence updated via `updatePresenceCursor()` from room-runtime

---

## Key Invariants

1. **Each new object feature needs updates everywhere throughout the codebase:** UI Store, Bbox calculations, Y.map schema, Rbush hit testing, Snapshot/objectHandle, EraserTool, SelectTool behaviour for each scenario, Toolbar UI updates, etc.
2. **Y.Map is live:** Rendering reads directly from `handle.y.get()`
3. **ULID is z-order:** Sort by ULID for deterministic stacking
4. **Width affects bbox:** Width changes → bbox changes → cache eviction
5. **DPR applied once:** `ctx.setTransform(dpr, 0, 0, dpr, 0, 0)` at start
6. **userId is origin:** `ydoc.transact(fn, this.userId)` for undo tracking
7. **Camera store is imperative:** Tools/loops use `getState()`, not React subscriptions
8. **Tools are singletons:** Zero-arg constructors, created at module load, never destroyed
9. **Stroke/Shape Settings frozen at begin():**  Those tools freeze UI settings when gesture starts
10. **World coords everywhere:** Tools receive world coords, internal conversion as needed
11. **Cursor via store:** Use `setCursorOverride()` + `applyCursor()`, not direct DOM

---

## Quick Test Scenarios (SelectTool)

**Corner handles:**
1. Two strokes diagonal: Flip → positions preserved, geometry not inverted
2. Mixed stroke + shape: Flip → positions preserved
3. Single stroke: Flip → t=0.5 stays centered

**Side handles:**
1. Shapes-only: Opposite edge stays fixed
2. Mixed + anchor strokes: Stay pinned, jump by width at flip
3. Mixed + interior strokes: Translate toward anchor, jump at flip
