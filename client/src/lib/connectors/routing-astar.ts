/**
 * A* Manhattan Routing for Snapped Endpoints
 *
 * Used when endpoint IS snapped to a shape. Provides obstacle avoidance
 * by routing around the padded shape bounds.
 *
 * Key features:
 * - Non-uniform grid (sparse, meaningful positions only)
 * - Dynamic AABBs with centerlines baked in (no cell blocking needed)
 * - Direction seeding (initial jetty counts as previous turn)
 * - Backwards visit prevention (no U-turns)
 * - Bend penalty (minimize direction changes)
 * - Segment intersection checking (prevents crossing through shapes)
 *
 * @module lib/connectors/routing-astar
 */

import { COST_CONFIG } from './constants';
import {
  oppositeDir,
  simplifyOrthogonal,
  computeSignature,
} from './connector-utils';
import { createRoutingContext, buildSimpleGrid } from './routing-context';
import { MinHeap } from './binary-heap';
import type { RouteResult, Dir, AABB, Grid, GridCell, AStarNode } from './types';

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
function findNearestCell(grid: Grid, pos: [number, number]): GridCell {
  let xi = 0, yi = 0;
  let bestXDist = Infinity, bestYDist = Infinity;

  for (let i = 0; i < grid.xLines.length; i++) {
    const dist = Math.abs(grid.xLines[i] - pos[0]);
    if (dist < bestXDist) { bestXDist = dist; xi = i; }
  }
  for (let i = 0; i < grid.yLines.length; i++) {
    const dist = Math.abs(grid.yLines[i] - pos[1]);
    if (dist < bestYDist) { bestYDist = dist; yi = i; }
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

/**
 * Get movement direction from one cell to another.
 */
function getDirection(from: GridCell, to: GridCell): Dir {
  const dx = to.x - from.x;
  const dy = to.y - from.y;

  // For orthogonal grid, one of dx/dy should be dominant
  if (Math.abs(dx) > Math.abs(dy)) {
    return dx > 0 ? 'E' : 'W';
  } else {
    return dy > 0 ? 'S' : 'N';
  }
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
function computeMoveCost(
  from: GridCell,
  to: GridCell,
  arrivalDir: Dir | null,
  moveDir: Dir
): number {
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
// SEGMENT-AABB INTERSECTION
// ============================================================================

/**
 * Check if a line segment intersects the strict interior of an AABB.
 *
 * Uses the slab method (parametric intersection). Unlike a midpoint-only
 * check, this handles:
 * - Thin shapes that midpoint could miss
 * - Any segment orientation (though we use H/V only)
 * - Works correctly with raw shape bounds (no stroke inflation needed)
 *
 * @param x1, y1 - Segment start
 * @param x2, y2 - Segment end
 * @param aabb - Axis-aligned bounding box (raw shape bounds)
 * @returns true if segment passes through AABB interior
 */
function segmentIntersectsAABB(
  x1: number, y1: number,
  x2: number, y2: number,
  aabb: AABB
): boolean {
  const { x, y, w, h } = aabb;
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

  // Segment intersects the AABB interior
  return true;
}

/**
 * Run A* pathfinding on the grid.
 *
 * Direction hints are now used for soft preferences:
 * - preferredFirstDir: Gives a bonus when first move matches this direction
 * - requiredApproachDir: Gives a penalty when goal is approached from wrong direction
 *
 * Segment midpoint checking prevents routes from "jumping over" shapes
 * when the grid is sparse (lines only at padding boundaries).
 *
 * @param grid - The routing grid
 * @param start - Start cell
 * @param goal - Goal cell
 * @param startDir - Direction to start from
 * @param obstacles - Array of AABBs to check segment intersection against
 * @returns Array of cells forming the path
 */
function astar(
  grid: Grid,
  start: GridCell,
  goal: GridCell,
  startDir: Dir,
  obstacles: AABB[]
): GridCell[] {
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
        const segmentBlocked = obstacles.some(obs =>
          segmentIntersectsAABB(
            current.cell.x, current.cell.y,
            neighbor.x, neighbor.y,
            obs
          )
        );
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
 * NEW ARCHITECTURE: Uses routing context for all spatial analysis.
 * Takes 7 primitives instead of Terminal objects for cleaner SelectTool integration.
 *
 * Supports all endpoint combinations:
 * - Free→Anchored: Uses endShapeBounds as obstacle
 * - Anchored→Free: Uses startShapeBounds as obstacle
 * - Anchored→Anchored: Uses both shapes as obstacles
 *
 * @param startPos - Start endpoint position
 * @param startDir - Start outward direction
 * @param endPos - End endpoint position
 * @param endDir - End outward direction
 * @param startShapeBounds - Shape bounds if start is anchored, null if free
 * @param endShapeBounds - Shape bounds if end is anchored, null if free
 * @param strokeWidth - Connector stroke width (affects offsets)
 * @returns Route result with path and signature
 */
export function computeAStarRoute(
  startPos: [number, number],
  startDir: Dir,
  endPos: [number, number],
  endDir: Dir,
  startShapeBounds: AABB | null,
  endShapeBounds: AABB | null,
  strokeWidth: number
): RouteResult {

  // If start and end are exactly the same position
  if (startPos[0] === endPos[0] && startPos[1] === endPos[1]) {
    return {
      points: [endPos],
      signature: '',
    };
  }

  // 1. Build routing context (ALL spatial intelligence happens here)
  // - Computes centerlines from RAW bounds
  // - Builds dynamic AABBs with centerline/padding baked in
  // - Computes stub positions on AABB boundaries
  // - Collects obstacles (raw shape bounds)
  const ctx = createRoutingContext(
    startPos, startDir, endPos, endDir,
    startShapeBounds, endShapeBounds, strokeWidth
  );

  // 2. Build simple grid from context (trivial - just AABB boundaries)
  const grid = buildSimpleGrid(ctx);

  // 3. Find start and goal cells (at stub positions)
  const startCell = findNearestCell(grid, ctx.startStub);
  const goalCell = findNearestCell(grid, ctx.endStub);

  // 4. Run A* between stubs (seed with startDir)
  const path = astar(grid, startCell, goalCell, ctx.startDir, ctx.obstacles);

  // 5. Assemble full path: actual_start → A* path → actual_end
  // This is key for dynamic offset - stubs may be on centerline, not padded boundary
  const fullPath: [number, number][] = [startPos];
  for (const cell of path) {
    fullPath.push([cell.x, cell.y]);
  }
  fullPath.push(endPos);

  // 6. Simplify collinear points
  const simplified = simplifyOrthogonal(fullPath);

  return {
    points: simplified,
    signature: computeSignature(simplified),
  };
}
