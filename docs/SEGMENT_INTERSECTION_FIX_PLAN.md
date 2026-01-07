# Segment Intersection & Obstacle Blocking Fix - Implementation Plan

## Executive Summary

The current A* routing has a fundamental flaw: it only blocks individual cells but never checks if the segment (line) between two cells intersects an obstacle. With sparse non-uniform grids, routes can "jump over" shapes entirely. This document outlines the fix.

---

## Current State Analysis

### What Works ✅

1. **Centerline Computation**
   - `computeFacingSides()` computes centerlines between two shape AABBs
   - `computeFacingSidesFromPoint()` computes centerlines from free point to anchored shape
   - Centerlines use ACTUAL shape edges (midpoint between real geometry)

2. **Grid Line Placement with Centerline Merging**
   - When centerline exists, facing sides are merged into single centerline
   - Exterior (non-facing) sides still added for wrap-around routing
   - Goal position line still added for anchored endpoint connectivity

3. **Facing Side Cell Blocking**
   - `blockFacingSideCells()` blocks cells along facing side line EXCEPT goal cell
   - Creates "stub" effect - routes reach goal but can't travel parallel along facing line

4. **Direction Seeding**
   - ALWAYS seeds first direction (no more cursor-drag inference for anchored routing)
   - Three cases: anchored (use outwardDir), inside padding (escape logic), outside (spatial logic)
   - `computeFreeStartDirection()` handles same-side/opposite/adjacent scenarios
   - `computeSliverZoneEscape()` handles padding corridor escapes

### What's Broken ❌

#### Problem 1: No Segment Intersection Checking

```
Current A* flow:
Cell A → Cell B → Cell C

The algorithm only checks:
✓ Is Cell B blocked?
✗ Does segment (A→B) cross any obstacle?

With sparse grids (lines only at padding boundaries), this happens:

     Cell A                           Cell B
        ●━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━●
                    ┌────────┐
                    │ SHAPE  │   ← Route goes straight through!
                    └────────┘

There may be NO grid cells inside the shape at all!
```

#### Problem 2: Only One Obstacle Supported

Current `createCellGrid` signature:
```typescript
function createCellGrid(
  ...
  obstacle: AABB | null,  // ← Only ONE obstacle!
  ...
)
```

- Only `to.shapeBounds` is passed as obstacle
- For anchored→anchored: `from.shapeBounds` is IGNORED for blocking
- Routes can go straight through the start shape

#### Problem 3: Unnecessary Padding-Based Blocking

Current approach:
- If `startInsidePadding`: block shape + strokeInflation (small radius)
- Otherwise: block full padded bounds (large radius)

This is overcomplicated because:
1. Grid lines are ONLY placed at padding boundaries by construction
2. The only way to enter padded region is via segment crossing
3. Cell blocking alone can't prevent this

### The Solution Architecture

```
NEW A* FLOW:

1. Grid Construction:
   - Place lines at: endpoints, centerlines, padding boundaries (current)
   - Pass BOTH from.shapeBounds AND to.shapeBounds for blocking

2. Cell Blocking:
   - Block cells strictly inside shape bounds (NOT padded)
   - Block facing side cells except goal (current stub logic)

3. Segment Intersection Check (NEW):
   - Pass obstacle AABBs to A* algorithm
   - For each neighbor expansion, check: does segment intersect any obstacle?
   - If yes: skip this neighbor (don't expand through walls)
```

---

## Implementation Specification

### Part 1: Segment-AABB Intersection Test

**File:** `routing-astar.ts`

Add a function to check if a line segment intersects an AABB:

```typescript
/**
 * Check if a line segment intersects an AABB.
 *
 * Uses parametric line clipping (Liang-Barsky algorithm simplified for AABB).
 * Returns true if any part of segment is inside or crosses the box.
 *
 * @param x1, y1 - Segment start
 * @param x2, y2 - Segment end
 * @param aabb - Axis-aligned bounding box (strict shape bounds, NOT padded)
 * @returns true if segment intersects the AABB interior
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
    // Vertical line - check if X is inside
    if (x1 <= minX || x1 >= maxX) return false;
  } else {
    const t1 = (minX - x1) / dx;
    const t2 = (maxX - x1) / dx;
    const tEnter = Math.min(t1, t2);
    const tExit = Math.max(t1, t2);
    tMin = Math.max(tMin, tEnter);
    tMax = Math.min(tMax, tExit);
    if (tMin > tMax) return false;
  }

  // Check Y slab
  if (dy === 0) {
    // Horizontal line - check if Y is inside
    if (y1 <= minY || y1 >= maxY) return false;
  } else {
    const t1 = (minY - y1) / dy;
    const t2 = (maxY - y1) / dy;
    const tEnter = Math.min(t1, t2);
    const tExit = Math.max(t1, t2);
    tMin = Math.max(tMin, tEnter);
    tMax = Math.min(tMax, tExit);
    if (tMin > tMax) return false;
  }

  // Segment intersects the AABB interior
  return true;
}
```

**Why full segment check, not midpoint?**

Midpoint check fails for segments that just clip a corner:
```
A at (0, 50), B at (60, 50), Shape at (50, 0, 100, 100)
Midpoint = (30, 50) - OUTSIDE shape
But segment enters shape at x=50!
```

The segment intersection algorithm correctly handles all cases.

### Part 2: Pass Obstacles to A* Algorithm

**File:** `routing-astar.ts`

#### 2.1: Update `astar()` signature

```typescript
/**
 * Run A* pathfinding on the grid.
 *
 * @param grid - The routing grid
 * @param start - Start cell
 * @param goal - Goal cell
 * @param preferredFirstDir - Direction to prefer for first move
 * @param _requiredApproachDir - Direction to approach goal (penalty if wrong)
 * @param obstacles - Array of AABBs to check segment intersection against
 * @returns Array of cells forming the path
 */
function astar(
  grid: Grid,
  start: GridCell,
  goal: GridCell,
  preferredFirstDir: Dir | null,
  _requiredApproachDir: Dir,
  obstacles: AABB[]  // ← NEW PARAMETER
): GridCell[]
```

#### 2.2: Add segment check in A* loop

In the neighbor expansion loop, add intersection check:

```typescript
for (const neighbor of getNeighbors(grid, current.cell)) {
  // Skip blocked cells
  if (neighbor.blocked) continue;

  const neighborKey = cellKey(neighbor);
  if (closedSet.has(neighborKey)) continue;

  // NEW: Check if segment crosses any obstacle
  const segmentBlocked = obstacles.some(obs =>
    segmentIntersectsAABB(
      current.cell.x, current.cell.y,
      neighbor.x, neighbor.y,
      obs
    )
  );
  if (segmentBlocked) continue;  // ← Skip this neighbor

  // ... rest of A* logic (compute cost, add to open set)
}
```

### Part 3: Collect Obstacles for Routing

**File:** `routing-astar.ts`

#### 3.1: Update `computeAStarRoute()` to collect obstacles

```typescript
export function computeAStarRoute(from: Terminal, to: Terminal, strokeWidth: number): RouteResult {
  // ... existing setup (approach points, goal position, startInsidePadding check) ...

  // NEW: Collect obstacles for segment intersection checking
  const obstacles: AABB[] = [];

  if (to.shapeBounds) {
    obstacles.push(to.shapeBounds);
  }
  if (from.shapeBounds && from.shapeBounds !== to.shapeBounds) {
    obstacles.push(from.shapeBounds);
  }

  // ... build grid ...

  // Pass obstacles to A*
  const path = astar(grid, startCell, goalCell, preferredFirstDir, _requiredApproachDir, obstacles);

  // ... rest of function ...
}
```

### Part 4: Update Grid Construction for Two Obstacles

**File:** `routing-grid.ts`

#### 4.1: Update `createCellGrid()` signature

```typescript
function createCellGrid(
  xLines: number[],
  yLines: number[],
  obstacles: AABB[],  // ← Changed from `obstacle: AABB | null`
  _startPos: [number, number],
  _goalPos: [number, number],
  fromApproach: [number, number],
  toApproach: [number, number],
  strokeWidth: number,
  facing?: FacingSides
): Grid
```

#### 4.2: Update blocking logic

Simplify to strict shape bounds only (no padding):

```typescript
function createCellGrid(
  xLines: number[],
  yLines: number[],
  obstacles: AABB[],
  _startPos: [number, number],
  _goalPos: [number, number],
  fromApproach: [number, number],
  toApproach: [number, number],
  strokeWidth: number,
  facing?: FacingSides
): Grid {
  const cells: GridCell[][] = [];
  const strokeInflation = strokeWidth * 0.5 + 1;

  // Compute blocked bounds for each obstacle (strict bounds + stroke inflation)
  const blockedBounds: AABB[] = obstacles.map(obs => ({
    x: obs.x - strokeInflation,
    y: obs.y - strokeInflation,
    w: obs.w + strokeInflation * 2,
    h: obs.h + strokeInflation * 2,
  }));

  for (let yi = 0; yi < yLines.length; yi++) {
    cells[yi] = [];
    for (let xi = 0; xi < xLines.length; xi++) {
      const cellX = xLines[xi];
      const cellY = yLines[yi];

      // Cell is blocked if strictly inside ANY obstacle's blocked bounds
      let blocked = blockedBounds.some(bounds =>
        pointStrictlyInsideRect(cellX, cellY, bounds)
      );

      // NEVER block start, goal, or approach positions
      if (blocked) {
        const eps = 0.001;
        const isStart = Math.abs(cellX - fromApproach[0]) < eps && Math.abs(cellY - fromApproach[1]) < eps;
        const isGoal = Math.abs(cellX - toApproach[0]) < eps && Math.abs(cellY - toApproach[1]) < eps;
        if (isStart || isGoal) {
          blocked = false;
        }
      }

      cells[yi][xi] = { x: cellX, y: cellY, xi, yi, blocked };
    }
  }

  // Block facing side cells to create "stubs"
  if (facing) {
    blockFacingSideCells(cells, xLines, yLines, facing, toApproach);
  }

  return { cells, xLines, yLines };
}
```

#### 4.3: Update `buildNonUniformGrid()` call site

```typescript
export function buildNonUniformGrid(
  from: Terminal,
  to: Terminal,
  fromApproach: [number, number],
  toApproach: [number, number],
  strokeWidth: number,
  _startInsidePadding?: boolean  // ← No longer needed (can remove param)
): Grid {
  // ... existing line placement logic ...

  // Collect obstacles for cell blocking
  const obstacles: AABB[] = [];
  if (to.shapeBounds) {
    obstacles.push(to.shapeBounds);
  }
  if (from.shapeBounds && from.shapeBounds !== to.shapeBounds) {
    obstacles.push(from.shapeBounds);
  }

  // Build cell grid with all obstacles
  return createCellGrid(
    xSorted,
    ySorted,
    obstacles,
    from.position,
    to.position,
    fromApproach,
    toApproach,
    strokeWidth,
    facing
  );
}
```

### Part 5: Handle Anchored→Free Routing (Start Shape as Obstacle)

The current dispatch in `routing.ts`:

```typescript
if (!to.isAnchored) {
  return computeZRoute(from, to, strokeWidth);
} else {
  return computeAStarRoute(from, to, strokeWidth);
}
```

This means:
- **Free→Anchored**: Uses A*, `to.shapeBounds` is obstacle ✅
- **Anchored→Free**: Uses Z-route, NO obstacle avoidance ❌

For anchored→free, we may need A* routing too if the start is attached to a shape.

#### 5.1: Update dispatch logic

```typescript
export function computeRoute(
  from: Terminal,
  to: Terminal,
  _prevSignature: string | null,
  strokeWidth: number
): RouteResult {
  // Use A* if EITHER endpoint is anchored

  if (!From.isAnchored && !to.isAnchored) {
    // Both endpoints are free (no shapes to avoid)
    return computeZRoute(from, to, strokeWidth);
  } else {
    // At least one endpoint has a shape that needs avoiding
    return computeAStarRoute(from, to, strokeWidth);
  }
}
```

This enables:
- **Anchored→Free**: Uses A*, `from.shapeBounds` becomes obstacle
- **Anchored→Anchored**: Uses A*, both shapes are obstacles
- **Free→Anchored**: Uses A*, `to.shapeBounds` is obstacle (unchanged)
- **Free→Free**: Uses Z-route (unchanged)

### Part 6: Update Facing Sides for Anchored→Free

For anchored→free routing, we need to compute facing sides from start shape to the free point (reverse of current logic).

**File:** `routing-grid.ts`

Add a helper:

```typescript
/**
 * Compute facing sides from an anchored shape to a free point.
 * Inverse of computeFacingSidesFromPoint - the shape is the start, point is the end.
 */
function computeFacingSidesToPoint(
  startBounds: AABB,
  endPos: [number, number],
  startDir: Dir,  // from.outwardDir
  approachOffset: number
): FacingSides {
  const result: FacingSides = {
    startFacingX: null, endFacingX: null, centerlineX: null, hasXCenterline: false,
    startFacingY: null, endFacingY: null, centerlineY: null, hasYCenterline: false,
  };

  const [px, py] = endPos;
  const { x, y, w, h } = startBounds;

  const startDirIsHorizontal = startDir === 'E' || startDir === 'W';

  if (startDirIsHorizontal) {
    const shapeFacingX = startDir === 'E' ? x + w + approachOffset : x - approachOffset;
    const pointBeyondFacing = startDir === 'E' ? px > shapeFacingX : px < shapeFacingX;

    if (pointBeyondFacing) {
      const shapeEdgeX = startDir === 'E' ? x + w : x;
      result.startFacingX = shapeFacingX;
      result.endFacingX = px;
      result.centerlineX = (shapeEdgeX + px) / 2;
      result.hasXCenterline = true;
    }
  } else {
    const shapeFacingY = startDir === 'S' ? y + h + approachOffset : y - approachOffset;
    const pointBeyondFacing = startDir === 'S' ? py > shapeFacingY : py < shapeFacingY;

    if (pointBeyondFacing) {
      const shapeEdgeY = startDir === 'S' ? y + h : y;
      result.startFacingY = shapeFacingY;
      result.endFacingY = py;
      result.centerlineY = (shapeEdgeY + py) / 2;
      result.hasYCenterline = true;
    }
  }

  return result;
}
```

Update the facing sides computation in `buildNonUniformGrid()`:

```typescript
// Compute facing sides based on endpoint types
let facing: FacingSides;

if (from.shapeBounds && to.shapeBounds) {
  // Anchored→Anchored
  facing = computeFacingSides(from.shapeBounds, to.shapeBounds, approachOffset);
} else if (!from.isAnchored && to.shapeBounds) {
  // Free→Anchored
  facing = computeFacingSidesFromPoint(from.position, to.shapeBounds, to.outwardDir, approachOffset);
} else if (from.shapeBounds && !to.isAnchored) {
  // Anchored→Free (NEW CASE)
  facing = computeFacingSidesToPoint(from.shapeBounds, to.position, from.outwardDir, approachOffset);
} else {
  // Both free
  facing = { /* empty */ };
}
```

### Part 7: Update Facing Side Blocking for Start Shape

Currently `blockFacingSideCells()` only blocks `endFacingX` and `endFacingY`. For anchored→free, we need to also block `startFacingX` and `startFacingY` except for the start cell.

```typescript
function blockFacingSideCells(
  cells: GridCell[][],
  xLines: number[],
  yLines: number[],
  facing: FacingSides,
  fromApproach: [number, number],  // ← ADD: start approach
  toApproach: [number, number]
): void {
  const eps = 0.001;

  // Block END facing lines (existing)
  if (facing.hasXCenterline && facing.endFacingX !== null) {
    const xi = xLines.findIndex(x => Math.abs(x - facing.endFacingX!) < eps);
    if (xi >= 0) {
      for (let yi = 0; yi < yLines.length; yi++) {
        const cell = cells[yi][xi];
        if (Math.abs(cell.y - toApproach[1]) >= eps) {
          cell.blocked = true;
        }
      }
    }
  }

  if (facing.hasYCenterline && facing.endFacingY !== null) {
    const yi = yLines.findIndex(y => Math.abs(y - facing.endFacingY!) < eps);
    if (yi >= 0) {
      for (let xi = 0; xi < xLines.length; xi++) {
        const cell = cells[yi][xi];
        if (Math.abs(cell.x - toApproach[0]) >= eps) {
          cell.blocked = true;
        }
      }
    }
  }

  // NEW: Block START facing lines (for anchored→free)
  if (facing.hasXCenterline && facing.startFacingX !== null) {
    const xi = xLines.findIndex(x => Math.abs(x - facing.startFacingX!) < eps);
    if (xi >= 0) {
      for (let yi = 0; yi < yLines.length; yi++) {
        const cell = cells[yi][xi];
        // Don't block the start cell
        if (Math.abs(cell.y - fromApproach[1]) >= eps) {
          cell.blocked = true;
        }
      }
    }
  }

  if (facing.hasYCenterline && facing.startFacingY !== null) {
    const yi = yLines.findIndex(y => Math.abs(y - facing.startFacingY!) < eps);
    if (yi >= 0) {
      for (let xi = 0; xi < xLines.length; xi++) {
        const cell = cells[yi][xi];
        if (Math.abs(cell.x - fromApproach[0]) >= eps) {
          cell.blocked = true;
        }
      }
    }
  }
}
```

---

## Key Invariants

1. **Segment check uses strict shape bounds** (not padded) - we only need to avoid actual geometry
2. **Cell blocking uses stroke-inflated bounds** - small buffer around shapes
3. **Grid lines are at padding boundaries** - ensures approach room for arrows/corners
4. **Facing side blocking creates stubs** - routes enter/exit perpendicular, not parallel
5. **Obstacles list can be 0, 1, or 2 entries** - handles all endpoint combinations

---

---

## Success Criteria

1. **Routes never cross shapes** - Segment intersection prevents "jumping over"
2. **Anchored→Anchored works** - Both shapes are obstacles
3. **Anchored→Free works** - Start shape is obstacle
4. **Facing side stubs work** - Routes can't hug facing sides
5. **Typecheck passes** - No TypeScript errors
6. **Existing routes preserved** - Free→Anchored behavior unchanged

# Anchored→Free Z-Route Fix - Investigation & Plan

## Current Issue

After the previous fixes, obstacles work and L-routes are correct. But **anchored→free Z-routes are not occurring** - always getting VH L-routes instead of VHV Z-routes when dragging straight out from an anchor.

---

## Root Cause Analysis

### Why Free→Anchored Z-Routes Work

For **free→anchored** Z-routes:
1. `toHasShape = true` → we block `endFacingX/Y` (shape's facing side) except goal cell
2. This makes the VH L-route **impossible** - can only reach goal through centerline
3. Route is **forced** to use VHV: go to centerline, travel along it, then approach goal

### Why Anchored→Free Z-Routes Fail

For **anchored→free** Z-routes:
1. `toHasShape = false` → we DON'T block `endFacingY` (goal's Y line)
2. The VH L-route is **available**: go straight to goalY, then horizontal to goal
3. VH has **1 bend**, VHV has **2 bends** → A* prefers VH due to bend penalty!

### Trace Example (North Anchor → Free Point North)

```
Grid Y lines (north to south):
- goalY       ← NOT blocked (toHasShape = false)
- centerlineY
- paddingY    ← blocked except startX (opening for stub)
- stubY       ← start cell
- exteriorY

VH L-route (1 bend, cheaper):
(startX, stubY) → (startX, paddingY) → (startX, centerlineY) → (startX, goalY) → (goalX, goalY)
                                                                   ↑ NOT blocked!

VHV Z-route (2 bends, more expensive):
(startX, stubY) → (startX, paddingY) → (startX, centerlineY) → (goalX, centerlineY) → (goalX, goalY)

A* chooses VH because fewer bends = lower cost.
```

---

## The Fix

**For anchored→free with centerline (Z-route expected), block `endFacingY/X` except goal cell.**

This mirrors free→anchored behavior: block the goal's line to force routes through centerline.

### Implementation

In `blockFacingSideCells()`, add a new case for anchored→free Z-route forcing **after the existing `if (fromHasShape)` block**:

```typescript
// === BLOCK END FACING LINES FOR Z-ROUTE FORCING (anchored→free) ===
// When start is anchored and end is free, but we have a centerline,
// we need to block endFacingY/X to prevent VH L-routes and force VHV Z-routes.
// This mirrors the free→anchored behavior where we block the goal's facing side.

if (fromHasShape && !toHasShape) {
  // Block endFacingX if X centerline exists (horizontal anchor E/W)
  if (facing.hasXCenterline && facing.endFacingX !== null) {
    const xi = xLines.findIndex(x => Math.abs(x - facing.endFacingX!) < eps);
    if (xi >= 0) {
      for (let yi = 0; yi < yLines.length; yi++) {
        const cell = cells[yi][xi];
        // Don't block the goal cell itself
        if (Math.abs(cell.y - toApproach[1]) >= eps) {
          cell.blocked = true;
        }
      }
    }
  }

  // Block endFacingY if Y centerline exists (vertical anchor N/S)
  if (facing.hasYCenterline && facing.endFacingY !== null) {
    const yi = yLines.findIndex(y => Math.abs(y - facing.endFacingY!) < eps);
    if (yi >= 0) {
      for (let xi = 0; xi < xLines.length; xi++) {
        const cell = cells[yi][xi];
        // Don't block the goal cell itself
        if (Math.abs(cell.x - toApproach[0]) >= eps) {
          cell.blocked = true;
        }
      }
    }
  }
}
```

### Why This Works

1. `endFacingY = py` (goal's Y coordinate) for anchored→free with N/S anchor
2. Blocking all cells at goalY except (goalX, goalY) makes VH impossible:
   - The path `(startX, centerlineY) → (startX, goalY)` is now BLOCKED at `(startX, goalY)`
   - Only way to reach goalY is at goalX (through centerline)
3. Route is forced to use VHV: centerline H segment, then V to goal

### Important Notes

- This only triggers when `facing.hasXCenterline` or `facing.hasYCenterline` is true
- Centerline only exists when goal is "beyond" the anchor's facing side (Z-route scenario)
- For L-route scenarios (goal on adjacent side), no centerline → no blocking → L-route works normally

---

## File to Modify

**`client/src/lib/connectors/routing-grid.ts`** - `blockFacingSideCells()` function

Add the anchored→free Z-route blocking case at line ~521 (after the existing `if (fromHasShape)` block, before the closing brace).

---

## Testing Scenarios

After fix, verify:

1. **Anchored→Free Z-route (N anchor, drag north)**: Should produce VHV with centerline
2. **Anchored→Free Z-route (E anchor, drag east)**: Should produce HVH with centerline
3. **Anchored→Free L-route (N anchor, drag east)**: Should still produce VH L-route (no centerline, no blocking)
4. **Free→Anchored Z-route**: Should still work as before
