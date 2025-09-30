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
    // Immediate fallback to line for very short strokes
    const A = points.length > 0 ? points[0] : pointerNowWU;
    return {
      kind: 'line',
      score: 1,
      line: { A: [A[0], A[1]], B: pointerNowWU }
    };
  }

  // =========================================================================
  // Step 2: Fit and score CIRCLE
  // =========================================================================
  const circleFit = fitCircle(points);
  const circleScore = scoreCircle(points, circleFit);

  // =========================================================================
  // Step 3: Fit and score RECTANGLE
  // =========================================================================
  const boxFit = fitOBB(points);
  const { edges, corners } = detectEdgesAndCorners(points);
  const boxScore = scoreRectangle(points, boxFit, edges, corners);
  console.log('Circle Score', circleScore);
  console.log('Box Score', boxScore);
  console.log('Circle Fit', circleFit);
  console.log('Box Fit', boxFit);
  // =========================================================================
  // Step 4: Determine winner between circle and rectangle
  // No tie-breaking needed - just pick higher score
  // =========================================================================
  let winner: { kind: 'circle' | 'box'; score: number; data: any };

  if (boxScore >= circleScore) {
    winner = {
      kind: 'box',
      score: boxScore,
      data: boxFit
    };
  } else {
    winner = {
      kind: 'circle',
      score: circleScore,
      data: circleFit
    };
  }

  // =========================================================================
  // Step 5: Check if winner meets confidence threshold
  // =========================================================================
  if (winner.score >= SHAPE_CONFIDENCE_MIN) {
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
  // No straightness check, no scoring - just first point to current pointer
  // =========================================================================
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