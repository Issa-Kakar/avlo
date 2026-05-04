/**
 * Connector Utilities — direction primitives, spatial relation, bounds
 * conversion, path simplification, elbow direction resolution.
 *
 * Pure shape math (midpoints, nearest-edge, ray × shape) lives in
 * `shape-geometry.ts`. Anchor math (including `getEndpointEdgePosition`)
 * lives in `anchor-atoms.ts`. This file is strictly about directions and
 * elbow-routing direction inference.
 *
 * Reads top-to-bottom as a dependency chain: each section only uses symbols
 * defined above it.
 */

import { frameCenter } from '../geometry/bounds';
import type { FrameTuple, Point } from '../types/geometry';
import { computeApproachOffset } from './constants';
import type { Bounds, Dir } from './types';

// ============================================================================
// DIRECTION PRIMITIVES
// ============================================================================

const OPPOSITE: Record<Dir, Dir> = { N: 'S', S: 'N', E: 'W', W: 'E' };
export function oppositeDir(dir: Dir): Dir {
  return OPPOSITE[dir];
}

export function isHorizontal(dir: Dir): boolean {
  return dir === 'E' || dir === 'W';
}

export function isVertical(dir: Dir): boolean {
  return dir === 'N' || dir === 'S';
}

const DIR_VECTORS: Record<Dir, Point> = {
  N: [0, -1],
  E: [1, 0],
  S: [0, 1],
  W: [-1, 0],
};

/** Unit vector for a cardinal direction. */
export function directionVector(dir: Dir): Point {
  return DIR_VECTORS[dir];
}

/** Primary-axis cardinal direction from a delta. Horizontal ties go E/W. */
export function directionFromDelta(dx: number, dy: number): Dir {
  return Math.abs(dx) >= Math.abs(dy) ? (dx >= 0 ? 'E' : 'W') : dy >= 0 ? 'S' : 'N';
}

// ============================================================================
// SPATIAL RELATION (point ↔ frame)
// ============================================================================

/** Boolean flags describing where a point sits relative to a frame + padding corridor. */
export interface SpatialRelation {
  leftOf: boolean;
  rightOf: boolean;
  above: boolean;
  below: boolean;
  /** Within [x-offset, x+w+offset] — the horizontal padding corridor. */
  nearX: boolean;
  /** Within [y-offset, y+h+offset] — the vertical padding corridor. */
  nearY: boolean;
  /** Strictly inside the frame (all four half-planes fail). */
  inShape: boolean;
  /** Outside the frame but inside the padding corridor on both axes. */
  inFullPad: boolean;
}

export function spatialRelation(pos: Point, frame: FrameTuple, offset: number): SpatialRelation {
  const [x, y, w, h] = frame;
  const [px, py] = pos;
  const leftOf = px < x;
  const rightOf = px > x + w;
  const above = py < y;
  const below = py > y + h;
  const nearX = px >= x - offset && px <= x + w + offset;
  const nearY = py >= y - offset && py <= y + h + offset;
  const inShape = !leftOf && !rightOf && !above && !below;
  const inFullPad = nearX && nearY && !inShape;
  return { leftOf, rightOf, above, below, nearX, nearY, inShape, inFullPad };
}

/** True when `pos` lies in the `dir` half-plane of its frame (per SpatialRelation flags). */
function onSide(rel: SpatialRelation, dir: Dir): boolean {
  return dir === 'N' ? rel.above : dir === 'S' ? rel.below : dir === 'E' ? rel.rightOf : rel.leftOf;
}

// ============================================================================
// BOUNDS FILLERS (used by routing-context — write into caller scratches)
// ============================================================================

/** Fill `out` with edge-based bounds from a frame tuple. */
export function fillBoundsFromFrame(out: Bounds, frame: FrameTuple): void {
  const [x, y, w, h] = frame;
  out.left = x;
  out.top = y;
  out.right = x + w;
  out.bottom = y + h;
}

/** Fill `out` with collapsed point-bounds (all edges converge to `pos`). */
export function fillBoundsFromPoint(out: Bounds, pos: Point): void {
  out.left = pos[0];
  out.right = pos[0];
  out.top = pos[1];
  out.bottom = pos[1];
}

/** True when all edges of `b` converge to a single point (no padding applied). */
export function isPointBounds(b: Bounds): boolean {
  return b.left === b.right && b.top === b.bottom;
}

// ============================================================================
// ELBOW DIRECTION RESOLUTION (elbow connectors only)
// ============================================================================

/**
 * Pick a sliver-escape direction when a free start point sits in the padded
 * corridor of the target shape but outside the shape itself. Priority flips
 * with anchor axis so the escape never collides with the anchored end.
 * Returns null when no axis-aligned escape is available.
 */
function computeElbowSliverEscape(rel: SpatialRelation, anchorIsHorizontal: boolean): Dir | null {
  if (anchorIsHorizontal) {
    if (rel.leftOf && rel.nearY) return 'W';
    if (rel.rightOf && rel.nearY) return 'E';
    if (rel.above && rel.nearX) return 'N';
    if (rel.below && rel.nearX) return 'S';
  } else {
    if (rel.above && rel.nearX) return 'N';
    if (rel.below && rel.nearX) return 'S';
    if (rel.leftOf && rel.nearY) return 'W';
    if (rel.rightOf && rel.nearY) return 'E';
  }
  return null;
}

/**
 * Resolve start direction for FREE→ANCHORED elbow routes.
 *
 *   1. Inside full padding → opposite wraps toward target, else return anchorDir.
 *   2. Same side           → L-route checks sliver first, both variants go toward shape.
 *   3. Opposite + contained → wrap around via shape center.
 *   4. Adjacent / clear    → sliver escape, else anchorDir.
 */
export function resolveElbowFreeStartDir(
  fromPos: Point,
  anchorEnd: { position: Point; outwardDir: Dir; shapeBounds: FrameTuple },
  strokeWidth: number,
): Dir {
  const [fx, fy] = fromPos;
  const [tx, ty] = anchorEnd.position;
  const anchorDir = anchorEnd.outwardDir;
  const rel = spatialRelation(fromPos, anchorEnd.shapeBounds, computeApproachOffset(strokeWidth));
  const anchorIsH = isHorizontal(anchorDir);
  const sameSide = onSide(rel, anchorDir);
  const oppSide = onSide(rel, oppositeDir(anchorDir));

  // 1. Inside full padding
  if (rel.inFullPad) {
    if (oppSide) return !anchorIsH ? (fx < tx ? 'E' : 'W') : fy < ty ? 'S' : 'N';
    return anchorDir;
  }

  // 2. Same side: L-route (axis mismatch) tries sliver; both variants then go toward shape
  if (sameSide) {
    const dx = tx - fx;
    const dy = ty - fy;
    const hDominant = Math.abs(dx) >= Math.abs(dy);
    if (anchorIsH !== hDominant) {
      const sliver = computeElbowSliverEscape(rel, anchorIsH);
      if (sliver) return sliver;
    }
    return directionFromDelta(dx, dy);
  }

  // 3. Opposite + contained: wrap around via shape center
  if (oppSide && rel.nearX && rel.nearY) {
    const fc = frameCenter(anchorEnd.shapeBounds);
    return anchorIsH ? (fy < fc[1] ? 'N' : 'S') : fx < fc[0] ? 'W' : 'E';
  }

  // 4. Adjacent / opposite-not-contained: sliver escape, else anchorDir
  return computeElbowSliverEscape(rel, anchorIsH) ?? anchorDir;
}

/**
 * End direction for ANCHORED→FREE elbow routes — primary axis + sign.
 */
export function computeElbowFreeEndDir(fromPos: Point, toPos: Point): Dir {
  return directionFromDelta(toPos[0] - fromPos[0], toPos[1] - fromPos[1]);
}
