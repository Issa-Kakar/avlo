/**
 * A* Manhattan Routing for Snapped Endpoints.
 *
 * Used when an endpoint is snapped to a shape — provides obstacle avoidance by
 * routing around padded shape bounds.
 *
 * Features:
 * - Non-uniform grid (sparse, meaningful positions only)
 * - Dynamic routing bounds with centerlines baked in (no cell blocking needed)
 * - Direction seeding (initial jetty counts as previous turn)
 * - Backwards-visit prevention (no U-turns)
 * - Bend penalty (minimize direction changes)
 * - Segment intersection checking (prevents crossing through shapes)
 */

import type { FrameTuple, Point } from '../types/geometry';
import { COST_CONFIG } from './constants';
import { oppositeDir, simplifyOrthogonal, directionFromDelta } from './connector-utils';
import { createRoutingContext, buildSimpleGrid } from './routing-context';
import { MinHeap } from './binary-heap';
import type { RouteResult, Dir, Grid, GridCell, AStarNode } from './types';

/**

// ============================================================================
// GRID HELPERS (moved from routing-grid.ts)
// ============================================================================

/**
 * Find the nearest grid cell for a world position.
 *
 * @param grid - The grid to search
 * @param pos - World position
 * @returns Nearest grid cell
 */
function findNearestCell(grid: Grid, pos: Point): GridCell {
  let xi = 0,
    yi = 0;
  let bestXDist = Infinity,
    bestYDist = Infinity;

  for (let i = 0; i < grid.xLines.length; i++) {
    const dist = Math.abs(grid.xLines[i] - pos[0]);
    if (dist < bestXDist) {
      bestXDist = dist;
      xi = i;
    }
  }
  for (let i = 0; i < grid.yLines.length; i++) {
    const dist = Math.abs(grid.yLines[i] - pos[1]);
    if (dist < bestYDist) {
      bestYDist = dist;
      yi = i;
    }
  }

  return grid.cells[yi][xi];
}

/**
 * Get 4-connected neighbors (N, E, S, W) for a cell.
 *
 * @param grid - The grid
 * @param cell - Current cell
 * @returns Array of neighbor cells
 */
function getNeighbors(grid: Grid, cell: GridCell): GridCell[] {
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

// ============================================================================
// A* HELPERS
// ============================================================================

/** Movement direction from one cell to another (orthogonal grid). */
function getDirection(from: GridCell, to: GridCell): Dir {
  return directionFromDelta(to.x - from.x, to.y - from.y);
}

/**
 * Manhattan distance heuristic.
 */
function manhattan(a: GridCell, b: GridCell): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

/**
 * Compute movement cost including bend penalty.
 *
 * @param from - Source cell
 * @param to - Target cell
 * @param arrivalDir - Direction we arrived at source from
 * @param moveDir - Direction we're moving to target
 * @returns Movement cost
 */
function computeMoveCost(from: GridCell, to: GridCell, arrivalDir: Dir | null, moveDir: Dir): number {
  // Base cost: Manhattan distance of this segment
  let cost = Math.abs(to.x - from.x) + Math.abs(to.y - from.y);

  // BACKWARDS PREVENTION
  if (arrivalDir && moveDir === oppositeDir(arrivalDir)) {
    return Infinity;
  }

  // BEND PENALTY (minimize direction changes)
  if (arrivalDir && moveDir !== arrivalDir) {
    cost += COST_CONFIG.BEND_PENALTY;
  }

  return cost;
}

/**
 * Reconstruct path from A* goal node.
 */
function reconstructPath(node: AStarNode): GridCell[] {
  const path: GridCell[] = [];
  let current: AStarNode | null = node;

  while (current !== null) {
    path.unshift(current.cell);
    current = current.parent;
  }

  return path;
}

/**
 * Cell key for Set/Map operations.
 */
function cellKey(cell: GridCell): string {
  return `${cell.xi},${cell.yi}`;
}

// ============================================================================
// SEGMENT-FRAME INTERSECTION
// ============================================================================

/**
 * Check if a line segment intersects the strict interior of a frame.
 *
 * Uses the slab method (parametric intersection). Handles thin shapes,
 * arbitrary orientations, and works directly on raw shape bounds.
 */
function segmentIntersectsFrame(a: Point, b: Point, frame: FrameTuple): boolean {
  const [x1, y1] = a;
  const [x2, y2] = b;
  const [x, y, w, h] = frame;
  const minX = x;
  const maxX = x + w;
  const minY = y;
  const maxY = y + h;

  // Direction vector
  const dx = x2 - x1;
  const dy = y2 - y1;

  // Parametric bounds
  let tMin = 0;
  let tMax = 1;

  // Check X slab
  if (dx === 0) {
    // Vertical line - check if X is inside (including boundary)
    if (x1 < minX || x1 > maxX) return false;
  } else {
    const t1 = (minX - x1) / dx;
    const t2 = (maxX - x1) / dx;
    const tEnter = Math.min(t1, t2);
    const tExit = Math.max(t1, t2);
    tMin = Math.max(tMin, tEnter);
    tMax = Math.min(tMax, tExit);
    if (tMin >= tMax) return false;
  }

  // Check Y slab
  if (dy === 0) {
    // Horizontal line - check if Y is inside (including boundary)
    if (y1 < minY || y1 > maxY) return false;
  } else {
    const t1 = (minY - y1) / dy;
    const t2 = (maxY - y1) / dy;
    const tEnter = Math.min(t1, t2);
    const tExit = Math.max(t1, t2);
    tMin = Math.max(tMin, tEnter);
    tMax = Math.min(tMax, tExit);
    if (tMin >= tMax) return false;
  }

  // Segment intersects the frame interior
  return true;
}

/**
 * Run A* pathfinding on the grid.
 *
 * Segment intersection checking prevents routes from "jumping over" shapes
 * when the grid is sparse (lines only at padding boundaries).
 */
function astar(grid: Grid, start: GridCell, goal: GridCell, startDir: Dir, obstacles: FrameTuple[]): GridCell[] {
  const openSet = new MinHeap<AStarNode>((a, b) => a.f - b.f);
  const closedSet = new Set<string>();
  const gScores = new Map<string, number>();

  // Start with null arrivalDir - direction hints applied via cost adjustments
  const startNode: AStarNode = {
    cell: start,
    g: 0,
    h: manhattan(start, goal),
    f: manhattan(start, goal),
    parent: null,
    arrivalDir: startDir,
  };

  openSet.push(startNode);
  gScores.set(cellKey(start), 0);

  while (!openSet.isEmpty()) {
    const current = openSet.pop()!;
    const currentKey = cellKey(current.cell);

    // Goal check
    if (current.cell.xi === goal.xi && current.cell.yi === goal.yi) {
      return reconstructPath(current);
    }

    if (closedSet.has(currentKey)) continue;
    closedSet.add(currentKey);

    // Explore 4-connected neighbors
    for (const neighbor of getNeighbors(grid, current.cell)) {
      // Skip blocked cells
      if (neighbor.blocked) continue;

      const neighborKey = cellKey(neighbor);
      if (closedSet.has(neighborKey)) continue;

      // Check if segment crosses any obstacle interior (full segment check)
      if (obstacles.length > 0) {
        const from: Point = [current.cell.x, current.cell.y];
        const to: Point = [neighbor.x, neighbor.y];
        const segmentBlocked = obstacles.some((obs) => segmentIntersectsFrame(from, to, obs));
        if (segmentBlocked) continue;
      }

      // Compute move direction
      const moveDir = getDirection(current.cell, neighbor);

      // Base cost with bend penalty
      let moveCost = computeMoveCost(current.cell, neighbor, current.arrivalDir, moveDir);

      const tentativeG = current.g + moveCost;
      const existingG = gScores.get(neighborKey) ?? Infinity;
      if (tentativeG < existingG) {
        const h = manhattan(neighbor, goal);
        const neighborNode: AStarNode = {
          cell: neighbor,
          g: tentativeG,
          h: h,
          f: tentativeG + h,
          parent: current,
          arrivalDir: moveDir,
        };

        gScores.set(neighborKey, tentativeG);
        openSet.push(neighborNode);
      }
    }
  }

  // No path found with obstacles - retry without obstacles
  if (obstacles.length > 0) {
    return astar(grid, start, goal, startDir, []);
  }

  // No path found even without obstacles - return direct line (fallback)
  return [start, goal];
}

// ============================================================================
// PUBLIC API
// ============================================================================

/**
 * Compute A* routed path for connected endpoints.
 *
 * Takes 7 primitives. Supports all endpoint combinations — anchored shape
 * bounds double as obstacles; `null` means free.
 */
export function computeAStarRoute(
  startPos: Point,
  startDir: Dir,
  endPos: Point,
  endDir: Dir,
  startShapeBounds: FrameTuple | null,
  endShapeBounds: FrameTuple | null,
  strokeWidth: number,
): RouteResult {
  // If start and end are exactly the same position
  if (startPos[0] === endPos[0] && startPos[1] === endPos[1]) {
    return { points: [endPos] };
  }

  // 1. Build routing context (ALL spatial intelligence happens here)
  // - Computes centerlines from RAW bounds
  // - Builds dynamic routing bounds with centerline/padding baked in
  // - Computes stub positions on routing-bound edges
  // - Collects obstacles (raw shape bounds)
  const ctx = createRoutingContext(startPos, startDir, endPos, endDir, startShapeBounds, endShapeBounds, strokeWidth);

  // 2. Build simple grid from context (trivial — just routing-bound edges)
  const grid = buildSimpleGrid(ctx);

  // 3. Find start and goal cells (at stub positions)
  const startCell = findNearestCell(grid, ctx.startStub);
  const goalCell = findNearestCell(grid, ctx.endStub);

  // 4. Run A* between stubs (seed with startDir)
  const path = astar(grid, startCell, goalCell, ctx.startDir, ctx.obstacles);

  // 5. Assemble full path: actual_start → A* path → actual_end
  // This is key for dynamic offset - stubs may be on centerline, not padded boundary
  const fullPath: Point[] = [startPos];
  for (const cell of path) {
    fullPath.push([cell.x, cell.y]);
  }
  fullPath.push(endPos);

  // 6. Simplify collinear points
  return { points: simplifyOrthogonal(fullPath) };
}
