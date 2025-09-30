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

import {
  pcaAxisRatio,
  angularCoverage,
  avgParallelError,
  avgOrthogonalError,
  coverageAcrossDistinctSides,
  top3Avg
} from './geometry-helpers';

/**
 * Clamps a value to [0, 1] range
 */
function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

/**
 * Scores how well a stroke matches a rectangle shape.
 *
 * @param points - The stroke points
 * @param obb - The fitted oriented bounding box
 * @param edges - Detected edges in the stroke
 * @param corners - Detected corners in the stroke
 * @returns Score in [0, 1], or 0 if hard gates not met
 */
export function scoreRectangle(
  points: Vec2[],
  obb: { cx: number; cy: number; angle: number; hx: number; hy: number },
  edges: Edge[],
  corners: Corner[]
): number {
  console.group('🟦 Rectangle Scoring Analysis');
  console.log('Input:', {
    pointCount: points.length,
    obb: { center: [obb.cx, obb.cy], angle: (obb.angle * 180/Math.PI).toFixed(1) + '°', halfExtents: [obb.hx.toFixed(1), obb.hy.toFixed(1)] },
    edgeCount: edges.length,
    cornerCount: corners.length
  });

  // =========================================================================
  // Hard Gate: Must have at least 3 right-angle corners
  // =========================================================================
  console.group('📐 Corner Detection');
  console.log('All corners found:', corners.map(c => ({
    index: c.index,
    angle: c.angle.toFixed(1) + '°',
    deviation: Math.abs(c.angle - 90).toFixed(1) + '°',
    strength: c.strength.toFixed(2)
  })));

  const rightAngleCorners = corners.filter(
    c => Math.abs(c.angle - 90) <= RECT_CORNER_TOLERANCE_DEG
  );

  console.log(`Right-angle corners (±${RECT_CORNER_TOLERANCE_DEG}°):`, rightAngleCorners.length);
  console.log(`Required: ${RECT_MIN_CORNERS}, Found: ${rightAngleCorners.length}`);

  if (rightAngleCorners.length < RECT_MIN_CORNERS) {
    console.log('❌ HARD GATE FAILED: Not enough right-angle corners');
    console.groupEnd(); // Close Corner Detection
    console.groupEnd(); // Close Rectangle Scoring
    return 0;
  }
  console.log('✅ Corner gate passed');
  console.groupEnd(); // Close Corner Detection

  // =========================================================================
  // Component 1: Corner Quality (40% weight)
  // =========================================================================
  console.group('📊 Component Scores');
  const cornerQualities = rightAngleCorners.map(c => {
    const deviation = Math.abs(c.angle - 90);
    return 1 - clamp01(deviation / RECT_CORNER_TOLERANCE_DEG);
  });
  const S_corners = top3Avg(cornerQualities);
  console.log(`1. Corner Quality (${RECT_WEIGHT_CORNERS * 100}% weight):`);
  console.log('   Individual qualities:', cornerQualities.map(q => q.toFixed(3)));
  console.log('   Top-3 average:', S_corners.toFixed(3));

  // =========================================================================
  // Component 2: Parallel Edges (25% weight)
  // =========================================================================
  const parallelErrorDeg = avgParallelError(edges);
  const S_parallel = 1 - clamp01(parallelErrorDeg / RECT_PARALLEL_TOLERANCE_DEG);
  console.log(`2. Parallel Edges (${RECT_WEIGHT_PARALLEL * 100}% weight):`);
  console.log(`   Average error: ${parallelErrorDeg.toFixed(1)}° (threshold: ${RECT_PARALLEL_TOLERANCE_DEG}°)`);
  console.log('   Score:', S_parallel.toFixed(3));

  // =========================================================================
  // Component 3: Orthogonal Edges (20% weight)
  // =========================================================================
  const orthogonalErrorDeg = avgOrthogonalError(edges);
  const S_orthogonal = 1 - clamp01(orthogonalErrorDeg / RECT_ORTHOGONAL_TOLERANCE_DEG);
  console.log(`3. Orthogonal Edges (${RECT_WEIGHT_ORTHOGONAL * 100}% weight):`);
  console.log(`   Average error: ${orthogonalErrorDeg.toFixed(1)}° (threshold: ${RECT_ORTHOGONAL_TOLERANCE_DEG}°)`);
  console.log('   Score:', S_orthogonal.toFixed(3));

  // =========================================================================
  // Component 4: Coverage (15% weight)
  // =========================================================================
  const S_coverage = coverageAcrossDistinctSides(points, obb);
  console.log(`4. Coverage (${RECT_WEIGHT_COVERAGE * 100}% weight):`);
  console.log('   Score:', S_coverage.toFixed(3));
  console.groupEnd(); // Close Component Scores

  // =========================================================================
  // Final Weighted Score
  // =========================================================================
  let S_rect =
    RECT_WEIGHT_CORNERS * S_corners +
    RECT_WEIGHT_PARALLEL * S_parallel +
    RECT_WEIGHT_ORTHOGONAL * S_orthogonal +
    RECT_WEIGHT_COVERAGE * S_coverage;

  console.group('🎯 Final Rectangle Score');
  console.log('Weighted sum:', S_rect.toFixed(3));

  // CRITICAL: Add bias for rectangles with ≥3 right angles BEFORE threshold check
  const rectBias = rightAngleCorners.length >= 3 ? 0.08 : 0.00;
  if (rectBias > 0) {
    console.log(`Rectangle bias: +${rectBias} (${rightAngleCorners.length} right-angle corners)`);
    S_rect += rectBias;
    console.log('Adjusted score:', S_rect.toFixed(3));
  }

  console.log(`Confidence threshold: ${SHAPE_CONFIDENCE_MIN}`);

  if (S_rect < SHAPE_CONFIDENCE_MIN) {
    console.log(`❌ Below threshold: ${S_rect.toFixed(3)} < ${SHAPE_CONFIDENCE_MIN}`);
    console.log('Returning: 0 (will trigger line fallback)');
  } else {
    console.log(`✅ Above threshold: ${S_rect.toFixed(3)} >= ${SHAPE_CONFIDENCE_MIN}`);
    console.log(`Returning: ${S_rect.toFixed(3)}`);
  }
  console.groupEnd(); // Close Final Score
  console.groupEnd(); // Close Rectangle Scoring

  // Only return non-zero score if it meets the global confidence threshold
  return S_rect >= SHAPE_CONFIDENCE_MIN ? S_rect : 0;
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
  fit: { cx: number; cy: number; r: number; residualRMS: number }
): number {
  console.group('⭕ Circle Scoring Analysis');
  console.log('Input:', {
    pointCount: points.length,
    fit: {
      center: [fit.cx.toFixed(1), fit.cy.toFixed(1)],
      radius: fit.r.toFixed(1),
      residualRMS: fit.residualRMS.toFixed(2)
    }
  });

  // =========================================================================
  // Hard Gate 1: PCA Axis Ratio (roundness check)
  // =========================================================================
  console.group('🔍 Hard Gates');
  const axisRatio = pcaAxisRatio(points);
  console.log(`1. PCA Axis Ratio (Roundness):`);
  console.log(`   Value: ${axisRatio.toFixed(3)} (threshold: ${CIRCLE_MAX_AXIS_RATIO})`);
  console.log(`   Interpretation: ${axisRatio < 1.2 ? 'Very round' : axisRatio < 1.5 ? 'Somewhat elliptical' : 'Very elongated'}`);

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
  console.log(`   Interpretation: ${rmsNorm < 0.1 ? 'Excellent fit' : rmsNorm < 0.2 ? 'Good fit' : rmsNorm < 0.3 ? 'Acceptable fit' : 'Poor fit'}`);

  if (rmsNorm > CIRCLE_MAX_RMS_RATIO) {
    console.log(`   ❌ FAILED: ${rmsNorm.toFixed(3)} > ${CIRCLE_MAX_RMS_RATIO} (points deviate too much)`);
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
  const S_fit = clamp01(1 - (rmsNorm / CIRCLE_MAX_RMS_RATIO));
  console.log(`2. Fit Quality (${CIRCLE_WEIGHT_FIT * 100}% weight):`);
  console.log(`   Score: ${S_fit.toFixed(3)}`);
  console.log(`   (Inverted normalized RMS)`);

  // Component 3: Roundness (20% weight)
  const roundnessRange = CIRCLE_MAX_AXIS_RATIO - 1;
  const S_round = clamp01(1 - ((axisRatio - 1) / roundnessRange));
  console.log(`3. Roundness (${CIRCLE_WEIGHT_ROUND * 100}% weight):`);
  console.log(`   Score: ${S_round.toFixed(3)}`);
  console.log(`   (Maps axis ratio 1-${CIRCLE_MAX_AXIS_RATIO} to 1-0)`);
  console.groupEnd(); // Close Component Scores

  // =========================================================================
  // Final Weighted Score
  // =========================================================================
  const S_circle =
    CIRCLE_WEIGHT_COVERAGE * S_coverage +
    CIRCLE_WEIGHT_FIT * S_fit +
    CIRCLE_WEIGHT_ROUND * S_round;

  console.group('🎯 Final Circle Score');
  console.log('Breakdown:');
  console.log(`   Coverage:  ${CIRCLE_WEIGHT_COVERAGE} × ${S_coverage.toFixed(3)} = ${(CIRCLE_WEIGHT_COVERAGE * S_coverage).toFixed(3)}`);
  console.log(`   Fit:       ${CIRCLE_WEIGHT_FIT} × ${S_fit.toFixed(3)} = ${(CIRCLE_WEIGHT_FIT * S_fit).toFixed(3)}`);
  console.log(`   Roundness: ${CIRCLE_WEIGHT_ROUND} × ${S_round.toFixed(3)} = ${(CIRCLE_WEIGHT_ROUND * S_round).toFixed(3)}`);
  console.log(`Total: ${S_circle.toFixed(3)}`);
  console.log(`Confidence threshold: ${SHAPE_CONFIDENCE_MIN}`);

  if (S_circle < SHAPE_CONFIDENCE_MIN) {
    console.log(`⚠️ Score ${S_circle.toFixed(3)} < ${SHAPE_CONFIDENCE_MIN} (may lose to rectangle or trigger line)`);
  } else {
    console.log(`✅ Score ${S_circle.toFixed(3)} >= ${SHAPE_CONFIDENCE_MIN} (competitive)`);
  }
  console.groupEnd(); // Close Final Score
  console.groupEnd(); // Close Circle Scoring

  return S_circle;
}

// Note: No scoreLine function needed - line is a strict fallback with no scoring