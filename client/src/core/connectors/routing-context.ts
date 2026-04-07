/**
 * Routing Context - Single Source of Truth for A* Routing
 *
 * CORE PHILOSOPHY:
 * - All spatial analysis happens HERE, grid construction is dumb
 * - AABBs encode centerline knowledge in their boundaries (facing side = centerline)
 * - Point-AABBs for free endpoints (converge to single point, expand to centerline)
 * - Stubs are ON AABB boundaries, not separate offset calculations
 * - No cell blocking needed - grid lines come directly from AABBs
 *
 * @module lib/connectors/routing-context
 */

import { computeApproachOffset, EDGE_CLEARANCE_W } from './constants';
import { toBounds, pointBounds, isPointBounds, isHorizontal } from './connector-utils';
import type { Dir, AABB, Bounds, RoutingContext, Grid, GridCell, Centerlines } from './types';

// ============================================================================
// MAIN ENTRY POINT
// ============================================================================

/**
 * Create complete routing context with all spatial analysis.
 *
 * This is the SINGLE place where:
 * - Centerlines are computed (from RAW bounds)
 * - Dynamic AABBs are built (facing side = centerline)
 * - Stubs are computed (on AABB boundary)
 * - Obstacles are collected
 *
 * Takes 7 primitives instead of Terminal objects:
 * - startPos, startDir, endPos, endDir: Position and direction for each endpoint
 * - startBounds, endBounds: Shape AABB if anchored, null if free (isAnchored derived)
 * - strokeWidth: Connector stroke width (affects offset)
 *
 * @param startPos - Start endpoint position
 * @param startDir - Start outward direction
 * @param endPos - End endpoint position
 * @param endDir - End outward direction
 * @param startShapeBounds - Shape bounds if start is anchored, null if free
 * @param endShapeBounds - Shape bounds if end is anchored, null if free
 * @param strokeWidth - Connector stroke width (affects offset)
 * @returns Complete routing context
 */
export function createRoutingContext(
  startPos: [number, number],
  startDir: Dir,
  endPos: [number, number],
  endDir: Dir,
  startShapeBounds: AABB | null,
  endShapeBounds: AABB | null,
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
  const routingStartBounds = buildRoutingBounds(
    startRaw,
    endRaw,
    centerlines,
    offset,
    isAnchoredToFree,
  );
  const routingEndBounds = buildRoutingBounds(
    endRaw,
    startRaw,
    centerlines,
    offset,
    isAnchoredToFree,
  );

  // 5. Compute stubs from bounds + direction
  const startStub = computeStub(routingStartBounds, startPos, startDir);
  const endStub = computeStub(routingEndBounds, endPos, endDir);

  // 6. Collect obstacles (raw shape bounds for segment checking)
  // Segments ON the boundary are blocked by segmentIntersectsAABB (non-strict inequality)
  const obstacles: AABB[] = [];
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
 * Compute centerlines between two bounds.
 *
 * A centerline exists when:
 * 1. Bounds don't overlap on that axis (computed from RAW bounds)
 * 2. For free-to-anchored: stricter minimum clearance check (offset)
 * 3. For all other cases: gap must be > EDGE_CLEARANCE_W to avoid stub behind start
 *
 * Uses RAW bounds - no padding. Centerline is midpoint between actual edges.
 *
 * @param startRaw - Start raw bounds (shape or point)
 * @param endRaw - End raw bounds (shape or point)
 * @param isFreeToAnchored - True if free→anchored case (needs stricter min clearance)
 * @param offset - Approach offset for minimum clearance check
 * @returns Centerlines (null if doesn't exist on that axis)
 */
function computeCenterlines(
  startRaw: Bounds,
  endRaw: Bounds,
  isFreeToAnchored: boolean,
  offset: number,
): Centerlines {
  let centerX: number | null = null;
  let centerY: number | null = null;

  // X centerline: exists if no horizontal overlap
  // end is to the RIGHT of start
  if (endRaw.left > startRaw.right) {
    const gap = endRaw.left - startRaw.right;
    centerX = (startRaw.right + endRaw.left) / 2;

    // Free→Anchored: stricter minimum clearance check
    if (isFreeToAnchored && gap < offset) {
      centerX = null;
    }
    // All other cases (anchored→free, anchored→anchored): smaller minimum gap
    else if (gap <= EDGE_CLEARANCE_W) {
      centerX = null;
    }
  }
  // start is to the RIGHT of end
  else if (startRaw.left > endRaw.right) {
    const gap = startRaw.left - endRaw.right;
    centerX = (endRaw.right + startRaw.left) / 2;

    if (isFreeToAnchored && gap < offset) {
      centerX = null;
    } else if (gap <= EDGE_CLEARANCE_W) {
      centerX = null;
    }
  }

  // Y centerline: exists if no vertical overlap
  // end is BELOW start
  if (endRaw.top > startRaw.bottom) {
    const gap = endRaw.top - startRaw.bottom;
    centerY = (startRaw.bottom + endRaw.top) / 2;

    if (isFreeToAnchored && gap < offset) {
      centerY = null;
    } else if (gap <= EDGE_CLEARANCE_W) {
      centerY = null;
    }
  }
  // start is BELOW end
  else if (startRaw.top > endRaw.bottom) {
    const gap = startRaw.top - endRaw.bottom;
    centerY = (endRaw.bottom + startRaw.top) / 2;

    if (isFreeToAnchored && gap < offset) {
      centerY = null;
    } else if (gap <= EDGE_CLEARANCE_W) {
      centerY = null;
    }
  }

  return { x: centerX, y: centerY };
}

// ============================================================================
// DYNAMIC AABB CONSTRUCTION
// ============================================================================

/**
 * Build a dynamic routing AABB.
 *
 * THREE distinct cases based on endpoint configuration:
 *
 * 1. ANCHORED→FREE POINT (isPoint && isAnchoredToFree):
 *    - Full centerline merging: shift entire point to centerline coordinates
 *    - Preserves WYSIWYG: path identical whether user stops at free point or snaps
 *    - All edges become centerline (if exists), maintaining symmetric behavior
 *      with anchored→anchored routes
 *
 * 2. FREE→ANCHORED POINT (isPoint && !isAnchoredToFree):
 *    - Uses FACING-SIDE LOGIC like shapes (falls through to bottom return)
 *    - Acts like an "imaginary shape" where outward direction defines the anchor
 *    - Only FACING sides get centerline; non-facing sides stay at raw position
 *    - Critical for direction seeding: allows first segment to escape (N/S)
 *      instead of incorrectly going horizontal to centerline
 *    - Example: start LEFT of shape, inside padded Y, anchor on EAST
 *      → Direction is N (escape up), so E/W are non-facing
 *      → Stub X stays at actual point X, not centerline
 *      → First segment correctly goes vertical
 *
 * 3. SHAPE BOUNDS (anchored endpoints):
 *    - Facing side = centerline (if exists) - shared between both AABBs
 *    - Non-facing sides = raw bound + padding
 *    - Facing determined by spatial relationship to OTHER shape
 *
 * @param raw - This shape's raw bounds (or point)
 * @param other - The OTHER shape's raw bounds (for spatial comparison)
 * @param centerlines - Pre-computed centerlines
 * @param offset - Approach offset for padding
 * @param isAnchoredToFree - True if this is the END point in anchored→free
 * @returns Dynamic routing bounds
 */
function buildRoutingBounds(
  raw: Bounds,
  other: Bounds,
  centerlines: Centerlines,
  offset: number,
  isAnchoredToFree: boolean,
): Bounds {
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
    left:
      facesLeft && centerlines.x !== null ? centerlines.x : isPoint ? raw.left : raw.left - offset,

    right:
      facesRight && centerlines.x !== null
        ? centerlines.x
        : isPoint
          ? raw.right
          : raw.right + offset,

    top: facesTop && centerlines.y !== null ? centerlines.y : isPoint ? raw.top : raw.top - offset,

    bottom:
      facesBottom && centerlines.y !== null
        ? centerlines.y
        : isPoint
          ? raw.bottom
          : raw.bottom + offset,
  };
}

// ============================================================================
// STUB COMPUTATION
// ============================================================================

/**
 * Compute stub position - where A* actually starts/ends.
 *
 * Stub is the intersection of:
 * - The anchor's fixed axis position (e.g., anchor.y for E/W headings)
 * - The routing bounds boundary on the outward direction
 *
 * The bounds boundary already accounts for centerline/padding.
 * This means stubs are ON the centerline when one exists!
 *
 * @param bounds - Dynamic routing bounds (with centerline/padding baked in)
 * @param anchorPos - Actual anchor position [x, y]
 * @param dir - Outward direction (determines which bounds edge to use)
 * @returns Stub position [x, y]
 */
function computeStub(bounds: Bounds, anchorPos: [number, number], dir: Dir): [number, number] {
  const [ax, ay] = anchorPos;

  switch (dir) {
    case 'E':
      return [bounds.right, ay]; // Right boundary, anchor's Y
    case 'W':
      return [bounds.left, ay]; // Left boundary, anchor's Y
    case 'S':
      return [ax, bounds.bottom]; // Anchor's X, bottom boundary
    case 'N':
      return [ax, bounds.top]; // Anchor's X, top boundary
  }
}

// ============================================================================
// GRID CONSTRUCTION
// ============================================================================

/**
 * Build a simple grid from routing context.
 *
 * Grid construction is trivial because routing context already has:
 * - Dynamic AABBs with centerline/padding baked in
 * - Stub positions on AABB boundaries
 *
 * No cell blocking needed - A* handles obstacles via segment intersection.
 *
 * @param ctx - Routing context with pre-computed AABBs and stubs
 * @returns Grid for A* routing
 */
export function buildSimpleGrid(ctx: RoutingContext): Grid {
  // Collect grid lines from AABB edges (Sets auto-dedupe)
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
      cells[yi][xi] = { x: xLines[xi], y: yLines[yi], xi, yi, blocked: false };
    }
  }

  return { cells, xLines, yLines };
}
