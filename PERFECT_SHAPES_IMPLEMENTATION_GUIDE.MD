# Perfect Shapes Feature - Complete Implementation Guide

## Executive Summary

Shape recognition is **explicitly user-intentional via a 600 ms dwell**. We are **aggressive** by design and **only** recognize **rectangle** and **circle**; **line** is a **strict fallback** when neither clears confidence. This guide details the implementation.

---

## Implementation Status

### ✅ Implemented
- **Live cursor synchronization fix** - Prevents "tiny dot" issue on first frame after snap
- **Geometry algorithms** (`/client/src/lib/geometry/`):
  - `fit-circle.ts` - Taubin algebraic circle fitting
  - `fit-obb.ts` - PCA-based oriented bounding box
  - `geometry-helpers.ts` - All helper functions (PCA, coverage, corner/edge detection, scoring helpers)
  - `types.ts` - Vec2, Edge, Corner types
  - `shape-params.ts` - Centralized constants for thresholds and scoring weights
  - `score.ts` - Shape scoring functions for circle and rectangle
  - `recognize-open-stroke.ts` - Main recognition algorithm with line fallback
- HoldDetector (`/client/src/lib/input/HoldDetector.ts`)
- PreviewData type updates in `/client/src/lib/tools/types.ts`
- DrawingTool modifications for perfect shapes
- OverlayRenderLoop perfect shape rendering
- Perfect shape preview renderer (`/client/src/renderer/layers/perfect-shape-preview.ts`)
- Canvas.tsx integration changes

### ⏳ Not Yet Implemented

---

## 1. Core Behavior & User Experience

### What Users Experience

1. **Draw normally, then dwell to trigger a snap to run shape recognition**: While drawing a stroke, holding still for 600ms triggers shape recognition
2. After the hold detector fires, only **circle** and **rectangle** are tested. If neither reaches `SHAPE_CONFIDENCE_MIN`, the tool **snaps to a line fallback** (A = first point, B = current pointer) — **no straightness test** and **no tie-breaks**.
3. **Locked-after-snap**: Once snapped, the tool is locked to that shape until pointer-up (no escape back to freehand, no shape switching)
4. **Drag to refine geometry**: After it locks, jerk the mouse anywhere:
• Circle: radius follows the cursor (center fixed).
• Box: scales along its own X/Y axes (center & angle fixed).
• Line: endpoint follows the cursor (rotation and length change).
After snapping, moving the pointer updates only the shape's geometry
4. **Release to commit**: On pointer-up, the perfect shape commits as a regular stroke (no seperate commit type for shapes)

### Shape-Specific Behaviors After Snap

**Line**:
- First point (A) stays at initial draw position
- Endpoint (B) follows pointer anywhere
- Updates length and rotation freely

**Circle**:
- Center (C) stays fixed at recognition point
- Radius updates based on pointer distance from center
- Perfect circles, no ellipses

**Box/Rectangle (Oriented Bounding Box)**:
- Center (M) and angle stay fixed from recognition
- Scales along its own X/Y axes (anisotropic): center & angle stay fixed; half-extents adjust with cursor movement. Stroke width does not scale, only geometry

### Clarifications:

1. **Hold detector stays active until snap** - Once shape recognition triggers (always succeeds due to line fallback), the hold detector is canceled
2. **Single recognition per snap** - Once snapped, no re-recognition occurs
3. Only compute bbox for perfect shapes on commit, not preview
4. **Live cursor synchronization** - `liveCursorWU` is kept in sync throughout the gesture to prevent stale cursor on first frame after snap (prevents "tiny dot" issue)

---

## 2. Technical Architecture

### System Components

```
┌─────────────────────────────────────────────────────────────┐
│                          Canvas                             │
│  • Converts pointer events to world coords                  │
│  • Provides callbacks to DrawingTool:                       │
│    - requestOverlayFrame() → overlay.invalidateAll()        │
│    - getView() → viewTransformRef.current                   │
│  • Sets DrawingTool as preview provider for overlay         │
└──────────────┬──────────────────────────┬──────────────────┘
               │                          │
         creates with                sets as preview
          callbacks                      provider
               │                          │
               ▼                          ▼
┌──────────────────────────┐  ┌─────────────────────────────┐
│      DrawingTool         │  │     OverlayRenderLoop       │
│  • Maintains snap state  │  │  • Calls getPreview()       │
│  • Owns HoldDetector     │  │  • Event-driven rendering   │
│  • Calls callbacks       │  │  • Full clear on invalidate │
│  • Provides getPreview() │  │                             │
└──────────────────────────┘  └─────────────────────────────┘
```

### Data Flow

1. **Event Ingress**: Canvas receives pointer events, converts to world coordinates
2. **Tool Processing**: DrawingTool maintains hold detector and snap state
3. **Recognition**: On hold detector firing after dwell, recognizer runs and may snap to circle or rectangle/box if recognized, otherwise fallback to line
4. **Preview**: Tool returns appropriate preview type based on snap state via getPreview()
5. **Rendering**: Overlay renders preview in world space (full clear on each invalidation - event-driven, not continuous)
6. **Commit**: On pointer-up, shape converts to polyline and commits as stroke

---

## 3. Coordinate Systems & Rendering Strategy

### Three-Tier Coordinate System

1. **World Space**: Infinite 2D plane for document content
2. **Canvas Space**: CSS pixel viewport coordinates
3. **Device Space**: Physical device pixels (canvas * dpr)

### Transform Mathematics

```typescript
// Authoritative formulas (from OVERVIEW_CONDENSED.md):
worldToCanvas: [(x - pan.x) * scale, (y - pan.y) * scale]
canvasToWorld: [x / scale + pan.x, y / scale + pan.y]

// Canvas context setup:
ctx.scale(view.scale, view.scale);        // Apply zoom first
ctx.translate(-view.pan.x, -view.pan.y);  // Then pan

// Recognition note:
// All recognition metrics (corner angles, PCA, circle fit residuals, coverage)
// are computed in WORLD units only. The hold jitter threshold is in
// SCREEN pixels to match user feel.
```

### Why No Bbox for Shape Previews

**Key Insight**: The overlay canvas does `stage.clear()` every frame regardless of what's drawn:
Therefore:
- **StrokePreview** keeps bbox (existing freehand path, used by base canvas)
- **PerfectShapePreview** has `bbox: null` (overlay doesn't use it)
- Bbox computed only at commit time for the stroke record

### Rendering Strategy

**Base Canvas** (RenderLoop):
- Persistent content with dirty rect optimization
- Needs bbox for selective invalidation
- Updates only on docVersion changes

**Overlay Canvas** (OverlayRenderLoop):
- Ephemeral content with full clear
- No bbox needed for previews
- For previews- Only renders on invalidation; tools must explicitly request a frame via `requestOverlayFrame()` callback which calls `overlayLoop.invalidateAll()`. Ensure the perfect-shape preview structs carry `bbox: null`

---

## 4. Implementation Changes

### 4.1 New Types (`/client/src/lib/tools/types.ts`)

```typescript
// Add to existing PreviewData union
// NEW: Perfect Shape preview is inputs (anchors + live cursor),
// not final geometry. The renderer computes geometry.
export interface PerfectShapePreview {
  kind: 'perfectShape';
  shape: 'line' | 'circle' | 'box';

  // Tool styling frozen at pointer-down
  color: string;
  size: number;
  opacity: number;

  // Inputs in WORLD space:
  // - anchors: frozen the moment we snap (shape-specific)
  // - cursor: live pointer in world units
  anchors:
    | { kind: 'line';   A: [number, number] }                // line: fixed A
    | { kind: 'circle'; center: [number, number] }           // circle: fixed center
    | { kind: 'box';    cx: number; cy: number; angle: number; hx0: number; hy0: number }; // box: frozen OBB seed
  cursor: [number, number];

  // Overlay previews never carry a bbox (base canvas ignores them)
  bbox: null;
}

// Update union
export type PreviewData =
  | StrokePreview
  | EraserPreview
  | TextPreview
  | PerfectShapePreview;  // NEW
```

### 4.2 HoldDetector (`/client/src/lib/input/HoldDetector.ts`)

```typescript
export class HoldDetector {
  private timerId: number | null = null;
  private lastPos: { x: number; y: number } | null = null;

  constructor(
    private onFire: () => void,
    private dwellMs = 600,
    private jitterPx = 6  // Screen space threshold
  ) {}

  start(screenPos: { x: number; y: number }) {
    this.cancel();
    this.lastPos = screenPos;
    this.timerId = window.setTimeout(this.onFire, this.dwellMs);
  }

  move(screenPos: { x: number; y: number }) {
    if (!this.lastPos) return;

    const dist = Math.hypot(
      screenPos.x - this.lastPos.x,
      screenPos.y - this.lastPos.y
    );

    if (dist > this.jitterPx) {
      // Movement exceeded jitter - reset timer
      this.lastPos = screenPos;
      if (this.timerId) clearTimeout(this.timerId);
      this.timerId = window.setTimeout(this.onFire, this.dwellMs);
    }
    // If within jitter, timer continues unchanged
  }

  cancel() {
    if (this.timerId) {
      clearTimeout(this.timerId);
      this.timerId = null;
    }
    this.lastPos = null;
  }
}
```

### 4.3 DrawingTool Changes

#### New Fields

```typescript
import { SHAPE_CONFIDENCE_MIN } from '../geometry/shape-params'; //add this

type RequestOverlayFrame = () => void;

class DrawingTool {
  // Existing fields...

  // NEW: Perfect shapes support
  private hold: HoldDetector;
  private snap:
    | null
    | (
        | { kind: 'line';   anchors: { A: [number, number] } }
        | { kind: 'circle'; anchors: { center: [number, number] } }
        | { kind: 'box';    anchors: { cx: number; cy: number; angle: number; hx0: number; hy0: number } }
      ) = null;
  private liveCursorWU: [number, number] | null = null;
  private getView?: () => ViewTransform;              // screen jitter (hold)
  private requestOverlayFrame?: RequestOverlayFrame;  // NEW: nudge overlay loop

  constructor(
    room: IRoomDocManager,
    settings: ToolSettings,
    toolType: 'pen' | 'highlighter',
    userId: string,
    requestOverlayFrame?: RequestOverlayFrame,     // NEW (overlay frames)
    getView?: () => ViewTransform                  // stays (hold jitter)
  ) {
    // Existing initialization...
    this.requestOverlayFrame = requestOverlayFrame;
    this.getView = getView;
    this.hold = new HoldDetector(() => this.onHoldFire());
  }
}
```

#### Modified Methods

```typescript
begin(pointerId: number, wx: number, wy: number): void {
  // Existing freezing of settings...
  this.startDrawing(pointerId, wx, wy);

  // NEW: Start hold detector in SCREEN px
  if (this.getView) {
    const [sx, sy] = this.getView().worldToCanvas(wx, wy);
    this.hold.start({ x: sx, y: sy });
  }

  // Reset snap state for new gesture
  this.snap = null;
  this.liveCursorWU = [wx, wy];
  this.requestOverlayFrame?.(); // draw first frame
}

move(wx: number, wy: number): void {
  // Always mirror the latest pointer in world space (prevents stale cursor on snap)
  this.liveCursorWU = [wx, wy];

  // Keep hold jitter in SCREEN px prior to snap
  if (!this.snap && this.getView) {
    const [sx, sy] = this.getView().worldToCanvas(wx, wy);
    this.hold.move({ x: sx, y: sy });
  }

  if (this.snap) {
    // After snap: just request an overlay frame (liveCursorWU already updated above)
    this.requestOverlayFrame?.();                // CRITICAL: drives overlay
    return;
  }

  // Before snap: freehand path behavior stays the same
  this.addPoint(wx, wy);                         // will call updateBounds()
  // updateBounds() → onInvalidate(bounds) → Canvas maps that to overlay invalidation
}

private onHoldFire(): void {
  if (this.snap) return;

  // Make sure we use the freshest point
  this.flushPending();  // Flush any pending RAF updates

  // Use latest pointer in WORLD units
  const len = this.state.points.length;
  if (len < 2) return;
  const pointerNowWU: [number, number] = [
    this.state.points[len - 2], this.state.points[len - 1]
  ];

  // CRITICAL: Update live cursor to prevent stale cursor on first frame after snap
  this.liveCursorWU = pointerNowWU;

  const result = recognizeOpenStroke({
    pointsWU: this.state.points,
    pointerNowWU
  });

  // Recognizer enforces fallback; accept any result
  // - 'circle'/'box' only if score >= SHAPE_CONFIDENCE_MIN (0.58)
  // - otherwise it returns { kind:'line', score:1 }
  if (result.kind === 'line' || result.score >= SHAPE_CONFIDENCE_MIN) {
    // Freeze anchors; do NOT compute live geometry here.
    this.snap = (
      result.kind === 'line'
        ? { kind: 'line',   anchors: { A: result.line!.A } }
      : result.kind === 'circle'
        ? { kind: 'circle', anchors: { center: [result.circle!.cx, result.circle!.cy] } }
      : { kind: 'box',     anchors: { cx: result.box!.cx, cy: result.box!.cy, angle: result.box!.angle, hx0: result.box!.hx, hy0: result.box!.hy } }
    );
    this.requestOverlayFrame?.();                // draw snapped preview immediately
    this.hold.cancel();                          // snap: hold no longer needed
  }

}

getPreview(): PreviewData | null {
  if (!this.state.isDrawing) return null;

  if (this.snap && this.liveCursorWU) {
    const { color, size, tool } = this.state.config;
    return {
      kind: 'perfectShape',
      shape: this.snap.kind,
      color,
      size,
      opacity: tool === 'pen'
        ? STROKE_CONFIG.CURSOR_PREVIEW_OPACITY
        : STROKE_CONFIG.HIGHLIGHTER_PREVIEW_OPACITY,
      anchors: { ...this.snap.anchors, kind: this.snap.kind } as any,
      cursor: this.liveCursorWU,
      bbox: null
    };
  }

  // Freehand (unchanged)
  if (this.state.points.length < 2) return null;
  return {
    kind: 'stroke',
    points: this.state.points,
    tool: this.state.config.tool,
    color: this.state.config.color,
    size: this.state.config.size,
    opacity: this.state.config.tool === 'pen'
      ? STROKE_CONFIG.CURSOR_PREVIEW_OPACITY
      : STROKE_CONFIG.HIGHLIGHTER_PREVIEW_OPACITY,
    bbox: this.lastBounds,
  };
}

end(finalWx?: number, finalWy?: number): void {
  this.hold.cancel();

  if (this.snap && this.liveCursorWU) {
    // Build polyline from (anchors + live cursor), compute bbox ONCE, commit.
    this.commitPerfectShapeFromPreview();
    return;
  }
  // Freehand path commit (existing)
  this.commitStroke(finalWx ?? /* last point */ this.state.points.at(-2)!);
}

private commitPerfectShapeFromPreview(): void {
  // Generate polyline from (anchors + final cursor)
  let points: number[];
  const finalCursor = this.liveCursorWU!;

  if (this.snap.kind === 'line') {
    const { A } = this.snap.anchors;
    const B = finalCursor;
    points = [A[0], A[1], B[0], B[1]];

  } else if (this.snap.kind === 'circle') {
    const { center } = this.snap.anchors;
    const r = Math.hypot(finalCursor[0] - center[0], finalCursor[1] - center[1]);
    const n = Math.max(24, Math.ceil(2 * Math.PI * r / 8));
    points = [];
    for (let i = 0; i <= n; i++) {
      const angle = (i / n) * 2 * Math.PI;
      points.push(center[0] + r * Math.cos(angle), center[1] + r * Math.sin(angle));
    }

  } else {  // box
    const { cx, cy, angle, hx0, hy0 } = this.snap.anchors;
    // Compute final scale from cursor
    const dx = finalCursor[0] - cx;
    const dy = finalCursor[1] - cy;
    const cos = Math.cos(angle), sin = Math.sin(angle);
    const localX =  dx *  cos + dy *  sin;
    const localY = -dx *  sin + dy *  cos;
    const sx = Math.max(0.0001, Math.abs(localX) / Math.max(1e-6, hx0));
    const sy = Math.max(0.0001, Math.abs(localY) / Math.max(1e-6, hy0));
    const hx = hx0 * sx;
    const hy = hy0 * sy;

    const corners = [
      [-hx, -hy], [hx, -hy], [hx, hy], [-hx, hy], [-hx, -hy]
    ];
    points = [];
    for (const [lx, ly] of corners) {
      points.push(
        cx + lx * cos - ly * sin,
        cy + lx * sin + ly * cos
      );
    }
  }

  // NOW compute bbox at commit time
  const bbox = calculateBBox(points, this.state.config.size);

  // Check size limits
  const estimatedSize = estimateEncodedSize(points);
  if (estimatedSize > ROOM_CONFIG.MAX_INBOUND_FRAME_BYTES) {
    console.error('Perfect shape too large for transport');
    this.cancelDrawing();
    return;
  }

  // Commit as regular stroke
  const strokeId = ulid();
  this.room.mutate((ydoc) => {
    const root = ydoc.getMap('root');
    const strokes = root.get('strokes') as Y.Array<any>;
    const meta = root.get('meta') as Y.Map<any>;
    const sceneTicks = meta.get('scene_ticks') as Y.Array<number>;
    const currentScene = sceneTicks.length;

    strokes.push([{
      id: strokeId,
      tool: this.state.config.tool,
      color: this.state.config.color,
      size: this.state.config.size,
      opacity: this.state.config.opacity,
      points,  // Generated polyline
      bbox,    // Computed at commit
      scene: currentScene,
      createdAt: Date.now(),
      userId: this.userId
    }]);
  });

  // Invalidate and reset
  if (bbox) this.onInvalidate?.(bbox);
  this.resetState();
  this.snap = null;
}
```

### 4.4 OverlayRenderLoop Changes

```typescript
// In OverlayRenderLoop.ts frame() method
if (previewToDraw.kind === 'stroke') {
  // Existing stroke preview
} else if (previewToDraw.kind === 'eraser') {
  // Existing eraser preview
} else if (previewToDraw.kind === 'text') {
  // Existing text preview
} else if (previewToDraw.kind === 'perfectShape') {
  // NEW: Perfect shape preview
  ctx.save();
  ctx.scale(view.scale, view.scale);
  ctx.translate(-view.pan.x, -view.pan.y);
  drawPerfectShapePreview(ctx, previewToDraw);
  ctx.restore();
}
```

### 4.5 Perfect Shape Preview Renderer (`/client/src/renderer/layers/perfect-shape-preview.ts`)

```typescript
export function drawPerfectShapePreview(
  ctx: CanvasRenderingContext2D,
  preview: PerfectShapePreview
): void {
  // Apply tool styling
  ctx.globalAlpha = preview.opacity;
  ctx.strokeStyle = preview.color;
  ctx.lineWidth = preview.size;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.setLineDash([]);

  const { anchors, cursor } = preview;

  if (anchors.kind === 'line') {
    const { A } = anchors;
    const B = cursor;
    ctx.beginPath();
    ctx.moveTo(A[0], A[1]);
    ctx.lineTo(B[0], B[1]);
    ctx.stroke();
    return;
  }
  if (anchors.kind === 'circle') {
    const { center } = anchors;
    const r = Math.hypot(cursor[0] - center[0], cursor[1] - center[1]);
    ctx.beginPath();
    ctx.arc(center[0], center[1], r, 0, Math.PI * 2);
    ctx.stroke();
    return;
  }

  // box
  const { cx, cy, angle, hx0, hy0 } = anchors;
  // Uniform scale from frozen half-extents to live cursor
  const dx = cursor[0] - cx;
  const dy = cursor[1] - cy;
  const cos = Math.cos(angle), sin = Math.sin(angle);
  // Project live vector into box's local axes
  const localX =  dx *  cos + dy *  sin;
  const localY = -dx *  sin + dy *  cos;
  const sx = Math.max(0.0001, Math.abs(localX) / Math.max(1e-6, hx0));
  const sy = Math.max(0.0001, Math.abs(localY) / Math.max(1e-6, hy0));
  const hx = hx0 * sx;
  const hy = hy0 * sy;

  // Draw rotated rectangle from (cx,cy), angle, half-extents (hx,hy)
  const corners = [[-hx,-hy],[hx,-hy],[hx,hy],[-hx,hy]];
  ctx.beginPath();
  for (let i = 0; i < corners.length; i++) {
    const [lx, ly] = corners[i];
    const wx = cx + lx * cos - ly * sin;
    const wy = cy + lx * sin + ly * cos;
    if (i === 0) ctx.moveTo(wx, wy); else ctx.lineTo(wx, wy);
  }
  ctx.closePath();
  ctx.stroke();
}
```

### 4.6 Canvas.tsx Integration

```typescript
// Canvas.tsx — when constructing the DrawingTool

const tool = new DrawingTool(
  roomDoc,
  activeTool === 'pen' ? pen : highlighter,
  activeTool,
  userId,
  // requestOverlayFrame: tools call this after snap or any preview change
  () => overlayLoopRef.current?.invalidateAll(),
  // getView: needed only for hold-jitter in SCREEN px (pre-snap)
  () => viewTransformRef.current
);

// Overlay preview plumbing remains the same:
// - setPreviewProvider(tool) on activate / unset on deactivate
// - snapshot subscription calls holdPreviewForOneFrame() on docVersion change
```

---

## 5. Helper Functions & Geometry

### Constants File (`/client/src/lib/geometry/shape-params.ts`)

All shape recognition thresholds and scoring weights are centralized:

```typescript
// shape-params.ts
export const SHAPE_CONFIDENCE_MIN = 0.58;

// Circle thresholds
export const CIRCLE_MIN_COVERAGE = 0.667;   // ≥240°
export const CIRCLE_MAX_AXIS_RATIO = 1.70;  // PCA λ1/λ2 (sqrt)
export const CIRCLE_MAX_RMS_RATIO = 0.24;   // normalized RMS

// Rectangle thresholds
export const RECT_MIN_CORNERS = 3;
export const RECT_CORNER_TOLERANCE_DEG = 20;
export const RECT_PARALLEL_TOLERANCE_DEG = 15;
export const RECT_ORTHOGONAL_TOLERANCE_DEG = 15;

// Scoring weights
export const RECT_WEIGHT_CORNERS = 0.40;
export const RECT_WEIGHT_PARALLEL = 0.25;
export const RECT_WEIGHT_ORTHOGONAL = 0.20;
export const RECT_WEIGHT_COVERAGE = 0.15;

export const CIRCLE_WEIGHT_COVERAGE = 0.50;
export const CIRCLE_WEIGHT_FIT = 0.30;
export const CIRCLE_WEIGHT_ROUND = 0.20;
```

### 5.1 Recognition Algorithm (`/client/src/lib/geometry/recognize-open-stroke.ts` - )

```typescript
import { SHAPE_CONFIDENCE_MIN } from './shape-params';

export interface RecognitionResult {
  kind: 'line' | 'circle' | 'box';
  score: number;
  // Shape-specific parameters
  line?: { A: [number, number]; B: [number, number] };
  circle?: { cx: number; cy: number; r: number };
  box?: { cx: number; cy: number; angle: number; hx: number; hy: number };
}

export function recognizeOpenStroke({
  pointsWU,
  pointerNowWU
}: {
  pointsWU: number[];  // Flat array [x,y,x,y,...]
  pointerNowWU: [number, number];
}): RecognitionResult {
  // Convert flat array to Vec2 array for processing
  const points: Vec2[] = [];
  for (let i = 0; i < pointsWU.length; i += 2) {
    points.push([pointsWU[i], pointsWU[i + 1]]);
  }

  // Fit & score ONLY circle and box (no line scoring/competition)
  const circleFit = fitCircle(points);
  const circleScore = scoreCircle(points, circleFit);

  const boxFit = fitOBB(points);
  const { edges, corners } = detectEdgesAndCorners(points);
  const boxScore = scoreRectangle(points, boxFit, edges, corners);

  // Winner must clear the global confidence threshold
  const winner =
    boxScore >= circleScore
      ? { kind: 'box' as const, score: boxScore, data: boxFit }
      : { kind: 'circle' as const, score: circleScore, data: circleFit };

  if (winner.score >= SHAPE_CONFIDENCE_MIN) {
    // Shape-specific payload under winner.kind
    return { kind: winner.kind, score: winner.score, [winner.kind]: winner.data as any };
  }

  // Strict fallback: line with no straightness metric / no tie-breaks
  const A = points[0];
  const B = pointerNowWU;
  return { kind: 'line', score: 1, line: { A, B } };
}
```

### 5.2 Shape Fitting Functions (IMPLEMENTED)

**Files:**
- `/client/src/lib/geometry/fit-circle.ts` - Taubin algebraic circle fitting
- `/client/src/lib/geometry/fit-obb.ts` - PCA-based oriented bounding box fitting
- `/client/src/lib/geometry/types.ts` - Common geometric types (Vec2, Edge, Corner)

#### fit-circle.ts
Implements **Taubin algebraic circle fitting** for robust partial arc fitting:
- Handles degenerate cases (< 3 points)
- Computes centroid and moment matrices
- Solves characteristic polynomial using Newton's method
- Returns `{cx, cy, r, residualRMS}` with RMS of residuals for scoring

#### fit-obb.ts
Implements **PCA-based Oriented Bounding Box** fitting:
- Computes covariance matrix from points
- Extracts principal axes via eigendecomposition
- Projects points onto principal axes to find extents
- Returns `{cx, cy, angle, hx, hy}` where angle is the box rotation and hx/hy are half-extents

#### 5.2.a Helpers & Definitions (in `/client/src/lib/geometry/geometry-helpers.ts`)

**Implemented helpers:**

- **pcaAxisRatio(points)**: Computes covariance eigenvalues λ₁ ≥ λ₂ and returns `sqrt(λ₁ / λ₂)`. Used for circle roundness scoring and as a hard gate for circles (must be ≤ 1.70).

- **angularCoverage(points, center)**: Calculates the angular span of points around a center (0-1). Sorts points by angle, finds maximum gap, returns `(2π - maxGap) / 2π`. Circles require ≥ 0.667 (240°) coverage.

- **detectCorners(points)**: Identifies corners where turn angle > 45° and both adjacent segments are ≥ 10 world units. Returns array of `{index, angle, strength}`.

- **detectEdges(points, corners)**: Creates edges between consecutive corners. Skips edges with `indexDelta ≤ 3`. Returns array of `{startIdx, endIdx, angle, length}`.

- **detectEdgesAndCorners(points)**: Combined function that efficiently detects both edges and corners in one pass.

- **avgParallelError(edges)**: Calculates average angle difference between potentially opposite edges (in degrees). Used for rectangle scoring.

- **avgOrthogonalError(edges)**: Calculates average deviation from 90° for adjacent edges. Used for rectangle scoring.

- **coverageAcrossDistinctSides(points, obb)**: Evaluates how well points are distributed across all four sides of a rectangle (0-1 score).

- **top3Avg(values)**: Returns average of top 3 values from an array. Used for corner confidence scoring.

#### Geometry Internals

- **PCA → OBB & roundness**: The **first eigenvector** gives the OBB angle; `axisRatio = sqrt(λ₁/λ₂)` is re-used as the circle roundness signal and as a hard gate for circles (`≤ 1.70`).
- **Rectangle gating**: require **≥ 3 right-angle corners** within **± 20°**. Rectangles that do not show three right corners cannot compete.
- **Coverage**: For circles we require **≥ 240°** angular coverage measured around the circle center.

### 5.3 Scoring Functions (`/client/src/lib/geometry/score.ts`)

```typescript
import {
  SHAPE_CONFIDENCE_MIN,
  CIRCLE_MIN_COVERAGE,
  CIRCLE_MAX_AXIS_RATIO,
  CIRCLE_MAX_RMS_RATIO,
  RECT_MIN_CORNERS,
  RECT_CORNER_TOLERANCE_DEG,
  RECT_PARALLEL_TOLERANCE_DEG,
  RECT_ORTHOGONAL_TOLERANCE_DEG,
  RECT_WEIGHT_CORNERS,
  RECT_WEIGHT_PARALLEL,
  RECT_WEIGHT_ORTHOGONAL,
  RECT_WEIGHT_COVERAGE,
  CIRCLE_WEIGHT_COVERAGE,
  CIRCLE_WEIGHT_FIT,
  CIRCLE_WEIGHT_ROUND
} from './shape-params';

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

export function scoreRectangle(
  points: Vec2[],
  obb: { cx: number; cy: number; angle: number; hx: number; hy: number },
  edges: Edge[],
  corners: Corner[]
): number {
  // Gate: require ≥ 3 right-angle corners
  const rightAngleCorners = corners.filter(
    c => Math.abs(c.angle - 90) <= RECT_CORNER_TOLERANCE_DEG
  );
  if (rightAngleCorners.length < RECT_MIN_CORNERS) return 0;

  // Compute component scores
  const S_corners = top3Avg(
    rightAngleCorners.map(c =>
      1 - clamp01(Math.abs(c.angle - 90) / RECT_CORNER_TOLERANCE_DEG)
    )
  );
  const S_parallel = 1 - clamp01(avgParallelError(edges) / RECT_PARALLEL_TOLERANCE_DEG);
  const S_orthogonal = 1 - clamp01(avgOrthogonalError(edges) / RECT_ORTHOGONAL_TOLERANCE_DEG);
  const S_coverage = coverageAcrossDistinctSides(points, obb); // normalized 0..1

  // Weighted score
  const S_rect =
    RECT_WEIGHT_CORNERS * S_corners +
    RECT_WEIGHT_PARALLEL * S_parallel +
    RECT_WEIGHT_ORTHOGONAL * S_orthogonal +
    RECT_WEIGHT_COVERAGE * S_coverage;

  return S_rect >= SHAPE_CONFIDENCE_MIN ? S_rect : 0;
}

export function scoreCircle(
  points: Vec2[],
  fit: { cx: number; cy: number; r: number; residualRMS: number }
): number {
  const axisRatio = pcaAxisRatio(points);

  // Hard gates (fail fast)
  if (axisRatio > CIRCLE_MAX_AXIS_RATIO) return 0;

  const coverage = angularCoverage(points, [fit.cx, fit.cy]);
  if (coverage < CIRCLE_MIN_COVERAGE) return 0;

  const rmsNorm = fit.residualRMS / fit.r;
  if (rmsNorm > CIRCLE_MAX_RMS_RATIO) return 0;

  // Blended score (coverage-dominant)
  const S_coverage = clamp01((coverage - CIRCLE_MIN_COVERAGE) / (1 - CIRCLE_MIN_COVERAGE));
  const S_fit = clamp01(1 - (rmsNorm / CIRCLE_MAX_RMS_RATIO));
  const S_round = clamp01(1 - ((axisRatio - 1) / (CIRCLE_MAX_AXIS_RATIO - 1)));

  return CIRCLE_WEIGHT_COVERAGE * S_coverage +
         CIRCLE_WEIGHT_FIT * S_fit +
         CIRCLE_WEIGHT_ROUND * S_round;
}

// Note: No scoreLine function - line is a strict fallback, not a scored candidate
```

