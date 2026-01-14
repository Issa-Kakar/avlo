# Connector Routing System - Complete Technical Reference

## Overview

The connector tool implements orthogonal (Manhattan) routing using a **Dynamic AABB architecture**. Routes are aesthetically pleasing: they use centerlines between shapes rather than hugging shape edges, with automatic obstacle avoidance.

**Core Architecture:**
1. **RoutingContext** - Single source of truth for all spatial analysis
2. **Dynamic AABBs** - Routing bounds with centerlines baked into facing sides
3. **Point-AABBs** - Free endpoints represented as collapsed bounds
4. **Simple Non-Uniform Grid** - Grid lines come directly from AABB boundaries
5. **Segment Intersection** - A* checks segments against obstacles (no cell blocking)

**Design Principles:**
1. **Centerline routing** - Routes prefer the midpoint between facing shape sides
2. **Direction resolution first** - Endpoint directions computed before routing begins
3. **Spatial intelligence in context** - All smart decisions in RoutingContext, grid/A* are simple consumers
4. **No cell blocking** - Segment intersection checking prevents crossing shapes
5. **Unified endpoint handling** - Point-AABBs make free endpoints work like shapes

---

## File Structure

```
client/src/lib/connectors/
├── types.ts               # All shared types (Dir, Terminal, Bounds, RoutingContext, Grid, etc.)
├── constants.ts           # SNAP_CONFIG (screen px), ROUTING_CONFIG (world), COST_CONFIG (A*)
├── connector-utils.ts     # Shape frame helpers, direction resolution, bounds conversion, path utilities
├── snap.ts                # Shape snapping with edge detection and midpoint hysteresis
├── routing-context.ts     # Routing context: centerlines, dynamic AABBs, stubs, grid construction
├── routing-astar.ts       # A* pathfinding with segment intersection checking, computeRoute entry point
├── binary-heap.ts         # MinHeap priority queue for A*
└── index.ts               # Re-exports all public API

client/src/lib/tools/
└── ConnectorTool.ts       # Main tool: gesture handling, direction resolution, commit

client/src/renderer/layers/
└── connector-preview.ts   # Preview rendering with rounded corners and arrows
```

---

## Core Data Structures

All types are defined in `types.ts` and re-exported via `index.ts`.

### Terminal (Endpoint Definition)
```typescript
interface Terminal {
  position: [number, number];   // World coordinates
  outwardDir: Dir;              // Direction extending from this point (N/E/S/W)
  isAnchored: boolean;          // Snapped to shape?
  hasCap: boolean;              // Has arrow cap? (affects offset)
  shapeBounds?: AABB;           // Shape bounds for obstacle blocking
  t?: number;                   // Edge position parameter (0-1)
}
```

**Key insight:** `outwardDir` is the direction a jetty/approach segment extends from the endpoint, NOT the direction of travel. For snapped endpoints, it's the side of the shape. For free endpoints, it's computed based on the spatial relationship.

### Bounds (Edge-Based AABB)
```typescript
interface Bounds {
  left: number;    // minX
  top: number;     // minY
  right: number;   // maxX
  bottom: number;  // maxY
}
```

**Why edges instead of x/y/w/h:**
- Grid lines: `xLines.add(b.left)` vs `xLines.add(b.x)`
- Centerline: `(a.right + b.left) / 2` vs `(a.x + a.w + b.x) / 2`
- Facing checks: `a.right <= b.left` vs derived calculations

### RoutingContext (Single Source of Truth)
```typescript
interface RoutingContext {
  // Original terminals (unchanged)
  from: Terminal;
  to: Terminal;

  // Dynamic routing bounds (centerline/padding baked in)
  startBounds: Bounds;      // NOT raw shape bounds - these are routing AABBs
  endBounds: Bounds;

  // Stub positions - WHERE A* actually starts/ends (ON bounds boundary)
  startStub: [number, number];
  endStub: [number, number];

  // Resolved directions
  startDir: Dir;
  endDir: Dir;

  // Raw shape bounds for obstacle checking (NOT the routing bounds)
  obstacles: AABB[];
}
```

**Critical design:** This is the SINGLE place where all spatial intelligence lives. Grid construction and A* just consume these pre-computed values.

### Dir (Cardinal Direction)
```typescript
type Dir = 'N' | 'E' | 'S' | 'W';
```

### Grid and GridCell (A* Navigation)
```typescript
interface GridCell {
  x: number;       // World X coordinate
  y: number;       // World Y coordinate
  xi: number;      // Grid index X
  yi: number;      // Grid index Y
  blocked: boolean; // Always false (segment checking handles obstacles)
}

interface Grid {
  cells: GridCell[][];  // 2D cell array [yi][xi]
  xLines: number[];     // Sorted unique X coordinates
  yLines: number[];     // Sorted unique Y coordinates
}
```

### AStarNode (Pathfinding State)
```typescript
interface AStarNode {
  cell: GridCell;
  g: number;           // Cost from start
  h: number;           // Heuristic to goal
  f: number;           // f = g + h
  parent: AStarNode | null;
  arrivalDir: Dir | null;  // Direction we arrived from (for bend penalty)
}
```

---

## Routing Architecture

### High-Level Flow

```
ConnectorTool.updateRoute()
    │
    ├── Resolve directions (for free endpoints)
    │   ├── FREE→ANCHORED: resolveFreeStartDir()
    │   └── ANCHORED→FREE: computeFreeEndDir()
    │
    └── computeRoute(fromTerminal, toTerminal, strokeWidth)
            │
            └── computeAStarRoute()
                    │
                    ├── createRoutingContext()
                    │   ├── Compute centerlines (from RAW bounds)
                    │   ├── Build dynamic AABBs (centerline/padding)
                    │   ├── Compute stubs (on AABB boundaries)
                    │   └── Collect obstacles
                    │
                    ├── buildSimpleGrid(ctx)
                    │   └── Add AABB lines + stub perpendiculars
                    │
                    └── astar(grid, start, goal, startDir, obstacles)
                        └── Segment intersection checking
```

### Unified A* Routing

All endpoint combinations use A* routing. The separate Z-route algorithm was removed because A* with Point-AABBs produces identical results for free→free cases (centerline merging naturally creates optimal 3-segment HVH/VHV routes when both endpoints are free).

| From | To | Obstacles |
|------|----|-----------|
| Free | Free | None |
| Free | Anchored | to.shapeBounds |
| Anchored | Free | from.shapeBounds |
| Anchored | Anchored | Both shapes |

---

## RoutingContext Creation (`routing-context.ts`)

### Step 1: Extract Raw Bounds

```typescript
const startRaw = from.shapeBounds ? toBounds(from.shapeBounds) : pointBounds(from.position);
const endRaw = to.shapeBounds ? toBounds(to.shapeBounds) : pointBounds(to.position);
```

- **Shapes** → Convert `{x,y,w,h}` to edge-based `Bounds`
- **Free points** → Create collapsed bounds where `left === right` and `top === bottom`

### Step 2: Compute Centerlines

Centerlines are computed from **RAW bounds** (actual geometry, no padding):

```typescript
function computeCenterlines(startRaw, endRaw, isFreeToAnchored, offset): Centerlines
```

A centerline exists when:
1. **No overlap** on that axis
2. **For FREE→ANCHORED:** Gap must be ≥ `offset` (minimum clearance)

**Formula:**
```typescript
// X centerline (vertical line between shapes)
if (endRaw.left > startRaw.right) {
  centerX = (startRaw.right + endRaw.left) / 2;  // Midpoint between actual edges
}

// Y centerline (horizontal line between shapes)
if (endRaw.top > startRaw.bottom) {
  centerY = (startRaw.bottom + endRaw.top) / 2;
}
```

### Step 3: Build Dynamic AABBs

This is the **key innovation**. AABBs encode centerline knowledge in their boundaries:

**For Point-AABBs (free endpoints):**
```typescript
if (isPointBounds(raw)) {
  return {
    left: centerlines.x ?? raw.left,    // Shift to centerline if exists
    right: centerlines.x ?? raw.left,
    top: centerlines.y ?? raw.top,
    bottom: centerlines.y ?? raw.top,
  };
}
```

Point-AABBs can't use spatial facing logic (a point has `left === right`). Instead, they **shift to centerline coordinates** when centerlines exist.

**For Shape Bounds (anchored endpoints):**
```typescript
// Determine which sides "face" the other shape
const facesRight = raw.right <= other.left;  // This shape is LEFT of other
const facesLeft = raw.left >= other.right;   // This shape is RIGHT of other
const facesBottom = raw.bottom <= other.top; // This shape is ABOVE other
const facesTop = raw.top >= other.bottom;    // This shape is BELOW other

return {
  // Facing side → centerline (if exists), else padded outward
  left: facesLeft && centerlines.x !== null ? centerlines.x : raw.left - offset,
  right: facesRight && centerlines.x !== null ? centerlines.x : raw.right + offset,
  top: facesTop && centerlines.y !== null ? centerlines.y : raw.top - offset,
  bottom: facesBottom && centerlines.y !== null ? centerlines.y : raw.bottom + offset,
};
```

**Key insight:** Both start and end AABBs share the same centerline as their facing boundaries. This is what makes routes naturally use centerlines.

### Step 4: Compute Stubs

Stubs are where A* actually starts/ends. They're at the intersection of:
- The anchor's fixed axis position (Y for E/W, X for N/S)
- The AABB boundary in the outward direction

```typescript
function computeStub(bounds, anchorPos, dir): [number, number] {
  switch (dir) {
    case 'E': return [bounds.right, ay];  // Right boundary, anchor's Y
    case 'W': return [bounds.left, ay];   // Left boundary, anchor's Y
    case 'S': return [ax, bounds.bottom]; // Anchor's X, bottom boundary
    case 'N': return [ax, bounds.top];    // Anchor's X, top boundary
  }
}
```

**Result:** Stubs naturally land on centerlines when they exist, because the AABB boundary IS the centerline.

### Step 5: Collect Obstacles

Raw shape bounds (not routing bounds) are collected for segment intersection checking:

```typescript
const obstacles: AABB[] = [];
if (from.shapeBounds) obstacles.push(from.shapeBounds);
if (to.shapeBounds && to.shapeBounds !== from.shapeBounds) {
  obstacles.push(to.shapeBounds);
}
```

---

## Grid Construction (`routing-context.ts`)

Grid construction is now **trivial** because RoutingContext handles all intelligence. The `buildSimpleGrid()` function lives alongside `createRoutingContext()` in the same file:

```typescript
export function buildSimpleGrid(ctx: RoutingContext): Grid {
  const xSet = new Set<number>();
  const ySet = new Set<number>();

  // Add all 4 edges from each routing bounds
  xSet.add(ctx.startBounds.left);
  xSet.add(ctx.startBounds.right);
  ySet.add(ctx.startBounds.top);
  ySet.add(ctx.startBounds.bottom);

  xSet.add(ctx.endBounds.left);
  xSet.add(ctx.endBounds.right);
  ySet.add(ctx.endBounds.top);
  ySet.add(ctx.endBounds.bottom);

  // Add stub perpendicular lines
  if (isHorizontal(ctx.startDir)) ySet.add(ctx.startStub[1]);
  else xSet.add(ctx.startStub[0]);

  if (isHorizontal(ctx.endDir)) ySet.add(ctx.endStub[1]);
  else xSet.add(ctx.endStub[0]);

  // Sort and build cells (no blocking - A* checks segments)
  const xLines = [...xSet].sort((a, b) => a - b);
  const yLines = [...ySet].sort((a, b) => a - b);

  const cells: GridCell[][] = [];
  for (let yi = 0; yi < yLines.length; yi++) {
    cells[yi] = [];
    for (let xi = 0; xi < xLines.length; xi++) {
      cells[yi][xi] = { x: xLines[xi], y: yLines[yi], xi, yi, blocked: false };
    }
  }

  return { cells, xLines, yLines };
}
```

**Why no cell blocking?**
1. Dynamic AABBs with centerlines are already valid routing corridors
2. Segment intersection checking prevents actually crossing shapes
3. Cell blocking during construction is inherently useless: The **PATH** between cells is what must be blocked anyway; segment intersection checking handles this during A*

---

## A* Pathfinding (`routing-astar.ts`)

### Algorithm Flow

```typescript
export function computeAStarRoute(from, to, strokeWidth): RouteResult {
  // 1. Build routing context (ALL spatial intelligence here)
  const ctx = createRoutingContext(from, to, strokeWidth);

  // 2. Build simple grid from context
  const grid = buildSimpleGrid(ctx);

  // 3. Find start and goal cells (at stub positions)
  const startCell = findNearestCell(grid, ctx.startStub);
  const goalCell = findNearestCell(grid, ctx.endStub);

  // 4. Run A* between stubs (seed with startDir)
  const path = astar(grid, startCell, goalCell, ctx.startDir, ctx.obstacles);

  // 5. Assemble full path: actual_start → A* path → actual_end
  const fullPath = [from.position, ...path.map(c => [c.x, c.y]), to.position];

  // 6. Simplify collinear points
  return { points: simplifyOrthogonal(fullPath), signature };
}
```

**Key design:** The full path is `[actual_start, ...A*_path, actual_end]`. This handles dynamic offset correctly—when stubs are on centerlines, the actual endpoints gracefully enter/exit shapes.

### Cost Function

```typescript
function computeMoveCost(from, to, arrivalDir, moveDir): number {
  let cost = manhattan(from, to);  // Base: Manhattan distance

  // Prevent U-turns (backwards movement)
  if (arrivalDir && moveDir === oppositeDir(arrivalDir)) {
    return Infinity;
  }

  // Bend penalty: minimize direction changes
  if (arrivalDir && moveDir !== arrivalDir) {
    cost += COST_CONFIG.BEND_PENALTY;  // 1000
  }

  return cost;
}
```

**Bend penalty (1000)** strongly prefers the path with the most minimal turns. This naturally produces the best looking routes when combined with the dynamic AABBs: as forcing centerlines to be the routing boundaries for facing sides forces centerline usage whenever possible; Thus a path with fewest bends+manhattan distance is the only heuristic needed as there's assurance that a theoretical path with fewer bends than a path with a centerline won't exist due to the facing sides always being the centerline for each facing axis. 

### Segment Intersection Checking

```typescript
for (const neighbor of getNeighbors(grid, current.cell)) {
  if (neighbor.blocked) continue;

  // Check if segment crosses ANY obstacle interior
  if (obstacles.length > 0) {
    const segmentBlocked = obstacles.some(obs =>
      segmentIntersectsAABB(current.cell.x, current.cell.y, neighbor.x, neighbor.y, obs)
    );
    if (segmentBlocked) continue;
  }
  // ... continue with A* exploration
}
```

Uses **parametric slab method** for precise segment-AABB intersection. This handles:
- Thin shapes that midpoint checks could miss
- Any segment orientation
- Works with raw shape bounds (no stroke inflation needed)

### Priority Queue (`binary-heap.ts`)

A* uses a `MinHeap<AStarNode>` for the open set priority queue:

```typescript
const openSet = new MinHeap<AStarNode>((a, b) => a.f - b.f);
```

The heap provides O(log n) push/pop operations, extracted into a standalone file for clarity.

---

## Direction Resolution (`connector-utils.ts`)

Directions are resolved **BEFORE** routing begins, based on endpoint configuration. All direction helpers live in `connector-utils.ts`.

### FREE→ANCHORED: `resolveFreeStartDir()`

Computes start direction from spatial relationship between free point and target shape:

**Three spatial cases:**

1. **SAME SIDE** (Z-route possible)
   - Start is on same side as anchor's opposite (e.g., start LEFT, anchor WEST)
   - Z-route only valid when primary axis matches anchor axis
   - Otherwise: L-route on perpendicular axis

2. **OPPOSITE SIDE** (wrap around)
   - Start is "behind" the shape (e.g., start LEFT, anchor EAST)
   - If inside padded bounds: wrap around via shortest path (N or S)

3. **ADJACENT SIDE** (L-route)
   - Go directly toward anchor
   - Check for sliver zone escape first

**Inside Padding Special Case:**
```typescript
if (isInsidePaddedRegion(fromPos, toTerminal.shapeBounds, strokeWidth)) {
  return computePreferredFirstDir(fromPos, toTerminal);  // Escape logic
} else {
  return computeFreeStartDirection(fromPos, toTerminal, strokeWidth);
}
```

### ANCHORED→FREE: `computeFreeEndDir()`

Simple primary axis + sign computation:

```typescript
export function computeFreeEndDir(fromPos, toPos): Dir {
  const dx = toPos[0] - fromPos[0];
  const dy = toPos[1] - fromPos[1];
  const axis = Math.abs(dx) >= Math.abs(dy) ? 'H' : 'V';
  return axis === 'H' ? (dx >= 0 ? 'E' : 'W') : (dy >= 0 ? 'S' : 'N');
}
```

**Why simpler than FREE→ANCHORED?** Free-anchored must determine which direction to route around in U route scenarios(going around and behind the shape to the oppisite facing side), and also handle starting inside padding differently than anchored->free. In anchored->free, the startInsidePadding will always be true on initial drag, causing the initial drag to not point outwards from a shape as it must "escape" to padding reigon. This escape behaviour when starting inside padding is only good UX for free->anchored. At its core, anchored->anchored and anchored->free routing is exactly the same path wise. only difference is that the end direction/arrow head is not computed automatically, which is why we compute end direction there: its essential for grid construction as we must only add one line based on axis during AABB generation, to ensure the only way to reach the goal stub is the intersection of an AABB existing line(which could be a shape padded boundary, but, also be a centerline, thus enforcing centerline path as the only way to reach goal)

### Direction Resolution in ConnectorTool

```typescript
private updateRoute(): void {
  let resolvedFromDir = this.from.outwardDir;
  let resolvedToDir = this.to.outwardDir;

  if (!fromAnchored && toAnchored && toShapeBounds) {
    // FREE→ANCHORED: Spatial relationship
    resolvedFromDir = resolveFreeStartDir(this.from.position, toTerminal, strokeWidth);
  } else if (fromAnchored && !toAnchored) {
    // ANCHORED→FREE: Primary axis + sign
    resolvedToDir = computeFreeEndDir(this.from.position, this.to.position);
  }
  // Both free: inferDragDirection already handled in move()
  // Both anchored: snap.side already set

  // Build terminals with RESOLVED directions
  const fromTerminal = { ...this.from, outwardDir: resolvedFromDir };
  const toTerminal = { ...this.to, outwardDir: resolvedToDir };

  const result = computeRoute(fromTerminal, toTerminal, prevSignature, strokeWidth);
}
```

---

### Drag Direction Inference: `inferDragDirection()`

For free endpoints, direction is inferred from cursor movement with hysteresis:

```typescript
export function inferDragDirection(from, cursor, prevDir, hysteresisRatio = 1.04): Dir {
  const dx = cursor[0] - from[0];
  const dy = cursor[1] - from[1];
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);

  let axis = ax >= ay ? 'H' : 'V';

  // Hysteresis: require margin to switch axis
  if (prevDir && isHorizontal(prevDir) && ay > ax * hysteresisRatio) axis = 'V';
  if (prevDir && !isHorizontal(prevDir) && ax > ay * hysteresisRatio) axis = 'H';

  return axis === 'H' ? (dx >= 0 ? 'E' : 'W') : (dy >= 0 ? 'S' : 'N');
}
```

---

## Snapping System (`snap.ts`)

### Priority Logic (Nested Shapes)

1. Sort candidates by area ascending (smallest = most nested first)
2. Among equal-area, prefer higher z-order (ULID descending)
3. Pick first valid snap target

### Snap Modes

| Location | Behavior |
|----------|----------|
| Deep inside shape | Midpoints only (nearest of N/E/S/W) |
| Near edge | Snap to edge, midpoints are sticky |
| Outside edge radius | No snap |

### Midpoint Hysteresis

- **Snap IN threshold:** 14px (enter midpoint lock)
- **Snap OUT threshold:** 20px (exit midpoint lock)
- Prevents jitter when cursor hovers near midpoint

### Shape-Type Awareness

- **rect/roundedRect:** Edge is the frame boundary
- **ellipse:** Closest point on ellipse perimeter, side determined by angle
- **diamond:** Four diagonal edges, mapped to N/E/S/W based on quadrant

---

## ConnectorTool (`ConnectorTool.ts`)

### State Machine

```typescript
type Phase = 'idle' | 'creating';
```

### Gesture Flow

```
idle:
  └─ Shows anchor dots on hovered shapes (via hoverSnap)
  └─ findBestSnapTarget() on every move

begin(pointerId, worldX, worldY):
  └─ Check snap at cursor
  ├─ Snap found: from = anchored terminal with shapeBounds
  └─ No snap: from = free terminal, outwardDir = 'E' (refined in move)
  └─ Initialize to = free terminal at same position
  └─ updateRoute()

move(worldX, worldY):
  └─ Check snap at cursor
  ├─ Snap found: to = anchored terminal with shapeBounds
  │   └─ dragDir reset to null
  └─ No snap: to = free terminal
      └─ Update dragDir via inferDragDirection()
      └─ If from is free: update from.outwardDir = dragDir
  └─ updateRoute()

end():
  └─ Commit if valid (dist > 5px, points >= 2)
  └─ resetState()
```

### Commit Schema

```typescript
connectorMap.set('fromX', fromX);
connectorMap.set('fromY', fromY);
connectorMap.set('toX', toX);
connectorMap.set('toY', toY);

// If anchored:
connectorMap.set('fromShapeId', shapeId);
connectorMap.set('fromSide', side);
connectorMap.set('fromT', t);

// Waypoints (intermediate points)
connectorMap.set('waypoints', routedPoints.slice(1, -1));

// Styling
connectorMap.set('color', color);
connectorMap.set('width', width);
connectorMap.set('endCap', 'arrow');
```

---

## Constants (`constants.ts`)

### Screen-Space (CSS pixels)

```typescript
SNAP_CONFIG = {
  EDGE_SNAP_RADIUS_PX: 12,   // Snap to edge within this
  MIDPOINT_SNAP_IN_PX: 14,   // Enter midpoint lock
  MIDPOINT_SNAP_OUT_PX: 20,  // Exit midpoint lock
  INSIDE_DEPTH_PX: 10,       // Force midpoint-only when deep inside
  DOT_RADIUS_PX: 7,          // Anchor dot size
  ENDPOINT_RADIUS_PX: 7,     // Endpoint dot size
}
```

### World-Space (world units)

```typescript
ROUTING_CONFIG = {
  CORNER_RADIUS_W: 28,       // Arc radius for rounded corners
  ARROW_LENGTH_FACTOR: 4,    // Arrow scales with stroke
  ARROW_WIDTH_FACTOR: 3,
  ARROW_MIN_LENGTH_W: 10,
  ARROW_MIN_WIDTH_W: 8,
}
```

### Approach Offset Formula

```typescript
function computeApproachOffset(strokeWidth: number): number {
  const arrowLength = Math.max(ARROW_MIN_LENGTH_W, strokeWidth * ARROW_LENGTH_FACTOR);
  return CORNER_RADIUS_W + arrowLength;
}

// Example: 2px stroke
//   arrowLength = max(10, 2*4) = 10
//   offset = 28 + 10 = 38 world units
```

---

## Key Invariants

1. **Centerlines use actual edges** - Not padded boundaries
2. **Dynamic AABBs share facing sides** - Both AABBs have the same centerline as their facing boundary
3. **Point-AABBs shift to centerlines** - Free endpoints adopt centerline coordinates when they exist
4. **Cell Blocking is during routing, not grid construction** - Segment intersection checking handles obstacle avoidance
5. **Directions resolved before routing for unanchored endpoints** - `from.outwardDir` and `to.outwardDir` are trustworthy; A* just uses them
6. **Stubs are ON AABB boundaries** - Not separate offset calculations
7. **approachOffset = corner + arrow** - Sufficient room for geometry
8. **Full segment intersection** - Uses slab method on raw shape bounds

---

## Testing Scenarios

### Route Shape Validation
1. **Free→Anchored (H-dominant, E anchor):** HVH with X centerline
2. **Free→Anchored (V-dominant, E anchor):** VH L-route (no centerline use)
3. **Anchored→Free (N anchor, drag north, V-dominant):** VHV with Y centerline
4. **Anchored→Free (N anchor, drag east, H-dominant):** VH L-route
5. **Free→Free:** 3-segment HVH/VHV based on drag direction (no obstacles)

### Centerline Usage
1. **Anchored→Anchored (shapes separated):** Route uses centerline
2. **Shapes overlapping on one axis:** No centerline on that axis, regular shape padded boundary are the AABB edges on that axis

### Dynamic Offset
1. **Stubs on centerline:** Route starts/ends at centerline, not padded boundary
2. **Shapes close together:** Centerline adjusts dynamically

### Obstacle Avoidance
1. **Anchored→Anchored:** Both shapes blocked, route wraps around
2. **Free->Anchored Start inside padding:** Escapes correctly based on spatial relationship

---

## Architecture Benefits

### Compared to Previous System

| Old Code | New Code |
|----------|----------|
| `computeFacingSides()` | `computeCenterlines()` (unified) |
| `computeFacingSidesFromPoint()` | (merged into above) |
| `computeFacingSidesToPoint()` | (merged into above) |
| `FacingSides` interface | `Centerlines` (just `{x, y}`) |
| `blockFacingSideCells()` | **DELETED** |
| Complex grid construction | Simple AABB line addition |
| ~200+ line `buildNonUniformGrid()` | ~40 line `buildSimpleGrid()` |
| Multiple `approachOffset` usages | Centralized in context |
| Separate `routing.ts` entry point | Merged into `routing-astar.ts` |
| Separate `routing-zroute.ts` | **DELETED** (A* handles free→free) |
| Types scattered across files | Centralized in `types.ts` |
| `shape-utils.ts` | Renamed to `connector-utils.ts` |

### Key Design Decisions

1. **Unified A* routing** - All endpoint combinations use A* pathfinding. Point-AABBs and centerline merging produce optimal 3-segment routes for free→free cases automatically.

2. **Spatial analysis in RoutingContext** - All centerline computation, AABB building, and stub computation happens once per route update.

3. **Dynamic AABBs with baked-in intelligence** - Routing bounds already incorporate centerlines and padding. Grid lines come directly from AABB edges.

4. **Point-AABBs for free endpoints** - Unified handling for all endpoint types.

5. **No cell blocking** - Segment intersection checking is more robust and eliminates complex blocking logic.

6. **Direction seeding** - A* starts with a known direction, producing predictable first segments.

7. **Centralized types** - All shared types in `types.ts` reduce duplication and make imports cleaner.

---

## File Dependency Graph

```
ConnectorTool.ts
├── findBestSnapTarget()                 [snap.ts]
├── resolveFreeStartDir()                [connector-utils.ts]
├── computeFreeEndDir()                  [connector-utils.ts]
├── inferDragDirection()                 [connector-utils.ts]
├── computeRoute()                       [routing-astar.ts]
│   └── computeAStarRoute()              [routing-astar.ts]
│       ├── createRoutingContext()       [routing-context.ts]
│       │   ├── computeCenterlines()
│       │   ├── buildRoutingBounds()
│       │   └── computeStub()
│       ├── buildSimpleGrid()            [routing-context.ts]
│       ├── astar()                       [routing-astar.ts]
│       │   ├── MinHeap                   [binary-heap.ts]
│       │   └── segmentIntersectsAABB()
│       └── simplifyOrthogonal()         [connector-utils.ts]
├── getShapeFrame()                       [connector-utils.ts]
└── computeApproachOffset()               [constants.ts]
```

---

## Future Work

1. **Sticky connectors** - Shapes move, connectors follow (planned)
2. **Start inside shape** - Behavior undefined (planned)
3. **Multiple obstacles** - Support for third-party shapes in route
4. **Bezier curves** - Alternative to orthogonal routing
