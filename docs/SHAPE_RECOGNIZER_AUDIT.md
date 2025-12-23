# Perfect Shape Recognition System - Complete Audit

**Date:** 2025-12-21
**Purpose:** Comprehensive documentation of the current shape recognition pipeline for context in transitioning to a Point Cloud ($P/$Q) approach.

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Trigger Mechanism: HoldDetector](#2-trigger-mechanism-holddetector)
3. [DrawingTool State Machine](#3-drawingtool-state-machine)
4. [Recognition Pipeline: recognizeOpenStroke](#4-recognition-pipeline-recognizeopenstroke)
5. [Fitting Algorithms](#5-fitting-algorithms)
6. [Scoring Algorithms](#6-scoring-algorithms)
7. [Geometry Helpers](#7-geometry-helpers)
8. [Preview System: Anchors & Cursor](#8-preview-system-anchors--cursor)
9. [Parameters & Thresholds](#9-parameters--thresholds)
10. [Known Issues & Limitations](#10-known-issues--limitations)
11. [Data Flow Diagram](#11-data-flow-diagram)
12. [Shape Types Summary](#12-shape-types-summary)

---

## 1. System Overview

### High-Level Flow

```
User draws freehand stroke (pen/highlighter tool)
         ↓
HoldDetector monitors screen-space jitter (6px threshold)
         ↓
After 600ms dwell → onHoldFire() triggers
         ↓
recognizeOpenStroke() analyzes the stroke
         ↓
Returns RecognitionResult: 'line' | 'circle' | 'box' + score + anchors
         ↓
If score >= SHAPE_CONFIDENCE_MIN (0.58) and passes ambiguity checks:
   → DrawingTool sets `snap` state with frozen anchors
   → Preview switches from freehand to PerfectShapePreview
   → Cursor movement updates preview geometry live
         ↓
On pointer-up → commitPerfectShapeFromPreview()
   → Creates Y.Doc shape object with computed frame
```

### Key Files

| File | Responsibility |
|------|----------------|
| `client/src/lib/tools/DrawingTool.ts` | Main tool, HoldDetector integration, snap state |
| `client/src/lib/input/HoldDetector.ts` | 600ms dwell detection with 6px jitter threshold |
| `client/src/lib/geometry/recognize-open-stroke.ts` | Main recognition pipeline |
| `client/src/lib/geometry/fit-circle.ts` | Taubin circle fitting algorithm |
| `client/src/lib/geometry/fit-aabb.ts` | Axis-aligned bounding box fitting |
| `client/src/lib/geometry/score.ts` | Circle and rectangle scoring functions |
| `client/src/lib/geometry/geometry-helpers.ts` | PCA, corners, edges, coverage |
| `client/src/lib/geometry/shape-params.ts` | All tunable thresholds |
| `client/src/lib/tools/types.ts` | PreviewData types including PerfectShapePreview |
| `client/src/renderer/layers/perfect-shape-preview.ts` | Renders preview from anchors + cursor |
| `client/src/lib/tools/simplification.ts` | RDP simplification (used for preprocessing) |

### Recognized Shape Types (Hold-Detected)

| Kind | Description | Storage Type |
|------|-------------|--------------|
| `line` | **Currently NO-OP** - Returns but not committed | - |
| `circle` | Detected circular arc → ellipse | `'shape'` with `shapeType: 'ellipse'` |
| `box` | Detected AABB rectangle | `'shape'` with `shapeType: 'rect'` |

**Note:** These are distinct from the Shape Tool's forced snap kinds (`rect`, `ellipseRect`, `diamond`).

---

## 2. Trigger Mechanism: HoldDetector

**File:** `client/src/lib/input/HoldDetector.ts`

### Algorithm

```typescript
class HoldDetector {
  constructor(
    onFire: () => void,
    dwellMs = 600,    // Time before firing
    jitterPx = 6      // Screen-space threshold
  )
}
```

### Behavior

1. **Start:** On `pointerdown`, records screen position and starts 600ms timer
2. **Move:** On `pointermove`, calculates distance from last position
   - If distance > 6px → Reset timer and update position
   - If distance ≤ 6px → Timer continues unchanged (jitter allowed)
3. **Fire:** After 600ms of continuous dwell → calls `onHoldFire()`
4. **Cancel:** On `pointerup` or explicit cancel → clears timer

### Screen-Space Conversion

```typescript
// In DrawingTool.begin():
const [sx, sy] = worldToCanvas(worldX, worldY);
this.hold.start({ x: sx, y: sy });

// In DrawingTool.move():
if (!this.snap) {
  const [sx, sy] = worldToCanvas(worldX, worldY);
  this.hold.move({ x: sx, y: sy });
}
```

**Critical:** HoldDetector operates in SCREEN PIXELS, not world units. The 6px jitter threshold is fixed regardless of zoom level.

---

## 3. DrawingTool State Machine

**File:** `client/src/lib/tools/DrawingTool.ts`

### Snap State Types

```typescript
type ForcedSnapKind = 'line' | 'circle' | 'box' | 'rect' | 'ellipseRect' | 'diamond';

private snap:
  | null
  | { kind: 'line'; anchors: { A: [number, number] } }
  | { kind: 'circle'; anchors: { center: [number, number] } }
  | { kind: 'box'; anchors: { cx: number; cy: number; angle: number; hx0: number; hy0: number } }
  | { kind: 'rect'; anchors: { A: [number, number] } }
  | { kind: 'ellipseRect'; anchors: { A: [number, number] } }
  | { kind: 'diamond'; anchors: { A: [number, number] } }
  = null;
```

### State Transitions

```
[FREEHAND MODE]
   snap = null
   points accumulate in state.points
   HoldDetector active
        │
        ↓ onHoldFire()
   recognizeOpenStroke()
        │
        ├─ result.ambiguous = true → Stay in freehand (NO SNAP)
        │
        ├─ result.kind = 'line' → snap = { kind: 'line', anchors: { A } }
        │
        ├─ result.kind = 'circle' → snap = { kind: 'circle', anchors: { center } }
        │
        └─ result.kind = 'box' → snap = { kind: 'box', anchors: { cx, cy, angle, hx0, hy0 } }

[SNAP MODE]
   snap ≠ null
   liveCursorWU tracks current pointer
   HoldDetector cancelled
   Preview shows perfect shape
        │
        ↓ end()
   commitPerfectShapeFromPreview()
```

### Preview Generation

```typescript
getPreview(): PreviewData | null {
  if (this.snap && this.liveCursorWU) {
    return {
      kind: 'perfectShape',
      shape: this.snap.kind,
      color, size, opacity,
      fill: this.getFillEnabled(),  // Read LIVE from store
      anchors: { kind: this.snap.kind, ...this.snap.anchors },
      cursor: this.liveCursorWU,
      bbox: null,
    };
  }
  // Otherwise return freehand stroke preview
}
```

**Key Insight:** Perfect shape preview carries INPUT DATA (anchors + live cursor), NOT computed geometry. The renderer (`perfect-shape-preview.ts`) computes final geometry from these inputs.

---

## 4. Recognition Pipeline: recognizeOpenStroke

**File:** `client/src/lib/geometry/recognize-open-stroke.ts`

### Input

```typescript
function recognizeOpenStroke({
  pointsWU,      // number[] - Flat array [x0,y0,x1,y1,...] in WORLD units
  pointerNowWU   // [number, number] - Current pointer position
}): RecognitionResult
```

### Output

```typescript
interface RecognitionResult {
  kind: 'line' | 'circle' | 'box';
  score: number;            // Confidence [0, 1]
  ambiguous?: boolean;      // Near-miss flag - don't snap to anything
  line?: { A, B };          // Line parameters
  circle?: { cx, cy, r };   // Circle parameters
  box?: { cx, cy, angle, hx, hy };  // AABB parameters (angle always 0)
}
```

### Pipeline Steps

#### Step 1: Point Conversion

```typescript
// Convert flat array to Vec2[]
const points: Vec2[] = [];
for (let i = 0; i < pointsWU.length; i += 2) {
  points.push([pointsWU[i], pointsWU[i + 1]]);
}
```

#### Step 2: Circle Fitting & Scoring

```typescript
const circleFit = fitCircle(points);     // Taubin algebraic method
const circleScore = scoreCircle(points, circleFit);
```

#### Step 3: Rectangle Preprocessing (Two-Channel Approach)

**Track-A (rawPts):** Original points for AABB fitting and side proximity scoring
**Track-B (cleanPts):** Processed points for corner/edge detection

```typescript
// Track-B processing:
// 1. RDP simplification (removes jitter)
const rdp = simplifyStroke(flat, 'pen');

// 2. Distance decimation (minimum segment length)
const minSegWU = Math.max(10, Math.min(18, 0.06 * diag));
// Skip points closer than minSegWU to last kept point

// 3. Micro-closure (snap nearly-closed paths)
const closeEps = 0.06 * diag;  // 6% of diagonal
if (gap <= closeEps) {
  decimated.push(sx, sy);  // Close the loop
}
```

**Issue:** RDP tolerance is in WORLD UNITS, not screen pixels. While this doesn't significantly affect the recognizer, it means simplification aggressiveness varies with stroke size.

#### Step 4: Rectangle Fitting & Scoring

```typescript
const aabbFit = fitAABB(rawPts);  // Uses Track-A
const corners = detectCorners(cleanPts, minSegWU, 45, closed);  // Uses Track-B
const edges = reconstructRectangleEdges(cleanPts, corners, minSegWU);
const boxScore = scoreRectangleAABB(rawPts, aabbFit, edges, corners);
```

#### Step 5: Winner Selection with Complex Tie-Breaking

```typescript
// Count right-angle corners (within ±28°)
const rightAngleCorners = corners.filter(
  c => Math.abs(c.angle - 90) <= RECT_CORNER_TIE_TOLERANCE_DEG
);

// Case 1: Too many right angles (>4) → AMBIGUOUS
if (rightAngleCount > RECT_MAX_RIGHT_ANGLES) {
  return { kind: 'line', ambiguous: true, ... };
}

// Case 2: Both pass confidence + ≥2 right angles → Rectangle wins
if (circleScore >= 0.58 && boxScore >= 0.58 && rightAngleCount >= 2) {
  return { kind: 'box', ... };
}

// Case 3: Rectangle wins but <2 right angles → AMBIGUOUS
if (winner.kind === 'box' && winner.score >= 0.58 && rightAngleCount < 2) {
  return { kind: 'line', ambiguous: true, ... };
}

// Case 4: Circle wins but right angles detected → AMBIGUOUS
if (winner.kind === 'circle' && winner.score >= 0.58 && rightAngleCount >= 1) {
  return { kind: 'line', ambiguous: true, ... };
}

// Case 5: Winner passes confidence (and passed ambiguity checks)
if (winner.score >= SHAPE_CONFIDENCE_MIN) {
  return winner;
}

// Case 6: Near-miss (score within 0.10 of threshold)
if (maxScore >= SHAPE_CONFIDENCE_MIN - SHAPE_AMBIGUITY_DELTA) {
  return { kind: 'line', ambiguous: true, ... };
}

// Case 7: Self-intersection check
if (hasSelfIntersection(decimated, epsWU)) {
  return { kind: 'line', ambiguous: true, ... };
}

// Case 8: Near-closure check
if (closeGapWU <= closeGapThreshold) {
  return { kind: 'line', ambiguous: true, ... };
}

// Case 9: Near self-touch check
if (hasNearTouch(decimated, nearTouchEpsWU)) {
  return { kind: 'line', ambiguous: true, ... };
}

// Case 10: Clear failure → Line fallback
return { kind: 'line', score: 1 };
```

**Critical Observation:** The right-angle gating mechanism prevents ambiguity between circles and rectangles. If right angles are detected, circle cannot win. If not enough right angles, rectangle becomes ambiguous. This is the primary disambiguation technique.

---

## 5. Fitting Algorithms

### 5.1 Circle Fitting (Taubin Method)

**File:** `client/src/lib/geometry/fit-circle.ts`

#### Algorithm: Taubin's Algebraic Circle Fit

1. **Centroid Computation:**
   ```typescript
   const meanX = sumX / n;
   const meanY = sumY / n;
   ```

2. **Moment Calculation:**
   ```typescript
   // Shift points to centroid, compute moments
   for (const [x, y] of points) {
     const xi = x - meanX;
     const yi = y - meanY;
     const zi = xi * xi + yi * yi;

     Mxx += xi * xi;  Myy += yi * yi;  Mxy += xi * yi;
     Mxz += xi * zi;  Myz += yi * zi;  Mzz += zi * zi;
   }
   // Normalize by n
   ```

3. **Characteristic Polynomial:**
   ```typescript
   const Mz = Mxx + Myy;
   const Cov_xy = Mxx * Myy - Mxy * Mxy;
   const A3 = 4 * Mz;
   const A2 = -3 * Mz * Mz - Mzz;
   const A1 = Mzz * Mz + 4 * Cov_xy * Mz - Mxz * Mxz - Myz * Myz - Mz * Mz * Mz;
   const A0 = Mxz * Mxz * Myy + Myz * Myz * Mxx - Mzz * Cov_xy - 2 * Mxz * Myz * Mxy + Mz * Mz * Cov_xy;
   ```

4. **Newton's Method Root Finding:**
   ```typescript
   let x = 0;
   for (let iter = 0; iter < 20; iter++) {
     const y = A0 + x * (A1 + x * (A2 + x * A3));
     const dy = A1 + x * (2 * A2 + x * 3 * A3);
     const dx = y / dy;
     x -= dx;
     if (Math.abs(dx) < 1e-12) break;
   }
   ```

5. **Circle Parameters:**
   ```typescript
   const DET = x * x - x * Mz + Cov_xy;
   const cx = meanX + (Mxz * (Myy - x) - Myz * Mxy) / (2 * DET);
   const cy = meanY + (Myz * (Mxx - x) - Mxz * Mxy) / (2 * DET);
   const r = Math.sqrt((cx - meanX)² + (cy - meanY)² + (Mxx + Myy) - 2 * x);
   ```

6. **Residual RMS:**
   ```typescript
   for (const [px, py] of points) {
     const dist = Math.hypot(px - cx, py - cy);
     const residual = dist - r;
     sumSquaredResiduals += residual * residual;
   }
   const residualRMS = Math.sqrt(sumSquaredResiduals / n);
   ```

**Output:** `{ cx, cy, r, residualRMS }`

### 5.2 AABB Fitting (Robust Statistics)

**File:** `client/src/lib/geometry/fit-aabb.ts`

#### Algorithm

1. **Sort coordinates:**
   ```typescript
   const xs = points.map(p => p[0]).sort((a, b) => a - b);
   const ys = points.map(p => p[1]).sort((a, b) => a - b);
   ```

2. **Trimmed percentiles (outlier rejection):**
   ```typescript
   // For n >= 20, trim 5% from each end
   const trim = n < 20 ? 0 : Math.floor(n * 0.05);
   const minX = xs[trim];
   const maxX = xs[n - 1 - trim];
   const minY = ys[trim];
   const maxY = ys[n - 1 - trim];
   ```

3. **Center and half-extents:**
   ```typescript
   const cx = (minX + maxX) / 2;
   const cy = (minY + maxY) / 2;
   const hx = Math.max(1, (maxX - minX) / 2);
   const hy = Math.max(1, (maxY - minY) / 2);
   ```

**Output:** `{ cx, cy, hx, hy, angle: 0, minX, minY, maxX, maxY }`

**Note:** `angle` is always 0 - this is AABB only, no OBB support.

---

## 6. Scoring Algorithms

**File:** `client/src/lib/geometry/score.ts`

### 6.1 Circle Scoring

#### Hard Gates (Immediate Rejection → score = 0)

| Gate | Threshold | Description |
|------|-----------|-------------|
| PCA Axis Ratio | ≤ 1.70 | `sqrt(λ₁/λ₂)` - Roundness check |
| Angular Coverage | ≥ 0.667 | At least 240° of circle covered |
| Normalized RMS | ≤ 0.24 | `residualRMS / radius` - Fit quality |

#### Soft Scoring Components

| Component | Weight | Calculation |
|-----------|--------|-------------|
| Coverage | 50% | `(coverage - 0.667) / (1 - 0.667)` normalized |
| Fit Quality | 30% | `1 - (rmsNorm / 0.24)` |
| Roundness | 20% | `1 - ((axisRatio - 1) / 0.70)` |

```typescript
const S_circle = 0.50 * S_coverage + 0.30 * S_fit + 0.20 * S_round;
```

### 6.2 Rectangle AABB Scoring

**ALL SOFT - NO HARD GATES**

#### Scoring Components

| Component | Weight | Description |
|-----------|--------|-------------|
| Side Distance | 45% | Fraction of points within epsilon of AABB sides |
| Side Coverage | 20% | Coverage across 4 sides + distribution evenness |
| Corner Quality | 35% | Average of top-3 corner right-angle scores |
| Parallel Edges | 0% | Disabled (was 10%) |
| Orthogonal Edges | 0% | Disabled (was 10%) |

#### Side Distance Score

```typescript
const epsilon = Math.max(1.5, 0.04 * diag);

function aabbSideFitScore(points, aabb, epsilon) {
  let nearCount = 0;
  for (const [x, y] of points) {
    const dist = aabbSideDist(x, y, aabb.minX, aabb.minY, aabb.maxX, aabb.maxY);
    if (dist <= epsilon) nearCount++;
  }
  return nearCount / points.length;
}
```

#### Side Coverage with Evenness

```typescript
function aabbCoverageAcrossDistinctSides(points, aabb) {
  const tol = Math.max(1.5, 0.15 * Math.min(width, height));

  // Count points near each side
  for (const [x, y] of points) {
    if (Math.abs(y - aabb.minY) <= tol && ...) top++;
    if (Math.abs(y - aabb.maxY) <= tol && ...) bottom++;
    if (Math.abs(x - aabb.minX) <= tol && ...) left++;
    if (Math.abs(x - aabb.maxX) <= tol && ...) right++;
  }

  const sidesWithPoints = (top > 0 ? 1 : 0) + (bottom > 0 ? 1 : 0) + ...
  const coverage = sidesWithPoints / 4;

  // Evenness: penalize if points cluster on one side
  const distribution = [top, bottom, left, right].map(c => c / total);
  const maxDistribution = Math.max(...distribution);
  const evenness = 1 - (maxDistribution - 0.25) / 0.75;

  return coverage * 0.7 + evenness * 0.3;
}
```

#### Corner Quality Score

```typescript
// Peak-at-90° strength (triangle shape)
// Strength is 1.0 at 90°, falling linearly to 0 at 45° and 135°
const deviation = Math.abs(cornerAngleDeg - 90);
const strength = Math.max(0, 1 - (deviation / 45));

// Score = average of top 3 corner strengths
```

#### Right-Angle Penalties

```typescript
// After computing base score:
let finalScore = score;

// Severe penalty if no right angles
if (rightAngleCount < 1) {
  finalScore *= 0.5;  // RECT_NO_RIGHT_ANGLE_MULTIPLIER
}

// Penalty for exactly 2 right angles
if (rightAngleCount === 2) {
  finalScore -= 0.03;  // RECT_TWO_RIGHT_ANGLES_PENALTY
}
```

---

## 7. Geometry Helpers

**File:** `client/src/lib/geometry/geometry-helpers.ts`

### 7.1 PCA Axis Ratio

Measures shape elongation using Principal Component Analysis.

```typescript
function pcaAxisRatio(points: Vec2[]): number {
  // 1. Compute centroid
  // 2. Build 2x2 covariance matrix
  // 3. Compute eigenvalues λ₁ ≥ λ₂
  // 4. Return sqrt(λ₁ / λ₂)
}
```

**Interpretation:**
- ~1.0 = Round (circle-like)
- ~1.5 = Elliptical
- >2.0 = Very elongated (line-like)

### 7.2 Angular Coverage

Measures how much of a full circle is covered by stroke points.

```typescript
function angularCoverage(points: Vec2[], center: Vec2): number {
  // 1. Compute angle of each point relative to center
  // 2. Sort angles
  // 3. Find maximum gap between consecutive angles
  // 4. Coverage = (2π - maxGap) / 2π
}
```

**Threshold:** ≥ 0.667 (240° of 360°) required for circle.

### 7.3 Corner Detection

```typescript
function detectCorners(
  points: Vec2[],
  minSegmentLength: number = 10,
  minTurnAngleDeg: number = 45,
  closed: boolean = false
): Corner[]
```

#### Algorithm

1. **For each point i (with wrap-around if closed):**
   - Get vectors: `(i-1) → i` and `i → (i+1)`
   - Skip if either segment < minSegmentLength
   - Compute turn angle between vectors

2. **If turn angle > 45°:**
   - Record corner with:
     - `index`: Position in point array
     - `angle`: Turn angle in degrees
     - `strength`: Peak-at-90° metric

```typescript
// Strength calculation: 1.0 at 90°, 0 at 45° and 135°
const deviation = Math.abs(cornerAngleDeg - 90);
const strength = Math.max(0, 1 - (deviation / 45));
```

### 7.4 Edge Reconstruction

```typescript
function reconstructRectangleEdges(
  points: Vec2[],
  corners: Corner[],
  minEdgeLengthWU: number = 8
): Edge[]
```

#### Algorithm

1. Select top 4 corners by strength
2. Sort by index (position along stroke)
3. Build edges between consecutive corners + closing edge
4. Filter by minimum world-unit length
5. Compute edge angles using **PCA over all segment points** (not just endpoints)

### 7.5 Self-Intersection Detection

```typescript
function hasSelfIntersection(pointsFlat: number[], epsWU: number): boolean
```

Checks if non-adjacent segments cross each other (used to prevent line snap for complex strokes).

### 7.6 Near-Touch Detection

```typescript
function hasNearTouch(pointsFlat: number[], epsWU: number): boolean
```

Checks if non-adjacent segments come within epsilon of each other without crossing.

---

## 8. Preview System: Anchors & Cursor

### 8.1 PerfectShapePreview Type

**File:** `client/src/lib/tools/types.ts`

```typescript
interface PerfectShapePreview {
  kind: 'perfectShape';
  shape: 'line' | 'circle' | 'box' | 'rect' | 'ellipseRect' | 'diamond';
  fill?: boolean;
  color: string;
  size: number;
  opacity: number;

  // INPUTS in WORLD space:
  anchors: PerfectShapeAnchors;  // Frozen at snap time
  cursor: [number, number];      // Live pointer position

  bbox: null;  // Overlay previews never carry bbox
}

type PerfectShapeAnchors =
  | { kind: 'line'; A: [number, number] }
  | { kind: 'circle'; center: [number, number] }
  | { kind: 'box'; cx: number; cy: number; angle: number; hx0: number; hy0: number }
  | { kind: 'rect'; A: [number, number] }
  | { kind: 'ellipseRect'; A: [number, number] }
  | { kind: 'diamond'; A: [number, number] };
```

**Key Design:** Preview carries INPUTS (anchors + cursor), not computed geometry. Renderer computes final geometry each frame.

### 8.2 Anchor Meanings by Shape

| Shape | Anchor Data | Geometry Computation |
|-------|-------------|---------------------|
| `line` | `A: [x, y]` | Draw from A to cursor |
| `circle` | `center: [cx, cy]` | Radius = distance(center, cursor) |
| `box` | `cx, cy, angle, hx0, hy0` | Scale hx0/hy0 by cursor distance from center |
| `rect` | `A: [x, y]` | AABB from A to cursor (rounded corners) |
| `ellipseRect` | `A: [x, y]` | Ellipse inscribed in AABB from A to cursor |
| `diamond` | `A: [x, y]` | Diamond inscribed in AABB from A to cursor |

### 8.3 Geometry Computation in Renderer

**File:** `client/src/renderer/layers/perfect-shape-preview.ts`

```typescript
// Circle: radius from center to cursor
if (anchors.kind === 'circle') {
  const r = Math.hypot(cursor[0] - center[0], cursor[1] - center[1]);
  ctx.arc(center[0], center[1], r, 0, Math.PI * 2);
}

// Box: scale half-extents by cursor projection
if (anchors.kind === 'box') {
  const dx = cursor[0] - cx, dy = cursor[1] - cy;
  const cos = Math.cos(angle), sin = Math.sin(angle);
  const localX = dx * cos + dy * sin;
  const localY = -dx * sin + dy * cos;
  const sx = Math.abs(localX) / Math.max(1e-6, hx0);
  const sy = Math.abs(localY) / Math.max(1e-6, hy0);
  const hx = hx0 * sx, hy = hy0 * sy;
  // Draw rectangle at (cx, cy) with half-extents (hx, hy) and rotation angle
}
// SHAPE TOOLBAR SPECIFIC ONLY(NOT PERFECT SHAPE DETECTION FROM PEN TOOL)
// Rect/Ellipse/Diamond: corner-anchored AABB
if (anchors.kind === 'rect') {
  const minX = Math.min(A[0], cursor[0]);
  const minY = Math.min(A[1], cursor[1]);
  const width = Math.abs(cursor[0] - A[0]);
  const height = Math.abs(cursor[1] - A[1]);
  // Draw rounded rectangle
}
if (anchors.kind === 'diamond') {
    const { A } = anchors;
    const C = cursor;
    const minX = Math.min(A[0], C[0]);
    const maxX = Math.max(A[0], C[0]);
    const minY = Math.min(A[1], C[1]);
    const maxY = Math.max(A[1], C[1]);
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const width = maxX - minX;
    const height = maxY - minY;
        // Calculate corner radius
    const radius = Math.min(20, Math.min(width, height) * 0.1);
    ctx.beginPath();
    ctx.moveTo(cx + width / 4, minY + height / 4);
    ctx.arcTo(maxX, cy, cx, maxY, radius);
    ctx.arcTo(cx, maxY, minX, cy, radius);
    ctx.arcTo(minX, cy, cx, minY, radius);
    ctx.arcTo(cx, minY, maxX, cy, radius);
}
```

### 8.4 Commit: Preview → Shape Object

**File:** `client/src/lib/tools/DrawingTool.ts`

```typescript
private commitPerfectShapeFromPreview(): void {
  const finalCursor = this.liveCursorWU!;
  let frame: [x, y, width, height];
  const shapeType = getShapeTypeFromSnapKind(this.snap.kind);

  if (this.snap.kind === 'circle') {
    const r = Math.hypot(finalCursor[0] - center[0], finalCursor[1] - center[1]);
    frame = [center[0] - r, center[1] - r, r * 2, r * 2];
  } else if (this.snap.kind === 'box') {
    // Compute scale from cursor, get final half-extents
    frame = [cx - hx, cy - hy, hx * 2, hy * 2];
  } else if (this.snap.kind === 'rect' | 'ellipseRect' | 'diamond') {
    // Simple AABB from A to cursor
    frame = [minX, minY, maxX - minX, maxY - minY];
  }

  // Commit as Y.Doc shape object
  roomDoc.mutate((ydoc) => {
    const shapeMap = new Y.Map();
    shapeMap.set('kind', 'shape');
    shapeMap.set('shapeType', shapeType);  // 'rect' | 'ellipse' | 'diamond' | 'roundedRect'
    shapeMap.set('frame', frame);
    // ...
  });
}
```

---

## 9. Parameters & Thresholds

**File:** `client/src/lib/geometry/shape-params.ts`

### Global

| Parameter | Value | Description |
|-----------|-------|-------------|
| `SHAPE_CONFIDENCE_MIN` | 0.58 | Minimum score to accept a shape |
| `SHAPE_AMBIGUITY_DELTA` | 0.10 | Near-miss detection range |

### Circle Recognition

| Parameter | Value | Description |
|-----------|-------|-------------|
| `CIRCLE_MIN_COVERAGE` | 0.667 | Minimum angular coverage (240°) |
| `CIRCLE_MAX_AXIS_RATIO` | 1.70 | Maximum PCA axis ratio |
| `CIRCLE_MAX_RMS_RATIO` | 0.24 | Maximum normalized RMS |
| `CIRCLE_WEIGHT_COVERAGE` | 0.50 | Coverage weight in scoring |
| `CIRCLE_WEIGHT_FIT` | 0.30 | Fit quality weight |
| `CIRCLE_WEIGHT_ROUND` | 0.20 | Roundness weight |

### Rectangle AABB Recognition

| Parameter | Value | Description |
|-----------|-------|-------------|
| `RECT_SIDE_EPSILON_FACTOR` | 0.04 | 4% of diagonal for side distance |
| `RECT_MIN_SIDE_EPSILON` | 1.5 | Minimum tolerance in WU |
| `RECT_CORNER_TIE_TOLERANCE_DEG` | 28 | Right-angle tolerance for tie-breaker |
| `RECT_MIN_RIGHT_ANGLES_FOR_VALIDITY` | 1 | Minimum right angles needed |
| `RECT_NO_RIGHT_ANGLE_MULTIPLIER` | 0.5 | Penalty if no right angles |
| `RECT_MIN_RIGHT_ANGLES_FOR_CONFIDENCE` | 2 | Minimum to avoid ambiguity |
| `RECT_MAX_RIGHT_ANGLES` | 4 | More than this = ambiguous |
| `RECT_WEIGHT_SIDEDIST` | 0.45 | Side distance weight |
| `RECT_WEIGHT_SIDECOV` | 0.20 | Side coverage weight |
| `RECT_WEIGHT_CORNERS` | 0.35 | Corner quality weight |
| `RECT_WEIGHT_PARALLEL` | 0.00 | Disabled |
| `RECT_WEIGHT_ORTHOGONAL` | 0.00 | Disabled |

### Line Fallback Ambiguity

| Parameter | Value | Description |
|-----------|-------|-------------|
| `LINE_SELF_INTERSECT_AMBIGUOUS` | true | Detect self-intersections |
| `LINE_SELF_INTERSECT_EPSILON_FACTOR` | 0.02 | 2% of diagonal |
| `LINE_NEAR_CLOSURE_AMBIGUOUS` | true | Detect nearly-closed loops |
| `LINE_CLOSE_GAP_RATIO` | 0.06 | 6% of diagonal for closure |
| `LINE_NEAR_TOUCH_AMBIGUOUS` | true | Detect near self-touches |
| `LINE_NEAR_TOUCH_EPSILON_FACTOR` | 0.015 | 1.5% of diagonal |

### HoldDetector

| Parameter | Value | Location |
|-----------|-------|----------|
| Dwell time | 600ms | `HoldDetector.ts` constructor |
| Jitter threshold | 6px | `HoldDetector.ts` constructor (SCREEN PIXELS) |

---

## 10. Known Issues & Limitations

### 10.1 Line Recognition Disabled

- Line is returned as fallback but **not committed** as a shape object
- Code exists but `commitPerfectShapeFromPreview()` logs "Line shapes not yet supported" and cancels

### 10.2 Staircase → Box Problem

User described: "Drawing a staircase and holding will make the box recognized if 4 lines for the staircase."

**Root Cause:** The rectangle recognizer is aggressive about accepting strokes with ≥2 right-angle corners. A staircase pattern with 3-4 right angles easily passes the corner quality threshold.

**Why it happens:**
1. RDP simplification cleans up the staircase into ~4-5 segments
2. Corner detection finds 3-4 ~90° corners
3. AABB fit encloses all points (staircases often have good side proximity on 2-3 sides)
4. Score exceeds 0.58 threshold

### 10.3 Circle Detection Relies on Right-Angle Gate

Circle works well because of the right-angle gate:
- If ANY right angles detected (≥1), circle becomes ambiguous
- This prevents circle/rectangle confusion

**Side effect:** Drawing a nearly-circular shape with a corner anywhere makes it ambiguous.

### 10.4 No Diamond Detection

Diamond shapes are not recognized during hold-detect. They only work via the Shape Tool forced snap mode.

### 10.5 No OBB (Oriented Bounding Box)

Legacy code mentions OBB, but current implementation is **AABB only** (angle always 0). Rotated rectangles are not recognized.

### 10.6 Edge Reconstruction Issues

User mentioned "my edge reconstruction is way off." Specific issues:
- Edge angles computed via PCA over segment points, but segment selection depends on corner detection quality
- Short edges (< 8 WU) are filtered out, potentially losing important data
- Parallel/orthogonal scoring weights are set to 0% (disabled)

### 10.7 RDP Simplification Uses World Space

RDP tolerance comes from `STROKE_CONFIG` which may be in world units. This means simplification aggressiveness changes with zoom level during drawing.

### 10.8 Condition Normalization Issues

User mentioned "we also don't normalize conditions well." The current approach:
- No scale normalization (stroke bounding box varies)
- No rotation normalization (AABB only)
- No resampling to fixed point count
- Coordinates are raw world units

This contrasts with $P/$Q algorithms which normalize to fixed scale, center, and point count.

### 10.9 Aggressive Box Recognition

The 0.58 threshold combined with 0.45 side-distance weight means:
- If ~60% of points are near AABB sides, that alone contributes 0.27 to score
- Add any corner quality and it easily reaches 0.58

### 10.10 Click-to-Place Side Effect

Click detection in shape tool uses 200ms + 5 world-unit thresholds. This is separate from hold-detect and may cause unexpected behavior at boundaries.

---

## 11. Data Flow Diagram

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              DRAWING TOOL GESTURE                               │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                 │
│  pointerdown                                                                    │
│      │                                                                          │
│      ├──► HoldDetector.start(screenPos)                                        │
│      │         │                                                                │
│      │         │  600ms timer started                                           │
│      │         ▼                                                                │
│      └──► state.points = [[worldX, worldY]]                                     │
│                                                                                 │
│  pointermove (while snap = null)                                               │
│      │                                                                          │
│      ├──► HoldDetector.move(screenPos)                                         │
│      │         │                                                                │
│      │         ├── dist > 6px → Reset timer                                     │
│      │         └── dist ≤ 6px → Timer continues                                │
│      │                                                                          │
│      └──► state.points.push([worldX, worldY])                                  │
│                                                                                 │
│  600ms dwell → onHoldFire()                                                    │
│      │                                                                          │
│      ├──► tupleArrayToFlat(state.points)  → pointsWU                           │
│      │                                                                          │
│      └──► recognizeOpenStroke({ pointsWU, pointerNowWU })                      │
│                │                                                                │
│                ▼                                                                │
│  ┌─────────────────────────────────────────────────────────────────────────┐   │
│  │                    RECOGNITION PIPELINE                                  │   │
│  ├─────────────────────────────────────────────────────────────────────────┤   │
│  │                                                                          │   │
│  │  1. Convert flat → Vec2[]                                               │   │
│  │                                                                          │   │
│  │  2. CIRCLE PATH:                                                         │   │
│  │     fitCircle(points) → { cx, cy, r, residualRMS }                       │   │
│  │     scoreCircle(points, fit) → [0, 1] or 0 if hard gates fail            │   │
│  │        Hard Gates:                                                       │   │
│  │        - PCA axis ratio ≤ 1.70                                           │   │
│  │        - Angular coverage ≥ 0.667 (240°)                                 │   │
│  │        - Normalized RMS ≤ 0.24                                           │   │
│  │        Soft Scoring:                                                     │   │
│  │        - 50% coverage + 30% fit + 20% roundness                          │   │
│  │                                                                          │   │
│  │  3. RECTANGLE PATH:                                                      │   │
│  │     Track-A: rawPts (original)                                           │   │
│  │     Track-B: cleanPts (RDP + decimation + micro-closure)                 │   │
│  │                                                                          │   │
│  │     fitAABB(rawPts) → { cx, cy, hx, hy, minX, minY, maxX, maxY }         │   │
│  │     detectCorners(cleanPts) → Corner[]                                   │   │
│  │     reconstructRectangleEdges(cleanPts, corners) → Edge[]                │   │
│  │     scoreRectangleAABB(rawPts, aabb, edges, corners) → [0, 1]            │   │
│  │        All Soft:                                                         │   │
│  │        - 45% side dist + 20% side cov + 35% corners                      │   │
│  │        Right-angle penalties applied                                     │   │
│  │                                                                          │   │
│  │  4. WINNER SELECTION:                                                    │   │
│  │     Count right-angle corners                                            │   │
│  │     Apply tie-breaker rules                                              │   │
│  │     Check ambiguity conditions                                           │   │
│  │                                                                          │   │
│  │  5. RESULT:                                                              │   │
│  │     { kind, score, ambiguous?, line/circle/box params }                  │   │
│  │                                                                          │   │
│  └─────────────────────────────────────────────────────────────────────────┘   │
│                │                                                                │
│                ▼                                                                │
│  if (result.ambiguous) → Continue freehand, no snap                            │
│  if (result.kind === 'line') → snap = { kind: 'line', anchors }                │
│  if (result.kind === 'circle') → snap = { kind: 'circle', anchors }            │
│  if (result.kind === 'box') → snap = { kind: 'box', anchors }                  │
│                                                                                 │
│  pointermove (while snap ≠ null)                                               │
│      │                                                                          │
│      └──► liveCursorWU = [worldX, worldY]                                      │
│           invalidateOverlay()                                                   │
│                │                                                                │
│                ▼                                                                │
│           getPreview() returns PerfectShapePreview                              │
│                │                                                                │
│                ▼                                                                │
│           OverlayRenderLoop draws preview                                       │
│           (geometry computed from anchors + cursor)                             │
│                                                                                 │
│  pointerup                                                                     │
│      │                                                                          │
│      └──► commitPerfectShapeFromPreview()                                      │
│                │                                                                │
│                ├── Compute final frame from anchors + final cursor             │
│                │                                                                │
│                └── Create Y.Doc shape object                                   │
│                       kind: 'shape'                                             │
│                       shapeType: 'rect' | 'ellipse'                            │
│                       frame: [x, y, w, h]                                       │
│                                                                                 │
└─────────────────────────────────────────────────────────────────────────────────┘
```

---

## 12. Shape Types Summary

### Hold-Detected Shapes (from recognizeOpenStroke)

| Recognition Kind | Storage shapeType | Anchor Type | Notes |
|-----------------|-------------------|-------------|-------|
| `'line'` | N/A | `{ A }` | NOT committed (no-op) |
| `'circle'` | `'ellipse'` | `{ center }` | Radius from cursor distance |
| `'box'` | `'rect'` | `{ cx, cy, angle, hx0, hy0 }` | AABB, angle always 0 |

### Forced Snap Shapes (from Shape Tool)

| Snap Kind | Storage shapeType | Anchor Type | Notes |
|-----------|-------------------|-------------|-------|
| `'rect'` | `'roundedRect'` | `{ A }` | Corner-anchored AABB |
| `'ellipseRect'` | `'ellipse'` | `{ A }` | Corner-anchored |
| `'diamond'` | `'diamond'` | `{ A }` | Corner-anchored |

