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
  // =========================================================================
  // Hard Gate: Must have at least 3 right-angle corners
  // =========================================================================
  const rightAngleCorners = corners.filter(
    c => Math.abs(c.angle - 90) <= RECT_CORNER_TOLERANCE_DEG
  );

  if (rightAngleCorners.length < RECT_MIN_CORNERS) {
    // Immediate rejection - not enough right angles to be a rectangle
    return 0;
  }

  // =========================================================================
  // Component 1: Corner Quality (40% weight)
  // Average quality of the best 3 corners
  // =========================================================================
  const cornerQualities = rightAngleCorners.map(c => {
    // Map angle deviation from 90° to quality score [0, 1]
    // Perfect 90° = score 1, deviation at tolerance = score 0
    const deviation = Math.abs(c.angle - 90);
    return 1 - clamp01(deviation / RECT_CORNER_TOLERANCE_DEG);
  });
  const S_corners = top3Avg(cornerQualities);

  // =========================================================================
  // Component 2: Parallel Edges (25% weight)
  // How parallel are opposite edges?
  // =========================================================================
  const parallelErrorDeg = avgParallelError(edges);
  const S_parallel = 1 - clamp01(parallelErrorDeg / RECT_PARALLEL_TOLERANCE_DEG);

  // =========================================================================
  // Component 3: Orthogonal Edges (20% weight)
  // How perpendicular are adjacent edges?
  // =========================================================================
  const orthogonalErrorDeg = avgOrthogonalError(edges);
  const S_orthogonal = 1 - clamp01(orthogonalErrorDeg / RECT_ORTHOGONAL_TOLERANCE_DEG);

  // =========================================================================
  // Component 4: Coverage (15% weight)
  // Are points well-distributed across all four sides?
  // =========================================================================
  const S_coverage = coverageAcrossDistinctSides(points, obb);

  // =========================================================================
  // Final Weighted Score
  // =========================================================================
  const S_rect =
    RECT_WEIGHT_CORNERS * S_corners +
    RECT_WEIGHT_PARALLEL * S_parallel +
    RECT_WEIGHT_ORTHOGONAL * S_orthogonal +
    RECT_WEIGHT_COVERAGE * S_coverage;

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
  // =========================================================================
  // Hard Gate 1: PCA Axis Ratio (roundness check)
  // =========================================================================
  const axisRatio = pcaAxisRatio(points);
  if (axisRatio > CIRCLE_MAX_AXIS_RATIO) {
    // Too elongated to be a circle
    return 0;
  }

  // =========================================================================
  // Hard Gate 2: Angular Coverage
  // Must cover at least 240° (2/3) of a circle
  // =========================================================================
  const coverage = angularCoverage(points, [fit.cx, fit.cy]);
  if (coverage < CIRCLE_MIN_COVERAGE) {
    // Not enough of a circle drawn
    return 0;
  }

  // =========================================================================
  // Hard Gate 3: Normalized RMS Residual
  // How well points fit the ideal circle
  // =========================================================================
  const rmsNorm = fit.residualRMS / fit.r;
  if (rmsNorm > CIRCLE_MAX_RMS_RATIO) {
    // Points deviate too much from fitted circle
    return 0;
  }

  // =========================================================================
  // Component 1: Coverage Score (50% weight - dominant factor)
  // Map coverage from [MIN_COVERAGE, 1] to [0, 1]
  // =========================================================================
  const coverageRange = 1 - CIRCLE_MIN_COVERAGE;
  const S_coverage = clamp01((coverage - CIRCLE_MIN_COVERAGE) / coverageRange);

  // =========================================================================
  // Component 2: Fit Quality (30% weight)
  // Based on normalized RMS - lower is better
  // =========================================================================
  const S_fit = clamp01(1 - (rmsNorm / CIRCLE_MAX_RMS_RATIO));

  // =========================================================================
  // Component 3: Roundness (20% weight)
  // Based on PCA axis ratio - closer to 1 is better
  // =========================================================================
  const roundnessRange = CIRCLE_MAX_AXIS_RATIO - 1;
  const S_round = clamp01(1 - ((axisRatio - 1) / roundnessRange));

  // =========================================================================
  // Final Weighted Score
  // =========================================================================
  const S_circle =
    CIRCLE_WEIGHT_COVERAGE * S_coverage +
    CIRCLE_WEIGHT_FIT * S_fit +
    CIRCLE_WEIGHT_ROUND * S_round;

  return S_circle;
}

// Note: No scoreLine function needed - line is a strict fallback with no scoring