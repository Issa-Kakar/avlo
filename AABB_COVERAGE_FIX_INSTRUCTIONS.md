# AABB Rectangle Coverage Fix - Implementation Instructions

## Problem Statement

The current AABB rectangle detection implementation has too many false positives. The main issue is with the simplistic side coverage calculation (`aabbSideCoverage`) which only checks if points are near each side and returns 0.25 per side visited (0.25, 0.50, 0.75, or 1.0). This naive approach doesn't consider how points are distributed across the sides, allowing lines, L-shapes, and slight angles to score too high when they happen to run close to a couple of edges.

Previously, when using OBB (Oriented Bounding Box), the coverage measured both:
1. How many sides had points
2. **Evenness** of point distribution across the four sides

The combination was: `coverage * 0.7 + evenness * 0.3`, where evenness prevented imbalanced distributions from scoring high. This "evenness" term is exactly what's missing in the current AABB implementation.

## Additional Requirements

Beyond fixing the coverage issue, we need to add several right-angle corner checks to prevent false positives and handle edge cases:

1. **No Right Angles → Severe Penalty**: If a rectangle doesn't have at least one right angle corner, give it either confidence = 0 or apply a significant /2 multiplier so it doesn't compete with straight lines
2. **<2 Right Angles + Rectangle Wins → Ambiguous**: If rectangle has less than 2 right angles (needs at least 2) and it wins, return the ambiguous flag
3. **≥1 Right Angle + Circle Wins → Ambiguous**: If there are 1 or more right angles and circle wins, return the ambiguous flag (reduces false positives when rectangles lose)
4. **>4 Right Angles → Always Ambiguous**: If rectangle has greater than 4 right angle corners (regardless of win/loss), make it ambiguous (prevents line snap issues)
5. **Exactly 2 Right Angles → Score Penalty**: If rectangle has exactly 2 right angles, apply a -0.03 subtraction from the confidence score

## Current Implementation Analysis

### Current Files Structure
- `/client/src/lib/geometry/geometry-helpers.ts` - Contains both the old OBB `coverageAcrossDistinctSides` (lines 512-563) and current AABB helpers
- `/client/src/lib/geometry/score.ts` - Contains `scoreRectangleAABB` function that uses the simplistic `aabbSideCoverage`
- `/client/src/lib/geometry/shape-params.ts` - Contains all tuning parameters
- `/client/src/lib/geometry/recognize-open-stroke.ts` - Main recognition pipeline

### Current Weights (from shape-params.ts)
```typescript
RECT_WEIGHT_SIDEDIST = 0.30    // Side proximity
RECT_WEIGHT_SIDECOV = 0.20     // Side coverage (the problematic one)
RECT_WEIGHT_CORNERS = 0.50     // Corner quality
RECT_WEIGHT_PARALLEL = 0.00    // Currently disabled
RECT_WEIGHT_ORTHOGONAL = 0.00  // Currently disabled
```

## Step-by-Step Implementation Guide

### Step 1: Add New Constants to shape-params.ts

Add these new constants to `/client/src/lib/geometry/shape-params.ts`:

```typescript
// AABB Coverage parameters (mirroring OBB)
export const RECT_AABB_COVERAGE_TOLERANCE_FACTOR = 0.15; // 15% of min(width,height), mirrors OBB
export const RECT_AABB_COVERAGE_MIN_TOL = 1.5;           // keep a floor in WU so tiny boxes don't collapse

// Right-angle corner requirements and penalties
export const RECT_MIN_RIGHT_ANGLES_FOR_VALIDITY = 1;     // Need at least 1 right angle to be valid
export const RECT_NO_RIGHT_ANGLE_MULTIPLIER = 0.5;        // Severe penalty if no right angles
export const RECT_MIN_RIGHT_ANGLES_FOR_CONFIDENCE = 2;   // Need at least 2 to avoid ambiguity
export const RECT_TWO_RIGHT_ANGLES_PENALTY = 0.03;       // Subtract from score if exactly 2 right angles
export const RECT_MAX_RIGHT_ANGLES = 4;                  // More than 4 right angles = ambiguous
```

### Step 2: Create AABB Coverage Function (Mirroring OBB)

Add this new function to `/client/src/lib/geometry/geometry-helpers.ts`:

```typescript
/**
 * Calculate coverage across distinct sides of an AABB rectangle.
 * This mirrors the OBB implementation exactly but for axis-aligned boxes.
 * Returns a combined score of side coverage and evenness of distribution.
 */
export function aabbCoverageAcrossDistinctSides(
  points: Vec2[],
  aabb: { minX: number; minY: number; maxX: number; maxY: number }
): number {
  if (points.length < 4) return 0;

  const width  = Math.max(1, aabb.maxX - aabb.minX);
  const height = Math.max(1, aabb.maxY - aabb.minY);
  const tol = Math.max(RECT_AABB_COVERAGE_MIN_TOL, RECT_AABB_COVERAGE_TOLERANCE_FACTOR * Math.min(width, height));

  let top = 0, bottom = 0, left = 0, right = 0;

  for (const [x, y] of points) {
    // Check proximity to each side with tolerance
    const nearTop    = Math.abs(y - aabb.minY) <= tol && x >= aabb.minX - tol && x <= aabb.maxX + tol;
    const nearBottom = Math.abs(y - aabb.maxY) <= tol && x >= aabb.minX - tol && x <= aabb.maxX + tol;
    const nearLeft   = Math.abs(x - aabb.minX) <= tol && y >= aabb.minY - tol && y <= aabb.maxY + tol;
    const nearRight  = Math.abs(x - aabb.maxX) <= tol && y >= aabb.minY - tol && y <= aabb.maxY + tol;

    if (nearTop) top++;
    if (nearBottom) bottom++;
    if (nearLeft) left++;
    if (nearRight) right++;
  }

  const sidesWithPoints = (top > 0 ? 1 : 0) + (bottom > 0 ? 1 : 0) + (left > 0 ? 1 : 0) + (right > 0 ? 1 : 0);
  const total = top + bottom + left + right;
  if (total === 0) return 0;

  // Calculate distribution evenness
  const distribution = [top, bottom, left, right].map(c => c / total);
  const maxDistribution = Math.max(...distribution);
  const evenness = 1 - (maxDistribution - 0.25) / 0.75; // identical to OBB

  const coverage = sidesWithPoints / 4;
  return coverage * 0.7 + evenness * 0.3; // identical to OBB weighting
}
```

Don't forget to add the imports at the top of the file:
```typescript
import { RECT_AABB_COVERAGE_TOLERANCE_FACTOR, RECT_AABB_COVERAGE_MIN_TOL } from './shape-params';
```

### Step 3: Update Rectangle Scoring Function

Modify the `scoreRectangleAABB` function in `/client/src/lib/geometry/score.ts`:

1. **Add imports** at the top:
```typescript
import {
  // ... existing imports ...
  RECT_AABB_COVERAGE_TOLERANCE_FACTOR,
  RECT_AABB_COVERAGE_MIN_TOL,
  RECT_MIN_RIGHT_ANGLES_FOR_VALIDITY,
  RECT_NO_RIGHT_ANGLE_MULTIPLIER,
  RECT_TWO_RIGHT_ANGLES_PENALTY
} from './shape-params';

import {
  // ... existing imports ...
  aabbCoverageAcrossDistinctSides  // Add this new import
} from './geometry-helpers';
```

2. **Replace the Side Coverage calculation** (around line 85-89):
```typescript
// Component 2: Side Coverage (20% weight) - NOW WITH EVENNESS
const S_sideCov = aabbCoverageAcrossDistinctSides(points, aabb);
console.log(`2. Side Coverage with Evenness (${RECT_WEIGHT_SIDECOV * 100}%): ${S_sideCov.toFixed(3)}`);
console.log(`   Coverage accounts for both sides visited and distribution evenness`);
```

3. **Add right-angle corner analysis and penalties** after the final score calculation (before the console.log statements at the end):
```typescript
// Count right-angle corners (within stricter tolerance for validity checks)
const rightAngleCorners = corners.filter(
  c => Math.abs(c.angle - 90) <= RECT_CORNER_TIE_TOLERANCE_DEG
);
const rightAngleCount = rightAngleCorners.length;

// Apply right-angle corner penalties/multipliers
let finalScore = score;

// Severe penalty if no right angles
if (rightAngleCount < RECT_MIN_RIGHT_ANGLES_FOR_VALIDITY) {
  console.log(`⚠️ NO right-angle corners detected - applying ${RECT_NO_RIGHT_ANGLE_MULTIPLIER}x multiplier`);
  finalScore *= RECT_NO_RIGHT_ANGLE_MULTIPLIER;
}

// Additional penalty for exactly 2 right angles
if (rightAngleCount === 2) {
  console.log(`📉 Exactly 2 right angles - subtracting ${RECT_TWO_RIGHT_ANGLES_PENALTY} from score`);
  finalScore -= RECT_TWO_RIGHT_ANGLES_PENALTY;
}

console.log(`🎯 Final AABB Score: ${finalScore.toFixed(3)} (base: ${score.toFixed(3)})`);
console.log(`Right-angle corners: ${rightAngleCount}`);
console.log(`Confidence threshold: ${SHAPE_CONFIDENCE_MIN}`);

// ... existing console logs ...

return Math.max(0, Math.min(1, finalScore)); // Return modified score
```

### Step 4: Update Recognition Pipeline for Ambiguity Rules

Modify `/client/src/lib/geometry/recognize-open-stroke.ts`:

1. **Add imports**:
```typescript
import {
  // ... existing imports ...
  RECT_MIN_RIGHT_ANGLES_FOR_CONFIDENCE,
  RECT_MAX_RIGHT_ANGLES
} from './shape-params';
```

2. **Modify the decision logic** (starting around line 227). Replace the entire Step 5 section with:

```typescript
// =========================================================================
// Step 5: Apply confidence logic with enhanced right-angle rules
// =========================================================================

// Count right-angle corners for all decision logic
const rightAngleCorners = corners.filter(
  c => Math.abs(c.angle - 90) <= RECT_CORNER_TIE_TOLERANCE_DEG
);
const rightAngleCount = rightAngleCorners.length;

console.log(`Right-angle corners (within ±${RECT_CORNER_TIE_TOLERANCE_DEG}°): ${rightAngleCount}`);

// Check for too many right angles (>4) - always ambiguous
if (rightAngleCount > RECT_MAX_RIGHT_ANGLES) {
  console.log(`⚠️ TOO MANY right angles (${rightAngleCount} > 4) - AMBIGUOUS to prevent line snap`);
  console.groupEnd();
  console.groupEnd();

  const A = points[0];
  return {
    kind: 'line',
    score: Math.max(circleScore, boxScore),
    ambiguous: true,
    line: { A: [A[0], A[1]], B: pointerNowWU }
  };
}

// Case 1: Rectangle tie-breaker - both pass confidence + ≥2 right angles
if (circleScore >= SHAPE_CONFIDENCE_MIN && boxScore >= SHAPE_CONFIDENCE_MIN) {
  if (rightAngleCount >= 2) {
    console.log(`🎯 TIE-BREAKER: Rectangle wins (both pass confidence + ${rightAngleCount} right angles)`);
    console.groupEnd();
    console.groupEnd();

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
  // If <2 right angles, fall through to normal winner logic
}

// Case 2: Check winner by highest score
let winner: { kind: 'circle' | 'box'; score: number; data: any };
if (boxScore >= circleScore) {
  winner = { kind: 'box', score: boxScore, data: aabbFit };
  console.log(`Winner: RECTANGLE (${boxScore.toFixed(3)})`);
} else {
  winner = { kind: 'circle', score: circleScore, data: circleFit };
  console.log(`Winner: CIRCLE (${circleScore.toFixed(3)})`);
}

// Case 3: Check for ambiguity based on right angles
// If rectangle wins with <2 right angles, make ambiguous
if (winner.kind === 'box' && winner.score >= SHAPE_CONFIDENCE_MIN && rightAngleCount < RECT_MIN_RIGHT_ANGLES_FOR_CONFIDENCE) {
  console.log(`⚠️ Rectangle wins but has <2 right angles (${rightAngleCount}) - AMBIGUOUS`);
  console.groupEnd();
  console.groupEnd();

  const A = points[0];
  return {
    kind: 'line',
    score: winner.score,
    ambiguous: true,
    line: { A: [A[0], A[1]], B: pointerNowWU }
  };
}

// If circle wins but there are right angles, make ambiguous
if (winner.kind === 'circle' && winner.score >= SHAPE_CONFIDENCE_MIN && rightAngleCount >= 1) {
  console.log(`⚠️ Circle wins but ${rightAngleCount} right angle(s) detected - AMBIGUOUS`);
  console.groupEnd();
  console.groupEnd();

  const A = points[0];
  return {
    kind: 'line',
    score: winner.score,
    ambiguous: true,
    line: { A: [A[0], A[1]], B: pointerNowWU }
  };
}

// Case 4: Winner passes confidence threshold (and passed ambiguity checks above)
if (winner.score >= SHAPE_CONFIDENCE_MIN) {
  console.log(`✅ RECOGNIZED: ${winner.kind.toUpperCase()} (score ${winner.score.toFixed(3)} >= ${SHAPE_CONFIDENCE_MIN})`);
  console.groupEnd();
  console.groupEnd();

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

// Case 5: Near-miss - any shape was close to confidence threshold
const maxScore = Math.max(circleScore, boxScore);
const nearMissThreshold = SHAPE_CONFIDENCE_MIN - SHAPE_AMBIGUITY_DELTA;

if (maxScore >= nearMissThreshold) {
  console.log(`🤷 NEAR-MISS: Best score ${maxScore.toFixed(3)} is within ${SHAPE_AMBIGUITY_DELTA} of threshold`);
  console.log(`📝 NO SNAP - User likely intended a shape, continue freehand`);
  console.groupEnd();
  console.groupEnd();

  // Return with ambiguous flag to prevent any snap
  const A = points[0];
  return {
    kind: 'line',
    score: maxScore,
    ambiguous: true,  // Signal to DrawingTool: don't snap, continue freehand
    line: { A: [A[0], A[1]], B: pointerNowWU }
  };
}

// Case 6: Clear failure - fallback to line
console.log(`❌ Score too low: ${maxScore.toFixed(3)} < ${nearMissThreshold.toFixed(3)}`);
console.log('📏 FALLBACK: LINE (clear failure, user didn\'t intend a shape)');
console.groupEnd();
console.groupEnd();

const A = points[0];
return {
  kind: 'line',
  score: 1,
  line: { A: [A[0], A[1]], B: pointerNowWU }
};
```

## Testing Guidelines

After implementing these changes, test the following scenarios:

1. **Straight Lines**: Should snap to lines properly without false rectangle detection
2. **L-Shapes**: Should not trigger rectangle detection due to improved evenness scoring
3. **Rectangles with 0 right angles**: Should fail or score very low
4. **Rectangles with 1 right angle**: Should score low and not compete with lines
5. **Rectangles with 2 right angles**: Should have reduced score (-0.03 penalty) and trigger ambiguity if they win
6. **Rectangles with 3-4 right angles**: Should work normally (best case)
7. **Malformed shapes with >4 right angles**: Should trigger ambiguity to prevent line snaps
8. **Circles with some right angles**: Should trigger ambiguity when circle wins but right angles exist

## Summary of Changes

1. **New Coverage Function**: `aabbCoverageAcrossDistinctSides` that mirrors the OBB implementation exactly, combining side coverage with evenness scoring
2. **Right-Angle Penalties**: Added multipliers and penalties based on right-angle corner count
3. **Enhanced Ambiguity Logic**: Multiple new ambiguity triggers based on right-angle corner analysis
4. **New Constants**: Added configuration parameters for all the new behaviors

The key insight is that by porting the OBB coverage logic (which includes evenness) to AABB and adding comprehensive right-angle corner checks, we can eliminate most false positives while maintaining robust rectangle detection for actual rectangles.