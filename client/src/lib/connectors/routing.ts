/**
 * Connector Routing - Main Entry Point
 *
 * Two-mode routing dispatch:
 * 1. Z-routing for free cursor (simple 3-segment HVH/VHV path)
 * 2. A* Manhattan routing for snapped endpoints (obstacle avoidance)
 *
 * Also provides direction resolution functions for free endpoints.
 *
 * DESIGN PRINCIPLES:
 * - Obstacle elimination, not post-hoc filtering
 * - Grid cells overlapping obstacles are BLOCKED during construction
 * - A* never visits blocked cells (valid by construction)
 * - Generous padding ensures arrows and approach points fit
 *
 * @module lib/connectors/routing
 */

import { computeZRoute, inferDragDirection, type Terminal, type RouteResult } from './routing-zroute';
import { computeAStarRoute } from './routing-astar';
import { computeApproachOffset } from './constants';
import type { Dir, AABB } from './shape-utils';

// Re-export types
export type { RouteResult, Terminal };

// ============================================================================
// DIRECTION RESOLUTION FOR FREE ENDPOINTS
// ============================================================================

/**
 * Minimal interface for target info in direction computation.
 * Avoids needing full Terminal type for internal helpers.
 */
interface TargetInfo {
  position: [number, number];
  outwardDir: Dir;
  shapeBounds: AABB;
}

/**
 * Check if a position is inside the padded region (but outside the shape).
 *
 * A point is "inside padded region" if:
 * - Inside the padded AABB (shape + approachOffset on all sides)
 * - BUT outside the actual shape bounds
 *
 * This is the "corridor" zone where we need special handling.
 */
function isInsidePaddedRegion(
  pos: [number, number],
  shapeBounds: AABB,
  strokeWidth: number
): boolean {
  const offset = computeApproachOffset(strokeWidth);

  // Padded bounds
  const pMinX = shapeBounds.x - offset;
  const pMaxX = shapeBounds.x + shapeBounds.w + offset;
  const pMinY = shapeBounds.y - offset;
  const pMaxY = shapeBounds.y + shapeBounds.h + offset;

  // Shape bounds
  const sMinX = shapeBounds.x;
  const sMaxX = shapeBounds.x + shapeBounds.w;
  const sMinY = shapeBounds.y;
  const sMaxY = shapeBounds.y + shapeBounds.h;

  const insidePadded = pos[0] > pMinX && pos[0] < pMaxX &&
                       pos[1] > pMinY && pos[1] < pMaxY;
  const insideShape = pos[0] > sMinX && pos[0] < sMaxX &&
                      pos[1] > sMinY && pos[1] < sMaxY;

  return insidePadded && !insideShape;
}

/**
 * Compute preferred first direction when starting INSIDE the padded region.
 *
 * Three distinct cases based on relationship between start zone and target side:
 *
 * 1. SAME SIDE: Start in N padding → Snap to N
 *    → Escape away from shape (return N)
 *
 * 2. OPPOSITE SIDE: Start in S padding → Snap to N
 *    → Go E/W toward target's X position (need to wrap around)
 *
 * 3. ADJACENT SIDE: Start in S padding → Snap to W
 *    → Go directly toward target side (return W)
 *    This creates clean L-routes without weird near-corner behavior
 */
function computePreferredFirstDir(
  fromPos: [number, number],
  to: TargetInfo
): Dir {
  const { x, y, w, h } = to.shapeBounds;
  const toPos = to.position;
  const toSide = to.outwardDir;

  // Determine which side(s) of the shape we're on
  const isAboveShape = fromPos[1] < y;
  const isBelowShape = fromPos[1] > y + h;
  const isLeftOfShape = fromPos[0] < x;
  const isRightOfShape = fromPos[0] > x + w;

  // === SAME SIDE ===
  const isSameSide =
    (toSide === 'N' && isAboveShape) ||
    (toSide === 'S' && isBelowShape) ||
    (toSide === 'E' && isRightOfShape) ||
    (toSide === 'W' && isLeftOfShape);

  if (isSameSide) {
    return toSide; // Escape in outward direction
  }

  // === OPPOSITE SIDE ===
  const isOppositeSide =
    (toSide === 'N' && isBelowShape) ||
    (toSide === 'S' && isAboveShape) ||
    (toSide === 'E' && isLeftOfShape) ||
    (toSide === 'W' && isRightOfShape);

  if (isOppositeSide) {
    if (toSide === 'N' || toSide === 'S') {
      // Vertical target - decide E/W based on target X
      return fromPos[0] < toPos[0] ? 'E' : 'W';
    } else {
      // Horizontal target - decide N/S based on target Y
      return fromPos[1] < toPos[1] ? 'S' : 'N';
    }
  }

  // === ADJACENT SIDE ===
  return toSide;
}

/**
 * Compute escape direction when starting in a "sliver zone".
 *
 * A sliver zone is when we're within the padded range on at least one axis
 * while being outside the shape.
 */
function computeSliverZoneEscape(
  fx: number,
  fy: number,
  shapeBounds: AABB,
  offset: number,
  anchorDir: Dir
): Dir | null {
  const { x, y, w, h } = shapeBounds;

  // Position relative to shape (no padding)
  const startLeftOf = fx < x;
  const startRightOf = fx > x + w;
  const startAbove = fy < y;
  const startBelow = fy > y + h;

  // Padded range checks
  const withinPaddedX = fx >= (x - offset) && fx <= (x + w + offset);
  const withinPaddedY = fy >= (y - offset) && fy <= (y + h + offset);

  // If outside BOTH padded ranges, we're in free space - no escape needed
  if (!withinPaddedX && !withinPaddedY) return null;

  // For corner positions, prioritize based on anchor axis
  const anchorIsHorizontal = anchorDir === 'E' || anchorDir === 'W';

  if (anchorIsHorizontal) {
    // Horizontal anchor: prioritize horizontal escape (W/E)
    if (startLeftOf && withinPaddedY) return 'W';
    if (startRightOf && withinPaddedY) return 'E';
    if (startAbove && withinPaddedX) return 'N';
    if (startBelow && withinPaddedX) return 'S';
  } else {
    // Vertical anchor: prioritize vertical escape (N/S)
    if (startAbove && withinPaddedX) return 'N';
    if (startBelow && withinPaddedX) return 'S';
    if (startLeftOf && withinPaddedY) return 'W';
    if (startRightOf && withinPaddedY) return 'E';
  }

  return null;
}

/**
 * Compute start direction for FREE endpoints.
 *
 * Uses spatial relationship between start position and target shape,
 * NOT cursor drag direction.
 *
 * Three cases:
 * 1. SAME SIDE (head-on): Z-route if primary axis matches anchor axis, else L-route
 * 2. ADJACENT SIDES: Go directly toward anchor (L-route)
 * 3. OPPOSITE SIDES (contained): Wrap around via shortest path
 */
function computeFreeStartDirection(
  fromPos: [number, number],
  to: TargetInfo,
  strokeWidth: number
): Dir {
  const { x, y, w, h } = to.shapeBounds;
  const [fx, fy] = fromPos;
  const [tx, ty] = to.position;
  const offset = computeApproachOffset(strokeWidth);

  // Compute primary axis from start→snap (NOT cursor)
  const dx = tx - fx;
  const dy = ty - fy;
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  const primaryAxis: 'H' | 'V' = ax >= ay ? 'H' : 'V';

  // Position checks (NO padding for spatial relation)
  const startLeftOf = fx < x;
  const startRightOf = fx > x + w;
  const startAbove = fy < y;
  const startBelow = fy > y + h;

  // Containment check (WITH padding - for wrap-around detection)
  const withinPaddedX = fx >= (x - offset) && fx <= (x + w + offset);
  const withinPaddedY = fy >= (y - offset) && fy <= (y + h + offset);
  const containedInPaddedBounds = withinPaddedX && withinPaddedY;

  const anchorDir = to.outwardDir;

  // === SAME SIDE (Z-route possible) ===
  const isSameSide =
    (anchorDir === 'W' && startLeftOf) ||
    (anchorDir === 'E' && startRightOf) ||
    (anchorDir === 'N' && startAbove) ||
    (anchorDir === 'S' && startBelow);

  if (isSameSide) {
    const anchorOnHorizontal = anchorDir === 'E' || anchorDir === 'W';
    // Z-route ONLY valid when primary axis matches anchor axis
    const zRouteValid = (anchorOnHorizontal && primaryAxis === 'H') ||
                        (!anchorOnHorizontal && primaryAxis === 'V');

    if (zRouteValid) {
      // Z-route: go toward snap point on primary axis
      return anchorOnHorizontal ? (dx >= 0 ? 'E' : 'W') : (dy >= 0 ? 'S' : 'N');
    } else {
      // L-route: check for sliver escape first
      const sliverEscape = computeSliverZoneEscape(fx, fy, to.shapeBounds, offset, anchorDir);
      if (sliverEscape) return sliverEscape;
      // Otherwise normal L-route: go on perpendicular axis first
      return primaryAxis === 'V' ? (dy >= 0 ? 'S' : 'N') : (dx >= 0 ? 'E' : 'W');
    }
  }

  // === OPPOSITE SIDE (wrap around required) ===
  const isOppositeSide =
    (anchorDir === 'E' && startLeftOf) ||   // anchor right, start left
    (anchorDir === 'W' && startRightOf) ||  // anchor left, start right
    (anchorDir === 'N' && startBelow) ||    // anchor top, start below
    (anchorDir === 'S' && startAbove);      // anchor bottom, start above

  if (isOppositeSide && containedInPaddedBounds) {
    // Must wrap around - pick shortest path
    if (anchorDir === 'E' || anchorDir === 'W') {
      // Horizontal anchor: go N or S based on start position relative to shape center
      const shapeCenterY = y + h / 2;
      return fy < shapeCenterY ? 'N' : 'S';
    } else {
      // Vertical anchor: go E or W based on start position relative to shape center
      const shapeCenterX = x + w / 2;
      return fx < shapeCenterX ? 'W' : 'E';
    }
  }

  // === ADJACENT SIDES (L-route directly toward anchor) ===
  // Check for sliver escape first - if in padding corridor, escape outward
  const sliverEscape = computeSliverZoneEscape(fx, fy, to.shapeBounds, offset, anchorDir);
  if (sliverEscape) return sliverEscape;
  return anchorDir;
}

// ============================================================================
// PUBLIC DIRECTION RESOLUTION FUNCTIONS
// ============================================================================

/**
 * Resolve start direction for FREE→ANCHORED cases.
 *
 * Computes direction from spatial relationship, NOT cursor drag.
 * Must be called BEFORE routing when from.isAnchored=false, to.isAnchored=true.
 *
 * @param fromPos - Start position (free endpoint)
 * @param toTerminal - Target info with position, outwardDir, and shapeBounds
 * @param strokeWidth - Connector stroke width
 * @returns Direction for from.outwardDir
 */
export function resolveFreeStartDir(
  fromPos: [number, number],
  toTerminal: { position: [number, number]; outwardDir: Dir; shapeBounds: AABB },
  strokeWidth: number
): Dir {
  const startInsidePadding = isInsidePaddedRegion(fromPos, toTerminal.shapeBounds, strokeWidth);

  if (startInsidePadding) {
    return computePreferredFirstDir(fromPos, toTerminal);
  } else {
    return computeFreeStartDirection(fromPos, toTerminal, strokeWidth);
  }
}

/**
 * Compute end direction for ANCHORED→FREE cases.
 *
 * Uses primary axis + sign from anchor position to free endpoint.
 * No hysteresis (unlike inferDragDirection).
 *
 * @param fromPos - Anchored snap position
 * @param toPos - Free cursor position
 * @returns Direction for to.outwardDir
 */
export function computeFreeEndDir(
  fromPos: [number, number],
  toPos: [number, number]
): Dir {
  const dx = toPos[0] - fromPos[0];
  const dy = toPos[1] - fromPos[1];
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  const axis = ax >= ay ? 'H' : 'V';
  return axis === 'H' ? (dx >= 0 ? 'E' : 'W') : (dy >= 0 ? 'S' : 'N');
}

// ============================================================================
// MAIN ROUTING DISPATCH
// ============================================================================

/**
 * Compute route between two terminals.
 *
 * Dispatches to appropriate routing algorithm:
 * - Z-routing when endpoint is free (not snapped to shape)
 * - A* routing when endpoint is snapped (needs obstacle avoidance)
 *
 * @param from - Start terminal
 * @param to - End terminal
 * @param _prevSignature - Previous route signature (unused in new implementation)
 * @param strokeWidth - Connector stroke width (affects routing offsets)
 * @returns Route result with path and signature
 */
export function computeRoute(
  from: Terminal,
  to: Terminal,
  _prevSignature: string | null,
  strokeWidth: number
): RouteResult {
  // Two-mode routing dispatch
  if (!to.isAnchored && !from.isAnchored) {
    // Free cursor - use simple Z-routing (no obstacle avoidance needed)
    return computeZRoute(from, to, strokeWidth);
  } else {
    // Snapped to shape - use A* Manhattan routing (obstacle avoidance)
    return computeAStarRoute(from, to, strokeWidth);
  }
}

// Re-export inferDragDirection for ConnectorTool
export { inferDragDirection };
