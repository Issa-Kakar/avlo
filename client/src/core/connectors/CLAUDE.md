# Connector Routing System v2 - Technical Reference

> **System Status:** Dual routing modes (elbow A* + straight point-to-point), full SelectTool integration via `rerouteConnector()`.

> **Maintenance note:** This is a system-level architectural overview, not a changelog. When updating after code changes, match the detail level of surrounding content — don't inflate coverage of your specific change at the expense of the big-picture pipeline flow and cache interactions that make this document useful.
## Overview

The connector routing system implements two routing modes: **orthogonal (elbow)** with A* Manhattan routing and obstacle avoidance, and **straight** with direct point-to-point lines. Elbow routes prefer centerlines between shapes and use dynamic bounding boxes. All logic branches on `ConnectorType` checks — elbow code paths are completely untouched by straight connector additions.

**Key Design Decisions:**

1. **Primitives-Based API** — Routing accepts 7 primitive values, not Terminal objects
2. **Centerline Routing** — Routes prefer the midpoint between facing shape sides
3. **Dynamic AABBs** — Routing bounds encode centerline knowledge in their boundaries
4. **Segment Intersection** — A* checks segments against obstacles (no cell blocking)
5. **Normalized Anchors** — Shape-agnostic endpoint positions stored as `[0-1, 0-1]`
6. **Override Patterns** — Clean separation between frame overrides and endpoint overrides
7. **Connector Type Branching** — All straight logic gated on `connectorType` checks, zero regression risk to elbow

---

## File Structure

```
client/src/core/connectors/
├── types.ts               # Dir, Bounds, AABB, SnapTarget, RoutingContext, Grid, ConnectorType, ConnectorCap, isAnchorInterior
├── constants.ts           # SNAP_CONFIG, ROUTING_CONFIG, offset formulas, CENTER_SNAP_RADIUS_PX, STRAIGHT_INTERIOR_DEPTH_PX
├── anchor-atoms.ts        # Anchor ↔ point math: anchorFramePoint, anchorOffsetPoint, sideFromAnchor, isSameShape
├── connector-utils.ts     # Shape midpoints, direction helpers, bounds conversion, direction resolution, getEndpointEdgePosition, computeShapeEdgeIntersection
├── snap.ts                # Shape snapping with fill-aware visual ordering, straight interior/center snap
├── routing-context.ts     # Centerlines, dynamic AABBs, stubs, grid construction
├── routing-astar.ts       # A* pathfinding with segment intersection checking
├── connector-paths.ts     # Path2D builders (polyline, arrows) for cache and preview
├── connector-lookup.ts    # Reverse map: shapeId → Set<connectorId>
├── reroute-connector.ts   # High-level routing: rerouteConnector + routeNewConnector + computeStraightRoute
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

### ConnectorType

```typescript
type ConnectorType = 'elbow' | 'straight';
```

Stored per-connector in Y.Map (`connectorType?: 'straight'` — absent means elbow). Read via `getConnectorType(y)` from `@avlo/shared`. Device-ui-store holds the default for new connectors.

### Interior Anchors

Straight connectors introduce a distinction: **edge anchors** (at least one normalized coordinate at 0 or 1) vs **interior anchors** (both strictly inside `(0, 1)`).

```typescript
const INTERIOR_EPS = 1e-6;
function isAnchorInterior(anchor: [number, number]): boolean {
  return anchor[0] > INTERIOR_EPS && anchor[0] < 1 - INTERIOR_EPS
      && anchor[1] > INTERIOR_EPS && anchor[1] < 1 - INTERIOR_EPS;
}
```

**Center snap** (`[0.5, 0.5]`): Special interior anchor with dedicated `CENTER_SNAP_RADIUS_PX: 12` and hysteresis (1.3× OUT threshold). Renders a center dot on the shape in snap UI.

**Used by:** `anchorOffsetPoint` (skip edge offset), `computeStraightRoute` (edge intersection vs pull-back), `computeSnapForShape` (depth gate), snap dot rendering (center dot), preview/overlay dashed guides.

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

**Critical insight:** `startBounds`/`endBounds` are **not** raw shape bounds — they're dynamic AABBs with centerline and padding already baked in. This is what makes grid construction trivial. Straight connectors skip RoutingContext entirely — they use `computeStraightRoute()` with `ResolvedEndpoint` data directly.

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
return { points: simplifyOrthogonal(fullPath) };
```

### Straight Routing (`computeStraightRoute`)

Straight connectors bypass the entire elbow pipeline. After endpoint resolution in `rerouteConnector()`:

```typescript
if (connectorType === 'straight') {
  const result = computeStraightRoute(startResolved, endResolved);
  return { points: result.points, bbox };
}
```

Skipped: direction resolution, RoutingContext, grid construction, A* pathfinding.

**Per-endpoint logic:**

| Endpoint State | Line Position | Dash Guide |
|---|---|---|
| Free (`!isAnchored`) | `position` as-is | None |
| Edge anchor | Pull-back toward other endpoint by `EDGE_CLEARANCE_W` | None |
| Interior anchor (same shape) | Raw position directly | None |
| Interior anchor (diff shape) | Edge intersection + pull-back | Dashed: interior → edge |

**Key offset difference from elbow:** Elbow applies `EDGE_CLEARANCE_W` outward (perpendicular to shape edge via `directionVector(side)`). Straight applies it as **pull-back along the connector line** toward the other endpoint. This ensures the arrow tip points directly at the edge.

**Same-shape detection:** Both endpoints interior on same shape (`start.shapeId === end.shapeId`) → skip edge intersection, direct line between raw positions. Prevents the "spinning clock" effect from opposing ray intersections on a convex shape.

**Overlap safety:** Validates visible segment isn't flipped (dot product ≤ 0) or collapsed (length < `EDGE_CLEARANCE_W`). Falls back to raw `[startRaw, endRaw]` if degenerate.

**Edge intersection** (`computeShapeEdgeIntersection`): Casts ray from interior anchor toward other endpoint, finds exit point on shape boundary. Supports rect/roundedRect (axis-aligned edges, smallest positive `t`), ellipse (quadratic parametric solve), diamond (Cramer's rule for ray-segment).

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

### Anchor ↔ Point Atoms (`anchor-atoms.ts`)

Anchor-to-point math lives in one small module so that a future `StoredAnchor.side`
removal is a zero-touch change at every call site:

```typescript
// Raw frame point for a normalized anchor — no offset, sits on the shape edge/interior.
anchorFramePoint(anchor: [number, number], frame: FrameTuple): [number, number];

// Same raw frame point + EDGE_CLEARANCE_W (11) pushed outward for edge anchors.
// Interior anchors return the raw point untouched — `computeStraightRoute` handles
// its own pull-back for the line endpoint.
anchorOffsetPoint(anchor: [number, number], frame: FrameTuple, shapeType: string): [number, number];

// Derive the outward Dir from a normalized anchor + frame + shape type.
// Edge anchors read the coordinate; interior anchors resolve via nearest midpoint.
sideFromAnchor(anchor: [number, number], frame: FrameTuple, shapeType: string): Dir;

// True when two resolved endpoints point at the same shape (by shapeId).
isSameShape(a, b): boolean;
```

**Key insight:** Only `EDGE_CLEARANCE_W` (11 units) is applied for edge anchors — not the full approach offset. Interior anchors (straight connectors) skip the offset entirely; `computeStraightRoute` computes its own pull-back offsets via `applyPullBack`.

**`getEndpointEdgePosition`** (in `connector-utils.ts`) uses `anchorFramePoint` and is the canonical "where does this endpoint's dot sit on the frame" accessor — always returns a point on the shape frame, never offset outward.

---

## Snapping System

### API

```typescript
function findBestSnapTarget(ctx: SnapContext): SnapTarget | null;

interface SnapContext {
  cursorWorld: [number, number];  // Cursor in world coords
  prevAttach: SnapTarget | null;   // Previous snap (for hysteresis)
  connectorType?: ConnectorType;   // Defaults to 'elbow' behavior
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

### Connectable Kinds

Snapping targets shapes, text, and code blocks (`kind === 'shape' || 'text' || 'code'`). Text and code blocks use derived frames (`getTextFrame`/`getCodeFrame`); both are treated as always-filled rects. The same kind/frame pattern is mirrored in `reroute-connector.ts` and `connector-utils.ts`.

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

| Cursor Location | Elbow | Straight |
|---|---|---|
| Deep inside (> 35px / > 20px) | Midpoints only | Center snap → midpoint → interior |
| Shallow inside or near edge | Edge sliding + midpoint stickiness | Edge sliding + midpoint stickiness |
| Outside snap radius | No snap | No snap |

**Straight interior mode (CASE 1a):** When cursor is deeply inside a shape (> `STRAIGHT_INTERIOR_DEPTH_PX: 20`), priority cascade:
1. **Center snap:** Cursor within `CENTER_SNAP_RADIUS_PX: 12` of shape center → `normalizedAnchor=[0.5, 0.5]`, hysteresis 1.3×
2. **Midpoint stickiness:** Same as edge case
3. **Interior anchor:** Fallback — `normalizedAnchor` clamped to `[0.01, 0.99]`, position at cursor

The smaller depth threshold (20 vs elbow's 35) preserves edge sliding when shallowly inside, since interior anchors are a valid destination for straight connectors.

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

> **Note:** Straight connectors skip direction resolution entirely — they have no A* routing or stubs that need directional seeding.

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

Three functions:
- **`rerouteConnector()`** — Existing connectors: reads Y.map, applies per-endpoint overrides, branches on `connectorType` (SelectTool)
- **`routeNewConnector(start, end, strokeWidth, connectorType, dragDir?)`** — New connectors: accepts `SnapTarget | [x,y]` per endpoint (ConnectorTool)
- **`computeStraightRoute(start, end)`** — Pure straight routing from two `ResolvedEndpoint`s (called by both above)

### Signature

```typescript
type EndpointOverrideValue =
  | SnapTarget               // Snap to shape edge (has shapeId)
  | [number, number]          // Free position override
  | { frame: FrameTuple };    // Reapply the stored anchor against a transformed frame

function rerouteConnector(
  connectorId: string,
  endpointOverrides?: { start?: EndpointOverrideValue; end?: EndpointOverrideValue },
): RerouteResult | null;
```

Each endpoint is resolved independently by `resolveEndpoint()` which dispatches
to one of three branches on the override's shape:

1. `[x, y]`                 → free position
2. `{ frame: FrameTuple }`  → re-anchor against a transformed frame (shape drag/resize)
3. `SnapTarget`             → snap-driven override (endpoint drag / new connector)

With no override, the endpoint falls back to the stored Y.map anchor (or the
stored raw position for free endpoints).

### Usage Patterns

**Shape Transform (translate/resize):**

```typescript
// User dragging selected shapes — pass the transformed frame per affected endpoint.
const newFrame = computeNewFrame(anchorShapeId, transform);
for (const connectorId of getAffectedConnectors(selectedIds)) {
  const points = rerouteConnector(connectorId, {
    start: { frame: newFrame },  // Only if connector's start is on the selected shape
    end: { frame: newFrame },    // Only if connector's end is on the selected shape
  });
}
```

**Endpoint Drag (reconnection):**

```typescript
// User dragging a connector endpoint to reconnect
const snap = findBestSnapTarget(snapCtx);
const points = rerouteConnector(connectorId, { end: snap ?? [worldX, worldY] });
```

**Free Endpoint Translation:**

```typescript
// Moving an unanchored endpoint
const currentEnd = getEnd(yMap);
const points = rerouteConnector(connectorId, {
  end: [currentEnd[0] + dx, currentEnd[1] + dy],
});
```

### Mental Model: Canonical vs Dynamic Data

Think of connector endpoints as having two possible states:

- **Canonical (stored):** The Y.map data is trustworthy and stable
- **Dynamic (overridden):** The endpoint is actively being transformed

The override pattern exploits this: when dragging one endpoint, the **other endpoint is canonical**. When transforming a shape, only **endpoints anchored to that shape are dynamic** — the caller passes the transformed frame for each affected side.

### ResolvedEndpoint

Both `resolveEndpoint()` and `resolveNewEndpoint()` produce this. Straight-specific fields populated when anchored:

```typescript
interface ResolvedEndpoint {
  position: [number, number];
  dir: Dir | null;
  shapeBounds: AABB | null;
  isAnchored: boolean;
  // Straight connector fields (populated when anchored)
  normalizedAnchor?: [number, number];
  shapeType?: string;
  frame?: FrameTuple;
  shapeId?: string;              // Enables same-shape detection
}
```

### NewRouteResult

Returned by `routeNewConnector()`:

```typescript
interface NewRouteResult {
  points: [number, number][];
  startDashTo: [number, number] | null;  // Legacy: interior anchor frame point
  endDashTo: [number, number] | null;    // Legacy: interior anchor frame point
}
```

For elbow connectors, `startDashTo`/`endDashTo` are always `null`. For straight connectors, `computeStraightRoute` still populates them, but **the preview no longer consumes these fields** — `ConnectorPreview` carries `fromSnap`/`hoverSnap`, and `connector-preview.ts` derives dashed guides from `snap.edgePosition` + `isAnchorInterior`. The dash fields remain only for compat during the refactor and are slated for removal.

### Internal Flow

```typescript
function rerouteConnector(connectorId, endpointOverrides) {
  // 1. Read connector data from Y.map
  // 2. Resolve each endpoint → ResolvedEndpoint via resolveEndpoint()
  //    (straight fields: normalizedAnchor, shapeType, frame, shapeId)

  // 3. Branch on connector type
  const connectorType = getConnectorType(yMap);
  if (connectorType === 'straight') {
    const result = computeStraightRoute(startResolved, endResolved);
    return { points: result.points, bbox };
  }

  // 4. Elbow: resolve directions + A* routing
  const { startDir, endDir } = resolveDirections(...);
  return { points: computeAStarRoute(...).points, bbox };
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

Used by `object-cache.ts` (committed connectors) and `connector-preview.ts` (preview). The resulting `ConnectorPaths` is handed to `paintConnector()` in `renderer/layers/connector-render-atoms.ts` for the actual stroke/fill — see the Rendering Atoms section below.

### Key Features

- **Rounded corners:** `buildRoundedPolylinePath()` uses `arcTo()` with clamped radius
- **Arrow scaling:** Length ≤ `segmentLength / 2` (Excalidraw approach)
- **Trim compensation:** Polyline trimmed to prevent overlap with arrow caps
- **Stroke offset:** Arrow tip pulled back by `roundingLineWidth / 2` for visual accuracy

---

## Rendering Atoms (`renderer/layers/connector-render-atoms.ts`)

Canvas drawing for connectors lives in one module so the committed-render path,
the in-flight preview, and the selection overlay stay visually identical.

- **`paintConnector(ctx, paths, color, width)`** — Strokes the polyline
  + fills/strokes the arrow caps at the fixed `ARROW_ROUNDING_LINE_WIDTH`.
  Connectors always render at opacity 1, so no alpha param is threaded through.
  Shared by `objects.ts` (both `drawConnector` from cache and
  `drawConnectorFromPoints` for rerouted paths) and `connector-preview.ts`
  (via `buildConnectorPaths` at draw time).
- **`drawSnapFeedback(ctx, snap, isStraight)`** — Full target feedback in one
  call: shape highlight + midpoint dots + straight-center dot + active edge
  anchor dot. When snap is the straight center, the center dot doubles as the
  active indicator and the edge-position dot is skipped. Shared by
  `connector-preview.ts` (hover snap during creation) and `selection-overlay.ts`
  (endpoint drag).
- **Constant-styled decoration atoms** — `drawAnchorDot`,
  `drawConnectorDashGuide`, `drawSnapTargetHighlight`, `drawShapeMidpoints`,
  `drawStraightCenterDot`. No color/width/opacity params leak through; they
  pull sizing from `getAnchorDotMetricsWorld()` / `getGuideMetricsWorld()` so
  visual weight is scale-stable.
- **Helpers:** `isCenterSnap(snap)` and `resolveSnapContext(snap)` — the
  second resolves a snap to `{ handle, frame, shapeType }` via the bindable
  kinds set and `frameOf`.

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
  connectorType?: 'straight';       // Only stored when not 'elbow' (default)
  startCap: 'none' | 'arrow';
  endCap: 'none' | 'arrow';
  color, width, ownerId, createdAt
}
```
Connectors always render at opacity 1 — no `opacity` field is stored.

---

## Key Invariants

1. **Centerlines use actual edges** — Computed from raw bounds, not padded
2. **Dynamic AABBs share facing boundaries** — Both AABBs have same centerline on facing side
3. **Stubs are ON AABB boundaries** — Automatically land on centerlines
4. **Segment checking during A*** — No cell blocking at grid construction
5. **Directions resolved before routing** — RoutingContext receives final directions
6. **Normalized anchors are shape-agnostic** — `[0-1, 0-1]` + linear interpolation
7. **EDGE_CLEARANCE_W for endpoints** — 11 units, NOT the full approach offset
8. **Per-endpoint override** — `EndpointOverrideValue` covers free position, transformed frame, or live `SnapTarget` in one union
9. **Straight routing skips A*** — `computeStraightRoute` bypasses RoutingContext, grid, and direction resolution
10. **Interior anchors bypass edge offset** — `anchorOffsetPoint` returns the raw frame point for interior anchors; `computeStraightRoute` handles its own pull-back
11. **Same-shape interior goes direct** — No edge intersection when both endpoints share a shape
12. **Single paint atom** — Every connector stroke goes through `paintConnector` so committed render, transform preview, and in-flight preview share exactly one draw pass

---

## Summary: Integration Points

| Task | API | Notes |
|------|-----|-------|
| Create new connector | `routeNewConnector()` | SnapTarget or [x,y] per endpoint |
| Reroute existing connector | `rerouteConnector()` | Reads Y.map, applies `EndpointOverrideValue` per side |
| Find snap target | `findBestSnapTarget()` | Fill-aware, returns SnapTarget |
| Get connectors for shape | `getConnectorsForShape()` | O(1) reverse lookup |
| Build render paths | `buildConnectorPaths()` | Returns polyline + arrows |
| Paint connector | `paintConnector()` | Shared draw atom (committed + preview) |
| Anchor → frame point | `anchorFramePoint()` | Raw point (no outward offset) |
| Anchor → offset point | `anchorOffsetPoint()` | Adds EDGE_CLEARANCE_W for edge anchors; raw for interior |
| Anchor → side | `sideFromAnchor()` | Edge anchors read coord; interior uses nearest midpoint |
| Resolve free→anchored direction | `resolveFreeStartDir()` | Complex spatial logic (elbow only) |
| Resolve anchored→free direction | `computeFreeEndDir()` | Primary axis + sign (elbow only) |
| Route straight connector | `computeStraightRoute()` | Pull-back + edge intersection + overlap safety |
| Check interior anchor | `isAnchorInterior()` | Gates snap, routing, and rendering behavior |
| Find shape edge exit | `computeShapeEdgeIntersection()` | Ray cast for interior anchors (rect/ellipse/diamond) |
