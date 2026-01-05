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
import { computeShapeToShapeSpatial } from './shape-utils';

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
    // Centerline if there's space
    if (result.endFacingX > result.startFacingX) {
      result.centerlineX = (result.startFacingX + result.endFacingX) / 2;
      result.hasXCenterline = true;
    }
  } else if (spatial.endIsLeftOf) {
    // End is to the left → start's left faces end's right
    result.startFacingX = startBounds.x - approachOffset;
    result.endFacingX = endBounds.x + endBounds.w + approachOffset;
    // Centerline if there's space
    if (result.startFacingX > result.endFacingX) {
      result.centerlineX = (result.startFacingX + result.endFacingX) / 2;
      result.hasXCenterline = true;
    }
  }
  // If overlapX: no facing sides on X axis

  // Y-axis facing sides (horizontal lines)
  if (spatial.endIsBelow) {
    // End is below → start's bottom faces end's top
    result.startFacingY = startBounds.y + startBounds.h + approachOffset;
    result.endFacingY = endBounds.y - approachOffset;
    // Centerline if there's space
    if (result.endFacingY > result.startFacingY) {
      result.centerlineY = (result.startFacingY + result.endFacingY) / 2;
      result.hasYCenterline = true;
    }
  } else if (spatial.endIsAbove) {
    // End is above → start's top faces end's bottom
    result.startFacingY = startBounds.y - approachOffset;
    result.endFacingY = endBounds.y + endBounds.h + approachOffset;
    // Centerline if there's space
    if (result.startFacingY > result.endFacingY) {
      result.centerlineY = (result.startFacingY + result.endFacingY) / 2;
      result.hasYCenterline = true;
    }
  }
  // If overlapY: no facing sides on Y axis

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
 * - Dynamic blocking based on start position:
 *   - If starting inside padded region: block only shape bounds + stroke inflation
 *     This creates a corridor between shape edge and padding boundary
 *   - If starting outside: block full padded bounds (normal behavior)
 * - NEVER block start or goal positions
 * - Boundary cells are NOT blocked (they're the valid corridor)
 *
 * @param xLines - Sorted X coordinates
 * @param yLines - Sorted Y coordinates
 * @param obstacle - Shape bounds to block (if any)
 * @param startPos - Start position (must not be blocked)
 * @param goalPos - Goal position (must not be blocked)
 * @param fromApproach - Start approach point (must not be blocked)
 * @param toApproach - End approach point (must not be blocked)
 * @param strokeWidth - Connector stroke width (affects blocking offset)
 * @param startInsidePadding - If true, use smaller blocking (shape + stroke only)
 * @returns Grid structure
 */
function createCellGrid(
  xLines: number[],
  yLines: number[],
  obstacle: AABB | null,
  startPos: [number, number],
  goalPos: [number, number],
  fromApproach: [number, number],
  toApproach: [number, number],
  strokeWidth: number,
  startInsidePadding?: boolean
): Grid {
  const cells: GridCell[][] = [];

  // DYNAMIC BLOCKING BOUNDS
  // When starting inside padded region, use smaller bounds to create escape corridor
  const approachOffset = computeApproachOffset(strokeWidth);
  const strokeInflation = strokeWidth * 0.5 + 1; // Match bbox computation

  let blockedBounds: AABB | null = null;
  if (obstacle) {
    if (startInsidePadding || !startInsidePadding) {
      // Use shape bounds + stroke inflation only (creates corridor for escape)
      blockedBounds = {
        x: obstacle.x - strokeInflation,
        y: obstacle.y - strokeInflation,
        w: obstacle.w + strokeInflation * 2,
        h: obstacle.h + strokeInflation * 2,
      };
    } else {
      // Use full padded bounds (normal behavior)
      blockedBounds = {
        x: obstacle.x - approachOffset,
        y: obstacle.y - approachOffset,
        w: obstacle.w + approachOffset * 2,
        h: obstacle.h + approachOffset * 2,
      };
    }
  }

  for (let yi = 0; yi < yLines.length; yi++) {
    cells[yi] = [];
    for (let xi = 0; xi < xLines.length; xi++) {
      const cellX = xLines[xi];
      const cellY = yLines[yi];

      // Cell is blocked if strictly INSIDE the computed bounds
      // (NOT on boundary - boundary is valid routing corridor)
      let blocked = blockedBounds ? pointStrictlyInsideRect(cellX, cellY, blockedBounds) : false;
      // NEVER block start, goal, or approach positions - A* needs to reach them
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
  return { cells, xLines, yLines };
}

/**
 * Build non-uniform grid for A* routing.
 *
 * GRID LINE PHILOSOPHY:
 * - Lines exist only at positions where routing is valid
 * - Anchored endpoints: single axis at approach point (perpendicular to snap side)
 * - Unsnapped endpoints: both axes at position
 * - Shape obstacle: ONLY padding boundary lines (NO shape edge lines)
 * - Midpoints for routing flexibility
 *
 * DYNAMIC BLOCKING:
 * - When startInsidePadding is true, blocking uses smaller bounds (shape + stroke)
 *   to create escape corridor for same-side scenarios
 * - When false (default), uses full padded bounds
 *
 * @param from - Start terminal
 * @param to - End terminal
 * @param fromApproach - Start approach point (where route begins in grid)
 * @param toApproach - End approach point (where route ends in grid)
 * @param strokeWidth - Connector stroke width (affects grid line placement)
 * @param startInsidePadding - If true, use smaller blocking bounds
 * @returns Grid for A* routing
 */
export function buildNonUniformGrid(
  from: Terminal,
  to: Terminal,
  fromApproach: [number, number],
  toApproach: [number, number],
  strokeWidth: number,
  startInsidePadding?: boolean
): Grid {
  const xLines: number[] = [];
  const yLines: number[] = [];

  const approachOffset = computeApproachOffset(strokeWidth);

  // === 1. FROM endpoint ===
  // Anchored: single axis at approach point
  // Free: both axes at position
  if (from.isAnchored) {
    if (from.outwardDir === 'N' || from.outwardDir === 'S') {
      // Vertical exit → only Y line at approach point
      yLines.push(fromApproach[1]);
      xLines.push(fromApproach[0]);
    } else {
      // Horizontal exit → only X line at approach point
      xLines.push(fromApproach[0]);
      yLines.push(fromApproach[1]);
    }
  } else {
    // Unsnapped: both axes at position
    xLines.push(from.position[0]);
    yLines.push(from.position[1]);
  }

  // === 2. TO endpoint (goal at padding intersection) ===
  if (to.isAnchored && to.shapeBounds) {
    const {x, y, w, h } = to.shapeBounds;

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
  // === 3. Obstacle padding boundaries with centerline merging ===
  // Compute facing sides for anchored→anchored cases
  // Free→anchored uses direction seeding instead (handled in routing-astar.ts)
  let facing: FacingSides;

  if (from.shapeBounds && to.shapeBounds) {
    // Anchored→Anchored: compute centerlines between both shapes
    facing = computeFacingSides(from.shapeBounds, to.shapeBounds, approachOffset);
  } else {
    // Free→Anchored or both free: no facing sides, use midpoint-based routing
    facing = {
      startFacingX: null, endFacingX: null, centerlineX: null, hasXCenterline: false,
      startFacingY: null, endFacingY: null, centerlineY: null, hasYCenterline: false,
    };
  }

  if (to.shapeBounds) {
    const { x, y, w, h } = to.shapeBounds;

    // X-axis lines: use centerline or both padding boundaries
    if (facing.hasXCenterline) {
      // MERGE: Use centerline instead of both facing sides
      xLines.push(facing.centerlineX!);
      // Add only the exterior (non-facing) side of end shape
      // If endIsRightOf: end's right side is exterior
      // If endIsLeftOf: end's left side is exterior
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
      // Centerline already added above
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
      // Centerline already added above
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

  // === 4. Midpoints for routing flexibility ===
  // Only add midpoints if no centerline exists on that axis
  // (centerlines ARE the preferred midpoints)
  if (!facing.hasXCenterline) {
    const midX = (fromApproach[0] + toApproach[0]) / 2;
    xLines.push(midX);
  }
  if (!facing.hasYCenterline) {
    const midY = (fromApproach[1] + toApproach[1]) / 2;
    yLines.push(midY);
  }

  // === 5. Dedupe and sort ===
  const xSorted = [...new Set(xLines)].sort((a, b) => a - b);
  const ySorted = [...new Set(yLines)].sort((a, b) => a - b);

  // === 6. Build cell grid ===
  return createCellGrid(
    xSorted,
    ySorted,
    to.shapeBounds ?? null,
    from.position,
    to.position,
    fromApproach,
    toApproach,
    strokeWidth,
    startInsidePadding
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
