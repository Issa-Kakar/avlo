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
import { SHAPE_CONFIDENCE_MIN } from './shape-params';
import { fitCircle } from './fit-circle';
import { fitOBB } from './fit-obb';
import { detectEdgesAndCorners } from './geometry-helpers';
import { scoreCircle, scoreRectangle } from './score';
import { simplifyStroke } from '../tools/simplification';

/**
 * Result of shape recognition
 */
export interface RecognitionResult {
  /** The recognized shape type */
  kind: 'line' | 'circle' | 'box';

  /** Confidence score [0, 1]. Line always has score 1. */
  score: number;

  /** Line parameters (when kind === 'line') */
  line?: {
    A: [number, number];  // Start point (first stroke point)
    B: [number, number];  // End point (current pointer position)
  };

  /** Circle parameters (when kind === 'circle') */
  circle?: {
    cx: number;           // Center X
    cy: number;           // Center Y
    r: number;            // Radius
  };

  /** Oriented bounding box parameters (when kind === 'box') */
  box?: {
    cx: number;           // Center X
    cy: number;           // Center Y
    angle: number;        // Rotation angle in radians
    hx: number;           // Half-extent along local X axis
    hy: number;           // Half-extent along local Y axis
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
  pointerNowWU
}: {
  pointsWU: number[];
  pointerNowWU: [number, number];
}): RecognitionResult {
  console.group('🎨 Shape Recognition Pipeline');
  console.log(`Stroke points: ${pointsWU.length / 2}, Pointer at: [${pointerNowWU[0].toFixed(1)}, ${pointerNowWU[1].toFixed(1)}]`);

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
      line: { A: [A[0], A[1]], B: pointerNowWU }
    };
  }

  // Calculate stroke bounds for context
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
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
    aspectRatio: (width / Math.max(1, height)).toFixed(2)
  });

  // =========================================================================
  // Step 2: Fit and score CIRCLE
  // =========================================================================
  console.log('\n--- CIRCLE ANALYSIS ---');
  const circleFit = fitCircle(points);
  const circleScore = scoreCircle(points, circleFit);

  // =========================================================================
  // Step 3: Fit and score RECTANGLE
  // =========================================================================
  console.log('\n--- RECTANGLE ANALYSIS ---');

  // Rectangle analysis needs simplified points to detect clean corners
  // Create a COPY and simplify it (never mutate preview points)
  let rectFlat = pointsWU.slice(); // Copy the flat array

  // Step 1: RDP simplification (removes tiny wiggles, stabilizes OBB)
  const rdp = simplifyStroke(rectFlat, 'pen'); // Use world-unit tolerance from STROKE_CONFIG
  if (rdp.points.length >= 4) {
    rectFlat = rdp.points; // Use simplified if successful
  }

  // Step 2: Distance decimation - ensure neighbor segments are long enough for corner gate
  // This guarantees consecutive points are at least 10 WU apart (corner detector's threshold)
  const diag = Math.hypot(width, height);
  const minSegWU = Math.max(10, Math.min(18, 0.08 * diag)); // ≥10WU, scale with size a bit

  const decimated: number[] = [];
  let lastX = rectFlat[0], lastY = rectFlat[1];
  decimated.push(lastX, lastY);

  for (let i = 2; i < rectFlat.length; i += 2) {
    const x = rectFlat[i], y = rectFlat[i + 1];
    const dx = x - lastX, dy = y - lastY;
    if (dx * dx + dy * dy >= minSegWU * minSegWU) {
      decimated.push(x, y);
      lastX = x;
      lastY = y;
    }
  }

  // Always include the last original point (preserves OBB and coverage)
  const lx = rectFlat[rectFlat.length - 2], ly = rectFlat[rectFlat.length - 1];
  if (decimated[decimated.length - 2] !== lx || decimated[decimated.length - 1] !== ly) {
    decimated.push(lx, ly);
  }

  // Step 3: Micro-closure - recover the 4th corner if nearly closed
  const sx = decimated[0], sy = decimated[1];
  const ex = decimated[decimated.length - 2], ey = decimated[decimated.length - 1];
  const gap = Math.hypot(ex - sx, ey - sy);
  const closeEps = 0.06 * diag; // ~6% of box diagonal
  if (gap <= closeEps) {
    decimated.push(sx, sy);
  }

  // Convert to Vec2 for geometry helpers
  const rectPoints: Vec2[] = [];
  for (let i = 0; i < decimated.length; i += 2) {
    if (i + 1 < decimated.length) {
      rectPoints.push([decimated[i], decimated[i + 1]]);
    }
  }

  // Debug output to verify the preprocessing
  console.log('🧮 Rect prep', {
    orig: pointsWU.length / 2,
    rdp: rdp.points.length / 2,
    decimated: decimated.length / 2,
    minSegWU: +minSegWU.toFixed(2),
    closed: gap <= closeEps
  });

  // Now use cleaned points for rectangle analysis
  const boxFit = fitOBB(rectPoints);
  const { edges, corners } = detectEdgesAndCorners(rectPoints);
  const boxScore = scoreRectangle(rectPoints, boxFit, edges, corners);

  // =========================================================================
  // Step 4: Determine winner between circle and rectangle
  // =========================================================================
  console.group('\n🏆 Shape Competition');
  console.log(`Circle score: ${circleScore.toFixed(3)}`);
  console.log(`Rectangle score: ${boxScore.toFixed(3)}`);

  let winner: { kind: 'circle' | 'box'; score: number; data: any };

  if (boxScore >= circleScore) {
    winner = {
      kind: 'box',
      score: boxScore,
      data: boxFit
    };
    console.log(`Winner: RECTANGLE (${boxScore.toFixed(3)} >= ${circleScore.toFixed(3)})`);
  } else {
    winner = {
      kind: 'circle',
      score: circleScore,
      data: circleFit
    };
    console.log(`Winner: CIRCLE (${circleScore.toFixed(3)} > ${boxScore.toFixed(3)})`);
  }

  // =========================================================================
  // Step 5: Check if winner meets confidence threshold
  // =========================================================================
  console.log(`\nConfidence check: ${winner.score.toFixed(3)} vs threshold ${SHAPE_CONFIDENCE_MIN}`);

  if (winner.score >= SHAPE_CONFIDENCE_MIN) {
    console.log(`✅ RECOGNIZED: ${winner.kind.toUpperCase()} (score ${winner.score.toFixed(3)} >= ${SHAPE_CONFIDENCE_MIN})`);
    console.groupEnd(); // Close Shape Competition
    console.groupEnd(); // Close Recognition Pipeline

    // Winner is confident enough - return recognized shape
    if (winner.kind === 'circle') {
      return {
        kind: 'circle',
        score: winner.score,
        circle: {
          cx: circleFit.cx,
          cy: circleFit.cy,
          r: circleFit.r
        }
      };
    } else {
      return {
        kind: 'box',
        score: winner.score,
        box: {
          cx: boxFit.cx,
          cy: boxFit.cy,
          angle: boxFit.angle,
          hx: boxFit.hx,
          hy: boxFit.hy
        }
      };
    }
  }

  // =========================================================================
  // Step 6: Strict fallback to LINE
  // =========================================================================
  console.log(`❌ Score too low: ${winner.score.toFixed(3)} < ${SHAPE_CONFIDENCE_MIN}`);
  console.log('📏 FALLBACK: LINE (no straightness check)');
  console.groupEnd(); // Close Shape Competition
  console.groupEnd(); // Close Recognition Pipeline

  const A = points[0];
  return {
    kind: 'line',
    score: 1,  // Line always has perfect score (it's a fallback, not scored)
    line: {
      A: [A[0], A[1]],
      B: pointerNowWU
    }
  };
}