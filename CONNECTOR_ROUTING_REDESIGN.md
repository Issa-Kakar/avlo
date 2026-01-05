# ORTHOGONAL CONNECTOR ROUTING SUMMARY

## Document Purpose
Condensed reference for the connector tool routing system. Captures current state and provides creative suggestions for centerline-preferred routing behavior.

---

# CENTERLINE PREFERENCE: REFINED ALGORITHM

## The Core Insight

**Precise Rule:** For any segment that runs along a **SHAPE PADDING LINE ITSELF** (the actual padded AABB boundary), if:
1. That padding line is a **FACING side** (interior side looking at the other shape)
2. A **CENTERLINE** exists parallel to it with minimum space

→ **Use centerline instead of the shape padding line.**

**Key Distinction:**
- We're not checking arbitrary parallel segments - we're checking if the path uses the **actual shape padding AABB lines**
- Each shape has 4 padding lines: 2 X-lines (left_pad, right_pad), 2 Y-lines (top_pad, bottom_pad)
- **Facing sides** = the interior sides that look at each other
- **Exterior sides** = the outer sides used for wrapping around (neutral cost, hugging is fine)

**The Two Choices:**
When routing parallel to a facing side, there are only two options:
1. Use the shape's padded AABB line (hugging)
2. Use the centerline (preferred when available)

**Cost Strategy:**
- **Centerline:** BONUS (cheaper than neutral)
- **Facing side padding lines:** PENALTY (more expensive than neutral)
- **Exterior/non-facing padding lines:** NEUTRAL (hugging is acceptable here)

## Detection Algorithm

### Step 1: Identify Potential Facing Sides

For two shapes A (start) and B (end):
- If path would traverse a **vertical segment** parallel to A's E/W sides → those are facing candidates
- If path would traverse a **horizontal segment** parallel to B's N/S sides → those are facing candidates

### Step 2: Check Centerline Viability

For each axis where parallel traversal detected:
- X-centerline = (A.right_pad + B.left_pad) / 2 (for horizontal corridor)
- Y-centerline = (A.bottom_pad + B.top_pad) / 2 (for vertical corridor)
- Centerline viable if: gap >= MIN_CENTERLINE_SPACE

### Step 3: Route Decision

```
IF segment runs parallel to facing side
AND centerline exists on that axis
THEN use centerline instead of facing side padding
```

---

## Worked Examples

### Example 1: Exit EAST, Enter WEST (Opposing Horizontal)

```
[Start]=→    ←=[End]
        E    W
```

**Path structure:** H → V → H
- Exit EAST (horizontal stub)
- Vertical segment (parallel to start's E OR end's W)
- Enter WEST (horizontal stub)

**Facing sides:** Start's EAST, End's WEST (both vertical)
**Vertical segment is parallel to facing sides** → Use X-centerline

```
HUGGING:                    CENTERLINE:
[Start]=→↓                  [Start]=→→→→↓
         ↓                              ↓
         ↓←←←←←←=[End]                  ↓←←←←=[End]

Down at start.right_pad     Down at midline_x
```

### Example 2: Exit EAST, Enter NORTH (Perpendicular, Wrong Quadrant)

```
    [End]
      ↑N

[Start]→E
```

Start is BELOW end. Cannot do direct L.

**Path structure:** H → V → H → V
- Exit EAST (stub)
- Go UP (vertical)
- Go LEFT (horizontal) ← **This is parallel to End's NORTH!**
- Go DOWN into NORTH (stub)

**Facing side:** End's NORTH (horizontal line)
**Horizontal segment parallel to NORTH** → Use Y-centerline

```
HUGGING:                         CENTERLINE:
[Start]→→→→↑                     [Start]→→→→↑
           ↑                              ↑
    [End]←←←                      ←←←←←←←←
      ↑N   ↓                      ↓
           ↓                      ↓
                              [End]
                                ↑N
                                ↓

LEFT along end.north_pad        LEFT along midline_y
```

### Example 3: Direct L (Perpendicular, Agreeing Quadrant)

```
[Start]→E
        ↓
      [End]
        ↑N
```

**Path structure:** H → V (bend at intersection)
- No segment parallel to any facing side
- Direct L uses intersection point

**No centerline needed** - the bend happens at the natural intersection.

### Example 4: Same Direction - POSITION/ALIGNMENT CRITICAL

#### Case 4a: Y-aligned, X-offset (start left of end)

```
←[Start]     [End]←
  W            W
```

**Facing sides:** Start's EAST, End's WEST (both vertical, interior)
**Path:** W stub → V down → H right → V up → W stub

**Key observation:** The vertical segments (V down, V up) are on **EXTERIOR** sides:
- Start's WEST (not facing - it's the exit direction side)
- End's WEST (not facing - it's the entry direction side)

**No parallel facing side segments used!** The E/W facing sides are never traversed parallel.
This is a **U-shape** where centerline X doesn't help (we go around, not through).

#### Case 4b: Diagonal offset (partial Y overlap)

```
←[Start]
  W   ↖
        ↖
          [End]←
            W
```

Start is top-left, end is bottom-right. Shapes have partial Y overlap.

**Two sub-cases based on Y overlap amount:**

**Sub-case: Small Y overlap (gap between N/S facing sides)**
```
Path: W → UP → RIGHT → UP → W(stub)
                 ↑
         This horizontal segment parallels N/S facing sides!
```
- Start's SOUTH and End's NORTH are now facing sides (horizontal)
- The rightward horizontal segment runs parallel to these
- **Centerline Y should be used** instead of hugging one shape's N/S padding

**Sub-case: Large Y overlap (shapes close vertically)**
```
Path: W → DOWN → RIGHT → UP → W(stub)
```
- Must go DOWN first to clear start, then wrap around
- The horizontal segment is now in different territory
- Facing sides detection changes based on actual path geometry

#### Case 4c: Vertically stacked, horizontally aligned

```
  [End]←
    W

←[Start]
  W
```

Start is below end, X-aligned.

**Facing sides:** Start's NORTH, End's SOUTH (horizontal lines)

**Path options:**
1. **U-shape around exterior:** W → DOWN → L/R → UP → UP → W
   - Uses Start's WEST (exterior, neutral) for the DOWN segment
   - This is acceptable when no centerline Y exists in the corridor

2. **Snake through corridor with centerline:** W → UP → L/R → UP → W
   - If there's a gap between shapes (corridor exists)
   - The horizontal segment should use centerline Y, not hug N/S padding

**Why position matters:**
- If shapes are X-aligned and have a vertical corridor → centerline Y preferred for horizontal segments
- If shapes have no corridor (too close) → must use U-shape around exterior

#### The Exterior Parallel Segments Question

**Concern:** What about exterior padding lines that are also parallel to the travel direction?

**Answer:** For **non-facing exterior sides**, use **NEUTRAL cost** (hugging is acceptable).

**Why this works:**
1. Manhattan routing naturally gravitates toward the goal
2. If centerline exists and has a BONUS, A* will prefer it over neutral exterior hugging
3. If centerline doesn't exist (shapes overlapping), exterior hugging is the only option anyway

**The rule simplification:**
- **BONUS** for centerline (when it exists and is parallel to facing sides)
- **PENALTY** for facing side padding lines (the interior sides)
- **NEUTRAL** for everything else (exterior sides, stubs, perpendicular segments)

This means we don't need to explicitly track exterior parallel segments - the cost structure naturally handles it:
- Centerline beats neutral (A* will prefer centerline when available)
- Neutral beats penalty (A* avoids facing side hugging when centerline is available)

---

## Implementation Strategy

### Option A: Post-Path Analysis (Evaluate & Penalize)

After A* finds initial path, analyze each segment:

```typescript
function evaluatePath(path: Point[], startShape: AABB, endShape: AABB): number {
  let penalty = 0;

  for (let i = 0; i < path.length - 1; i++) {
    const segment = { from: path[i], to: path[i + 1] };
    const isVertical = segment.from.x === segment.to.x;
    const isHorizontal = segment.from.y === segment.to.y;

    // Check if segment parallels a facing side
    if (isVertical) {
      const facingX = [startShape.right + PAD, endShape.left - PAD];
      if (facingX.includes(segment.from.x)) {
        // Check if X-centerline exists
        const centerlineX = (facingX[0] + facingX[1]) / 2;
        if (centerlineX exists && segment.from.x !== centerlineX) {
          penalty += CENTERLINE_MISS_PENALTY;
        }
      }
    }
    // Similar for horizontal segments
  }

  return penalty;
}
```

### Option B: Pre-Route Grid Modification (Block Facing Lines)

Before running A*, modify grid to exclude facing side lines:

```typescript
function buildCenterlinePreferredGrid(from, to, corridor): Grid {
  const xLines = [];
  const yLines = [];

  // Always add: start/goal positions, exterior padding, centerline
  xLines.push(from.position[0], to.position[0]);
  xLines.push(startShape.left - PAD, endShape.right + PAD); // exterior
  xLines.push(corridor.centerlineX); // the preferred route

  // DON'T add facing side lines: start.right + PAD, end.left - PAD
  // This forces A* to use centerline for vertical segments in corridor

  // BUT: need connection from start to centerline
  // Start cell exists at start.x, and centerline exists
  // A* will naturally go horizontal to reach centerline

  return buildGrid(xLines, yLines, ...);
}
```

### Option C: Neighbor Filtering (Dynamic Valid Neighbors)

During A* expansion, filter neighbors based on centerline preference:

```typescript
function getValidNeighbors(cell: GridCell, corridor: Corridor): GridCell[] {
  const all = getNeighbors(grid, cell);

  return all.filter(neighbor => {
    const moveDir = getDirection(cell, neighbor);

    // If moving vertically in corridor, only allow if on centerline
    if (corridor.axis === 'x' && (moveDir === 'N' || moveDir === 'S')) {
      const isOnCenterline = Math.abs(cell.x - corridor.centerlineX) < EPSILON;
      const isOnFacingSide = facingSideXs.includes(cell.x);

      if (isOnFacingSide && !isOnCenterline && corridor.centerlineExists) {
        return false; // Block this vertical move on facing side
      }
    }

    return true;
  });
}
```

### Option D: Three-Tier Cost Model (RECOMMENDED)

Apply BONUS/PENALTY/NEUTRAL based on edge classification:

```typescript
const CENTERLINE_BONUS = -500;      // Cheaper than neutral
const FACING_PENALTY = 1000;        // More expensive than neutral
const EXTERIOR_NEUTRAL = 0;         // Normal cost

function computeMoveCost(from, to, arrivalDir, moveDir, corridor): number {
  let cost = baseCost(from, to, arrivalDir, moveDir);

  // Determine edge classification
  const edgeX = from.x; // or to.x for vertical edges
  const edgeY = from.y; // or to.y for horizontal edges

  if (corridor.exists) {
    if (corridor.axis === 'x' && (moveDir === 'N' || moveDir === 'S')) {
      // Vertical movement - check X position
      if (Math.abs(edgeX - corridor.centerline) < EPSILON) {
        cost += CENTERLINE_BONUS;  // Prefer this!
      } else if (edgeX === corridor.facingSideStart || edgeX === corridor.facingSideEnd) {
        cost += FACING_PENALTY;    // Avoid this
      }
      // Exterior sides get no modification (neutral)
    }
    // Similar for horizontal movement with Y-axis corridors
  }

  return cost;
}
```

**Why this works:**
- Centerline is cheaper than neutral → A* naturally prefers centerline
- Facing sides are more expensive → A* avoids them when centerline exists
- Exterior sides are neutral → A* uses them when necessary (wrapping)
- If centerline doesn't exist, facing sides become the fallback (still reachable)

---

## Recommended Implementation: Three-Tier Cost Model

1. **Detect Corridor** during grid construction (before A*)
2. **Add all lines** (including facing sides) for fallback routing
3. **Apply cost modifiers** in A* based on edge classification:
   - CENTERLINE: **BONUS** (-500) - actively preferred
   - FACING: **PENALTY** (+1000) - actively avoided
   - EXTERIOR: **NEUTRAL** (0) - acceptable fallback

```typescript
interface Corridor {
  exists: boolean;
  axis: 'x' | 'y';              // 'x' = vertical centerline, 'y' = horizontal centerline
  facingSideStart: number;      // e.g., startShape.right + PAD
  facingSideEnd: number;        // e.g., endShape.left - PAD
  centerline: number;           // (facingSideStart + facingSideEnd) / 2
  hasMinSpace: boolean;         // gap >= MIN_CENTERLINE_SPACE
}

// Cost modifiers (added to base cost)
const CENTERLINE_BONUS = -500;  // Cheaper than neutral
const FACING_PENALTY = 1000;    // More expensive than neutral
// Exterior/neutral = 0 (no modification)
```

**Key insight:** By using additive modifiers instead of multipliers:
- Centerline is always preferred when available (bonus makes it cheaper)
- Facing sides are avoided but still reachable (penalty is finite)
- Exterior sides are neutral (natural fallback for wrapping)
- Manhattan routing toward goal is preserved

---

## Key Invariants

1. **Facing sides are INTERIOR sides** - the sides of shapes that look at each other (not the exit/entry sides)
2. **Exterior sides are NEUTRAL** - hugging is acceptable, no penalty applied
3. **Stubs are non-negotiable** - the initial/final segments are fixed by anchor direction
4. **Centerline only applies when corridor exists** - if shapes overlap on that axis, no centerline available
5. **Position/alignment determines facing sides** - which sides are "facing" depends on actual shape positions
6. **The check is per-edge** - during A* expansion, check if the current X/Y position is a facing line, centerline, or exterior
7. **Three-tier costs preserve fallback** - BONUS/PENALTY/NEUTRAL ensures paths always exist even when centerline is blocked

---

## Pseudo-Code: Complete Flow

```typescript
function computeAStarRouteWithCenterline(from, to, strokeWidth): RouteResult {
  // 1. Compute approach points
  const fromApproach = computeApproachPoint(from, strokeWidth);
  const toApproach = computeApproachPoint(to, strokeWidth);

  // 2. Detect corridor between shapes
  const corridor = detectCorridor(from, to, strokeWidth);

  // 3. Build grid with all lines (including facing sides for fallback)
  const grid = buildNonUniformGrid(from, to, fromApproach, toApproach, strokeWidth);

  // 4. Label edges with roles
  labelEdges(grid, corridor);

  // 5. Run A* with corridor-aware costs
  const path = astarWithCorridorPreference(grid, startCell, goalCell, corridor);

  // 6. Assemble and simplify
  return assembleRoute(from.position, path, to.position);
}

function detectCorridor(from, to, strokeWidth): Corridor {
  const pad = computeApproachOffset(strokeWidth);

  // Horizontal corridor (shapes side by side on X axis)
  if (to.shapeBounds && from.shapeBounds) {
    const facingStart = from.shapeBounds.right + pad;
    const facingEnd = to.shapeBounds.left - pad;
    const gap = facingEnd - facingStart;

    if (gap > MIN_CENTERLINE_GAP) {
      return {
        exists: true,
        axis: 'x',
        facingSideStart: facingStart,
        facingSideEnd: facingEnd,
        centerline: (facingStart + facingEnd) / 2,
        hasMinSpace: true,
      };
    }
  }

  // Similar for vertical corridor

  return { exists: false };
}

function labelEdges(grid, corridor) {
  for (each edge in grid) {
    if (corridor.exists && corridor.axis === 'x') {
      if (edge.isVertical()) {
        if (Math.abs(edge.x - corridor.centerline) < EPSILON) {
          edge.role = 'CENTERLINE';
          edge.costMultiplier = 0.5;
        } else if (edge.x === corridor.facingSideStart || edge.x === corridor.facingSideEnd) {
          edge.role = 'FACING';
          edge.costMultiplier = 3.0; // or 5.0, or block entirely
        }
      }
    }
  }
}
```

---

---

## FILE MAP

| File | Lines | Responsibility |
|------|-------|----------------|
| `client/src/lib/tools/ConnectorTool.ts` | 432 | Tool state machine, gesture lifecycle, Y.Doc commit |
| `client/src/lib/connectors/routing.ts` | 54 | Dispatcher: Z-route vs A* |
| `client/src/lib/connectors/routing-zroute.ts` | 201 | Simple HVH/VHV for free endpoints |
| `client/src/lib/connectors/routing-astar.ts` | 577 | A* Manhattan with bend penalties |
| `client/src/lib/connectors/routing-grid.ts` | 341 | Non-uniform grid construction |
| `client/src/lib/connectors/snap.ts` | 398 | Shape edge snapping with hysteresis |
| `client/src/lib/connectors/constants.ts` | 222 | Offsets, costs, config |
| `client/src/lib/connectors/shape-utils.ts` | 125 | Dir, frames, vectors |
| `client/src/renderer/layers/connector-preview.ts` | 363 | Rounded polyline + arrow rendering |

---

## CORE DATA STRUCTURES

### Terminal (The Canonical Endpoint)
```typescript
interface Terminal {
  position: [number, number];
  outwardDir: Dir;           // N|E|S|W - direction jetty extends
  isAnchored: boolean;       // true = snapped to shape
  hasCap: boolean;           // true = arrow cap
  shapeBounds?: AABB;        // for obstacle blocking
  t?: number;                // edge position 0-1
}
```

### Grid Structure
```typescript
interface Grid {
  cells: GridCell[][];       // [yi][xi]
  xLines: number[];          // sorted unique X coords
  yLines: number[];          // sorted unique Y coords
}

interface GridCell {
  x, y: number;              // world coords
  xi, yi: number;            // grid indices
  blocked: boolean;          // inside obstacle padding
}
```

### Cost Configuration
```typescript
BEND_PENALTY: 1000           // heavy penalty for direction change
CONTINUATION_BONUS: 10       // small bonus for straight continuation
FIRST_DIR_BONUS: 500         // bonus for preferred initial direction
```

---

## ROUTING DISPATCH LOGIC

```
computeRoute(from, to, strokeWidth)
  │
  ├─ to.isAnchored === false → computeZRoute()
  │     Simple 3-segment HVH or VHV based on from.outwardDir
  │
  └─ to.isAnchored === true  → computeAStarRoute()
        A* with obstacle avoidance
```

**Current Implementation Status:**
- ✅ Free start → Free end: Z-route
- ✅ Free start → Anchored end: A* with single obstacle
- ⏳ Anchored start → Free end: Z-route (needs direction enforcement)
- ⏳ Anchored start → Anchored end: A* with TWO obstacles (not implemented)

---

## A* ROUTING PIPELINE

### 1. Approach Points
```typescript
fromApproach = position + outwardDir * jettyOffset
toApproach   = position + outwardDir * jettyOffset

jettyOffset = {
  unanchored:        0
  anchored no-cap:   CORNER_RADIUS (20)
  anchored + arrow:  CORNER_RADIUS + MIN_STRAIGHT + arrowLength (~36-50)
}
```

### 2. Grid Construction (routing-grid.ts)
Lines placed at:
- FROM endpoint (single axis if anchored, both if free)
- TO goal position (padding boundary intersection)
- Obstacle padding boundaries (4 lines)
- **Midpoint** between approach points

**Key Philosophy:** Lines only exist where routing is valid. Prevents A* from exploring blocked cells.

### 3. Dynamic Blocking
Two modes based on `startInsidePadding`:
- **Inside padding zone:** Block shape + strokeInflation (smaller) → creates escape corridor
- **Outside padding zone:** Block shape + approachOffset (larger) → normal behavior

### 4. Direction Seeding (Three Cases)
When starting inside padded region:
```
SAME SIDE:     Start in N padding → Snap to N → escape N (away from shape)
OPPOSITE SIDE: Start in S padding → Snap to N → go E/W (wrap around)
ADJACENT SIDE: Start in S padding → Snap to W → go W (direct toward target)
```

### 5. A* Cost Function
```typescript
cost = manhattan_distance
     + (direction_changed ? BEND_PENALTY : 0)
     - (same_direction ? CONTINUATION_BONUS : 0)
     - (first_move === preferredDir ? FIRST_DIR_BONUS : 0)
```

### 6. Path Assembly
```
fullPath = [from.position, ...A*_path, to.position]
simplified = removeCollinearPoints(fullPath)
```

---

## THE CENTERLINE PROBLEM

### Current Behavior
The midpoint X and Y are added to the grid (routing-grid.ts:253-256):
```typescript
const midX = (fromApproach[0] + toApproach[0]) / 2;
const midY = (fromApproach[1] + toApproach[1]) / 2;
xLines.push(midX);
yLines.push(midY);
```

**Problem:** A* has no preference for these centerlines. It routes via shortest path with fewest bends, which often means hugging obstacle padding instead of using the symmetric centerline.

### Why Centerline Matters
```
HUGGING PATH (current):           CENTERLINE PATH (desired):

[Start]→↓                         [Start]→→→→↓
        ↓                                    ↓
        →→→→→→→↓                             →→→→↓
               ↓                                 ↓
               ↑                                 ↑
            [End]←                            [End]←

Down at start_right_padding       Down at centerline_x
```

Both have same bend count. But centerline looks more "intentional" and symmetric.

### The Key Insight: Segment Classification

Not all segments are equal. From NEW_PROMPT.MD:

```
[Start]→→→→↓
       A   ↓ B
           →→→→→↓ C
                ↓ D
                ↑ E
             [End]←

A: Initial stub (forced by exit direction)
B: First vertical - CORRIDOR TRANSIT (can use centerline)
C: Horizontal crossing - CORRIDOR TRANSIT (can use centerline)
D: Second vertical - WRAP SEGMENT (must hug)
E: Final stub (forced by entry direction)
```

**Corridor transit segments have freedom. Wrap segments must hug.**

---

## FACING LINES vs WRAP LINES

For Exit EAST → Enter EAST with start left of end:

```
      start_right_pad   centerline   end_left_pad   end_right_pad
             |              |             |              |
[Start]=====]|              |             |[=============]
             |              |             |              |
             |              |             |              |
             |              |             |[====End=====]→
             |              |             |              |

      FACING LINE      CENTERLINE    FACING LINE    WRAP LINE
      (corridor)       (corridor)    (corridor)     (required)
```

- **Facing lines:** `start_right_pad` and `end_left_pad` - define the corridor
- **Centerline:** Midpoint of corridor - preferred route
- **Wrap line:** `end_right_pad` - far side, MUST use to wrap around

**Rule:** Within corridor (between facing lines), prefer centerline. Wrap line has no alternative.

---

## DIRECTION RELATIONSHIP CLASSIFICATION

### Opposing Directions (Most Common)
```
Exit EAST, Enter WEST  → OPPOSING_HORIZONTAL
Exit WEST, Enter EAST  → OPPOSING_HORIZONTAL
Exit NORTH, Enter SOUTH → OPPOSING_VERTICAL
Exit SOUTH, Enter NORTH → OPPOSING_VERTICAL
```
**Centerline Strategy:** Use X-centerline (vertical line) for horizontal opposing, Y-centerline (horizontal line) for vertical opposing.

### Same Direction (Wrap Required)
```
Exit EAST, Enter EAST  → SAME_DIRECTION (must wrap)
Exit NORTH, Enter NORTH → SAME_DIRECTION (must wrap)
```
**Centerline Strategy:** Centerline still useful for corridor transit portion, but wrap segment must hug.

### Perpendicular Directions
```
Exit EAST, Enter NORTH  → PERPENDICULAR
Exit EAST, Enter SOUTH  → PERPENDICULAR
```
**Centerline Strategy:** Direct L possible if in agreeing quadrant. Otherwise, centerline for bridge segment.

---

## SPATIAL AGREEMENT

For centerline to be useful, there must be a corridor:

```
endIsRight = endBounds.left > startBounds.right;   // Clear gap, end to right
endIsLeft = endBounds.right < startBounds.left;    // Clear gap, end to left
overlapX = !endIsRight && !endIsLeft;              // X extents overlap
```

| Exit→Enter | Spatial | Agreement? | Strategy |
|------------|---------|------------|----------|
| E→W | endIsRight | ✓ IDEAL | X-CENTERLINE |
| E→W | endIsLeft | ✗ BACKWARDS | WRAP |
| E→W | overlapX | ✗ BLOCKED | HUG |
| S→N | endIsBelow | ✓ IDEAL | Y-CENTERLINE |
| E→E | any | ✗ NEVER | WRAP (centerline for corridor portion) |

---

## CREATIVE SUGGESTIONS FOR IMPLEMENTATION

### Approach 1: Edge Role Labeling + Cost Penalties

Label each edge with its semantic role:

```typescript
type EdgeRole =
  | 'CORRIDOR_CENTERLINE'   // Prefer strongly
  | 'CORRIDOR_FACING'       // Parallel to centerline, discourage
  | 'WRAP_REQUIRED'         // Must use, no penalty
  | 'NORMAL';               // Default

function classifyEdgeRole(edge: Edge, corridor: Corridor): EdgeRole {
  if (edge.isVertical() && corridor.axis === 'x') {
    if (Math.abs(edge.x - corridor.centerline) < EPSILON) {
      return 'CORRIDOR_CENTERLINE';
    }
    if (edge.x === corridor.facingLineStart || edge.x === corridor.facingLineEnd) {
      return 'CORRIDOR_FACING';
    }
    if (edge.x === wrapLine) {
      return 'WRAP_REQUIRED';
    }
  }
  return 'NORMAL';
}

function getEdgeCost(edge: Edge, baseLength: number): number {
  switch (edge.role) {
    case 'CORRIDOR_CENTERLINE': return baseLength * 0.5;  // Strong preference
    case 'CORRIDOR_FACING':     return baseLength * 2.0;  // Discourage
    case 'WRAP_REQUIRED':       return baseLength;        // Neutral (necessary)
    default:                    return baseLength;
  }
}
```

**Pros:** Flexible, debuggable, allows fallback if centerline blocked
**Cons:** Requires edge-level labeling, more complex

### Approach 2: Dynamic AABB Merging

Grow facing sides toward each other until they meet at centerline:

```typescript
// Instead of separate facing lines, merge to single centerline
if (hasCorridor && preferCenterline) {
  // Don't add: start_right_pad, end_left_pad
  // Only add: centerline
  xLines.push(corridor.centerline);
}

// Start point still needs connection to centerline
// Add horizontal edges from start position to centerline
```

**Pros:** Forces centerline usage, simpler A* graph
**Cons:** Less flexible, need special handling for start/goal connections

### Approach 3: Conditional Edge Blocking

Block facing line edges when centerline provides parallel alternative:

```typescript
function shouldIncludeEdge(edge: Edge, corridor: Corridor): boolean {
  if (!corridor.exists) return true;

  if (edge.isVertical() && corridor.axis === 'x') {
    const isOnFacingLine =
      edge.x === corridor.facingLineStart ||
      edge.x === corridor.facingLineEnd;

    if (isOnFacingLine) {
      // Block if centerline covers this Y range
      return !corridor.centerlineCoversRange(edge.yRange);
    }
  }
  return true;
}
```

**Pros:** Guarantees centerline usage where applicable
**Cons:** Must ensure graph remains solvable

### Approach 4: Two-Phase Routing

1. **Strategy Selection:** Before A*, classify the situation and decide strategy
2. **Path Optimization:** Run A* with strategy-appropriate constraints

```typescript
function selectStrategy(from, to, startBounds, endBounds): Strategy {
  const dirRelation = classifyDirections(from.outwardDir, to.outwardDir);
  const spatial = classifySpatial(startBounds, endBounds);

  switch (dirRelation) {
    case OPPOSING_HORIZONTAL:
      if (spatial.hasCorridorAhead) {
        return { type: CENTERLINE, axis: 'x', value: (from.x + to.x) / 2 };
      } else if (spatial.isBackwards) {
        return { type: WRAP, wrapDir: ... };
      } else {
        return { type: HUG, side: ... };
      }
    // ... other cases
  }
}

// Then use strategy to configure A* costs
```

**Pros:** Clean separation of concerns, explicit aesthetic preferences
**Cons:** More code, strategy selection logic can get complex

### Approach 5: Waypoint Forcing

Simple but effective:

```typescript
if (strategy === USE_CENTERLINE_X) {
  const waypointY = (from.position[1] + to.position[1]) / 2;
  const waypoint = { x: centerlineX, y: waypointY };

  const path1 = astar(from, waypoint);
  const path2 = astar(waypoint, to);
  return concatenate(path1, path2);
}
```

**Pros:** Simplest conceptually, guarantees centerline usage
**Cons:** May create suboptimal paths, two A* runs

---

## RECOMMENDED APPROACH

**Hybrid: Strategy Selection + Edge Cost Penalties**

1. **Detect Corridor:** Check if facing sides have clear gap between them
2. **Classify Strategy:** Based on direction relationship and spatial agreement
3. **Label Edges:** Mark edges as CENTERLINE/FACING/WRAP during grid construction
4. **Apply Costs:** Modify A* cost function based on edge labels

This preserves flexibility (A* still finds best path) while expressing aesthetic preferences (centerline is cheaper than facing lines).

---

## IMPLEMENTATION ROADMAP

### Phase 1: Corridor Detection
Add to routing-grid.ts:
```typescript
interface Corridor {
  exists: boolean;
  axis: 'x' | 'y';
  facingLineStart: number;
  facingLineEnd: number;
  centerline: number;
  yRange?: { min: number; max: number };
  xRange?: { min: number; max: number };
}

function detectCorridor(from: Terminal, to: Terminal): Corridor;
```

### Phase 2: Direction Classification
Add to routing-astar.ts:
```typescript
type DirectionRelation =
  | 'OPPOSING_HORIZONTAL'
  | 'OPPOSING_VERTICAL'
  | 'SAME_DIRECTION'
  | 'PERPENDICULAR';

function classifyDirections(exitDir: Dir, enterDir: Dir): DirectionRelation;
```

### Phase 3: Edge Labeling
Extend GridCell or add edge metadata:
```typescript
interface GridEdge {
  from: GridCell;
  to: GridCell;
  role: EdgeRole;
  cost: number;
}
```

### Phase 4: Cost Integration
Modify computeMoveCost() to factor in edge roles:
```typescript
function computeMoveCost(from, to, arrivalDir, moveDir, edgeRole): number {
  let cost = baseMoveCost(from, to, arrivalDir, moveDir);

  switch (edgeRole) {
    case 'CORRIDOR_CENTERLINE': cost *= 0.5; break;
    case 'CORRIDOR_FACING':     cost *= 2.0; break;
  }

  return cost;
}
```

---

## RESTRUCTURING CONSIDERATION

Current structure splits information across files:
- routing.ts (dispatch)
- routing-astar.ts (algorithm)
- routing-grid.ts (grid construction)
- routing-zroute.ts (simple paths)

**Suggestion:** Consolidate into unified routing module with clear internal structure:
1. **Types & Constants:** All interfaces in one place
2. **Strategy Selection:** Direction/spatial classification, corridor detection
3. **Grid Construction:** Unified with edge labeling
4. **Path Finding:** A* with strategy-aware costs
5. **Path Assembly:** Simplification, signature generation

This makes the information flow explicit and reduces the need to pass context between modules.

---

## SEMANTIC LABELS FOR CLARITY

Replace abstract dirs with semantic names:

```typescript
// Instead of:
from.outwardDir === 'E'

// Use:
const exitingRight = from.outwardDir === 'E';
const enteringFromLeft = to.outwardDir === 'W';
const hasHorizontalCorridor = endBounds.left > startBounds.right;
const needsWrap = exitingRight && endIsLeft;  // backwards
```

Makes the routing logic self-documenting.

---

## NEXT STEPS

1. Implement corridor detection
2. Add direction relationship classification
3. Test edge labeling with small examples
4. Integrate costs and validate with visual tests
5. Handle anchored-start case properly
6. Implement two-obstacle routing for anchor→anchor
