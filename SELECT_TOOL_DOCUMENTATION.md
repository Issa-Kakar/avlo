# SelectTool Implementation Documentation

**Last Updated:** 2025-01-29
**Branch:** `feature/select-tool`
**Status:** Shapes and strokes fully working. Text/connectors not implemented.

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [State Machine](#2-state-machine)
3. [Selection Store](#3-selection-store)
4. [Hit Testing](#4-hit-testing)
5. [Handle System](#5-handle-system)
6. [Transform Behaviors](#6-transform-behaviors)
7. [Bounds Computation](#7-bounds-computation)
8. [Preview Rendering](#8-preview-rendering)
9. [Commit Logic](#9-commit-logic)
10. [Dirty Rect Invalidation](#10-dirty-rect-invalidation)
11. [Cursor Management](#11-cursor-management)
12. [Shared Geometry Modules](#12-shared-geometry-modules)

---

## 1. Architecture Overview

### File Structure

```
client/src/
├── lib/tools/SelectTool.ts          # Main tool implementation (~1586 lines)
├── lib/tools/types.ts               # Type definitions (SelectionPreview, HandleId)
├── lib/geometry/
│   ├── scale-transform.ts           # Shared scale math (~206 lines)
│   └── hit-test-primitives.ts       # Shared hit testing (~298 lines)
├── stores/selection-store.ts        # Zustand state management (~166 lines)
└── renderer/
    ├── layers/objects.ts            # Transform preview rendering (~763 lines)
    └── OverlayRenderLoop.ts         # Selection UI rendering
```

### Integration Pattern

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   SelectTool    │────▶│ SelectionStore  │────▶│   Rendering     │
│  (Gestures)     │     │  (Zustand)      │     │  (objects.ts)   │
└─────────────────┘     └─────────────────┘     └─────────────────┘
         │                                               │
         │              ┌─────────────────┐              │
         └─────────────▶│ RoomDocManager  │◀─────────────┘
                        │   (Mutations)   │
                        └─────────────────┘
```

---

## 2. State Machine

### Phases

```typescript
type Phase = 'idle' | 'pendingClick' | 'marquee' | 'translate' | 'scale';
```

### State Transitions

```
                    ┌──────────┐
                    │   idle   │
                    └────┬─────┘
                         │ pointer down
                         ▼
                ┌────────────────┐
                │  pendingClick  │◀──────────────────────┐
                └───────┬────────┘                       │
       ┌────────────────┼────────────────┐               │
       │                │                │               │
  move > threshold   move > threshold   move > threshold │
  on handle          on object/gap      on background    │
       │                │                │               │
       ▼                ▼                ▼               │
   ┌───────┐      ┌───────────┐    ┌─────────┐          │
   │ scale │      │ translate │    │ marquee │          │
   └───┬───┘      └─────┬─────┘    └────┬────┘          │
       │                │               │               │
       └────────────────┴───────────────┘               │
                        │ pointer up                    │
                        ▼                               │
              commit mutations / end                    │
                        │                               │
                        └───────────────────────────────┘
```

### DownTarget Classification

At pointer-down, the tool classifies what was clicked:

```typescript
type DownTarget =
  | 'none'                    // Initial state
  | 'handle'                  // Resize handle (nw/ne/se/sw/n/e/s/w)
  | 'objectInSelection'       // Object already selected
  | 'objectOutsideSelection'  // Object not yet selected
  | 'selectionGap'            // Empty space INSIDE selection bounds
  | 'background';             // Empty space OUTSIDE selection bounds
```

### Behavior by Target

| Target | Click Behavior | Drag Behavior |
|--------|---------------|---------------|
| `handle` | No-op | Scale transform |
| `objectInSelection` | Drill down (if multi) | Translate |
| `objectOutsideSelection` | Select that object | Select + Translate |
| `selectionGap` | Deselect (quick tap) | Translate |
| `background` | Deselect | Marquee selection |

---

## 3. Selection Store

**File:** `client/src/stores/selection-store.ts`

### State Interface

```typescript
interface SelectionState {
  selectedIds: string[];           // ULID array
  mode: 'none' | 'single' | 'multi';
  transform: TransformState;       // Active transform
  marquee: MarqueeState;           // Marquee drag state
}
```

### Transform Types

```typescript
type TransformState =
  | { kind: 'none' }
  | TranslateTransform
  | ScaleTransform;

interface TranslateTransform {
  kind: 'translate';
  dx: number;                      // World units delta X
  dy: number;                      // World units delta Y
  originBounds: WorldRect;         // Bounds before transform
}

interface ScaleTransform {
  kind: 'scale';
  origin: [number, number];        // Fixed anchor point
  scaleX: number;                  // X scale factor (can be negative)
  scaleY: number;                  // Y scale factor (can be negative)
  originBounds: WorldRect;         // Geometry-based (for position math)
  bboxBounds: WorldRect;           // Padded (for dirty rects)
  handleId: HandleId;              // Which handle is being dragged
  selectionKind: SelectionKind;    // 'strokesOnly' | 'shapesOnly' | 'mixed'
  handleKind: HandleKind;          // 'corner' | 'side'
  initialDelta: [number, number];  // Click offset from origin (for scale=1.0)
}
```

### Selection Kind

```typescript
type SelectionKind = 'none' | 'strokesOnly' | 'shapesOnly' | 'mixed';
```

Computed from selection content:
- `strokesOnly`: Only strokes/connectors selected
- `shapesOnly`: Only shapes/text selected
- `mixed`: Both strokes and shapes selected

---

## 4. Hit Testing

### Constants

```typescript
const HIT_RADIUS_PX = 6;       // Base hit test radius (screen space)
const HIT_SLACK_PX = 2.0;      // Extra tolerance for touch
const HANDLE_HIT_PX = 10;      // Handle hit radius
const MOVE_THRESHOLD_PX = 4;   // Drag detection threshold
const CLICK_WINDOW_MS = 180;   // Click vs drag timeout
```

### Hit Testing Pipeline

```
pointer (worldX, worldY)
         │
         ▼
┌────────────────────────────┐
│ RBush spatial index query  │  bbox intersection filter
│ radius = (6 + 2) / scale   │
└────────────┬───────────────┘
             │ IndexEntry[]
             ▼
┌────────────────────────────┐
│   Per-object geometry test │  testObject() dispatches by kind
└────────────┬───────────────┘
             │ HitCandidate[]
             ▼
┌────────────────────────────┐
│ Z-order aware resolution   │  pickBestCandidate()
│ (Fill-aware traversal)     │
└────────────────────────────┘
```

### HitCandidate Structure

```typescript
interface HitCandidate {
  id: string;
  kind: 'stroke' | 'shape' | 'text' | 'connector';
  distance: number;        // Distance from pointer to geometry
  insideInterior: boolean; // True if inside shape (not just near edge)
  area: number;            // Bounding area (for priority)
  isFilled: boolean;       // Has fillColor
}
```

### Geometry Tests by Object Kind

**Strokes/Connectors:**
```typescript
// Point-to-polyline distance test
strokeHitTest(px, py, points, radiusWorld + strokeWidth/2)
```

**Shapes (rect/roundedRect/ellipse/diamond):**
```typescript
// 1. Interior check (always selectable)
pointInsideShape(px, py, frame, shapeType)

// 2. Edge proximity check
shapeEdgeHitTest(px, py, tolerance, frame, shapeType)
```

**Text:**
```typescript
// Simple rect containment
pointInRect(px, py, x, y, w, h)
```

### Z-Order Resolution: Fill-Aware Traversal

**Key Insight:** Unfilled shape interiors are "transparent" for selection - we scan through them looking for paint underneath. But they ARE selectable if nothing else is found.

```typescript
private pickBestCandidate(candidates: HitCandidate[]): HitCandidate {
  // Sort by ULID descending (topmost first)
  const sorted = [...candidates].sort((a, b) => a.id < b.id ? 1 : -1);

  // Classification
  const isFrameInterior = (c) => c.kind === 'shape' && !c.isFilled && c.insideInterior;

  const classifyPaint = (c) => {
    if (c.kind === 'stroke' || c.kind === 'connector' || c.kind === 'text') return 'ink';
    if (c.kind === 'shape' && c.isFilled) return 'fill';
    if (c.kind === 'shape' && !c.isFilled && !c.insideInterior) return 'ink'; // border
    return null; // transparent interior
  };

  // Scan from top to bottom
  let bestFrame = null;   // Smallest unfilled interior
  let firstPaint = null;  // First visible paint

  for (const c of sorted) {
    if (isFrameInterior(c)) {
      // Remember smallest frame, keep scanning
      if (!bestFrame || c.area < bestFrame.area) bestFrame = c;
      continue;
    }

    const paintClass = classifyPaint(c);
    if (paintClass) {
      firstPaint = c;
      break; // Stop - this occludes everything below
    }
  }

  // Resolution priority:
  // 1. Only frames → return smallest (most nested)
  // 2. Ink (stroke/border/text) → always beats frames
  // 3. Filled shape vs frames → smaller area wins
}
```

### Marquee Selection (Geometry Intersection)

Industry-standard behavior: Select objects whose **actual geometry** intersects the marquee, not just bbox.

```typescript
private objectIntersectsRect(handle, rect): boolean {
  switch (handle.kind) {
    case 'stroke':
    case 'connector':
      return polylineIntersectsRect(points, rect);

    case 'shape':
      switch (shapeType) {
        case 'ellipse':  return ellipseIntersectsRect(cx, cy, rx, ry, rect);
        case 'diamond':  return diamondIntersectsRect(top, right, bottom, left, rect);
        default:         return rectsIntersect(frameBounds, rect);
      }

    case 'text':
      return rectsIntersect(frameBounds, rect);
  }
}
```

---

## 5. Handle System

### Handle IDs

```typescript
type HandleId = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';
//               └──────────────────┬───────────────────────┘
//                    Corners (4)           Sides (4)
```

### Handle Layout

```
       n
   nw ─┬─ ne
   │   │   │
w ─┼───┼───┼─ e
   │   │   │
   sw ─┴─ se
       s
```

### Hit Testing Handles

```typescript
// Corners tested first (priority)
for (const corner of [nw, ne, se, sw]) {
  if (distance(pointer, corner) <= HANDLE_HIT_PX / scale) return corner;
}

// Side edges (invisible but hittable)
if (Math.abs(pointer.y - bounds.minY) <= tolerance &&
    pointer.x > bounds.minX + tolerance &&
    pointer.x < bounds.maxX - tolerance) {
  return 'n';  // North edge
}
// Similar for s, e, w
```

### Scale Origin

The scale origin is the **opposite** edge/corner from the dragged handle:

```typescript
getScaleOrigin(handle, bounds) {
  switch (handle) {
    case 'nw': return [bounds.maxX, bounds.maxY];  // SE corner
    case 'ne': return [bounds.minX, bounds.maxY];  // SW corner
    case 'se': return [bounds.minX, bounds.minY];  // NW corner
    case 'sw': return [bounds.maxX, bounds.minY];  // NE corner
    case 'n':  return [midX, bounds.maxY];         // S edge midpoint
    case 's':  return [midX, bounds.minY];         // N edge midpoint
    case 'e':  return [bounds.minX, midY];         // W edge midpoint
    case 'w':  return [bounds.maxX, midY];         // E edge midpoint
  }
}
```

---

## 6. Transform Behaviors

### Behavior Matrix

| Selection | Handle | Strokes | Shapes |
|-----------|--------|---------|--------|
| **strokesOnly** | Corner | Uniform scale, position preserved | N/A |
| **strokesOnly** | Side | Uniform scale (single axis) | N/A |
| **shapesOnly** | Corner | N/A | Non-uniform (independent X/Y) |
| **shapesOnly** | Side | N/A | Non-uniform (single axis) |
| **mixed** | Corner | Uniform, position preserved | Uniform, position preserved |
| **mixed** | Side | **Translate only** (edge-pin) | Non-uniform |

### Corner Handle: Strokes

**Behavior:** Uniform scale with "copy-paste" flip semantics.

```typescript
// Compute uniform scale (no threshold - immediate flip)
const uniformScale = computeUniformScaleNoThreshold(scaleX, scaleY);
const absScale = Math.abs(uniformScale);

// Position preserves relative arrangement
const [newCx, newCy] = computePreservedPosition(cx, cy, originBounds, origin, uniformScale);

// Transform points (geometry uses absScale - NEVER inverts)
const newPoints = points.map(([x, y]) => [
  newCx + (x - cx) * absScale,
  newCy + (y - cy) * absScale,
]);

// Width scales proportionally
yMap.set('width', oldWidth * absScale);
```

**Key Properties:**
- Geometry never mirrors/inverts
- Position preserved: object at top-left stays at top-left after flip
- Stroke width scales WYSIWYG

### Corner Handle: Shapes-Only

**Behavior:** Non-uniform scale (independent X/Y), corner-anchored.

```typescript
// Scale corners around origin
const newX1 = ox + (x - ox) * scaleX;
const newY1 = oy + (y - oy) * scaleY;
const newX2 = ox + ((x + w) - ox) * scaleX;
const newY2 = oy + ((y + h) - oy) * scaleY;

// Normalize for negative scale (flip)
yMap.set('frame', [
  Math.min(newX1, newX2),
  Math.min(newY1, newY2),
  Math.abs(newX2 - newX1),
  Math.abs(newY2 - newY1),
]);
// Shape stroke width: UNCHANGED
```

### Corner Handle: Mixed Selection

Both strokes and shapes use **uniform scale with position preservation**.

```typescript
// Shapes behave like strokes in mixed+corner
const uniformScale = computeUniformScaleNoThreshold(scaleX, scaleY);
const absScale = Math.abs(uniformScale);

const [newCx, newCy] = computePreservedPosition(cx, cy, originBounds, origin, uniformScale);
const newW = w * absScale;
const newH = h * absScale;

yMap.set('frame', [newCx - newW/2, newCy - newH/2, newW, newH]);
```

### Side Handle: Mixed Selection (Stroke Edge-Pinning)

**Strokes translate** instead of scaling. Edge-pinning logic:

```typescript
function computeStrokeTranslation(handle, originBounds, scaleX, scaleY, origin, handleId) {
  const isHorizontal = handleId === 'e' || handleId === 'w';

  // Detect if stroke touches anchor edge
  const anchorX = handleId === 'e' ? originBounds.minX : originBounds.maxX;
  const isAnchor = Math.abs(minX - anchorX) < EPS || Math.abs(maxX - anchorX) < EPS;

  if (isAnchor) {
    if (scaleX >= 0) {
      // Pre-flip: pin edge that touches anchor
      dx = anchorX - (touchesLeft ? minX : maxX);  // ≈ 0
    } else {
      // Post-flip: pin opposite edge (shift by stroke width)
      dx = anchorX - (touchesLeft ? maxX : minX);
    }
  } else {
    // Interior stroke: origin-based translation
    const newCx = ox + (cx - ox) * scaleX;
    dx = newCx - cx;

    // At flip (scaleX < 0), shift by half stroke width (opposite direction)
    if (scaleX < 0) {
      const halfWidth = (maxX - minX) / 2;
      dx += handleId === 'w' ? -halfWidth : halfWidth;
    }
  }

  return { dx, dy: 0 };
}
```

---

## 7. Bounds Computation

### Two Bounds Types

**1. BBox Bounds** (`computeSelectionBounds()`)
- Uses `handle.bbox` (includes stroke width padding)
- Used for: visual selection rectangle, dirty rect invalidation

**2. Geometry Bounds** (`computeTransformBoundsForScale()`)
- Raw geometry without padding
- Shapes: raw `frame [x, y, w, h]`
- Strokes: raw `points` min/max
- Used for: scale origin, position math

### Why Two Bounds?

**Problem:** Using padded bboxes for scale origin causes "anchor sliding":

```
Shape frame: [100, 100, 50, 50]  (left edge at x=100)
Stroke width: 10 → Padding: 6
BBox: [94, 94, 156, 156]  (left edge at x=94)

Origin for E handle = [94, midY]  ← from padded bbox
Transform: newX = 94 + (100 - 94) * 1.5 = 103  ← frame moves!

RESULT: Left edge slides from 100 → 103 (3px drift)
```

**Solution:** Use geometry bounds for origin:

```
Geometry bounds: minX = 100
Origin for E handle = [100, midY]  ← from geometry
Transform: newX = 100 + (100 - 100) * 1.5 = 100  ← frame stays!
```

---

## 8. Preview Rendering

### Preview Flow

```
SelectTool.getPreview()
         │
         ▼
   SelectionPreview
         │
         ▼
OverlayRenderLoop (selection UI)
         │
         └──────────────────────────────────┐
                                            ▼
                                   objects.ts (transform preview)
```

### SelectionPreview Structure

```typescript
interface SelectionPreview {
  kind: 'selection';
  selectionBounds: WorldRect | null;     // Transformed bounds
  marqueeRect: WorldRect | null;         // Drag rectangle
  handles: { id: HandleId; x, y }[];     // Corner handles (null during transform)
  isTransforming: boolean;               // Hide handles during drag
  selectedIds: string[];                 // For highlight rendering
  bbox: null;
}
```

### Overlay Rendering (OverlayRenderLoop.ts)

```typescript
// Selection highlighting (when not transforming)
if (!preview.isTransforming && preview.selectedIds?.length > 0) {
  ctx.strokeStyle = 'rgba(59, 130, 246, 1)';  // Blue
  ctx.lineWidth = 2 / view.scale;

  for (const id of selectedIds) {
    // Text: stroke frame rect
    // Strokes: stroke bbox rect
    // Shapes: stroke cached Path2D
  }
}

// Marquee rect (dashed)
if (preview.marqueeRect) {
  ctx.fillStyle = 'rgba(59, 130, 246, 0.08)';
  ctx.strokeStyle = 'rgba(59, 130, 246, 0.6)';
  ctx.setLineDash([4 / view.scale, 4 / view.scale]);
  // Draw rect...
}

// Selection bounds + handles (when not transforming)
if (preview.selectionBounds && !preview.isTransforming) {
  // Draw rect + 4 corner handles (8px screen size)
}
```

### Transform Preview Rendering (objects.ts)

```typescript
function renderSelectedObjectWithScaleTransform(ctx, handle, transform) {
  const { selectionKind, handleKind, handleId } = transform;
  const isStroke = handle.kind === 'stroke' || handle.kind === 'connector';

  // CASE 1: Mixed + side + stroke = TRANSLATE ONLY
  if (selectionKind === 'mixed' && handleKind === 'side' && isStroke) {
    const { dx, dy } = computeStrokeTranslation(...);
    ctx.translate(dx, dy);
    drawObject(ctx, handle);  // Use cached Path2D
    return;
  }

  // CASE 2: Stroke scaling = PF-per-frame
  if (isStroke) {
    drawScaledStrokePreview(ctx, handle, transform);  // Fresh PF outline
    return;
  }

  // CASE 3: Shape scaling
  if (selectionKind === 'mixed' && handleKind === 'corner') {
    drawShapeWithUniformScale(ctx, handle, transform);  // Center-based
  } else {
    drawShapeWithTransform(ctx, handle, transform);     // Corner-based
  }
}
```

---

## 9. Commit Logic

### Translate Commit

```typescript
commitTranslate(selectedIds, dx, dy) {
  room.mutate((ydoc) => {
    for (const id of selectedIds) {
      if (handle.kind === 'stroke' || handle.kind === 'connector') {
        // Offset all points
        const newPoints = points.map(([x, y]) => [x + dx, y + dy]);
        yMap.set('points', newPoints);
      } else {
        // Offset frame
        const [x, y, w, h] = frame;
        yMap.set('frame', [x + dx, y + dy, w, h]);
      }
    }
  });
}
```

### Scale Commit

```typescript
commitScale(selectedIds, origin, scaleX, scaleY, handleId, selectionKind, handleKind, originBounds) {
  room.mutate((ydoc) => {
    for (const id of selectedIds) {
      const isStroke = handle.kind === 'stroke' || handle.kind === 'connector';

      // CASE 1: Mixed + side + stroke = TRANSLATE
      if (selectionKind === 'mixed' && handleKind === 'side' && isStroke) {
        const { dx, dy } = computeStrokeTranslation(...);
        const newPoints = points.map(([x, y]) => [x + dx, y + dy]);
        yMap.set('points', newPoints);
        // Width UNCHANGED
        continue;
      }

      // CASE 2: Stroke scaling
      if (isStroke) {
        const uniformScale = computeUniformScaleNoThreshold(scaleX, scaleY);
        const absScale = Math.abs(uniformScale);
        const [newCx, newCy] = computePreservedPosition(...);

        const newPoints = points.map(([x, y]) => [
          newCx + (x - cx) * absScale,
          newCy + (y - cy) * absScale,
        ]);
        yMap.set('points', newPoints);
        yMap.set('width', oldWidth * absScale);  // WYSIWYG
        continue;
      }

      // CASE 3: Shape scaling
      if (selectionKind === 'mixed' && handleKind === 'corner') {
        // Center-based with position preservation
        const [newCx, newCy] = computePreservedPosition(...);
        yMap.set('frame', [newCx - newW/2, newCy - newH/2, newW, newH]);
      } else {
        // Corner-based (non-uniform)
        const newX1 = ox + (x - ox) * scaleX;
        // ... normalize and set frame
      }
      // Shape stroke width: UNCHANGED
    }
  });
}
```

---

## 10. Dirty Rect Invalidation

### Envelope Pattern

SelectTool maintains a `transformEnvelope` that **accumulates** and **never shrinks** during a gesture:

```typescript
private transformEnvelope: WorldRect | null = null;

invalidateTransformPreview() {
  // Compute current transformed bounds
  const combinedBounds = computeTransformedBounds();

  // ACCUMULATE: expand envelope (never shrink)
  if (!this.transformEnvelope) {
    this.transformEnvelope = combinedBounds;
  } else {
    this.transformEnvelope = {
      minX: Math.min(this.transformEnvelope.minX, combinedBounds.minX),
      minY: Math.min(this.transformEnvelope.minY, combinedBounds.minY),
      maxX: Math.max(this.transformEnvelope.maxX, combinedBounds.maxX),
      maxY: Math.max(this.transformEnvelope.maxY, combinedBounds.maxY),
    };
  }

  this.invalidateWorld(this.transformEnvelope);
}
```

### Per-Object Bounds Computation

During scale transforms, bounds are computed per-object based on transform strategy:

```typescript
for (const id of selectedIds) {
  let objBounds: WorldRect;

  // Mixed + side + stroke = translate bounds
  if (selectionKind === 'mixed' && handleKind === 'side' && isStroke) {
    const { dx, dy } = computeStrokeTranslation(...);
    objBounds = translateBounds(bbox, dx, dy);
  }
  // Stroke scaling = center-based bounds
  else if (isStroke) {
    const [newCx, newCy] = computePreservedPosition(...);
    objBounds = centerBasedBounds(newCx, newCy, halfW * absScale, halfH * absScale);
    // Expand for scaled stroke width
  }
  // Shape scaling = ...
}

// Union all object bounds + include bboxBounds for coverage
```

---

## 11. Cursor Management

### Cursor Callbacks

```typescript
interface SelectToolOpts {
  applyCursor: () => void;                    // Apply current cursor
  setCursorOverride: (cursor: string | null) => void;  // Set override
}
```

### Cursor by Handle

```typescript
getHandleCursor(handle: HandleId): string {
  switch (handle) {
    case 'nw': case 'se': return 'nwse-resize';
    case 'ne': case 'sw': return 'nesw-resize';
    case 'n': case 's':   return 'ns-resize';
    case 'e': case 'w':   return 'ew-resize';
  }
}
```

### Hover Cursor Updates

```typescript
updateHoverCursor(worldX, worldY) {
  if (selectedIds.length === 0) {
    this.setCursorOverride(null);
    return;
  }

  const handle = this.hitTestHandle(worldX, worldY);
  if (handle) {
    this.setCursorOverride(this.getHandleCursor(handle));
  } else {
    this.setCursorOverride(null);
  }
  this.applyCursor();
}
```

### Lifecycle

- Set override on scale begin
- Clear override on end/cancel
- `clearHover()` called when pointer leaves canvas

---

## 12. Shared Geometry Modules

### scale-transform.ts

```typescript
/**
 * Uniform scale with NO threshold - immediate flip
 */
computeUniformScaleNoThreshold(scaleX, scaleY): number

/**
 * Position preservation for flip transforms
 */
computePreservedPosition(cx, cy, originBounds, origin, uniformScale): [number, number]

/**
 * Stroke translation for mixed + side (edge-pinning)
 */
computeStrokeTranslation(handle, originBounds, scaleX, scaleY, origin, handleId): { dx, dy }
```

### hit-test-primitives.ts

```typescript
// Point tests
pointToSegmentDistance(px, py, x1, y1, x2, y2): number
pointInRect(px, py, x, y, w, h): boolean
pointInWorldRect(px, py, rect): boolean
pointInDiamond(px, py, top, right, bottom, left): boolean

// Hit tests
strokeHitTest(px, py, points, radius): boolean
circleRectIntersect(cx, cy, r, x, y, w, h): boolean

// Intersection tests
rectsIntersect(a, b): boolean
segmentsIntersect(x1, y1, x2, y2, x3, y3, x4, y4): boolean
segmentIntersectsRect(x1, y1, x2, y2, rect): boolean
polylineIntersectsRect(points, rect): boolean
ellipseIntersectsRect(cx, cy, rx, ry, rect): boolean
diamondIntersectsRect(top, right, bottom, left, rect): boolean

// Utility
computePolylineArea(points): number
```

---

## Quick Test Scenarios

### Corner Handles - Uniform Scale

1. **Two strokes diagonal:** Flip → positions preserved, geometry not inverted
2. **Mixed stroke + shape:** Flip → positions preserved, geometry not inverted
3. **Single stroke:** Flip → works correctly (t=0.5, 0.5 stays centered)
4. **Shrink without flip:** Normal scaling unchanged

### Corner Handles - Non-Uniform Scale

1. **Shapes-only corner:** Opposite corner stays fixed
2. **Shape with thick stroke (20px):** No sliding despite large padding

### Side Handles

1. **Strokes-only side:** Uniform scale (single axis)
2. **Shapes-only side:** Opposite edge stays fixed
3. **Mixed side anchor strokes:** Stay pinned pre-flip, jump by width at flip
4. **Mixed side non-anchor strokes:** Translate toward anchor, jump at flip

---

**End of Documentation**
