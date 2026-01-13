/**
 * A* Manhattan Routing for Snapped Endpoints
 *
 * Used when endpoint IS snapped to a shape. Provides obstacle avoidance
 * by routing around the padded shape bounds.
 *
 * Key features:
 * - Non-uniform grid (sparse, meaningful positions only)
 * - Blocked cells inside padded obstacles (valid by construction)
 * - Direction seeding (initial jetty counts as previous turn)
 * - Backwards visit prevention (no U-turns)
 * - Bend penalty (minimize direction changes)
 *
 * @module lib/connectors/routing-astar
 */

import { COST_CONFIG, computeJettyOffset } from './constants';
import { getOutwardVector, oppositeDir, segmentIntersectsAABB, type Dir, type AABB } from './shape-utils';
import { simplifyOrthogonal, computeSignature } from './routing';
import {
  buildNonUniformGrid,
  findNearestCell,
  getNeighbors,
  type Grid,
  type GridCell,
} from './routing-grid';
import { type Terminal, type RouteResult } from './routing-zroute';

/**
 * A* node for priority queue.
 */
interface AStarNode {
  cell: GridCell;
  /** Cost from start */
  g: number;
  /** Heuristic to goal */
  h: number;
  /** f = g + h */
  f: number;
  /** Parent node for path reconstruction */
  parent: AStarNode | null;
  /** Direction we arrived from (for bend penalty) */
  arrivalDir: Dir | null;
}

/**
 * Min-heap priority queue for A*.
 */
class MinHeap<T> {
  private items: T[] = [];

  constructor(private compareFn: (a: T, b: T) => number) {}

  push(item: T): void {
    this.items.push(item);
    this.bubbleUp(this.items.length - 1);
  }

  pop(): T | undefined {
    if (this.items.length === 0) return undefined;
    const result = this.items[0];
    const last = this.items.pop()!;
    if (this.items.length > 0) {
      this.items[0] = last;
      this.bubbleDown(0);
    }
    return result;
  }

  isEmpty(): boolean {
    return this.items.length === 0;
  }

  private bubbleUp(idx: number): void {
    while (idx > 0) {
      const parentIdx = Math.floor((idx - 1) / 2);
      if (this.compareFn(this.items[idx], this.items[parentIdx]) >= 0) break;
      [this.items[idx], this.items[parentIdx]] = [this.items[parentIdx], this.items[idx]];
      idx = parentIdx;
    }
  }

  private bubbleDown(idx: number): void {
    while (true) {
      const leftIdx = 2 * idx + 1;
      const rightIdx = 2 * idx + 2;
      let smallest = idx;

      if (
        leftIdx < this.items.length &&
        this.compareFn(this.items[leftIdx], this.items[smallest]) < 0
      ) {
        smallest = leftIdx;
      }
      if (
        rightIdx < this.items.length &&
        this.compareFn(this.items[rightIdx], this.items[smallest]) < 0
      ) {
        smallest = rightIdx;
      }

      if (smallest === idx) break;
      [this.items[idx], this.items[smallest]] = [this.items[smallest], this.items[idx]];
      idx = smallest;
    }
  }
}

/**
 * Compute approach point (stub extending from terminal).
 *
 * Cap-aware: anchored endpoints with arrow caps get full offset,
 * unsnapped endpoints get no offset (they're free-floating).
 *
 * @param terminal - The terminal to compute approach point for
 * @param strokeWidth - Connector stroke width (affects offset)
 */
function computeApproachPoint(terminal: Terminal, strokeWidth: number): [number, number] {
  const offset = computeJettyOffset(terminal.isAnchored, terminal.hasCap, strokeWidth);

  if (offset === 0) {
    return terminal.position;
  }

  const vec = getOutwardVector(terminal.outwardDir);
  return [
    terminal.position[0] + vec[0] * offset,
    terminal.position[1] + vec[1] * offset,
  ];
}

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
  
  // No path found - return direct line (fallback)
  return [start, goal];
}

/**
 * Compute goal position from padding boundary intersection.
 *
 * For anchored endpoints, the goal is at the intersection of:
 * - The anchor's fixed axis (X for E/W, Y for N/S)
 * - The padding boundary
 */
function computeGoalPosition(to: Terminal, strokeWidth: number): [number, number] {
  if (!to.isAnchored || !to.shapeBounds) {
    return to.position;
  }

  const { x, y, w, h } = to.shapeBounds;
  const offset = computeJettyOffset(to.isAnchored, to.hasCap, strokeWidth);

  switch (to.outwardDir) {
    case 'N':
      return [to.position[0], y - offset];
    case 'S':
      return [to.position[0], y + h + offset];
    case 'E':
      return [x + w + offset, to.position[1]];
    case 'W':
      return [x - offset, to.position[1]];
  }
}

/**
 * Compute A* routed path for connected endpoints.
 *
 * Used when either endpoint is anchored to a shape.
 * Provides obstacle avoidance by routing around shape bounds.
 *
 * Supports all endpoint combinations:
 * - Free→Anchored: Uses to.shapeBounds as obstacle
 * - Anchored→Free: Uses from.shapeBounds as obstacle
 * - Anchored→Anchored: Uses both shapes as obstacles
 *
 * @param from - Start terminal
 * @param to - End terminal
 * @param strokeWidth - Connector stroke width (affects offsets)
 * @returns Route result with path and signature
 */
export function computeAStarRoute(from: Terminal, to: Terminal, strokeWidth: number): RouteResult {
  // 1. Compute approach points 
  const fromApproach = computeApproachPoint(from, strokeWidth);
  const toApproach = computeApproachPoint(to, strokeWidth);

  // 2. Compute goal/start positions
  // For anchored endpoints, the goal/start is at padding boundary intersection
  const goalPos = computeGoalPosition(to, strokeWidth);
  //const startPos = from.isAnchored ? computeGoalPosition(from, strokeWidth) : from.position;

  // 3. Collect obstacles for segment intersection checking
  // Use strict shape bounds (not padded) for intersection checks
  const obstacles: AABB[] = [];
  if (to.shapeBounds) {
    obstacles.push(to.shapeBounds);
  }
  if (from.shapeBounds && from.shapeBounds !== to.shapeBounds) {
    obstacles.push(from.shapeBounds);
  }

  // 4. Build non-uniform grid with obstacles
  const grid = buildNonUniformGrid(from, to, fromApproach, toApproach, strokeWidth);

  // 5. Find start and goal cells
  const startCell = findNearestCell(grid, fromApproach);
  const goalCell = findNearestCell(grid, goalPos);

  // 6. Direction already resolved before routing - just use from.outwardDir
  // (Direction computation moved to routing.ts: resolveFreeStartDir/computeFreeEndDir)
  const startDir = from.outwardDir;

  // 7. Run A* with segment intersection checking
  const path = astar(grid, startCell, goalCell, startDir, obstacles);

  // 9. Assemble full path: actual start → A* path → actual end
  const fullPath: [number, number][] = [from.position];
  for (const cell of path) {
    fullPath.push([cell.x, cell.y]);
  }
  fullPath.push(to.position);

  // 10. Simplify collinear points
  const simplified = simplifyOrthogonal(fullPath);

  return {
    points: simplified,
    signature: computeSignature(simplified)
  };
}
