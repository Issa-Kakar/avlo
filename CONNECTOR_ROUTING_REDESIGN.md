# Connector Routing Redesign - Implementation Plan

**Date:** 2024-12-25
**Purpose:** Ground-up redesign of connector routing algorithm with A* Manhattan routing and proper obstacle avoidance.

---

## Table of Contents

1. [Design Principles](#1-design-principles)
2. [Algorithm Overview](#2-algorithm-overview)
3. [Data Model](#3-data-model)
4. [Phase 1: Z-Routing for Unsnapped Endpoints](#4-phase-1-z-routing-for-unsnapped-endpoints)
5. [Phase 2: A* Manhattan Routing](#5-phase-2-a-manhattan-routing)
6. [Phase 3: Non-Uniform Grid Construction](#6-phase-3-non-uniform-grid-construction)
7. [Phase 4: Direction Seeding](#7-phase-4-direction-seeding)
8. [Phase 5: Cost Function Design](#8-phase-5-cost-function-design)
9. [Phase 6: ConnectorTool Integration](#9-phase-6-connectortool-integration)
10. [Implementation Checklist](#10-implementation-checklist)
11. [File Structure](#11-file-structure)

---

## 1. Design Principles

### 1.1 Core Philosophy

**DISCARD ALL PREVIOUS PATTERNS.** This is a clean-room redesign based on these non-negotiable constraints:

1. **Two routing modes, not one:**
   - **Z-routing:** When endpoint is NOT snapped (free cursor)
   - **A* Manhattan routing:** When endpoint IS snapped to a shape

2. **Obstacle elimination, not post-hoc filtering:**
   - Grid cells overlapping obstacles are BLOCKED during grid construction
   - A* never visits blocked cells
   - Path is valid BY CONSTRUCTION (no `pathCrossesRect` filter needed)

3. **Generous padding:**
   - Obstacle padding = `shapeBounds + JETTY_LENGTH + ARROW_OFFSET + BUFFER`
   - This MUST be generous to prevent visual overlap

4. **Direction seeding:**
   - Initial jetty directions count as "previous turns" for penalty calculation
   - The first move away from the jetty is penalized if it's a direction change

5. **Backwards visit prevention:**
   - INFINITE cost for moving in the opposite direction of how you arrived
   - Never create U-shapes or spikes

### 1.2 What We're NOT Doing

- NO segment-by-segment intersection checking
- NO candidate generation + filtering approach
- NO `pathCrossesRect` function
- NO special-casing for "same-side approach" (A* handles it naturally)
- NO "quadrant elimination" heuristics (Manhattan distance handles heading)
- NO "early parallel penalty" (bend penalty already handles this)

---

## 2. Algorithm Overview

### 2.1 Decision Tree

```
computeRoute(from, to):
    │
    ├─ Is to.isAttached === false?
    │   │
    │   └─ YES → computeZRoute(from, to)
    │            Simple 3-segment HVH or VHV based on from.outwardDir
    │            Use HEAVY padding around any obstacles
    │
    └─ NO (endpoint IS snapped to shape) → computeAStarRoute(from, to)
         │
         ├─ Build non-uniform grid with blocked cells for obstacles
         ├─ Find start cell (fromJetty) and goal cell (toJetty)
         ├─ Run A* with Manhattan heuristic + cost function
         ├─ Assemble path: [from.pos, fromJetty, ...A*path..., toJetty, to.pos]
         └─ Simplify collinear points
```

### 2.2 When to Use Each Mode

| from.kind | to.kind | Routing Mode | Reason |
|-----------|---------|--------------|--------|
| world | world | Z-route | Both free, simple path |
| shape | world | Z-route | Free cursor, simple path |
| world | shape | A* Manhattan | Need obstacle avoidance |
| shape | shape | A* Manhattan | Need obstacle avoidance |

**Key insight:** A* is only needed when the DESTINATION is snapped, because that's when we have an obstacle (the target shape) to avoid.

---

## 3. Data Model

### 3.1 Terminal Interface (REVISED)

```typescript
/**
 * Terminal describes an endpoint during interaction.
 *
 * SEMANTIC CLARITY:
 * - `outwardDir` = direction the JETTY extends (AWAY from endpoint)
 * - For shape attachment: outwardDir = snap.side (the side we're on)
 * - For free endpoint: outwardDir = direction toward other endpoint
 */
interface Terminal {
  kind: 'world' | 'shape';
  position: [number, number];

  /**
   * Direction the jetty extends from this point.
   *
   * For shape-attached: SAME as the side we're attached to.
   *   - Attached to NORTH side → outwardDir = 'N' → jetty extends NORTH (away from shape)
   *   - Attached to EAST side → outwardDir = 'E' → jetty extends EAST (away from shape)
   *
   * For free endpoint:
   *   - Computed from relative position to other endpoint
   *   - Updated dynamically during drag
   */
  outwardDir: Dir;

  // Shape attachment metadata (only when kind === 'shape')
  shapeId?: string;
  shapeSide?: Dir;        // Which side attached to (same as outwardDir when attached)
  shapeT?: number;        // Position along edge [0-1], 0.5 = midpoint
  shapeBounds?: AABB;     // Full bounding box for obstacle avoidance
}

interface AABB {
  x: number;
  y: number;
  w: number;
  h: number;
}
```

### 3.2 Route Result Interface

```typescript
interface RouteResult {
  /** Full path including endpoints */
  points: [number, number][];
  /** Route signature for stability (e.g., 'HVH', 'VHV') */
  signature: string;
}
```

### 3.3 Grid Cell Interface

```typescript
interface GridCell {
  x: number;              // World X coordinate
  y: number;              // World Y coordinate
  xi: number;             // Grid index X
  yi: number;             // Grid index Y
  blocked: boolean;       // True if inside obstacle + padding
}

interface Grid {
  cells: GridCell[][];    // [yi][xi] access pattern
  xLines: number[];       // Sorted unique X coordinates
  yLines: number[];       // Sorted unique Y coordinates
}
```

### 3.4 A* Node Interface

```typescript
interface AStarNode {
  cell: GridCell;
  g: number;              // Cost from start
  h: number;              // Heuristic to goal
  f: number;              // g + h
  parent: AStarNode | null;
  arrivalDir: Dir | null; // Direction we arrived FROM (for bend penalty)
}
```

---

## 4. Phase 1: Z-Routing for Unsnapped Endpoints

### 4.1 When to Use

Z-routing is used when `to.kind === 'world'` (cursor is not snapped to any shape).

### 4.2 Algorithm

```typescript
function computeZRoute(from: Terminal, to: Terminal): RouteResult {
  const fromJetty = computeJettyPoint(from);
  const toJetty = computeJettyPoint(to);

  // Determine HVH vs VHV based on from.outwardDir
  const isFromHorizontal = from.outwardDir === 'E' || from.outwardDir === 'W';

  let midPoints: [number, number][];
  let signature: string;

  if (isFromHorizontal) {
    // HVH: horizontal from jetty, vertical middle, horizontal to jetty
    const midX = (fromJetty[0] + toJetty[0]) / 2;
    midPoints = [
      [midX, fromJetty[1]],
      [midX, toJetty[1]]
    ];
    signature = 'HVH';
  } else {
    // VHV: vertical from jetty, horizontal middle, vertical to jetty
    const midY = (fromJetty[1] + toJetty[1]) / 2;
    midPoints = [
      [fromJetty[0], midY],
      [toJetty[0], midY]
    ];
    signature = 'VHV';
  }

  const fullPath: [number, number][] = [
    from.position,
    fromJetty,
    ...midPoints,
    toJetty,
    to.position
  ];

  return {
    points: simplifyOrthogonal(fullPath),
    signature
  };
}
```

### 4.3 Heavy Padding for Z-Routes

Even in Z-routing, if there are obstacles in the path, we need padding. For now, Z-routes don't do obstacle avoidance (the cursor is free). If obstacle avoidance is needed for Z-routes in the future, switch to A* for those cases too.

---

## 5. Phase 2: A* Manhattan Routing

### 5.1 Core Algorithm

```typescript
function computeAStarRoute(from: Terminal, to: Terminal): RouteResult {
  // 1. Compute jetty endpoints
  const fromJetty = computeJettyPoint(from);
  const toJetty = computeJettyPoint(to);

  // 2. Build non-uniform grid with obstacles blocked
  const grid = buildNonUniformGrid(from, to, fromJetty, toJetty);

  // 3. Find start and goal cells
  const startCell = findNearestCell(grid, fromJetty);
  const goalCell = findNearestCell(grid, toJetty);

  // 4. Run A*
  const path = astar(grid, startCell, goalCell, from.outwardDir, to.outwardDir);

  // 5. Assemble full path
  const fullPath: [number, number][] = [
    from.position,
    fromJetty,
    ...path.map(cell => [cell.x, cell.y] as [number, number]),
    toJetty,
    to.position
  ];

  // 6. Simplify collinear points
  return {
    points: simplifyOrthogonal(fullPath),
    signature: computeSignature(fullPath)
  };
}
```

### 5.2 A* Implementation

```typescript
function astar(
  grid: Grid,
  start: GridCell,
  goal: GridCell,
  fromOutwardDir: Dir,
  toOutwardDir: Dir
): GridCell[] {
  const openSet = new MinHeap<AStarNode>((a, b) => a.f - b.f);
  const closedSet = new Set<string>();
  const gScores = new Map<string, number>();

  const cellKey = (c: GridCell) => `${c.xi},${c.yi}`;

  // Initial node - arrivalDir is the direction we "arrived" from the jetty
  // This is the OPPOSITE of fromOutwardDir because we're moving AWAY from from.position
  const initialArrivalDir = fromOutwardDir; // Direction of first segment

  const startNode: AStarNode = {
    cell: start,
    g: 0,
    h: manhattan(start, goal),
    f: manhattan(start, goal),
    parent: null,
    arrivalDir: initialArrivalDir // SEED THE INITIAL DIRECTION
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

    // Explore neighbors (4-connected: N, E, S, W)
    for (const neighbor of getNeighbors(grid, current.cell)) {
      if (neighbor.blocked) continue;

      const neighborKey = cellKey(neighbor);
      if (closedSet.has(neighborKey)) continue;

      // Compute move direction
      const moveDir = getDirection(current.cell, neighbor);

      // BACKWARDS VISIT PREVENTION
      if (current.arrivalDir && moveDir === oppositeDir(current.arrivalDir)) {
        continue; // Skip - would create U-turn
      }

      // Compute cost using full cost function
      const moveCost = computeMoveCost(
        current.cell,
        neighbor,
        current.arrivalDir,
        moveDir,
        goal,
        toOutwardDir
      );

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
          arrivalDir: moveDir
        };

        gScores.set(neighborKey, tentativeG);
        openSet.push(neighborNode);
      }
    }
  }

  // No path found - return direct line (fallback)
  return [start, goal];
}

function reconstructPath(node: AStarNode): GridCell[] {
  const path: GridCell[] = [];
  let current: AStarNode | null = node;

  while (current !== null) {
    path.unshift(current.cell);
    current = current.parent;
  }

  return path;
}
```

### 5.3 Direction Computation

```typescript
function getDirection(from: GridCell, to: GridCell): Dir {
  const dx = to.x - from.x;
  const dy = to.y - from.y;

  // For orthogonal grid, exactly one of dx/dy should be non-zero
  if (Math.abs(dx) > Math.abs(dy)) {
    return dx > 0 ? 'E' : 'W';
  } else {
    return dy > 0 ? 'S' : 'N';
  }
}

function manhattan(a: GridCell, b: GridCell): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}
```

---

## 6. Phase 3: Non-Uniform Grid Construction

### 6.1 Grid Line Selection

The grid is NOT a uniform pixel grid. Instead, grid lines are placed at meaningful positions:

```typescript
function buildNonUniformGrid(
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
    const padding = ROUTING_CONFIG.JETTY_W + ROUTING_CONFIG.ARROW_MIN_LENGTH_W + 12;
    const { x, y, w, h } = to.shapeBounds;

    // Inner boundaries (shape edge)
    xLines.push(x, x + w);
    yLines.push(y, y + h);

    // Outer boundaries (padded - valid routing corridors)
    xLines.push(x - padding, x + w + padding);
    yLines.push(y - padding, y + h + padding);
  }

  // === 4. Midpoints for Z-route flexibility ===
  const midX = (fromJetty[0] + toJetty[0]) / 2;
  const midY = (fromJetty[1] + toJetty[1]) / 2;
  xLines.push(midX);
  yLines.push(midY);

  // === 5. Dedupe and sort ===
  const xSorted = [...new Set(xLines)].sort((a, b) => a - b);
  const ySorted = [...new Set(yLines)].sort((a, b) => a - b);

  // === 6. Build cell grid ===
  return createCellGrid(xSorted, ySorted, to.shapeBounds);
}
```

### 6.2 Cell Grid Creation with Blocking

```typescript
function createCellGrid(
  xLines: number[],
  yLines: number[],
  obstacle: AABB | null
): Grid {
  const cells: GridCell[][] = [];

  // Compute padded obstacle bounds for blocking
  const paddedObstacle = obstacle ? {
    x: obstacle.x - ROUTING_CONFIG.JETTY_W,
    y: obstacle.y - ROUTING_CONFIG.JETTY_W,
    w: obstacle.w + ROUTING_CONFIG.JETTY_W * 2,
    h: obstacle.h + ROUTING_CONFIG.JETTY_W * 2
  } : null;

  for (let yi = 0; yi < yLines.length; yi++) {
    cells[yi] = [];
    for (let xi = 0; xi < xLines.length; xi++) {
      const cellX = xLines[xi];
      const cellY = yLines[yi];

      // Cell is blocked if INSIDE the padded obstacle
      // (NOT on boundary - boundary is valid routing corridor)
      const blocked = paddedObstacle ? pointInsideRect(cellX, cellY, paddedObstacle) : false;

      cells[yi][xi] = {
        x: cellX,
        y: cellY,
        xi,
        yi,
        blocked
      };
    }
  }

  return { cells, xLines, yLines };
}

function pointInsideRect(x: number, y: number, rect: AABB): boolean {
  // Strict interior check (boundary is NOT inside)
  return x > rect.x && x < rect.x + rect.w && y > rect.y && y < rect.y + rect.h;
}
```

### 6.3 Finding Cells and Neighbors

```typescript
function findNearestCell(grid: Grid, pos: [number, number]): GridCell {
  // Find closest grid line indices
  const xi = findNearestIndex(grid.xLines, pos[0]);
  const yi = findNearestIndex(grid.yLines, pos[1]);
  return grid.cells[yi][xi];
}

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

function getNeighbors(grid: Grid, cell: GridCell): GridCell[] {
  const neighbors: GridCell[] = [];
  const { xi, yi } = cell;

  // 4-connected neighbors (N, E, S, W)
  if (yi > 0) neighbors.push(grid.cells[yi - 1][xi]);                    // N
  if (xi < grid.xLines.length - 1) neighbors.push(grid.cells[yi][xi + 1]); // E
  if (yi < grid.yLines.length - 1) neighbors.push(grid.cells[yi + 1][xi]); // S
  if (xi > 0) neighbors.push(grid.cells[yi][xi - 1]);                    // W

  return neighbors;
}
```

---

## 7. Phase 4: Direction Seeding

### 7.1 Why Direction Seeding Matters

**CRITICAL REQUIREMENT:** The initial direction from the jetty must be treated as a "previous turn" for penalty calculation.

Without seeding:
- First move from fromJetty has no `arrivalDir`
- No bend penalty applies to the first turn
- Path can immediately turn away from jetty direction

With seeding:
- First move from fromJetty has `arrivalDir = from.outwardDir`
- If first move differs from outwardDir, bend penalty applies
- Path is encouraged to continue in jetty direction initially

### 7.2 Implementation

In the A* start node:

```typescript
const startNode: AStarNode = {
  cell: start,
  g: 0,
  h: manhattan(start, goal),
  f: manhattan(start, goal),
  parent: null,
  arrivalDir: from.outwardDir  // ← SEED THE DIRECTION
};
```

Now when exploring the first neighbor:
- If neighbor is in `from.outwardDir` direction → no bend penalty
- If neighbor is perpendicular to `from.outwardDir` → BEND_PENALTY applies
- If neighbor is opposite to `from.outwardDir` → BLOCKED (backwards)

### 7.3 Final Segment Seeding

Similarly, we should consider the required arrival direction at the goal (toJetty must approach in a direction compatible with `to.outwardDir`).

This is handled implicitly: the final segment is `toJetty → to.position`, and `toJetty` is positioned such that this segment follows `oppositeDir(to.outwardDir)` direction (pointing INTO the shape).

The A* will naturally find a path that reaches `toJetty` from a direction that allows the final segment to work.

---

## 8. Phase 5: Cost Function Design

### 8.1 Cost Components

```typescript
const COST_CONFIG = {
  /** Penalty for changing direction (creating a bend) */
  BEND_PENALTY: 1000,

  /** Bonus for continuing in same direction (longer segments) */
  CONTINUATION_BONUS: 10,

  /** Penalty for very short segments (less than JETTY_W) */
  SHORT_SEGMENT_PENALTY: 50,

  /** Base cost is Manhattan distance */
};
```

### 8.2 Full Cost Function

```typescript
function computeMoveCost(
  from: GridCell,
  to: GridCell,
  arrivalDir: Dir | null,
  moveDir: Dir,
  goal: GridCell,
  goalOutwardDir: Dir
): number {
  // Base cost: Manhattan distance of this segment
  let cost = Math.abs(to.x - from.x) + Math.abs(to.y - from.y);

  // === 1. BACKWARDS PREVENTION (handled in A* loop, but double-check) ===
  if (arrivalDir && moveDir === oppositeDir(arrivalDir)) {
    return Infinity;
  }

  // === 2. BEND PENALTY (minimize direction changes) ===
  if (arrivalDir && moveDir !== arrivalDir) {
    cost += COST_CONFIG.BEND_PENALTY;
  }

  // === 3. CONTINUATION BONUS (prefer longer straight segments) ===
  if (arrivalDir && moveDir === arrivalDir) {
    cost -= COST_CONFIG.CONTINUATION_BONUS;
  }

  // === 4. SHORT SEGMENT PENALTY ===
  const segmentLength = Math.abs(to.x - from.x) + Math.abs(to.y - from.y);
  if (segmentLength < ROUTING_CONFIG.JETTY_W && arrivalDir !== null) {
    // Penalize short segments (except first segment from jetty)
    cost += COST_CONFIG.SHORT_SEGMENT_PENALTY;
  }

  return cost;
}
```

### 8.3 Why This Works

**Manhattan distance** naturally captures "heading":
- If goal is mostly to the right, eastward moves reduce heuristic faster
- No need for explicit "heading" calculation

**Bend penalty** naturally handles:
- L-route vs Z-route selection (L has fewer bends)
- Same-side approach (will route around if that's fewer bends)
- Parallel vs orthogonal first move (will pick whichever leads to fewer total bends)

**Continuation bonus** handles:
- Preferring one long segment over many short ones
- Preventing stair-stepping on non-uniform grid

**Backwards prevention** handles:
- Never creating U-turns
- Never creating spike patterns

---

## 9. Phase 6: ConnectorTool Integration

### 9.1 Direction Computation When Snapped (IMPLEMENTED)

When `to.kind === 'shape'` (snapped), compute `from.outwardDir` based on THREE cases:

**The Final Approach Principle:**
- N/S snaps → final approach is VERTICAL (perpendicular to horizontal edge)
- E/W snaps → final approach is HORIZONTAL (perpendicular to vertical edge)

**Three Cases:**

| Case | Condition | First Segment | Reason |
|------|-----------|---------------|--------|
| SAME SIDE | from on same side as snap | PERPENDICULAR | No obstacle, align first, clean L-shape |
| OPPOSITE (beside) | from opposite, outside extent | PARALLEL | Route around shape |
| BEHIND SHAPE | from opposite, within extent | PERPENDICULAR | Exit extent first, then around |

```typescript
function computeFromOutwardDirOnSnap(
  fromPos: [number, number],
  toSide: Dir,
  shapeBounds: { x: number; y: number; w: number; h: number }
): Dir {
  const { x, y, w, h } = shapeBounds;
  const shapeCenterX = x + w / 2;
  const shapeCenterY = y + h / 2;

  switch (toSide) {
    case 'N': // Final approach is vertical (down into shape)
      if (fromPos[1] < y) {
        // SAME SIDE: from is above shape
        // Go horizontal first to align X, then vertical approach
        return fromPos[0] < shapeCenterX ? 'E' : 'W';
      } else if (fromPos[0] > x && fromPos[0] < x + w) {
        // BEHIND SHAPE: horizontally within shape extent
        // Go horizontal to exit shape width first
        return fromPos[0] < shapeCenterX ? 'W' : 'E';
      }
      // OPPOSITE SIDE (beside): go up to match toJetty level
      return 'N';

    // ... similar for S, E, W
  }
}
```

**Example Scenarios:**

1. **SAME SIDE:** from at (50, 50), snap to TOP at (200, 100)
   - from.y < shape.y → SAME SIDE
   - Returns 'E' (go right to align, then down)
   - Path: HV with clean vertical approach

2. **OPPOSITE (beside):** from at (50, 250), snap to TOP at (200, 100)
   - from.y > shape.y+h AND from.x outside shape → BESIDE
   - Returns 'N' (go up to clear, then across)
   - Path: VH routing around

3. **BEHIND SHAPE:** from at (200, 250), snap to TOP at (200, 100)
   - from.y > shape.y+h AND from.x inside shape → BEHIND
   - Returns 'E' or 'W' (exit shape extent first)
   - Path: HVH U-turn around

### 9.2 Updated move() Implementation

```typescript
move(worldX: number, worldY: number): void {
  const scale = useCameraStore.getState().scale;

  // ... existing snap detection code ...

  if (snap) {
    // Snapped to shape
    this.to = {
      kind: 'shape',
      position: snap.position,
      outwardDir: snap.side,  // ← Jetty extends AWAY from shape
      shapeId: snap.shapeId,
      shapeSide: snap.side,
      shapeT: snap.t,
      shapeBounds: getShapeBounds(snap.shapeId)
    };

    // Update from.outwardDir based on relative position to snapped target
    if (this.from.kind === 'world') {
      this.from.outwardDir = computeStartDirection(
        this.from.position,
        this.to.position,
        snap.side
      );
    }
  } else {
    // Free endpoint - use drag direction inference
    this.dragDir = inferDragDirection(fromPos, cursorPos, this.dragDir);

    if (this.from.kind === 'world') {
      this.from.outwardDir = this.dragDir;
    }

    this.to = {
      kind: 'world',
      position: [worldX, worldY],
      outwardDir: oppositeDir(this.dragDir)
    };
  }

  this.updateRoute();
}
```

### 9.3 Updated updateRoute() Implementation

```typescript
private updateRoute(): void {
  if (!this.from || !this.to) {
    this.routedPoints = [];
    return;
  }

  // Two-mode routing dispatch
  if (this.to.kind === 'world') {
    // Free cursor - use simple Z-routing
    const result = computeZRoute(this.from, this.to);
    this.routedPoints = result.points;
    this.prevRouteSignature = result.signature;
  } else {
    // Snapped to shape - use A* Manhattan routing
    const result = computeAStarRoute(this.from, this.to);
    this.routedPoints = result.points;
    this.prevRouteSignature = result.signature;
  }
}
```

---

## 10. Implementation Checklist

### 10.1 New Files to Create

- [x] `client/src/lib/connectors/routing-astar.ts` - A* implementation ✓
- [x] `client/src/lib/connectors/routing-grid.ts` - Non-uniform grid construction ✓
- [x] `client/src/lib/connectors/routing-zroute.ts` - Z-route implementation ✓

### 10.2 Files to Modify

- [x] `client/src/lib/connectors/routing.ts` - Replace with dispatcher ✓
- [x] `client/src/lib/connectors/constants.ts` - Add COST_CONFIG + OBSTACLE_PADDING_W ✓
- [x] `client/src/lib/tools/ConnectorTool.ts` - Added computeFromOutwardDirOnSnap() ✓

### 10.3 Known Issues (TODO)

**Padding/Offset Problem:**
Routes still hug the shape frame too closely. The arrow tip overlaps or precedes the routing waypoints.

Root cause: toJetty is computed as `to.position - JETTY_W`, but:
1. JETTY_W (16) is less than arrow length (~10-14)
2. Grid blocking only blocks shape interior, not padding corridors
3. Routes can pass close to shape edge

**Proposed fix:**
1. Increase toJetty offset: `JETTY_W + ARROW_MIN_LENGTH_W + buffer`
2. Block cells within arrow-length of shape, not just interior
3. Ensure routing waypoints stay outside arrow tip zone

**A* vs Heuristic for First Segment:**
Current `computeFromOutwardDirOnSnap()` uses quadrant heuristics. Alternative approach:
- Include `from.position` as a graph node (not just fromJetty)
- Let A* choose the optimal first direction
- Only add guards for same-side edge cases

### 10.4 Files to Delete (or gut)

- [ ] Remove `pathCrossesRect` function (no longer needed)
- [ ] Remove `generateRouteCandidates` function (replaced by A*)
- [ ] Remove `generateDoglegCandidates` function (A* handles routing around)
- [ ] Remove `pickBestRoute` function (A* finds optimal)

### 10.4 Test Scenarios

1. **Free cursor (Z-route):**
   - [ ] Drag from empty space, cursor never snaps
   - [ ] Path is clean HVH or VHV based on direction inferred
   - [ ] Direction changes during drag update first segment

2. **Snapped endpoint (A* route):**
   - [ ] Snap to left side of rect from the left (same-side)
   - [ ] Snap to left side from above-left
   - [ ] Snap to left side from below-right
   - [ ] Path never crosses through target shape
   - [ ] Minimal bends
   - [ ] No backwards segments

3. **Edge cases:**
   - [ ] Very close snap (almost touching shape)
   - [ ] Snap to midpoint vs edge point
   - [ ] Multiple shapes (only target is obstacle for now)

---

## 11. File Structure

### 11.1 Final Module Structure

```
client/src/lib/connectors/
├── index.ts              # Re-exports
├── constants.ts          # SNAP_CONFIG, ROUTING_CONFIG, COST_CONFIG
├── shape-utils.ts        # Dir, ShapeFrame, getOutwardVector, etc. (unchanged)
├── snap.ts               # findBestSnapTarget, computeSnapForShape (unchanged)
├── routing.ts            # computeRoute dispatcher (rewritten)
├── routing-zroute.ts     # computeZRoute (new)
├── routing-grid.ts       # buildNonUniformGrid, cell utilities (new)
└── routing-astar.ts      # A* implementation (new)
```

### 11.2 routing.ts (New Dispatcher)

```typescript
/**
 * Connector Routing - Main Entry Point
 *
 * Two-mode routing:
 * 1. Z-routing for free cursor (simple 3-segment path)
 * 2. A* Manhattan routing for snapped endpoints (obstacle avoidance)
 */

import { computeZRoute } from './routing-zroute';
import { computeAStarRoute } from './routing-astar';
import type { Dir } from './shape-utils';

export interface Terminal {
  kind: 'world' | 'shape';
  position: [number, number];
  outwardDir: Dir;
  shapeId?: string;
  shapeSide?: Dir;
  shapeT?: number;
  shapeBounds?: { x: number; y: number; w: number; h: number };
}

export interface RouteResult {
  points: [number, number][];
  signature: string;
}

export function computeRoute(from: Terminal, to: Terminal): RouteResult {
  if (to.kind === 'world') {
    return computeZRoute(from, to);
  } else {
    return computeAStarRoute(from, to);
  }
}

// Re-export inferDragDirection for ConnectorTool
export { inferDragDirection } from './routing-zroute';
```

---

## Appendix A: Constants Reference

```typescript
// constants.ts additions

export const COST_CONFIG = {
  /** Penalty for changing direction (creating a bend) */
  BEND_PENALTY: 1000,

  /** Bonus for continuing in same direction */
  CONTINUATION_BONUS: 10,

  /** Penalty for short segments */
  SHORT_SEGMENT_PENALTY: 50,
} as const;

export const ROUTING_CONFIG = {
  // ... existing ...

  /** Obstacle padding beyond shape bounds (world units) */
  OBSTACLE_PADDING_W: 24, // JETTY_W + ARROW_MIN_LENGTH_W
} as const;
```

---

## Appendix B: MinHeap Implementation

For A* efficiency, we need a min-heap for the open set:

```typescript
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

      if (leftIdx < this.items.length &&
          this.compareFn(this.items[leftIdx], this.items[smallest]) < 0) {
        smallest = leftIdx;
      }
      if (rightIdx < this.items.length &&
          this.compareFn(this.items[rightIdx], this.items[smallest]) < 0) {
        smallest = rightIdx;
      }

      if (smallest === idx) break;
      [this.items[idx], this.items[smallest]] = [this.items[smallest], this.items[idx]];
      idx = smallest;
    }
  }
}
```

---

## Appendix C: Visual Diagram

```
Snapped to LEFT side of rectangle, approach from bottom-left:

                        RECTANGLE
               ┌─────────────────────────┐
               │                         │
    toJetty ●──┤ ← to.position           │
           ↑   │   (snap point)          │
     padding   │                         │
               └─────────────────────────┘
               x=100                  x=300


●───────────●───────────●
from.pos    midpoint    toJetty

Path: from.pos → fromJetty → [A* finds path avoiding rect] → toJetty → to.pos

With correct jetty direction:
- to.outwardDir = 'W' (west, away from rectangle)
- toJetty is at (100 - JETTY_W, y) = (84, 50)
- Last segment: (84,50) → (100,50) points EAST (into rectangle)
- Arrow head points EAST (opposite of outwardDir)
```

---

*End of Implementation Plan*
