/**
 * Non-Uniform Grid Construction for A* Routing
 *
 * Creates a sparse grid with lines at meaningful positions:
 * - Endpoint positions (from/to)
 * - Jetty endpoints
 * - Obstacle boundaries with padding
 * - Midpoints for flexibility
 *
 * Grid cells are marked as blocked if inside padded obstacle bounds.
 * A* will never visit blocked cells, ensuring valid paths by construction.
 *
 * @module lib/connectors/routing-grid
 */

import { ROUTING_CONFIG } from './constants';
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
 * @returns true if inside (not on boundary)
 */
function pointInsideRect(x: number, y: number, rect: AABB): boolean {
  return x > rect.x && x < rect.x + rect.w && y > rect.y && y < rect.y + rect.h;
}

/**
 * Create cell grid with blocking based on obstacle bounds.
 *
 * CRITICAL: The blocking margin must be SMALLER than JETTY_W!
 * - We use full padding (OBSTACLE_PADDING_W) for grid line placement (routing corridors)
 * - We use small margin for blocking (just the shape interior)
 * - This ensures jetty endpoints are NOT blocked, so A* can reach the goal
 *
 * @param xLines - Sorted X coordinates
 * @param yLines - Sorted Y coordinates
 * @param obstacle - Shape bounds to block (if any)
 * @param fromJetty - Start jetty position (must not be blocked)
 * @param toJetty - End jetty position (must not be blocked)
 * @returns Grid structure
 */
function createCellGrid(
  xLines: number[],
  yLines: number[],
  obstacle: AABB | null,
  fromJetty: [number, number],
  toJetty: [number, number]
): Grid {
  const cells: GridCell[][] = [];

  // Block only the ACTUAL shape interior (not the full padded region)
  // This ensures jetty endpoints (which are JETTY_W away from shape) are NOT blocked
  // Routes will still prefer the padded corridors due to bend penalties
  const blockedBounds: AABB | null = obstacle
    ? {
        // Small margin just for the shape itself (no padding)
        // The jetty at JETTY_W=16 units away will NOT be blocked
        x: obstacle.x,
        y: obstacle.y,
        w: obstacle.w,
        h: obstacle.h,
      }
    : null;

  for (let yi = 0; yi < yLines.length; yi++) {
    cells[yi] = [];
    for (let xi = 0; xi < xLines.length; xi++) {
      const cellX = xLines[xi];
      const cellY = yLines[yi];

      // Cell is blocked if INSIDE the shape bounds (strict interior)
      let blocked = blockedBounds ? pointInsideRect(cellX, cellY, blockedBounds) : false;

      // NEVER block the jetty endpoints - A* needs to reach them
      if (blocked) {
        const isFromJetty = Math.abs(cellX - fromJetty[0]) < 0.001 && Math.abs(cellY - fromJetty[1]) < 0.001;
        const isToJetty = Math.abs(cellX - toJetty[0]) < 0.001 && Math.abs(cellY - toJetty[1]) < 0.001;
        if (isFromJetty || isToJetty) {
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
 * Grid lines are placed at meaningful positions to minimize grid size
 * while ensuring all necessary routing paths are available.
 *
 * @param from - Start terminal
 * @param to - End terminal
 * @param fromJetty - Start jetty position
 * @param toJetty - End jetty position
 * @returns Grid for A* routing
 */
export function buildNonUniformGrid(
  from: Terminal,
  to: Terminal,
  fromJetty: [number, number],
  toJetty: [number, number]
): Grid {
  const xLines: number[] = [];
  const yLines: number[] = [];

  // === 1. Endpoint positions ===
  xLines.push(from.position[0], to.position[0]);
  yLines.push(from.position[1], to.position[1]);

  // === 2. Jetty endpoints ===
  xLines.push(fromJetty[0], toJetty[0]);
  yLines.push(fromJetty[1], toJetty[1]);

  // === 3. Obstacle boundaries with GENEROUS padding ===
  if (to.shapeBounds) {
    const padding = ROUTING_CONFIG.OBSTACLE_PADDING_W;
    const { x, y, w, h } = to.shapeBounds;

    // Inner boundaries (shape edge)
    xLines.push(x, x + w);
    yLines.push(y, y + h);

    // Outer boundaries (padded - valid routing corridors)
    xLines.push(x - padding, x + w + padding);
    yLines.push(y - padding, y + h + padding);
  }

  // Also handle from.shapeBounds for bi-directional obstacle avoidance
  if (from.shapeBounds) {
    const padding = ROUTING_CONFIG.OBSTACLE_PADDING_W;
    const { x, y, w, h } = from.shapeBounds;

    xLines.push(x, x + w);
    yLines.push(y, y + h);
    xLines.push(x - padding, x + w + padding);
    yLines.push(y - padding, y + h + padding);
  }

  // === 4. Midpoints for Z-route flexibility ===
  const midX = (fromJetty[0] + toJetty[0]) / 2;
  const midY = (fromJetty[1] + toJetty[1]) / 2;
  xLines.push(midX);
  yLines.push(midY);

  // === 5. Additional grid lines for better path options ===
  // Quarter points help with complex routing scenarios
  const quarterX1 = fromJetty[0] + (toJetty[0] - fromJetty[0]) * 0.25;
  const quarterX2 = fromJetty[0] + (toJetty[0] - fromJetty[0]) * 0.75;
  const quarterY1 = fromJetty[1] + (toJetty[1] - fromJetty[1]) * 0.25;
  const quarterY2 = fromJetty[1] + (toJetty[1] - fromJetty[1]) * 0.75;
  xLines.push(quarterX1, quarterX2);
  yLines.push(quarterY1, quarterY2);

  // === 6. Dedupe and sort ===
  const xSorted = [...new Set(xLines)].sort((a, b) => a - b);
  const ySorted = [...new Set(yLines)].sort((a, b) => a - b);

  // === 7. Build cell grid ===
  // Only consider target shape as obstacle (from is where we're coming FROM)
  // Pass jetty positions so they're explicitly not blocked
  return createCellGrid(xSorted, ySorted, to.shapeBounds ?? null, fromJetty, toJetty);
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
