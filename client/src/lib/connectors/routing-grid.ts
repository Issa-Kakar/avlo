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
 * - Block cells strictly INSIDE the padded obstacle bounds
 * - NEVER block start or goal positions (jetty or endpoint positions)
 * - Padding boundary cells are NOT blocked (they're the valid corridor)
 *
 * @param xLines - Sorted X coordinates
 * @param yLines - Sorted Y coordinates
 * @param obstacle - Shape bounds to block (if any)
 * @param startPos - Start position (must not be blocked)
 * @param goalPos - Goal position (must not be blocked)
 * @param fromJetty - Start jetty position (must not be blocked)
 * @param toJetty - End jetty position (must not be blocked)
 * @param strokeWidth - Connector stroke width (affects blocking offset)
 * @returns Grid structure
 */
function createCellGrid(
  xLines: number[],
  yLines: number[],
  obstacle: AABB | null,
  startPos: [number, number],
  goalPos: [number, number],
  fromJetty: [number, number],
  toJetty: [number, number],
  strokeWidth: number
): Grid {
  const cells: GridCell[][] = [];

  // Compute padded obstacle bounds for blocking
  const approachOffset = computeApproachOffset(strokeWidth);
  const blockedBounds: AABB | null = obstacle
    ? {
        x: obstacle.x - approachOffset,
        y: obstacle.y - approachOffset,
        w: obstacle.w + approachOffset * 2,
        h: obstacle.h + approachOffset * 2,
      }
    : null;

  for (let yi = 0; yi < yLines.length; yi++) {
    cells[yi] = [];
    for (let xi = 0; xi < xLines.length; xi++) {
      const cellX = xLines[xi];
      const cellY = yLines[yi];

      // Cell is blocked if strictly INSIDE the padded bounds
      // (NOT on boundary - boundary is valid routing corridor)
      let blocked = blockedBounds ? pointStrictlyInsideRect(cellX, cellY, blockedBounds) : false;

      // NEVER block start, goal, or jetty positions - A* needs to reach them
      if (blocked) {
        const eps = 0.001;
        const isStart = Math.abs(cellX - startPos[0]) < eps && Math.abs(cellY - startPos[1]) < eps;
        const isGoal = Math.abs(cellX - goalPos[0]) < eps && Math.abs(cellY - goalPos[1]) < eps;
        const isFromJetty = Math.abs(cellX - fromJetty[0]) < eps && Math.abs(cellY - fromJetty[1]) < eps;
        const isToJetty = Math.abs(cellX - toJetty[0]) < eps && Math.abs(cellY - toJetty[1]) < eps;

        if (isStart || isGoal || isFromJetty || isToJetty) {
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
  console.log('xLines', xLines);
  console.log('yLines', yLines);
  console.log('cells', cells);
  return { cells, xLines, yLines };
}

/**
 * Build non-uniform grid for A* routing.
 *
 * GRID LINE PHILOSOPHY:
 * - Lines exist only at positions where routing is valid
 * - Anchored endpoints: position + jetty (both axes needed for path assembly)
 * - Unsnapped endpoints: position (jetty = position when offset = 0)
 * - Shape obstacle: ONLY padding boundary lines (NO shape edge lines)
 *   This prevents creating cells inside the blocked zone
 * - Midpoints for routing flexibility
 *
 * @param from - Start terminal
 * @param to - End terminal
 * @param fromJetty - Start jetty position
 * @param toJetty - End jetty position
 * @param strokeWidth - Connector stroke width (affects grid line placement)
 * @returns Grid for A* routing
 */
export function buildNonUniformGrid(
  from: Terminal,
  to: Terminal,
  fromJetty: [number, number],
  toJetty: [number, number],
  strokeWidth: number
): Grid {
  const xLines: number[] = [];
  const yLines: number[] = [];

  const approachOffset = computeApproachOffset(strokeWidth);

  // === 1. FROM endpoint ===
  // Always add both axes for the endpoint position (needed for path assembly)
    // === 1. FROM endpoint ===
    if (from.kind === 'shape') {
      // Anchored FROM: single-axis line at jetty position
      // The axis is PERPENDICULAR to the snap side
      if (from.outwardDir === 'N' || from.outwardDir === 'S') {
        // Vertical exit → y-line at jetty
        yLines.push(fromJetty[1]);
        xLines.push(from.position[0]); // Keep x for path assembly
      } else {
        // Horizontal exit → x-line at jetty
        xLines.push(fromJetty[0]);
        yLines.push(from.position[1]); // Keep y for path assembly
      }
    } else {
      // Unsnapped FROM: both axes at position
      xLines.push(from.position[0]);
      yLines.push(from.position[1]);
    }
  
    // === 2. TO endpoint ===
    if (to.kind === 'shape') {
      // Anchored TO: single-axis line at jetty position
      if (to.outwardDir === 'N' || to.outwardDir === 'S') {
        yLines.push(toJetty[1]);
        xLines.push(toJetty[0]);
      } else {
        xLines.push(toJetty[0]);
        yLines.push(toJetty[1]);
      }
    } else {
      // Unsnapped TO: both axes
      xLines.push(to.position[0]);
      yLines.push(to.position[1]);
    }
  
    // === 3. Obstacle padding boundaries (NOT shape edges) ===
    if (to.shapeBounds) {
      const { x, y, w, h } = to.shapeBounds;
  
      // Only add padding boundary lines (valid routing corridors)
      // DO NOT add shape edge lines - those create blocked cells
      xLines.push(x - approachOffset, x + w + approachOffset);
      yLines.push(y - approachOffset, y + h + approachOffset);
    }
  
    if (from.shapeBounds && from.shapeBounds !== to.shapeBounds) {
      const { x, y, w, h } = from.shapeBounds;
      xLines.push(x - approachOffset, x + w + approachOffset);
      yLines.push(y - approachOffset, y + h + approachOffset);
    }
  
    // === 4. Midpoints for routing flexibility ===
    // These allow Z-routes that don't align with endpoints
    const midX = (fromJetty[0] + toJetty[0]) / 2;
    const midY = (fromJetty[1] + toJetty[1]) / 2;
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
      from.position,  // Start position (never blocked)
      to.position,    // Goal position (never blocked)
      fromJetty,
      toJetty,
      strokeWidth
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
