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

import { computeApproachOffset } from './constants';
import type { Terminal } from './routing-zroute';
import {
  type Dir,
  type AABB,
  type Bounds,
  toBounds,
  pointBounds,
  isPointBounds,
  isHorizontal,
} from './shape-utils';

// ============================================================================
// INTERFACES
// ============================================================================

/**
 * Complete routing context with all spatial analysis pre-computed.
 *
 * Grid construction just reads AABB boundaries from this.
 * A* uses stubs as start/goal positions.
 */
export interface RoutingContext {
  // Original terminals (unchanged)
  from: Terminal;
  to: Terminal;

  // Dynamic routing bounds (centerline/padding baked in)
  // These are NOT raw shape bounds - they're the routing AABBs
  startBounds: Bounds;
  endBounds: Bounds;

  // Stub positions - WHERE A* actually starts/ends (ON bounds boundary)
  startStub: [number, number];
  endStub: [number, number];

  // Resolved directions
  startDir: Dir;
  endDir: Dir;

  // Raw shape bounds for obstacle checking (NOT the routing bounds)
  obstacles: AABB[];
}

/**
 * Centerlines between two shapes (if they exist).
 * Computed from RAW bounds - no padding.
 */
interface Centerlines {
  x: number | null; // Vertical centerline (if X gap exists)
  y: number | null; // Horizontal centerline (if Y gap exists)
}

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
 * @param from - Start terminal (direction already resolved)
 * @param to - End terminal (direction already resolved)
 * @param strokeWidth - Connector stroke width (affects offset)
 * @returns Complete routing context
 */
export function createRoutingContext(
  from: Terminal,
  to: Terminal,
  strokeWidth: number
): RoutingContext {
  const offset = computeApproachOffset(strokeWidth);

  // 1. Get raw bounds (shape bounds or point)
  const startRaw = from.shapeBounds ? toBounds(from.shapeBounds) : pointBounds(from.position);
  const endRaw = to.shapeBounds ? toBounds(to.shapeBounds) : pointBounds(to.position);

  // 2. Determine endpoint configuration
  const startIsAnchored = from.isAnchored && !!from.shapeBounds;
  const endIsAnchored = to.isAnchored && !!to.shapeBounds;
  const isFreeToAnchored = !startIsAnchored && endIsAnchored;

  // 3. Compute centerlines from RAW bounds (no padding)
  const centerlines = computeCenterlines(startRaw, endRaw, isFreeToAnchored, offset);

  // 4. Build dynamic routing bounds with centerline/padding
  // Each call determines its own facing sides based on where the OTHER shape is
  const startBounds = buildRoutingBounds(startRaw, endRaw, centerlines, offset);
  const endBounds = buildRoutingBounds(endRaw, startRaw, centerlines, offset);

  // 5. Compute stubs from bounds + direction
  const startStub = computeStub(startBounds, from.position, from.outwardDir);
  const endStub = computeStub(endBounds, to.position, to.outwardDir);

  // 6. Collect obstacles (raw shape bounds only, not routing bounds)
  const obstacles: AABB[] = [];
  if (from.shapeBounds) obstacles.push(from.shapeBounds);
  if (to.shapeBounds && to.shapeBounds !== from.shapeBounds) {
    obstacles.push(to.shapeBounds);
  }

  return {
    from,
    to,
    startBounds,
    endBounds,
    startStub,
    endStub,
    startDir: from.outwardDir,
    endDir: to.outwardDir,
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
 * 2. For free-to-anchored: additional minimum clearance check (offset)
 *
 * Uses RAW bounds - no padding. Centerline is midpoint between actual edges.
 *
 * @param startRaw - Start raw bounds (shape or point)
 * @param endRaw - End raw bounds (shape or point)
 * @param isFreeToAnchored - True if free→anchored case (needs min clearance)
 * @param offset - Approach offset for minimum clearance check
 * @returns Centerlines (null if doesn't exist on that axis)
 */
function computeCenterlines(
  startRaw: Bounds,
  endRaw: Bounds,
  isFreeToAnchored: boolean,
  offset: number
): Centerlines {
  let centerX: number | null = null;
  let centerY: number | null = null;

  // X centerline: exists if no horizontal overlap
  // end is to the RIGHT of start
  if (endRaw.left > startRaw.right) {
    const gap = endRaw.left - startRaw.right;
    centerX = (startRaw.right + endRaw.left) / 2;

    // Free→Anchored minimum clearance check
    if (isFreeToAnchored && gap < offset) {
      centerX = null;
    }
  }
  // start is to the RIGHT of end
  else if (startRaw.left > endRaw.right) {
    const gap = startRaw.left - endRaw.right;
    centerX = (endRaw.right + startRaw.left) / 2;

    if (isFreeToAnchored && gap < offset) {
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
    }
  }
  // start is BELOW end
  else if (startRaw.top > endRaw.bottom) {
    const gap = startRaw.top - endRaw.bottom;
    centerY = (endRaw.bottom + startRaw.top) / 2;

    if (isFreeToAnchored && gap < offset) {
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
 * Two distinct cases:
 *
 * 1. POINT BOUNDS (free endpoints):
 *    - Shift entire point to centerline coordinates when they exist
 *    - Can't use spatial facing logic (point has left === right)
 *    - Enables anchored→free and free→anchored centerline routing
 *
 * 2. SHAPE BOUNDS (anchored endpoints):
 *    - Facing side = centerline (if exists) - shared between both AABBs
 *    - Non-facing sides = raw bound + padding
 *    - Facing determined by spatial relationship to OTHER shape
 *
 * @param raw - This shape's raw bounds (or point)
 * @param other - The OTHER shape's raw bounds (for spatial comparison)
 * @param centerlines - Pre-computed centerlines
 * @param offset - Approach offset for padding
 * @returns Dynamic routing bounds
 */
function buildRoutingBounds(
  raw: Bounds,
  other: Bounds,
  centerlines: Centerlines,
  offset: number
): Bounds {
  // === Point bounds (free endpoints): shift entire point to centerline if exists ===
  // Point-AABBs can't use the facesLeft/facesRight logic because a point has
  // left === right, so spatial comparison is ambiguous. Instead, we simply
  // shift the point to centerline coordinates when they exist.
  if (isPointBounds(raw)) {
    return {
      left: centerlines.x ?? raw.left,
      right: centerlines.x ?? raw.left,
      top: centerlines.y ?? raw.top,
      bottom: centerlines.y ?? raw.top,
    };
  }

  // === Shape bounds: determine facing sides based on spatial relationship ===
  // facesRight: this shape is to the LEFT of other (my right side faces them)
  const facesRight = raw.right <= other.left;
  // facesLeft: this shape is to the RIGHT of other (my left side faces them)
  const facesLeft = raw.left >= other.right;
  // facesBottom: this shape is ABOVE other (my bottom side faces them)
  const facesBottom = raw.bottom <= other.top;
  // facesTop: this shape is BELOW other (my top side faces them)
  const facesTop = raw.top >= other.bottom;

  return {
    // Left: centerline if facing left, else padded outward
    left: facesLeft && centerlines.x !== null ? centerlines.x : raw.left - offset,

    // Top: centerline if facing top, else padded outward
    top: facesTop && centerlines.y !== null ? centerlines.y : raw.top - offset,

    // Right: centerline if facing right, else padded outward
    right: facesRight && centerlines.x !== null ? centerlines.x : raw.right + offset,

    // Bottom: centerline if facing bottom, else padded outward
    bottom: facesBottom && centerlines.y !== null ? centerlines.y : raw.bottom + offset,
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
// GRID LINE HELPERS (used by routing-grid-simple.ts)
// ============================================================================

/**
 * Get grid lines from routing context.
 *
 * Grid construction is trivial:
 * 1. Add all 4 edges from each routing bounds
 * 2. Add stub perpendicular lines (Y for H heading, X for V heading)
 * 3. Dedupe and sort
 *
 * @param ctx - Routing context
 * @returns X and Y line arrays (unsorted, may have duplicates)
 */
export function getGridLinesFromContext(ctx: RoutingContext): {
  xLines: Set<number>;
  yLines: Set<number>;
} {
  const xLines = new Set<number>();
  const yLines = new Set<number>();

  // Add all routing bounds edges
  addBoundsLines(ctx.startBounds, xLines, yLines);
  addBoundsLines(ctx.endBounds, xLines, yLines);

  // Add stub perpendicular lines
  // Horizontal heading (E/W) → need Y line at stub.y
  // Vertical heading (N/S) → need X line at stub.x
  if (isHorizontal(ctx.startDir)) {
    yLines.add(ctx.startStub[1]);
  } else {
    xLines.add(ctx.startStub[0]);
  }

  if (isHorizontal(ctx.endDir)) {
    yLines.add(ctx.endStub[1]);
  } else {
    xLines.add(ctx.endStub[0]);
  }

  return { xLines, yLines };
}

/**
 * Add all 4 edges of bounds to line sets.
 */
function addBoundsLines(b: Bounds, xLines: Set<number>, yLines: Set<number>): void {
  xLines.add(b.left);
  xLines.add(b.right);
  yLines.add(b.top);
  yLines.add(b.bottom);
}
