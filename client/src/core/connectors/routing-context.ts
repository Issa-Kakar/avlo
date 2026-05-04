/**
 * Routing Context — single source of truth for A* routing.
 *
 * CORE PHILOSOPHY:
 * - All spatial analysis happens here; grid construction is dumb.
 * - Routing bounds encode centerline knowledge (facing side = centerline).
 * - Point-bounds for free endpoints (converge to a single point, expand to centerline).
 * - Stubs are ON routing-bound edges, not separate offset calculations.
 * - No cell blocking needed — grid lines come directly from routing bounds.
 *
 * SYNCHRONOUS-ONLY CONTRACT:
 * Every scratch in this file (raw bounds, routing bounds, centerlines, stubs,
 * obstacles, ctx, grid, cell pool) is module-level and reused per call. Callers
 * MUST NOT invoke `fillRoutingContext` re-entrantly — there is no second copy
 * of these scratches. The full reroute/route pipeline is synchronous; A* never
 * calls back out into reroute, and Y.Doc observers don't run inside transact().
 */

import type { FrameTuple, Point } from '../types/geometry';
import { fillBoundsFromFrame, fillBoundsFromPoint, isHorizontal, isPointBounds } from './connector-utils';
import { computeApproachOffset, EDGE_CLEARANCE_W } from './constants';
import type { Bounds, Centerlines, Dir, Grid, RoutingContext } from './types';

// ============================================================================
// MODULE-LEVEL SCRATCHES (synchronous, non-re-entrant)
// ============================================================================

const START_RAW: Bounds = { left: 0, top: 0, right: 0, bottom: 0 };
const END_RAW: Bounds = { left: 0, top: 0, right: 0, bottom: 0 };
const ROUTING_START: Bounds = { left: 0, top: 0, right: 0, bottom: 0 };
const ROUTING_END: Bounds = { left: 0, top: 0, right: 0, bottom: 0 };
const CENTERLINES: Centerlines = { x: null, y: null };
const START_STUB: Point = [0, 0];
const END_STUB: Point = [0, 0];

// Obstacles: cleared and pushed into per call. Max length 2.
const OBSTACLES: FrameTuple[] = [];

// CTX permanently references the scratches above. Returned by reference each call.
const CTX: RoutingContext = {
  startPos: [0, 0] as Point,
  endPos: [0, 0] as Point,
  startBounds: ROUTING_START,
  endBounds: ROUTING_END,
  startStub: START_STUB,
  endStub: END_STUB,
  startDir: 'E',
  endDir: 'E',
  obstacles: OBSTACLES,
};

// Grid pool — pre-allocated line arrays (cells are addressed by index, not objects).
const MAX_GRID_LINES = 16;
const GRID_X_LINES: number[] = [];
const GRID_Y_LINES: number[] = [];
const GRID_SCRATCH: Grid = { xLines: GRID_X_LINES, yLines: GRID_Y_LINES };

// ============================================================================
// MAIN ENTRY POINT
// ============================================================================

/**
 * Fill the module routing context with all spatial analysis. Returns a stable
 * reference to `CTX` whose fields point at module scratches — read-only for
 * the caller (consumed by A* before any subsequent call).
 *
 * Single place where centerlines are computed, dynamic routing bounds are built
 * (facing side = centerline), stubs are placed on those bounds, and obstacles
 * (raw shape bounds) are collected.
 *
 * Takes 7 primitives; `isAnchored` is derived from `startShapeBounds !== null`.
 */
export function fillRoutingContext(
  startPos: Point,
  startDir: Dir,
  endPos: Point,
  endDir: Dir,
  startShapeBounds: FrameTuple | null,
  endShapeBounds: FrameTuple | null,
  strokeWidth: number,
): RoutingContext {
  const offset = computeApproachOffset(strokeWidth);

  const startAnchored = startShapeBounds !== null;
  const endAnchored = endShapeBounds !== null;

  // 1. Get raw bounds (shape bounds or point), filled into module scratches.
  if (startShapeBounds) fillBoundsFromFrame(START_RAW, startShapeBounds);
  else fillBoundsFromPoint(START_RAW, startPos);
  if (endShapeBounds) fillBoundsFromFrame(END_RAW, endShapeBounds);
  else fillBoundsFromPoint(END_RAW, endPos);

  // 2. Determine endpoint configuration
  const isFreeToAnchored = !startAnchored && endAnchored;
  const isAnchoredToFree = startAnchored && !endAnchored;

  // 3. Compute centerlines from RAW bounds (no padding) into CENTERLINES.
  fillCenterlines(CENTERLINES, START_RAW, END_RAW, isFreeToAnchored, offset);

  // 4. Build dynamic routing bounds with centerline/padding into ROUTING_*.
  // Each call determines its own facing sides based on where the OTHER shape is.
  fillRoutingBounds(ROUTING_START, START_RAW, END_RAW, CENTERLINES, offset, isAnchoredToFree);
  fillRoutingBounds(ROUTING_END, END_RAW, START_RAW, CENTERLINES, offset, isAnchoredToFree);

  // 5. Compute stubs from bounds + direction into STUB scratches.
  fillStub(START_STUB, ROUTING_START, startPos, startDir);
  fillStub(END_STUB, ROUTING_END, endPos, endDir);

  // 6. Collect obstacles (raw shape bounds for segment checking) — clear+push.
  OBSTACLES.length = 0;
  if (startShapeBounds) OBSTACLES.push(startShapeBounds);
  if (endShapeBounds && endShapeBounds !== startShapeBounds) OBSTACLES.push(endShapeBounds);

  // 7. Refresh CTX header fields. Bounds/stubs/obstacles already share refs with scratches.
  CTX.startPos = startPos;
  CTX.endPos = endPos;
  CTX.startDir = startDir;
  CTX.endDir = endDir;

  return CTX;
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
 * Fill `out` with centerlines between two raw bounds — one per axis, either order.
 * Uses RAW bounds (no padding); a centerline is the midpoint between actual edges.
 */
function fillCenterlines(out: Centerlines, startRaw: Bounds, endRaw: Bounds, isFreeToAnchored: boolean, offset: number): void {
  out.x =
    computeAxisCenterline(startRaw.right, endRaw.left, isFreeToAnchored, offset) ??
    computeAxisCenterline(endRaw.right, startRaw.left, isFreeToAnchored, offset);
  out.y =
    computeAxisCenterline(startRaw.bottom, endRaw.top, isFreeToAnchored, offset) ??
    computeAxisCenterline(endRaw.bottom, startRaw.top, isFreeToAnchored, offset);
}

// ============================================================================
// DYNAMIC ROUTING BOUNDS
// ============================================================================

/**
 * Fill `out` with dynamic routing bounds (centerline + padding baked in).
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
 *    to the centerline.
 *
 * 3. SHAPE BOUNDS — facing side = centerline (if exists) shared between both
 *    shapes' routing bounds; non-facing sides = raw bound ± approach-offset.
 */
function fillRoutingBounds(
  out: Bounds,
  raw: Bounds,
  other: Bounds,
  centerlines: Centerlines,
  offset: number,
  isAnchoredToFree: boolean,
): void {
  const isPoint = isPointBounds(raw);

  // Case 1: Anchored→free endpoint - full centerline merging.
  if (isPoint && isAnchoredToFree) {
    out.left = centerlines.x ?? raw.left;
    out.right = centerlines.x ?? raw.right;
    out.top = centerlines.y ?? raw.top;
    out.bottom = centerlines.y ?? raw.bottom;
    return;
  }

  // Cases 2 & 3: facing-side logic.
  const facesRight = raw.right <= other.left;
  const facesLeft = raw.left >= other.right;
  const facesBottom = raw.bottom <= other.top;
  const facesTop = raw.top >= other.bottom;

  out.left = facesLeft && centerlines.x !== null ? centerlines.x : isPoint ? raw.left : raw.left - offset;
  out.right = facesRight && centerlines.x !== null ? centerlines.x : isPoint ? raw.right : raw.right + offset;
  out.top = facesTop && centerlines.y !== null ? centerlines.y : isPoint ? raw.top : raw.top - offset;
  out.bottom = facesBottom && centerlines.y !== null ? centerlines.y : isPoint ? raw.bottom : raw.bottom + offset;
}

// ============================================================================
// STUB COMPUTATION
// ============================================================================

/**
 * Fill `out` with the stub position — where A* actually starts / ends.
 *
 * Intersection of the anchor's fixed axis (Y for E/W, X for N/S) with the
 * routing-bounds edge in the outward direction. Because routing bounds already
 * encode centerline and padding, stubs land ON the centerline whenever one exists.
 */
function fillStub(out: Point, bounds: Bounds, anchorPos: Point, dir: Dir): void {
  const ax = anchorPos[0];
  const ay = anchorPos[1];
  switch (dir) {
    case 'E':
      out[0] = bounds.right;
      out[1] = ay;
      return;
    case 'W':
      out[0] = bounds.left;
      out[1] = ay;
      return;
    case 'S':
      out[0] = ax;
      out[1] = bounds.bottom;
      return;
    case 'N':
      out[0] = ax;
      out[1] = bounds.top;
      return;
  }
}

// ============================================================================
// GRID CONSTRUCTION
// ============================================================================

/**
 * Sort + in-place dedup of `arr` (values within 1e-9). Length is shrunk after.
 * Faster than Set<number> for the ~10 candidate values we actually have.
 */
function sortAndDedup(arr: number[]): void {
  arr.sort((a, b) => a - b);
  let writeIdx = 0;
  let prev = NaN;
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i];
    if (i === 0 || v - prev > 1e-9) {
      arr[writeIdx++] = v;
      prev = v;
    }
  }
  arr.length = writeIdx;
}

/**
 * Fill the grid line arrays from the routing context.
 *
 * Lines come from the 4 routing-bound edges per side (8 total) plus the
 * perpendicular stub line each anchor needs. ~10 candidates dedup faster via
 * sort-then-unique sweep than via Set<number>.
 *
 * Cells are addressed by `(yi, xi)` index in A* — no GridCell objects allocated.
 */
export function fillSimpleGrid(out: Grid, ctx: RoutingContext): Grid {
  out.xLines.length = 0;
  out.yLines.length = 0;

  out.xLines.push(ctx.startBounds.left, ctx.startBounds.right, ctx.endBounds.left, ctx.endBounds.right);
  out.yLines.push(ctx.startBounds.top, ctx.startBounds.bottom, ctx.endBounds.top, ctx.endBounds.bottom);

  if (isHorizontal(ctx.startDir)) out.yLines.push(ctx.startStub[1]);
  else out.xLines.push(ctx.startStub[0]);

  if (isHorizontal(ctx.endDir)) out.yLines.push(ctx.endStub[1]);
  else out.xLines.push(ctx.endStub[0]);

  sortAndDedup(out.xLines);
  sortAndDedup(out.yLines);

  if (import.meta.env.DEV && (out.xLines.length > MAX_GRID_LINES || out.yLines.length > MAX_GRID_LINES)) {
    console.warn(`[routing-context] grid lines exceeded MAX_GRID_LINES (${out.xLines.length}×${out.yLines.length})`);
  }

  return out;
}

/** Module-level grid scratch — exported so routing-astar can pass it into fillSimpleGrid. */
export const GRID = GRID_SCRATCH;
