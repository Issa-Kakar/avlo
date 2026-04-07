/**
 * Shape Recognition Algorithm
 *
 * Core algorithm that recognizes circles and rectangles from drawn strokes.
 * Uses aggressive recognition with line as a strict fallback.
 *
 * Recognition flow:
 * 1. Fit both circle and rectangle to the stroke
 * 2. Score both shapes
 * 3. Pick winner (higher score)
 * 4. If winner scores >= SHAPE_CONFIDENCE_MIN, return that shape
 * 5. Otherwise, fallback to line (no straightness check)
 */

import type { Vec2 } from './types';
import {
  SHAPE_CONFIDENCE_MIN,
  SHAPE_AMBIGUITY_DELTA,
  RECT_CORNER_TIE_TOLERANCE_DEG,
  RECT_MIN_RIGHT_ANGLES_FOR_CONFIDENCE,
  RECT_MAX_RIGHT_ANGLES,
  LINE_SELF_INTERSECT_AMBIGUOUS,
  LINE_SELF_INTERSECT_EPSILON_FACTOR,
  LINE_SELF_INTERSECT_MIN_EPSILON,
  LINE_NEAR_CLOSURE_AMBIGUOUS,
  LINE_CLOSE_GAP_RATIO,
  LINE_NEAR_TOUCH_AMBIGUOUS,
  LINE_NEAR_TOUCH_EPSILON_FACTOR,
  LINE_NEAR_TOUCH_MIN_EPSILON,
} from './shape-params';
import { fitCircle } from './fit-circle';
import { fitAABB } from './fit-aabb';
import {
  detectCorners,
  reconstructRectangleEdges,
  hasSelfIntersection,
  hasNearTouch,
} from './geometry-helpers';
import { scoreCircle, scoreRectangleAABB } from './score';
import { simplifyStroke } from './simplification';

/**
 * Result of shape recognition
 */
export interface RecognitionResult {
  /** The recognized shape type */
  kind: 'line' | 'circle' | 'box';

  /** Confidence score [0, 1]. Line always has score 1. */
  score: number;

  /** NEW: Flag indicating near-miss - shape almost passed threshold, don't snap to line */
  ambiguous?: boolean;

  /** Line parameters (when kind === 'line') */
  line?: {
    A: [number, number]; // Start point (first stroke point)
    B: [number, number]; // End point (current pointer position)
  };

  /** Circle parameters (when kind === 'circle') */
  circle?: {
    cx: number; // Center X
    cy: number; // Center Y
    r: number; // Radius
  };

  /** Oriented bounding box parameters (when kind === 'box') */
  box?: {
    cx: number; // Center X
    cy: number; // Center Y
    angle: number; // Rotation angle in radians (always 0 for AABB)
    hx: number; // Half-extent along local X axis
    hy: number; // Half-extent along local Y axis
  };
}

/**
 * Recognizes shapes from an open stroke.
 *
 * This is the main entry point for shape recognition. It attempts to
 * recognize circles and rectangles, falling back to a line if neither
 * shape is confident enough.
 *
 * @param pointsWU - Flat array of stroke points in world units [x,y,x,y,...]
 * @param pointerNowWU - Current pointer position in world units
 * @returns Recognition result with shape type and parameters
 */
export function recognizeOpenStroke({
  pointsWU,
  pointerNowWU,
}: {
  pointsWU: number[];
  pointerNowWU: [number, number];
}): RecognitionResult {
  console.group('🎨 Shape Recognition Pipeline');
  console.log(
    `Stroke points: ${pointsWU.length / 2}, Pointer at: [${pointerNowWU[0].toFixed(1)}, ${pointerNowWU[1].toFixed(1)}]`,
  );

  // =========================================================================
  // Step 1: Convert flat array to Vec2 array for processing
  // =========================================================================
  const points: Vec2[] = [];
  for (let i = 0; i < pointsWU.length; i += 2) {
    if (i + 1 < pointsWU.length) {
      points.push([pointsWU[i], pointsWU[i + 1]]);
    }
  }

  // Need at least 3 points for any meaningful shape recognition
  if (points.length < 3) {
    console.log('⚠️ Too few points (<3), immediate line fallback');
    console.groupEnd();
    const A = points.length > 0 ? points[0] : pointerNowWU;
    return {
      kind: 'line',
      score: 1,
      line: { A: [A[0], A[1]], B: pointerNowWU },
    };
  }

  // Calculate stroke bounds for context
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const [x, y] of points) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  const width = maxX - minX;
  const height = maxY - minY;

  console.log('Stroke characteristics:', {
    pointCount: points.length,
    boundingBox: { width: width.toFixed(1), height: height.toFixed(1) },
    aspectRatio: (width / Math.max(1, height)).toFixed(2),
  });

  // =========================================================================
  // Step 2: Fit and score CIRCLE
  // =========================================================================
  console.log('\n--- CIRCLE ANALYSIS ---');
  const circleFit = fitCircle(points);
  const circleScore = scoreCircle(points, circleFit);

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
  const rdp = simplifyStroke(flat, 'pen'); // Use world-unit tolerance from STROKE_CONFIG
  if (rdp.points.length >= 4) {
    flat = rdp.points; // Use simplified if successful
  }

  // Distance decimation: ensure minimum segment length for stable corner detection
  const minSegWU = Math.max(10, Math.min(18, 0.06 * diag)); // Clamp between 10-18 WU
  const decimated: number[] = [];
  let lastX = flat[0],
    lastY = flat[1];
  decimated.push(lastX, lastY);

  for (let i = 2; i < flat.length; i += 2) {
    const x = flat[i],
      y = flat[i + 1];
    const dx = x - lastX,
      dy = y - lastY;
    if (dx * dx + dy * dy >= minSegWU * minSegWU) {
      decimated.push(x, y);
      lastX = x;
      lastY = y;
    }
  }

  // Always include the last original point to preserve shape
  const lx = flat[flat.length - 2],
    ly = flat[flat.length - 1];
  if (decimated[decimated.length - 2] !== lx || decimated[decimated.length - 1] !== ly) {
    decimated.push(lx, ly);
  }

  // Micro-closure: snap nearly-closed paths so wrap-around corners are detected
  const sx = decimated[0],
    sy = decimated[1];
  const ex = decimated[decimated.length - 2],
    ey = decimated[decimated.length - 1];
  const gap = Math.hypot(ex - sx, ey - sy);
  const closeEps = 0.06 * diag; // ~6% of box diagonal
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

  console.log('🧮 Two-channel preprocessing:', {
    rawPts: rawPts.length,
    rdp: rdp.points.length / 2,
    cleanPts: cleanPts.length,
    minSegWU: +minSegWU.toFixed(2),
    closed,
  });

  // AABB fit uses rawPts (Track-A) for robust fitting
  const aabbFit = fitAABB(rawPts);

  // Corner/edge detection uses cleanPts (Track-B) for jitter-free analysis
  const corners = detectCorners(cleanPts, minSegWU, 45, closed);
  const edges = reconstructRectangleEdges(cleanPts, corners, minSegWU);

  console.log('AABB fit:', {
    center: [aabbFit.cx.toFixed(1), aabbFit.cy.toFixed(1)],
    size: [(aabbFit.maxX - aabbFit.minX).toFixed(1), (aabbFit.maxY - aabbFit.minY).toFixed(1)],
    cornerCount: corners.length,
    edgeCount: edges.length,
  });

  // Score using rawPts for side metrics, but corners/edges from cleanPts
  const boxScore = scoreRectangleAABB(rawPts, aabbFit, edges, corners);

  // =========================================================================
  // Step 4: Determine winner with rectangle tie-breaker
  // =========================================================================
  console.group('\n🏆 Shape Competition');
  console.log(`Circle score: ${circleScore.toFixed(3)}`);
  console.log(`Rectangle (AABB) score: ${boxScore.toFixed(3)}`);

  // Count right-angle corners for tie-breaker
  const rightAngleCorners = corners.filter(
    (c) => Math.abs(c.angle - 90) <= RECT_CORNER_TIE_TOLERANCE_DEG,
  );
  console.log(
    `Right-angle corners (within ±${RECT_CORNER_TIE_TOLERANCE_DEG}°): ${rightAngleCorners.length}`,
  );

  // =========================================================================
  // Step 5: Apply confidence logic with enhanced right-angle rules
  // =========================================================================

  // Count right-angle corners for all decision logic
  const rightAngleCount = rightAngleCorners.length;

  console.log(`Right-angle corners count: ${rightAngleCount}`);

  // Check for too many right angles (>4) - always ambiguous
  if (rightAngleCount > RECT_MAX_RIGHT_ANGLES) {
    console.log(
      `⚠️ TOO MANY right angles (${rightAngleCount} > 4) - AMBIGUOUS to prevent line snap`,
    );
    console.groupEnd();
    console.groupEnd();

    const A = points[0];
    return {
      kind: 'line',
      score: Math.max(circleScore, boxScore),
      ambiguous: true,
      line: { A: [A[0], A[1]], B: pointerNowWU },
    };
  }

  // Case 1: Rectangle tie-breaker - both pass confidence + ≥2 right angles
  if (circleScore >= SHAPE_CONFIDENCE_MIN && boxScore >= SHAPE_CONFIDENCE_MIN) {
    if (rightAngleCount >= 2) {
      console.log(
        `🎯 TIE-BREAKER: Rectangle wins (both pass confidence + ${rightAngleCount} right angles)`,
      );
      console.groupEnd();
      console.groupEnd();

      return {
        kind: 'box',
        score: boxScore,
        box: {
          cx: aabbFit.cx,
          cy: aabbFit.cy,
          angle: 0, // ALWAYS 0 for AABB
          hx: aabbFit.hx,
          hy: aabbFit.hy,
        },
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
  if (
    winner.kind === 'box' &&
    winner.score >= SHAPE_CONFIDENCE_MIN &&
    rightAngleCount < RECT_MIN_RIGHT_ANGLES_FOR_CONFIDENCE
  ) {
    console.log(`⚠️ Rectangle wins but has <2 right angles (${rightAngleCount}) - AMBIGUOUS`);
    console.groupEnd();
    console.groupEnd();

    const A = points[0];
    return {
      kind: 'line',
      score: winner.score,
      ambiguous: true,
      line: { A: [A[0], A[1]], B: pointerNowWU },
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
      line: { A: [A[0], A[1]], B: pointerNowWU },
    };
  }

  // Case 4: Winner passes confidence threshold (and passed ambiguity checks above)
  if (winner.score >= SHAPE_CONFIDENCE_MIN) {
    console.log(
      `✅ RECOGNIZED: ${winner.kind.toUpperCase()} (score ${winner.score.toFixed(3)} >= ${SHAPE_CONFIDENCE_MIN})`,
    );
    console.groupEnd();
    console.groupEnd();

    if (winner.kind === 'circle') {
      return {
        kind: 'circle',
        score: winner.score,
        circle: { cx: circleFit.cx, cy: circleFit.cy, r: circleFit.r },
      };
    } else {
      return {
        kind: 'box',
        score: winner.score,
        box: {
          cx: aabbFit.cx,
          cy: aabbFit.cy,
          angle: 0, // ALWAYS 0 for AABB
          hx: aabbFit.hx,
          hy: aabbFit.hy,
        },
      };
    }
  }

  // Case 5: Near-miss - any shape was close to confidence threshold
  const maxScore = Math.max(circleScore, boxScore);
  const nearMissThreshold = SHAPE_CONFIDENCE_MIN - SHAPE_AMBIGUITY_DELTA;

  if (maxScore >= nearMissThreshold) {
    console.log(
      `🤷 NEAR-MISS: Best score ${maxScore.toFixed(3)} is within ${SHAPE_AMBIGUITY_DELTA} of threshold`,
    );
    console.log(`📝 NO SNAP - User likely intended a shape, continue freehand`);
    console.groupEnd();
    console.groupEnd();

    // Return with ambiguous flag to prevent any snap
    const A = points[0];
    return {
      kind: 'line',
      score: maxScore,
      ambiguous: true, // Signal to DrawingTool: don't snap, continue freehand
      line: { A: [A[0], A[1]], B: pointerNowWU },
    };
  }

  // Case 6: Self-intersection check - prevent line snap for self-intersecting strokes
  if (LINE_SELF_INTERSECT_AMBIGUOUS) {
    // Calculate epsilon tolerance based on diagonal
    const epsWU = Math.max(
      LINE_SELF_INTERSECT_MIN_EPSILON,
      LINE_SELF_INTERSECT_EPSILON_FACTOR * diag,
    );

    // Use the already decimated points from Track-B (jitter-free, minimum segment length)
    // This is the same array we used for corner detection
    if (hasSelfIntersection(decimated, epsWU)) {
      console.log(`🔄 SELF-INTERSECTION detected - AMBIGUOUS to prevent line snap`);
      console.log(`📝 NO SNAP - Stroke crosses itself, continue freehand`);
      console.groupEnd();
      console.groupEnd();

      const A = points[0];
      return {
        kind: 'line',
        score: 1,
        ambiguous: true, // Signal to DrawingTool: don't snap, continue freehand
        line: { A: [A[0], A[1]], B: pointerNowWU },
      };
    }
  }

  // Case 7: Near-closure check - prevent line snap for nearly-closed loops
  if (LINE_NEAR_CLOSURE_AMBIGUOUS && points.length >= 3) {
    // Check if start and end points are very close
    const firstPoint = points[0];
    const lastPoint = points[points.length - 1];
    const closeGapWU = Math.hypot(lastPoint[0] - firstPoint[0], lastPoint[1] - firstPoint[1]);
    const closeGapThreshold = LINE_CLOSE_GAP_RATIO * diag;

    if (closeGapWU <= closeGapThreshold) {
      console.log(`🔁 NEAR-CLOSURE detected - AMBIGUOUS to prevent line snap`);
      console.log(
        `   Gap: ${closeGapWU.toFixed(1)} WU <= ${closeGapThreshold.toFixed(1)} WU (${(LINE_CLOSE_GAP_RATIO * 100).toFixed(0)}% of diagonal)`,
      );
      console.log(`📝 NO SNAP - Stroke nearly closes on itself, continue freehand`);
      console.groupEnd();
      console.groupEnd();

      const A = points[0];
      return {
        kind: 'line',
        score: 1,
        ambiguous: true, // Signal to DrawingTool: don't snap, continue freehand
        line: { A: [A[0], A[1]], B: pointerNowWU },
      };
    }
  }

  // Case 8: Near self-touch check - prevent line snap for strokes that nearly touch themselves
  if (LINE_NEAR_TOUCH_AMBIGUOUS) {
    // Calculate epsilon tolerance based on diagonal
    // Note: We don't have stroke size here, so we use a conservative estimate
    const nearTouchEpsWU = Math.max(
      LINE_NEAR_TOUCH_MIN_EPSILON,
      LINE_NEAR_TOUCH_EPSILON_FACTOR * diag,
    );

    // Use the already decimated points from Track-B
    if (hasNearTouch(decimated, nearTouchEpsWU)) {
      console.log(`👆 NEAR SELF-TOUCH detected - AMBIGUOUS to prevent line snap`);
      console.log(`   Segments come within ${nearTouchEpsWU.toFixed(1)} WU of each other`);
      console.log(`📝 NO SNAP - Stroke nearly touches itself, continue freehand`);
      console.groupEnd();
      console.groupEnd();

      const A = points[0];
      return {
        kind: 'line',
        score: 1,
        ambiguous: true, // Signal to DrawingTool: don't snap, continue freehand
        line: { A: [A[0], A[1]], B: pointerNowWU },
      };
    }
  }

  // Case 9: Clear failure - fallback to line
  console.log(`❌ Score too low: ${maxScore.toFixed(3)} < ${nearMissThreshold.toFixed(3)}`);
  console.log("📏 FALLBACK: LINE (clear failure, user didn't intend a shape)");
  console.groupEnd();
  console.groupEnd();

  const A = points[0];
  return {
    kind: 'line',
    score: 1,
    line: { A: [A[0], A[1]], B: pointerNowWU },
  };
}
