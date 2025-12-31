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
  _fromApproach: [number, number],
  _toApproach: [number, number],
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
    if (startInsidePadding) {
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
        const isStart = Math.abs(cellX - startPos[0]) < eps && Math.abs(cellY - startPos[1]) < eps;
        const isGoal = Math.abs(cellX - goalPos[0]) < eps && Math.abs(cellY - goalPos[1]) < eps;

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
    } else {
      // Horizontal exit → only X line at approach point
      xLines.push(fromApproach[0]);
    }
  } else {
    // Unsnapped: both axes at position
    xLines.push(from.position[0]);
    yLines.push(from.position[1]);
  }

  // === 2. TO endpoint (goal at padding intersection) ===
  if (to.isAnchored && to.shapeBounds) {
    const { y, h } = to.shapeBounds;

    // Goal is at intersection of anchor's fixed axis and padding boundary
    if (to.outwardDir === 'N' || to.outwardDir === 'S') {
      // Vertical approach: fixed X from anchor, Y from padding boundary
      xLines.push(toApproach[0]);
      const goalY = to.outwardDir === 'N' ? y - approachOffset : y + h + approachOffset;
      yLines.push(goalY);
    } else {
      // Horizontal approach: fixed Y from anchor, X from padding boundary
      yLines.push(toApproach[1]);
      xLines.push(toApproach[0]);
    }
  } else {
    // Unsnapped TO: both axes at position
    xLines.push(to.position[0]);
    yLines.push(to.position[1]);
  }

  // === 3. Obstacle padding boundaries ===
  if (to.shapeBounds) {
    const { x, y, w, h } = to.shapeBounds;
    // Full padding boundary lines
    xLines.push(x - approachOffset, x + w + approachOffset);
    yLines.push(y - approachOffset, y + h + approachOffset);
  }

  if (from.shapeBounds && from.shapeBounds !== to.shapeBounds) {
    const { x, y, w, h } = from.shapeBounds;
    xLines.push(x - approachOffset, x + w + approachOffset);
    yLines.push(y - approachOffset, y + h + approachOffset);
  }

  // === 4. Midpoints for routing flexibility ===
  const midX = (fromApproach[0] + toApproach[0]) / 2;
  const midY = (fromApproach[1] + toApproach[1]) / 2;
  xLines.push(midX);
  yLines.push(midY);

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
function findNearestIndex(lines: number[], target: number): number {
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
