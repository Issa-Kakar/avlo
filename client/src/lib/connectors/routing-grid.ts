/**
 * Non-Uniform Grid Construction for A* Routing
 *
 * REDESIGNED GRID PHILOSOPHY:
 * - Lines exist only at positions where routing is valid
 * - Anchored endpoints: single-axis line (perpendicular to snap side)
 * - Unsnapped endpoints: both x and y lines
 * - Shape obstacle: only padding boundary lines (NO edge lines inside blocked zone)
 * - Midpoints for routing flexibility
 *
 * This prevents A* from getting trapped in blocked cells by ensuring
 * grid lines only exist in routable corridors.
 *
 * @module lib/connectors/routing-grid
 */

import { computeApproachOffset } from './constants';
import type { Terminal } from './routing-zroute';
import { computeShapeToShapeSpatial, type Dir } from './shape-utils';

/**
 * Axis-Aligned Bounding Box.
 */
export interface AABB {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Grid cell with position and blocking state.
 */
export interface GridCell {
  /** World X coordinate */
  x: number;
  /** World Y coordinate */
  y: number;
  /** Grid index X */
  xi: number;
  /** Grid index Y */
  yi: number;
  /** True if inside obstacle + padding (not routable) */
  blocked: boolean;
}

/**
 * Non-uniform grid structure.
 */
export interface Grid {
  /** 2D cell array [yi][xi] */
  cells: GridCell[][];
  /** Sorted unique X coordinates */
  xLines: number[];
  /** Sorted unique Y coordinates */
  yLines: number[];
}

// ============================================================================
// FACING SIDES & CENTERLINE COMPUTATION
// ============================================================================

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

/**
 * Compute facing sides between two shapes.
 *
 * Facing sides are the sides of each shape that "look at" each other:
 * - If endShape is to the right of startShape: start's right side faces end's left side
 * - If endShape is below startShape: start's bottom side faces end's top side
 *
 * When shapes have a gap between facing sides, we compute a centerline
 * that will be used instead of both facing side lines in grid construction.
 *
 * @param startBounds - Start shape AABB (or null for free endpoint)
 * @param endBounds - End shape AABB (or null for free endpoint)
 * @param approachOffset - Padding offset for each shape
 * @returns Facing sides with centerlines where applicable
 */
export function computeFacingSides(
  startBounds: AABB | null,
  endBounds: AABB | null,
  approachOffset: number
): FacingSides {
  const result: FacingSides = {
    startFacingX: null,
    endFacingX: null,
    centerlineX: null,
    hasXCenterline: false,
    startFacingY: null,
    endFacingY: null,
    centerlineY: null,
    hasYCenterline: false,
  };

  // Need both shapes to compute facing sides
  if (!startBounds || !endBounds) {
    // For free→anchored: only end shape exists
    // We'll handle this case in grid construction
    return result;
  }

  // Get spatial relationship (uses actual bounds, no padding)
  const spatial = computeShapeToShapeSpatial(startBounds, endBounds);

  // X-axis facing sides (vertical lines)
  if (spatial.endIsRightOf) {
    // End is to the right → start's right faces end's left
    result.startFacingX = startBounds.x + startBounds.w + approachOffset;
    result.endFacingX = endBounds.x - approachOffset;
    // Centerline if there's space between padded boundaries
    if (result.endFacingX > result.startFacingX) {
      // Centerline is midpoint between ACTUAL shape edges, NOT padded boundaries
      const actualStartEdge = startBounds.x + startBounds.w;
      const actualEndEdge = endBounds.x;
      result.centerlineX = (actualStartEdge + actualEndEdge) / 2;
      result.hasXCenterline = true;
    }
  } else if (spatial.endIsLeftOf) {
    // End is to the left → start's left faces end's right
    result.startFacingX = startBounds.x - approachOffset;
    result.endFacingX = endBounds.x + endBounds.w + approachOffset;
    // Centerline if there's space between padded boundaries
    if (result.startFacingX > result.endFacingX) {
      // Centerline is midpoint between ACTUAL shape edges, NOT padded boundaries
      const actualStartEdge = startBounds.x;
      const actualEndEdge = endBounds.x + endBounds.w;
      result.centerlineX = (actualStartEdge + actualEndEdge) / 2;
      result.hasXCenterline = true;
    }
  }
  // If overlapX: no facing sides on X axis

  // Y-axis facing sides (horizontal lines)
  if (spatial.endIsBelow) {
    // End is below → start's bottom faces end's top
    result.startFacingY = startBounds.y + startBounds.h + approachOffset;
    result.endFacingY = endBounds.y - approachOffset;
    // Centerline if there's space between padded boundaries
    if (result.endFacingY > result.startFacingY) {
      // Centerline is midpoint between ACTUAL shape edges, NOT padded boundaries
      const actualStartEdge = startBounds.y + startBounds.h;
      const actualEndEdge = endBounds.y;
      result.centerlineY = (actualStartEdge + actualEndEdge) / 2;
      result.hasYCenterline = true;
    }
  } else if (spatial.endIsAbove) {
    // End is above → start's top faces end's bottom
    result.startFacingY = startBounds.y ;
    result.endFacingY = endBounds.y + endBounds.h;
    // Centerline if there's space between padded boundaries
    if (result.startFacingY > result.endFacingY) {
      // Centerline is midpoint between ACTUAL shape edges, NOT padded boundaries
      const actualStartEdge = startBounds.y;
      const actualEndEdge = endBounds.y + endBounds.h;
      result.centerlineY = (actualStartEdge + actualEndEdge) / 2;
      result.hasYCenterline = true;
    }
  }
  // If overlapY: no facing sides on Y axis

  return result;
}

/**
 * Compute facing sides from a free point to an anchored shape.
 *
 * For Z-route scenarios (same side + primary axis), we compute a centerline
 * between the free start point and the target shape's facing side.
 *
 * This only generates a centerline when:
 * - Start is on the same side as anchor's opposite (Z-route scenario)
 * - The start is beyond the shape's padded facing side
 *
 * @param startPos - Free endpoint position [x, y]
 * @param endBounds - Target shape AABB
 * @param anchorDir - Direction the anchor faces (outwardDir)
 * @param approachOffset - Padding offset for the shape
 * @returns FacingSides with centerline if applicable
 */
function computeFacingSidesFromPoint(
  startPos: [number, number],
  endBounds: AABB,
  anchorDir: Dir,
  approachOffset: number
): FacingSides {
  const result: FacingSides = {
    startFacingX: null,
    endFacingX: null,
    centerlineX: null,
    hasXCenterline: false,
    startFacingY: null,
    endFacingY: null,
    centerlineY: null,
    hasYCenterline: false,
  };

  const [px, py] = startPos;
  const { x, y, w, h } = endBounds;

  const anchorIsHorizontal = anchorDir === 'E' || anchorDir === 'W';

  if (anchorIsHorizontal) {
    // Anchor is E or W → check X-axis relationship for centerline
    const shapeFacingX = anchorDir === 'W' ? x - approachOffset : x + w + approachOffset;
    // Z-route condition: start is beyond the shape's padded facing side
    const startBeyondFacing = anchorDir === 'W' ? px < shapeFacingX : px > shapeFacingX;

    if (startBeyondFacing) {
      // Compute centerline between start point and shape's actual edge
      const shapeEdgeX = anchorDir === 'W' ? x : x + w;
      result.startFacingX = px; // Point's X (notional "facing side")
      result.endFacingX = shapeFacingX;
      result.centerlineX = (px + shapeEdgeX) / 2;
      result.hasXCenterline = true;
    }
  } else {
    // Anchor is N or S → check Y-axis relationship for centerline
    const shapeFacingY = anchorDir === 'N' ? y - approachOffset : y + h + approachOffset;
    const startBeyondFacing = anchorDir === 'N' ? py < shapeFacingY : py > shapeFacingY;

    if (startBeyondFacing) {
      const shapeEdgeY = anchorDir === 'N' ? y : y + h;
      result.startFacingY = py;
      result.endFacingY = shapeFacingY;
      result.centerlineY = (py + shapeEdgeY) / 2;
      result.hasYCenterline = true;
    }
  }

  return result;
}

/**
 * Compute facing sides from an anchored shape to a free point.
 * Inverse of computeFacingSidesFromPoint - the shape is the start, point is the end.
 *
 * For anchored→free routing, computes centerline between start shape's facing side
 * and the free endpoint when:
 * 1. The endpoint is beyond the shape's padded boundary
 * 2. The primary axis (from approach to endpoint) matches the anchor's axis (Z-route valid)
 *
 * This mirrors the logic in computeFreeStartDirection() to ensure consistent
 * Z-route vs L-route selection for both free→anchored and anchored→free cases.
 *
 * @param startBounds - Start shape AABB
 * @param endPos - Free endpoint position [x, y]
 * @param startDir - Direction the start anchor faces (from.outwardDir)
 * @param approachOffset - Padding offset for the shape
 * @param fromApproach - Start approach point (for computing primary axis)
 * @returns FacingSides with centerline if applicable
 */
function computeFacingSidesToPoint(
  startBounds: AABB,
  endPos: [number, number],
  startDir: Dir,
  approachOffset: number,
  fromApproach: [number, number]
): FacingSides {
  const result: FacingSides = {
    startFacingX: null,
    endFacingX: null,
    centerlineX: null,
    hasXCenterline: false,
    startFacingY: null,
    endFacingY: null,
    centerlineY: null,
    hasYCenterline: false,
  };

  const [px, py] = endPos;
  const { x, y, w, h } = startBounds;

  // Compute primary axis from approach to endpoint (mirrors computeFreeStartDirection)
  const dx = px - fromApproach[0];
  const dy = py - fromApproach[1];
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  const primaryAxis: 'H' | 'V' = ax >= ay ? 'H' : 'V';

  const startDirIsHorizontal = startDir === 'E' || startDir === 'W';

  // Z-route only valid when primary axis matches anchor axis
  // This prevents HVH Z-routes when vertical is dominant (should be HV L-route)
  const zRouteValid = (startDirIsHorizontal && primaryAxis === 'H') ||
                      (!startDirIsHorizontal && primaryAxis === 'V');

  if (startDirIsHorizontal) {
    // Start anchor is E or W → check X-axis relationship for centerline
    const shapeFacingX = startDir === 'E' ? x + w + approachOffset : x - approachOffset;
    // Centerline condition: point is beyond the shape's padded facing side AND Z-route is valid
    const pointBeyondFacing = startDir === 'E' ? px > shapeFacingX : px < shapeFacingX;

    if (pointBeyondFacing && zRouteValid) {
      // Compute centerline between shape's actual edge and the point
      const shapeEdgeX = startDir === 'E' ? x + w : x;
      result.startFacingX = shapeFacingX;
      result.endFacingX = px; // Point's X (notional "facing side")
      result.centerlineX = (shapeEdgeX + px) / 2;
      result.hasXCenterline = true;
    }
  } else {
    // Start anchor is N or S → check Y-axis relationship for centerline
    const shapeFacingY = startDir === 'S' ? y + h + approachOffset : y - approachOffset;
    const pointBeyondFacing = startDir === 'S' ? py > shapeFacingY : py < shapeFacingY;

    if (pointBeyondFacing && zRouteValid) {
      const shapeEdgeY = startDir === 'S' ? y + h : y;
      result.startFacingY = shapeFacingY;
      result.endFacingY = py;
      result.centerlineY = (shapeEdgeY + py) / 2;
      result.hasYCenterline = true;
    }
  }

  return result;
}

// ============================================================================
// GRID CONSTRUCTION HELPERS
// ============================================================================

/**
 * Check if a point is strictly inside a rectangle (not on boundary).
 *
 * @param x - Point X
 * @param y - Point Y
 * @param rect - Rectangle bounds
 * @returns true if strictly inside (not on boundary)
 */
function pointStrictlyInsideRect(x: number, y: number, rect: AABB): boolean {
  return x > rect.x && x < rect.x + rect.w && y > rect.y && y < rect.y + rect.h;
}

/**
 * Create cell grid with blocking.
 *
 * BLOCKING STRATEGY:
 * - Block cells strictly inside shape bounds + stroke inflation
 * - Segment intersection checks (in A*) handle the actual crossing prevention
 * - NEVER block start or goal positions
 * - Boundary cells are NOT blocked (they're the valid corridor)
 *
 * @param xLines - Sorted X coordinates
 * @param yLines - Sorted Y coordinates
 * @param obstacles - Array of shape bounds to block
 * @param fromApproach - Start approach point (must not be blocked)
 * @param toApproach - End approach point (must not be blocked)
 * @param strokeWidth - Connector stroke width (affects blocking offset)
 * @param facing - Facing sides info (for stub blocking)
 * @param fromHasShape - True if start endpoint has a shape
 * @param toHasShape - True if end endpoint has a shape
 * @returns Grid structure
 */
function createCellGrid(
  xLines: number[],
  yLines: number[],
  obstacles: AABB[],
  fromApproach: [number, number],
  toApproach: [number, number],
  strokeWidth: number,
  facing: FacingSides | undefined,
  fromHasShape: boolean,
  toHasShape: boolean
): Grid {
  const cells: GridCell[][] = [];

  // Compute blocked bounds for each obstacle (strict bounds + stroke inflation)
  const strokeInflation = strokeWidth * 0.5 + 1; // Match bbox computation
  const blockedBounds: AABB[] = obstacles.map(obs => ({
    x: obs.x - strokeInflation,
    y: obs.y - strokeInflation,
    w: obs.w + strokeInflation * 2,
    h: obs.h + strokeInflation * 2,
  }));

  for (let yi = 0; yi < yLines.length; yi++) {
    cells[yi] = [];
    for (let xi = 0; xi < xLines.length; xi++) {
      const cellX = xLines[xi];
      const cellY = yLines[yi];

      // Cell is blocked if strictly INSIDE ANY obstacle's blocked bounds
      // (NOT on boundary - boundary is valid routing corridor)
      let blocked = blockedBounds.some(bounds =>
        pointStrictlyInsideRect(cellX, cellY, bounds)
      );

      // NEVER block start or goal approach positions - A* needs to reach them
      if (blocked) {
        const eps = 0.001;
        const isStart = Math.abs(cellX - fromApproach[0]) < eps && Math.abs(cellY - fromApproach[1]) < eps;
        const isGoal = Math.abs(cellX - toApproach[0]) < eps && Math.abs(cellY - toApproach[1]) < eps;
        if (isStart || isGoal) {
          blocked = false;
        }
      }

      cells[yi][xi] = {
        x: cellX,
        y: cellY,
        xi,
        yi,
        blocked,
      };
    }
  }

  // Block facing side cells to create "stubs" (if facing sides were computed)
  if (facing) {
    blockFacingSideCells(cells, xLines, yLines, facing, fromApproach, toApproach, fromHasShape, toHasShape);
  }

  return { cells, xLines, yLines };
}

/**
 * Block cells along facing side lines, except for the anchor cells.
 *
 * This creates a "stub" effect - routes can reach the anchor cell but cannot
 * travel parallel along the facing side line. Forces routes to use the
 * centerline instead.
 *
 * IMPORTANT: Only blocks facing lines for endpoints that have shapes!
 * - endFacingX/Y only blocked if toHasShape (prevents blocking free point coords)
 * - startFacingX/Y only blocked if fromHasShape (prevents blocking free point coords)
 *
 * @param cells - 2D cell array to modify in place
 * @param xLines - Sorted X coordinates
 * @param yLines - Sorted Y coordinates
 * @param facing - Facing sides info (must have centerline)
 * @param fromApproach - Start approach position (to identify cell to keep unblocked)
 * @param toApproach - Goal approach position (to identify cell to keep unblocked)
 * @param fromHasShape - True if start endpoint has a shape (from.shapeBounds exists)
 * @param toHasShape - True if end endpoint has a shape (to.shapeBounds exists)
 */
function blockFacingSideCells(
  cells: GridCell[][],
  xLines: number[],
  yLines: number[],
  facing: FacingSides,
  fromApproach: [number, number],
  toApproach: [number, number],
  fromHasShape: boolean,
  toHasShape: boolean
): void {
  const eps = 0.001;

  // === BLOCK END FACING LINES (only if TO has a shape) ===
  // For free→anchored: to.shapeBounds exists, so we block endFacingX/Y (shape's facing side)
  // For anchored→free: to.shapeBounds is null, so we DON'T block endFacingX/Y (would block free point's coord!)

  if (toHasShape) {
    // Block vertical facing line (endFacingX) - all cells except the goal
    if (facing.hasXCenterline && facing.endFacingX !== null) {
      const xi = xLines.findIndex(x => Math.abs(x - facing.endFacingX!) < eps);
      if (xi >= 0) {
        for (let yi = 0; yi < yLines.length; yi++) {
          const cell = cells[yi][xi];
          // Don't block the goal cell itself
          if (Math.abs(cell.y - toApproach[1]) >= eps) {
            cell.blocked = true;
          }
        }
      }
    }

    // Block horizontal facing line (endFacingY) - all cells except the goal
    if (facing.hasYCenterline && facing.endFacingY !== null) {
      const yi = yLines.findIndex(y => Math.abs(y - facing.endFacingY!) < eps);
      if (yi >= 0) {
        for (let xi = 0; xi < xLines.length; xi++) {
          const cell = cells[yi][xi];
          // Don't block the goal cell itself
          if (Math.abs(cell.x - toApproach[0]) >= eps) {
            cell.blocked = true;
          }
        }
      }
    }
  }

  // === BLOCK START FACING LINES (only if FROM has a shape) ===
  // For anchored→free: from.shapeBounds exists, so we block startFacingX/Y (shape's facing side)
  // For free→anchored: from.shapeBounds is null, so we DON'T block startFacingX/Y (would block free point's coord!)

  if (fromHasShape && toHasShape) {
    // Block vertical facing line (startFacingX) - all cells except the start
    if (facing.hasXCenterline && facing.startFacingX !== null) {
      const xi = xLines.findIndex(x => Math.abs(x - facing.startFacingX!) < eps);
      if (xi >= 0) {
        for (let yi = 0; yi < yLines.length; yi++) {
          const cell = cells[yi][xi];
          // Don't block the start cell itself
          if (Math.abs(cell.y - fromApproach[1]) >= eps) {
            cell.blocked = true;
          }
        }
      }
    }

    // Block horizontal facing line (startFacingY) - all cells except the start
    if (facing.hasYCenterline && facing.startFacingY !== null) {
      const yi = yLines.findIndex(y => Math.abs(y - facing.startFacingY!) < eps);
      if (yi >= 0) {
        for (let xi = 0; xi < xLines.length; xi++) {
          const cell = cells[yi][xi];
          // Don't block the start cell itself
          if (Math.abs(cell.x - fromApproach[0]) >= eps) {
            cell.blocked = true;
          }
        }
      }
    }
  }

  // === BLOCK END FACING LINES FOR Z-ROUTE FORCING (anchored→free) ===
  // When start is anchored and end is free, but we have a centerline,
  // we need to block endFacingY/X to prevent VH L-routes and force VHV Z-routes.
  // This mirrors the free→anchored behavior where we block the goal's facing side.
  //
  // Without this: A* chooses VH (1 bend) over VHV (2 bends) due to bend penalty.
  // With this: VH path is blocked at (startX, goalY), forcing VHV through centerline.

  if (fromHasShape && !toHasShape) {
    // Block endFacingX if X centerline exists (horizontal anchor E/W)
    if (facing.hasXCenterline && facing.endFacingX !== null) {
      const xi = xLines.findIndex(x => Math.abs(x - facing.endFacingX!) < eps);
      if (xi >= 0) {
        for (let yi = 0; yi < yLines.length; yi++) {
          const cell = cells[yi][xi];
          // Don't block the goal cell itself
          if (Math.abs(cell.y - toApproach[1]) >= eps) {
            cell.blocked = true;
          }
        }
      }
    }

    // Block endFacingY if Y centerline exists (vertical anchor N/S)
    if (facing.hasYCenterline && facing.endFacingY !== null) {
      const yi = yLines.findIndex(y => Math.abs(y - facing.endFacingY!) < eps);
      if (yi >= 0) {
        for (let xi = 0; xi < xLines.length; xi++) {
          const cell = cells[yi][xi];
          // Don't block the goal cell itself
          if (Math.abs(cell.x - toApproach[0]) >= eps) {
            cell.blocked = true;
          }
        }
      }
    }
  }
}

/**
 * Build non-uniform grid for A* routing.
 *
 * GRID LINE PHILOSOPHY:
 * - Lines exist only at positions where routing is valid
 * - Anchored endpoints: single axis at approach point (perpendicular to snap side)
 * - Unsnapped endpoints: both axes at position
 * - Shape obstacle: ONLY padding boundary lines (NO shape edge lines)
 * - Centerlines between facing sides when applicable
 *
 * Supports all endpoint combinations:
 * - Free→Anchored: Centerline from free point to shape
 * - Anchored→Free: Centerline from shape to free point
 * - Anchored→Anchored: Centerline between two shapes
 *
 * @param from - Start terminal
 * @param to - End terminal
 * @param fromApproach - Start approach point (where route begins in grid)
 * @param toApproach - End approach point (where route ends in grid)
 * @param strokeWidth - Connector stroke width (affects grid line placement)
 * @param _startInsidePadding - DEPRECATED: no longer used, kept for API compatibility
 * @returns Grid for A* routing
 */
export function buildNonUniformGrid(
  from: Terminal,
  to: Terminal,
  fromApproach: [number, number],
  toApproach: [number, number],
  strokeWidth: number,
  _startInsidePadding?: boolean
): Grid {
  const xLines: number[] = [];
  const yLines: number[] = [];

  const approachOffset = computeApproachOffset(strokeWidth);

  // === 1. FROM endpoint ===
  // Anchored: single axis at approach point
  // Free: both axes at position
  if (from.isAnchored && from.shapeBounds) {
    const { x, y, w, h } = from.shapeBounds;

    // Add approach position lines
    xLines.push(fromApproach[0]);
    yLines.push(fromApproach[1]);

    // Add goal position at padding boundary (for start cell finding)
    if (from.outwardDir === 'N' || from.outwardDir === 'S') {
      const startY = from.outwardDir === 'N' ? y - approachOffset : y + h + approachOffset;
      yLines.push(startY);
    } else {
      const startX = from.outwardDir === 'E' ? x + w + approachOffset : x - approachOffset;
      xLines.push(startX);
    }
  } else {
    // Unsnapped: both axes at position
    xLines.push(from.position[0]);
    yLines.push(from.position[1]);
  }

  // === 2. TO endpoint (goal at padding intersection) ===
  if (to.isAnchored && to.shapeBounds) {
    const { x, y, w, h } = to.shapeBounds;

    // Goal is at intersection of anchor's fixed axis and padding boundary
    if (to.outwardDir === 'N' || to.outwardDir === 'S') {
      // Vertical approach: fixed X from anchor, Y from padding boundary
      xLines.push(to.position[0]);
      const goalY = to.outwardDir === 'N' ? y - approachOffset : y + h + approachOffset;
      yLines.push(goalY);
    } else {
      // Horizontal approach: fixed Y from anchor, X from padding boundary
      yLines.push(to.position[1]);
      const goalX = to.outwardDir === 'E' ? x + w + approachOffset : x - approachOffset;
      xLines.push(goalX);
    }
  } else {
    // Unsnapped TO: both axes at position
    xLines.push(to.position[0]);
    yLines.push(to.position[1]);
  }

  // === 3. Compute facing sides based on endpoint types ===
  let facing: FacingSides;

  if (from.shapeBounds && to.shapeBounds) {
    // Anchored→Anchored: compute centerlines between both shapes
    facing = computeFacingSides(from.shapeBounds, to.shapeBounds, approachOffset);
  } else if (!from.isAnchored && to.shapeBounds) {
    // Free→Anchored: compute centerline from point to shape (for Z-routes)
    facing = computeFacingSidesFromPoint(from.position, to.shapeBounds, to.outwardDir, approachOffset);
  } else if (from.shapeBounds && !to.isAnchored) {
    // Anchored→Free: compute centerline from shape to point (with axis dominance check)
    facing = computeFacingSidesToPoint(from.shapeBounds, to.position, from.outwardDir, approachOffset, fromApproach);
  } else {
    // Both free: no facing sides
    facing = {
      startFacingX: null, endFacingX: null, centerlineX: null, hasXCenterline: false,
      startFacingY: null, endFacingY: null, centerlineY: null, hasYCenterline: false,
    };
  }

  // === 4. Add obstacle padding boundary lines ===
  if (to.shapeBounds) {
    const { x, y, w, h } = to.shapeBounds;

    // X-axis lines: use centerline or both padding boundaries
    if (facing.hasXCenterline) {
      // MERGE: Use centerline instead of both facing sides
      xLines.push(facing.centerlineX!);
      // Add only the exterior (non-facing) side of end shape
      if (facing.endFacingX === x - approachOffset) {
        // End's left is facing → add right (exterior)
        xLines.push(x + w + approachOffset);
      } else {
        // End's right is facing → add left (exterior)
        xLines.push(x - approachOffset);
      }
    } else {
      // No centerline: add all padding boundaries (original behavior)
      xLines.push(x - approachOffset, x + w + approachOffset);
    }

    // Y-axis lines: use centerline or both padding boundaries
    if (facing.hasYCenterline) {
      // MERGE: Use centerline instead of both facing sides
      yLines.push(facing.centerlineY!);
      // Add only the exterior (non-facing) side of end shape
      if (facing.endFacingY === y - approachOffset) {
        // End's top is facing → add bottom (exterior)
        yLines.push(y + h + approachOffset);
      } else {
        // End's bottom is facing → add top (exterior)
        yLines.push(y - approachOffset);
      }
    } else {
      // No centerline: add all padding boundaries (original behavior)
      yLines.push(y - approachOffset, y + h + approachOffset);
    }
  }

  if (from.shapeBounds && from.shapeBounds !== to.shapeBounds) {
    const { x, y, w, h } = from.shapeBounds;

    // X-axis lines for start shape
    if (facing.hasXCenterline) {
      // Add centerline if not already added by to.shapeBounds block
      // (For anchored→free: to.shapeBounds is null, so centerline wasn't added above)
      if (!to.shapeBounds) {
        xLines.push(facing.centerlineX!);
      }
      // Add only the exterior (non-facing) side of start shape
      if (facing.startFacingX === x + w + approachOffset) {
        // Start's right is facing → add left (exterior)
        xLines.push(x - approachOffset);
      } else {
        // Start's left is facing → add right (exterior)
        xLines.push(x + w + approachOffset);
      }
    } else {
      xLines.push(x - approachOffset, x + w + approachOffset);
    }

    // Y-axis lines for start shape
    if (facing.hasYCenterline) {
      // Add centerline if not already added by to.shapeBounds block
      // (For anchored→free: to.shapeBounds is null, so centerline wasn't added above)
      if (!to.shapeBounds) {
        yLines.push(facing.centerlineY!);
      }
      // Add only the exterior (non-facing) side of start shape
      if (facing.startFacingY === y + h + approachOffset) {
        // Start's bottom is facing → add top (exterior)
        yLines.push(y - approachOffset);
      } else {
        // Start's top is facing → add bottom (exterior)
        yLines.push(y + h + approachOffset);
      }
    } else {
      yLines.push(y - approachOffset, y + h + approachOffset);
    }
  }

  // === 5. Dedupe and sort ===
  const xSorted = [...new Set(xLines)].sort((a, b) => a - b);
  const ySorted = [...new Set(yLines)].sort((a, b) => a - b);

  // === 6. Collect obstacles for cell blocking ===
  const obstacles: AABB[] = [];
  if (to.shapeBounds) {
    obstacles.push(to.shapeBounds);
  }
  if (from.shapeBounds && from.shapeBounds !== to.shapeBounds) {
    obstacles.push(from.shapeBounds);
  }
  
  // === 7. Build cell grid ===
  return createCellGrid(
    xSorted,
    ySorted,
    obstacles,
    fromApproach,
    toApproach,
    strokeWidth,
    facing,
    !!from.shapeBounds,
    !!to.shapeBounds
  );
}

/**
 * Find nearest cell index for a given coordinate.
 *
 * @param lines - Sorted array of grid line coordinates
 * @param target - Target coordinate
 * @returns Index of nearest line
 */
export function findNearestIndex(lines: number[], target: number): number {
  let bestIdx = 0;
  let bestDist = Infinity;

  for (let i = 0; i < lines.length; i++) {
    const dist = Math.abs(lines[i] - target);
    if (dist < bestDist) {
      bestDist = dist;
      bestIdx = i;
    }
  }

  return bestIdx;
}

/**
 * Find the nearest grid cell for a world position.
 *
 * @param grid - The grid to search
 * @param pos - World position
 * @returns Nearest grid cell
 */
export function findNearestCell(grid: Grid, pos: [number, number]): GridCell {
  const xi = findNearestIndex(grid.xLines, pos[0]);
  const yi = findNearestIndex(grid.yLines, pos[1]);
  return grid.cells[yi][xi];
}

/**
 * Get 4-connected neighbors (N, E, S, W) for a cell.
 *
 * @param grid - The grid
 * @param cell - Current cell
 * @returns Array of neighbor cells
 */
export function getNeighbors(grid: Grid, cell: GridCell): GridCell[] {
  const neighbors: GridCell[] = [];
  const { xi, yi } = cell;

  // North (yi - 1)
  if (yi > 0) {
    neighbors.push(grid.cells[yi - 1][xi]);
  }
  // East (xi + 1)
  if (xi < grid.xLines.length - 1) {
    neighbors.push(grid.cells[yi][xi + 1]);
  }
  // South (yi + 1)
  if (yi < grid.yLines.length - 1) {
    neighbors.push(grid.cells[yi + 1][xi]);
  }
  // West (xi - 1)
  if (xi > 0) {
    neighbors.push(grid.cells[yi][xi - 1]);
  }

  return neighbors;
}
