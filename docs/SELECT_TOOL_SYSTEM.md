# SelectTool System - Technical Reference

> **Purpose:** Comprehensive documentation of the SelectTool subsystem for future modifications (connector endpoint editing integration).
>
> **Note:** Connectors are currently grouped with strokes in selection logic. A future change will separate connectors entirely to enable anchor-aware endpoint rendering and editing.

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [State Machine](#state-machine)
3. [Selection Store](#selection-store)
4. [Hit Testing System](#hit-testing-system)
5. [Selection Kinds & Transform Dispatch](#selection-kinds--transform-dispatch)
6. [Bounds Calculation (Two Types)](#bounds-calculation-two-types)
7. [Scale Factor Computation](#scale-factor-computation)
8. [Transform Application](#transform-application)
9. [Rendering Pipeline](#rendering-pipeline)
10. [Commit Flow](#commit-flow)
11. [Overlay Rendering](#overlay-rendering)
12. [Key Invariants](#key-invariants)

---

## Architecture Overview

### File Dependencies

```
SelectTool.ts
├── selection-store.ts       # State: selectedIds, transform, marquee
├── geometry/transform.ts    # Scale math, frame transforms
├── geometry/bounds.ts       # WorldBounds manipulation
├── geometry/hit-testing.ts  # Object & handle hit detection
├── room-runtime.ts          # getCurrentSnapshot(), getActiveRoomDoc()
├── invalidation-helpers.ts  # invalidateWorld(), invalidateOverlay()
├── camera-store.ts          # worldToCanvas, scale
└── device-ui-store.ts       # applyCursor, setCursorOverride
```

### Data Flow Summary

```
User Gesture
    │
    ▼
SelectTool (state machine)
    │
    ├── Hit Testing ──────────────────────┐
    │                                      │
    ├── Selection Store (transform state)  │
    │        │                             │
    │        ▼                             │
    │   Render Pipeline ◄──────────────────┘
    │   (objects.ts)        (reads selectedIds + transform)
    │        │
    │        ▼
    │   Preview Data ──────► OverlayRenderLoop
    │                        (selection-overlay.ts)
    │
    └── Commit ──► Y.Doc Mutation
```

---

## State Machine

### Phase Enum

```typescript
type Phase = 'idle' | 'pendingClick' | 'marquee' | 'translate' | 'scale';
```

| Phase | Description |
|-------|-------------|
| `idle` | No active gesture; handles hover cursor detection |
| `pendingClick` | Pointer down detected, waiting for move threshold or release |
| `marquee` | Drag-selecting multiple objects with rectangle |
| `translate` | Dragging selected objects |
| `scale` | Resizing selected objects via handle |

### Target Classification (at pointer down)

```typescript
type DownTarget =
  | 'none'
  | 'handle'                   // Clicked resize handle
  | 'objectInSelection'        // Clicked object that IS selected
  | 'objectOutsideSelection'   // Clicked object that is NOT selected
  | 'selectionGap'             // Empty space INSIDE selection bounds
  | 'background';              // Empty space OUTSIDE selection bounds
```

### Decision Matrix

**From `pendingClick` phase:**

| Target | Move Threshold Passed | Action |
|--------|----------------------|--------|
| `handle` | Yes | → `scale` phase |
| `objectOutsideSelection` | Yes | Select object → `translate` phase |
| `objectInSelection` | Yes | Keep selection → `translate` phase |
| `selectionGap` | Yes (or time threshold) | Keep selection → `translate` phase |
| `background` | Yes (or time threshold) | Clear selection → `marquee` phase |

**On release without drag (click behavior):**

| Target | Click Action |
|--------|--------------|
| `handle` | No-op |
| `objectOutsideSelection` | Select only that object |
| `objectInSelection` | If multi-select: drill down to single object |
| `selectionGap` | Quick tap: deselect. Long hold: keep selection |
| `background` | Deselect all |

### Thresholds

```typescript
const HIT_RADIUS_PX = 6;       // Screen-space hit radius
const HIT_SLACK_PX = 2.0;      // Forgiving feel for precision
const MOVE_THRESHOLD_PX = 4;   // Pixels before drag detected
const CLICK_WINDOW_MS = 180;   // Time threshold for gap click disambiguation
```

### Phase Transition Diagram

```
                         ┌──────────────────────────────────────┐
                         │                                      │
                         ▼                                      │
┌──────┐  pointerDown  ┌──────────────┐  release  ┌──────────┐ │
│ idle │ ──────────► │ pendingClick │ ────────► │ (click)  │──┘
└──────┘               └──────────────┘           └──────────┘
   ▲                         │
   │                         │ drag detected
   │                         ▼
   │        ┌────────────────┬────────────────────┐
   │        │                │                    │
   │        ▼                ▼                    ▼
   │   ┌─────────┐     ┌───────────┐       ┌──────────┐
   │   │ marquee │     │ translate │       │  scale   │
   │   └────┬────┘     └─────┬─────┘       └────┬─────┘
   │        │                │                  │
   └────────┴────────────────┴──────────────────┘
                  pointerUp
```

---

## Selection Store

### State Interface

```typescript
interface SelectionState {
  selectedIds: string[];              // Object IDs (ULIDs)
  mode: 'none' | 'single' | 'multi';  // Derived from selectedIds.length
  transform: TransformState;          // Active transform (none/translate/scale)
  marquee: MarqueeState;              // Active marquee selection
}
```

### Transform State Types

```typescript
interface TranslateTransform {
  kind: 'translate';
  dx: number;                    // World-space X offset
  dy: number;                    // World-space Y offset
  originBounds: WorldRect;       // Bounds before transform started
}

interface ScaleTransform {
  kind: 'scale';
  origin: [number, number];      // Fixed point (opposite handle)
  scaleX: number;                // Current X scale factor
  scaleY: number;                // Current Y scale factor
  originBounds: WorldRect;       // GEOMETRY-based bounds (no stroke padding)
  bboxBounds: WorldRect;         // PADDED bounds (for dirty rect invalidation)
  handleId: HandleId;            // Which handle being dragged
  selectionKind: SelectionKind;  // strokesOnly/shapesOnly/mixed
  handleKind: HandleKind;        // corner/side (derived from handleId)
  initialDelta: [number, number]; // Distance from origin to click position
}
```

**Critical:** `originBounds` vs `bboxBounds`:
- `originBounds`: Geometry-only bounds for transform math (prevents anchor sliding)
- `bboxBounds`: Stroke-padded bounds for dirty rect invalidation

### Marquee State

```typescript
interface MarqueeState {
  active: boolean;
  anchor: [number, number] | null;   // World coords where marquee started
  current: [number, number] | null;  // World coords of current cursor
}
```

### Key Actions

| Action | Purpose |
|--------|---------|
| `setSelection(ids)` | Set selection, clear transform/marquee |
| `clearSelection()` | Clear all state |
| `beginTranslate(originBounds)` | Start translate with dx=0, dy=0 |
| `updateTranslate(dx, dy)` | Update translate delta |
| `beginScale(...)` | Start scale with computed handleKind |
| `updateScale(scaleX, scaleY)` | Update scale factors |
| `endTransform()` | Clear transform state |
| `beginMarquee(anchor)` | Start marquee at anchor point |
| `updateMarquee(current)` | Update marquee current position |

### Handle Helpers (selection-store.ts)

```typescript
// Check if handle is corner (vs side)
function isCornerHandle(handleId: HandleId): boolean {
  return handleId === 'nw' || handleId === 'ne' || handleId === 'se' || handleId === 'sw';
}

// Compute corner handle positions
function computeHandles(bounds: WorldBounds): { id: HandleId; x: number; y: number }[];

// Get scale origin (opposite of dragged handle)
function getScaleOrigin(handleId: HandleId, bounds: WorldBounds): [number, number];

// Get cursor CSS for handle
function getHandleCursor(handleId: HandleId): string;
```

---

## Hit Testing System

### Overview

Hit testing determines what object (if any) the cursor is over. Located in `geometry/hit-testing.ts`.

### HitCandidate Interface

```typescript
interface HitCandidate {
  id: string;                  // Object ID (ULID for Z-order)
  kind: 'stroke' | 'shape' | 'text' | 'connector';
  distance: number;            // Distance to geometry edge
  insideInterior: boolean;     // Inside shape bounds (not edge)
  area: number;                // Bounding area for priority
  isFilled: boolean;           // Has fill color (shapes only)
}
```

### Hit Test Flow

```
hitTestObjects(worldX, worldY)
    │
    ├── Query spatial index (R-tree) with hit radius
    │
    ├── For each candidate:
    │   └── testObjectHit() → HitCandidate | null
    │
    └── pickBestCandidate(candidates) → Z-order aware selection
```

### Object Hit Testing by Kind

| Kind | Hit Logic |
|------|-----------|
| **stroke/connector** | `strokeHitTest()` - tests each segment against tolerance (width/2 + radius) |
| **shape** | `shapeHitTest()` → `pointInsideShape()` for interior, `shapeEdgeHitTest()` for edge |
| **text** | Uses rect hit test on frame |

### Z-Order Aware Selection (`pickBestCandidate`)

Key insight: Unfilled shape interiors are "transparent" - we scan through to find paint underneath.

```typescript
// Classification
type PaintClass = 'ink' | 'fill';

// isFrameInterior: unfilled shape interior = transparent
const isFrameInterior = (c) => c.kind === 'shape' && !c.isFilled && c.insideInterior;

// classifyPaint: what type of paint (if any) this hit represents
const classifyPaint = (c): PaintClass | null => {
  if (stroke/connector/text) return 'ink';
  if (shape && filled) return 'fill';
  if (shape && !filled && !interior) return 'ink';  // border
  return null;  // unfilled interior = transparent
};
```

**Selection Priority:**
1. Sort candidates by ULID descending (topmost first)
2. Scan from top to bottom
3. Skip transparent regions (track smallest for fallback)
4. Stop at first paint (ink/fill)
5. Compare ink vs frames by area (smaller wins)

### Handle Hit Testing

```typescript
function hitTestHandle(worldX, worldY, bounds, scale): HandleId | null {
  // 1. Test corners first (they take priority)
  // 2. Test side edges (not rendered, but for cursor/scaling)
}

const HANDLE_HIT_PX = 10;  // Screen-space radius
```

Side handles (`n`, `s`, `e`, `w`) are not rendered but can be clicked for resize.

### Marquee Intersection

```typescript
function objectIntersectsRect(handle: ObjectHandle, rect: WorldRect): boolean {
  // Stroke/connector: polylineIntersectsRect
  // Shape: depends on shapeType (ellipse, diamond, rect)
  // Text: rect intersection
}
```

Uses precise geometry intersection, not just bbox overlap.

---

## Selection Kinds & Transform Dispatch

### Selection Kind

```typescript
type SelectionKind = 'none' | 'strokesOnly' | 'shapesOnly' | 'mixed';
```

Computed from selected object kinds:

```typescript
function computeSelectionKind(selectedIds): SelectionKind {
  let hasStrokes = false;  // includes connectors!
  let hasShapes = false;   // includes text

  for (id of selectedIds) {
    if (handle.kind === 'stroke' || handle.kind === 'connector') hasStrokes = true;
    else hasShapes = true;
  }

  if (hasStrokes && hasShapes) return 'mixed';
  if (hasStrokes) return 'strokesOnly';
  if (hasShapes) return 'shapesOnly';
  return 'none';
}
```

**Note:** Connectors are currently grouped with strokes. Future work will separate them.

### Handle Kind

```typescript
type HandleKind = 'corner' | 'side';
// Derived from HandleId: nw/ne/se/sw = corner, n/s/e/w = side
```

### Transform Behavior Matrix

| SelectionKind | HandleKind | Strokes | Shapes |
|---------------|------------|---------|--------|
| `strokesOnly` | `corner` | Uniform scale, position preserved | N/A |
| `strokesOnly` | `side` | Uniform scale (single axis) | N/A |
| `shapesOnly` | `corner` | N/A | Non-uniform (X/Y independent) |
| `shapesOnly` | `side` | N/A | Non-uniform (single axis) |
| `mixed` | `corner` | Uniform, position preserved | Uniform, position preserved |
| `mixed` | `side` | **TRANSLATE only** (edge-pin) | Non-uniform |

**Key Behaviors:**

1. **Strokes never invert geometry on flip** - uses absolute magnitude scale
2. **Strokes preserve position** - center maintains relative position in selection box
3. **Stroke width scales** - WYSIWYG behavior
4. **Shape stroke width unchanged** - only geometry scales
5. **Mixed + side + stroke = translate** - edge-pinning behavior

---

## Bounds Calculation (Two Types)

### Selection Bounds (Padded/Visual)

`computeSelectionBounds()` - Used for:
- Selection box display
- Handle positioning
- Visual dirty rect coverage

```typescript
private computeSelectionBounds(): WorldRect | null {
  // Union of all selected objects' bbox (which includes stroke padding)
  for (const id of selectedIds) {
    const handle = snapshot.objectsById.get(id);
    result = expandEnvelope(result, bboxTupleToWorldBounds(handle.bbox));
  }
  return result;
}
```

### Transform Bounds (Geometry-Only)

`computeTransformBoundsForScale()` - Used for:
- Scale origin computation
- Position preservation math

```typescript
private computeTransformBoundsForScale(): WorldRect | null {
  // Uses computeRawGeometryBounds() from bounds.ts
  // - Shapes/text: raw frame [x, y, w, h]
  // - Strokes/connectors: raw points min/max (no width inflation)
}
```

**Why two bounds?**

Stroke objects have `bbox = geometry + width/2` padding. If we used padded bbox for scale origin, the anchor point would "slide" as stroke width changes during scale. Geometry bounds ensure stable anchor positioning.

### Bounds Helper Functions (bounds.ts)

```typescript
// Union two bounds
unionBounds(a, b): WorldBounds

// Accumulator pattern (never shrinks)
expandEnvelope(envelope, bounds): WorldBounds

// Transform helpers
translateBounds(bounds, dx, dy): WorldBounds
scaleBoundsAround(bounds, origin, scaleX, scaleY): WorldBounds  // auto-normalizes for flip

// Construction
pointsToWorldBounds(p1, p2): WorldBounds  // for marquee
frameTupleToWorldBounds(frame): WorldBounds

// Raw geometry extraction
computeRawGeometryBounds(handles): WorldBounds | null
```

---

## Scale Factor Computation

Located in `geometry/transform.ts`.

### From Cursor Position

```typescript
function computeScaleFactors(worldX, worldY, transform): { scaleX, scaleY } {
  const { origin, initialDelta, handleId } = transform;

  // Vector from origin to cursor
  const dx = worldX - origin[0];
  const dy = worldY - origin[1];

  // initialDelta = distance from origin to click position
  // This ensures scale=1.0 exactly when cursor == downWorld

  if (isCorner) {
    scaleX = dx / initialDelta[0];
    scaleY = dy / initialDelta[1];
  } else if (isSideH) {
    scaleX = dx / initialDelta[0];
    scaleY = 1;  // Y locked
  } else if (isSideV) {
    scaleX = 1;  // X locked
    scaleY = dy / initialDelta[1];
  }
}
```

### Uniform Scale Computation (for strokes)

```typescript
function computeUniformScaleNoThreshold(scaleX, scaleY): number {
  // Returns single uniform scale with flip handling
  // - Both negative → immediate flip
  // - Side handles → use active axis only
  // - Corner → use dominant axis, immediate flip when < 0
}
```

### Position Preservation

```typescript
function computePreservedPosition(cx, cy, originBounds, origin, uniformScale): [x, y] {
  // Computes new center position that maintains relative arrangement
  // When flipping, objects maintain their 0-1 position within selection box
  // (not inverted as would happen with raw scale math)
}
```

---

## Transform Application

### During Gesture (Preview)

**Translation:** Uses `ctx.translate()` with cached Path2D - efficient

**Scale:** Per-frame rendering dispatch based on selectionKind + handleKind

### Commit Transform Functions

```typescript
// Translation: offset points or frame
private commitTranslate(selectedIds, dx, dy) {
  for (id of selectedIds) {
    if (stroke/connector) {
      // Offset all points
      newPoints = points.map(([x, y]) => [x + dx, y + dy]);
      yMap.set('points', newPoints);
    } else {
      // Offset frame
      yMap.set('frame', [x + dx, y + dy, w, h]);
    }
  }
}

// Scale: context-aware per-object transform
private commitScale(selectedIds, origin, scaleX, scaleY, handleId, selectionKind, handleKind, originBounds) {
  for (id of selectedIds) {
    if (mixed && side && stroke) {
      // TRANSLATE ONLY
      const { dx, dy } = computeStrokeTranslation(...);
      yMap.set('points', translated);
    } else if (stroke) {
      // Uniform scale with position preservation
      const { points, absScale } = applyUniformScaleToPoints(...);
      yMap.set('points', points);
      yMap.set('width', width * absScale);  // Scale stroke width!
    } else if (mixed && corner && shape) {
      // Uniform scale (matches stroke behavior)
      yMap.set('frame', applyUniformScaleToFrame(...));
    } else {
      // Non-uniform scale
      yMap.set('frame', applyTransformToFrame(...));
    }
  }
}
```

---

## Rendering Pipeline

### Overview

During active transform, selected objects are rendered with transform applied **on the base canvas** (not overlay) to maintain correct Z-order with non-selected objects.

### Render Flow (objects.ts)

```typescript
function drawObjects(ctx, snapshot, viewTransform, viewport) {
  // 1. Read selection state
  const { selectedIds, transform } = useSelectionStore.getState();
  const selectedSet = new Set(selectedIds);
  const isTransforming = transform.kind !== 'none';

  // 2. Query and sort by ULID (oldest first = correct Z-order)
  const sortedCandidates = spatialIndex.query(visibleBounds)
    .sort((a, b) => a.id < b.id ? -1 : 1);

  // 3. For each object
  for (entry of sortedCandidates) {
    const isSelected = selectedSet.has(entry.id);
    const needsTransform = isTransforming && isSelected;

    if (needsTransform) {
      if (transform.kind === 'translate') {
        // Use ctx.translate() with cached Path2D
        ctx.save();
        ctx.translate(transform.dx, transform.dy);
        drawObject(ctx, handle);  // cached path
        ctx.restore();
      } else if (transform.kind === 'scale') {
        // Context-aware rendering dispatch
        renderSelectedObjectWithScaleTransform(ctx, handle, transform);
      }
    } else {
      drawObject(ctx, handle);  // cached path
    }
  }
}
```

### Scale Transform Rendering Dispatch

```typescript
function renderSelectedObjectWithScaleTransform(ctx, handle, transform) {
  const { selectionKind, handleKind } = transform;
  const isStroke = handle.kind === 'stroke' || handle.kind === 'connector';

  // CASE 1: Mixed + side + stroke = TRANSLATE ONLY
  if (selectionKind === 'mixed' && handleKind === 'side' && isStroke) {
    const { dx, dy } = computeStrokeTranslation(...);
    ctx.translate(dx, dy);
    drawObject(ctx, handle);  // cached Path2D
    return;
  }

  // CASE 2: Stroke scaling = fresh PerfectFreehand per frame
  if (isStroke) {
    drawScaledStrokePreview(ctx, handle, transform);
    // Generates new Path2D with scaled points + scaled width
    return;
  }

  // CASE 3: Shape scaling
  if (handle.kind === 'shape') {
    if (selectionKind === 'mixed' && handleKind === 'corner') {
      drawShapeWithUniformScale(ctx, handle, transform);  // uniform
    } else {
      drawShapeWithTransform(ctx, handle, transform);      // non-uniform
    }
    return;
  }

  // CASE 4: Text
  if (handle.kind === 'text') {
    // Similar dispatch...
  }
}
```

### Shape Rendering During Scale

```typescript
function drawShapeWithTransform(ctx, handle, transform) {
  // 1. Get original frame, compute transformed frame
  const transformedFrame = applyTransformToFrame(frame, transform);

  // 2. Build fresh Path2D from transformed frame (not cached)
  const path = buildShapePathFromFrame(shapeType, transformedFrame);

  // 3. Draw with ORIGINAL stroke width (not scaled)
  ctx.lineWidth = width;  // Shape stroke width never scales
  ctx.fill(path);
  ctx.stroke(path);
}
```

### Stroke Rendering During Scale

```typescript
function drawScaledStrokePreview(ctx, handle, transform) {
  // 1. Apply uniform scale with position preservation
  const { points: scaledPoints, absScale } = applyUniformScaleToPoints(
    points, bbox, originBounds, origin, scaleX, scaleY
  );

  // 2. Scale width for WYSIWYG
  const scaledWidth = originalWidth * absScale;

  // 3. Generate FRESH PerfectFreehand outline (not cached)
  const outline = getStroke(scaledPoints, { size: scaledWidth, ... });
  const path = new Path2D(getSvgPathFromStroke(outline));

  // 4. Fill (strokes are filled polygons)
  ctx.fill(path);
}
```

---

## Commit Flow

### Sequence

```
SelectTool.end()
    │
    ├── Read final transform from store
    │
    ├── Clear transform BEFORE mutate (prevents double-transform glitch)
    │   └── store.endTransform()
    │
    ├── Skip if no actual change (dx=0/dy=0 or scale=1)
    │
    └── Mutate Y.Doc
        └── commitTranslate() or commitScale()
            └── roomDoc.mutate((ydoc) => { ... })
```

### Y.Doc Mutation Pattern

```typescript
getActiveRoomDoc().mutate((ydoc: Y.Doc) => {
  const objects = ydoc.getMap('root').get('objects') as Y.Map<Y.Map<unknown>>;

  for (const id of selectedIds) {
    const yMap = objects.get(id);
    // Apply transform to stored data
    yMap.set('points', newPoints);  // or 'frame', 'width', etc.
  }
});
```

---

## Overlay Rendering

### SelectionPreview Type

```typescript
interface SelectionPreview {
  kind: 'selection';
  selectionBounds: WorldRect | null;
  marqueeRect: WorldRect | null;
  handles: { id: HandleId; x: number; y: number }[] | null;
  isTransforming: boolean;
  selectedIds: string[];
}
```

### getPreview() Logic

```typescript
getPreview(): PreviewData | null {
  // 1. Compute marquee rect if active
  if (marquee.active) {
    marqueeRect = pointsToWorldBounds(marquee.anchor, marquee.current);
  }

  // 2. Compute selection bounds with transform applied
  if (selectedIds.length > 0) {
    // During scale: use originBounds (geometry-based)
    // During idle/translate: use bbox-based bounds
    baseBounds = transform.kind === 'scale'
      ? transform.originBounds
      : this.computeSelectionBounds();

    selectionBounds = applyTransformToBounds(baseBounds, transform);
    handles = computeHandles(selectionBounds);
  }

  // 3. Hide handles during transform
  return {
    kind: 'selection',
    selectionBounds,
    marqueeRect,
    handles: isTransforming ? null : handles,
    isTransforming,
    selectedIds,
  };
}
```

### Selection Overlay Drawing (selection-overlay.ts)

Renders three phases:

1. **Object highlights** (when not transforming)
   - Strokes/connectors: bbox rectangle
   - Shapes: cached Path2D stroke
   - Text: frame rectangle

2. **Marquee rectangle**
   - Semi-transparent fill + solid stroke

3. **Selection box + handles** (when not transforming)
   - Selection box stroke
   - Circular corner handles with shadow

```typescript
function drawSelectionOverlay(ctx, preview, scale, snapshot) {
  // Phase 1: Object highlights
  if (!preview.isTransforming && preview.selectedIds.length > 0) {
    drawObjectHighlights(ctx, preview.selectedIds, snapshot, scale);
  }

  // Phase 2: Marquee
  if (preview.marqueeRect) {
    drawMarqueeRect(ctx, preview.marqueeRect, scale);
  }

  // Phase 3: Selection box + handles
  if (preview.selectionBounds && !preview.isTransforming) {
    drawSelectionBoxAndHandles(ctx, preview.selectionBounds, preview.handles, scale);
  }
}
```

### Overlay Render Loop Integration

```typescript
// OverlayRenderLoop.frame()
if (previewToDraw?.kind === 'selection') {
  ctx.setTransform(/* world transform */);
  const snapshot = getCurrentSnapshot();
  drawSelectionOverlay(ctx, previewToDraw, view.scale, snapshot);
}
```

---

## Key Invariants

1. **Z-order is ULID-based** - Objects sorted by ULID ascending for correct layering
2. **Selection bounds use bbox** - Visual coverage includes stroke width
3. **Transform bounds use geometry** - Origin stability, no anchor sliding
4. **Handles hide during transform** - Clean visual during gesture
5. **Strokes scale uniformly** - Geometry never inverts, width scales
6. **Shape stroke width unchanged** - Only geometry transforms
7. **Mixed + side + stroke = translate** - Edge-pinning behavior
8. **Commit clears transform first** - Prevents double-transform glitch
9. **Hit test respects fill state** - Unfilled interiors are transparent
10. **Connectors grouped with strokes** - (Will be separated in future work)

---

## Dirty Rect Invalidation

### Envelope Pattern

Transform gestures use an accumulating envelope for dirty rects:

```typescript
private transformEnvelope: WorldRect | null = null;

private invalidateTransformPreview() {
  const bounds = this.computeSelectionBounds();
  const transformedBounds = applyTransformToBounds(bounds, transform);

  // Envelope ONLY EXPANDS (never shrinks)
  if (!this.transformEnvelope) {
    this.transformEnvelope = unionBounds(bounds, transformedBounds);
  } else {
    this.transformEnvelope = expandEnvelope(this.transformEnvelope, transformedBounds);
  }

  invalidateWorld(this.transformEnvelope);
}
```

This ensures all pixels touched during the gesture are repainted, preventing ghosting artifacts.

---

## Future Work: Connector Separation

Currently, connectors are classified alongside strokes in selection logic:

```typescript
const isStroke = handle.kind === 'stroke' || handle.kind === 'connector';
```

For connector endpoint editing integration, the following changes will be needed:

1. **New SelectionKind**: Add `'connectorsOnly'` or separate connector tracking
2. **Endpoint Hit Testing**: Detect hits on connector endpoints (distinct from line segments)
3. **Anchor Information**: Track which endpoint is being edited (start/end) and its anchor state
4. **Endpoint Drag Mode**: New phase or sub-mode for dragging connector endpoints
5. **Endpoint Dots Rendering**: Render anchor dots on selection overlay using anchor position data
6. **Reroute Integration**: Call `rerouteConnector()` during endpoint drag with endpoint overrides
7. **Transform Behavior**: Connectors may need different transform logic than strokes (anchor-aware rerouting vs point translation)

The modular architecture (separate hit-testing, transform, bounds modules) should facilitate these additions.
