# Connector Routing Phase 1: Grid Architecture Redesign

**Date:** 2024-12-27
**Status:** Planning
**Purpose:** Fix fundamental routing issues by restructuring grid architecture and removing artificial constraints
**Dependencies:** CONNECTOR_OFFSET_REDESIGN.md (offset math complete), CONNECTOR_ROUTING_REDESIGN.md (A* foundation)

---

## Table of Contents

1. [Problem Summary](#1-problem-summary)
2. [Root Cause Analysis](#2-root-cause-analysis)
3. [Design Principles](#3-design-principles)
4. [Phase 1 Changes](#4-phase-1-changes)
5. [Implementation Order](#5-implementation-order)
6. [Detailed Implementation Steps](#6-detailed-implementation-steps)
7. [Testing Scenarios](#7-testing-scenarios)
8. [Deferred to Phase 2](#8-deferred-to-phase-2)

---

## 1. Problem Summary

### Current Symptoms

1. **Zig-zag on same-side approach**: When starting close to a shape on the same side as the anchor, routing creates unnecessary turns instead of a simple U-turn or L-shape.

2. **"No path found" straight-line fallbacks**: A* fails to find any valid path and falls back to a straight line from start to end (visible as a diagonal line cutting through shapes).

3. **Trapped in padding zone**: When the start position is inside the approach offset padding zone, direction seeding + U-turn prevention creates a dead end with no valid neighbors.

4. **Wrong first segment direction**: `computeFromOutwardDirOnSnap()` computes directions without accounting for the new strokeWidth-based offset, leading to suboptimal or impossible routes.

### Visual Example of Trap

```
Start at ● inside padding zone, seeded direction 'W':

     ╔════════════════════════╗  ← Padding boundary
     ║ ✗ ✗ ✗ ✗ ✗ ✗ ✗ ✗ ✗ ✗  ║
     ║ ✗ ┌──────────────┐ ✗  ║
     ║ ✗ │              │ ●→ ║  Seeded direction 'W'
     ║ ✗ │    Shape     │    ║  - Can't go W (blocked)
     ║ ✗ └──────────────┘ ✗  ║  - Can't go E (U-turn blocked)
     ║ ✗ ✗ ✗ ✗↑✗ ✗ ✗ ✗ ✗ ✗  ║  - N/S may also be blocked
     ║       goal            ║
     ╚════════════════════════╝

     Result: FALLBACK to straight line
```

---

## 2. Root Cause Analysis

### 2.1 Direction Seeding Creates Traps

**Current code** (`routing-astar.ts:226-234`):
```typescript
// PHASE 4: DIRECTION SEEDING
const initialArrivalDir = fromOutwardDir;
const startNode: AStarNode = {
  arrivalDir: initialArrivalDir, // SEED THE INITIAL DIRECTION
  ...
};
```

**Combined with U-turn prevention** (`routing-astar.ts:263-266`):
```typescript
// BACKWARDS VISIT PREVENTION - skip U-turns
if (current.arrivalDir && moveDir === oppositeDir(current.arrivalDir)) {
  continue;
}
```

**The trap:**
1. `computeFromOutwardDirOnSnap()` returns 'W' for a "same side" scenario
2. Start node's `arrivalDir` is seeded as 'W'
3. All westward neighbors are blocked (inside padding)
4. Eastward is blocked by U-turn prevention
5. N/S may also be blocked → no valid neighbors → fallback

### 2.2 Both Endpoints Get Full Offset (Unnecessarily)

**Current code** (`routing-zroute.ts:55-62`, `routing-astar.ts:114-121`):
```typescript
function computeJettyPoint(terminal: Terminal, strokeWidth: number): [number, number] {
  const offset = computeApproachOffset(strokeWidth);  // Always full offset
  return [
    terminal.position[0] + vec[0] * offset,
    terminal.position[1] + vec[1] * offset,
  ];
}
```

**The problem:**
- Unsnapped endpoints (free cursor) don't have arrows by default
- Applying full offset creates artificial distance and grid lines where they're not needed
- For unsnapped endpoints, the offset should be 0 (or just corner radius if we want clean turns)

### 2.3 `computeFromOutwardDirOnSnap()` Ignores Offset

**Current logic** (ConnectorTool.ts:79-91):
```typescript
case 'N': // Final approach is vertical (down into shape)
  if (fromPos[1] < y) {
    // SAME SIDE: from is above shape
    return fromPos[0] < shapeCenterX ? 'E' : 'W';
  }
```

**The problem:**
- Uses raw shape bounds `y` for "same side" detection
- Doesn't account for offset (~38-52 units)
- Start at `y - 20` (inside padding) is detected as "same side" when it's actually "trapped in padding"

### 2.4 Grid Structure Creates Blocked Cells That Get Trapped

**Current grid line placement** (`routing-grid.ts:165-184`):
```typescript
// === 1. Endpoint positions ===
xLines.push(from.position[0], to.position[0]);
yLines.push(from.position[1], to.position[1]);

// === 2. Jetty endpoints ===
xLines.push(fromJetty[0], toJetty[0]);

// === 3. Obstacle boundaries with approach offset padding ===
if (to.shapeBounds) {
  // Inner boundaries (shape edge)  ← PROBLEM: creates cells inside blocking zone
  xLines.push(x, x + w);
  yLines.push(y, y + h);

  // Outer boundaries (valid routing corridors)
  xLines.push(x - approachOffset, x + w + approachOffset);
  yLines.push(y - approachOffset, y + h + approachOffset);
}
```

**The problem:**
- Shape edge lines create cells inside the blocked zone
- These get blocked, but then direction seeding may point AT them
- Better: only create lines where routes can actually go

---

## 3. Design Principles

### 3.1 Grid Structure IS the Constraint

**Old approach:** Add lines everywhere → block invalid cells → seed directions → prevent U-turns
**New approach:** Only add lines where routes can go → no blocking needed → no seeding needed

### 3.2 Anchored Endpoints Have Single-Axis Lines

For a **West side snap**:
- The exit direction is FORCED to be West (toward goal = East)
- Grid only needs an **x-line** at `shape.x - approachOffset`
- The y-position is determined by the snap's `t` parameter
- Movement from that position is horizontal only (along x-axis)

| Snap Side | Required Axis | Exit Direction | Grid Line Position |
|-----------|---------------|----------------|-------------------|
| N | y-line only | North (up) | `shape.y - offset` |
| S | y-line only | South (down) | `shape.y + h + offset` |
| E | x-line only | East (right) | `shape.x + w + offset` |
| W | x-line only | West (left) | `shape.x - offset` |

### 3.3 Unsnapped Endpoints Have Both Axes

Free endpoints can approach from any direction, so they need both x-line and y-line.

**But:** If the unsnapped position is inside another shape's padding zone:
- Those intersecting cells get blocked
- A* must escape to padding boundary first

### 3.4 Padding Boundary Lines ARE the Jetty

**Current:** `jetty = position + outwardVector * offset`, then A* routes between jetties
**New:** The padding boundary line IS where the route turns. A* discovers it naturally.

For anchored endpoints, the "jetty point" becomes implicit:
```
Snap position: (shape.x, snap.y)      ← actual snap point on shape edge
Padding line:  x = shape.x - offset   ← first routable x position
Path goes:     [..., (shape.x - offset, route.y), (shape.x, snap.y)]
```

### 3.5 No Direction Seeding, No U-turn Prevention

With correct grid structure:
- Start cell has exactly 2 neighbors (the valid directions)
- Invalid directions don't exist as neighbors
- A* naturally finds the path

---

## 4. Phase 1 Changes

### 4.1 Summary of Changes

| Change | File | Impact |
|--------|------|--------|
| Fix offset awareness | ConnectorTool.ts | `computeFromOutwardDirOnSnap()` uses padded bounds |
| Restructure grid lines | routing-grid.ts | Single-axis for anchored, both for unanchored |
| Remove shape edge lines | routing-grid.ts | No cells inside blocked zone |
| Remove direction seeding | routing-astar.ts | `arrivalDir: null` for start node |
| Remove U-turn prevention | routing-astar.ts | Allow all directions |
| Cap-aware jetty offset | routing-astar.ts, routing-zroute.ts | Only anchored endpoints get offset |
| Update path assembly | routing-astar.ts | No explicit jetty prepend/append |
| Simplify blocking | routing-grid.ts | Block padding zone interior, protect start/goal |

### 4.2 Files Modified

1. **`client/src/lib/tools/ConnectorTool.ts`**
   - Update `computeFromOutwardDirOnSnap()` to use offset-padded bounds

2. **`client/src/lib/connectors/routing-grid.ts`**
   - Restructure `buildNonUniformGrid()` for new line placement
   - Update blocking strategy in `createCellGrid()`

3. **`client/src/lib/connectors/routing-astar.ts`**
   - Remove direction seeding (start with `arrivalDir: null`)
   - Remove U-turn prevention code
   - Update `computeJettyPoint()` for cap-aware offset
   - Update `computeAStarRoute()` path assembly

4. **`client/src/lib/connectors/routing-zroute.ts`**
   - Update `computeJettyPoint()` for cap-aware offset
   - Unsnapped endpoints get no offset (or minimal for corner radius)

5. **`client/src/lib/connectors/constants.ts`**
   - Add `computeJettyOffset(isAnchored, hasCap, strokeWidth)` helper

---

## 5. Implementation Order

The changes have dependencies. This is the correct order:

```
┌─────────────────────────────────────────────────────────────────┐
│ Step 1: Add cap-aware offset helper                             │
│         constants.ts - computeJettyOffset()                     │
│         Pure addition, no breaks                                │
└──────────────────────────────┬──────────────────────────────────┘
                               │
┌──────────────────────────────▼──────────────────────────────────┐
│ Step 2: Fix computeFromOutwardDirOnSnap()                       │
│         ConnectorTool.ts - account for approach offset          │
│         Uses new helper, fixes direction computation            │
└──────────────────────────────┬──────────────────────────────────┘
                               │
┌──────────────────────────────▼──────────────────────────────────┐
│ Step 3: Update jetty computation for cap-awareness              │
│         routing-astar.ts, routing-zroute.ts                     │
│         Unsnapped = 0 or corner-radius only                     │
│         Snapped = full approach offset                          │
└──────────────────────────────┬──────────────────────────────────┘
                               │
┌──────────────────────────────▼──────────────────────────────────┐
│ Step 4: Restructure grid line placement                         │
│         routing-grid.ts - buildNonUniformGrid()                 │
│         Single-axis for anchored, both for unanchored           │
│         Remove shape edge lines                                 │
└──────────────────────────────┬──────────────────────────────────┘
                               │
┌──────────────────────────────▼──────────────────────────────────┐
│ Step 5: Update blocking strategy                                │
│         routing-grid.ts - createCellGrid()                      │
│         Simpler blocking with proper endpoint protection        │
└──────────────────────────────┬──────────────────────────────────┘
                               │
┌──────────────────────────────▼──────────────────────────────────┐
│ Step 6: Remove direction seeding                                │
│         routing-astar.ts - astar() function                     │
│         Start node arrivalDir = null                            │
└──────────────────────────────┬──────────────────────────────────┘
                               │
┌──────────────────────────────▼──────────────────────────────────┐
│ Step 7: Remove U-turn prevention                                │
│         routing-astar.ts - astar() neighbor loop                │
│         Allow all directions (grid structure prevents invalid)  │
└──────────────────────────────┬──────────────────────────────────┘
                               │
┌──────────────────────────────▼──────────────────────────────────┐
│ Step 8: Update path assembly                                    │
│         routing-astar.ts - computeAStarRoute()                  │
│         Path is [from.pos, ...A*cells..., to.pos]               │
│         No explicit jetty prepend/append                        │
└──────────────────────────────┬──────────────────────────────────┘
                               │
┌──────────────────────────────▼──────────────────────────────────┐
│ Step 9: Test and validate                                       │
│         Run through all test scenarios                          │
└─────────────────────────────────────────────────────────────────┘
```

---

## 6. Detailed Implementation Steps

### Step 1: Add Cap-Aware Offset Helper

**File:** `constants.ts`

Add a new function that computes offset based on whether the endpoint is anchored and has a cap:

```typescript
/**
 * Compute jetty offset based on endpoint characteristics.
 *
 * Anchored endpoints with arrow caps need full offset (arc + straight + arrow).
 * Unsnapped endpoints need no offset (they're free-floating).
 *
 * @param isAnchored - Is endpoint snapped to a shape?
 * @param hasCap - Does this endpoint have an arrow cap?
 * @param strokeWidth - Connector stroke width
 * @returns Offset in world units
 */
export function computeJettyOffset(
  isAnchored: boolean,
  hasCap: boolean,
  strokeWidth: number
): number {
  if (!isAnchored) {
    // Free endpoints don't need offset
    // Could add corner radius here if we want clean turns at unsnapped ends
    return 0;
  }

  if (!hasCap) {
    // Anchored but no arrow - just need corner radius clearance
    return ROUTING_CONFIG.CORNER_RADIUS_W;
  }

  // Full offset for anchored endpoints with arrow caps
  return computeApproachOffset(strokeWidth);
}
```

### Step 2: Fix `computeFromOutwardDirOnSnap()`

**File:** `ConnectorTool.ts`

The function needs to know about the approach offset to correctly detect "same side" vs "inside padding zone":

```typescript
import { computeApproachOffset } from '@/lib/connectors/constants';

/**
 * Compute optimal from.outwardDir when to is snapped to a shape.
 *
 * CRITICAL: Uses offset-padded bounds for position checks.
 * The "approach zone" extends approachOffset beyond the shape.
 *
 * Scenarios:
 * 1. OUTSIDE PADDING - normal routing
 * 2. INSIDE PADDING, SAME SIDE - U-turn route
 * 3. INSIDE PADDING, ADJACENT SIDE - L-turn shortcut
 * 4. INSIDE PADDING, OPPOSITE SIDE - route around
 */
function computeFromOutwardDirOnSnap(
  fromPos: [number, number],
  toSide: Dir,
  shapeBounds: { x: number; y: number; w: number; h: number },
  strokeWidth: number
): Dir {
  const { x, y, w, h } = shapeBounds;
  const offset = computeApproachOffset(strokeWidth);

  // Padded bounds for position checks
  const paddedMinX = x - offset;
  const paddedMaxX = x + w + offset;
  const paddedMinY = y - offset;
  const paddedMaxY = y + h + offset;

  const shapeCenterX = x + w / 2;
  const shapeCenterY = y + h / 2;

  // Is start inside the padding zone?
  const insidePaddingX = fromPos[0] > paddedMinX && fromPos[0] < paddedMaxX;
  const insidePaddingY = fromPos[1] > paddedMinY && fromPos[1] < paddedMaxY;
  const insidePadding = insidePaddingX && insidePaddingY;

  // Determine which side of shape the start is on (relative to padded bounds)
  const isAbovePadding = fromPos[1] < paddedMinY;
  const isBelowPadding = fromPos[1] > paddedMaxY;
  const isLeftOfPadding = fromPos[0] < paddedMinX;
  const isRightOfPadding = fromPos[0] > paddedMaxX;

  switch (toSide) {
    case 'N': // Final approach is vertical (down into shape from north)
      if (isAbovePadding) {
        // CLEARLY ABOVE - standard approach, go horizontal to align
        return fromPos[0] < shapeCenterX ? 'E' : 'W';
      }
      if (insidePadding) {
        // INSIDE PADDING ZONE
        if (fromPos[1] < y) {
          // Same side (N side padding) - need U-turn
          // Go horizontal first to clear padding width, then down, then back
          return fromPos[0] < shapeCenterX ? 'W' : 'E';
        } else {
          // Different side (inside S/E/W padding) - route around
          return fromPos[0] < shapeCenterX ? 'W' : 'E';
        }
      }
      // BESIDE (left or right of padded bounds)
      return 'N';

    case 'S': // Final approach is vertical (up into shape from south)
      if (isBelowPadding) {
        return fromPos[0] < shapeCenterX ? 'E' : 'W';
      }
      if (insidePadding) {
        if (fromPos[1] > y + h) {
          // Same side (S side padding) - U-turn
          return fromPos[0] < shapeCenterX ? 'W' : 'E';
        } else {
          return fromPos[0] < shapeCenterX ? 'W' : 'E';
        }
      }
      return 'S';

    case 'E': // Final approach is horizontal (left into shape from east)
      if (isRightOfPadding) {
        return fromPos[1] < shapeCenterY ? 'S' : 'N';
      }
      if (insidePadding) {
        if (fromPos[0] > x + w) {
          // Same side (E side padding) - U-turn
          return fromPos[1] < shapeCenterY ? 'N' : 'S';
        } else {
          return fromPos[1] < shapeCenterY ? 'N' : 'S';
        }
      }
      return 'E';

    case 'W': // Final approach is horizontal (right into shape from west)
      if (isLeftOfPadding) {
        return fromPos[1] < shapeCenterY ? 'S' : 'N';
      }
      if (insidePadding) {
        if (fromPos[0] < x) {
          // Same side (W side padding) - U-turn
          return fromPos[1] < shapeCenterY ? 'N' : 'S';
        } else {
          return fromPos[1] < shapeCenterY ? 'N' : 'S';
        }
      }
      return 'W';
  }
}
```

**Note:** This function will become less critical after direction seeding is removed, but fixing it first ensures the heuristic is correct for any remaining uses.

### Step 3: Update Jetty Computation

**File:** `routing-astar.ts`

Update `computeJettyPoint` to be cap-aware:

```typescript
import { computeJettyOffset } from './constants';

/**
 * Compute jetty point based on terminal characteristics.
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
```

**File:** `routing-zroute.ts`

Same update for Z-route jetty computation.

### Step 4: Restructure Grid Line Placement

**File:** `routing-grid.ts`

Completely rewrite `buildNonUniformGrid()`:

```typescript
/**
 * Build non-uniform grid for A* routing.
 *
 * GRID LINE PHILOSOPHY:
 * - Lines exist only at positions where routing is valid
 * - Anchored endpoints: single-axis line (perpendicular to snap side)
 * - Unsnapped endpoints: both x and y lines
 * - Shape obstacle: only padding boundary lines (no edge lines)
 * - Midpoints for routing flexibility
 */
export function buildNonUniformGrid(
  from: Terminal,
  to: Terminal,
  fromJetty: [number, number],
  toJetty: [number, number],
  strokeWidth: number
): Grid {
  const xLines: number[] = [];
  const yLines: number[] = [];

  const approachOffset = computeApproachOffset(strokeWidth);

  // === 1. FROM endpoint ===
  if (from.kind === 'shape') {
    // Anchored FROM: single-axis line at jetty position
    // The axis is PERPENDICULAR to the snap side
    if (from.outwardDir === 'N' || from.outwardDir === 'S') {
      // Vertical exit → y-line at jetty
      yLines.push(fromJetty[1]);
      xLines.push(from.position[0]); // Keep x for path assembly
    } else {
      // Horizontal exit → x-line at jetty
      xLines.push(fromJetty[0]);
      yLines.push(from.position[1]); // Keep y for path assembly
    }
  } else {
    // Unsnapped FROM: both axes at position
    xLines.push(from.position[0]);
    yLines.push(from.position[1]);
  }

  // === 2. TO endpoint ===
  if (to.kind === 'shape') {
    // Anchored TO: single-axis line at jetty position
    if (to.outwardDir === 'N' || to.outwardDir === 'S') {
      yLines.push(toJetty[1]);
      xLines.push(to.position[0]);
    } else {
      xLines.push(toJetty[0]);
      yLines.push(to.position[1]);
    }
  } else {
    // Unsnapped TO: both axes
    xLines.push(to.position[0]);
    yLines.push(to.position[1]);
  }

  // === 3. Obstacle padding boundaries (NOT shape edges) ===
  if (to.shapeBounds) {
    const { x, y, w, h } = to.shapeBounds;

    // Only add padding boundary lines (valid routing corridors)
    // DO NOT add shape edge lines - those create blocked cells
    xLines.push(x - approachOffset, x + w + approachOffset);
    yLines.push(y - approachOffset, y + h + approachOffset);
  }

  if (from.shapeBounds && from.shapeBounds !== to.shapeBounds) {
    const { x, y, w, h } = from.shapeBounds;
    xLines.push(x - approachOffset, x + w + approachOffset);
    yLines.push(y - approachOffset, y + h + approachOffset);
  }

  // === 4. Midpoints for routing flexibility ===
  // These allow Z-routes that don't align with endpoints
  const midX = (fromJetty[0] + toJetty[0]) / 2;
  const midY = (fromJetty[1] + toJetty[1]) / 2;
  xLines.push(midX);
  yLines.push(midY);

  // === 5. Dedupe and sort ===
  const xSorted = [...new Set(xLines)].sort((a, b) => a - b);
  const ySorted = [...new Set(yLines)].sort((a, b) => a - b);

  // === 6. Build cell grid ===
  return createCellGrid(
    xSorted,
    ySorted,
    to.shapeBounds ?? null,
    from.position,  // Start position (never blocked)
    to.position,    // Goal position (never blocked)
    strokeWidth
  );
}
```

### Step 5: Update Blocking Strategy

**File:** `routing-grid.ts`

Simplify blocking - we only need to block the interior of the padding zone:

```typescript
/**
 * Create cell grid with blocking.
 *
 * Blocking strategy:
 * - Block cells strictly INSIDE the padded obstacle bounds
 * - NEVER block start or goal positions
 * - Padding boundary cells are NOT blocked (they're the valid corridor)
 */
function createCellGrid(
  xLines: number[],
  yLines: number[],
  obstacle: AABB | null,
  startPos: [number, number],
  goalPos: [number, number],
  strokeWidth: number
): Grid {
  const cells: GridCell[][] = [];
  const approachOffset = computeApproachOffset(strokeWidth);

  // Compute padded obstacle bounds for blocking
  const blockedBounds: AABB | null = obstacle
    ? {
        x: obstacle.x - approachOffset,
        y: obstacle.y - approachOffset,
        w: obstacle.w + approachOffset * 2,
        h: obstacle.h + approachOffset * 2,
      }
    : null;

  for (let yi = 0; yi < yLines.length; yi++) {
    cells[yi] = [];
    for (let xi = 0; xi < xLines.length; xi++) {
      const cellX = xLines[xi];
      const cellY = yLines[yi];

      // Cell is blocked if strictly INSIDE the padded bounds
      // (NOT on boundary - boundary is valid routing corridor)
      let blocked = blockedBounds
        ? pointStrictlyInsideRect(cellX, cellY, blockedBounds)
        : false;

      // NEVER block start or goal positions
      if (blocked) {
        const isStart = Math.abs(cellX - startPos[0]) < 0.001 &&
                        Math.abs(cellY - startPos[1]) < 0.001;
        const isGoal = Math.abs(cellX - goalPos[0]) < 0.001 &&
                       Math.abs(cellY - goalPos[1]) < 0.001;
        if (isStart || isGoal) {
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
 * Check if point is strictly inside rect (not on boundary).
 */
function pointStrictlyInsideRect(x: number, y: number, rect: AABB): boolean {
  return x > rect.x && x < rect.x + rect.w &&
         y > rect.y && y < rect.y + rect.h;
}
```

### Step 6: Remove Direction Seeding

**File:** `routing-astar.ts`

In the `astar()` function, remove direction seeding:

```typescript
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
    arrivalDir: null,  // ← CHANGED: was fromOutwardDir
  };

  // ... rest of function
}
```

### Step 7: Remove U-turn Prevention

**File:** `routing-astar.ts`

In the neighbor exploration loop, remove U-turn prevention:

```typescript
// Explore 4-connected neighbors
for (const neighbor of getNeighbors(grid, current.cell)) {
  // Skip blocked cells
  if (neighbor.blocked) continue;

  const neighborKey = cellKey(neighbor);
  if (closedSet.has(neighborKey)) continue;

  // Compute move direction
  const moveDir = getDirection(current.cell, neighbor);

  // REMOVED: Backwards visit prevention
  // Grid structure now prevents invalid paths by construction
  // if (current.arrivalDir && moveDir === oppositeDir(current.arrivalDir)) {
  //   continue;
  // }

  // Compute cost (bend penalty still applies)
  const moveCost = computeMoveCost(current.cell, neighbor, current.arrivalDir, moveDir);
  // ... rest of loop
}
```

### Step 8: Update Path Assembly

**File:** `routing-astar.ts`

Update `computeAStarRoute()` to not explicitly add jetty points:

```typescript
export function computeAStarRoute(
  from: Terminal,
  to: Terminal,
  strokeWidth: number
): RouteResult {
  // Determine if endpoints have caps (affects offset)
  // For now, assume: from has startCap, to has endCap
  // In future, this should come from connector settings
  const fromHasCap = false;  // TODO: pass from caller
  const toHasCap = true;     // endCap = 'arrow' by default

  // Compute jetty positions (used for grid construction)
  const fromJetty = computeJettyPoint(from, strokeWidth, fromHasCap);
  const toJetty = computeJettyPoint(to, strokeWidth, toHasCap);

  // Build grid
  const grid = buildNonUniformGrid(from, to, fromJetty, toJetty, strokeWidth);

  // Find start and goal cells
  // For anchored endpoints, start/goal is at JETTY position (in routing space)
  // For unsnapped endpoints, start/goal is at ACTUAL position
  const startCell = from.kind === 'shape'
    ? findNearestCell(grid, fromJetty)
    : findNearestCell(grid, from.position);

  const goalCell = to.kind === 'shape'
    ? findNearestCell(grid, toJetty)
    : findNearestCell(grid, to.position);

  // Run A* (no direction seeding)
  const path = astar(grid, startCell, goalCell);

  // Assemble full path
  // For anchored endpoints, A* path goes to jetty; we add actual endpoint
  // For unsnapped, A* path already includes actual position
  const fullPath: [number, number][] = [];

  // Add start
  fullPath.push(from.position);

  // Add A* path (may include jetty as first/last point)
  for (const cell of path) {
    fullPath.push([cell.x, cell.y]);
  }

  // Add end
  fullPath.push(to.position);

  // Simplify collinear points
  const simplified = simplifyOrthogonal(fullPath);

  return {
    points: simplified,
    signature: computeSignature(simplified),
  };
}
```

---

## 7. Testing Scenarios

### 7.1 Basic Scenarios (Must Work)

| Scenario | Expected Behavior |
|----------|-------------------|
| Free cursor drag (no snap) | Clean Z-route (HVH or VHV) |
| Snap to distant shape | Clean L or Z route around padding |
| Head-on approach | Straight line with minimal bends |
| Perpendicular approach | Single corner at shape padding boundary |

### 7.2 Same-Side Approach (Previously Broken)

| Scenario | Expected Behavior |
|----------|-------------------|
| Start above shape, snap to N side | U-turn: down → out → around → up → in |
| Start inside N-side padding, snap to N | U-turn escaping to padding boundary first |
| Start on exact same horizontal line as snap | Clean L-route (horizontal then vertical) |

### 7.3 Inside Padding Zone (Previously Trapped)

| Scenario | Expected Behavior |
|----------|-------------------|
| Start inside E-side padding, snap to E | Escape west to padding boundary, route around |
| Start inside E-side padding, snap to N | Can shortcut (adjacent side) - L-route |
| Start inside padding, snap to opposite side | Route around the long way |

### 7.4 Edge Cases

| Scenario | Expected Behavior |
|----------|-------------------|
| Start very close to shape edge | Still routes correctly (no fallback) |
| Start exactly on padding boundary | Valid route (not blocked) |
| Shape-to-shape (same shape) | Special handling (future - may defer) |

---

## 8. Deferred to Phase 2

These enhancements depend on Phase 1 working correctly:

### 8.1 Graceful Fallback for Tight Corners

When start and end are very close along the anchor axis:
- Detect if there's not enough room for full corner radius + arrow
- Reduce corner radius dynamically
- Reduce arrow size as last resort
- Blank connector if still not enough room

### 8.2 Z-Route vs L-Route Preference

Use `inferDragDirection()` to prefer Z-routes when:
- Drag direction matches the axis of the first Z-route segment
- Head-on approach where Z feels more natural

### 8.3 Smaller Corner Radius in Tight U-turns

Detect rapid 180° turns (up-right-down pattern) and:
- Use smaller corner radius
- Optionally hide if too cramped

### 8.4 Adjacent Side Reduced Padding

When routing from one side's padding to an adjacent side:
- Only need padding on the TARGET side
- Can allow the route to be closer on the exit side

### 8.5 Multiple Obstacles

Currently only target shape is an obstacle. Future:
- All shapes in path should be obstacles
- Grid includes all padding boundaries
- Blocking for all padding zones

---

## Appendix A: Quick Reference

### Offset Values (strokeWidth 2-6)

| strokeWidth | cornerRadius | minStraight | arrowLength | approachOffset |
|-------------|--------------|-------------|-------------|----------------|
| 2 | 22 | 6 | 10 | 38 |
| 3 | 22 | 6 | 12 | 40 |
| 4 | 22 | 6 | 16 | 44 |
| 5 | 22 | 6 | 20 | 48 |
| 6 | 22 | 6 | 24 | 52 |

### Direction Quick Reference

| Snap Side | Outward Vector | Final Segment Direction |
|-----------|----------------|------------------------|
| N | (0, -1) | South (into shape) |
| S | (0, +1) | North (into shape) |
| E | (+1, 0) | West (into shape) |
| W | (-1, 0) | East (into shape) |

---

*End of Phase 1 Plan*
