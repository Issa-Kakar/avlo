# Avlo Drawing & Rendering Pipeline - Comprehensive Technical Documentation

**Purpose:** Complete technical reference for understanding how strokes flow from user input through preview, recognition, simplification, commit, and final rendering. This document covers all data transformations, array constructions, caching strategies, and rendering techniques.

**Last Updated:** 2025-10-06

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Data Flow Summary](#data-flow-summary)
3. [Drawing Tool Pipeline](#drawing-tool-pipeline)
4. [Preview Systems](#preview-systems)
5. [Perfect Shape Recognition](#perfect-shape-recognition)
6. [Simplification & Commit](#simplification--commit)
7. [Rendering Architecture](#rendering-architecture)
8. [Path2D & Stroke Caching](#path2d--stroke-caching)
9. [Array Transformations Reference](#array-transformations-reference)
10. [Key Implementation Files](#key-implementation-files)

---

## Architecture Overview

### Two-Canvas System

**Base Canvas** (`/client/src/canvas/CanvasStage.tsx`)
- Renders committed world content (strokes, text, shapes)
- Event-driven invalidation only (no continuous loop)
- Dirty-rect optimization for partial redraws
- Full clear on scene changes or transform changes

**Overlay Canvas** (`/client/src/renderer/OverlayRenderLoop.ts`)
- Renders ephemeral content (preview, presence cursors)
- Full clear every frame (cheap for sparse overlay)
- Always renders on top of base canvas
- `pointer-events: none` (events handled by base canvas)

### Coordinate Spaces

```typescript
// Three coordinate spaces in the system:
// 1. SCREEN (CSS pixels) - DOM events, cursor positions
// 2. WORLD (world units) - Stroke storage, geometric calculations
// 3. DEVICE (device pixels) - Canvas backing store with DPR

// Transform chain:
// Screen → World: canvasToWorld(x, y) = [x/scale + pan.x, y/scale + pan.y]
// World → Screen: worldToCanvas(x, y) = [(x - pan.x) * scale, (y - pan.y) * scale]

// Canvas context transform order:
// ctx.setTransform(dpr, 0, 0, dpr, 0, 0);  // DPR applied ONCE by CanvasStage
// ctx.scale(view.scale, view.scale);        // World zoom
// ctx.translate(-view.pan.x, -view.pan.y);  // World pan
```

---

## Data Flow Summary

```
User Input (Pointer Events)
    ↓
Canvas.tsx (Event Routing)
    ↓
DrawingTool.begin/move/end
    ↓
RAF-Coalesced Point Buffer
    ↓                              ↓
Freehand Preview           Hold Detector (600ms)
    ↓                              ↓
Overlay Rendering          Shape Recognition
    ↓                              ↓
                          Perfect Shape Preview
                                   ↓
                          Overlay Rendering
                                   ↓
Pointer-Up Commit ←────────────────┘
    ↓
RDP Simplification
    ↓
Yjs Transaction
    ↓
Snapshot Update
    ↓
Base Canvas Invalidation
    ↓
RenderLoop (Event-Driven)
    ↓
Path2D Cache + Stroke Rendering
```

---

## Drawing Tool Pipeline

### File: `/client/src/lib/tools/DrawingTool.ts`

The DrawingTool manages the complete lifecycle of a drawing gesture from pointer-down to commit.

### State Management

```typescript
interface DrawingState {
  isDrawing: boolean;
  pointerId: number | null;
  points: number[];  // Flat array: [x0,y0, x1,y1, ...] in WORLD coordinates
  config: DrawingToolConfig; // Frozen at pointer-down
  startTime: number;
}

interface DrawingToolConfig {
  tool: 'pen' | 'highlighter';
  color: string;  // #RRGGBB format
  size: number;   // World units
  opacity: number; // 0-1 range
}
```

**CRITICAL:** Tool settings are **frozen at pointer-down** and never change during a gesture. This ensures visual consistency from preview to commit.

### Pointer Event Handling

#### begin(pointerId, worldX, worldY)

```typescript
// Two modes: Forced snap (shape tools) vs. freehand (pen/highlighter)

if (this.opts.forceSnapKind) {
  // Shape tool mode: Seed snap immediately
  this.snap = { kind: 'rect', anchors: { A: [worldX, worldY] } };
  this.liveCursorWU = [worldX, worldY];
  this.requestOverlayFrame();
  return; // Skip HoldDetector
}

// Freehand mode: Start HoldDetector for auto-recognition
const [screenX, screenY] = view.worldToCanvas(worldX, worldY);
this.hold.start({ x: screenX, y: screenY }); // Screen-space jitter
this.snap = null;
this.liveCursorWU = [worldX, worldY];
this.requestOverlayFrame();
```

#### move(worldX, worldY)

```typescript
// ALWAYS update live cursor (critical for snap preview)
this.liveCursorWU = [worldX, worldY];

if (!this.snap) {
  // Before snap: update hold detector with screen coordinates
  const [screenX, screenY] = view.worldToCanvas(worldX, worldY);
  this.hold.move({ x: screenX, y: screenY });

  // Freehand path: RAF-coalesced point addition
  this.addPoint(worldX, worldY);
} else {
  // After snap: just request overlay frame (geometry computed from anchors + cursor)
  this.requestOverlayFrame();
}
```

**RAF Coalescing:**

```typescript
// addPoint() uses RAF to coalesce high-frequency pointer events
private pendingPoint: [number, number] | null = null;
private rafId: number | null = null;

addPoint(worldX: number, worldY: number): void {
  this.pendingPoint = [worldX, worldY];

  if (!this.rafId) {
    this.rafId = requestAnimationFrame(() => {
      if (this.pendingPoint) {
        this.state.points.push(...this.pendingPoint);
        this.updateBounds(); // Invalidates overlay with new bounds
      }
      this.pendingPoint = null;
      this.rafId = null;
    });
  }
}
```

This prevents excessive array allocations and invalidation calls during fast pointer movement.

#### end(worldX?, worldY?)

```typescript
this.hold.cancel(); // Stop hold detector

if (this.snap && this.liveCursorWU) {
  // Perfect shape: Generate polyline from anchors + final cursor
  this.commitPerfectShapeFromPreview();
} else {
  // Freehand: Simplify and commit raw points
  this.flushPending(); // Critical: ensure RAF buffer is committed
  this.commitStroke(finalX, finalY);
}
```

### Hold Detector

**File:** `/client/src/lib/input/HoldDetector.ts`

Triggers shape recognition after 600ms of pointer stillness.

```typescript
class HoldDetector {
  private dwellMs = 600;
  private jitterPx = 6; // Screen-space threshold

  start(screenPos: { x: number; y: number }) {
    this.lastPos = screenPos;
    this.timerId = setTimeout(this.onFire, this.dwellMs);
  }

  move(screenPos: { x: number; y: number }) {
    const dist = Math.hypot(
      screenPos.x - this.lastPos.x,
      screenPos.y - this.lastPos.y
    );

    if (dist > this.jitterPx) {
      // Movement exceeded jitter - reset timer
      this.lastPos = screenPos;
      clearTimeout(this.timerId);
      this.timerId = setTimeout(this.onFire, this.dwellMs);
    }
  }
}
```

**Why screen space?** Jitter tolerance feels consistent regardless of zoom level. A 6px hand tremor should always be tolerated, not scaled with zoom.

---

## Preview Systems

### Freehand Preview

**File:** `/client/src/renderer/layers/preview.ts`

**Data Structure:**

```typescript
interface StrokePreview {
  kind: 'stroke';
  points: ReadonlyArray<number>; // Flat array in WORLD coordinates
  tool: 'pen' | 'highlighter';
  color: string;
  size: number;
  opacity: number;
  bbox: [number, number, number, number] | null;
}
```

**Rendering (overlay canvas with world transform):**

```typescript
export function drawPreview(ctx: CanvasRenderingContext2D, preview: StrokePreview) {
  // Context already has world transform applied by OverlayRenderLoop
  ctx.save();
  ctx.strokeStyle = preview.color;
  ctx.lineWidth = preview.size; // World units
  ctx.globalAlpha = preview.opacity;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  ctx.beginPath();
  ctx.moveTo(preview.points[0], preview.points[1]);

  for (let i = 2; i < preview.points.length; i += 2) {
    ctx.lineTo(preview.points[i], preview.points[i + 1]);
  }

  ctx.stroke();
  ctx.restore();
}
```

**No Path2D, No Float32Array:** Previews use immediate-mode rendering. The points array is the live buffer from DrawingTool, never converted to typed arrays.

### Perfect Shape Preview

**File:** `/client/src/renderer/layers/perfect-shape-preview.ts`

**Data Structure:**

```typescript
interface PerfectShapePreview {
  kind: 'perfectShape';
  shape: 'line' | 'circle' | 'box' | 'rect' | 'ellipseRect' | 'arrow';
  color: string;
  size: number;
  opacity: number;
  anchors: PerfectShapeAnchors; // Frozen at snap moment
  cursor: [number, number];     // Live pointer in world coords
  bbox: null;                   // Never computed for preview
}

type PerfectShapeAnchors =
  | { kind: 'line';        A: [number, number] }
  | { kind: 'circle';      center: [number, number] }
  | { kind: 'box';         cx: number; cy: number; angle: number; hx0: number; hy0: number }
  | { kind: 'rect';        A: [number, number] }
  | { kind: 'ellipseRect'; A: [number, number] }
  | { kind: 'arrow';       A: [number, number] };
```

**Key Insight:** The preview contains **inputs** (anchors + cursor), not final geometry. The renderer computes geometry on-the-fly.

**Rendering Examples:**

```typescript
// Line: Simple segment
if (anchors.kind === 'line') {
  ctx.beginPath();
  ctx.moveTo(anchors.A[0], anchors.A[1]);
  ctx.lineTo(cursor[0], cursor[1]);
  ctx.stroke();
}

// Circle: Radius from cursor distance
if (anchors.kind === 'circle') {
  const r = Math.hypot(cursor[0] - anchors.center[0], cursor[1] - anchors.center[1]);
  ctx.beginPath();
  ctx.arc(anchors.center[0], anchors.center[1], r, 0, Math.PI * 2);
  ctx.stroke();
}

// Rectangle (AABB, corner-anchored)
if (anchors.kind === 'rect') {
  const A = anchors.A;
  const C = cursor;
  const B: [number, number] = [C[0], A[1]];
  const D: [number, number] = [A[0], C[1]];

  ctx.beginPath();
  ctx.moveTo(A[0], A[1]);
  ctx.lineTo(B[0], B[1]);
  ctx.lineTo(C[0], C[1]);
  ctx.lineTo(D[0], D[1]);
  ctx.closePath();
  ctx.stroke();
}

// Ellipse (corner-anchored, inscribed in AABB)
if (anchors.kind === 'ellipseRect') {
  const minX = Math.min(anchors.A[0], cursor[0]);
  const maxX = Math.max(anchors.A[0], cursor[0]);
  const minY = Math.min(anchors.A[1], cursor[1]);
  const maxY = Math.max(anchors.A[1], cursor[1]);
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const rx = Math.max(0.0001, (maxX - minX) / 2);
  const ry = Math.max(0.0001, (maxY - minY) / 2);

  ctx.beginPath();
  ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
  ctx.stroke();
}
```

---

## Perfect Shape Recognition

### File: `/client/src/lib/geometry/recognize-open-stroke.ts`

Triggered by HoldDetector after 600ms of stillness.

### Two-Channel Preprocessing

The recognition system uses **two separate data channels** for different purposes:

**Track-A (Raw Points):** Original stroke points
- Used for: Circle fitting, rectangle AABB fitting, side proximity scoring
- Preserves: Outliers for robust statistical fitting (percentile-trimmed)

**Track-B (Clean Points):** RDP simplified → distance decimated → micro-closed
- Used for: Corner detection, edge detection, self-intersection tests
- Purpose: Jitter-free geometry analysis for stable corner/edge detection

```typescript
// Track-A: Raw points (already in Vec2[] format)
const rawPts = points;

// Track-B: Build clean points
let flat = pointsWU.slice(); // Copy flat array

// Step 1: RDP simplification (removes jitter)
const rdp = simplifyStroke(flat, 'pen'); // 0.8 WU tolerance
if (rdp.points.length >= 4) flat = rdp.points;

// Step 2: Distance decimation (minimum segment length)
const minSegWU = Math.max(10, Math.min(18, 0.06 * diagonal));
const decimated: number[] = [];
let lastX = flat[0], lastY = flat[1];
decimated.push(lastX, lastY);

for (let i = 2; i < flat.length; i += 2) {
  const x = flat[i], y = flat[i + 1];
  const dist = Math.hypot(x - lastX, y - lastY);
  if (dist >= minSegWU) {
    decimated.push(x, y);
    lastX = x;
    lastY = y;
  }
}

// Step 3: Micro-closure (snap nearly-closed strokes)
const gap = Math.hypot(endX - startX, endY - startY);
if (gap <= 0.06 * diagonal) {
  decimated.push(startX, startY); // Close the loop
}

// Convert to Vec2 for corner/edge detection
const cleanPts: Vec2[] = [];
for (let i = 0; i < decimated.length; i += 2) {
  cleanPts.push([decimated[i], decimated[i + 1]]);
}
```

### Shape Fitting

**Circle Fitting** (`/client/src/lib/geometry/fit-circle.ts`)
- Algorithm: Taubin algebraic circle fit
- Robust to partial arcs and outliers
- Returns: `{ cx, cy, r, residualRMS }`

**Rectangle Fitting** (`/client/src/lib/geometry/fit-aabb.ts`)
- Algorithm: Axis-aligned bounding box with percentile trimming
- Uses 5th-95th percentile to resist outliers
- Returns: `{ cx, cy, hx, hy, minX, minY, maxX, maxY, angle: 0 }`

### Shape Scoring

**Circle Scoring** (`/client/src/lib/geometry/score.ts`)

```typescript
// Hard Gates (immediate rejection):
// 1. PCA Axis Ratio ≤ 1.70 (roundness)
// 2. Angular Coverage ≥ 240° (2π/3 radians)
// 3. Normalized RMS ≤ 0.24 (fit quality)

// Soft Scores (weighted):
const S_coverage = (coverage - 0.667) / (1 - 0.667);  // 50% weight
const S_fit = 1 - (rmsNorm / 0.24);                   // 30% weight
const S_round = 1 - ((axisRatio - 1) / 0.70);         // 20% weight

const score = 0.50 * S_coverage + 0.30 * S_fit + 0.20 * S_round;
```

**Rectangle Scoring** (`/client/src/lib/geometry/score.ts`)

```typescript
// No hard gates - all soft scoring

// 1. Side Proximity (30%) - fraction of points within epsilon of AABB sides
const S_sideDist = aabbSideFitScore(rawPts, aabb, epsilon);

// 2. Side Coverage with Evenness (20%) - sides visited + distribution balance
const S_sideCov = aabbCoverageAcrossDistinctSides(rawPts, aabb);

// 3. Corner Quality (50%) - top-3 average right-angle quality
const rightAngleScores = corners.map(c =>
  Math.max(0, 1 - Math.abs(c.angle - 90) / tolerance)
);
const S_corners = top3Avg(rightAngleScores);

// 4. Parallel Edges (0% - currently disabled)
// 5. Orthogonal Edges (0% - currently disabled)

let score = 0.30 * S_sideDist + 0.20 * S_sideCov + 0.50 * S_corners;

// Apply right-angle penalties
if (rightAngleCount === 0) score *= 0.5;
if (rightAngleCount === 2) score -= 0.03;

return Math.max(0, Math.min(1, score));
```

### Corner & Edge Detection

**File:** `/client/src/lib/geometry/geometry-helpers.ts`

**Corner Detection:**

```typescript
// Detects significant turn angles (>45°) with minimum segment lengths
// Peak-at-90° strength: strength = max(0, 1 - |angle - 90°| / 45°)

for (let i = 1; i < n - 1; i++) {
  const angle1 = Math.atan2(y1 - y0, x1 - x0);
  const angle2 = Math.atan2(y2 - y1, x2 - x1);
  let turnAngle = angle2 - angle1;

  // Normalize to [-π, π]
  while (turnAngle > Math.PI) turnAngle -= 2 * Math.PI;
  while (turnAngle < -Math.PI) turnAngle += 2 * Math.PI;

  const cornerAngleDeg = Math.abs(turnAngle) * 180 / Math.PI;
  const deviation = Math.abs(cornerAngleDeg - 90);
  const strength = Math.max(0, 1 - deviation / 45);

  if (Math.abs(turnAngle) > minTurnAngleRad) {
    corners.push({ index: i, angle: cornerAngleDeg, strength });
  }
}
```

**Edge Reconstruction (for rectangles):**

```typescript
// Select 4 best corners by strength, sort by position
const bestCorners = corners.sort((a, b) => b.strength - a.strength).slice(0, 4);
bestCorners.sort((a, b) => a.index - b.index);

// Build edges between consecutive corners + closing edge
for (let i = 0; i < 4; i++) {
  const startIdx = bestCorners[i].index;
  const endIdx = bestCorners[(i + 1) % 4].index;

  // Use PCA-based angle for stability (not just endpoints)
  const angle = robustSegmentAngle(points, startIdx, endIdx);

  edges.push({ startIdx, endIdx, angle, length });
}
```

### Ambiguity Detection

The system has **multiple ambiguity guards** to prevent unwanted line snaps:

```typescript
// 1. Near-miss: Score within 0.10 of threshold (0.48-0.58)
if (maxScore >= 0.48 && maxScore < 0.58) return { kind: 'line', ambiguous: true };

// 2. Too many corners: >4 right angles
if (rightAngleCount > 4) return { kind: 'line', ambiguous: true };

// 3. Rectangle wins but <2 right angles
if (winner === 'box' && rightAngleCount < 2) return { kind: 'line', ambiguous: true };

// 4. Circle wins but ≥1 right angle detected
if (winner === 'circle' && rightAngleCount >= 1) return { kind: 'line', ambiguous: true };

// 5. Self-intersection (segments cross)
if (hasSelfIntersection(decimated, epsilon)) return { kind: 'line', ambiguous: true };

// 6. Near-closure (start/end within 6% of diagonal)
if (gap <= 0.06 * diagonal) return { kind: 'line', ambiguous: true };

// 7. Near self-touch (segments come close without crossing)
if (hasNearTouch(decimated, epsilon)) return { kind: 'line', ambiguous: true };
```

**When ambiguous:** DrawingTool continues freehand (no snap).

---

## Simplification & Commit

### File: `/client/src/lib/tools/simplification.ts`

RDP (Ramer-Douglas-Peucker) simplification runs **only at commit time**, never during preview.

### Algorithm: Iterative Douglas-Peucker

```typescript
function douglasPeucker(points: number[], tolerance: number): number[] {
  const numPoints = points.length / 2;
  const keep = new Uint8Array(numPoints);
  keep[0] = 1; // Always keep first
  keep[numPoints - 1] = 1; // Always keep last

  const stack: [number, number][] = [[0, numPoints - 1]];

  while (stack.length > 0) {
    const [startIdx, endIdx] = stack.pop()!;
    if (endIdx - startIdx < 2) continue;

    // Find farthest point from line segment
    let maxDist = 0;
    let maxIdx = -1;

    for (let i = startIdx + 1; i < endIdx; i++) {
      const dist = perpendicularDistance(
        points[i*2], points[i*2+1],
        points[startIdx*2], points[startIdx*2+1],
        points[endIdx*2], points[endIdx*2+1]
      );
      if (dist > maxDist) {
        maxDist = dist;
        maxIdx = i;
      }
    }

    if (maxDist >= tolerance && maxIdx !== -1) {
      keep[maxIdx] = 1;
      stack.push([startIdx, maxIdx]);
      stack.push([maxIdx, endIdx]);
    }
  }

  // Rebuild simplified array
  const result: number[] = [];
  for (let i = 0; i < numPoints; i++) {
    if (keep[i]) {
      result.push(points[i*2], points[i*2+1]);
    }
  }
  return result;
}
```

**Why iterative?** Stack-based to prevent stack overflow on 10k+ point strokes.

### Tolerance Strategy

```typescript
// Base tolerances (world units)
const baseTol = tool === 'pen' ? 0.8 : 0.5; // Highlighter stricter

let simplified = douglasPeucker(points, baseTol);
const size = estimateEncodedSize(simplified);
const count = simplified.length / 2;

// Check constraints: 10k points OR 128KB update
if (size > 128_000 || count > 10_000) {
  // Retry with 1.4x tolerance
  simplified = douglasPeucker(points, baseTol * 1.4);

  // Still over? Hard downsample to 10k points
  if (simplified.length / 2 > 10_000) {
    simplified = hardDownsample(simplified, 10_000);
  }

  // Final size check
  if (estimateEncodedSize(simplified) > 128_000) {
    return { points: [], simplified: false }; // Reject
  }
}
```

### Commit to Yjs

```typescript
// Generate polyline from perfect shape OR use simplified freehand
const points = this.snap
  ? this.generatePolylineFromShape(this.snap, this.liveCursorWU)
  : simplified;

const bbox = calculateBBox(points, this.state.config.size);

this.room.mutate((ydoc) => {
  const root = ydoc.getMap('root');
  const strokes = root.get('strokes') as Y.Array<any>;
  const meta = root.get('meta') as Y.Map<any>;
  const sceneTicks = meta.get('scene_ticks') as Y.Array<number>;
  const currentScene = sceneTicks.length;

  strokes.push([{
    id: ulid(),
    tool: this.state.config.tool,
    color: this.state.config.color,
    size: this.state.config.size,
    opacity: this.state.config.opacity,
    points,  // Plain number[] - NEVER Float32Array
    bbox,
    scene: currentScene,
    createdAt: Date.now(),
    userId: this.userId
  }]);
});
```

**CRITICAL:** Yjs stores `number[]`, never typed arrays. Float32Arrays are built at render time only.

---

## Rendering Architecture

### Event-Driven RenderLoop

**File:** `/client/src/renderer/RenderLoop.ts`

The base canvas uses an **event-driven** architecture: frames are scheduled ONLY when content is invalidated.

```typescript
class RenderLoop {
  private needsFrame = false;
  private rafId: number | null = null;

  // Public invalidation APIs
  invalidateWorld(bounds: WorldBounds): void {
    this.dirtyTracker.invalidateWorldBounds(bounds, view);
    this.markDirty(); // Schedules frame if needed
  }

  invalidateAll(reason: InvalidationReason): void {
    this.dirtyTracker.invalidateAll(reason);
    this.markDirty();
  }

  private markDirty(): void {
    if (!this.needsFrame) {
      this.needsFrame = true;
      this.framesSinceInvalidation = 0;
      this.scheduleFrameIfNeeded();
    }
  }

  private scheduleFrameIfNeeded(): void {
    if (this.rafId !== null) return;

    this.rafId = requestAnimationFrame(() => {
      this.tick();
      this.rafId = null;
      // Schedule next frame ONLY if still dirty
      if (this.needsFrame) this.scheduleFrameIfNeeded();
    });
  }
}
```

**Zero idle CPU:** When nothing changes, no frames are rendered.

### Dirty Rectangle Optimization

```typescript
// Check for scene change (forces full clear)
if (snapshot.scene !== this.lastRenderedScene) {
  this.dirtyTracker.invalidateAll('scene-change');
}

// Check for transform change (forces full clear)
if (transformChanged) {
  this.dirtyTracker.notifyTransformChange(view);
}

// Check for translucent content (forces full clear to avoid alpha artifacts)
if (hasTranslucentInView) {
  this.dirtyTracker.invalidateAll('content-change');
}

// Get clear instructions
const clearInstructions = this.dirtyTracker.getClearInstructions();

if (clearInstructions.type === 'full') {
  ctx.clearRect(0, 0, pixelWidth, pixelHeight);
} else if (clearInstructions.type === 'dirty') {
  for (const rect of clearInstructions.rects) {
    ctx.clearRect(rect.x, rect.y, rect.width, rect.height);
  }
}
```

### Render Order (Base Canvas)

```typescript
stage.withContext((ctx) => {
  // Apply world transform
  ctx.scale(view.scale, view.scale);
  ctx.translate(-view.pan.x, -view.pan.y);

  // Draw layers in order
  drawBackground(ctx, snapshot, view, viewport);
  drawStrokes(ctx, snapshot, view, viewport); // all shapes commit as a stroke
  //drawShapes(ctx, snapshot, view, viewport); // Dormant
  drawText(ctx, snapshot, view, viewport);
  drawAuthoringOverlays(ctx, snapshot, view, viewport);
});

// HUD (screen space with DPR only)
stage.withContext((ctx) => {
  drawHUD(ctx, snapshot, view, viewport);
});
```

### Stroke Rendering

**File:** `/client/src/renderer/layers/strokes.ts`

```typescript
export function drawStrokes(
  ctx: CanvasRenderingContext2D,
  snapshot: Snapshot,
  viewTransform: ViewTransform,
  viewport: ViewportInfo
) {
  // Clear cache on scene change
  if (snapshot.scene !== lastScene) {
    strokeCache.clear();
    lastScene = snapshot.scene;
  }

  const visibleBounds = getVisibleWorldBounds(viewTransform, viewport);

  for (const stroke of snapshot.strokes) {
    // Viewport culling
    if (!isStrokeVisible(stroke, visibleBounds)) continue;

    // LOD: Skip tiny strokes (<2px screen diagonal)
    if (shouldSkipLOD(stroke, viewTransform)) continue;

    renderStroke(ctx, stroke, viewTransform);
  }
}

function renderStroke(ctx: CanvasRenderingContext2D, stroke: StrokeView) {
  const renderData = strokeCache.getOrBuild(stroke);

  ctx.save();
  ctx.strokeStyle = stroke.style.color;
  ctx.lineWidth = stroke.style.size; // World units
  ctx.globalAlpha = stroke.style.opacity;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  if (renderData.path) {
    ctx.stroke(renderData.path); // Fast Path2D rendering
  } else {
    // Fallback for test environments
    ctx.beginPath();
    const pl = renderData.polyline;
    ctx.moveTo(pl[0], pl[1]);
    for (let i = 2; i < pl.length; i += 2) {
      ctx.lineTo(pl[i], pl[i + 1]);
    }
    ctx.stroke();
  }

  ctx.restore();
}
```

---

## Path2D & Stroke Caching

### File: `/client/src/renderer/stroke-builder/path-builder.ts`

Strokes are **immutable after commit only right now (future will change this)**, so ID-keyed caching is safe and efficient.

### Building Render Data

```typescript
export function buildStrokeRenderData(stroke: StrokeView): StrokeRenderData {
  const { points } = stroke; // ReadonlyArray<number>
  const pointCount = points.length / 2;

  // Build Float32Array at render time (NEVER stored)
  const polyline = new Float32Array(pointCount * 2);

  // Feature-detect Path2D (missing in test environments)
  const path = typeof Path2D === 'function' ? new Path2D() : null;

  let minX = points[0], maxX = points[0];
  let minY = points[1], maxY = points[1];

  if (path) path.moveTo(points[0], points[1]);
  polyline[0] = points[0];
  polyline[1] = points[1];

  for (let i = 1; i < pointCount; i++) {
    const x = points[i * 2];
    const y = points[i * 2 + 1];

    if (path) path.lineTo(x, y);
    polyline[i * 2] = x;
    polyline[i * 2 + 1] = y;

    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }

  return {
    path,     // Path2D or null
    polyline, // Float32Array for fallback
    bounds: { x: minX, y: minY, width: maxX - minX, height: maxY - minY },
    pointCount
  };
}
```

### Stroke Cache

**File:** `/client/src/renderer/stroke-builder/stroke-cache.ts`

```typescript
class StrokeRenderCache {
  private cache = new Map<string, StrokeRenderData>();
  private maxSize = 1000;

  getOrBuild(stroke: StrokeView): StrokeRenderData {
    const cached = this.cache.get(stroke.id);
    if (cached) return cached;

    // Build new render data
    const renderData = buildStrokeRenderData(stroke);

    // FIFO eviction if full
    if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }

    this.cache.set(stroke.id, renderData);
    return renderData;
  }

  clear(): void {
    this.cache.clear();
  }
}

// Singleton instance shared across all stroke rendering
let globalCacheInstance: StrokeRenderCache | null = null;

export function getStrokeCacheInstance(): StrokeRenderCache {
  if (!globalCacheInstance) {
    globalCacheInstance = new StrokeRenderCache(1000);
  }
  return globalCacheInstance;
}
```

**Cache Invalidation:**
- Scene change: `strokeCache.clear()`
- Stroke deletion: `strokeCache.invalidate(strokeId)`
- FIFO eviction when cache is full

---

## Array Transformations Reference

### Complete Data Journey

```
1. POINTER INPUT (Screen Coords)
   Event: { clientX: 500, clientY: 300 } (CSS pixels)

   ↓ canvasToWorld(clientX, clientY)

2. WORLD COORDINATES
   DrawingTool.state.points: [123.4, 567.8, 125.1, 569.2, ...]
   Type: number[] (flat array, NOT Float32Array)

   ↓ RAF coalescing (addPoint)

3. PREVIEW (Overlay)
   StrokePreview.points: ReadonlyArray<number>
   Type: number[] (same reference, immutable view)
   Rendering: Immediate-mode ctx.lineTo() in world space

   ↓ Hold detector fires (600ms)

4. SHAPE RECOGNITION
   Track-A (Raw): Vec2[] = [[x0,y0], [x1,y1], ...]
   Track-B (Clean): number[] → RDP → decimate → Vec2[]

   Fitting: Circle (Taubin), Rectangle (AABB percentiles)
   Scoring: Weighted components, ambiguity checks

   ↓ Snap OR continue freehand

5. PERFECT SHAPE (if snapped)
   Anchors: Frozen at snap moment
   Preview: Geometry computed from anchors + liveCursorWU
   Commit: Generate polyline from final geometry

   Rectangle: [Ax,Ay, Bx,By, Cx,Cy, Dx,Dy, Ax,Ay] (5 points, closed)
   Circle: Adaptive density (n = max(24, ceil(2πr / 8)))
   Ellipse: Ramanujan perimeter approx for density
   Arrow: [Ax,Ay, Bx,By, H1x,H1y, Bx,By, H2x,H2y] (5 points)

6. SIMPLIFICATION (Freehand only)
   Input: number[] (raw points)
   Algorithm: Iterative Douglas-Peucker
   Tolerance: pen 0.8 WU, highlighter 0.5 WU
   Retry: × 1.4 if over limits
   Fallback: Hard downsample to 10k points
   Output: number[] (simplified)

7. COMMIT TO YJS
   points: number[] (plain array, NEVER Float32Array)
   bbox: [minX, minY, maxX, maxY] (with stroke width inflation)

   Y.Array.push([{ id, tool, color, size, opacity, points, bbox, scene, ... }])

8. SNAPSHOT CREATION
   StrokeView.points: ReadonlyArray<number>
   Type: number[] (from Yjs, immutable wrapper)

9. RENDER-TIME CONVERSION
   Input: ReadonlyArray<number>
   Output: StrokeRenderData {
     path: Path2D | null
     polyline: Float32Array  ← ONLY TIME typed array is created
     bounds: { x, y, width, height }
   }

10. CANVAS RENDERING
    ctx.stroke(renderData.path)  ← GPU-accelerated Path2D

    OR (fallback)

    for (let i = 0; i < polyline.length; i += 2) {
      ctx.lineTo(polyline[i], polyline[i+1]);
    }
```

### Type Safety Rules

```typescript
// ✅ CORRECT: Yjs storage
interface Stroke {
  points: number[]; // Plain array
}

// ❌ WRONG: Never store typed arrays in Yjs
interface StrokeBad {
  points: Float32Array; // CRDT can't serialize this
}

// ✅ CORRECT: Snapshot view (immutable wrapper)
interface StrokeView {
  points: ReadonlyArray<number>;
}

// ✅ CORRECT: Render data (ephemeral)
interface StrokeRenderData {
  polyline: Float32Array; // Built at render time only
}
```

---

## Key Implementation Files

### Drawing & Tools

- `/client/src/lib/tools/DrawingTool.ts` - Main drawing tool, RAF coalescing, hold detector integration
- `/client/src/lib/tools/types.ts` - Preview data types, shape anchors
- `/client/src/lib/input/HoldDetector.ts` - 600ms dwell detection with screen-space jitter

### Geometry & Recognition

- `/client/src/lib/geometry/recognize-open-stroke.ts` - Main recognition algorithm, two-channel preprocessing
- `/client/src/lib/geometry/fit-circle.ts` - Taubin algebraic circle fitting
- `/client/src/lib/geometry/fit-aabb.ts` - Percentile-trimmed AABB fitting
- `/client/src/lib/geometry/score.ts` - Circle and rectangle scoring functions
- `/client/src/lib/geometry/geometry-helpers.ts` - Corner detection, edge reconstruction, self-intersection tests
- `/client/src/lib/geometry/shape-params.ts` - All recognition thresholds and weights

### Simplification

- `/client/src/lib/tools/simplification.ts` - Iterative Douglas-Peucker, hard downsample, bbox calculation

### Rendering

- `/client/src/renderer/RenderLoop.ts` - Event-driven base canvas loop, dirty rect optimization
- `/client/src/renderer/OverlayRenderLoop.ts` - Overlay canvas loop for preview and presence
- `/client/src/renderer/layers/strokes.ts` - Stroke rendering with caching and culling
- `/client/src/renderer/layers/preview.ts` - Freehand preview rendering
- `/client/src/renderer/layers/perfect-shape-preview.ts` - Perfect shape preview rendering
- `/client/src/renderer/stroke-builder/path-builder.ts` - Float32Array and Path2D construction
- `/client/src/renderer/stroke-builder/stroke-cache.ts` - ID-keyed render data cache

### Canvas Integration

- `/client/src/canvas/Canvas.tsx` - Main canvas component, event routing, tool lifecycle
- `/client/src/canvas/CanvasStage.tsx` - Low-level canvas wrapper with DPR handling

---

## Summary

The Avlo drawing system is architected around **clear separation of concerns**:

1. **Input Layer** (DrawingTool) - Handles pointer events, RAF coalescing, hold detection
2. **Recognition Layer** (recognize-open-stroke) - Two-channel preprocessing, fitting, scoring, ambiguity detection
3. **Preview Layer** (OverlayRenderLoop) - Ephemeral rendering with immediate-mode graphics
4. **Simplification Layer** (Douglas-Peucker) - Commit-time optimization with fallbacks
5. **Storage Layer** (Yjs) - Plain arrays for CRDT compatibility
6. **Rendering Layer** (RenderLoop) - Event-driven invalidation with Path2D caching

**Key Performance Optimizations:**
- RAF coalescing prevents excessive allocations during pointer movement
- Event-driven rendering ensures zero idle CPU
- Dirty rectangle optimization for partial redraws
- Path2D caching with ID-based lookup (strokes are immutable)
- Viewport culling and LOD for large scenes
- Float32Array construction deferred until render time

**Key Design Principles:**
- Points stored as `number[]` in Yjs, converted to `Float32Array` only at render
- Previews use immediate-mode rendering (no caching, no typed arrays)
- Perfect shape previews store inputs (anchors + cursor), not final geometry
- Two-channel preprocessing for optimal fitting vs. corner detection
- Aggressive ambiguity detection to prevent unwanted line snaps
- Iterative RDP to handle 10k+ point strokes without stack overflow
