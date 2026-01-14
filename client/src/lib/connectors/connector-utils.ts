/**
 * Connector Utilities
 *
 * Provides:
 * - Shape frame extraction and midpoint calculation
 * - Direction helpers (isHorizontal, isVertical, oppositeDir)
 * - Bounds conversion utilities
 * - Direction resolution for free endpoints
 * - Path simplification utilities
 *
 * @module lib/connectors/connector-utils
 */

import type { ObjectHandle } from '@avlo/shared';
import type { Dir, ShapeFrame, AABB, Bounds } from './types';
import { computeApproachOffset } from './constants';

/**
 * Extract frame from shape handle.
 * Works with 'shape' and 'text' object kinds.
 *
 * @param handle - Object handle from snapshot
 * @returns ShapeFrame or null if not a shape/text or no frame
 */
export function getShapeFrame(handle: ObjectHandle): ShapeFrame | null {
  if (handle.kind !== 'shape' && handle.kind !== 'text') return null;
  const frame = handle.y.get('frame') as [number, number, number, number] | undefined;
  if (!frame) return null;
  return { x: frame[0], y: frame[1], w: frame[2], h: frame[3] };
}

/**
 * Get midpoint positions for all 4 edges.
 * For all shape types (rect, ellipse, diamond), midpoints are at frame edge centers.
 *
 * @param frame - Shape frame
 * @returns Record mapping each direction to its midpoint [x, y]
 */
export function getMidpoints(frame: ShapeFrame): Record<Dir, [number, number]> {
  return {
    N: [frame.x + frame.w / 2, frame.y],
    E: [frame.x + frame.w, frame.y + frame.h / 2],
    S: [frame.x + frame.w / 2, frame.y + frame.h],
    W: [frame.x, frame.y + frame.h / 2],
  };
}

/**
 * Get position along edge for given t (0-1).
 *
 * @param frame - Shape frame
 * @param side - Which edge (N/E/S/W)
 * @param t - Position along edge (0 = start, 0.5 = midpoint, 1 = end)
 * @returns World coordinates [x, y]
 */
export function getEdgePosition(frame: ShapeFrame, side: Dir, t: number): [number, number] {
  const clampedT = Math.max(0, Math.min(1, t));
  switch (side) {
    case 'N':
      return [frame.x + frame.w * clampedT, frame.y];
    case 'S':
      return [frame.x + frame.w * clampedT, frame.y + frame.h];
    case 'W':
      return [frame.x, frame.y + frame.h * clampedT];
    case 'E':
      return [frame.x + frame.w, frame.y + frame.h * clampedT];
  }
}

/**
 * Get opposite direction.
 *
 * @param dir - Input direction
 * @returns Opposite direction
 */
export function oppositeDir(dir: Dir): Dir {
  const map: Record<Dir, Dir> = { N: 'S', S: 'N', E: 'W', W: 'E' };
  return map[dir];
}

/**
 * Check if a direction is horizontal (E or W).
 *
 * @param dir - Direction to check
 * @returns true if horizontal
 */
export function isHorizontal(dir: Dir): boolean {
  return dir === 'E' || dir === 'W';
}

/**
 * Check if a direction is vertical (N or S).
 *
 * @param dir - Direction to check
 * @returns true if vertical
 */
export function isVertical(dir: Dir): boolean {
  return dir === 'N' || dir === 'S';
}

// ============================================================================
// EDGE-BASED BOUNDS HELPERS
// ============================================================================

/**
 * Convert AABB {x,y,w,h} to edge-based Bounds.
 *
 * @param aabb - Shape bounds in x,y,w,h format
 * @returns Edge-based bounds
 */
export function toBounds(aabb: AABB): Bounds {
  return {
    left: aabb.x,
    top: aabb.y,
    right: aabb.x + aabb.w,
    bottom: aabb.y + aabb.h,
  };
}

/**
 * Create point-bounds where all edges converge to a single point.
 * Used for free (non-anchored) endpoints in routing context.
 *
 * @param pos - World position [x, y]
 * @returns Bounds collapsed to a point
 */
export function pointBounds(pos: [number, number]): Bounds {
  return {
    left: pos[0],
    top: pos[1],
    right: pos[0],
    bottom: pos[1],
  };
}

/**
 * Check if bounds is a point (all sides equal).
 * Point-bounds don't get padding applied - they stay at their position.
 *
 * @param b - Bounds to check
 * @returns true if all edges converge to a point
 */
export function isPointBounds(b: Bounds): boolean {
  return b.left === b.right && b.top === b.bottom;
}

// ============================================================================
// SEGMENT-AABB INTERSECTION
// ============================================================================

/**
 * Check if a line segment intersects the strict interior of an AABB.
 *
 * Uses the slab method (parametric intersection). Unlike a midpoint-only
 * check, this handles:
 * - Thin shapes that midpoint could miss
 * - Any segment orientation (though we use H/V only)
 * - Works correctly with raw shape bounds (no stroke inflation needed)
 *
 * @param x1, y1 - Segment start
 * @param x2, y2 - Segment end
 * @param aabb - Axis-aligned bounding box (raw shape bounds)
 * @returns true if segment passes through AABB interior
 */
export function segmentIntersectsAABB(
  x1: number, y1: number,
  x2: number, y2: number,
  aabb: AABB
): boolean {
  const { x, y, w, h } = aabb;
  const minX = x;
  const maxX = x + w;
  const minY = y;
  const maxY = y + h;

  // Direction vector
  const dx = x2 - x1;
  const dy = y2 - y1;

  // Parametric bounds
  let tMin = 0;
  let tMax = 1;

  // Check X slab
  if (dx === 0) {
    // Vertical line - check if X is strictly inside
    if (x1 <= minX || x1 >= maxX) return false;
  } else {
    const t1 = (minX - x1) / dx;
    const t2 = (maxX - x1) / dx;
    const tEnter = Math.min(t1, t2);
    const tExit = Math.max(t1, t2);
    tMin = Math.max(tMin, tEnter);
    tMax = Math.min(tMax, tExit);
    if (tMin >= tMax) return false;
  }

  // Check Y slab
  if (dy === 0) {
    // Horizontal line - check if Y is strictly inside
    if (y1 <= minY || y1 >= maxY) return false;
  } else {
    const t1 = (minY - y1) / dy;
    const t2 = (maxY - y1) / dy;
    const tEnter = Math.min(t1, t2);
    const tExit = Math.max(t1, t2);
    tMin = Math.max(tMin, tEnter);
    tMax = Math.min(tMax, tExit);
    if (tMin >= tMax) return false;
  }

  // Segment intersects the AABB interior
  return true;
}

// ============================================================================
// PATH UTILITIES
// ============================================================================

/**
 * Remove collinear points from orthogonal path.
 *
 * For H/V-only paths, removes intermediate points that lie on the same
 * horizontal or vertical line as their neighbors.
 *
 * @param points - Input path
 * @returns Simplified path without collinear intermediate points
 */
export function simplifyOrthogonal(points: [number, number][]): [number, number][] {
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
 * Compute route signature from simplified path.
 *
 * Encodes path as sequence of H (horizontal) and V (vertical) segments,
 * with consecutive duplicates removed. E.g., "HVH", "VHV", "HV".
 *
 * @param points - Simplified path points
 * @returns Signature string
 */
export function computeSignature(points: [number, number][]): string {
  let sig = '';
  for (let i = 0; i < points.length - 1; i++) {
    const dx = points[i + 1][0] - points[i][0];
    const dy = points[i + 1][1] - points[i][1];
    if (Math.abs(dx) > Math.abs(dy)) {
      sig += 'H';
    } else if (Math.abs(dy) > Math.abs(dx)) {
      sig += 'V';
    }
  }
  // Deduplicate consecutive same chars
  return sig.replace(/(.)(\1)+/g, '$1');
}

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

/**
 * Infer drag direction for free endpoint.
 * Uses hysteresis to prevent jitter when cursor moves near axis boundaries.
 *
 * @param from - Start position
 * @param cursor - Current cursor position
 * @param prevDir - Previous direction (for hysteresis)
 * @param hysteresisRatio - Ratio required to switch axis (default 1.04)
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
