/**
 * $P/$Q recognizer tuning constants — byte-identical to the previous
 * `pdollar-recognizer.ts` PDOLLAR_CONFIG. Do not change without re-running
 * the full smoke gesture suite.
 */

import type { PerfectShapeKind } from './types';

export const PDOLLAR_CONFIG = {
  NUM_POINTS: 32,
  MIN_MARGIN: 0.1,
  CLOSE_EPS_RATIO: 0.12,
  EPSILON: 0.5,
  MIN_INPUT_POINTS: 6,
  // Shape-specific distance thresholds (lower = stricter)
  MAX_DISTANCE_BOX: 3.5,
  MAX_DISTANCE_DIAMOND: 4.5,
  MAX_DISTANCE_CIRCLE: 6,
  MAX_DISTANCE_LINE: 3.0,
  // Hybrid validation gates (box/diamond)
  MIN_TURN_ANGLE_DEG: 40,
  MIN_TURNS_BOX: 3,
  MIN_TURNS_BOX_RELAXED_THRESHOLD: 2,
  MIN_TURNS_DIAMOND: 2,
  MIN_TURNS_DIAMOND_RELAXED_THRESHOLD: 3,
  MAX_TURNS: 8,
  MIN_QUADRANT_OCCUPATION: 0.75,
  // Self-intersection / near-touch (raw points)
  SELF_INTERSECT_EPS_FACTOR: 0.02,
  NEAR_TOUCH_EPS_FACTOR: 0.015,
  MIN_EPS_WU: 1.5,
} as const;

/**
 * Fixed aspect ratios for template generation. Log-spaced (~25% visual step).
 * The key insight from $P: fixed ratios force the recognizer to discriminate
 * on geometry, not on whether the input "looks like itself."
 */
export const TEMPLATE_RATIOS = {
  /** Box: square → very elongated, both wide and tall. */
  box: [1.0, 1.25, 1.6, 2.0, 2.5, 3.2, 4.0, 5.0, 6.3, 8.0, 10.0, 12.5, 0.8, 0.625, 0.5, 0.4, 0.3125, 0.25, 0.2, 0.159, 0.125, 0.1, 0.08],
  /** Diamond: capped at 3:1 to avoid line-like degeneracy. */
  diamond: [1.0, 1.25, 1.6, 2.0, 2.5, 3.0, 0.8, 0.625, 0.5, 0.4, 0.333],
  /** Circle: only 1:1 makes geometric sense. */
  circle: [1.0],
  /** Line: H/V/diagonal angles. */
  line: [25.0, 2.0, 1.0, 0.5, 0.04],
} as const;

/** Per-kind max distance — replaces if/else dispatch in recognize.ts. */
export const SHAPE_MAX_DISTANCE: Record<PerfectShapeKind, number> = {
  circle: PDOLLAR_CONFIG.MAX_DISTANCE_CIRCLE,
  box: PDOLLAR_CONFIG.MAX_DISTANCE_BOX,
  diamond: PDOLLAR_CONFIG.MAX_DISTANCE_DIAMOND,
  line: PDOLLAR_CONFIG.MAX_DISTANCE_LINE,
};

/** Kind → numeric encoding for packed `Uint8Array`. Order is the public ABI. */
export const KIND_FOR_CODE: readonly PerfectShapeKind[] = ['circle', 'box', 'diamond', 'line'];
export const CIRCLE = 0;
export const BOX = 1;
export const DIAMOND = 2;
export const LINE = 3;
