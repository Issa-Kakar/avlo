/**
 * Routing Context — single source of truth for A* routing.
 *
 * CORE PHILOSOPHY:
 * - All spatial analysis happens here; grid construction is dumb.
 * - Routing bounds encode centerline knowledge (facing side = centerline).
 * - Point-bounds for free endpoints (converge to a single point, expand to centerline).
 * - Stubs are ON routing-bound edges, not separate offset calculations.
 * - No cell blocking needed — grid lines come directly from routing bounds.
 */

import type { FrameTuple, Point } from '../types/geometry';
import { computeApproachOffset, EDGE_CLEARANCE_W } from './constants';
import { toBounds, pointBounds, isPointBounds, isHorizontal } from './connector-utils';
import type { Dir, Bounds, RoutingContext, Grid, GridCell, Centerlines } from './types';

// ============================================================================
// MAIN ENTRY POINT
// ============================================================================

/**
 * Create the complete routing context with all spatial analysis.
 *
 * Single place where centerlines are computed, dynamic routing bounds are built
 * (facing side = centerline), stubs are placed on those bounds, and obstacles
 * (raw shape bounds) are collected.
 *
 * Takes 7 primitives; `isAnchored` is derived from `startShapeBounds !== null`.
 */
export function createRoutingContext(
  startPos: Point,
  startDir: Dir,
  endPos: Point,
  endDir: Dir,
  startShapeBounds: FrameTuple | null,
  endShapeBounds: FrameTuple | null,
  strokeWidth: number,
): RoutingContext {
  const offset = computeApproachOffset(strokeWidth);

  // Derive isAnchored from bounds !== null
  const startAnchored = startShapeBounds !== null;
  const endAnchored = endShapeBounds !== null;

  // 1. Get raw bounds (shape bounds or point)
  const startRaw = startShapeBounds ? toBounds(startShapeBounds) : pointBounds(startPos);
  const endRaw = endShapeBounds ? toBounds(endShapeBounds) : pointBounds(endPos);

  // 2. Determine endpoint configuration
  const isFreeToAnchored = !startAnchored && endAnchored;
  const isAnchoredToFree = startAnchored && !endAnchored;
  // 3. Compute centerlines from RAW bounds (no padding)
  const centerlines = computeCenterlines(startRaw, endRaw, isFreeToAnchored, offset);

  // 4. Build dynamic routing bounds with centerline/padding
  // Each call determines its own facing sides based on where the OTHER shape is
  const routingStartBounds = buildRoutingBounds(startRaw, endRaw, centerlines, offset, isAnchoredToFree);
  const routingEndBounds = buildRoutingBounds(endRaw, startRaw, centerlines, offset, isAnchoredToFree);

  // 5. Compute stubs from bounds + direction
  const startStub = computeStub(routingStartBounds, startPos, startDir);
  const endStub = computeStub(routingEndBounds, endPos, endDir);

  // 6. Collect obstacles (raw shape bounds for segment checking)
  const obstacles: FrameTuple[] = [];
  if (startShapeBounds) obstacles.push(startShapeBounds);
  if (endShapeBounds && endShapeBounds !== startShapeBounds) {
    obstacles.push(endShapeBounds);
  }

  return {
    startPos,
    endPos,
    startBounds: routingStartBounds,
    endBounds: routingEndBounds,
    startStub,
    endStub,
    startDir,
    endDir,
    obstacles,
  };
}

// ============================================================================
// CENTERLINE COMPUTATION
// ============================================================================

/**
 * Per-axis centerline between two non-overlapping ranges.
 *
 * Returns `null` when:
 * - Ranges overlap (`aMax >= bMin`), or
 * - Free→Anchored gap is below the approach offset (would place stub behind start), or
 * - Any-case gap is ≤ EDGE_CLEARANCE_W (too close for a meaningful centerline).
 */
function computeAxisCenterline(aMax: number, bMin: number, isFreeToAnchored: boolean, offset: number): number | null {
  if (aMax >= bMin) return null;
  const gap = bMin - aMax;
  if (isFreeToAnchored && gap < offset) return null;
  if (gap <= EDGE_CLEARANCE_W) return null;
  return (aMax + bMin) / 2;
}

/**
 * Centerlines between two raw bounds — one per axis, either order.
 * Uses RAW bounds (no padding); a centerline is the midpoint between actual edges.
 */
function computeCenterlines(startRaw: Bounds, endRaw: Bounds, isFreeToAnchored: boolean, offset: number): Centerlines {
  return {
    x:
      computeAxisCenterline(startRaw.right, endRaw.left, isFreeToAnchored, offset) ??
      computeAxisCenterline(endRaw.right, startRaw.left, isFreeToAnchored, offset),
    y:
      computeAxisCenterline(startRaw.bottom, endRaw.top, isFreeToAnchored, offset) ??
      computeAxisCenterline(endRaw.bottom, startRaw.top, isFreeToAnchored, offset),
  };
}

// ============================================================================
// DYNAMIC ROUTING BOUNDS
// ============================================================================

/**
 * Build dynamic routing bounds with centerline + padding baked in.
 *
 * THREE cases based on endpoint configuration:
 *
 * 1. ANCHORED→FREE POINT — full centerline merging. All edges collapse to the
 *    centerline (when one exists). Preserves WYSIWYG: the path is identical
 *    whether the user stops at a free point or snaps to a shape.
 *
 * 2. FREE→ANCHORED POINT — facing-side logic (treats the point as an imaginary
 *    shape whose outward direction is the anchor side). Only facing sides get
 *    the centerline; non-facing sides stay at the raw position. Critical so the
 *    first segment escapes in the direction-seeded axis rather than collapsing
 *    to the centerline. Example: start LEFT of shape, inside padded Y, anchor
 *    on EAST — direction is N (escape up), E/W are non-facing, stub X stays at
 *    the actual point X (not the centerline), first segment goes vertical.
 *
 * 3. SHAPE BOUNDS — facing side = centerline (if exists) shared between both
 *    shapes' routing bounds; non-facing sides = raw bound ± offset.
 */
function buildRoutingBounds(raw: Bounds, other: Bounds, centerlines: Centerlines, offset: number, isAnchoredToFree: boolean): Bounds {
  const isPoint = isPointBounds(raw);

  // Case 1: Anchored→free endpoint - full centerline merging
  // Ensures WYSIWYG: identical path whether stopping free or snapping to shape
  if (isPoint && isAnchoredToFree) {
    return {
      left: centerlines.x ?? raw.left,
      right: centerlines.x ?? raw.right,
      top: centerlines.y ?? raw.top,
      bottom: centerlines.y ?? raw.bottom,
    };
  }

  // Cases 2 & 3: Shape bounds OR free→anchored point
  // Both use facing-side logic - only facing sides get centerline
  // For free→anchored: treats point like imaginary shape based on outward direction
  const facesRight = raw.right <= other.left; // This is left of other
  const facesLeft = raw.left >= other.right; // This is right of other
  const facesBottom = raw.bottom <= other.top; // This is above other
  const facesTop = raw.top >= other.bottom; // This is below other

  return {
    // Facing side → centerline; non-facing → raw (point) or raw±offset (shape)
    left: facesLeft && centerlines.x !== null ? centerlines.x : isPoint ? raw.left : raw.left - offset,

    right: facesRight && centerlines.x !== null ? centerlines.x : isPoint ? raw.right : raw.right + offset,

    top: facesTop && centerlines.y !== null ? centerlines.y : isPoint ? raw.top : raw.top - offset,

    bottom: facesBottom && centerlines.y !== null ? centerlines.y : isPoint ? raw.bottom : raw.bottom + offset,
  };
}

// ============================================================================
// STUB COMPUTATION
// ============================================================================

/**
 * Stub position — where A* actually starts / ends.
 *
 * Intersection of the anchor's fixed axis (Y for E/W, X for N/S) with the
 * routing-bounds edge in the outward direction. Because routing bounds already
 * encode centerline and padding, stubs land ON the centerline whenever one exists.
 */
function computeStub(bounds: Bounds, anchorPos: Point, dir: Dir): Point {
  const [ax, ay] = anchorPos;
  switch (dir) {
    case 'E':
      return [bounds.right, ay];
    case 'W':
      return [bounds.left, ay];
    case 'S':
      return [ax, bounds.bottom];
    case 'N':
      return [ax, bounds.top];
  }
}

// ============================================================================
// GRID CONSTRUCTION
// ============================================================================

/**
 * Build a simple grid from routing context.
 *
 * Trivial because routing context already has:
 * - Dynamic routing bounds with centerline/padding baked in
 * - Stub positions on those bounds
 *
 * No cell blocking needed — A* handles obstacles via segment intersection.
 *
 * @param ctx - Routing context with pre-computed bounds and stubs
 * @returns Grid for A* routing
 */
export function buildSimpleGrid(ctx: RoutingContext): Grid {
  // Collect grid lines from routing-bound edges (Sets auto-dedupe)
  const xSet = new Set<number>();
  const ySet = new Set<number>();

  // Add all 4 edges from each routing bounds
  xSet.add(ctx.startBounds.left);
  xSet.add(ctx.startBounds.right);
  ySet.add(ctx.startBounds.top);
  ySet.add(ctx.startBounds.bottom);

  xSet.add(ctx.endBounds.left);
  xSet.add(ctx.endBounds.right);
  ySet.add(ctx.endBounds.top);
  ySet.add(ctx.endBounds.bottom);

  // Add stub perpendicular lines (Y for H heading, X for V heading)
  if (isHorizontal(ctx.startDir)) ySet.add(ctx.startStub[1]);
  else xSet.add(ctx.startStub[0]);

  if (isHorizontal(ctx.endDir)) ySet.add(ctx.endStub[1]);
  else xSet.add(ctx.endStub[0]);

  // Sort
  const xLines = [...xSet].sort((a, b) => a - b);
  const yLines = [...ySet].sort((a, b) => a - b);

  // Build cells (no blocking - A* checks segments)
  const cells: GridCell[][] = [];
  for (let yi = 0; yi < yLines.length; yi++) {
    cells[yi] = [];
    for (let xi = 0; xi < xLines.length; xi++) {
      cells[yi][xi] = { x: xLines[xi], y: yLines[yi], xi, yi };
    }
  }

  return { cells, xLines, yLines };
}
