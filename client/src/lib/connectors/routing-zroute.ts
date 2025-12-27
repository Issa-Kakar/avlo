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

import { computeApproachOffset } from './constants';
import { getOutwardVector, isHorizontal, type Dir } from './shape-utils';

/**
 * Terminal describes an endpoint for routing.
 */
export interface Terminal {
  kind: 'world' | 'shape';
  position: [number, number];
  /**
   * Direction the jetty extends from this point.
   * For shape-attached: same as the side we're on.
   * For free: direction toward other endpoint.
   */
  outwardDir: Dir;
  shapeId?: string;
  shapeSide?: Dir;
  shapeT?: number;
  shapeBounds?: { x: number; y: number; w: number; h: number };
}

/**
 * Route result with full path and signature.
 */
export interface RouteResult {
  points: [number, number][];
  signature: string;
}

/**
 * Compute jetty point (stub extending from terminal).
 *
 * The jetty offset depends on strokeWidth because it must accommodate:
 * 1. Arc corner (for perpendicular turns)
 * 2. Straight segment (for stroke to straighten)
 * 3. Arrow head
 *
 * @param terminal - The terminal to compute jetty for
 * @param strokeWidth - Connector stroke width
 * @returns Jetty point position
 */
function computeJettyPoint(terminal: Terminal, strokeWidth: number): [number, number] {
  const vec = getOutwardVector(terminal.outwardDir);
  const offset = computeApproachOffset(strokeWidth);
  return [
    terminal.position[0] + vec[0] * offset,
    terminal.position[1] + vec[1] * offset,
  ];
}

/**
 * Remove collinear points from orthogonal path.
 *
 * @param points - Input path
 * @returns Simplified path without collinear intermediate points
 */
function simplifyOrthogonal(points: [number, number][]): [number, number][] {
  if (points.length < 3) return points;

  const result: [number, number][] = [points[0]];

  for (let i = 1; i < points.length - 1; i++) {
    const prev = result[result.length - 1];
    const curr = points[i];
    const next = points[i + 1];

    // Check if collinear (all on same horizontal or vertical line)
    const sameX = Math.abs(prev[0] - curr[0]) < 0.001 && Math.abs(curr[0] - next[0]) < 0.001;
    const sameY = Math.abs(prev[1] - curr[1]) < 0.001 && Math.abs(curr[1] - next[1]) < 0.001;

    if (!sameX && !sameY) {
      result.push(curr);
    }
  }

  result.push(points[points.length - 1]);
  return result;
}

/**
 * Compute simple Z-route for unsnapped endpoints.
 *
 * Used when to.kind === 'world' (cursor not snapped to shape).
 * Generates a clean 3-segment path without obstacle avoidance.
 *
 * @param from - Start terminal
 * @param to - End terminal (must be unsnapped)
 * @param strokeWidth - Connector stroke width (affects jetty offset)
 * @returns Route result with path and signature
 */
export function computeZRoute(from: Terminal, to: Terminal, strokeWidth: number): RouteResult {
  const fromJetty = computeJettyPoint(from, strokeWidth);
  const toJetty = computeJettyPoint(to, strokeWidth);

  // Determine HVH vs VHV based on from.outwardDir
  const isFromHorizontal = isHorizontal(from.outwardDir);

  let midPoints: [number, number][];
  let signature: string;

  if (isFromHorizontal) {
    // HVH: horizontal from jetty, vertical middle, horizontal to jetty
    const midX = (fromJetty[0] + toJetty[0]) / 2;
    midPoints = [
      [midX, fromJetty[1]],
      [midX, toJetty[1]],
    ];
    signature = 'HVH';
  } else {
    // VHV: vertical from jetty, horizontal middle, vertical to jetty
    const midY = (fromJetty[1] + toJetty[1]) / 2;
    midPoints = [
      [fromJetty[0], midY],
      [toJetty[0], midY],
    ];
    signature = 'VHV';
  }

  const fullPath: [number, number][] = [
    from.position,
    fromJetty,
    ...midPoints,
    toJetty,
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
  hysteresisRatio: number = 1.2
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
