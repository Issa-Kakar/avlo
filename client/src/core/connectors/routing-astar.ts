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
 *
 * MEMORY MODEL:
 * - All A* state is module-pool typed arrays (cell-keyed: closedGen, gScoreGen,
 *   gScores; node-keyed: fScores, parentNode, arrivalDir, nodeCell).
 * - Generation counter (`astarGen`) makes "clear before use" a single increment
 *   instead of N writes.
 * - MinHeap stores node indices; comparator reads fScores.
 * - Path reconstruction walks parent indices forward into `pathCells`, then
 *   computeAStarRoute iterates in reverse, applying collinear simplification
 *   inline. Final Point[] is the only allocation per route.
 * - Pool sizes (MAX_CELLS=64, MAX_NODES=256) cover realistic A* grids; dev-mode
 *   warning fires if exceeded so the bound can be revisited.
 *
 * SYNCHRONOUS-ONLY: same contract as routing-context.ts. Module scratches are
 * not re-entrant; A* may recurse into itself once (obstacle-free retry) but
 * that recursion bumps `astarGen` and resets the node pool.
 */

import type { FrameTuple, Point } from '../types/geometry';
import { MinHeap } from './binary-heap';
import { COST_CONFIG } from './constants';
import { fillRoutingContext, fillSimpleGrid, GRID } from './routing-context';
import type { Dir, Grid, RouteResult } from './types';

// ============================================================================
// POOLS (module-level, reused across calls)
// ============================================================================

/** Realistic A* grid is ≤ 6×6 = 36; 8×8 = 64 covers the long tail. */
const MAX_CELLS = 64;
/** A* visits each cell ≤ ~3 times in practice; 4× cells covers worst cases. */
const MAX_NODES = 256;

// Cell-keyed state (one entry per grid cell). Keyed by `yi * xStride + xi`.
const closedGen = new Uint32Array(MAX_CELLS);
const gScoreGen = new Uint32Array(MAX_CELLS);
const gScores = new Float32Array(MAX_CELLS);

// Node-keyed state (one entry per heap node — multiple may map to one cell).
const fScores = new Float32Array(MAX_NODES);
const parentNode = new Int32Array(MAX_NODES);
const arrivalDir = new Int8Array(MAX_NODES);
const nodeCell = new Int32Array(MAX_NODES);

// Path reconstruction: cell indices walked goal-to-start.
const pathCells = new Int32Array(MAX_NODES);

// Open set heap: stores node indices, comparator reads fScores.
const openSet = new MinHeap<number>((a, b) => fScores[a] - fScores[b]);

let astarGen = 0;
let nodePoolIdx = 0;

// Cardinal direction encoded as 0..3 for tight typed-array storage.
const DIR_N = 0;
const DIR_E = 1;
const DIR_S = 2;
const DIR_W = 3;
const OPPOSITE_INT = [DIR_S, DIR_W, DIR_N, DIR_E];

function dirToInt(d: Dir): number {
  return d === 'N' ? DIR_N : d === 'E' ? DIR_E : d === 'S' ? DIR_S : DIR_W;
}

/** Cardinal direction from a delta as 0..3 (matches `directionFromDelta`). */
function dirFromDeltaInt(dx: number, dy: number): number {
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? DIR_E : DIR_W;
  return dy >= 0 ? DIR_S : DIR_N;
}

// ============================================================================
// GRID HELPERS
// ============================================================================

/** Find the nearest grid cell index for a world position. Returns `yi * xStride + xi`. */
function findNearestCellIdx(grid: Grid, pos: Point): number {
  let xi = 0;
  let yi = 0;
  let bestXDist = Infinity;
  let bestYDist = Infinity;

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

  return yi * grid.xLines.length + xi;
}

// ============================================================================
// SEGMENT-FRAME INTERSECTION
// ============================================================================

/**
 * Check if a line segment intersects the strict interior of a frame.
 *
 * Uses the slab method (parametric intersection). Handles thin shapes,
 * arbitrary orientations, and works directly on raw shape bounds.
 *
 * Scalar `(x1, y1, x2, y2)` parameters by design — inner-loop A* per-neighbor
 * call; unpacking a Point would be a wash.
 */
function segmentIntersectsFrame(x1: number, y1: number, x2: number, y2: number, frame: FrameTuple): boolean {
  const [x, y, w, h] = frame;
  const minX = x;
  const maxX = x + w;
  const minY = y;
  const maxY = y + h;

  const dx = x2 - x1;
  const dy = y2 - y1;

  let tMin = 0;
  let tMax = 1;

  if (dx === 0) {
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

  if (dy === 0) {
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

  return true;
}

// ============================================================================
// A*
// ============================================================================

/** Allocate a fresh node index. Falls back to last index in dev-mode warning if pool exhausted. */
function allocateNode(cellIdx: number): number {
  if (nodePoolIdx >= MAX_NODES) {
    if (import.meta.env.DEV) console.warn(`[routing-astar] node pool exhausted (MAX_NODES=${MAX_NODES})`);
    return MAX_NODES - 1;
  }
  const idx = nodePoolIdx++;
  nodeCell[idx] = cellIdx;
  return idx;
}

/**
 * Run A* pathfinding on the grid. Returns `pathLen` (path written into
 * `pathCells` in goal→start order) on success, `-1` when no path was found
 * even without obstacles.
 *
 * On failure with non-empty obstacles, recurses once with obstacles cleared —
 * the recursion bumps `astarGen` and resets the node pool, so it's safe.
 */
function astar(grid: Grid, startCellIdx: number, goalCellIdx: number, startDir: Dir, obstacles: FrameTuple[]): number {
  astarGen++;
  openSet.clear();
  nodePoolIdx = 0;

  const xStride = grid.xLines.length;
  const xMax = xStride - 1;
  const yMax = grid.yLines.length - 1;

  if (xStride * grid.yLines.length > MAX_CELLS) {
    if (import.meta.env.DEV) console.warn(`[routing-astar] cell count exceeded MAX_CELLS (${xStride * grid.yLines.length})`);
  }

  const goalYi = (goalCellIdx / xStride) | 0;
  const goalXi = goalCellIdx % xStride;
  const goalX = grid.xLines[goalXi];
  const goalY = grid.yLines[goalYi];

  // Seed start node. arrivalDir = startDir so the first move respects the shape side.
  const startNodeIdx = allocateNode(startCellIdx);
  parentNode[startNodeIdx] = -1;
  arrivalDir[startNodeIdx] = dirToInt(startDir);

  const startYi = (startCellIdx / xStride) | 0;
  const startXi = startCellIdx % xStride;
  const startX = grid.xLines[startXi];
  const startY = grid.yLines[startYi];
  const startH = Math.abs(startX - goalX) + Math.abs(startY - goalY);
  fScores[startNodeIdx] = startH;

  gScoreGen[startCellIdx] = astarGen;
  gScores[startCellIdx] = 0;

  openSet.push(startNodeIdx);

  while (!openSet.isEmpty()) {
    const currentNodeIdx = openSet.pop()!;
    const currentCellIdx = nodeCell[currentNodeIdx];

    if (currentCellIdx === goalCellIdx) {
      // Reconstruct: walk parent chain into pathCells (goal→start order).
      let pathLen = 0;
      let cur = currentNodeIdx;
      while (cur !== -1 && pathLen < MAX_NODES) {
        pathCells[pathLen++] = nodeCell[cur];
        cur = parentNode[cur];
      }
      return pathLen;
    }

    if (closedGen[currentCellIdx] === astarGen) continue;
    closedGen[currentCellIdx] = astarGen;

    const yi = (currentCellIdx / xStride) | 0;
    const xi = currentCellIdx % xStride;
    const fromX = grid.xLines[xi];
    const fromY = grid.yLines[yi];
    const arrDir = arrivalDir[currentNodeIdx];
    const currentG = gScores[currentCellIdx]; // gScoreGen guaranteed === astarGen here

    // Visit 4-connected neighbors, inlined to keep call count down.
    if (yi > 0) visit(currentNodeIdx, fromX, fromY, currentG, arrDir, xStride, xi, yi - 1, grid, obstacles, goalX, goalY);
    if (xi < xMax) visit(currentNodeIdx, fromX, fromY, currentG, arrDir, xStride, xi + 1, yi, grid, obstacles, goalX, goalY);
    if (yi < yMax) visit(currentNodeIdx, fromX, fromY, currentG, arrDir, xStride, xi, yi + 1, grid, obstacles, goalX, goalY);
    if (xi > 0) visit(currentNodeIdx, fromX, fromY, currentG, arrDir, xStride, xi - 1, yi, grid, obstacles, goalX, goalY);
  }

  // Retry without obstacles; recursion bumps astarGen + resets node pool.
  if (obstacles.length > 0) return astar(grid, startCellIdx, goalCellIdx, startDir, EMPTY_OBSTACLES);

  return -1;
}

const EMPTY_OBSTACLES: FrameTuple[] = [];

function visit(
  parentIdx: number,
  fromX: number,
  fromY: number,
  parentG: number,
  parentArrDir: number,
  xStride: number,
  toXi: number,
  toYi: number,
  grid: Grid,
  obstacles: FrameTuple[],
  goalX: number,
  goalY: number,
): void {
  const neighborCellIdx = toYi * xStride + toXi;
  if (closedGen[neighborCellIdx] === astarGen) return;

  const toX = grid.xLines[toXi];
  const toY = grid.yLines[toYi];

  for (let i = 0; i < obstacles.length; i++) {
    if (segmentIntersectsFrame(fromX, fromY, toX, toY, obstacles[i])) return;
  }

  const moveDirInt = dirFromDeltaInt(toX - fromX, toY - fromY);

  // Backwards prevention.
  if (moveDirInt === OPPOSITE_INT[parentArrDir]) return;

  let cost = Math.abs(toX - fromX) + Math.abs(toY - fromY);
  if (moveDirInt !== parentArrDir) cost += COST_CONFIG.BEND_PENALTY;

  const tentativeG = parentG + cost;
  const existingG = gScoreGen[neighborCellIdx] === astarGen ? gScores[neighborCellIdx] : Infinity;
  if (tentativeG >= existingG) return;

  gScoreGen[neighborCellIdx] = astarGen;
  gScores[neighborCellIdx] = tentativeG;

  const newNodeIdx = allocateNode(neighborCellIdx);
  parentNode[newNodeIdx] = parentIdx;
  arrivalDir[newNodeIdx] = moveDirInt;
  fScores[newNodeIdx] = tentativeG + Math.abs(toX - goalX) + Math.abs(toY - goalY);

  openSet.push(newNodeIdx);
}

// ============================================================================
// PATH EMISSION (collinear-aware)
// ============================================================================

/**
 * Push (x, y) onto `out`, merging with the previous candidate when the last
 * two points + the new point are collinear (sameX or sameY across all three).
 * Folds `simplifyOrthogonal` directly into the emission loop.
 */
function pushOrMerge(out: Point[], x: number, y: number): void {
  const len = out.length;
  if (len >= 2) {
    const prev = out[len - 2];
    const cand = out[len - 1];
    const sameX = Math.abs(prev[0] - cand[0]) < 0.001 && Math.abs(cand[0] - x) < 0.001;
    const sameY = Math.abs(prev[1] - cand[1]) < 0.001 && Math.abs(cand[1] - y) < 0.001;
    if (sameX || sameY) {
      cand[0] = x;
      cand[1] = y;
      return;
    }
  }
  out.push([x, y]);
}

// ============================================================================
// PUBLIC API
// ============================================================================

/**
 * Compute A* routed path for connected endpoints.
 *
 * Takes 7 primitives. Supports all endpoint combinations — anchored shape
 * bounds double as obstacles; `null` means free.
 *
 * Returns a freshly-allocated `Point[]`; all internal A* state is module-pool.
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
  if (startPos[0] === endPos[0] && startPos[1] === endPos[1]) {
    return { points: [endPos] };
  }

  const ctx = fillRoutingContext(startPos, startDir, endPos, endDir, startShapeBounds, endShapeBounds, strokeWidth);
  const grid = fillSimpleGrid(GRID, ctx);

  const startCellIdx = findNearestCellIdx(grid, ctx.startStub);
  const goalCellIdx = findNearestCellIdx(grid, ctx.endStub);

  const pathLen = astar(grid, startCellIdx, goalCellIdx, ctx.startDir, ctx.obstacles);

  // Emit final route with inline collinear simplification.
  const out: Point[] = [];
  pushOrMerge(out, startPos[0], startPos[1]);

  if (pathLen < 0) {
    // No path even without obstacles → direct line fallback.
    pushOrMerge(out, endPos[0], endPos[1]);
    return { points: out };
  }

  const xStride = grid.xLines.length;
  // pathCells holds cells in goal→start order; iterate in reverse for start→goal emission.
  for (let i = pathLen - 1; i >= 0; i--) {
    const cellIdx = pathCells[i];
    const yi = (cellIdx / xStride) | 0;
    const xi = cellIdx % xStride;
    pushOrMerge(out, grid.xLines[xi], grid.yLines[yi]);
  }
  pushOrMerge(out, endPos[0], endPos[1]);

  return { points: out };
}
