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
import { getOutwardVector, oppositeDir, type Dir, type AABB } from './shape-utils';
import {
  buildNonUniformGrid,
  findNearestCell,
  getNeighbors,
  type Grid,
  type GridCell,
} from './routing-grid';
import { type Terminal, type RouteResult } from './routing-zroute';

// ============================================================================
// SEGMENT-AABB INTERSECTION (MIDPOINT CHECK)
// ============================================================================

/**
 * Check if a segment's midpoint is inside an obstacle (with inflation).
 *
 * For orthogonal routing (H/V segments only), checking the midpoint is sufficient
 * because if a segment passes through an obstacle, the midpoint will be inside.
 * This avoids false positives from corner-clipping that occurs with full segment checks.
 *
 * Uses INFLATED bounds (shape + strokeInflation) for a buffer zone around shapes.
 *
 * @param x1, y1 - Segment start
 * @param x2, y2 - Segment end
 * @param aabb - Axis-aligned bounding box (strict shape bounds)
 * @param strokeInflation - Inflation amount (typically strokeWidth * 0.5 + 1)
 * @returns true if segment midpoint is inside the inflated AABB
 */
function segmentMidpointInObstacle(
  x1: number, y1: number,
  x2: number, y2: number,
  aabb: AABB,
  strokeInflation: number
): boolean {
  const mx = (x1 + x2) / 2;
  const my = (y1 + y2) / 2;

  // Use inflated bounds for buffer zone
  const minX = aabb.x - strokeInflation;
  const maxX = aabb.x + aabb.w + strokeInflation;
  const minY = aabb.y - strokeInflation;
  const maxY = aabb.y + aabb.h + strokeInflation;

  // Strict interior check (not on boundary)
  return mx > minX && mx < maxX && my > minY && my < maxY;
}

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

  // BACKWARDS PREVENTION - should be caught earlier, but double-check
  if (arrivalDir && moveDir === oppositeDir(arrivalDir)) {
    return Infinity;
  }

  // BEND PENALTY (minimize direction changes)
  if (arrivalDir && moveDir !== arrivalDir) {
    cost += COST_CONFIG.BEND_PENALTY;
  }

  // CONTINUATION BONUS (prefer longer straight segments)
  // if (arrivalDir && moveDir === arrivalDir) {
  //   cost -= COST_CONFIG.CONTINUATION_BONUS;
  // }

  // SHORT SEGMENT PENALTY (segments shorter than corner radius look bad)
  // const segmentLength = Math.abs(to.x - from.x) + Math.abs(to.y - from.y);
  // if (segmentLength < ROUTING_CONFIG.CORNER_RADIUS_W && arrivalDir !== null) {
  //   cost += COST_CONFIG.SHORT_SEGMENT_PENALTY;
  // }

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
 * @param preferredFirstDir - Direction to prefer for first move (soft bonus)
 * @param requiredApproachDir - Direction to approach goal (penalty if wrong)
 * @param obstacles - Array of AABBs to check segment intersection against
 * @param strokeWidth - Connector stroke width (for computing inflation)
 * @returns Array of cells forming the path
 */
function astar(
  grid: Grid,
  start: GridCell,
  goal: GridCell,
  preferredFirstDir: Dir | null,
  _requiredApproachDir: Dir,
  obstacles: AABB[],
  strokeWidth: number
): GridCell[] {
  const openSet = new MinHeap<AStarNode>((a, b) => a.f - b.f);
  const closedSet = new Set<string>();
  const gScores = new Map<string, number>();

  // Compute stroke inflation once (same formula as cell blocking)
  const strokeInflation = strokeWidth * 0.5 + 1;

  // Start with null arrivalDir - direction hints applied via cost adjustments
  const startNode: AStarNode = {
    cell: start,
    g: 0,
    h: manhattan(start, goal),
    f: manhattan(start, goal),
    parent: null,
    arrivalDir: preferredFirstDir,
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

      // Check if segment midpoint is inside any obstacle
      // Midpoint check naturally handles start/goal corridors because:
      // - Start→neighbor: Midpoint is close to start, outside obstacle
      // - Current→goal: Midpoint is close to goal (in padding corridor), outside obstacle
      if (obstacles.length > 0) {
        const segmentBlocked = obstacles.some(obs =>
          segmentMidpointInObstacle(
            current.cell.x, current.cell.y,
            neighbor.x, neighbor.y,
            obs,
            strokeInflation
          )
        );
        if (segmentBlocked) continue;
      }

      // Compute move direction
      const moveDir = getDirection(current.cell, neighbor);

      // Base cost with bend penalty
      let moveCost = computeMoveCost(current.cell, neighbor, current.arrivalDir, moveDir);
      // FIRST DIRECTION BONUS - apply at start node when preferredFirstDir is set
      // Only applied when starting inside padding or from anchored position
      // if (current.parent === null && preferredFirstDir && moveDir === preferredFirstDir) {
      //   moveCost -= COST_CONFIG.FIRST_DIR_BONUS;
      // }

      // APPROACH MISMATCH PENALTY - disabled (creates weird routes)
      // if (neighbor.xi === goal.xi && neighbor.yi === goal.yi) {
      //   if (moveDir !== _requiredApproachDir) {
      //     moveCost += COST_CONFIG.APPROACH_MISMATCH_PENALTY;
      //   }
      // }

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
 * Remove collinear points from path.
 */
function simplifyOrthogonal(points: [number, number][]): [number, number][] {
  if (points.length < 3) return points;

  const result: [number, number][] = [points[0]];

  for (let i = 1; i < points.length - 1; i++) {
    const prev = result[result.length - 1];
    const curr = points[i];
    const next = points[i + 1];

    const sameX = Math.abs(prev[0] - curr[0]) < 0.001 && Math.abs(curr[0] - next[0]) < 0.001;
    const sameY = Math.abs(prev[1] - curr[1]) < 0.001 && Math.abs(curr[1] - next[1]) < 0.001;

    if (!sameX && !sameY) {
      result.push(curr);
    }
  }

  result.push(points[points.length - 1]);
  return result;
}

/**
 * Compute route signature from simplified path.
 */
function computeSignature(points: [number, number][]): string {
  let sig = '';
  for (let i = 0; i < points.length - 1; i++) {
    const dx = points[i + 1][0] - points[i][0];
    const dy = points[i + 1][1] - points[i][1];
    if (Math.abs(dx) > Math.abs(dy)) {
      sig += 'H';
    } else if (Math.abs(dy) > Math.abs(dx)) {
      sig += 'V';
    }
  }
  // Deduplicate consecutive same chars
  return sig.replace(/(.)(\1)+/g, '$1');
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

  // Required approach: must enter goal from opposite of to.outwardDir
  const _requiredApproachDir = to.isAnchored ? oppositeDir(to.outwardDir) : to.outwardDir;

  // 7. Run A* with direction hints AND segment midpoint checking
  const path = astar(grid, startCell, goalCell, startDir, _requiredApproachDir, obstacles, strokeWidth);

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
