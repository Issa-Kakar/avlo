# Connector Routing System v2 - Technical Reference

> **System Status:** Dual routing modes (elbow A* + straight point-to-point), full SelectTool integration via `rerouteConnector()`.

> **Maintenance note:** This is a system-level architectural overview, not a changelog. When updating after code changes, match the detail level of surrounding content — don't inflate coverage of your specific change at the expense of the big-picture pipeline flow and cache interactions that make this document useful.
## Overview

The connector routing system implements two routing modes: **orthogonal (elbow)** with A* Manhattan routing and obstacle avoidance, and **straight** with direct point-to-point lines. Elbow routes prefer centerlines between shapes and use dynamic bounding boxes. All logic branches on `ConnectorType` checks — elbow code paths are completely untouched by straight connector additions.

**Key Design Decisions:**

1. **Primitives-Based API** — Routing accepts 7 primitive values (positions, directions, `FrameTuple | null` per endpoint, stroke width).
2. **Centerline Routing** — Routes prefer the midpoint between facing shape sides.
3. **Dynamic Routing Bounds** — Bounds encode centerline knowledge; facing side = centerline.
4. **Segment Intersection** — A* checks segments against obstacles (no cell blocking).
5. **Normalized Anchors** — Shape-agnostic endpoint positions stored as `[0-1, 0-1]`.
6. **Override Patterns** — Clean separation between frame overrides and endpoint overrides.
7. **Connector Type Branching** — All straight logic gated on `connectorType` checks; elbow path is untouched.

---

## File Structure

```
client/src/core/connectors/
├── types.ts               # Dir, Bounds, SnapTarget (discriminated union), RoutingContext, Grid, ConnectorType, ConnectorCap
├── constants.ts           # SNAP_CONFIG, ROUTING_CONFIG, offset formulas, CENTER_SNAP_RADIUS_PX, STRAIGHT_INTERIOR_DEPTH_PX
├── shape-geometry.ts      # Pure shape math: rect/ellipse/diamond centers, edges, midpoints, nearest-edge, ray×shape intersection. Zero connector deps.
├── anchor-atoms.ts        # Anchor ↔ point math: anchorFramePoint, elbowAnchorPoint, isSameShape, anchorRecordFromSnap, getEndpointEdgePosition
├── connector-utils.ts     # Direction primitives, spatial relation, path simplify, bounds conversion, elbow direction resolution
├── snap.ts                # Shape snapping — per-type branch (elbow/straight) + shared probeEdgeSnap pipeline
├── routing-context.ts     # Centerlines, dynamic routing bounds, stubs, grid construction
├── routing-astar.ts       # A* pathfinding with segment-intersection obstacle checking
├── connector-paths.ts     # Path2D builders (polyline, arrows) for cache and preview
├── connector-lookup.ts    # Reverse map: shapeId → Set<connectorId>
└── reroute-connector.ts   # High-level routing: rerouteConnector + routeNewConnector + computeStraightRoute
```

There is no barrel — consumers import from specific files. `FrameTuple`, `Point`, and `StoredAnchor*` come from their canonical homes (`@/core/types/geometry`, `@/core/types/objects`).

---

## Primitives-Based Routing API

The routing layer accepts **7 primitive values**:

```typescript
computeAStarRoute(
  startPos: [number, number],         // 1. Start endpoint position
  startDir: Dir,                      // 2. Start outward direction
  endPos: [number, number],           // 3. End endpoint position
  endDir: Dir,                        // 4. End outward direction
  startShapeBounds: FrameTuple | null,// 5. Start shape bounds (null = free)
  endShapeBounds: FrameTuple | null,  // 6. End shape bounds (null = free)
  strokeWidth: number                 // 7. Connector stroke width
): RouteResult
```

**Why primitives?**

- `isAnchored` is **derived** from `bounds !== null` — no redundant state.
- Callers route with zero boilerplate — no wrapper objects.
- Routing depends on nothing from Y.map or commit-time fields.

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

**Required discriminated field** on every connector Y.Map. `ConnectorTool.commitConnector` always writes it. `getConnectorType(y)` defaults to `'elbow'` on read for graceful handling of stale data — but all new writes carry the explicit value.

### Interior vs Edge — Stored, Never Computed

Interior-ness (straight connectors only) is committed at snap time as `anchor.interior: boolean` on the stored anchor. The snap layer already knows — it ran `pointInsideShape(cursor, frame, shapeType)` to decide the branch. Downstream code never recomputes it from normalized coordinates (the old `isAnchorInterior(coord-only)` check was the root of a bug cluster: shape-agnostic, wrong for ellipses/diamonds).

**Consequence:** there is no `isAnchorInterior` function anymore. Consumers read `anchor.interior` (stored) or `snap.interior` / `snap.kind === 'straight'` (live). Elbow anchors have **no** `interior` field — they're always edge-anchored (incl. midpoints).

**Center snap** (`[0.5, 0.5]`): Special interior anchor with dedicated `CENTER_SNAP_RADIUS_PX: 12` and hysteresis (1.3× OUT threshold). Emitted as `StraightSnapTarget` with `isCenter: true`.

### Bounds vs FrameTuple

```typescript
// Edge-based representation (internal routing)
interface Bounds { left, top, right, bottom }

// Storage / external API — the canonical shape frame
type FrameTuple = [x, y, w, h];
```

Routing uses `Bounds` internally because edge-based math is cleaner:
- Centerline: `(a.right + b.left) / 2`
- Facing check: `a.right <= b.left`

Convert with `toBounds(frameTuple)` and `pointBounds(position)`.

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
  obstacles: FrameTuple[];      // Raw shape bounds for segment checking
}
```

**Critical insight:** `startBounds`/`endBounds` are **not** raw shape bounds — they're dynamic routing bounds with centerline and padding already baked in. This is what makes grid construction trivial. Straight connectors skip RoutingContext entirely — they use `computeStraightRoute()` with `ResolvedEndpoint` data directly.

---

## Routing Architecture

### High-Level Flow

```
computeAStarRoute(7 primitives)
    │
    └── createRoutingContext()
        ├── 1. Compute centerlines (from RAW bounds)
        ├── 2. Build dynamic routing bounds (centerline + padding on facing sides)
        ├── 3. Compute stubs (ON routing-bound edges)
        └── 4. Collect obstacles (raw shape bounds)
            │
            └── buildSimpleGrid(ctx)
                └── Add routing-bound edge lines + stub perpendiculars
                    │
                    └── astar(grid, startCell, goalCell, startDir, obstacles)
                        └── Segment intersection checking per move
                            │
                            └── Assemble: [startPos, ...A*path..., endPos]
                                └── simplifyOrthogonal() → remove collinear points
```

### Centerline Computation

Centerlines are computed from **raw bounds** (actual geometry, no padding) via a single per-axis helper, `computeAxisCenterline(aMax, bMin, isFreeToAnchored, offset)`. It returns `null` when the ranges overlap, when a Free→Anchored gap is smaller than the approach offset, or when the gap is ≤ `EDGE_CLEARANCE_W`. `computeCenterlines` calls the helper four times (X + Y, either order) and returns whichever result is non-null.

**Minimum gap check:** the `≤ EDGE_CLEARANCE_W` rule prevents stubs from landing between the endpoint and the shape edge — that would cause backwards routing.

### Dynamic Routing Bounds

The key innovation: routing bounds encode centerline knowledge in their edges.

**Three cases based on endpoint configuration:**

| Configuration | Behavior |
|---------------|----------|
| **Anchored→Free** | Full centerline merging — point's bounds collapse to the centerline on all axes |
| **Free→Anchored** | Facing-side logic — only facing sides get the centerline |
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

**Result:** When shapes face each other, their routing bounds share the centerline as a boundary. Grid lines naturally include this centerline, and A* finds paths through it.

### Stub Computation

Stubs are where A* actually starts and ends — at the intersection of:
- The anchor's fixed axis position (Y for E/W, X for N/S)
- The routing-bound edge in the outward direction

```typescript
switch (dir) {
  case 'E': return [bounds.right, anchorY];   // Right boundary, anchor's Y
  case 'W': return [bounds.left, anchorY];    // Left boundary, anchor's Y
  case 'S': return [anchorX, bounds.bottom];  // Anchor's X, bottom boundary
  case 'N': return [anchorX, bounds.top];     // Anchor's X, top boundary
}
```

**Result:** Stubs automatically land on centerlines when they exist, because the routing-bound edge IS the centerline for facing sides.

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
      if (segmentIntersectsFrame(current.cell, neighbor, obstacle)) continue;

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

**Edge intersection** (`computeShapeEdgeIntersection`, in `shape-geometry.ts`): Casts ray from interior anchor toward other endpoint, finds exit point on shape boundary. Supports rect/roundedRect (axis-aligned edges, smallest positive `t`), ellipse (quadratic parametric solve), diamond (Cramer's rule for ray-segment).

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

Four tiny functions. No classifiers, no re-derivation, no shape-type-aware math:

```typescript
// Raw frame point for a normalized anchor — no offset, sits on the frame (edge or interior).
anchorFramePoint(anchor: [number, number], frame: FrameTuple): [number, number];

// Elbow-only: frame point + EDGE_CLEARANCE_W along stored anchor.side.
// Stored side is authoritative — never re-derived from coords.
elbowAnchorPoint(anchor: StoredElbowAnchor, frame: FrameTuple): [number, number];

// True when two resolved endpoints point at the same shape (by shapeId).
isSameShape(a, b): boolean;

// Build the Y.Map anchor record for a snap target — shape matches connector type:
//   elbow   → { id, side, anchor }
//   straight→ { id, interior, anchor }
anchorRecordFromSnap(snap: SnapTarget): StoredAnchor;
```

**Key insight:** `EDGE_CLEARANCE_W` offset lives in the elbow path exclusively. Straight connectors never need it — `computeStraightRoute` applies its own pull-back via `applyPullBack`. The snap layer always emits `position` as the visual anchor point (no offset baked in); elbow routing applies the offset at resolve time.

**`getEndpointEdgePosition`** (in `anchor-atoms.ts`) uses `anchorFramePoint` — canonical "where does this endpoint's dot sit on the frame" accessor, always on the shape frame, never offset outward.

---

## Snapping System

### API

```typescript
function findBestSnapTarget(ctx: SnapContext): SnapTarget | null;

interface SnapContext {
  cursorWorld: [number, number];
  prevAttach: SnapTarget | null;   // Previous snap (for hysteresis)
  connectorType: ConnectorType;    // REQUIRED — top-level branch discriminator
}

// Discriminated union — callers branch on `snap.kind`.
type SnapTarget = ElbowSnapTarget | StraightSnapTarget;

interface ElbowSnapTarget {
  kind: 'elbow';
  shapeId: string;
  side: Dir;                       // Authoritative (shape-aware edge classification)
  normalizedAnchor: [number, number];
  isMidpoint: boolean;
  position: [number, number];      // Visual dot + pre-offset routing endpoint
  isInside: boolean;
}

interface StraightSnapTarget {
  kind: 'straight';
  shapeId: string;
  interior: boolean;               // Committed at snap time; never recomputed
  isCenter: boolean;               // Snapped to [0.5, 0.5]
  midpointSide: Dir | null;        // Edge-midpoint snap — for highlight + hysteresis
  normalizedAnchor: [number, number];
  position: [number, number];      // Visual dot + pre-pullback routing endpoint
  isInside: boolean;
}
```

`position` is the single visual + pre-offset point for both kinds. The old `edgePosition` is gone — routing owns its own offset/pullback per type (elbow: `+ EDGE_CLEARANCE_W * directionVector(side)` at resolve; straight: `applyPullBack` in `computeStraightRoute`).

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

### Snap Modes — two fully separate pipelines

`computeSnapForShape` branches at the top on `ctx.connectorType`. The two pipelines share nothing except the nearest-edge / nearest-midpoint helpers.

| Cursor Location | Elbow (`computeElbowSnap`) | Straight (`computeStraightSnap`) |
|---|---|---|
| Deep inside (> 35px / > 20px) | `forceElbowMidpoint` (nearest midpoint only) | `computeStraightInterior`: center → midpoint → clamped interior |
| Shallow inside or near edge | `tryElbowEdgeSnap`: edge + midpoint stickiness | `tryStraightEdgeSnap`: edge + midpoint stickiness |
| Outside snap radius | No snap | No snap |

**Dead-zone fix:** the edge-radius gate (`edgeSnap.dist > radii.edgeSnap`) now applies **only when the cursor is outside the shape** (`!isInside`). When shallow-inside, the nearest edge is always a valid target. Previously the gate rejected shallow-inside edges between 15–35px (elbow) / 15–20px (straight) deep, producing a "dead zone" where neither edge sliding nor force-midpoint fired.

**Straight interior mode:** when `insideDepth > STRAIGHT_INTERIOR_DEPTH_PX (20)`:
1. Center snap within `CENTER_SNAP_RADIUS_PX (12)` of shape center (hysteresis 1.3×) → `{ kind: 'straight', isCenter: true, interior: true, normalizedAnchor: [0.5, 0.5] }`.
2. Midpoint stickiness (hysteresis 16/16) → `{ interior: false, midpointSide: side }`.
3. Fallback → clamped interior anchor at cursor → `{ interior: true, midpointSide: null }`.

Elbow never enters interior mode — deep-inside cursors always pin to a midpoint.

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

`findNearestEdgePoint()` (in `shape-geometry.ts`) handles different geometries:

| Shape | Edge Detection |
|-------|---------------|
| Rect/RoundedRect | Simple edge projection |
| Ellipse | Closest point on perimeter via angle, side from quadrant |
| Diamond | Four diagonal edges mapped to N/E/S/W |

---

## Direction Resolution

> **Note:** Straight connectors skip direction resolution entirely — they have no A* routing or stubs that need directional seeding. All functions here are elbow-only.

All three functions share the primitive `directionFromDelta(dx, dy)` and the `spatialRelation(pos, frame, offset)` helper in `connector-utils.ts`.

### Free→Anchored: `resolveElbowFreeStartDir()`

Complex decision tree based on spatial relationship:

```typescript
resolveElbowFreeStartDir(fromPos, anchorEnd, strokeWidth): Dir
```

**Cases:**
1. **Inside full padding** — Escape outward or wrap toward target
2. **Same side as anchor** — Check sliver escape (private `computeElbowSliverEscape`), then go toward shape via `directionFromDelta`
3. **Opposite side + contained** — Wrap around shape
4. **Adjacent or clear** — Sliver escape or anchor direction

### Anchored→Free: `computeElbowFreeEndDir()`

Primary axis + sign — a one-liner over `directionFromDelta`:

```typescript
function computeElbowFreeEndDir(fromPos, toPos): Dir {
  return directionFromDelta(toPos[0] - fromPos[0], toPos[1] - fromPos[1]);
}
```

### Drag Direction: `inferDragDirection()`

For live feedback during connector creation (used by elbow and straight drag previews):

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

Both `resolveEndpoint()` and `resolveNewEndpoint()` produce this. `frame` doubles as the elbow-routing shape-bounds input (no duplicate `shapeBounds` field).

```typescript
interface ResolvedEndpoint {
  position: [number, number];
  dir: Dir | null;
  isAnchored: boolean;
  // Populated for anchored endpoints (both connector types)
  normalizedAnchor?: [number, number];
  shapeType?: string;
  frame?: FrameTuple;              // Passed to elbow A* as start/endShapeBounds
  shapeId?: string;                // Enables same-shape detection
  interior?: boolean;              // Straight-only: committed at snap time
}
```

### NewRouteResult

Returned by `routeNewConnector()`:

```typescript
interface NewRouteResult {
  points: [number, number][];
}
```

Dashed guides for interior straight anchors are rendered directly from `snap` by `connector-preview.ts` and `selection-overlay.ts` (`snap.kind === 'straight' && snap.interior` → draw from `points[0 | -1]` to `snap.position`). No dash metadata is threaded through the route result.

### Internal Flow

```typescript
function rerouteConnector(connectorId, endpointOverrides) {
  // 1. Read connector data from Y.map
  // 2. Resolve each endpoint via resolveEndpoint() →
  //    - free → FREE_ENDPOINT
  //    - stored / frame override → buildAnchoredByType()
  //    - snap override → buildElbowAnchored / buildStraightAnchored directly

  // 3. Branch on connector type
  const connectorType = getConnectorType(yMap);
  if (connectorType === 'straight') {
    const result = computeStraightRoute(startResolved, endResolved);
    return { points: result.points, bbox };
  }

  // 4. Elbow: resolve directions, then callAStar() wraps the 7-arg A* call
  const { startDir, endDir } = resolveElbowDirections(...);
  return { points: callAStar(startResolved, startDir, endResolved, endDir, strokeWidth).points, bbox };
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
- **`drawSnapFeedback(ctx, snap)`** — Full target feedback in one call: shape
  highlight + midpoint dots + straight-center dot + active anchor dot. Branches
  internally on `snap.kind` — active midpoint highlight uses `snap.side` (elbow)
  or `snap.midpointSide` (straight). When snap is the straight center, the
  center dot doubles as the active indicator and the anchor-position dot is
  skipped. Shared by `connector-preview.ts` (hover snap during creation) and
  `selection-overlay.ts` (endpoint drag).
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
  connectorType: 'elbow' | 'straight';  // REQUIRED — always written on new commits
  points: [number, number][];           // Full routed path
  start: [number, number];              // Start endpoint position
  end: [number, number];                // End endpoint position

  // Anchor shape is discriminated by `connectorType`:
  startAnchor?: StoredElbowAnchor | StoredStraightAnchor;
  endAnchor?:   StoredElbowAnchor | StoredStraightAnchor;

  startCap: 'none' | 'arrow';
  endCap:   'none' | 'arrow';
  color, width, ownerId, createdAt
}

interface StoredElbowAnchor {
  id: string;
  side: Dir;                // Authoritative; never re-derived at read time
  anchor: [number, number]; // Normalized [0-1, 0-1]
}

interface StoredStraightAnchor {
  id: string;
  interior: boolean;        // Committed at snap time; never recomputed
  anchor: [number, number];
}
```

Callers that need the narrowed shape cast via `connectorType` (the parent is the discriminator). `getConnectorType(y)` still defaults to `'elbow'` on read for stale data — but every new write carries the explicit value. Connectors render at opacity 1 — no `opacity` field is stored.

---

## Key Invariants

1. **Centerlines use actual edges** — Computed from raw bounds, not padded
2. **Dynamic routing bounds share facing edges** — Both endpoints' bounds have the same centerline on their facing side
3. **Stubs are ON routing-bound edges** — Automatically land on centerlines
4. **Segment checking during A*** — No cell blocking at grid construction
5. **Directions resolved before routing** — RoutingContext receives final directions
6. **Normalized anchors are shape-agnostic** — `[0-1, 0-1]` + linear interpolation
7. **EDGE_CLEARANCE_W for endpoints** — 11 units, applied ONLY by elbow routing (at resolve). Straight owns its own pull-back.
8. **Per-endpoint override** — `EndpointOverrideValue` covers free position, transformed frame, or live `SnapTarget` in one union
9. **Straight routing skips A*** — `computeStraightRoute` bypasses RoutingContext, grid, and direction resolution
10. **Interior-ness is stored, not computed** — Decided at snap time with shape-aware `pointInsideShape`. Never recomputed from normalized coordinates anywhere downstream.
11. **Elbow uses stored `side` directly** — `reroute-connector.ts` reads `anchor.side` / `snap.side`; there is no re-derivation from anchor coords.
12. **Same-shape interior goes direct** — No edge intersection when both endpoints share a shape
13. **Single paint atom** — Every connector stroke goes through `paintConnector` so committed render, transform preview, and in-flight preview share exactly one draw pass
14. **Edge-radius gate is outside-only** — Inside-but-shallow always allows edge snapping; no snap dead zones inside shapes.
15. **`SnapTarget` is a discriminated union** — `snap.kind` is the source of truth; consumers branch on it, never on field shape.

---

## Summary: Integration Points

| Task | API | Notes |
|------|-----|-------|
| Create new connector | `routeNewConnector()` | SnapTarget or [x,y] per endpoint |
| Reroute existing connector | `rerouteConnector()` | Reads Y.map, applies `EndpointOverrideValue` per side |
| Find snap target | `findBestSnapTarget()` | Fill-aware, returns discriminated `SnapTarget` |
| Get connectors for shape | `getConnectorsForShape()` | O(1) reverse lookup |
| Build render paths | `buildConnectorPaths()` | Returns polyline + arrows |
| Paint connector | `paintConnector()` | Shared draw atom (committed + preview) |
| Anchor → frame point | `anchorFramePoint()` | Raw point (no outward offset) |
| Elbow anchor → routing point | `elbowAnchorPoint()` | Raw + EDGE_CLEARANCE_W along stored `anchor.side` |
| Write anchor record from snap | `anchorRecordFromSnap()` | Per-kind Y.Map shape (elbow: side, straight: interior) |
| Resolve free→anchored direction | `resolveElbowFreeStartDir()` | Complex spatial logic (elbow only) |
| Resolve anchored→free direction | `computeElbowFreeEndDir()` | Primary axis + sign (elbow only) |
| Route straight connector | `computeStraightRoute()` | Pull-back + edge intersection + overlap safety |
| Check interior anchor | read `anchor.interior` (stored) or `snap.interior` (live) | Never recomputed from coords |
| Find shape edge exit | `computeShapeEdgeIntersection()` | Ray cast for interior anchors (rect/ellipse/diamond) |
