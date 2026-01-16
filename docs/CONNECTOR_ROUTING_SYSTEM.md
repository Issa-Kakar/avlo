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
6. **Visual edge clearance** - Snapped endpoints offset outward to prevent caps/arrows entering shapes

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
                    │   ├── Build dynamic AABBs (config-aware: anchored→free vs free→anchored)
                    │   ├── Compute stubs (on AABB boundaries)
                    │   └── Collect obstacles
                    │
                    ├── buildSimpleGrid(ctx)
                    │   └── Add AABB lines + stub perpendiculars
                    │
                    └── astar(grid, start, goal, startDir, obstacles)
                        └── Segment intersection checking
```

### A* Routing

| From | To | Obstacles |
|------|----|-----------|
| Free | Free | None |
| Free | Anchored | to.shapeBounds |
| Anchored | Free | from.shapeBounds |
| Anchored | Anchored | Both shapes |

- Free→Free cases naturally creates forced 3-segment HVH/VHV routes when both endpoints are free because of centerline merging
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
function computeCenterlines(startRaw, endRaw, isFreeToAnchored, isAnchoredToFree, offset): Centerlines
```

A centerline exists when:
1. **No overlap** on that axis
2. **For FREE→ANCHORED:** Gap must be ≥ `offset` (minimum clearance for routing)
3. **For ANCHORED→FREE:** Gap must be > `EDGE_CLEARANCE_W - 1` (minimum centerline gap)

**Why the anchored→free check?** When using full centerline merging for anchored→free endpoints, the stub position lands on the centerline. If the gap is too small (≤ `EDGE_CLEARANCE_W`), the stub X could end up between the edge snap offset position and the raw shape bounds. This would cause the first segment to go "backwards" (e.g., west when anchored to east side). The minimum gap check prevents this edge case.

**Formula:**
```typescript
// X centerline (vertical line between shapes)
if (endRaw.left > startRaw.right) {
  const gap = endRaw.left - startRaw.right;
  centerX = (startRaw.right + endRaw.left) / 2;

  if (isFreeToAnchored && gap < offset) centerX = null;
  if (isAnchoredToFree && gap <= EDGE_CLEARANCE_W - 1) centerX = null;
}
```

### Step 3: Build Dynamic AABBs

This is the **key innovation**. AABBs encode centerline knowledge in their boundaries, with **three distinct cases** based on endpoint configuration:

**Case 1: Anchored→Free Point (full centerline merging):**
```typescript
if (isPoint && isAnchoredToFree) {
  return {
    left: centerlines.x ?? raw.left,    // Shift to centerline if exists
    right: centerlines.x ?? raw.right,
    top: centerlines.y ?? raw.top,
    bottom: centerlines.y ?? raw.bottom,
  };
}
```

Full centerline merging preserves **WYSIWYG**: the path looks identical whether the user stops at a free point or continues to snap to a shape.

**Case 2: Free→Anchored Point (facing-side logic):**

Free→anchored points use the **same facing-side logic as shapes**. This is critical because the direction seeding may compute an escape direction (N/S) when the free point is contained within the target shape's padded bounds. If we did full centerline merging, the stub X would be at the centerline, causing the first segment to go horizontal instead of the intended vertical escape.

By using facing-side logic, the point acts like an "imaginary shape" where the outward direction determines which sides are "facing". Non-facing sides stay at the raw position, ensuring the first segment respects the computed direction.

**Case 3: Shape Bounds (anchored endpoints):**
```typescript
// Determine which sides "face" the other shape
const facesRight = raw.right <= other.left;  // This shape is LEFT of other
const facesLeft = raw.left >= other.right;   // This shape is RIGHT of other
const facesBottom = raw.bottom <= other.top; // This shape is ABOVE other
const facesTop = raw.top >= other.bottom;    // This shape is BELOW other

return {
  // Facing side → centerline (if exists), else padded outward
  // For points: non-facing stays at raw position (no padding)
  left: (facesLeft && centerlines.x !== null)
    ? centerlines.x : (isPoint ? raw.left : raw.left - offset),
  right: (facesRight && centerlines.x !== null)
    ? centerlines.x : (isPoint ? raw.right : raw.right + offset),
  // ... same pattern for top/bottom
};
```

**Key insight:** Anchored→anchored and anchored→free share identical AABB logic (facing-side for shapes, full merge for free end). Free→anchored is the exception: it uses facing-side logic for the free start point to ensure direction seeding takes effect.

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

**Why no cell blocking during creation?**
- Segment intersection checking prevents actually crossing shapes. Cell blocking during construction is inherently useless: The **PATH** between cells is what must be blocked anyway; segment intersection checking handles this during A*

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

Uses **parametric slab method** for precise segment-AABB intersection. Works with raw shape bounds (no stroke inflation needed)

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

Consolidated single function that computes start direction from spatial relationship between free point and target shape.

**Decision tree:**

1. **INSIDE FULL PADDING:**
   - Opposite side: wrap toward target on perpendicular axis
   - Same side or adjacent: escape outward (anchorDir)

2. **SAME SIDE** (outside padding):
   - L-route (axis mismatch) checks sliver escape first
   - Both Z-route and L-route return same direction: toward shape on primary axis

3. **OPPOSITE SIDE + CONTAINED** (in padded X and Y):
   - Wrap around via shape center (N/S or E/W based on anchor axis)

4. **ADJACENT / OPPOSITE-CLEAR:**
   - Sliver escape if applicable, else anchorDir

```typescript
export function resolveFreeStartDir(fromPos, toTerminal, strokeWidth): Dir {
  // All values computed ONCE: offset, padded bounds, position flags,
  // containment, deltas, spatial relationship, sliver escape

  // Inside full padding: escape or wrap
  if (inFullPad) {
    if (oppSide) return wrapDir;  // toward target on perp axis
    return anchorDir;              // escape outward
  }

  // Same side: check sliver, then go toward shape
  if (sameSide) {
    if (axisMismatch && sliverDir) return sliverDir;
    return primaryAxisDir;
  }

  // Opposite + contained: wrap around shape
  if (oppSide && nearX && nearY) return wrapAroundDir;

  // Adjacent or opposite-clear: sliver or anchor
  return sliverDir ?? anchorDir;
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

**Why simpler than FREE→ANCHORED?**

1. **No escape logic needed:** Free→anchored handles "inside padding" specially (escape direction). Anchored→free doesn't need this—the anchored start already has a fixed outward direction from its shape.

2. **WYSIWYG alignment:** Anchored→anchored and anchored→free produce identical paths. The only difference is the free endpoint uses `computeFreeEndDir()` for its arrow direction. This is essential for grid construction: we must add the correct perpendicular line to ensure A* can reach the goal stub.


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

For free-free routing case endpoints, direction is inferred from cursor movement with hysteresis.

---

## Snapping System (`snap.ts`)

### Priority Logic (Nested Shapes)

1. Sort candidates by area ascending (smallest = most nested first)
2. Among equal-area, prefer higher z-order (ULID descending)
3. Pick first valid snap target

### Snap Modes

| Location | Behavior |
|----------|----------|
| Deep inside shape (> 35px depth) | Midpoints only (nearest of N/E/S/W) |
| Shallow inside or outside | Snap to edge, midpoints are sticky |
| Outside edge radius | No snap |

**Inside-Edge Sliding:** When the cursor is inside a shape but not deeply (< `FORCE_MIDPOINT_DEPTH_PX`), snapping still works along the edge. The system projects the cursor onto the nearest edge and allows sliding. Midpoint hysteresis is calculated from this projected edge position, so the behavior is identical whether the cursor is just inside or just outside the shape.

### Midpoint Hysteresis

- **Snap IN threshold:** 16px (enter midpoint lock)
- **Snap OUT threshold:** 20px (exit midpoint lock)

### Edge Clearance Offset

When snapping to a shape edge, `getConnectorEndpoint(snap)` applies `EDGE_CLEARANCE_W` offset in the outward direction. This ensures:
- Round line caps don't visually enter the shape
- Arrowheads maintain visual separation from shape edges
- Consistent appearance regardless of stroke width

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

## Preview Rendering (`connector-preview.ts`)

### Polyline with Rounded Corners

Uses `ctx.arcTo()` for smooth corner transitions. The corner radius is clamped to fit available segment lengths:

```typescript
const maxR = Math.min(CORNER_RADIUS_W, lenIn / 2, lenOut / 2);
if (maxR < 2) {
  ctx.lineTo(curr[0], curr[1]);  // Sharp corner
} else {
  ctx.arcTo(curr[0], curr[1], next[0], next[1], maxR);
}
```

### Dynamic Arrow Scaling

**Critical rule:** Arrow length NEVER exceeds the final segment length.

When the final segment is short (e.g., endpoint near a corner), the arrow scales down proportionally:

```typescript
function computeScaledArrowDimensions(segmentLength, strokeWidth) {
  const fullArrowLength = computeArrowLength(strokeWidth);
  const fullHalfWidth = computeArrowWidth(strokeWidth) / 2;

  if (segmentLength >= fullArrowLength) {
    return { scaledLength: fullArrowLength, scaledHalfWidth: fullHalfWidth };
  }

  // Length matches segment exactly
  const scaledLength = segmentLength;

  // Width scales proportionally, with minimum for visibility
  const scale = segmentLength / fullArrowLength;
  const scaledHalfWidth = Math.max(fullHalfWidth * scale, strokeWidth * 0.5);

  return { scaledLength, scaledHalfWidth };
}
```

This prevents jarringly large arrows from extending backwards past the previous corner.

### Rounded Arrow Corners

Arrow heads use `lineJoin='round'` with a stroked overlay on a filled triangle:

```typescript
ctx.lineJoin = 'round';
ctx.lineCap = 'round';
ctx.lineWidth = roundingLineWidth;  // Controls corner radius

ctx.beginPath();
// Draw triangle vertices
ctx.fill();   // Solid interior
ctx.stroke(); // Adds rounded corners (radius = lineWidth/2)
```

### End Trim for Arrows

The polyline is trimmed before the arrow head to prevent overlap. Trim accounts for arc geometry:

```typescript
// Available for trimming = segment length - arc corner radius
const availableForTrim = Math.max(0, segLen - actualCornerRadius);
const actualTrim = Math.min(scaledArrowLength, availableForTrim);
```

---

## Constants (`constants.ts`)

### Screen-Space (CSS pixels)

```typescript
SNAP_CONFIG = {
  EDGE_SNAP_RADIUS_PX: 14,        // Snap to edge within this
  MIDPOINT_SNAP_IN_PX: 16,        // Enter midpoint lock
  MIDPOINT_SNAP_OUT_PX: 20,       // Exit midpoint lock (small hysteresis)
  FORCE_MIDPOINT_DEPTH_PX: 35,    // Force midpoint-only when deeper inside
  DOT_RADIUS_PX: 7,               // Anchor dot size
  ENDPOINT_RADIUS_PX: 8,          // Endpoint dot size
}
```

### World-Space (world units)

```typescript
ROUTING_CONFIG = {
  CORNER_RADIUS_W: 26,       // Arc radius for rounded corners
  ARROW_LENGTH_FACTOR: 3,    // Arrow length scales with stroke
  ARROW_WIDTH_FACTOR: 3.5,   // Arrow width scales with stroke
  ARROW_MIN_LENGTH_W: 10,    // Minimum arrow length
  ARROW_MIN_WIDTH_W: 8,      // Minimum arrow width
}

/** Visual clearance between endpoint and shape edge (world units) */
EDGE_CLEARANCE_W = 12;
```

### Approach Offset Formula

```typescript
function computeApproachOffset(strokeWidth: number): number {
  const arrowLength = computeArrowLength(strokeWidth);
  return CORNER_RADIUS_W + arrowLength + EDGE_CLEARANCE_W / 2;
}
```

The approach offset determines how far routing bounds extend from shape edges. It accounts for: arc corner radius, arrow length, and half the edge clearance.

---

## Key Invariants

1. **Centerlines use actual edges** - Computed from raw bounds, not padded boundaries
2. **Dynamic AABBs share facing sides** - Both AABBs have the same centerline as their facing boundary
3. **Point-AABB behavior depends on configuration:**
   - **Anchored→free:** Full centerline merging (all edges shift to centerline)
   - **Free→anchored:** Facing-side logic (only facing sides get centerline)
4. **Segment intersection checking during A*** - No cell blocking at grid construction time
5. **Directions resolved before routing** - `from.outwardDir` and `to.outwardDir` are trustworthy; A* just uses them
6. **Stubs are ON AABB boundaries** - Automatically land on centerlines when they exist
7. **approachOffset = corner + arrow + clearance/2** - Room for arc, arrowhead, and visual gap
8. **Edge clearance for snap positions** - `getConnectorEndpoint()` offsets by `EDGE_CLEARANCE_W`
9. **Arrow length ≤ segment length** - Dynamic scaling prevents arrows extending past corners

---

## Testing Scenarios

### Route Shape Validation
1. **Free→Anchored (H-dominant, E anchor):** HVH with X centerline
2. **Free→Anchored (V-dominant, E anchor):** VH L-route (no centerline use)
3. **Anchored→Free (N anchor, drag north, V-dominant):** VHV with Y centerline
4. **Anchored→Free (N anchor, drag east, H-dominant):** VH L-route
5. **Free→Free:** 3-segment HVH/VHV based on drag direction (no obstacles)

### Dynamic Offset
1. **Stubs on centerline:** Route starts/ends at centerline, not padded boundary
2. **Shapes close together:** Centerline adjusts dynamically

---

## File Dependency Graph

```
ConnectorTool.ts
├── findBestSnapTarget()                 [snap.ts]
├── getConnectorEndpoint()               [snap.ts] - applies EDGE_CLEARANCE_W
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

connector-preview.ts
├── drawConnectorPreview()                - main entry point
│   ├── computeEndTrim()                  - trim polyline for arrow
│   ├── computeScaledArrowDimensions()    - dynamic arrow sizing
│   ├── drawRoundedPolyline()             - arcTo corners
│   ├── drawArrowHead()                   - rounded triangle
│   ├── drawShapeAnchorDots()             - midpoint indicators
│   └── drawEndpointDot()                 - start/end handles
└── ROUTING_CONFIG, SNAP_CONFIG           [constants.ts]
```

---

## Current Status & Future Work

**⚠️ PREVIEW ONLY:** This connector system is currently preview-only. The routing and rendering work, but full integration into the app is incomplete.

### Immediate Next Steps

1. **Connector dot rendering** - Dots on shapes need visual improvements (placement, styling)
2. **Stroke width settings** - Current "S" size will become "XL"; need new smaller sizes
3. **Fallback routing** - Straight line fallback should reroute with no obstacles instead
4. **Inside-shape endpoints** - Handle cases where endpoint is inside a shape
5. **Terminal creation refactor** - Extract terminal building from ConnectorTool.ts

