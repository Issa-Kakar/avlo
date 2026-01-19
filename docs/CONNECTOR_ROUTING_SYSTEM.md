# Connector Routing System - Complete Technical Reference

> **📍 Connector System Status**
>
> **Authoritative code:** `client/src/lib/connectors/*`, `ConnectorTool.ts`, and `connector-preview.ts`
>
> **Integrated:** `objects.ts` rendering, `object-cache.ts` (multi-path support), `bbox.ts` (arrow extent), `connector-lookup.ts` (reverse map)
>
> **Not yet integrated:** SelectTool (select/edit connectors), hit-testing with arrows, anchor rerouting on shape move

## Overview

The connector tool implements orthogonal (Manhattan) routing using a **Dynamic AABB architecture**. Routes are aesthetically pleasing: they use centerlines between shapes rather than hugging shape edges, with automatic obstacle avoidance.

**Core Architecture:**

1. **RoutingContext** - Single source of truth for all spatial analysis
2. **Dynamic AABBs** - Routing bounds with centerlines baked into facing sides
3. **Point-AABBs** - Free endpoints represented as collapsed bounds
4. **Simple Non-Uniform Grid** - Grid lines come directly from AABB boundaries
5. **Segment Intersection** - A\* checks segments against obstacles (no cell blocking)

**Design Principles:**

1. **Centerline routing** - Routes prefer the midpoint between facing shape sides
2. **Direction resolution first** - Endpoint directions computed before routing begins
3. **Spatial intelligence in context** - All smart decisions in RoutingContext, grid/A\* are simple consumers
4. **No cell blocking** - Segment intersection checking prevents crossing shapes
5. **Unified endpoint handling** - Point-AABBs make free endpoints work like shapes
6. **Visual edge clearance** - Snapped endpoints offset outward to prevent caps/arrows entering shapes

---

## File Structure

```
client/src/lib/connectors/
├── types.ts               # All shared types (Dir, Terminal, SnapTarget, RoutingContext, Grid, etc.)
├── constants.ts           # SNAP_CONFIG, ANCHOR_DOT_CONFIG (screen px), ROUTING_CONFIG (world)
├── connector-utils.ts     # Shape frame/midpoint helpers, direction resolution, bounds conversion
├── snap.ts                # Shape snapping with edge detection, midpoint hysteresis, normalized anchors
├── routing-context.ts     # Routing context: centerlines, dynamic AABBs, stubs, grid construction
├── routing-astar.ts       # A* pathfinding with segment intersection checking, computeRoute entry point
├── connector-paths.ts     # Pure Path2D builders (polyline, arrows) shared by cache and preview
├── connector-lookup.ts    # Reverse map: shapeId → connectorIds (maintained by RoomDocManager)
├── binary-heap.ts         # MinHeap priority queue for A*
└── index.ts               # Re-exports all public API

client/src/lib/tools/
└── ConnectorTool.ts       # Main tool: gesture handling, direction resolution, commit

client/src/renderer/
├── object-cache.ts        # Geometry cache with union type: Path2D | ConnectorPaths
└── layers/
    ├── objects.ts         # Base canvas rendering including drawConnector()
    └── connector-preview.ts  # Preview rendering: polyline, arrows, anchor dots

packages/shared/src/utils/
└── bbox.ts                # BBox computation including connector arrow extent
```

---

## Core Data Structures

All types are defined in `types.ts` and re-exported via `index.ts`.

### Terminal (Endpoint Definition)

```typescript
interface Terminal {
  position: [number, number]; // World coordinates (with offset for anchored)
  outwardDir: Dir; // Direction extending from this point (N/E/S/W)
  isAnchored: boolean; // Snapped to shape?
  hasCap: boolean; // Has arrow cap? (affects offset)
  shapeBounds?: AABB; // Shape bounds for obstacle blocking
  normalizedAnchor?: [number, number]; // Frame-relative position [0-1, 0-1]
}
```

**Key insight:** `outwardDir` is the direction a jetty/approach segment extends from the endpoint, NOT the direction of travel. For snapped endpoints, it's the side of the shape. For free endpoints, it's computed based on the spatial relationship.

### SnapTarget (Snap Result)

```typescript
interface SnapTarget {
  shapeId: string; // ID of snapped shape
  side: Dir; // Which edge (N/E/S/W)
  normalizedAnchor: [number, number]; // Frame-relative [0-1, 0-1]
  isMidpoint: boolean; // At edge midpoint?
  position: [number, number]; // Endpoint position WITH offset (for routing)
  edgePosition: [number, number]; // Position ON shape edge (for dot rendering)
  isInside: boolean; // Cursor inside shape?
}
```

**Key insight:** `normalizedAnchor` enables shape-agnostic position reconstruction:

```typescript
edgePos = [frame.x + anchor[0] * frame.w, frame.y + anchor[1] * frame.h];
```

No shape-type awareness needed for resize/move operations. The snap system computes the correct edge position once (handling ellipse curves, diamond diagonals, etc.), then normalizes it.

### Bounds (Edge-Based AABB)

```typescript
interface Bounds {
  left: number; // minX
  top: number; // minY
  right: number; // maxX
  bottom: number; // maxY
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
  startBounds: Bounds; // NOT raw shape bounds - these are routing AABBs
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

**Critical design:** This is the SINGLE place where all spatial intelligence lives. Grid construction and A\* just consume these pre-computed values.

### Dir (Cardinal Direction)

```typescript
type Dir = 'N' | 'E' | 'S' | 'W';
```

### Grid and GridCell (A\* Navigation)

```typescript
interface GridCell {
  x: number; // World X coordinate
  y: number; // World Y coordinate
  xi: number; // Grid index X
  yi: number; // Grid index Y
  blocked: boolean; // Always false (segment checking handles obstacles)
}

interface Grid {
  cells: GridCell[][]; // 2D cell array [yi][xi]
  xLines: number[]; // Sorted unique X coordinates
  yLines: number[]; // Sorted unique Y coordinates
}
```

### AStarNode (Pathfinding State)

```typescript
interface AStarNode {
  cell: GridCell;
  g: number; // Cost from start
  h: number; // Heuristic to goal
  f: number; // f = g + h
  parent: AStarNode | null;
  arrivalDir: Dir | null; // Direction we arrived from (for bend penalty)
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

### A\* Routing

| From     | To       | Obstacles        |
| -------- | -------- | ---------------- |
| Free     | Free     | None             |
| Free     | Anchored | to.shapeBounds   |
| Anchored | Free     | from.shapeBounds |
| Anchored | Anchored | Both shapes      |

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
function computeCenterlines(startRaw, endRaw, isFreeToAnchored, offset): Centerlines;
```

A centerline exists when:

1. **No overlap** on that axis
2. **For FREE→ANCHORED:** Gap must be ≥ `offset` (stricter minimum clearance for routing)
3. **For all other cases:** Gap must be > `EDGE_CLEARANCE_W` (minimum centerline gap)

**Why the minimum gap check?** When the stub position lands on the centerline and the gap is too small (≤ `EDGE_CLEARANCE_W`), the stub could end up between the edge snap offset position and the raw shape bounds. This would cause the first segment to go "backwards" (e.g., west when anchored to east side). The minimum gap check prevents this edge case for anchored→free, anchored→anchored, and free→free configurations.

**Formula:**

```typescript
// X centerline (vertical line between shapes)
if (endRaw.left > startRaw.right) {
  const gap = endRaw.left - startRaw.right;
  centerX = (startRaw.right + endRaw.left) / 2;

  if (isFreeToAnchored && gap < offset) centerX = null;
  else if (gap <= EDGE_CLEARANCE_W) centerX = null;
}
```

### Step 3: Build Dynamic AABBs

This is the **key innovation**. AABBs encode centerline knowledge in their boundaries, with **three distinct cases** based on endpoint configuration:

**Case 1: Anchored→Free Point (full centerline merging):**

```typescript
if (isPoint && isAnchoredToFree) {
  return {
    left: centerlines.x ?? raw.left, // Shift to centerline if exists
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
const facesRight = raw.right <= other.left; // This shape is LEFT of other
const facesLeft = raw.left >= other.right; // This shape is RIGHT of other
const facesBottom = raw.bottom <= other.top; // This shape is ABOVE other
const facesTop = raw.top >= other.bottom; // This shape is BELOW other

return {
  // Facing side → centerline (if exists), else padded outward
  // For points: non-facing stays at raw position (no padding)
  left:
    facesLeft && centerlines.x !== null ? centerlines.x : isPoint ? raw.left : raw.left - offset,
  right:
    facesRight && centerlines.x !== null ? centerlines.x : isPoint ? raw.right : raw.right + offset,
  // ... same pattern for top/bottom
};
```

**Key insight:** Anchored→anchored and anchored→free share identical AABB logic (facing-side for shapes, full merge for free end). Free→anchored is the exception: it uses facing-side logic for the free start point to ensure direction seeding takes effect.

### Step 4: Compute Stubs

Stubs are where A\* actually starts/ends. They're at the intersection of:

- The anchor's fixed axis position (Y for E/W, X for N/S)
- The AABB boundary in the outward direction

```typescript
function computeStub(bounds, anchorPos, dir): [number, number] {
  switch (dir) {
    case 'E':
      return [bounds.right, ay]; // Right boundary, anchor's Y
    case 'W':
      return [bounds.left, ay]; // Left boundary, anchor's Y
    case 'S':
      return [ax, bounds.bottom]; // Anchor's X, bottom boundary
    case 'N':
      return [ax, bounds.top]; // Anchor's X, top boundary
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

- Segment intersection checking prevents actually crossing shapes. Cell blocking during construction is inherently useless: The **PATH** between cells is what must be blocked anyway; segment intersection checking handles this during A\*

---

## A\* Pathfinding (`routing-astar.ts`)

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
  const fullPath = [from.position, ...path.map((c) => [c.x, c.y]), to.position];

  // 6. Simplify collinear points
  return { points: simplifyOrthogonal(fullPath), signature };
}
```

**Key design:** The full path is `[actual_start, ...A*_path, actual_end]`. This handles dynamic offset correctly—when stubs are on centerlines, the actual endpoints gracefully enter/exit shapes.

### Cost Function

```typescript
function computeMoveCost(from, to, arrivalDir, moveDir): number {
  let cost = manhattan(from, to); // Base: Manhattan distance

  // Prevent U-turns (backwards movement)
  if (arrivalDir && moveDir === oppositeDir(arrivalDir)) {
    return Infinity;
  }

  // Bend penalty: minimize direction changes
  if (arrivalDir && moveDir !== arrivalDir) {
    cost += COST_CONFIG.BEND_PENALTY; // 1000
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
    const segmentBlocked = obstacles.some((obs) =>
      segmentIntersectsAABB(current.cell.x, current.cell.y, neighbor.x, neighbor.y, obs),
    );
    if (segmentBlocked) continue;
  }
  // ... continue with A* exploration
}
```

Uses **parametric slab method** for precise segment-AABB intersection. Works with raw shape bounds (no stroke inflation needed)

### Obstacle-Free Retry Fallback

When A\* exhausts its open set without finding a path (common with diamond/ellipse shapes where segment intersection has edge cases), it **retries with no obstacles** before falling back to a straight line:

```typescript
// End of astar() function
if (obstacles.length > 0) {
  return astar(grid, start, goal, startDir, []);
}
return [start, goal]; // Direct line fallback (rarely reached)
```

**Why this works:**

- Reuses the same grid (no re-computation needed)
- With no obstacles, A\* always finds an orthogonal path
- No infinite recursion: recursive call passes `[]`, won't recurse again
- The direct line fallback only triggers if even obstacle-free routing fails (shouldn't happen)

This ensures routes remain orthogonal even when obstacle intersection checking fails, rather than producing ugly straight lines through shapes.

### Priority Queue (`binary-heap.ts`)

A\* uses a `MinHeap<AStarNode>` for the open set priority queue:

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
    if (oppSide) return wrapDir; // toward target on perp axis
    return anchorDir; // escape outward
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
  return axis === 'H' ? (dx >= 0 ? 'E' : 'W') : dy >= 0 ? 'S' : 'N';
}
```

**Why simpler than FREE→ANCHORED?**

1. **No escape logic needed:** Free→anchored handles "inside padding" specially (escape direction). Anchored→free doesn't need this—the anchored start already has a fixed outward direction from its shape.

2. **WYSIWYG alignment:** Anchored→anchored and anchored→free produce identical paths. The only difference is the free endpoint uses `computeFreeEndDir()` for its arrow direction. This is essential for grid construction: we must add the correct perpendicular line to ensure A\* can reach the goal stub.

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

| Location                         | Behavior                            |
| -------------------------------- | ----------------------------------- |
| Deep inside shape (> 35px depth) | Midpoints only (nearest of N/E/S/W) |
| Shallow inside or outside        | Snap to edge, midpoints are sticky  |
| Outside edge radius              | No snap                             |

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

- **rect/roundedRect:** Edge is the frame boundary; midpoints at frame edge centers
- **ellipse:** Closest point on ellipse perimeter, side determined by angle; midpoints at frame edge centers
- **diamond:** Four diagonal edges, mapped to N/E/S/W based on quadrant; midpoints at visual apex of rounded corners (accounts for `arcTo` geometry)

### Normalized Anchor Computation

When snapping, `computeAnchorAndPosition()` converts edge position to normalized anchor:

```typescript
normalizedAnchor = [
  (edgeX - frame.x) / frame.w, // Clamped to [0,1]
  (edgeY - frame.y) / frame.h,
];
```

This is shape-agnostic: the snap system computes the correct shape-perimeter point once, then normalizes. Reconstruction for resize/move is trivial linear interpolation.

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
  ├─ Snap found: from = anchored terminal, to = from (same reference)
  └─ No snap: from = free terminal, to = free terminal at cursor
  └─ updateRoute()
```

**Terminal seeding on begin():** When snapped, `this.to = this.from` prevents routing from the edge to the cursor position inside the shape. This is temporary—`move()` immediately refines `this.to`. Similar to how `outwardDir` is seeded with a default and refined on move, the endpoint position is seeded identically to avoid visual glitches before the user moves.

move(worldX, worldY):
└─ Check snap at cursor (hoverSnap updated for dot rendering)
├─ Snap found: to = anchored terminal with shapeBounds, normalizedAnchor
│ └─ dragDir reset to null
└─ No snap: to = free terminal
└─ Update dragDir via inferDragDirection()
└─ If from is free: update from.outwardDir = dragDir
└─ updateRoute()

end():
└─ Commit if valid (dist > 5px, points >= 2)
└─ resetState()

````

### Commit Schema (Y.Map Structure)

```typescript
// Identity
connectorMap.set('id', id);
connectorMap.set('kind', 'connector');

// Full routed path (assembled, ready to render)
connectorMap.set('points', routedPoints);  // [number, number][]

// Endpoint positions (always present)
connectorMap.set('start', [x, y]);  // [number, number]
connectorMap.set('end', [x, y]);    // [number, number]

// Anchor data (grouped, only if anchored to a shape/text/image)
connectorMap.set('startAnchor', {   // Optional - only if start is anchored
  id: shapeId,                      // Target object ID
  side: 'E',                        // Dir: N/E/S/W
  anchor: [nx, ny],                 // Normalized [0-1, 0-1] frame-relative
});
connectorMap.set('endAnchor', { ... });  // Same structure

// Caps (flat)
connectorMap.set('startCap', 'none');
connectorMap.set('endCap', 'arrow');

// Styling
connectorMap.set('color', color);
connectorMap.set('width', width);
connectorMap.set('opacity', opacity);

// Metadata
connectorMap.set('ownerId', userId);
connectorMap.set('createdAt', timestamp);
````

**Design rationale:**

- `points` stores the full assembled path (no reconstruction needed at render time)
- `start`/`end` are separate from `points` for quick endpoint access without array indexing
- `startAnchor`/`endAnchor` group related data atomically—if present, all fields exist (no partial state)
- Anchor `id` field is future-proof for text/image anchoring (not just shapes)

---

## Connector Lookup (`connector-lookup.ts`)

Reverse map from shapes to their anchored connectors. Enables O(1) lookup for:

- **SelectTool:** Find connectors to reroute when shape moves/resizes
- **EraserTool:** Clean up anchors when deleting shapes

### Architecture

```
connector-lookup.ts (module-level state)     room-doc-manager.ts (lifecycle owner)
├── shapeToConnectors: Map<shapeId, Set<connectorId>>    ├── initConnectorLookup() in publishSnapshotNow()
├── connectorAnchors: Map<connectorId, {startId, endId}> ├── hydrateConnectorLookup() in hydrateObjectsFromY()
│                                                         ├── processConnector*() in applyObjectChanges()
└── getConnectorsForShape(shapeId): ReadonlySet          └── clearConnectorLookup() in destroy()
```

**Key Principle:** Logic lives in `connectors/` folder; RoomDocManager owns lifecycle timing only.

### Lifecycle Hooks

| RoomDocManager Method              | Connector Lookup Call                                                    |
| ---------------------------------- | ------------------------------------------------------------------------ |
| `publishSnapshotNow()` (first run) | `initConnectorLookup()` alongside spatialIndex                           |
| `hydrateObjectsFromY()`            | `hydrateConnectorLookup(objectsById)` after bulkLoad                     |
| `applyObjectChanges()` deletion    | `processConnectorDeleted(id)` or `processShapeDeleted(id)`               |
| `applyObjectChanges()` add/update  | `processConnectorAdded(id, yObj)` or `processConnectorUpdated(id, yObj)` |
| `destroy()`                        | `clearConnectorLookup()`                                                 |

### Delta Tracking

The `connectorAnchors` map tracks current anchor state per connector for efficient delta computation:

```typescript
// On connector update, compare old vs new anchors
const old = connectorAnchors.get(connectorId);
if (oldStartId !== newStartId) {
  if (oldStartId) removeConnectorFromShape(oldStartId, connectorId);
  if (newStartId) addConnectorToShape(newStartId, connectorId);
}
```

### Edge Cases

- **Self-loop:** Connector with both ends on same shape appears once in that shape's set
- **Free endpoints:** Connectors with no anchors don't appear in any shape's set
- **Empty set cleanup:** When a shape loses all connectors, its map entry is removed

### Tool Access

```typescript
import { getConnectorsForShape } from '@/canvas/room-runtime';

// In SelectTool during shape transform:
const connectorIds = getConnectorsForShape(shapeId);
if (connectorIds) {
  for (const cid of connectorIds) {
    // Reroute connector with new shape position
  }
}
```

---

## Connector Rendering

Connector rendering is split into two layers that share path-building logic via `connector-paths.ts`:

1. **Preview Layer** (`connector-preview.ts`) - Renders during tool interaction (ephemeral)
2. **Base Canvas** (`objects.ts` + `object-cache.ts`) - Renders committed connectors (persistent)

Both use the same path builders to ensure **WYSIWYG consistency**.

### Shared Path Building (`connector-paths.ts`)

Pure functions that return `Path2D` objects, used by both cache and preview:

```typescript
interface ConnectorPaths {
  polyline: Path2D;       // Main line (trimmed for arrows)
  startArrow: Path2D | null;
  endArrow: Path2D | null;
}

// Main entry point
buildConnectorPaths({ points, strokeWidth, startCap, endCap }): ConnectorPaths

// Individual builders
buildRoundedPolylinePath(points, startTrim, endTrim): Path2D
buildArrowPath(points, strokeWidth, position): Path2D
computeEndTrimInfo(points, strokeWidth, position): EndTrimInfo | null
```

### Object Cache Integration

The `ObjectRenderCache` uses a union type to handle connectors' multi-path requirement:

```typescript
type CachedGeometry = Path2D | ConnectorPaths;

// Type-safe accessors
cache.getPath(id, handle): Path2D              // For strokes, shapes, text
cache.getConnectorPaths(id, handle): ConnectorPaths  // For connectors
```

Eviction works the same as other objects—by ID when bbox changes.

### Committed Rendering (`objects.ts`)

Multi-pass rendering for committed connectors:

```typescript
function drawConnector(ctx, handle): void {
  const paths = cache.getConnectorPaths(id, handle);

  // Pass 1: Stroke polyline
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.stroke(paths.polyline);

  // Pass 2: Arrows (fill + stroke for rounded corners)
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  ctx.lineWidth = ARROW_ROUNDING_LINE_WIDTH; // Fixed 5 for ~2.5 unit radius
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  if (paths.startArrow) {
    ctx.fill(paths.startArrow);
    ctx.stroke(paths.startArrow);
  }
  if (paths.endArrow) {
    ctx.fill(paths.endArrow);
    ctx.stroke(paths.endArrow);
  }
}
```

### BBox Calculation (`bbox.ts`)

Connector bbox accounts for arrow extent, not just stroke width:

```typescript
case 'connector': {
  // Polyline stroke: width / 2
  const strokePadding = width / 2;

  // Arrow extent: arrowHalfWidth + rounding stroke
  const hasArrow = startCap === 'arrow' || endCap === 'arrow';
  if (hasArrow) {
    const arrowLength = Math.max(6, width * 3);
    const arrowHalfWidth = arrowLength / 2;  // ASPECT_RATIO = 1.0
    const arrowRounding = 2.5;               // ARROW_ROUNDING_LINE_WIDTH / 2
    padding = Math.max(strokePadding, arrowHalfWidth + arrowRounding) + 1;
  }
}
```

---

## Preview-Specific Rendering (`connector-preview.ts`)

### Polyline with Rounded Corners

Uses `ctx.arcTo()` for smooth corner transitions. The corner radius is clamped to fit available segment lengths:

```typescript
const maxR = Math.min(CORNER_RADIUS_W, lenIn / 2, lenOut / 2);
if (maxR < 2) {
  ctx.lineTo(curr[0], curr[1]); // Sharp corner
} else {
  ctx.arcTo(curr[0], curr[1], next[0], next[1], maxR);
}
```

### Dynamic Arrow Scaling

**Critical rule:** Arrow length NEVER exceeds half the final segment length (Excalidraw approach).

This prevents arrows from dominating short segments while maintaining proportional aesthetics:

```typescript
function computeScaledArrowDimensions(segmentLength, strokeWidth) {
  const fullLength = computeArrowLength(strokeWidth);

  // Arrow never exceeds half the segment (Excalidraw approach)
  const scaledLength = Math.min(fullLength, segmentLength / 2);

  // Width proportional to SCALED length via fixed aspect ratio
  const scaledHalfWidth = (scaledLength * ROUTING_CONFIG.ARROW_ASPECT_RATIO) / 2;

  return { scaledLength, scaledHalfWidth };
}
```

**Key insight:** Width derives from the **scaled** length (not full length) via `ARROW_ASPECT_RATIO` (1.0 = balanced triangle where width equals length). When length shrinks for short segments, width shrinks proportionally—maintaining consistent arrow shape at all sizes.

### Rounded Arrow Corners

Arrow heads use a filled triangle with a stroked overlay for rounded corners. The stroke's `lineJoin='round'` naturally rounds the vertices.

**Fixed rounding approach:** `roundingLineWidth = 5` gives consistent ~2.5 unit corner radius at all arrow sizes. This decouples corner rounding from connector stroke width.

**Stroke offset compensation:** The stroke extends outward by `lineWidth/2`, including at the tip. To ensure the **visible** tip (after stroke) lands exactly at the endpoint, the path is pulled back:

```typescript
const roundingLineWidth = 5; // Fixed: ~2.5 unit corner radius
const strokeOffset = roundingLineWidth / 2;

// Triangle vertices pulled back so visible tip lands at endpoint
const tipX = tip[0] - ux * strokeOffset;
const tipY = tip[1] - uy * strokeOffset;

ctx.fillStyle = color;
ctx.strokeStyle = color;
ctx.lineWidth = roundingLineWidth;
ctx.lineJoin = 'round';

ctx.beginPath();
ctx.moveTo(tipX, tipY);
ctx.lineTo(leftX, leftY);
ctx.lineTo(rightX, rightY);
ctx.closePath();

ctx.fill(); // Solid interior
ctx.stroke(); // Adds rounded corners (radius = lineWidth/2)
```

### End Trim for Arrows

The polyline is trimmed before the arrow head to prevent overlap. Trim accounts for both arc geometry and round line cap extension:

```typescript
// The arc consumes `actualCornerRadius` of the final segment
const availableForTrim = Math.max(0, segLen - actualCornerRadius);

// Round cap extends strokeWidth/2 beyond the trim point, so we need
// extra trim to prevent the polyline from poking through small arrows
const neededTrim = scaledLength + strokeWidth / 2;
const actualTrim = Math.min(neededTrim, availableForTrim);
```

**Round cap compensation:** Without the `strokeWidth / 2` term, the polyline's round cap would visually extend past the trim point and poke through small arrows. This is especially noticeable with thick strokes and short segments.

### Anchor Dot Rendering

Shape anchor dots use `drawSnapDots()` which renders:

- **4 midpoint dots** at frame edge centers (or diamond apex positions)
- **1 active dot** that slides along the snapped edge at `edgePosition`

**Size variations:**

- Not at midpoint: small midpoint dots (5px), larger active dot (7px)
- At midpoint: ALL dots grow to active size (7px)

**Color scheme:**

- Active dot: deep blue fill (`#1d4ed8`), white stroke
- Inactive dots: white fill, blue stroke (`#1d4ed8`)

**Glow effect:** Active dot has subtle shadow blur for polish.

**Visibility logic:** Dots appear when:

- Idle hover: `!fromIsAttached` (before pointer down, while hovering a shape)
- Creating: `toIsAttached` (when end is snapped, not start)

This prevents showing dots on the start shape after pointer down, only showing them when the end snaps.

---

## Constants (`constants.ts`)

### Screen-Space (CSS pixels)

```typescript
SNAP_CONFIG = {
  EDGE_SNAP_RADIUS_PX: 15, // Snap to edge within this
  MIDPOINT_SNAP_IN_PX: 20, // Enter midpoint lock
  MIDPOINT_SNAP_OUT_PX: 20, // Exit midpoint lock
  FORCE_MIDPOINT_DEPTH_PX: 30, // Force midpoint-only when deeper inside
  DOT_RADIUS_PX: 7, // Anchor dot size
  ENDPOINT_RADIUS_PX: 8, // Endpoint dot size (future: selection tool)
};

ANCHOR_DOT_CONFIG = {
  // See constants.ts for styling
};
```

### World-Space (world units)

```typescript
ROUTING_CONFIG = {
  CORNER_RADIUS_W: 26, // Arc radius for rounded corners
  ARROW_LENGTH_FACTOR: 3, // Arrow length = max(MIN, strokeWidth * FACTOR)
  ARROW_MIN_LENGTH_W: 6, // Minimum arrow length (for thin strokes)
  ARROW_ASPECT_RATIO: 1.0, // Width = length * ratio (balanced triangle)
};

/** Visual clearance between endpoint and shape edge (world units) */
EDGE_CLEARANCE_W = 11;
```

**Arrow sizing formulas:**

```typescript
// Length: scales with stroke, has minimum
arrowLength = max(ARROW_MIN_LENGTH_W, strokeWidth * ARROW_LENGTH_FACTOR);

// Width: derived from length via aspect ratio (always proportional)
arrowWidth = arrowLength * ARROW_ASPECT_RATIO;

// During rendering: length capped at segmentLength / 2
scaledLength = min(arrowLength, segmentLength / 2);
scaledWidth = scaledLength * ARROW_ASPECT_RATIO;
```

### Approach Offset Formula

```typescript
function computeApproachOffset(strokeWidth: number): number {
  const arrowLength = computeArrowLength(strokeWidth);
  return CORNER_RADIUS_W + arrowLength + EDGE_CLEARANCE_W;
}
```

The approach offset determines how far routing bounds extend from shape edges. It accounts for: arc corner radius, arrow length, and edge clearance.

---

## Key Invariants

1. **Centerlines use actual edges** - Computed from raw bounds, not padded boundaries
2. **Dynamic AABBs share facing sides** - Both AABBs have the same centerline as their facing boundary
3. **Point-AABB behavior depends on configuration:**
   - **Anchored→free:** Full centerline merging (all edges shift to centerline)
   - **Free→anchored:** Facing-side logic (only facing sides get centerline)
4. **Segment intersection checking during A\*** - No cell blocking at grid construction time
5. **Directions resolved before routing** - `from.outwardDir` and `to.outwardDir` are trustworthy; A\* just uses them
6. **Stubs are ON AABB boundaries** - Automatically land on centerlines when they exist
7. **approachOffset = corner + arrow + clearance** - Room for arc, arrowhead, and visual gap
8. **Edge clearance for snap positions** - Snap returns `position` (with offset) and `edgePosition` (on shape)
9. **Arrow length ≤ segment length / 2** - Excalidraw approach prevents arrows dominating short segments
10. **Normalized anchor is shape-agnostic** - Stored as `[nx, ny]` in [0,1]×[0,1]; reconstruction is `frame.x + nx*frame.w`

---

## Current Status & Future Work

**Connectors now render identically in preview and base canvas.** The routing, snapping, and rendering systems are complete. Integration work remains for editing existing connectors.

### Completed

- **Y.Map schema** - Structure with `points`, `start`/`end`, grouped `startAnchor`/`endAnchor`
- **BBox calculation** - `bbox.ts` accounts for arrow extent (`arrowLength/2 + 2.5 + 1`)
- **Shared path builders** - `connector-paths.ts` with `buildConnectorPaths()`, `buildArrowPath()`, etc.
- **Object cache union type** - Returns `ConnectorPaths { polyline, startArrow, endArrow }` for connectors
- **Committed rendering** - `objects.ts` handles multi-pass rendering (polyline + arrows)
- **WYSIWYG consistency** - Preview and base canvas use identical path-building functions
- **Type-safe cache API** - `getPath()` for single Path2D, `getConnectorPaths()` for connectors
- **Connector lookup map** - `connector-lookup.ts` maintains shapeId → Set<connectorId> reverse map via RoomDocManager Y.js observers

### Immediate Next Steps

1. **Selection tool integration** - Select/edit existing connectors, endpoint dragging
2. **Anchored shape resize/move** - Recompute routes when shapes move (use `getConnectorsForShape()`)
3. **Hit testing with arrows** - Update hit testing to use cached Path2D for accurate arrow detection
