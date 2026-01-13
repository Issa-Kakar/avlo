/**
 * Shape Utilities for Connector Snapping
 *
 * Provides frame extraction, midpoint calculation, and edge position helpers.
 * Designed to work with ObjectHandle from the snapshot.
 *
 * @module lib/connectors/shape-utils
 */

import type { ObjectHandle } from '@avlo/shared';

/** Cardinal direction type (North, East, South, West) */
export type Dir = 'N' | 'E' | 'S' | 'W';

/** Shape frame (x, y, width, height) */
export interface ShapeFrame {
  x: number;
  y: number;
  w: number;
  h: number;
}

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
 * Get outward direction vector for a side.
 * Used for jetty computation in routing.
 *
 * @param side - Edge side
 * @returns Unit vector [dx, dy] pointing outward
 */
export function getOutwardVector(side: Dir): [number, number] {
  switch (side) {
    case 'N':
      return [0, -1];
    case 'S':
      return [0, 1];
    case 'W':
      return [-1, 0];
    case 'E':
      return [1, 0];
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
// CLASSIFICATION HELPERS
// ============================================================================

/** Axis relationship between two directions */
export type AxisRelation = 'same-axis' | 'cross-axis';

/**
 * Classify axis relationship between two directions.
 * Same-axis: both vertical (N/S) or both horizontal (E/W)
 * Cross-axis: one vertical, one horizontal
 *
 * @param dirA - First direction
 * @param dirB - Second direction
 * @returns Axis relationship
 */
export function classifyAxisRelation(dirA: Dir, dirB: Dir): AxisRelation {
  const aVertical = isVertical(dirA);
  const bVertical = isVertical(dirB);
  return aVertical === bVertical ? 'same-axis' : 'cross-axis';
}

/** Direction relationship between two directions */
export type DirRelation = 'opposite' | 'same' | 'perpendicular';

/**
 * Classify direction relationship.
 * Opposite: N↔S, E↔W
 * Same: N↔N, E↔E, etc.
 * Perpendicular: N↔E, S↔W, etc.
 *
 * @param dirA - First direction
 * @param dirB - Second direction
 * @returns Direction relationship
 */
export function classifyDirRelation(dirA: Dir, dirB: Dir): DirRelation {
  if (dirA === oppositeDir(dirB)) return 'opposite';
  if (dirA === dirB) return 'same';
  return 'perpendicular';
}

// ============================================================================
// SPATIAL RELATIONSHIP HELPERS
// ============================================================================

/** AABB for spatial calculations (compatible with ShapeFrame) */
export interface AABB {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Facing sides between two shapes.
 * Used to compute centerlines for preferred routing paths.
 */
export interface FacingSides {
  // X-axis facing (vertical lines)
  /** Start shape's facing X (e.g., start's right padding line) */
  startFacingX: number | null;
  /** End shape's facing X (e.g., end's left padding line) */
  endFacingX: number | null;
  /** Centerline X (midpoint between facing sides) */
  centerlineX: number | null;
  /** True if there's space for X centerline */
  hasXCenterline: boolean;

  // Y-axis facing (horizontal lines)
  /** Start shape's facing Y (e.g., start's bottom padding line) */
  startFacingY: number | null;
  /** End shape's facing Y (e.g., end's top padding line) */
  endFacingY: number | null;
  /** Centerline Y (midpoint between facing sides) */
  centerlineY: number | null;
  /** True if there's space for Y centerline */
  hasYCenterline: boolean;
}

/** Point-to-shape spatial relationship (for direction seeding) */
export interface PointToShapeSpatial {
  /** Point is to the left of shape (point.x < shape.x) */
  pointIsLeftOf: boolean;
  /** Point is to the right of shape (point.x > shape.x + shape.w) */
  pointIsRightOf: boolean;
  /** Point is above shape (point.y < shape.y) */
  pointIsAbove: boolean;
  /** Point is below shape (point.y > shape.y + shape.h) */
  pointIsBelow: boolean;
  /** Point X is within padded X range */
  withinPaddedXRange: boolean;
  /** Point Y is within padded Y range */
  withinPaddedYRange: boolean;
}

/**
 * Compute spatial relationship between a point and a shape.
 * Used for direction seeding in A* routing.
 *
 * @param point - World position [x, y]
 * @param shapeBounds - Shape AABB
 * @param approachOffset - Padding offset for "within range" checks
 * @returns Spatial relationship
 */
export function computePointToShapeSpatial(
  point: [number, number],
  shapeBounds: AABB,
  approachOffset: number
): PointToShapeSpatial {
  const [px, py] = point;
  const { x, y, w, h } = shapeBounds;

  // Padded bounds
  const pMinX = x - approachOffset;
  const pMaxX = x + w + approachOffset;
  const pMinY = y - approachOffset;
  const pMaxY = y + h + approachOffset;

  return {
    pointIsLeftOf: px < x,
    pointIsRightOf: px > x + w,
    pointIsAbove: py < y,
    pointIsBelow: py > y + h,
    withinPaddedXRange: px >= pMinX && px <= pMaxX,
    withinPaddedYRange: py >= pMinY && py <= pMaxY,
  };
}

/** Shape-to-shape spatial relationship (for facing sides computation) */
export interface ShapeToShapeSpatial {
  /** End shape is to the right of start (end.x > start.x + start.w + padding) */
  endIsRightOf: boolean;
  /** End shape is to the left of start (end.x + end.w < start.x - padding) */
  endIsLeftOf: boolean;
  /** Shapes overlap on X axis */
  overlapX: boolean;
  /** End shape is below start (end.y > start.y + start.h + padding) */
  endIsBelow: boolean;
  /** End shape is above start (end.y + end.h < start.y - padding) */
  endIsAbove: boolean;
  /** Shapes overlap on Y axis */
  overlapY: boolean;
}

/**
 * Compute spatial relationship between two shapes.
 * Used for facing sides computation in grid construction.
 *
 * NOTE: Uses actual shape bounds, NOT padded bounds. Spatial relations
 * should be based on actual geometry, not padding-adjusted positions.
 * Padding is only used for grid line placement, not spatial classification.
 *
 * @param startBounds - Start shape AABB
 * @param endBounds - End shape AABB
 * @returns Spatial relationship
 */
export function computeShapeToShapeSpatial(
  startBounds: AABB,
  endBounds: AABB
): ShapeToShapeSpatial {
  // Spatial relationships based on actual shape bounds (NO padding)
  const endIsRightOf = endBounds.x > startBounds.x + startBounds.w;
  const endIsLeftOf = endBounds.x + endBounds.w < startBounds.x;
  const endIsBelow = endBounds.y > startBounds.y + startBounds.h;
  const endIsAbove = endBounds.y + endBounds.h < startBounds.y;

  return {
    endIsRightOf,
    endIsLeftOf,
    overlapX: !endIsRightOf && !endIsLeftOf,
    endIsBelow,
    endIsAbove,
    overlapY: !endIsBelow && !endIsAbove,
  };
}

/**
 * Check if a point is strictly inside a rectangle (not on boundary).
 *
 * @param x - Point X
 * @param y - Point Y
 * @param rect - Rectangle bounds
 * @returns true if strictly inside (not on boundary)
 */
export function pointStrictlyInsideRect(x: number, y: number, rect: AABB): boolean {
  return x > rect.x && x < rect.x + rect.w && y > rect.y && y < rect.y + rect.h;
}

// ============================================================================
// EDGE-BASED BOUNDS (FOR ROUTING CONTEXT)
// ============================================================================

/**
 * Edge-based bounds representation for routing AABBs.
 *
 * Using edges directly (instead of x,y,w,h) makes routing code cleaner:
 * - Grid lines: `xLines.add(b.left)` vs `xLines.add(b.x)`
 * - Centerline: `(a.right + b.left) / 2` vs `(a.x + a.w + b.x) / 2`
 * - Facing checks: `a.right <= b.left` vs `a.x + a.w <= b.x`
 */
export interface Bounds {
  left: number; // minX
  top: number; // minY
  right: number; // maxX
  bottom: number; // maxY
}

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
