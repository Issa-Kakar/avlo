/**
 * Z-Routing for Unsnapped Endpoints
 *
 * Simple 3-segment routing (HVH or VHV) used when the endpoint cursor
 * is NOT snapped to a shape. No obstacle avoidance - just clean paths.
 *
 * Z-routes are chosen based on the source terminal's outward direction:
 * - Horizontal exit (E/W) → HVH (horizontal-vertical-horizontal)
 * - Vertical exit (N/S) → VHV (vertical-horizontal-vertical)
 *
 * @module lib/connectors/routing-zroute
 */

import { computeJettyOffset } from './constants';
import { getOutwardVector, isHorizontal, type Dir } from './shape-utils';
import { simplifyOrthogonal } from './routing';

/**
 * Terminal describes an endpoint for routing.
 *
 * This is THE canonical endpoint type for all routing operations.
 * Use `isAnchored` instead of `kind: 'world'|'shape'`.
 */
export interface Terminal {
  position: [number, number];
  /**
   * Direction the jetty extends from this point.
   * For shape-attached: same as the side we're on (away from shape).
   * For free: direction toward other endpoint.
   */
  outwardDir: Dir;
  /** True if snapped to a shape edge */
  isAnchored: boolean;
  /** True if this endpoint has an arrow cap (affects offset) */
  hasCap: boolean;
  /** Shape bounds for obstacle blocking (when isAnchored=true) */
  shapeBounds?: { x: number; y: number; w: number; h: number };
  /** Edge position parameter for sliding hysteresis (0-1) */
  t?: number;
}

/**
 * Route result with full path and signature.
 */
export interface RouteResult {
  points: [number, number][];
  signature: string;
}

/**
 * Compute approach point (stub extending from terminal).
 *
 * Cap-aware: anchored endpoints with arrow caps get full offset,
 * unsnapped endpoints get no offset (they're free-floating).
 *
 * @param terminal - The terminal to compute approach point for
 * @param strokeWidth - Connector stroke width
 * @returns Approach point position
 */
function computeApproachPoint(terminal: Terminal, strokeWidth: number): [number, number] {
  const offset = computeJettyOffset(terminal.isAnchored, terminal.hasCap, strokeWidth);

  if (offset === 0) {
    return terminal.position;
  }

  const vec = getOutwardVector(terminal.outwardDir);
  return [
    terminal.position[0] + vec[0] * offset,
    terminal.position[1] + vec[1] * offset,
  ];
}

/**
 * Compute simple Z-route for unsnapped endpoints.
 *
 * Used when to.isAnchored === false (cursor not snapped to shape).
 * Generates a clean 3-segment path without obstacle avoidance.
 *
 * Cap-aware offset computation uses terminal.hasCap directly.
 *
 * @param from - Start terminal
 * @param to - End terminal (must be unsnapped)
 * @param strokeWidth - Connector stroke width (affects offset)
 * @returns Route result with path and signature
 */
export function computeZRoute(from: Terminal, to: Terminal, strokeWidth: number): RouteResult {
  const fromApproach = computeApproachPoint(from, strokeWidth);
  const toApproach = computeApproachPoint(to, strokeWidth);

  // Determine HVH vs VHV based on from.outwardDir
  const isFromHorizontal = isHorizontal(from.outwardDir);

  let midPoints: [number, number][];
  let signature: string;

  if (isFromHorizontal) {
    // HVH: horizontal from approach, vertical middle, horizontal to approach
    const midX = (fromApproach[0] + toApproach[0]) / 2;
    midPoints = [
      [midX, fromApproach[1]],
      [midX, toApproach[1]],
    ];
    signature = 'HVH';
  } else {
    // VHV: vertical from approach, horizontal middle, vertical to approach
    const midY = (fromApproach[1] + toApproach[1]) / 2;
    midPoints = [
      [fromApproach[0], midY],
      [toApproach[0], midY],
    ];
    signature = 'VHV';
  }

  const fullPath: [number, number][] = [
    from.position,
    fromApproach,
    ...midPoints,
    toApproach,
    to.position,
  ];

  return {
    points: simplifyOrthogonal(fullPath),
    signature,
  };
}

/**
 * Infer drag direction for free endpoint.
 * Uses hysteresis to prevent jitter when cursor moves near axis boundaries.
 *
 * @param from - Start position
 * @param cursor - Current cursor position
 * @param prevDir - Previous direction (for hysteresis)
 * @param hysteresisRatio - Ratio required to switch axis (default 1.2)
 * @returns Inferred direction
 */
export function inferDragDirection(
  from: [number, number],
  cursor: [number, number],
  prevDir: Dir | null,
  hysteresisRatio: number = 1.04
): Dir {
  const dx = cursor[0] - from[0];
  const dy = cursor[1] - from[1];
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);

  // Determine dominant axis
  let axis: 'H' | 'V';
  if (!prevDir) {
    axis = ax >= ay ? 'H' : 'V';
  } else {
    const prevH = isHorizontal(prevDir);
    axis = prevH ? 'H' : 'V';

    // Check if we should switch (requires winning by hysteresis margin)
    if (prevH && ay > ax * hysteresisRatio) {
      axis = 'V';
    } else if (!prevH && ax > ay * hysteresisRatio) {
      axis = 'H';
    }
  }

  // Return direction based on axis and sign
  if (axis === 'H') {
    return dx >= 0 ? 'E' : 'W';
  } else {
    return dy >= 0 ? 'S' : 'N';
  }
}
