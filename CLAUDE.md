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

### Core Files
| File | Lines | Responsibility |
|------|-------|----------------|
| `client/src/lib/room-doc-manager.ts` | 2075 | Y.Doc lifecycle, providers, spatial index, snapshot publishing |
| `client/src/canvas/Canvas.tsx` | 960 | Pointer events, tool dispatch, snapshot subscription, dirty rect bridge |
| `client/src/renderer/RenderLoop.ts` | 528 | Base canvas 60 FPS loop, dirty rect optimization |
| `client/src/renderer/OverlayRenderLoop.ts` | 404 | Preview + presence rendering, eraser trail |
| `client/src/renderer/layers/objects.ts` | 763 | Object rendering dispatch, transform preview |
| `client/src/renderer/DirtyRectTracker.ts` | 267 | Dirty rect accumulation, promotion to full clear |
| `client/src/renderer/object-cache.ts` | 200 | Path2D cache by object ID |

### Tools
| File | Lines | Status |
|------|-------|--------|
| `client/src/lib/tools/SelectTool.ts` | 1585 | **Full** - Selection, translate, scale transforms |
| `client/src/lib/tools/DrawingTool.ts` | 659 | **Full** - Pen, highlighter, AND shape drawing |
| `client/src/lib/tools/EraserTool.ts` | 383 | **Full** - Geometry-aware hit testing |
| `client/src/lib/tools/TextTool.ts` | 325 | **PLACEHOLDER** - Will be completely replaced |
| `client/src/lib/tools/PanTool.ts` | 86 | **Full** - Viewport panning |
| `client/src/lib/tools/types.ts` | 140 | Preview types, HandleId, WorldRect |

### Stores
| File | Responsibility |
|------|----------------|
| `client/src/stores/device-ui-store.ts` | Toolbar state, drawing settings, colors (persisted) |
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
| `client/src/canvas/CanvasStage.tsx` | DOM container for canvases |

---

## Architecture Overview

### Data Flow
```
Y.Doc (source of truth)
   ↓ observers
RoomDocManager (objectsById, spatialIndex, dirtyPatch)
   ↓ 60 FPS RAF
Snapshot (immutable view)
   ↓ subscription
Canvas.tsx → RenderLoop (base) + OverlayRenderLoop (preview)
```

### Write Path
```
Tool.commit() → roomDoc.mutate(fn) → ydoc.transact() → Y.Map.set()
   → Observer fires → applyObjectChanges() → dirtyPatch computed
   → Snapshot published → Canvas invalidates dirty rects
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
subscribeSnapshot(cb)       // 60 FPS snapshots
```

---

## Rendering Pipeline

### Two-Canvas Architecture
- **Base Canvas:** World content, dirty-rect optimized, 60 FPS (8 FPS hidden tab)
- **Overlay Canvas:** Full clear, preview + presence, pointer-events: none

### Dirty Rect Flow
```
Canvas.tsx (snapshot.dirtyPatch)
   → cache.evictMany(evictIds)
   → renderLoop.invalidateWorld(bounds)
   → DirtyRectTracker accumulates
   → Promotion check (>64 rects OR >33% area → full clear)
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

### Coordinate Spaces
- **World:** Logical document coords
- **CSS pixels:** Browser coords
- **Device pixels:** Physical pixels (CSS × DPR)

```typescript
worldToCanvas: [(x - pan.x) * scale, (y - pan.y) * scale]
canvasToWorld: [x / scale + pan.x, y / scale + pan.y]
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
- Screen-space delta → world pan offset
- Sets `grabbing` cursor

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

## Device UI Store

```typescript
interface DeviceUIState {
  activeTool: 'pen'|'highlighter'|'eraser'|'text'|'pan'|'select'|'shape'|'image'|'code';
  drawingSettings: { size: 10|14|18|22; color: string; opacity: number; fill: boolean };
  highlighterOpacity: 0.45;  // Fixed
  textSize: 20|30|40|50;
  shapeVariant: 'diamond'|'rectangle'|'ellipse'|'arrow';
}
```

Tools read settings at `begin()` via `getState()`.

---

## NOT Implemented / Planned

- **Connector Tool:** Sticky arrows to shapes (just basic polyline exists)
- **Text Tool:** Full replacement planned (current is placeholder DOM overlay)
- **Code Block Tool:** Placeholder in toolbar, shows "coming soon" toast
- **Shape labels:** Text inside shapes
- **Code/outputs:** Legacy Y.Array, future migration to Y.Map

---

## Stale / To Remove

- `client/src/renderer/stroke-builder/path-builder.ts` - Marked for removal (legacy)
- Dormant size guards, mobile restrictions, TTL checks - Will be removed

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

---

## Key Invariants

1. **Points are tuples:** `[number, number][]` never flattened
2. **Y.Map is live:** Rendering reads directly from `handle.y.get()`
3. **ULID is z-order:** Sort by ULID for deterministic stacking
4. **Width affects bbox:** Width changes → bbox changes → cache eviction
5. **DPR applied once:** `ctx.setTransform(dpr, 0, 0, dpr, 0, 0)` at start
6. **userId is origin:** `ydoc.transact(fn, this.userId)` for undo tracking

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
