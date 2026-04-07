/**
 * Shape Scoring Functions
 * Evaluates how well a stroke matches specific shapes (circle, rectangle).
 * Each shape has hard gates (immediate rejection) and weighted scoring components.
 */

import type { Vec2, Edge, Corner } from './types';
import {
  SHAPE_CONFIDENCE_MIN,
  CIRCLE_MIN_COVERAGE,
  CIRCLE_MAX_AXIS_RATIO,
  CIRCLE_MAX_RMS_RATIO,
  CIRCLE_WEIGHT_COVERAGE,
  CIRCLE_WEIGHT_FIT,
  CIRCLE_WEIGHT_ROUND,
  // AABB parameters
  RECT_SIDE_EPSILON_FACTOR,
  RECT_MIN_SIDE_EPSILON,
  RECT_CORNER_SOFT_TOLERANCE_DEG,
  RECT_PARALLEL_SOFT_TOLERANCE_DEG,
  RECT_ORTHOGONAL_SOFT_TOLERANCE_DEG,
  RECT_WEIGHT_SIDEDIST,
  RECT_WEIGHT_SIDECOV,
  RECT_WEIGHT_CORNERS,
  RECT_WEIGHT_PARALLEL,
  RECT_WEIGHT_ORTHOGONAL,
  // New right-angle constants
  RECT_MIN_RIGHT_ANGLES_FOR_VALIDITY,
  RECT_NO_RIGHT_ANGLE_MULTIPLIER,
  RECT_TWO_RIGHT_ANGLES_PENALTY,
  RECT_CORNER_TIE_TOLERANCE_DEG,
} from './shape-params';

import {
  pcaAxisRatio,
  angularCoverage,
  avgParallelError,
  avgOrthogonalError,
  // AABB helpers
  aabbSideFitScore,
  aabbCoverageAcrossDistinctSides,
} from './geometry-helpers';

/**
 * Clamps a value to [0, 1] range
 */
function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

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
  aabb: {
    cx: number;
    cy: number;
    hx: number;
    hy: number;
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
  },
  edges: Edge[] = [],
  corners: Corner[] = [],
): number {
  console.group('🟦 AABB Rectangle Scoring (Soft)');

  const diag = Math.hypot(aabb.maxX - aabb.minX, aabb.maxY - aabb.minY) || 1;
  const epsilon = Math.max(RECT_MIN_SIDE_EPSILON, RECT_SIDE_EPSILON_FACTOR * diag);

  console.log('AABB parameters:', {
    center: [aabb.cx.toFixed(1), aabb.cy.toFixed(1)],
    size: [(aabb.maxX - aabb.minX).toFixed(1), (aabb.maxY - aabb.minY).toFixed(1)],
    epsilon: epsilon.toFixed(1),
  });

  // =========================================================================
  // Component 1: Side Distance Score (40% weight) - PRIMARY SIGNAL
  // =========================================================================
  const S_sideDist = aabbSideFitScore(points, aabb, epsilon);
  console.log(`1. Side Proximity (${RECT_WEIGHT_SIDEDIST * 100}%): ${S_sideDist.toFixed(3)}`);
  console.log(`   Points within ${epsilon.toFixed(1)} of sides: ${(S_sideDist * 100).toFixed(1)}%`);

  // =========================================================================
  // Component 2: Side Coverage (20% weight) - NOW WITH EVENNESS
  // =========================================================================
  const S_sideCov = aabbCoverageAcrossDistinctSides(points, aabb);
  console.log(
    `2. Side Coverage with Evenness (${RECT_WEIGHT_SIDECOV * 100}%): ${S_sideCov.toFixed(3)}`,
  );
  console.log(`   Coverage accounts for both sides visited and distribution evenness`);

  // =========================================================================
  // Component 3: Corner Quality (15% weight) - SOFT CONTRIBUTION ONLY
  // =========================================================================
  let S_corners = 0;
  if (corners.length > 0) {
    const rightAngleScores = corners.map((c) => {
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
    console.log(
      `5. Orthogonal Edges (${RECT_WEIGHT_ORTHOGONAL * 100}%): ${S_orthogonal.toFixed(3)}`,
    );
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

  // Count right-angle corners (within stricter tolerance for validity checks)
  const rightAngleCorners = corners.filter(
    (c) => Math.abs(c.angle - 90) <= RECT_CORNER_TIE_TOLERANCE_DEG,
  );
  const rightAngleCount = rightAngleCorners.length;

  // Apply right-angle corner penalties/multipliers
  let finalScore = score;

  // Severe penalty if no right angles
  if (rightAngleCount < RECT_MIN_RIGHT_ANGLES_FOR_VALIDITY) {
    console.log(
      `⚠️ NO right-angle corners detected - applying ${RECT_NO_RIGHT_ANGLE_MULTIPLIER}x multiplier`,
    );
    finalScore *= RECT_NO_RIGHT_ANGLE_MULTIPLIER;
  }

  // Additional penalty for exactly 2 right angles
  if (rightAngleCount === 2) {
    console.log(
      `📉 Exactly 2 right angles - subtracting ${RECT_TWO_RIGHT_ANGLES_PENALTY} from score`,
    );
    finalScore -= RECT_TWO_RIGHT_ANGLES_PENALTY;
  }

  console.log(`🎯 Final AABB Score: ${finalScore.toFixed(3)} (base: ${score.toFixed(3)})`);
  console.log(`Right-angle corners: ${rightAngleCount}`);
  console.log(`Confidence threshold: ${SHAPE_CONFIDENCE_MIN}`);

  if (finalScore >= SHAPE_CONFIDENCE_MIN) {
    console.log(`✅ Above threshold - competitive rectangle`);
  } else {
    console.log(`⚠️ Below threshold - may not win or trigger ambiguity`);
  }

  console.groupEnd();

  return Math.max(0, Math.min(1, finalScore)); // Return modified score
}

/**
 * Scores how well a stroke matches a circle shape.
 *
 * @param points - The stroke points
 * @param fit - The fitted circle parameters with residual
 * @returns Score in [0, 1], or 0 if hard gates not met
 */
export function scoreCircle(
  points: Vec2[],
  fit: { cx: number; cy: number; r: number; residualRMS: number },
): number {
  console.group('⭕ Circle Scoring Analysis');
  console.log('Input:', {
    pointCount: points.length,
    fit: {
      center: [fit.cx.toFixed(1), fit.cy.toFixed(1)],
      radius: fit.r.toFixed(1),
      residualRMS: fit.residualRMS.toFixed(2),
    },
  });

  // =========================================================================
  // Hard Gate 1: PCA Axis Ratio (roundness check)
  // =========================================================================
  console.group('🔍 Hard Gates');
  const axisRatio = pcaAxisRatio(points);
  console.log(`1. PCA Axis Ratio (Roundness):`);
  console.log(`   Value: ${axisRatio.toFixed(3)} (threshold: ${CIRCLE_MAX_AXIS_RATIO})`);
  console.log(
    `   Interpretation: ${axisRatio < 1.2 ? 'Very round' : axisRatio < 1.5 ? 'Somewhat elliptical' : 'Very elongated'}`,
  );

  if (axisRatio > CIRCLE_MAX_AXIS_RATIO) {
    console.log(`   ❌ FAILED: ${axisRatio.toFixed(3)} > ${CIRCLE_MAX_AXIS_RATIO} (too elongated)`);
    console.groupEnd(); // Close Hard Gates
    console.groupEnd(); // Close Circle Scoring
    return 0;
  }
  console.log('   ✅ PASSED');

  // =========================================================================
  // Hard Gate 2: Angular Coverage
  // =========================================================================
  const coverage = angularCoverage(points, [fit.cx, fit.cy]);
  const coverageDegrees = coverage * 360;
  console.log(`2. Angular Coverage:`);
  console.log(`   Value: ${coverage.toFixed(3)} (${coverageDegrees.toFixed(0)}°)`);
  console.log(`   Required: ${CIRCLE_MIN_COVERAGE} (${(CIRCLE_MIN_COVERAGE * 360).toFixed(0)}°)`);

  if (coverage < CIRCLE_MIN_COVERAGE) {
    console.log(`   ❌ FAILED: ${coverage.toFixed(3)} < ${CIRCLE_MIN_COVERAGE} (not enough arc)`);
    console.groupEnd(); // Close Hard Gates
    console.groupEnd(); // Close Circle Scoring
    return 0;
  }
  console.log('   ✅ PASSED');

  // =========================================================================
  // Hard Gate 3: Normalized RMS Residual
  // =========================================================================
  const rmsNorm = fit.residualRMS / fit.r;
  console.log(`3. Normalized RMS Residual:`);
  console.log(`   Raw RMS: ${fit.residualRMS.toFixed(2)}, Radius: ${fit.r.toFixed(1)}`);
  console.log(`   Normalized: ${rmsNorm.toFixed(3)} (threshold: ${CIRCLE_MAX_RMS_RATIO})`);
  console.log(
    `   Interpretation: ${rmsNorm < 0.1 ? 'Excellent fit' : rmsNorm < 0.2 ? 'Good fit' : rmsNorm < 0.3 ? 'Acceptable fit' : 'Poor fit'}`,
  );

  if (rmsNorm > CIRCLE_MAX_RMS_RATIO) {
    console.log(
      `   ❌ FAILED: ${rmsNorm.toFixed(3)} > ${CIRCLE_MAX_RMS_RATIO} (points deviate too much)`,
    );
    console.groupEnd(); // Close Hard Gates
    console.groupEnd(); // Close Circle Scoring
    return 0;
  }
  console.log('   ✅ PASSED');
  console.log('All hard gates passed ✅');
  console.groupEnd(); // Close Hard Gates

  // =========================================================================
  // Component Scores
  // =========================================================================
  console.group('📊 Component Scores');

  // Component 1: Coverage Score (50% weight - dominant factor)
  const coverageRange = 1 - CIRCLE_MIN_COVERAGE;
  const S_coverage = clamp01((coverage - CIRCLE_MIN_COVERAGE) / coverageRange);
  console.log(`1. Coverage (${CIRCLE_WEIGHT_COVERAGE * 100}% weight):`);
  console.log(`   Normalized coverage: ${S_coverage.toFixed(3)}`);
  console.log(`   (Maps ${(CIRCLE_MIN_COVERAGE * 360).toFixed(0)}°-360° to 0-1)`);

  // Component 2: Fit Quality (30% weight)
  const S_fit = clamp01(1 - rmsNorm / CIRCLE_MAX_RMS_RATIO);
  console.log(`2. Fit Quality (${CIRCLE_WEIGHT_FIT * 100}% weight):`);
  console.log(`   Score: ${S_fit.toFixed(3)}`);
  console.log(`   (Inverted normalized RMS)`);

  // Component 3: Roundness (20% weight)
  const roundnessRange = CIRCLE_MAX_AXIS_RATIO - 1;
  const S_round = clamp01(1 - (axisRatio - 1) / roundnessRange);
  console.log(`3. Roundness (${CIRCLE_WEIGHT_ROUND * 100}% weight):`);
  console.log(`   Score: ${S_round.toFixed(3)}`);
  console.log(`   (Maps axis ratio 1-${CIRCLE_MAX_AXIS_RATIO} to 1-0)`);
  console.groupEnd(); // Close Component Scores

  // =========================================================================
  // Final Weighted Score
  // =========================================================================
  const S_circle =
    CIRCLE_WEIGHT_COVERAGE * S_coverage + CIRCLE_WEIGHT_FIT * S_fit + CIRCLE_WEIGHT_ROUND * S_round;

  console.group('🎯 Final Circle Score');
  console.log('Breakdown:');
  console.log(
    `   Coverage:  ${CIRCLE_WEIGHT_COVERAGE} × ${S_coverage.toFixed(3)} = ${(CIRCLE_WEIGHT_COVERAGE * S_coverage).toFixed(3)}`,
  );
  console.log(
    `   Fit:       ${CIRCLE_WEIGHT_FIT} × ${S_fit.toFixed(3)} = ${(CIRCLE_WEIGHT_FIT * S_fit).toFixed(3)}`,
  );
  console.log(
    `   Roundness: ${CIRCLE_WEIGHT_ROUND} × ${S_round.toFixed(3)} = ${(CIRCLE_WEIGHT_ROUND * S_round).toFixed(3)}`,
  );
  console.log(`Total: ${S_circle.toFixed(3)}`);
  console.log(`Confidence threshold: ${SHAPE_CONFIDENCE_MIN}`);

  if (S_circle < SHAPE_CONFIDENCE_MIN) {
    console.log(
      `⚠️ Score ${S_circle.toFixed(3)} < ${SHAPE_CONFIDENCE_MIN} (may lose to rectangle or trigger line)`,
    );
  } else {
    console.log(`✅ Score ${S_circle.toFixed(3)} >= ${SHAPE_CONFIDENCE_MIN} (competitive)`);
  }
  console.groupEnd(); // Close Final Score
  console.groupEnd(); // Close Circle Scoring

  return S_circle;
}

// Note: No scoreLine function needed - line is a strict fallback with no scoring
