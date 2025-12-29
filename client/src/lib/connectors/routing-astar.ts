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
import { getOutwardVector, type Dir } from './shape-utils';
import {
  buildNonUniformGrid,
  findNearestCell,
  getNeighbors,
  type Grid,
  type GridCell,
} from './routing-grid';
import type { Terminal, RouteResult } from './routing-zroute';

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
 * Compute jetty point (stub extending from terminal).
 *
 * Cap-aware: anchored endpoints with arrow caps get full offset,
 * unsnapped endpoints get no offset (they're free-floating).
 *
 * @param terminal - The terminal to compute jetty for
 * @param strokeWidth - Connector stroke width (affects offset)
 * @param hasCap - Whether this endpoint has an arrow cap
 */
function computeJettyPoint(
  terminal: Terminal,
  strokeWidth: number,
  hasCap: boolean
): [number, number] {
  const isAnchored = terminal.kind === 'shape';
  const offset = computeJettyOffset(isAnchored, hasCap, strokeWidth);

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
  // if (arrivalDir && moveDir === oppositeDir(arrivalDir)) {
  //   return Infinity;
  // }

  // BEND PENALTY (minimize direction changes)
  if (arrivalDir && moveDir !== arrivalDir) {
    cost += COST_CONFIG.BEND_PENALTY;
  }

  // CONTINUATION BONUS (prefer longer straight segments)
  if (arrivalDir && moveDir === arrivalDir) {
    cost -= COST_CONFIG.CONTINUATION_BONUS;
  }

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
 * NO DIRECTION SEEDING: Grid structure constrains valid moves.
 * NO U-TURN PREVENTION: Grid structure should prevent invalid paths by construction.
 *
 * @param grid - The routing grid
 * @param start - Start cell
 * @param goal - Goal cell
 * @returns Array of cells forming the path
 */
function astar(grid: Grid, start: GridCell, goal: GridCell): GridCell[] {
  const openSet = new MinHeap<AStarNode>((a, b) => a.f - b.f);
  const closedSet = new Set<string>();
  const gScores = new Map<string, number>();

  // NO DIRECTION SEEDING - start with null arrivalDir
  // Grid structure constrains valid first moves
  const startNode: AStarNode = {
    cell: start,
    g: 0,
    h: manhattan(start, goal),
    f: manhattan(start, goal),
    parent: null,
    arrivalDir: null, // No seeding - let A* explore freely
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

      // Compute move direction
      const moveDir = getDirection(current.cell, neighbor);

      // NO U-TURN PREVENTION - grid structure should prevent invalid paths
      // The cost function still penalizes direction changes via bend penalty

      // COST FUNCTION with bend penalty
      const moveCost = computeMoveCost(current.cell, neighbor, current.arrivalDir, moveDir);

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
 * Compute A* routed path for snapped endpoints.
 *
 * Used when to.kind === 'shape' (cursor snapped to shape).
 * Provides obstacle avoidance by routing around padded shape bounds.
 *
 * Cap-aware jetty computation:
 * - Anchored endpoints with arrow caps get full offset
 * - Unsnapped endpoints get no offset (free-floating)
 *
 * @param from - Start terminal
 * @param to - End terminal (must be snapped)
 * @param strokeWidth - Connector stroke width (affects offsets)
 * @returns Route result with path and signature
 */
export function computeAStarRoute(from: Terminal, to: Terminal, strokeWidth: number): RouteResult {
  // Determine if endpoints have caps
  // For now: startCap = 'none', endCap = 'arrow' (default)
  // TODO: Pass actual cap settings from caller
  const fromHasCap = false; // startCap = 'none' by default
  const toHasCap = true; // endCap = 'arrow' by default

  // 1. Compute jetty endpoints (cap-aware offset)
  const fromJetty = computeJettyPoint(from, strokeWidth, fromHasCap);
  const toJetty = computeJettyPoint(to, strokeWidth, toHasCap);

  // 2. Build non-uniform grid with obstacles blocked
  const grid = buildNonUniformGrid(from, to, fromJetty, toJetty, strokeWidth);

  // 3. Find start and goal cells
  // For anchored endpoints, start/goal is at JETTY position (in routing space)
  // For unsnapped endpoints, jetty IS the actual position (offset = 0)
  const startCell = findNearestCell(grid, fromJetty);
  const goalCell = findNearestCell(grid, toJetty);

  // 4. Run A* (no direction seeding)
  const path = astar(grid, startCell, goalCell);

  // 5. Assemble full path
  // Path includes start and goal cells, which are at jetty positions
  // We add actual endpoints at start and end
  const fullPath: [number, number][] = [fromJetty];

  // Add A* path (includes jetty positions as first/last cells)
  for (const cell of path) {
    fullPath.push([cell.x, cell.y]);
  }

  // Add actual endpoint
  fullPath.push(to.position);

  // 6. Simplify collinear points (removes duplicates when jetty = position)
  const simplified = simplifyOrthogonal(fullPath);

  return {
    points: simplified,
    signature: computeSignature(simplified),
  };
}
