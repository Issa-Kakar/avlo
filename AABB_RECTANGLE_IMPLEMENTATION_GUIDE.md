# AABB Rectangle Implementation Guide - Perfect Shapes Feature Overhaul

## Executive Summary

This guide details the complete replacement of the fragile OBB (Oriented Bounding Box) rectangle detection with a robust AABB (Axis-Aligned Bounding Box) approach. The goal is to make rectangle detection as forgiving and intuitive as circle detection, removing the current "all-or-nothing" behavior caused by hard gates and strict corner requirements.

### Current Perfect Shapes Implementation Overview

The Perfect Shapes feature allows users to draw freehand strokes that automatically snap to geometric shapes after a 600ms dwell. The system currently recognizes:
- **Circles**: Robust detection using Taubin fitting with coverage/roundness checks
- **Rectangles**: Fragile OBB-based detection with strict corner requirements
- **Lines**: Strict fallback when no shape meets confidence threshold

**Core Flow:**
1. User draws stroke → holds still for 600ms → HoldDetector fires
2. Shape recognition runs (circle vs rectangle competition)
3. Winner with score ≥ 0.58 triggers snap
4. After snap: pointer movements refine geometry (radius/size)
5. Pointer-up commits the perfect shape as a regular stroke

### What We're Changing

**From OBB to AABB:**
- **Current**: Rectangles detected as rotated boxes with PCA-determined angle
- **New**: Rectangles are always axis-aligned (angle = 0)
- **Why**: Eliminates rotation complexity, makes detection stable

**From Hard Gates to Soft Scoring:**
- **Current**: Rectangle fails immediately if <2 right-angle corners found
- **New**: All metrics are soft contributors, no hard failures
- **Why**: Allows imperfect rectangles to still be recognized

**From Strict Fallback to Near-Miss Detection:**
- **Current**: Always snaps to line when no shape meets threshold
- **New**: If any shape score is within 0.10 of threshold, no snap (continue freehand)
- **Why**: Prevents annoying line snaps when user clearly intended a shape but didn't quite make it
- **Also**: Rectangle wins tie-breaks when both pass confidence + ≥2 right angles

---

## 1. Investigation Results & Architecture Analysis

### Current Pain Points

1. **Rectangle Hard Gate (score.ts:77-88)**
   - Requires ≥2 corners within ±25° of 90°
   - Returns score = 0 if gate fails
   - Makes imperfect rectangles impossible to recognize

2. **OBB Complexity (fit-obb.ts)**
   - Uses PCA eigendecomposition for angle
   - Sensitive to point distribution
   - Adds unnecessary rotation handling

3. **Edge Reconstruction Fragility (geometry-helpers.ts)**
   - Reconstructs edges from detected corners
   - Computes parallel/orthogonal errors
   - Fails when corners aren't detected perfectly

4. **Always Line Fallback (recognize-open-stroke.ts:266-280)**
   - No ambiguity handling
   - Forces line snap even for "almost shapes"

### Architecture That Stays The Same

- **HoldDetector**: 600ms dwell trigger mechanism
- **DrawingTool**: Snap state management and preview generation
- **OverlayRenderLoop**: Preview rendering pipeline
- **Canvas.tsx**: Event handling and tool integration
- **Commit Flow**: Perfect shapes convert to polylines at pointer-up
- **Circle Detection**: Entire circle pipeline remains unchanged

---

## 2. Detailed Implementation Plan

### File Change Summary

**NEW FILES to create:**
- `/client/src/lib/geometry/fit-aabb.ts` - AABB fitting function

**EXISTING FILES to modify:**
- `/client/src/lib/geometry/geometry-helpers.ts` - Add AABB helper functions
- `/client/src/lib/geometry/shape-params.ts` - Update rectangle parameters
- `/client/src/lib/geometry/score.ts` - Add scoreRectangleAABB function
- `/client/src/lib/geometry/recognize-open-stroke.ts` - Use AABB instead of OBB
- `/client/src/lib/tools/DrawingTool.ts` - Handle ambiguous flag

**NO CHANGES NEEDED:**
- `/client/src/lib/geometry/fit-circle.ts` - Keep unchanged
- `/client/src/renderer/layers/perfect-shape-preview.ts` - Works with angle=0

### 2.1 New AABB Fitting Function

**File: `/client/src/lib/geometry/fit-aabb.ts`** (NEW)

```typescript
import type { Vec2 } from './types';

/**
 * Fit an Axis-Aligned Bounding Box to points using robust statistics.
 * Uses trimmed extents to ignore outliers and tails.
 */
export function fitAABB(points: Vec2[]): {
  cx: number;
  cy: number;
  hx: number;
  hy: number;
  angle: number; // Always 0 for AABB
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
} {
  const n = points.length;
  if (n < 2) {
    return { cx: 0, cy: 0, hx: 10, hy: 10, angle: 0, minX: -10, minY: -10, maxX: 10, maxY: 10 };
  }

  // Collect all x and y coordinates
  const xs = points.map(p => p[0]).sort((a, b) => a - b);
  const ys = points.map(p => p[1]).sort((a, b) => a - b);

  // Robust extent calculation: use 5th and 95th percentiles
  // This ignores outliers and tails
  // For small strokes (n < 20), use full extent
  const trim = n < 20 ? 0 : Math.floor(n * 0.05);
  const minX = xs[trim];
  const maxX = xs[n - 1 - trim];
  const minY = ys[trim];
  const maxY = ys[n - 1 - trim];

  // Compute center and half-extents
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const hx = Math.max(1, (maxX - minX) / 2);
  const hy = Math.max(1, (maxY - minY) / 2);

  return {
    cx, cy, hx, hy,
    angle: 0, // AABB is always axis-aligned
    minX, minY, maxX, maxY
  };
}
```

### 2.2 AABB Scoring Helpers

**File: `/client/src/lib/geometry/geometry-helpers.ts`** (ADD to existing)

```typescript
/**
 * Distance from a point to the nearest AABB edge.
 * Used for scoring how well points follow rectangle sides.
 */
export function aabbSideDist(
  x: number,
  y: number,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number
): number {
  // Distance to each side
  const dx = Math.min(Math.abs(x - minX), Math.abs(x - maxX));
  const dy = Math.min(Math.abs(y - minY), Math.abs(y - maxY));

  // Check if point is inside bbox
  const insideX = x >= minX && x <= maxX;
  const insideY = y >= minY && y <= maxY;

  if (insideX && insideY) {
    return Math.min(dx, dy); // Distance to nearest side
  }

  if (!insideX && insideY) {
    return Math.abs(x < minX ? minX - x : x - maxX);
  }

  if (insideX && !insideY) {
    return Math.abs(y < minY ? minY - y : y - maxY);
  }

  // Outside corner - distance to nearest corner
  const cx = x < minX ? minX : maxX;
  const cy = y < minY ? minY : maxY;
  return Math.hypot(x - cx, y - cy);
}

/**
 * Score how well points follow the AABB sides.
 * Returns fraction of points within epsilon of any side.
 */
export function aabbSideFitScore(
  points: Vec2[],
  aabb: { minX: number; minY: number; maxX: number; maxY: number },
  epsilonWU: number
): number {
  let nearCount = 0;
  for (const [x, y] of points) {
    const dist = aabbSideDist(x, y, aabb.minX, aabb.minY, aabb.maxX, aabb.maxY);
    if (dist <= epsilonWU) {
      nearCount++;
    }
  }
  return nearCount / Math.max(1, points.length);
}

/**
 * Calculate how many distinct sides of AABB are visited.
 * Returns 0-1 score (0.25 per side visited).
 */
export function aabbSideCoverage(
  points: Vec2[],
  aabb: { minX: number; minY: number; maxX: number; maxY: number },
  epsilonWU: number
): number {
  const sides = { left: false, right: false, top: false, bottom: false };

  for (const [x, y] of points) {
    if (Math.abs(x - aabb.minX) <= epsilonWU) sides.left = true;
    if (Math.abs(x - aabb.maxX) <= epsilonWU) sides.right = true;
    if (Math.abs(y - aabb.minY) <= epsilonWU) sides.top = true;
    if (Math.abs(y - aabb.maxY) <= epsilonWU) sides.bottom = true;
  }

  const count = (sides.left ? 1 : 0) + (sides.right ? 1 : 0) +
                (sides.top ? 1 : 0) + (sides.bottom ? 1 : 0);
  return count / 4;
}
```

### 2.3 Updated Shape Parameters

**File: `/client/src/lib/geometry/shape-params.ts`** (MODIFY)

```typescript
// Global confidence threshold
export const SHAPE_CONFIDENCE_MIN = 0.58;

// NEW: Near-miss detection - prevents snap when shape was "close but not quite"
export const SHAPE_AMBIGUITY_DELTA = 0.10; // No snap if any shape score is within 0.10 of confidence threshold

// Circle parameters (UNCHANGED)
export const CIRCLE_MIN_COVERAGE = 0.667;
export const CIRCLE_MAX_AXIS_RATIO = 1.70;
export const CIRCLE_MAX_RMS_RATIO = 0.24;
export const CIRCLE_WEIGHT_COVERAGE = 0.50;
export const CIRCLE_WEIGHT_FIT = 0.30;
export const CIRCLE_WEIGHT_ROUND = 0.20;

// Rectangle AABB parameters (ALL SOFT - NO HARD GATES)
export const RECT_SIDE_EPSILON_FACTOR = 0.04;  // Tolerance = 4% of diagonal
export const RECT_MIN_SIDE_EPSILON = 1.5;      // Minimum tolerance in world units

// Soft thresholds for gentle corner/edge scoring
export const RECT_CORNER_SOFT_TOLERANCE_DEG = 25;    // Wider tolerance for soft scoring
export const RECT_PARALLEL_SOFT_TOLERANCE_DEG = 25;  // Soft parallel check
export const RECT_ORTHOGONAL_SOFT_TOLERANCE_DEG = 25; // Soft orthogonal check

// Rectangle AABB Scoring Weights (MUST sum to 1.0)
export const RECT_WEIGHT_SIDEDIST = 0.40;    // Primary: proximity to sides (40%)
export const RECT_WEIGHT_SIDECOV = 0.25;     // Secondary: side coverage (25%)
export const RECT_WEIGHT_CORNERS = 0.15;     // Tertiary: corner quality - soft (15%)
export const RECT_WEIGHT_PARALLEL = 0.10;    // Gentle parallel hint (10%)
export const RECT_WEIGHT_ORTHOGONAL = 0.10;  // Gentle orthogonal hint (10%)
// Total: 0.40 + 0.25 + 0.15 + 0.10 + 0.10 = 1.00 ✓

// Debug - set to false in production
export const SHAPE_DEBUG_SCORES = true;  // Show detailed score breakdown in console
```

### 2.4 New Rectangle Scoring Function

**File: `/client/src/lib/geometry/score.ts`** (ADD new function, keep old for reference)

```typescript
// Add these imports at the top of the file
import {
  aabbSideFitScore,
  aabbSideCoverage
} from './geometry-helpers';
import {
  SHAPE_DEBUG_SCORES
} from './shape-params';

/**
 * Scores how well a stroke matches an axis-aligned rectangle.
 * ALL SOFT SCORING - NO HARD GATES
 *
 * @param points - The stroke points
 * @param aabb - The fitted axis-aligned bounding box
 * @param edges - Detected edges (optional, for soft scoring)
 * @param corners - Detected corners (optional, for soft scoring)
 * @returns Score in [0, 1], never hard-fails to 0
 */
export function scoreRectangleAABB(
  points: Vec2[],
  aabb: { cx: number; cy: number; hx: number; hy: number; minX: number; minY: number; maxX: number; maxY: number },
  edges: Edge[] = [],
  corners: Corner[] = []
): number {
  console.group('🟦 AABB Rectangle Scoring (Soft)');

  const diag = Math.hypot(aabb.maxX - aabb.minX, aabb.maxY - aabb.minY) || 1;
  const epsilon = Math.max(RECT_MIN_SIDE_EPSILON, RECT_SIDE_EPSILON_FACTOR * diag);

  console.log('AABB parameters:', {
    center: [aabb.cx.toFixed(1), aabb.cy.toFixed(1)],
    size: [(aabb.maxX - aabb.minX).toFixed(1), (aabb.maxY - aabb.minY).toFixed(1)],
    epsilon: epsilon.toFixed(1)
  });

  // =========================================================================
  // Component 1: Side Distance Score (40% weight) - PRIMARY SIGNAL
  // =========================================================================
  const S_sideDist = aabbSideFitScore(points, aabb, epsilon);
  console.log(`1. Side Proximity (${RECT_WEIGHT_SIDEDIST * 100}%): ${S_sideDist.toFixed(3)}`);
  console.log(`   Points within ${epsilon.toFixed(1)} of sides: ${(S_sideDist * 100).toFixed(1)}%`);

  // =========================================================================
  // Component 2: Side Coverage (25% weight) - ENCOURAGES COMPLETE RECTANGLES
  // =========================================================================
  const S_sideCov = aabbSideCoverage(points, aabb, epsilon);
  const sidesVisited = Math.round(S_sideCov * 4);
  console.log(`2. Side Coverage (${RECT_WEIGHT_SIDECOV * 100}%): ${S_sideCov.toFixed(3)}`);
  console.log(`   Distinct sides visited: ${sidesVisited}/4`);

  // =========================================================================
  // Component 3: Corner Quality (15% weight) - SOFT CONTRIBUTION ONLY
  // =========================================================================
  let S_corners = 0;
  if (corners.length > 0) {
    const rightAngleScores = corners.map(c => {
      const deviation = Math.abs(c.angle - 90);
      return Math.max(0, 1 - deviation / RECT_CORNER_SOFT_TOLERANCE_DEG);
    });

    // Take average of top 3 corners (or all if fewer)
    const topN = Math.min(3, rightAngleScores.length);
    rightAngleScores.sort((a, b) => b - a);
    S_corners = rightAngleScores.slice(0, topN).reduce((a, b) => a + b, 0) / topN;

    console.log(`3. Corner Quality (${RECT_WEIGHT_CORNERS * 100}%): ${S_corners.toFixed(3)}`);
    console.log(`   Found ${corners.length} corners, top-${topN} average quality`);
  } else {
    console.log(`3. Corner Quality (${RECT_WEIGHT_CORNERS * 100}%): 0.000 (no corners detected)`);
  }

  // =========================================================================
  // Component 4 & 5: Parallel/Orthogonal (20% combined) - SOFT HINTS
  // =========================================================================
  let S_parallel = 0.5; // Default neutral if no edges
  let S_orthogonal = 0.5;

  if (edges.length >= 2) {
    const parallelError = avgParallelError(edges);
    const orthogonalError = avgOrthogonalError(edges);

    S_parallel = Math.max(0, 1 - parallelError / RECT_PARALLEL_SOFT_TOLERANCE_DEG);
    S_orthogonal = Math.max(0, 1 - orthogonalError / RECT_ORTHOGONAL_SOFT_TOLERANCE_DEG);

    console.log(`4. Parallel Edges (${RECT_WEIGHT_PARALLEL * 100}%): ${S_parallel.toFixed(3)}`);
    console.log(`5. Orthogonal Edges (${RECT_WEIGHT_ORTHOGONAL * 100}%): ${S_orthogonal.toFixed(3)}`);
  } else {
    console.log(`4-5. Edge metrics: neutral (insufficient edges)`);
  }

  // =========================================================================
  // Final Weighted Score - NO HARD GATES, ALL SOFT
  // =========================================================================
  const score =
    RECT_WEIGHT_SIDEDIST * S_sideDist +
    RECT_WEIGHT_SIDECOV * S_sideCov +
    RECT_WEIGHT_CORNERS * S_corners +
    RECT_WEIGHT_PARALLEL * S_parallel +
    RECT_WEIGHT_ORTHOGONAL * S_orthogonal;

  console.log(`🎯 Final AABB Score: ${score.toFixed(3)}`);
  console.log(`Confidence threshold: ${SHAPE_CONFIDENCE_MIN}`);

  if (score >= SHAPE_CONFIDENCE_MIN) {
    console.log(`✅ Above threshold - competitive rectangle`);
  } else {
    console.log(`⚠️ Below threshold - may not win or trigger ambiguity`);
  }

  console.groupEnd();

  return Math.max(0, Math.min(1, score)); // Clamp to [0,1]
}
```

### 2.5 Updated Recognition Pipeline (IMPLEMENTED with Two-Channel Approach)

**File: `/client/src/lib/geometry/recognize-open-stroke.ts`** (MODIFIED)

This implementation uses a critical **two-channel approach** to ensure noise-free corner detection while maintaining robust AABB fitting:

**Track-A (rawPts):** Original points used for:
- AABB fitting (robust to outliers via trimmed percentiles)
- Side proximity scoring (primary AABB signal)
- Side coverage scoring (secondary signal)

**Track-B (cleanPts):** RDP + decimation + micro-closure used for:
- Corner detection (jitter-free for stable right-angle detection)
- Edge reconstruction (for soft parallel/orthogonal hints)

Key changes:
1. Import `fitAABB` instead of `fitOBB`
2. Import `scoreRectangleAABB` instead of `scoreRectangle`
3. Add `SHAPE_AMBIGUITY_DELTA` and `RECT_CORNER_TIE_TOLERANCE_DEG` imports
4. Two-channel preprocessing strategy
5. Rectangle tie-breaker when both pass confidence + ≥2 right angles
6. Near-miss detection with ambiguous flag

```typescript
// Updated imports
import { SHAPE_CONFIDENCE_MIN, SHAPE_AMBIGUITY_DELTA, RECT_CORNER_TIE_TOLERANCE_DEG } from './shape-params';
import { fitAABB } from './fit-aabb';
import { scoreCircle, scoreRectangleAABB } from './score';

// In recognizeOpenStroke function, rectangle analysis section:

  // =========================================================================
  // Step 3: Fit and score RECTANGLE (AABB with two-channel approach)
  // =========================================================================
  console.log('\n--- RECTANGLE ANALYSIS (AABB) ---');

  const diag = Math.hypot(width, height);

  // Track-A (rawPts): Original points for AABB fitting and side proximity/coverage scoring
  const rawPts = points; // Vec2[] already converted above

  // Track-B (cleanPts): RDP + decimation + micro-closure for corner/edge extraction only
  // Create a COPY and process it (never mutate preview points)
  let flat = pointsWU.slice(); // Copy the flat array

  // RDP simplification: removes jitter for clean corner detection
  const rdp = simplifyStroke(flat, 'pen');
  if (rdp.points.length >= 4) {
    flat = rdp.points;
  }

  // Distance decimation: ensure minimum segment length for stable corner detection
  const minSegWU = Math.max(10, Math.min(18, 0.06 * diag)); // Clamp between 10-18 WU
  const decimated: number[] = [];
  let lastX = flat[0], lastY = flat[1];
  decimated.push(lastX, lastY);

  for (let i = 2; i < flat.length; i += 2) {
    const x = flat[i], y = flat[i + 1];
    const dx = x - lastX, dy = y - lastY;
    if (dx * dx + dy * dy >= minSegWU * minSegWU) {
      decimated.push(x, y);
      lastX = x;
      lastY = y;
    }
  }

  // Always include the last original point to preserve shape
  const lx = flat[flat.length - 2], ly = flat[flat.length - 1];
  if (decimated[decimated.length - 2] !== lx || decimated[decimated.length - 1] !== ly) {
    decimated.push(lx, ly);
  }

  // Micro-closure: snap nearly-closed paths so wrap-around corners are detected
  const sx = decimated[0], sy = decimated[1];
  const ex = decimated[decimated.length - 2], ey = decimated[decimated.length - 1];
  const gap = Math.hypot(ex - sx, ey - sy);
  const closeEps = 0.06 * diag;
  const closed = gap <= closeEps;
  if (closed) {
    decimated.push(sx, sy);
  }

  // Convert cleaned points to Vec2 for corner/edge detection
  const cleanPts: Vec2[] = [];
  for (let i = 0; i < decimated.length; i += 2) {
    if (i + 1 < decimated.length) {
      cleanPts.push([decimated[i], decimated[i + 1]]);
    }
  }

  // AABB fit uses rawPts (Track-A) for robust fitting
  const aabbFit = fitAABB(rawPts);

  // Corner/edge detection uses cleanPts (Track-B) for jitter-free analysis
  const corners = detectCorners(cleanPts, minSegWU, 45, closed);
  const edges = reconstructRectangleEdges(cleanPts, corners, minSegWU);

  // Score using rawPts for side metrics, but corners/edges from cleanPts
  const boxScore = scoreRectangleAABB(rawPts, aabbFit, edges, corners);

  // =========================================================================
  // Step 4: Determine winner with rectangle tie-breaker
  // =========================================================================

  // Count right-angle corners for tie-breaker (uses stricter RECT_CORNER_TIE_TOLERANCE_DEG)
  const rightAngleCorners = corners.filter(
    c => Math.abs(c.angle - 90) <= RECT_CORNER_TIE_TOLERANCE_DEG
  );

  // Case 1: Rectangle tie-breaker - both pass confidence + ≥2 right angles
  if (circleScore >= SHAPE_CONFIDENCE_MIN && boxScore >= SHAPE_CONFIDENCE_MIN) {
    if (rightAngleCorners.length >= 2) {
      // Rectangle wins the tie
      return {
        kind: 'box',
        score: boxScore,
        box: {
          cx: aabbFit.cx,
          cy: aabbFit.cy,
          angle: 0,  // ALWAYS 0 for AABB
          hx: aabbFit.hx,
          hy: aabbFit.hy
        }
      };
    }
  }

  // Case 2: Normal winner by highest score
  let winner: { kind: 'circle' | 'box'; score: number };
  if (boxScore >= circleScore) {
    winner = { kind: 'box', score: boxScore };
  } else {
    winner = { kind: 'circle', score: circleScore };
  }

  // Case 3: Winner passes confidence threshold
  if (winner.score >= SHAPE_CONFIDENCE_MIN) {
    if (winner.kind === 'circle') {
      return {
        kind: 'circle',
        score: winner.score,
        circle: { cx: circleFit.cx, cy: circleFit.cy, r: circleFit.r }
      };
    } else {
      return {
        kind: 'box',
        score: winner.score,
        box: {
          cx: aabbFit.cx,
          cy: aabbFit.cy,
          angle: 0,  // ALWAYS 0 for AABB
          hx: aabbFit.hx,
          hy: aabbFit.hy
        }
      };
    }
  }

  // Case 4: Near-miss - any shape was close to confidence threshold
  const maxScore = Math.max(circleScore, boxScore);
  const nearMissThreshold = SHAPE_CONFIDENCE_MIN - SHAPE_AMBIGUITY_DELTA;

  if (maxScore >= nearMissThreshold) {
    // Return with ambiguous flag to prevent any snap
    const A = points[0];
    return {
      kind: 'line',
      score: maxScore,
      ambiguous: true,  // Signal to DrawingTool: don't snap, continue freehand
      line: { A: [A[0], A[1]], B: pointerNowWU }
    };
  }

  // Case 5: Clear failure - fallback to line
  const A = points[0];
  return {
    kind: 'line',
    score: 1,
    line: { A: [A[0], A[1]], B: pointerNowWU }
  };
```

**Critical Implementation Details:**
- **Never mutate preview points** - RDP/decimation operates on a copy
- **Two separate data flows**: rawPts → AABB fit + side scoring; cleanPts → corner/edge detection
- **Angle is always 0** for AABB rectangles
- **RECT_CORNER_TIE_TOLERANCE_DEG = 20°** for tie-breaker (stricter than soft scoring tolerance)

### 2.6 Update DrawingTool for Ambiguous (Near-Miss) Handling (IMPLEMENTED)

**File: `/client/src/lib/tools/DrawingTool.ts`** (MODIFIED in onHoldFire method)

The DrawingTool now handles the ambiguous flag to prevent annoying line snaps when the user clearly intended a shape but didn't quite make the threshold:

```typescript
private onHoldFire(): void {
  if (this.snap) return;

  this.flushPending();

  const len = this.state.points.length;
  if (len < 2) return;
  const pointerNowWU: [number, number] = [
    this.state.points[len - 2], this.state.points[len - 1]
  ];

  this.liveCursorWU = pointerNowWU;

  console.group('🎯 Hold Detector Fired - Shape Recognition');
  console.log(`Stroke has ${this.state.points.length / 2} points after 600ms dwell`);

  const result = recognizeOpenStroke({
    pointsWU: this.state.points,
    pointerNowWU
  });

  // Handle near-miss result - don't snap, continue freehand
  if (result.ambiguous) {
    console.log('🤷 Near-miss detected - NO SNAP, user likely intended a shape but didn\'t quite make it');
    console.groupEnd();
    // Don't set snap, don't cancel hold, just continue drawing
    // This prevents the annoying line snap when user almost drew a shape
    return;
  }

  // Handle recognized shapes (line, circle, box)
  if (result.kind === 'line' || result.score >= SHAPE_CONFIDENCE_MIN) {
    this.snap = (
      result.kind === 'line'
        ? { kind: 'line', anchors: { A: result.line!.A } }
      : result.kind === 'circle'
        ? { kind: 'circle', anchors: { center: [result.circle!.cx, result.circle!.cy] } }
        : { kind: 'box', anchors: {
            cx: result.box!.cx,
            cy: result.box!.cy,
            angle: 0,  // ALWAYS 0 for AABB
            hx0: result.box!.hx,
            hy0: result.box!.hy
          }}
    );
    console.log(`✅ SNAP DECISION: ${result.kind.toUpperCase()} (score: ${result.score.toFixed(3)})`);
    console.groupEnd();
    this.requestOverlayFrame?.();
    this.hold.cancel();
  }
}
```

**Key Behavior Changes:**
- If `result.ambiguous === true`, the tool continues freehand drawing (no snap)
- This occurs when any shape scores within 0.10 of the confidence threshold (in range [0.48, 0.58))
- User's stroke continues unmodified, preventing frustrating line snaps for "almost shapes"

### 2.7 Update Recognition Result Interface

**File: `/client/src/lib/geometry/recognize-open-stroke.ts`** (MODIFY interface)

```typescript
export interface RecognitionResult {
  /** The recognized shape type */
  kind: 'line' | 'circle' | 'box';

  /** Confidence score [0, 1]. Line always has score 1. */
  score: number;

  /** NEW: Flag indicating near-miss - shape almost passed threshold, don't snap to line */
  ambiguous?: boolean;

  // ... rest of interface unchanged
}
```

### 3.2 Tuning Parameters

If recognition needs adjustment:

**Too many false rectangles:**
- Increase `SHAPE_CONFIDENCE_MIN` from 0.58 to 0.62
- Increase `RECT_SIDE_EPSILON_FACTOR` to require closer side following
- Increase weight on `RECT_WEIGHT_SIDECOV` to require more complete rectangles

**Too few rectangles recognized:**
- Decrease `SHAPE_CONFIDENCE_MIN` to 0.54
- Increase `SHAPE_AMBIGUITY_DELTA` to 0.15 for wider near-miss detection range
- Increase `RECT_CORNER_SOFT_TOLERANCE_DEG` to be more forgiving

**Near-miss behavior adjustment:**
- `SHAPE_AMBIGUITY_DELTA = 0.10` means shapes scoring in [0.48, 0.58) won't snap
- Increase to 0.15 for range [0.43, 0.58) if users complain about unwanted line snaps
- Decrease to 0.05 for range [0.53, 0.58) if too many "almost shapes" are ignored

---

## 5. Key Implementation Notes

### Critical Invariants to Maintain

1. **Never mutate preview points** - Recognition should work on copies
2. **Angle = 0 always** for AABB rectangles
3. **Soft scoring only** - No hard gates for rectangles (except for corner counting in tie-breaker)
4. **Near-miss detection** - Use `ambiguous: true` flag when any shape is within 0.10 of threshold
5. **Rectangle tie-breaker** - When both pass confidence, rectangle wins if ≥2 right angles
6. **Circle unchanged** - Don't modify circle detection at all

### Important Compatibility Note

The existing `perfect-shape-preview.ts` renderer still expects an `angle` parameter in box anchors. Even though AABB always has `angle: 0`, keep passing it for compatibility:
- The renderer will still work correctly with `angle: 0`
- Future optimization could simplify the box rendering for axis-aligned cases
- No changes needed to the renderer for initial implementation

### Debug Support

Keep `SHAPE_DEBUG_SCORES = true` during development to see:
- Component score breakdowns
- Which sides were visited
- Ambiguity detection results
- Why shapes won/lost competition

---

## 6. Expected Behavior After Implementation

### User Experience Improvements

**Before:**
- Rectangle needs perfect corners → frequent line fallbacks
- Overshooting kills recognition
- Incomplete rectangles never work
- Rotated rectangles add complexity

**After:**
- Rectangle recognition is forgiving like circles
- Overshoots and gaps handled gracefully
- Near-miss shapes (score in [0.48, 0.58)) don't snap to line
- Rectangle wins when both shapes pass + ≥2 right angles present
- Always axis-aligned (cleaner, simpler)

### Technical Benefits

1. **Robustness**: Trimmed AABB ignores outliers
2. **Simplicity**: No PCA, no angle calculations
3. **Flexibility**: All scoring is soft, no hard failures (except corner count for tie-breaker)
4. **Intelligence**: Near-miss detection prevents annoying line snaps when user intended a shape
5. **Smart tie-breaking**: Rectangle wins when user clearly draws right angles

---

## Summary

This implementation replaces the fragile OBB-based rectangle detection with a robust AABB approach that:
- **Removes all hard gates** making recognition forgiving
- **Uses axis-aligned boxes** eliminating rotation complexity
- **Adds near-miss detection** preventing line snaps when user clearly intended a shape (score within 0.10 of threshold)
- **Implements rectangle tie-breaker** for when both shapes pass confidence + ≥2 right angles present
- **Maintains existing architecture** minimizing changes
- **Preserves circle detection** which already works well

The key insight is that by making rectangle scoring entirely soft and using robust AABB fitting, we can handle imperfect drawing (overshoots, gaps, wobbles) while maintaining high accuracy. The near-miss detection ensures users aren't frustrated by unexpected line snaps when their shape attempt was "close but not quite" (scored in [0.48, 0.58) range).
