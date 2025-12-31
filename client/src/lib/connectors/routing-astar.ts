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

import { COST_CONFIG, computeJettyOffset, computeApproachOffset } from './constants';
import { getOutwardVector, oppositeDir, type Dir } from './shape-utils';
import {
  buildNonUniformGrid,
  findNearestCell,
  getNeighbors,
  type Grid,
  type GridCell,
} from './routing-grid';
import type { Terminal, RouteResult } from './routing-zroute';

/**
 * Check if a position is inside the padded region (but outside the shape).
 *
 * A point is "inside padded region" if:
 * - Inside the padded AABB (shape + approachOffset on all sides)
 * - BUT outside the actual shape bounds
 *
 * This is the "corridor" zone where we need special handling.
 *
 * @param pos - Position to check
 * @param shapeBounds - Shape bounds
 * @param strokeWidth - Connector stroke width
 * @returns True if position is in the padded corridor
 */
function isInsidePaddedRegion(
  pos: [number, number],
  shapeBounds: { x: number; y: number; w: number; h: number },
  strokeWidth: number
): boolean {
  const offset = computeApproachOffset(strokeWidth);

  // Padded bounds
  const pMinX = shapeBounds.x - offset;
  const pMaxX = shapeBounds.x + shapeBounds.w + offset;
  const pMinY = shapeBounds.y - offset;
  const pMaxY = shapeBounds.y + shapeBounds.h + offset;

  // Shape bounds
  const sMinX = shapeBounds.x;
  const sMaxX = shapeBounds.x + shapeBounds.w;
  const sMinY = shapeBounds.y;
  const sMaxY = shapeBounds.y + shapeBounds.h;

  const insidePadded = pos[0] > pMinX && pos[0] < pMaxX &&
                       pos[1] > pMinY && pos[1] < pMaxY;
  const insideShape = pos[0] > sMinX && pos[0] < sMaxX &&
                      pos[1] > sMinY && pos[1] < sMaxY;

  return insidePadded && !insideShape;
}

/**
 * Compute preferred first direction when starting INSIDE the padded region.
 *
 * Three distinct cases based on relationship between start zone and target side:
 *
 * 1. SAME SIDE: Start in N padding → Snap to N
 *    → Escape away from shape (return N)
 *
 * 2. OPPOSITE SIDE: Start in S padding → Snap to N
 *    → Go E/W toward target's X position (need to wrap around)
 *
 * 3. ADJACENT SIDE: Start in S padding → Snap to W
 *    → Go directly toward target side (return W)
 *    This creates clean L-routes without weird near-corner behavior
 *
 * @param fromPos - Start position (inside padded region)
 * @param to - Target terminal (must be anchored with shapeBounds)
 * @returns Preferred first direction
 */
function computePreferredFirstDir(
  fromPos: [number, number],
  to: Terminal
): Dir {
  if (!to.shapeBounds) {
    return to.outwardDir;
  }

  const { x, y, w, h } = to.shapeBounds;
  const toPos = to.position;
  const toSide = to.outwardDir;

  // Determine which side(s) of the shape we're on
  // Note: corner positions will have two flags true (e.g., SW corner: isBelowShape && isLeftOfShape)
  const isAboveShape = fromPos[1] < y;
  const isBelowShape = fromPos[1] > y + h;
  const isLeftOfShape = fromPos[0] < x;
  const isRightOfShape = fromPos[0] > x + w;

  // === SAME SIDE ===
  // We're on the same side as the target - escape away from shape
  const isSameSide =
    (toSide === 'N' && isAboveShape) ||
    (toSide === 'S' && isBelowShape) ||
    (toSide === 'E' && isRightOfShape) ||
    (toSide === 'W' && isLeftOfShape);

  if (isSameSide) {
    return toSide; // Escape in outward direction
  }

  // === OPPOSITE SIDE ===
  // We're on the opposite side - need to wrap around the shape
  // Use target position to decide which way around (E/W or N/S)
  const isOppositeSide =
    (toSide === 'N' && isBelowShape) ||
    (toSide === 'S' && isAboveShape) ||
    (toSide === 'E' && isLeftOfShape) ||
    (toSide === 'W' && isRightOfShape);

  if (isOppositeSide) {
    if (toSide === 'N' || toSide === 'S') {
      // Vertical target - decide E/W based on target X
      return fromPos[0] < toPos[0] ? 'E' : 'W';
    } else {
      // Horizontal target - decide N/S based on target Y
      return fromPos[1] < toPos[1] ? 'S' : 'N';
    }
  }

  // === ADJACENT SIDE ===
  // We're on a perpendicular side - go directly toward target side
  // This creates clean L-shaped routes (e.g., S padding → W snap → go W first)
  return toSide;
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
 * Direction hints are now used for soft preferences:
 * - preferredFirstDir: Gives a bonus when first move matches this direction
 * - requiredApproachDir: Gives a penalty when goal is approached from wrong direction
 *
 * @param grid - The routing grid
 * @param start - Start cell
 * @param goal - Goal cell
 * @param preferredFirstDir - Direction to prefer for first move (soft bonus)
 * @param requiredApproachDir - Direction to approach goal (penalty if wrong)
 * @returns Array of cells forming the path
 */
function astar(
  grid: Grid,
  start: GridCell,
  goal: GridCell,
  preferredFirstDir: Dir | null,
  requiredApproachDir: Dir
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
    arrivalDir: null,
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

      // Base cost with bend penalty
      let moveCost = computeMoveCost(current.cell, neighbor, current.arrivalDir, moveDir);

      // FIRST DIRECTION BONUS - apply at start node when preferredFirstDir is set
      // Only applied when starting inside padding or from anchored position
      if (current.parent === null && preferredFirstDir && moveDir === preferredFirstDir) {
        moveCost -= COST_CONFIG.FIRST_DIR_BONUS;
      }

      // APPROACH MISMATCH PENALTY - disabled (creates weird routes)
      // if (neighbor.xi === goal.xi && neighbor.yi === goal.yi) {
      //   if (moveDir !== requiredApproachDir) {
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
 * Compute A* routed path for snapped endpoints.
 *
 * Used when to.isAnchored === true (cursor snapped to shape).
 * Provides obstacle avoidance by routing around padded shape bounds.
 *
 * DYNAMIC BEHAVIOR based on start position:
 * - If starting INSIDE padded region: uses smaller blocking bounds + seeds direction
 * - If starting OUTSIDE: uses full padded bounds + lets A* decide naturally
 *
 * @param from - Start terminal
 * @param to - End terminal (must be snapped)
 * @param strokeWidth - Connector stroke width (affects offsets)
 * @returns Route result with path and signature
 */
export function computeAStarRoute(from: Terminal, to: Terminal, strokeWidth: number): RouteResult {
  // 1. Compute approach points
  const fromApproach = computeApproachPoint(from, strokeWidth);
  const toApproach = computeApproachPoint(to, strokeWidth);

  // 2. Compute goal position at padding intersection
  const goalPos = computeGoalPosition(to, strokeWidth);

  // 3. Check if starting inside padded region (for dynamic blocking + seeding)
  const startInsidePadding = to.shapeBounds
    ? isInsidePaddedRegion(from.position, to.shapeBounds, strokeWidth)
    : false;

  // 4. Build non-uniform grid with dynamic blocking
  const grid = buildNonUniformGrid(from, to, fromApproach, toApproach, strokeWidth, startInsidePadding);

  // 5. Find start and goal cells
  const startCell = findNearestCell(grid, fromApproach);
  const goalCell = findNearestCell(grid, goalPos);

  // 6. Compute direction hints - CONDITIONAL SEEDING
  // - Anchored start: always use outwardDir
  // - Inside padding: compute escape direction toward target
  // - Outside padding: null (let A* decide naturally)
  let preferredFirstDir: Dir | null = null;

  if (from.isAnchored) {
    // Anchored start always uses outwardDir
    preferredFirstDir = from.outwardDir;
  } else if (startInsidePadding) {
    // Only seed direction when starting in padded zone
    preferredFirstDir = computePreferredFirstDir(from.position, to);
  }
  // else: null - let A* decide naturally (works well for normal cases)

  // Required approach: must enter goal from opposite of to.outwardDir
  // (kept for potential future use, currently APPROACH_MISMATCH_PENALTY is disabled)
  const _requiredApproachDir = oppositeDir(to.outwardDir);

  // 7. Run A* with direction hints
  const path = astar(grid, startCell, goalCell, preferredFirstDir, _requiredApproachDir);

  // 8. Assemble full path: actual start → A* path → actual end
  const fullPath: [number, number][] = [from.position];
  for (const cell of path) {
    fullPath.push([cell.x, cell.y]);
  }
  fullPath.push(to.position);

  // 9. Simplify collinear points
  const simplified = simplifyOrthogonal(fullPath);

  return {
    points: simplified,
    signature: computeSignature(simplified),
  };
}
