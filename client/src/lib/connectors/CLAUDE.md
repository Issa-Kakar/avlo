# Connector Routing System v2 - Technical Reference

> **System Status:** Primitives-based routing API, full A* orthogonal routing, SelectTool integration ready via `rerouteConnector()`.

> **Maintenance note:** This is a system-level architectural overview, not a changelog. When updating after code changes, match the detail level of surrounding content — don't inflate coverage of your specific change at the expense of the big-picture pipeline flow and cache interactions that make this document useful.
## Overview

The connector routing system implements **orthogonal (Manhattan) routing** with automatic obstacle avoidance. Routes prefer centerlines between shapes and use dynamic bounding boxes to produce aesthetically pleasing paths.

**Key Design Decisions:**

1. **Primitives-Based API** — Routing accepts 7 primitive values, not Terminal objects
2. **Centerline Routing** — Routes prefer the midpoint between facing shape sides
3. **Dynamic AABBs** — Routing bounds encode centerline knowledge in their boundaries
4. **Segment Intersection** — A* checks segments against obstacles (no cell blocking)
5. **Normalized Anchors** — Shape-agnostic endpoint positions stored as `[0-1, 0-1]`
6. **Override Patterns** — Clean separation between frame overrides and endpoint overrides

---

## File Structure

```
client/src/lib/connectors/
├── types.ts               # Dir, Bounds, AABB, Terminal, SnapTarget, RoutingContext, Grid, ConnectorType, ConnectorCap
├── constants.ts           # SNAP_CONFIG, ROUTING_CONFIG, offset formulas
├── connector-utils.ts     # Anchor application, direction resolution, bounds conversion
├── snap.ts                # Shape snapping with fill-aware visual ordering
├── routing-context.ts     # Centerlines, dynamic AABBs, stubs, grid construction
├── routing-astar.ts       # A* pathfinding with segment intersection checking
├── connector-paths.ts     # Path2D builders (polyline, arrows) for cache and preview
├── connector-lookup.ts    # Reverse map: shapeId → Set<connectorId>
├── reroute-connector.ts   # High-level routing: rerouteConnector (existing Y.map) + routeNewConnector (snap/position)
└── index.ts               # Public API exports
```

---

## Primitives-Based Routing API

The routing layer accepts **7 primitive values** instead of Terminal objects:

```typescript
computeAStarRoute(
  startPos: [number, number],      // 1. Start endpoint position
  startDir: Dir,                   // 2. Start outward direction
  endPos: [number, number],        // 3. End endpoint position
  endDir: Dir,                     // 4. End outward direction
  startShapeBounds: AABB | null,   // 5. Start shape bounds (null = free)
  endShapeBounds: AABB | null,     // 6. End shape bounds (null = free)
  strokeWidth: number              // 7. Connector stroke width
): RouteResult
```

**Why primitives?**

- `isAnchored` is **derived** from `bounds !== null` — no redundant state
- SelectTool can call routing with minimal boilerplate — no Terminal construction
- Routing layer has zero dependency on Y.map data or commit-time fields

---

## Core Data Structures

### Dir (Cardinal Direction)

```typescript
type Dir = 'N' | 'E' | 'S' | 'W';
```

`outwardDir` is the direction a route segment extends **from** an endpoint — the direction of travel away from the anchor point. For snapped endpoints, this matches the shape side.

### Bounds vs AABB

```typescript
// Edge-based representation (internal routing)
interface Bounds { left, top, right, bottom }

// Frame representation (storage, external API)
interface AABB { x, y, w, h }
```

Routing uses `Bounds` internally because edge-based math is cleaner:
- Centerline: `(a.right + b.left) / 2`
- Facing check: `a.right <= b.left`

Convert with `toBounds(aabb)` and `pointBounds(position)`.

### RoutingContext

Single source of truth for all spatial analysis, created by `createRoutingContext()`:

```typescript
interface RoutingContext {
  startPos: [number, number];   // Original endpoint position
  endPos: [number, number];     // Original endpoint position
  startBounds: Bounds;          // Dynamic routing bounds (centerline/padding baked in)
  endBounds: Bounds;            // Dynamic routing bounds
  startStub: [number, number];  // WHERE A* starts (ON bounds boundary)
  endStub: [number, number];    // WHERE A* ends (ON bounds boundary)
  startDir: Dir;                // Resolved direction
  endDir: Dir;                  // Resolved direction
  obstacles: AABB[];            // Raw shape bounds for segment checking
}
```

**Critical insight:** `startBounds`/`endBounds` are **not** raw shape bounds — they're dynamic AABBs with centerline and padding already baked in. This is what makes grid construction trivial.

---

## Routing Architecture

### High-Level Flow

```
computeAStarRoute(7 primitives)
    │
    └── createRoutingContext()
        ├── 1. Compute centerlines (from RAW bounds)
        ├── 2. Build dynamic AABBs (centerline + padding on facing sides)
        ├── 3. Compute stubs (ON AABB boundaries)
        └── 4. Collect obstacles (raw shape bounds)
            │
            └── buildSimpleGrid(ctx)
                └── Add AABB edge lines + stub perpendiculars
                    │
                    └── astar(grid, startCell, goalCell, startDir, obstacles)
                        └── Segment intersection checking per move
                            │
                            └── Assemble: [startPos, ...A*path..., endPos]
                                └── simplifyOrthogonal() → remove collinear points
```

### Centerline Computation

Centerlines are computed from **raw bounds** (actual geometry, no padding):

```typescript
// X centerline (vertical line between horizontally-separated shapes)
if (endRaw.left > startRaw.right) {
  centerX = (startRaw.right + endRaw.left) / 2;
}

// Y centerline (horizontal line between vertically-separated shapes)
if (endRaw.top > startRaw.bottom) {
  centerY = (startRaw.bottom + endRaw.top) / 2;
}
```

**Minimum gap check:** When the gap is too small (≤ `EDGE_CLEARANCE_W`), no centerline is created. This prevents stubs from landing between the endpoint position and the shape edge, which would cause backwards routing.

### Dynamic AABBs

The key innovation: AABBs encode centerline knowledge in their boundaries.

**Three cases based on endpoint configuration:**

| Configuration | Behavior |
|---------------|----------|
| **Anchored→Free** | Full centerline merging — point's AABB collapses to centerline on all axes |
| **Free→Anchored** | Facing-side logic — only facing sides get centerline |
| **Shape bounds** | Facing sides → centerline; non-facing → padded outward |

**Facing-side logic for shapes:**

```typescript
const facesRight = raw.right <= other.left;  // This shape is LEFT of other
const facesLeft = raw.left >= other.right;   // This shape is RIGHT of other

return {
  left: facesLeft && centerX ? centerX : raw.left - offset,
  right: facesRight && centerX ? centerX : raw.right + offset,
  // ... same for top/bottom
};
```

**Result:** When shapes face each other, their AABBs share the centerline as a boundary. Grid lines naturally include this centerline, and A* finds paths through it.

### Stub Computation

Stubs are where A* actually starts and ends — at the intersection of:
- The anchor's fixed axis position (Y for E/W, X for N/S)
- The AABB boundary in the outward direction

```typescript
switch (dir) {
  case 'E': return [bounds.right, anchorY];   // Right boundary, anchor's Y
  case 'W': return [bounds.left, anchorY];    // Left boundary, anchor's Y
  case 'S': return [anchorX, bounds.bottom];  // Anchor's X, bottom boundary
  case 'N': return [anchorX, bounds.top];     // Anchor's X, top boundary
}
```

**Result:** Stubs automatically land on centerlines when they exist, because the AABB boundary IS the centerline for facing sides.

### Grid Construction

Grid construction is trivial because RoutingContext encodes all intelligence:

```typescript
function buildSimpleGrid(ctx: RoutingContext): Grid {
  const xSet = new Set<number>();
  const ySet = new Set<number>();

  // Add all 4 edges from each routing bounds
  [ctx.startBounds, ctx.endBounds].forEach(b => {
    xSet.add(b.left);
    xSet.add(b.right);
    ySet.add(b.top);
    ySet.add(b.bottom);
  });

  // Add stub perpendicular lines (for A* to reach goal)
  if (isHorizontal(ctx.startDir)) ySet.add(ctx.startStub[1]);
  else xSet.add(ctx.startStub[0]);

  // Sort and build cells
  const xLines = [...xSet].sort((a, b) => a - b);
  const yLines = [...ySet].sort((a, b) => a - b);
  // ... create GridCell[][] with blocked: false
}
```

**No cell blocking during construction** — A* checks segment intersection instead.

### A* Pathfinding

```typescript
function astar(grid, start, goal, startDir, obstacles): GridCell[] {
  // MinHeap priority queue sorted by f = g + h
  const openSet = new MinHeap<AStarNode>((a, b) => a.f - b.f);

  // Start node seeded with startDir as arrival direction
  openSet.push({ cell: start, g: 0, h: manhattan(start, goal), arrivalDir: startDir });

  while (!openSet.isEmpty()) {
    const current = openSet.pop();
    if (current.cell === goal) return reconstructPath(current);

    for (const neighbor of getNeighbors(grid, current.cell)) {
      const moveDir = getDirection(current.cell, neighbor);

      // Segment intersection check (not cell blocking)
      if (segmentIntersectsAABB(current.cell, neighbor, obstacle)) continue;

      // Cost with bend penalty
      const cost = computeMoveCost(current.cell, neighbor, current.arrivalDir, moveDir);
      // ... standard A* update
    }
  }

  // Fallback: retry without obstacles, then direct line
  if (obstacles.length > 0) return astar(grid, start, goal, startDir, []);
  return [start, goal];
}
```

**Cost function:**

```typescript
function computeMoveCost(from, to, arrivalDir, moveDir): number {
  let cost = manhattan(from, to);

  // Prevent U-turns
  if (arrivalDir && moveDir === oppositeDir(arrivalDir)) return Infinity;

  // Bend penalty (1000) — strongly prefers fewer turns
  if (arrivalDir && moveDir !== arrivalDir) cost += BEND_PENALTY;

  return cost;
}
```

**Path assembly:**

```typescript
const fullPath = [ctx.startPos, ...astarPath.map(c => [c.x, c.y]), ctx.endPos];
return { points: simplifyOrthogonal(fullPath), signature };
```

---

## Normalized Anchors & Frame Application

### Normalized Anchor Format

When a connector endpoint snaps to a shape, the position is stored as a **normalized anchor** in `[0-1, 0-1]` space relative to the shape's frame:

```typescript
interface StoredAnchor {
  id: string;                    // Target shape ID
  side: Dir;                     // 'N' | 'E' | 'S' | 'W'
  anchor: [number, number];      // Normalized position [0-1, 0-1]
}
```

**Why normalized?** Shape-agnostic position reconstruction. When a shape resizes or moves, reconstructing the world position is trivial linear interpolation — no need to know shape type (rect, ellipse, diamond).

### Computing Normalized Anchor

During snapping, `computeAnchorAndPosition()` converts edge position to normalized anchor:

```typescript
normalizedAnchor = [
  (edgeX - frame.x) / frame.w,
  (edgeY - frame.y) / frame.h,
];
// Clamped to [0, 1]
```

### Applying Anchor to Frame

When rerouting, `applyAnchorToFrame()` reconstructs world position:

```typescript
function applyAnchorToFrame(
  anchor: [number, number],
  frame: FrameTuple,
  side: Dir
): [number, number] {
  const [nx, ny] = anchor;
  const [x, y, w, h] = frame;

  // Interpolate within frame
  const edgeX = x + nx * w;
  const edgeY = y + ny * h;

  // Apply edge clearance offset in outward direction
  const [dx, dy] = directionVector(side);
  return [edgeX + dx * EDGE_CLEARANCE_W, edgeY + dy * EDGE_CLEARANCE_W];
}
```

**Key insight:** Only `EDGE_CLEARANCE_W` (11 units) is applied — not the full approach offset. The approach offset (`CORNER_RADIUS + arrowLength + EDGE_CLEARANCE`) is for routing bounds, not endpoint positions.

---

## Snapping System

### API

```typescript
function findBestSnapTarget(ctx: SnapContext): SnapTarget | null;

interface SnapContext {
  cursorWorld: [number, number];  // Cursor in world coords
  scale: number;                   // Viewport scale (for px→world)
  prevAttach: SnapTarget | null;   // Previous snap (for hysteresis)
}

interface SnapTarget {
  shapeId: string;
  side: Dir;
  normalizedAnchor: [number, number];
  isMidpoint: boolean;
  position: [number, number];      // World coords WITH offset
  edgePosition: [number, number];  // Position ON shape edge (for dots)
  isInside: boolean;
}
```

### Fill-Aware Visual Ordering

Snapping respects Z-order and fill state:

1. Sort candidates by ULID descending (topmost first)
2. For each shape (top to bottom):
   - **Filled interior:** Occluding — snap to it or reject, then stop scanning
   - **Unfilled interior:** Transparent — track smallest found, keep scanning
   - **Edge region:** Always visible for snapping
3. Return innermost unfilled shape if no filled snap

**Result:** Nested shapes snap to the inner-most shape when cursor is inside.

### Snap Modes

| Cursor Location | Behavior |
|-----------------|----------|
| Deep inside (> 35px) | Midpoints only (nearest of N/E/S/W) |
| Shallow inside or outside | Edge sliding with midpoint stickiness |
| Outside snap radius | No snap |

### Ctrl Suppresses Snapping

Holding Ctrl during any connector endpoint interaction prevents binding. `isCtrlHeld()` from `cursor-tracking.ts` is checked before every `findBestSnapTarget()` call — when true, snap is forced to `null`. Affects:
- **ConnectorTool:** `begin()` (start endpoint), `move()` idle (hover dots), `move()` creating (end endpoint)
- **SelectTool:** `move()` endpointDrag phase

Live Ctrl state is updated on every pointer event (`handlePointerDown`, `handlePointerMove`, `handlePointerUp` in CanvasRuntime), so releasing Ctrl mid-drag resumes snapping immediately. No rendering changes needed — null snap already means no dots in both renderers.

### Midpoint Stickiness (Hysteresis)

- Snap IN at 16px from midpoint
- Snap OUT at 16px from midpoint (same threshold)
- Prevents jitter when cursor hovers near midpoint boundary

### Shape-Type Awareness

`findNearestEdgePoint()` handles different geometries:

| Shape | Edge Detection |
|-------|---------------|
| Rect/RoundedRect | Simple edge projection |
| Ellipse | Closest point on perimeter via angle, side from quadrant |
| Diamond | Four diagonal edges mapped to N/E/S/W |

---

## Direction Resolution

### Free→Anchored: `resolveFreeStartDir()`

Complex decision tree based on spatial relationship:

```typescript
resolveFreeStartDir(fromPos, toTerminal, strokeWidth): Dir
```

**Cases:**
1. **Inside full padding** — Escape outward or wrap toward target
2. **Same side as anchor** — Check sliver escape, then go toward shape
3. **Opposite side + contained** — Wrap around shape
4. **Adjacent or clear** — Sliver escape or anchor direction

### Anchored→Free: `computeFreeEndDir()`

Simple primary axis + sign:

```typescript
function computeFreeEndDir(fromPos, toPos): Dir {
  const dx = toPos[0] - fromPos[0];
  const dy = toPos[1] - fromPos[1];
  const axis = Math.abs(dx) >= Math.abs(dy) ? 'H' : 'V';
  return axis === 'H' ? (dx >= 0 ? 'E' : 'W') : (dy >= 0 ? 'S' : 'N');
}
```

### Drag Direction: `inferDragDirection()`

For live feedback during connector creation:

```typescript
inferDragDirection(from, cursor, prevDir, hysteresisRatio = 1.04): Dir
```

Requires winning axis to exceed the other by `hysteresisRatio` to switch — prevents jitter near 45° angles.

---

## Connector Lookup (Reverse Map)

### Purpose

Efficient O(1) lookup of which connectors are anchored to a given shape. Critical for:

- **SelectTool:** Find connectors to reroute when shape transforms
- **EraserTool:** Clean up anchors when deleting shapes

### Data Structure

```typescript
// Module-level state (connector-lookup.ts)
const shapeToConnectors: Map<string, Set<string>>;  // shapeId → connectorIds
const connectorAnchors: Map<string, { startId?: string; endId?: string }>;
```

### Lifecycle

| RoomDocManager Event | Connector Lookup Call |
|----------------------|----------------------|
| `publishSnapshotNow()` | `initConnectorLookup()` |
| `hydrateObjectsFromY()` | `hydrateConnectorLookup(objectsById)` |
| Connector added/updated | `processConnectorAdded/Updated(id, yObj)` |
| Connector deleted | `processConnectorDeleted(id)` |
| Shape deleted | `processShapeDeleted(shapeId)` |
| `destroy()` | `clearConnectorLookup()` |

### Query API

```typescript
import { getConnectorsForShape } from '@/canvas/room-runtime';

const connectorIds = getConnectorsForShape(shapeId);
if (connectorIds) {
  for (const cid of connectorIds) {
    // Reroute this connector
  }
}
```

---

## The Rerouting APIs

Two companion functions sharing `resolveDirections()` internally:
- **`rerouteConnector()`** — Existing connectors: reads Y.map, applies overrides (SelectTool)
- **`routeNewConnector(start, end, strokeWidth, dragDir?)`** — New connectors: accepts `SnapTarget | [x,y]` per endpoint (ConnectorTool)

### Signature

```typescript
function rerouteConnector(
  connectorId: string,
  frameOverrides?: Map<string, FrameTuple>,
  endpointOverrides?: {
    start?: SnapTarget | [number, number];
    end?: SnapTarget | [number, number];
  }
): [number, number][] | null
```

### Two Orthogonal Override Mechanisms

**1. `frameOverrides`** — Temporary shape frames during transform

When a shape is being dragged/resized, pass its temporary frame:

```typescript
const frameOverrides = new Map([
  [selectedShapeId, [newX, newY, newW, newH]]
]);
const points = rerouteConnector(connectorId, frameOverrides);
```

**2. `endpointOverrides`** — Direct endpoint replacement

When dragging a connector endpoint or explicitly repositioning:

```typescript
// Snapped endpoint
const points = rerouteConnector(connectorId, undefined, {
  end: snapTarget  // SnapTarget object
});

// Free endpoint (no snap)
const points = rerouteConnector(connectorId, undefined, {
  end: [worldX, worldY]  // Position tuple
});
```

### Resolution Priority (Per Endpoint)

```
1. endpointOverrides.start/end (if provided) → direct override wins
2. frameOverrides.get(anchor.id) (if anchored) → shape is transforming
3. Y.map stored data → default
```

### Mental Model: Canonical vs Dynamic Data

Think of connector endpoints as having two possible states:

- **Canonical (stored):** The Y.map data is trustworthy and stable
- **Dynamic (overridden):** The endpoint is actively being transformed

The override pattern exploits this: when dragging one endpoint, the **other endpoint is canonical**. When transforming a shape, only **anchors to that shape are dynamic**.

### Usage Patterns

**Shape Transform (translate/resize):**

```typescript
// User dragging selected shapes
const frameOverrides = new Map(
  selectedIds.map(id => [id, computeNewFrame(id, transform)])
);

for (const connectorId of getAffectedConnectors(selectedIds)) {
  const points = rerouteConnector(connectorId, frameOverrides);
  if (points) previewRoutes.set(connectorId, points);
}
```

**Endpoint Drag (reconnection):**

```typescript
// User dragging connector endpoint to reconnect
const snap = findBestSnapTarget(snapCtx);
const points = rerouteConnector(connectorId, undefined, {
  end: snap ?? [worldX, worldY]  // SnapTarget or free position
});
```

**Free Endpoint Translation:**

```typescript
// Moving an unanchored endpoint
const currentEnd = getEnd(yMap);
const points = rerouteConnector(connectorId, undefined, {
  end: [currentEnd[0] + dx, currentEnd[1] + dy]
});
```

**Mixed (Shape + Endpoint Override):**

```typescript
// One end attached to moving shape, other end being dragged
const points = rerouteConnector(
  connectorId,
  new Map([[shapeId, newFrame]]),
  { end: [dragX, dragY] }
);
```

### Internal Flow

```typescript
function rerouteConnector(connectorId, frameOverrides, endpointOverrides) {
  // 1. Read connector data from Y.map
  const yMap = getConnectorYMap(connectorId);
  const storedStart = getStart(yMap);
  const startAnchor = getStartAnchor(yMap);
  // ...

  // 2. Resolve each endpoint
  const startResolved = resolveEndpoint('start', ...);
  const endResolved = resolveEndpoint('end', ...);

  // 3. Resolve directions based on anchor state
  const { startDir, endDir } = resolveDirections(startResolved, endResolved, strokeWidth);

  // 4. Call primitives-based routing
  return computeAStarRoute(
    startResolved.position, startDir,
    endResolved.position, endDir,
    startResolved.shapeBounds, endResolved.shapeBounds,
    strokeWidth
  ).points;
}
```

---

## Path Building (connector-paths.ts)

### Output Structure

```typescript
interface ConnectorPaths {
  polyline: Path2D;           // Main line (trimmed for arrows)
  startArrow: Path2D | null;  // Start cap triangle
  endArrow: Path2D | null;    // End cap triangle
}
```

### Main Entry

```typescript
function buildConnectorPaths(params: {
  points: [number, number][];
  strokeWidth: number;
  startCap: 'arrow' | 'none';
  endCap: 'arrow' | 'none';
}): ConnectorPaths
```

Used by both `object-cache.ts` (committed connectors) and `connector-preview.ts` (preview).

### Key Features

- **Rounded corners:** `buildRoundedPolylinePath()` uses `arcTo()` with clamped radius
- **Arrow scaling:** Length ≤ `segmentLength / 2` (Excalidraw approach)
- **Trim compensation:** Polyline trimmed to prevent overlap with arrow caps
- **Stroke offset:** Arrow tip pulled back by `roundingLineWidth / 2` for visual accuracy

---

## Y.Map Schema

```typescript
{
  id: string;
  kind: 'connector';
  points: [number, number][];       // Full routed path
  start: [number, number];          // Start endpoint position
  end: [number, number];            // End endpoint position
  startAnchor?: {                   // Only if anchored
    id: string;                     // Target shape ID
    side: Dir;                      // Edge direction
    anchor: [number, number];       // Normalized [0-1, 0-1]
  };
  endAnchor?: { ... };              // Same structure
  startCap: 'none' | 'arrow';
  endCap: 'none' | 'arrow';
  color, width, opacity, ownerId, createdAt
}
```

---

## Key Invariants

1. **Centerlines use actual edges** — Computed from raw bounds, not padded
2. **Dynamic AABBs share facing boundaries** — Both AABBs have same centerline on facing side
3. **Stubs are ON AABB boundaries** — Automatically land on centerlines
4. **Segment checking during A*** — No cell blocking at grid construction
5. **Directions resolved before routing** — RoutingContext receives final directions
6. **Normalized anchors are shape-agnostic** — `[0-1, 0-1]` + linear interpolation
7. **EDGE_CLEARANCE_W for endpoints** — 11 units, NOT the full approach offset
8. **Override patterns are orthogonal** — Frame and endpoint overrides compose cleanly

---

## Summary: Integration Points

| Task | API | Notes |
|------|-----|-------|
| Create new connector | `routeNewConnector()` | SnapTarget or [x,y] per endpoint |
| Reroute existing connector | `rerouteConnector()` | Reads Y.map, applies overrides |
| Find snap target | `findBestSnapTarget()` | Fill-aware, returns SnapTarget |
| Get connectors for shape | `getConnectorsForShape()` | O(1) reverse lookup |
| Build render paths | `buildConnectorPaths()` | Returns polyline + arrows |
| Apply anchor to new frame | `applyAnchorToFrame()` | For transforms |
| Resolve free→anchored direction | `resolveFreeStartDir()` | Complex spatial logic |
| Resolve anchored→free direction | `computeFreeEndDir()` | Primary axis + sign |
