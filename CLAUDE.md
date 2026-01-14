# AVLO Codebase Guide

**Purpose:** Offline-first collaborative whiteboard with Yjs CRDT sync.
**Stack:** React/TS/Canvas + Yjs + Cloudflare Workers/R2

## Commands
```bash
npm run dev          # Client :3000 + Worker :8787 (DON'T START WITHOUT PERMISSION)
npm run typecheck    # Type check all workspaces (RUN FROM ROOT!)
```

**Aliases:** `@avlo/shared` → `packages/shared/src/*` | `@/*` → `client/src/*`

---

## File Map

### Canvas System
| File | Responsibility |
|------|----------------|
| `canvas/Canvas.tsx` | Thin React wrapper - mounts DOM, sets room context |
| `canvas/CanvasRuntime.ts` | Central orchestrator - events, subscriptions, tool dispatch |
| `canvas/SurfaceManager.ts` | DOM refs (contexts, editorHost) + resize/DPR |
| `canvas/InputManager.ts` | DOM event forwarder |
| `canvas/tool-registry.ts` | Tool singletons + `getCurrentTool()`, `getActivePreview()` |
| `canvas/room-runtime.ts` | Module-level room context: `getActiveRoomDoc()`, `getCurrentSnapshot()` |
| `canvas/invalidation-helpers.ts` | `invalidateWorld()`, `invalidateOverlay()` |

### Renderer
| File | Responsibility |
|------|----------------|
| `renderer/RenderLoop.ts` | Base canvas 60fps, dirty-rect optimization |
| `renderer/OverlayRenderLoop.ts` | Preview + presence rendering |
| `renderer/layers/objects.ts` | Object rendering dispatch + transform preview |
| `renderer/object-cache.ts` | Path2D cache by object ID |

### Tools (`lib/tools/`)
| File | Status |
|------|--------|
| `SelectTool.ts` | Full - selection, translate, scale transforms |
| `DrawingTool.ts` | Full - pen, highlighter, perfect shapes |
| `EraserTool.ts` | Full - geometry-aware hit testing |
| `ConnectorTool.ts` | **In Progress** - orthogonal routing (see `docs/CONNECTOR_ROUTING_SYSTEM.md`) |
| `TextTool.ts` | Placeholder - DOM overlay |
| `PanTool.ts` | Full - viewport panning |

### Stores
| File | Key Exports |
|------|-------------|
| `stores/camera-store.ts` | `screenToWorld()`, `worldToCanvas()`, `getVisibleWorldBounds()`, `setPan()`, `setScale()` |
| `stores/device-ui-store.ts` | `activeTool`, `drawingSettings`, `setCursorOverride()`, `applyCursor()` |
| `stores/selection-store.ts` | `selectedIds`, `transform`, `marquee` |

### Geometry (`lib/geometry/`)
- `hit-test-primitives.ts` - Shared hit testing (stroke, shape, diamond, ellipse)
- `scale-transform.ts` - Scale math for SelectTool
- `recognize-open-stroke.ts` - Shape recognition pipeline
- `geometry-helpers.ts` - Corner/edge detection, PCA

### Connectors (`lib/connectors/`) - **In Active Development**
See `docs/CONNECTOR_ROUTING_SYSTEM.md` for full details. Key files:
- `routing.ts` - Entry point, dispatches Z-route or A*
- `routing-grid.ts` - Non-uniform grid with centerlines
- `routing-astar.ts` - A* pathfinding with obstacle avoidance
- `snap.ts` - Shape snapping with midpoint hysteresis

### Shared Package (`packages/shared/src/`)
| File | Key Types |
|------|-----------|
| `types/objects.ts` | `ObjectKind`, `ObjectHandle`, `IndexEntry`, `DirtyPatch` |
| `types/snapshot.ts` | `Snapshot`, `ViewTransform` |
| `spatial/object-spatial-index.ts` | RBush R-tree wrapper |
| `utils/bbox.ts` | BBox computation with stroke width inflation |

---

## Architecture

### System Hierarchy
```
Canvas.tsx (thin wrapper)
└── CanvasRuntime.ts (the brain)
    ├── SurfaceManager     - DOM refs, resize, DPR
    ├── RenderLoop         - base canvas, dirty-rect
    ├── OverlayRenderLoop  - preview + presence
    ├── ZoomAnimator       - smooth zoom
    ├── InputManager       - DOM events
    └── Subscriptions: camera-store, snapshot
```

### Data Flow
```
Y.Doc (source of truth)
   ↓ observers
RoomDocManager → objectsById, spatialIndex, dirtyPatch
   ↓ subscribeSnapshot()
CanvasRuntime → cache.evictMany(), renderLoop.invalidateWorld()
   ↓
RenderLoop / OverlayRenderLoop
```

### Write Path
```
Tool.begin/move/end() → getActiveRoomDoc().mutate(fn)
   → ydoc.transact() → Observer fires → dirtyPatch computed
   → Snapshot published → dirty rects invalidated
```

---

## PointerTool Interface

All tools implement this (see `lib/tools/types.ts`):

```typescript
interface PointerTool {
  canBegin(): boolean;
  begin(pointerId, worldX, worldY): void;
  move(worldX, worldY): void;
  end(worldX?, worldY?): void;
  cancel(): void;
  isActive(): boolean;
  getPointerId(): number | null;
  getPreview(): PreviewData | null;
  onPointerLeave(): void;
  onViewChange(): void;
  destroy(): void;
}
```

**Key:** All tools receive **world coordinates**. Convert via `worldToCanvas()` if needed.

### Tool Singletons
Tools are zero-arg constructors, created at module load:
```typescript
// tool-registry.ts
const drawingTool = new DrawingTool();  // handles pen, highlighter, shape
const toolMap = { 'pen': drawingTool, 'highlighter': drawingTool, ... }
```

Dependencies read at runtime: `useDeviceUIStore.getState()`, `getActiveRoomDoc()`

---

## Y.Doc Structure (v2)

```
Y.Doc { guid: roomId }
└─ root: Y.Map
   ├─ v: 2
   ├─ objects: Y.Map<Y.Map>  // All objects by ULID
   └─ meta: Y.Map            // TTL timestamps
```

### Object Kinds
```typescript
type ObjectKind = 'stroke' | 'shape' | 'text' | 'connector';
```

### Object Schemas

**Stroke:**
```typescript
{ id, kind: 'stroke', tool: 'pen'|'highlighter', color, width, opacity,
  points: [number, number][], ownerId, createdAt }
```

**Shape:**
```typescript
{ id, kind: 'shape', shapeType: 'rect'|'ellipse'|'diamond'|'roundedRect',
  color, width, opacity, fillColor?, frame: [x, y, w, h], ownerId, createdAt }
```

**Connector:**
```typescript
{ id, kind: 'connector', fromX, fromY, toX, toY, waypoints: [number,number][],
  fromShapeId?, fromSide?, fromT?, toShapeId?, toSide?, toT?,
  color, width, opacity, startCap?, endCap?, ownerId, createdAt }
```

**Text:**
```typescript
{ id, kind: 'text', frame: [x,y,w,h], text, color, fontSize,
  fontFamily, fontWeight, fontStyle, textAlignH, opacity, ownerId, createdAt }
```

### ObjectHandle (Live Reference)
```typescript
interface ObjectHandle {
  id: string;              // ULID
  kind: ObjectKind;
  y: Y.Map<any>;           // LIVE Y.Map - rendering reads directly!
  bbox: [minX, minY, maxX, maxY];
}
```

---

## RoomDocManager

### Two-Epoch Model
1. **Rebuild:** `hydrateObjectsFromY()` → build handles → `bulkLoad()` spatial index
2. **Steady-State:** Deep observer → incremental updates → `dirtyPatch`

### Gates
| Gate | Opens When |
|------|-----------|
| `idbReady` | IndexedDB loaded (2s timeout) |
| `wsConnected` | WebSocket opens (5s) |
| `wsSynced` | First Y.Doc sync (10s) |

### Key Methods
```typescript
mutate(fn)           // Transact with userId origin
undo() / redo()      // Y.UndoManager (500ms capture)
subscribeSnapshot()  // Doc-only
subscribePresence()  // Presence-only
```

---

## SelectTool

### State Machine
```typescript
type Phase = 'idle' | 'pendingClick' | 'marquee' | 'translate' | 'scale';
```

### Handle System
```typescript
type HandleId = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';
```
Scale origin is **opposite** edge/corner from dragged handle.

### Selection Kinds
```typescript
type SelectionKind = 'none' | 'strokesOnly' | 'shapesOnly' | 'mixed';
```

### Transform Behaviors (Brief)
- **strokesOnly:** Uniform scale, position preserved
- **shapesOnly:** Non-uniform (independent X/Y)
- **mixed corner:** Uniform for both
- **mixed side:** Strokes translate only, shapes scale

See `scale-transform.ts` for math details.

---

## Preview Types

```typescript
type PreviewData = StrokePreview | EraserPreview | PerfectShapePreview
                 | SelectionPreview | ConnectorPreview;
```

Each tool's `getPreview()` returns its preview type for overlay rendering.

---

## Coordinate Spaces

- **World:** Logical document coords (tools operate here)
- **CSS pixels:** Browser coords
- **Device pixels:** Physical pixels (CSS × DPR)

```typescript
worldToCanvas: [(x - pan.x) * scale, (y - pan.y) * scale]
canvasToWorld: [x / scale + pan.x, y / scale + pan.y]
```

---

## Cursor Management

```typescript
// Set override (e.g., during pan)
setCursorOverride('grabbing');  // from device-ui-store
setCursorOverride(null);        // clear override

// Applies cursor based on active tool or override
applyCursor();
```

---

## Key Invariants

1. **Y.Map is live:** Rendering reads directly via `handle.y.get('color')`
2. **ULID is z-order:** Sort by ULID for deterministic stacking
3. **Width affects bbox:** Width changes → bbox changes → cache eviction
4. **DPR applied once:** `ctx.setTransform(dpr, 0, 0, dpr, 0, 0)` at frame start
5. **userId is origin:** `ydoc.transact(fn, this.userId)` for undo tracking
6. **Camera store is imperative:** Tools use `getState()`, not React subscriptions
7. **Tools are singletons:** Zero-arg constructors, created at module load
8. **Settings frozen at begin():** Drawing tools freeze UI settings when gesture starts
9. **World coords everywhere:** Tools receive world coords from CanvasRuntime
10. **Cursor via store:** Use `setCursorOverride()`, not direct DOM manipulation

---

## Module Access Patterns

```typescript
// Room context (throws if no room)
getActiveRoomDoc()         // room-runtime.ts
getCurrentSnapshot()       // room-runtime.ts

// Camera/viewport
useCameraStore.getState()  // imperative
screenToWorld(clientX, clientY)
getVisibleWorldBounds()

// UI state
useDeviceUIStore.getState().activeTool
useDeviceUIStore.getState().drawingSettings

// Invalidation
invalidateWorld(bounds)    // invalidation-helpers.ts
invalidateOverlay()

// Rendering contexts
getBaseContext()           // SurfaceManager.ts
getOverlayContext()
```

---

## Spatial Index

```typescript
class ObjectSpatialIndex {
  insert(id, bbox, kind): void;
  update(id, oldBBox, newBBox, kind): void;
  remove(id, bbox): void;
  query(bounds): IndexEntry[];
}
```

**BBox includes stroke width:** `width * 0.5 + 1` inflation.

---

## In Progress / Planned

- **Connector Tool:** Orthogonal routing with obstacle avoidance (active development)
- **Text Tool:** Full replacement planned
- **Images:** Not implemented
- **Code Blocks:** Placeholder only

---

## Quick Reference

### Committing Objects
```typescript
getActiveRoomDoc().mutate((root) => {
  const objects = root.get('objects') as Y.Map<Y.Map<any>>;
  const obj = new Y.Map();
  obj.set('id', ulid());
  obj.set('kind', 'stroke');
  // ... set other properties
  objects.set(obj.get('id'), obj);
});
```

### Reading Object Properties
```typescript
const handle = snapshot.objectsById.get(id);
const color = handle.y.get('color');
const points = handle.y.get('points');
```

### Tool Lifecycle
```typescript
class MyTool implements PointerTool {
  begin(pointerId, worldX, worldY) {
    // Freeze settings from stores
    this.settings = useDeviceUIStore.getState().drawingSettings;
  }
  move(worldX, worldY) {
    // Update preview state
    invalidateOverlay();
  }
  end() {
    // Commit to Y.Doc
    getActiveRoomDoc().mutate(...);
    holdPreviewForOneFrame();  // Prevents flash
  }
}
```
