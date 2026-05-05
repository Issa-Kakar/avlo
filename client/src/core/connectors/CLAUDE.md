# Connector Routing System — Technical Reference

> **Maintenance:** Architectural overview, not a changelog. Match surrounding detail level when updating — don't inflate coverage of one change at the expense of the big picture.

---

## Overview

Two routing modes, one front-end:

- **Elbow** — orthogonal A* over a sparse grid with centerline-seeded bounds.
  Endpoints carry a side-direction (`N/E/S/W`). Stable; rarely modified.
- **Straight** — direct point-to-point with per-endpoint pull-back and (for
  interior anchors) a ray-cast to the shape boundary.

The snap layer, endpoint resolver, connector-lookup, render atoms, and Y.Map
schema are shared. Divergence points:

| Concern | Elbow | Straight |
|---|---|---|
| Stored anchor shape | `{ id, anchor }` | `{ id, interior, anchor }` |
| Deep-inside snap | Nearest midpoint only | Center → midpoint → clamped interior |
| Endpoint direction | derived at route time via `projectAnchorToEdge` | `null` (not needed) |
| Endpoint offset | Cardinal (along projected `dir`), applied at resolve (`elbowAnchorPoint`) | Along-line pull-back, applied during route (`applyPullBack`) |
| Routing algorithm | A* over dynamic grid + obstacles | Two points, ray-cast for interior |

Routing is deterministic from Y.map + current shape frames — no persistent
route state; every reroute recomputes.

---

## File Map

Orient by task:

| Task | Files to read |
|------|---------------|
| Add a new shape kind to snap/route | `shape-geometry.ts` (`projectAnchorToEdge` + `rayShapeExitPoint` branches), `snap.ts` (bindable kinds via `BINDABLE_KINDS`) |
| Change snap behavior (thresholds, tiers) | `snap.ts`, `constants.ts` |
| Change how connectors reroute on shape transform | `reroute-connector.ts` (endpoint resolver) |
| Add a new connector type | Y.Map schema + `types.ts` + `snap.ts` branch + `reroute-connector.ts` branch |
| Change arrow / polyline rendering | `connector-paths.ts` + `renderer/layers/connector-render-atoms.ts` |
| Change routing heuristics / grid | `routing-context.ts`, `routing-astar.ts` |
| Fix jitter near midpoints | `snap.ts` hysteresis helpers |
| Fix interior anchor visuals | `connector-render-atoms.ts`, `connector-preview.ts` |

```
client/src/core/connectors/
├── types.ts              # Dir, Bounds, SnapTarget union, RoutingContext, Grid, AStarNode
├── constants.ts          # SNAP_CONFIG, ROUTING_CONFIG, GUIDE_CONFIG, bundle getters, EDGE_CLEARANCE_W
├── shape-geometry.ts     # projectAnchorToEdge (anchor → world edge + outward normal + Dir), rayShapeExitPoint, midpointFor
├── anchor-atoms.ts       # Anchor↔point: anchorFramePoint, elbowAnchorPoint(anchor, frame, dir), anchorRecordFromSnap
├── connector-utils.ts    # Direction primitives, spatialRelation, path simplify, elbow direction resolution
├── snap.ts               # findBestSnapTarget + two pipelines + shared edge probe
├── routing-context.ts    # Centerlines, dynamic routing bounds, stubs, grid construction
├── routing-astar.ts      # computeAStarRoute + A* with segment-intersection
├── connector-paths.ts    # Path2D builders (rounded polyline + arrows, trim compensation)
├── connector-lookup.ts   # Reverse map: shapeId → Set<connectorId>
├── reroute-connector.ts  # Endpoint resolution, straight route assembly, three reroute entry points + routeNewConnector
└── binary-heap.ts        # MinHeap used by A*
```

No barrel — import from specific files. `FrameTuple`, `Point`, and
`StoredAnchor*` come from `@/core/types/geometry` and `@/core/types/objects`.

Renderer glue: `renderer/layers/connector-render-atoms.ts` (paint + feedback),
`renderer/layers/connector-preview.ts` (in-flight preview).

---

## Y.Map Schema

```typescript
{
  id: string;
  kind: 'connector';
  connectorType: 'elbow' | 'straight';  // REQUIRED — always written on new commits
  points: [number, number][];           // Full routed path, render-ready
  start: [number, number];              // Stored endpoint position (fallback when free)
  end:   [number, number];

  startAnchor?: StoredElbowAnchor | StoredStraightAnchor;  // Shape tied to connectorType
  endAnchor?:   StoredElbowAnchor | StoredStraightAnchor;

  startCap: 'none' | 'arrow';
  endCap:   'none' | 'arrow';
  color, width, ownerId, createdAt
}

interface StoredElbowAnchor    { id: string;                    anchor: [number, number]; }
interface StoredStraightAnchor { id: string; interior: boolean; anchor: [number, number]; }
```

- **`connectorType` is the discriminator** for both anchor union branches and
  every routing decision downstream. `getConnectorType(y)` defaults to `'elbow'`
  on stale reads; every new write carries the explicit value.
- **Elbow `side` is *derived*** at route time from `(anchor + live frame +
  shapeType)` via `projectAnchorToEdge` — never persisted. Old Y.Maps may carry
  a `side` field; readers ignore it, writers omit it. Auto-corrects when the
  shape's aspect ratio or shape-type changes.
- **Straight `interior`** is committed at snap time (user intent — center vs
  edge). Cannot be reconstructed from the normalized anchor alone.
- **`anchor: [0-1, 0-1]`** is normalized into the shape's frame — resizes and
  moves reduce to linear interpolation, shape-agnostic.
- **`start` / `end` Y.Map fields stay** in this PR. They will fold into a
  `Point | StoredAnchor` union in the follow-up local-routing refactor.
- Connectors always render at opacity 1; no stored `opacity`.

---

## Core Types (snap-facing)

```typescript
type Dir = 'N' | 'E' | 'S' | 'W';
type ConnectorType = 'elbow' | 'straight';

type SnapTarget = ElbowSnapTarget | StraightSnapTarget;  // Discriminated by `kind`

interface ElbowSnapTarget {
  kind: 'elbow';
  shapeId: string;
  side: Dir;                        // Gesture-time UI hint (midpoint highlight + hysteresis); not persisted
  normalizedAnchor: [number, number];
  isMidpoint: boolean;
  position: [number, number];       // Visual dot + pre-offset routing endpoint
  isInside: boolean;
}

interface StraightSnapTarget {
  kind: 'straight';
  shapeId: string;
  interior: boolean;                // Committed at snap time
  isCenter: boolean;                // [0.5, 0.5] — drives center dot
  midpointSide: Dir | null;         // Non-null when snapped to an edge midpoint
  normalizedAnchor: [number, number];
  position: [number, number];
  isInside: boolean;
}

interface SnapContext { cursorWorld: Point; prevAttach: SnapTarget | null; connectorType: ConnectorType; }
```

`position` is always the **un-offset** visual dot; per-type offset (elbow's
perpendicular `EDGE_CLEARANCE_W`, straight's along-line pull-back) happens in
routing, not in snap.

---

## Snapping

```typescript
findBestSnapTarget(ctx: SnapContext): SnapTarget | null
```

Uses `pickTopmostBindable` (from `core/spatial/object-query`) to iterate
candidates in Z-order (top-most first) and defers shape-aware decisions to
`computeSnapForShape`. **Connectable kinds** = `shape`, `text`, `code` (via
`BINDABLE_KINDS`); text/code use derived frames and are treated as filled
rects.

### Fill-aware visual ordering

Baked into `pickTopmostBindable`:

1. Filled shape interior → occluding; snap to it or reject, stop scanning.
2. Unfilled shape interior → transparent; remember as innermost, keep scanning.
3. Edge region → always a valid snap target regardless of fill.

Result: nested unfilled shapes snap to the innermost shape under the cursor.

### Two pipelines, shared edge probe

`computeSnapForShape` branches on `ctx.connectorType`:

| Cursor position | Elbow (`computeElbowSnap`) | Straight (`computeStraightSnap`) |
|---|---|---|
| Outside snap radius | no snap | no snap |
| Near edge (outside or shallow-inside) | `tryElbowEdgeSnap` → edge + midpoint hysteresis | `tryStraightEdgeSnap` → edge + midpoint hysteresis |
| Deep inside | `forceElbowMidpoint` (nearest midpoint) | `computeStraightInterior` (center → midpoint → clamped) |

Both call `probeEdgeSnap` for the edge-finding + hysteresis logic. The
depth threshold differs — `FORCE_MIDPOINT_DEPTH_PX = 35` for elbow,
`STRAIGHT_INTERIOR_DEPTH_PX = 20` for straight.

**Dead-zone guarantee.** The edge-radius gate (`edgeSnap.dist > radii.edgeSnap`)
applies **only when the cursor is outside the shape**. Shallow-inside
(`isInside && depth < depthThreshold`) always permits edge sliding.

### Straight interior (three-tier)

When `insideDepth > STRAIGHT_INTERIOR_DEPTH_PX`:

1. **Center snap** — `centerDist ≤ CENTER_SNAP_RADIUS_PX (12)` (with 1.3×
   unstick hysteresis once active) → `{ isCenter: true, interior: true,
   normalizedAnchor: [0.5, 0.5] }`. The only deliberate path to exact center.
2. **Midpoint stickiness** — within 16px of an edge midpoint → snap there
   with `midpointSide: Dir`, `interior: false` (it's an edge anchor on the
   shape boundary, not interior).
3. **Clamped interior** — cursor becomes the anchor, normalized coords clamped
   to `[0.01, 0.99]` per axis (avoids sitting exactly on corners).
   `interior: true, isCenter: false, midpointSide: null`.

Elbow never enters interior mode.

### Hysteresis + Ctrl

- **Edge snap in** at 15px (outside only), **midpoint in/out** at 16/16px
  (sticky; same threshold).
- **Center snap** at 12px, unstick at 15.6px (1.3×) once already centered.
- **Ctrl held** → `isCtrlHeld()` from `cursor-tracking.ts` forces `snap = null`
  before every `findBestSnapTarget` call. Live state, updates on every pointer
  event — releasing mid-drag resumes snapping instantly.

### Thresholds (world units at 1× scale; bundled via `getSnapRadiiWorld()`)

| Constant | Value | Use |
|---|---|---|
| `EDGE_SNAP_RADIUS_PX` | 15 | outside-shape edge gate |
| `MIDPOINT_SNAP_IN_PX` / `MIDPOINT_SNAP_OUT_PX` | 16 / 16 | midpoint hysteresis |
| `FORCE_MIDPOINT_DEPTH_PX` | 35 | elbow-only "lock to midpoint" depth |
| `STRAIGHT_INTERIOR_DEPTH_PX` | 20 | straight-only interior mode depth |
| `CENTER_SNAP_RADIUS_PX` | 12 | straight-only [0.5, 0.5] snap |
| `EDGE_CLEARANCE_W` | 11 | world-unit clearance used by both route paths |

---

## Endpoint Resolution

Two parallel pipelines (elbow + straight) share a single Y.Map fetch
(`readContext`). Each public entry reads `connectorType` once, branches once,
dispatches to a type-specific path, and never sees the type again. Each
pipeline operates on its own discriminated-union endpoint type carrying only
the fields it uses — no shared `ResolvedEndpoint`, no optional fields, no
defensive nullability.

```
rerouteConnectorEndpointDrag(id, endpoint, override)        // SelectTool
rerouteConnectorTransform(id, startOverride, endOverride)   // connector-topology
rerouteConnectorCanonical(id)                                // future "update affected"
routeNewConnector(start, end, strokeWidth, type)             // ConnectorTool
```

### Override unions (per entry point)

```typescript
type FrameOverride        = { frame: FrameTuple };           // anchor reapplied against transformed frame
type TransformOverride    = FrameOverride | Point;           // null = canonical (read Y.Map)
type EndpointDragOverride = SnapTarget | Point;              // SelectTool drag side
```

`TransformOverride` carries no `SnapTarget` branch — transform paths never
feed snap. `EndpointDragOverride` carries no `FrameOverride` branch — only
shape transforms reapply frames.

**Read-only contract, aliased endpoints.** Frame overrides are read-only
(`anchorFramePoint` / `elbowAnchorPoint` allocate fresh position tuples).
The resulting route's `points[0]` / `points[points.length-1]` may *alias*
a `Point` free-position override — the elbow A* path emits
`[startPos, ...cells, endPos]` (start/end pushed as fresh tuples) and the
straight path clones the visible endpoints. But **inputs to reroute may be
the result of a prior call** if a caller passes its own scratch buffer; the
guarantee is the call clones inputs into the result, not that inputs are
distinct from past outputs. Consequences for callers:
- A scratch tuple used as a free-position override **must not** be shared
  across multiple reroute calls within one apply pass — see
  `connector-topology.ts` `FreeSide.scratch` (per-side, not module-shared).
- Callers persisting the route to Y.Map **must** clone `points[0]` and
  `points[last]` before writing `start` / `end` (Y.Map preserves references,
  so an un-cloned write resurfaces as the next gesture's "stored position").

**Synchronous-only contract.** The reroute pipeline owns module scratches in
`reroute-connector.ts`, `routing-context.ts`, and `routing-astar.ts`. Callers
must not invoke any reroute entry recursively (e.g. from inside an A* hop or a
Y.Doc observer reentry). The full route is synchronous; A* never re-enters
reroute, and Y.Doc observers don't run inside `transact()`.

### Internal endpoint types

```typescript
// Elbow: position + cardinal direction + frame (also fed to A* as obstacle bounds).
type ElbowEndpoint =
  | { kind: 'free'; pos: Point }
  | { kind: 'anchored'; pos: Point; dir: Dir; frame: FrameTuple };

// Straight: three states. shapeType + shapeId + frame appear ONLY on `interior`,
// where they're needed for ray-cast and the same-shape short-circuit. The `edge`
// variant carries only `pos` — pull-back doesn't need anything else.
type StraightEndpoint =
  | { kind: 'free'; pos: Point }
  | { kind: 'edge'; pos: Point }
  | { kind: 'interior'; pos: Point; frame: FrameTuple; shapeType: string; shapeId: string };
```

What disappeared from the prior `ResolvedEndpoint`: `dir` on straight (was
always `null`), `shapeId` on elbow (unused post-construction), `interior?` on
elbow, `normalizedAnchor` everywhere (dead — written, never read), and the
`isAnchored` boolean discriminator (replaced by `kind`). All optional fields
are gone — every present field is required for its variant. TypeScript
narrowing on `kind` proves invariants the old shape required runtime guards
to express (`if (!me.isAnchored || !me.normalizedAnchor || !me.frame)` →
`me.kind === 'interior'`).

### Factories (one per pipeline)

- `buildElbowAnchored(frame, shapeType, anchor)` — calls
  `projectAnchorToEdge(anchor, frame, shapeType, …)` to derive `dir`, then
  `elbowAnchorPoint(anchor, frame, dir)` for position (cardinal `EDGE_CLEARANCE_W`).
  Returns `{ kind: 'anchored', pos, dir, frame }`.
- `buildStraightAnchored(frame, shapeType, anchor, interior, shapeId)` —
  position = `anchorFramePoint(anchor, frame)` (no offset). Branches on
  `interior` → `{ kind: 'interior', pos, frame, shapeType, shapeId }` or
  `{ kind: 'edge', pos }`.

### Resolvers (per pipeline, all `connectorType`-free)

Each pipeline exposes:
- `resolveXxxSide(override, anchor, storedPos)` — handles transform overrides
  AND canonical (`override === null` reads frame from `getHandle(anchor.id)`;
  `Point` override = free; `FrameOverride` reapplies anchor on the supplied frame).
- `resolveXxxFromSnapOrPoint(input)` — shared by SelectTool drag and
  `routeNewConnector`. `Point` input = free; `SnapTarget` input → factory.

The straight side casts `anchor as StoredStraightAnchor` once at the boundary
— the parent connector's `connectorType` discriminates the union, so the cast
is sound and isolated.

### Canonical vs dynamic (mental model)

Each endpoint is either **canonical** (stored Y.map data is stable) or
**dynamic** (actively being transformed). The override pattern exploits this:

- Dragging one endpoint → the other is canonical (no override).
- Translating/resizing a shape → only endpoints anchored to that shape are
  dynamic; pass `{ frame: newFrame }` per affected side, no snap calculation
  needed.

### Call patterns

```typescript
// Shape transform (iterate affected connectors per shape):
rerouteConnectorTransform(cid,
  startOv,    // FrameOverride | Point | null  (null = canonical)
  endOv,
);

// Endpoint drag (reconnection — SelectTool):
const snap = findBestSnapTarget(snapCtx);
rerouteConnectorEndpointDrag(cid, endpoint, snap ?? [worldX, worldY]);

// Trust Y.Map entirely (future "update affected connectors"):
rerouteConnectorCanonical(cid);
```

---

## Straight Routing

Bypasses the elbow pipeline entirely — no RoutingContext, no grid, no A*, no
direction resolution. `computeStraightRoute(start, end)` returns a two-point
array.

### Per-endpoint logic (`resolveStraightVisibleEndpoint`)

Called symmetrically for each side, writing into a module scratch
(`STRAIGHT_PT_START` / `STRAIGHT_PT_END`). The same-shape interior pair is
intercepted at the route level (next section), so this function never sees it
— three explicit cases over `me.kind`:

| `me.kind` | Result written into `out` |
|---|---|
| `free` | `me.pos` copied |
| `edge` | `applyPullBackInto(out, me.pos, otherPos)` — EDGE_CLEARANCE_W along the line |
| `interior` | ray-cast exit + `applyPullBackInto` (via `STRAIGHT_RAY_DIR` / `STRAIGHT_RAY_EXIT` scratches) |

For straight endpoints, `me.pos` IS the un-offset `anchorFramePoint`
(`buildStraightAnchored` writes it; no offset). It's also the source of the
dashed guide for interior anchors. `STRAIGHT_RAY_DIR` / `STRAIGHT_RAY_EXIT`
are reused sequentially per side — never aliased into the result.

### Same-shape short-circuit (pair-level, in `computeStraightRoute`)

When `start.kind === 'interior' && end.kind === 'interior' && start.shapeId
=== end.shapeId`, return `[start.pos, end.pos]` directly. Ray-casting two
interior points on one convex shape produces opposing intersections (the
"spinning clock" artifact). The check lives at the route level because it's
a property of the **pair**, not a per-side concern — extracting it lets each
per-side branch operate on a clean three-case `kind` switch.

### Edge intersection (`rayShapeExitPoint`)

Ray from interior anchor toward the other endpoint's raw position; writes the
exit point on the shape boundary into a caller-owned scratch tuple; returns
`true` on success. Dispatches on shapeType:

- **rect / roundedRect** — axis-aligned slab per edge, smallest positive `t`.
- **ellipse** — parametric quadratic.
- **diamond** — Cramer's rule across the 4 diagonal segments.

The cardinal side isn't returned (callers don't need it); they apply
`EDGE_CLEARANCE_W` pull-back along the line afterward, which is direction-
agnostic.

### Overlap safety

With `rawDelta = endRaw - startRaw` and `visDelta = endPt - startPt`, fall
back to `[startRaw, endRaw]` when either:

- `visDelta · rawDelta ≤ 0` (pull-back or intersection flipped the line)
- `|visDelta| < EDGE_CLEARANCE_W` (segment collapsed)

Happens with overlapping shapes or small shapes where clearance exceeds the
available gap.

### Dashed guides (render-side only)

For interior straight anchors, the preview + overlay layers render a dashed
guide from `snap.position` (raw frame point) to the polyline endpoint
(pulled-back line end). Dash metadata is **not** threaded through route
results — it's computed directly from
`snap.kind === 'straight' && snap.interior` by `connector-preview.ts` and
`selection-overlay.ts` via `drawConnectorDashGuide`.

---

## Elbow Routing

`computeAStarRoute(startPos, startDir, endPos, endDir, startFrame, endFrame, strokeWidth)`.
Primitive API: `isAnchored` is derived from `frame !== null`; no wrapper
objects.

### Pipeline

```
computeAStarRoute
  ├── fillRoutingContext (all spatial intelligence; writes into module scratches)
  │     ├── centerlines from RAW bounds, per-axis
  │     ├── dynamic routing bounds (facing-side = centerline, non-facing padded)
  │     ├── stubs on routing-bound edges at each anchor's fixed axis
  │     └── obstacles (raw shape bounds, deduped when start===end)
  ├── fillSimpleGrid (sort-then-unique into pre-allocated xLines/yLines)
  ├── astar (index-based: typed arrays + generation counter, segment-intersection
  │          checks per move, bend penalty, no U-turns)
  └── emit final Point[] with inline collinear simplification
```

### RoutingContext (the single trick)

Dynamic routing bounds **encode centerline knowledge in their edges**: when
two shapes face each other, both bounds share the centerline as their facing
edge. Grid lines from bound edges automatically include the centerline, so A*
routes through it without special casing.

Three configurations handled by `buildRoutingBounds`:

| Endpoint pair | Bounds |
|---|---|
| Anchored → Free point | Free point's bounds collapse to centerline on all axes (WYSIWYG: path identical whether stopping free or snapping). |
| Free point → Anchored | Facing-side only gets centerline; non-facing stays at raw point position (so the first segment escapes in the seeded axis rather than collapsing). |
| Shape → Shape | Facing side = centerline if it exists; non-facing = raw ± approach-offset. |

**Centerline computation** (`computeAxisCenterline`): returns `null` when
ranges overlap, when a Free→Anchored gap is below the approach offset (stub
would land behind start), or when the gap is ≤ `EDGE_CLEARANCE_W` (too
tight to route through). Approach offset = `CORNER_RADIUS_W + arrowLength + EDGE_CLEARANCE_W`.

**Stubs** sit at `(routing-bound edge, anchor's fixed axis)` — so they
automatically land on centerlines when those exist.

### A* specifics

- **Index-based, zero-alloc.** Cells are addressed by `yi * xStride + xi`
  (no `GridCell` objects). All A* state lives in module-pool typed arrays:
  cell-keyed (`closedGen`/`gScoreGen`/`gScores`, `Uint32Array`/`Float32Array`,
  `MAX_CELLS = 64`) and node-keyed (`fScores`/`parentNode`/`arrivalDir`/
  `nodeCell`, `MAX_NODES = 256`). A `Uint32` generation counter (`astarGen`)
  is bumped per call — "clear before use" becomes a single increment, not N
  writes.
- **Heap stores node indices.** `MinHeap<number>` reused across calls
  (`.clear()` at start), comparator reads `fScores[idx]`. Manual swap inside
  the heap (no destructuring allocation).
- Priority sorted by `f = g + h`, Manhattan heuristic. Cardinal directions
  encoded as `0..3` (`DIR_N` / `DIR_E` / `DIR_S` / `DIR_W`); `OPPOSITE_INT`
  table avoids the `Dir` string ↔ string lookup hot path.
- **No cell blocking** during grid construction. Obstacles are checked per
  segment via `segmentIntersectsFrame` (slab method) — handles thin shapes
  and arbitrary segment directions.
- `cost = Manhattan + BEND_PENALTY (1000)` on direction changes; backwards
  moves are skipped (no U-turns).
- Start node seeded with `arrivalDir = startDir` so the first move respects
  the shape side.
- **Path reconstruction** walks parent indices forward into `pathCells`
  (`Int32Array(MAX_NODES)`); caller iterates in reverse during emission. No
  intermediate `fullPath` array; collinear simplification folds inline via
  `pushOrMerge` while writing the final `Point[]`.
- **Final `Point[]` is the only allocation per route.** Each emitted vertex is
  a fresh `[x, y]`; the result array is fresh.
- **Fallbacks**: no path with obstacles → recurse with `EMPTY_OBSTACLES`
  (recursion bumps `astarGen` and resets the node pool); still nothing →
  return `[startPos, endPos]` direct line.
- **Pool exhaustion** is dev-mode warned (`MAX_CELLS` / `MAX_NODES`); raise
  caps if the warning fires under realistic gestures.

### Direction resolution (elbow only)

In `resolveElbowDirections`:

- **Anchored → Anchored** — both `dir`s are stored `side`s. Nothing to compute.
- **Free → Anchored** — `resolveElbowFreeStartDir(fromPos, anchorEnd, strokeWidth)`.
  Four-case decision tree over `spatialRelation`: inside full padding (escape
  outward or wrap toward target), same side (L-route with sliver-escape
  check), opposite + contained (wrap via shape center), adjacent (sliver
  escape or anchor direction). This is the one function doing heavy spatial
  reasoning in the elbow path.
- **Anchored → Free** — `computeElbowFreeEndDir(fromPos, toPos)`, one-liner
  over `directionFromDelta` (primary axis + sign).

---

## Public Entry Points

```typescript
// SelectTool endpoint drag — one side overridden, the other reads Y.Map.
rerouteConnectorEndpointDrag(
  connectorId: string,
  endpoint: 'start' | 'end',
  override: SnapTarget | Point,                    // EndpointDragOverride
): RerouteResult | null;                           // { points, bbox }

// connector-topology transforms — per-side FrameOverride | Point | null.
rerouteConnectorTransform(
  connectorId: string,
  startOverride: FrameOverride | Point | null,
  endOverride:   FrameOverride | Point | null,
): RerouteResult | null;

// Trust Y.Map (future "update affected connectors") — wrapper over Transform.
rerouteConnectorCanonical(connectorId: string): RerouteResult | null;

// Route new — no Y.map; same resolver + routing pipeline. (ConnectorTool.)
routeNewConnector(
  start: SnapTarget | Point,
  end:   SnapTarget | Point,
  strokeWidth: number,
  connectorType?: ConnectorType,                   // default 'elbow'
): NewRouteResult;                                 // { points }
```

Internal flow — each public entry reads `ctx = readContext(connectorId)` once
(shared Y.Map fetch — schema doesn't fork by type), then branches on
`ctx.connectorType` exactly once and dispatches to a per-pipeline private:

```typescript
export function rerouteConnectorTransform(connectorId, startOverride, endOverride) {
  const ctx = readContext(connectorId);
  if (!ctx) return null;
  return ctx.connectorType === 'straight'
    ? rerouteStraightTransform(ctx, startOverride, endOverride)
    : rerouteElbowTransform(ctx, startOverride, endOverride);
}

function rerouteElbowTransform(ctx, sOv, eOv) {
  const start = resolveElbowSide(sOv, ctx.startAnchor, ctx.storedStart);
  const end   = resolveElbowSide(eOv, ctx.endAnchor,   ctx.storedEnd);
  const { points } = computeElbowRoute(start, end, ctx.strokeWidth);
  return { points, bbox: computeConnectorBBoxFromPoints(points, ctx.yMap) };
}
// rerouteStraightTransform symmetric. Drag + canonical follow the same shape.
```

`connectorType` lives only in `ConnectorContext` (the `readContext` output) and
is never threaded into resolvers, factories, or route assemblers — every
internal function operates on `ElbowEndpoint` xor `StraightEndpoint`, and the
type itself encodes which pipeline you're in.

BBox for `RerouteResult` comes from `computeConnectorBBoxFromPoints(points, yMap)`.

---

## Anchor Atoms (`anchor-atoms.ts`)

The whole anchor-math surface — five functions, no classifiers. Interior-ness
is a stored fact; elbow `dir` is supplied by the caller (derived via
`projectAnchorToEdge` at the route boundary).

```typescript
anchorFramePoint(anchor: Point, frame: FrameTuple): Point;
// Raw interpolation of [0-1, 0-1] into frame. No offset. Shared by both types.

elbowAnchorPoint(anchor: Point, frame: FrameTuple, dir: Dir): Point;
// Raw point + EDGE_CLEARANCE_W along directionVector(dir). Cardinal-aligned by
// design (A* needs orthogonal escape segments). Caller derives `dir` via
// projectAnchorToEdge at route time.

isSameShape(a, b): boolean;
// Both endpoints point at the same shapeId.

anchorRecordFromSnap(snap: SnapTarget): StoredAnchor;
// Elbow snap → { id, anchor };  straight snap → { id, interior, anchor }.

getEndpointEdgePosition(handle, endpoint: 'start' | 'end'): Point;
// "Where does this endpoint's dot sit?" — always the raw frame point.
```

---

## Connector Lookup (reverse map)

O(1) `shapeId → Set<connectorId>` for SelectTool transforms and EraserTool
deletions. Maintained incrementally by `RoomDocManager` observers.

| RoomDocManager event | Call |
|---|---|
| Construction | `initConnectorLookup()` |
| Hydrate | `hydrateConnectorLookup(objectsById)` |
| Connector add/update/delete | `processConnectorAdded/Updated/Deleted(id, yObj?)` |
| Shape delete | `processShapeDeleted(shapeId)` |
| Teardown | `clearConnectorLookup()` |

Self-loops (both endpoints → same shape) are deduped via `uniqueShapeIds`.
Query: `getConnectorsForShape(shapeId)`, re-exported from
`@/runtime/room-runtime`.

---

## Path Building (`connector-paths.ts`)

```typescript
buildConnectorPaths({ points, strokeWidth, startCap, endCap }): ConnectorPaths;
// { polyline: Path2D, startArrow: Path2D | null, endArrow: Path2D | null }
```

Implementation notes (rarely modified):

- **Rounded corners** via `arcTo()`; radius clamped to `min(CORNER_RADIUS_W (26), lenIn/2, lenOut/2)`. Sharp corner when the clamped radius falls below 2.
- **Arrow sizing** — `length = max(ARROW_MIN_LENGTH_W (6), strokeWidth * 3)`,
  capped at `segmentLength / 2` (Excalidraw approach); width = length × 1.0.
- **Polyline trim** before each arrow-capped end so the polyline doesn't poke
  through the triangle: `neededTrim = scaledLength + strokeWidth/2`, clamped
  by `segLen - actualCornerRadius`.
- **Tip stroke compensation** — arrow tip is pulled back by
  `ARROW_ROUNDING_LINE_WIDTH / 2 (5/2)` so the visible stroke-drawn tip lands
  at the endpoint.

Used by `object-cache.ts` (committed connectors, cached) and
`connector-preview.ts` (in-flight, rebuilt per frame). Both hand the result
to `paintConnector`.

---

## Render Atoms (`renderer/layers/connector-render-atoms.ts`)

All canvas drawing for connectors lives here so the committed render path,
transform preview, and in-flight preview stay visually identical.

| Atom | Purpose |
|---|---|
| `paintConnector(ctx, paths, color, width)` | Strokes polyline + fills/strokes arrow caps at `ARROW_ROUNDING_LINE_WIDTH`. Always opacity 1. Shared by `objects.ts` (`drawConnector` + `drawConnectorFromPoints`) and `connector-preview.ts`. |
| `drawSnapFeedback(ctx, snap)` | Full snap visualization: shape highlight + midpoint dots + (straight) center dot + active anchor dot. Branches on `snap.kind`; when `isCenterSnap`, center dot doubles as active and the anchor-position dot is skipped. Shared by preview + selection overlay. |
| `drawConnectorDashGuide(ctx, from, to)` | Interior straight guide. Only drawn for `snap.kind === 'straight' && snap.interior`. |
| `drawAnchorDot` / `drawSnapTargetHighlight` / `drawShapeMidpoints` / `drawStraightCenterDot` | Styling atoms; sizes come from `getAnchorDotMetricsWorld()` / `getGuideMetricsWorld()` — scale-stable. |
| `isCenterSnap(snap)` / `resolveSnapContext(snap)` | Helpers: center check; resolve `{ handle, frame, shapeType }` via `BINDABLE_KINDS` + `frameOf`. |

---

## Constants (`constants.ts`)

Two classes of constants, two accessor styles:

- **Screen-space (`_PX`)** — `SNAP_CONFIG`, `ANCHOR_DOT_CONFIG`, `GUIDE_CONFIG`.
  Materialized into world units per-call via bundle getters
  (`getSnapRadiiWorld`, `getAnchorDotMetricsWorld`, `getGuideMetricsWorld`).
  Each getter reads camera scale once and returns every relevant metric
  pre-divided. Call sites read the bundle once per function rather than
  threading `scale`.
- **World-space (`_W`)** — `ROUTING_CONFIG.CORNER_RADIUS_W`,
  `ARROW_MIN_LENGTH_W`, `EDGE_CLEARANCE_W`, `COST_CONFIG.BEND_PENALTY`.
  Permanent (stored in Y.Doc) — must not vary with zoom.

Derived helpers: `computeArrowLength(strokeWidth)`,
`computeArrowWidth(strokeWidth)`, `computeApproachOffset(strokeWidth) =
CORNER_RADIUS_W + arrowLength + EDGE_CLEARANCE_W`.

---

## Key Invariants

1. **`connectorType` is the authoritative branch.** Anchor shape, snap pipeline,
   and routing mode all follow from it. No field-shape inference.
2. **`SnapTarget` is a discriminated union.** Consumers branch on `snap.kind`.
3. **Interior-ness is stored, never recomputed.** Committed at snap time via
   shape-aware `pointInsideShape`. Normalized coords alone are insufficient.
4. **Elbow `side` is *derived*** at route time from `(anchor + live frame +
   shapeType)` via `projectAnchorToEdge`. **Not persisted.** The `side` on
   `ElbowSnapTarget` is a gesture-time UI hint, not authoritative.
5. **`position` is the pre-offset visual dot AND the pre-offset routing
   endpoint.** Per-type offset (elbow cardinal / straight along-line)
   runs in routing — the snap layer never bakes offsets into `position`.
6. **Same-shape interior goes direct** — no ray-cast; avoids opposing-ray
   intersections on convex shapes.
7. **Centerlines come from RAW bounds**; dynamic routing bounds then merge
   facing edges to those centerlines. Stubs on those edges land on the
   centerline automatically.
8. **A* checks segment intersection, not cell blocking.** The grid is sparse
   and unblocked; obstacle avoidance is per-move via slab intersection.
9. **Edge-radius gate is outside-only.** Shallow-inside (below the mode's
   depth threshold) always permits edge snapping — no dead zone.
10. **Single paint atom.** Every connector stroke goes through
    `paintConnector`, so committed render, transform preview, and in-flight
    preview share one draw pass.
11. **Two parallel reroute pipelines, one shared `readContext`.** Each public
    reroute (endpoint-drag, transform, canonical) accepts only the override
    shapes its caller actually produces; each branches on `ctx.connectorType`
    exactly once and dispatches to elbow or straight private internals.
    Internal helpers operate on `ElbowEndpoint` xor `StraightEndpoint` — the
    type encodes the pipeline. No drift risk; the topology hot path skips
    runtime override-shape discrimination it can't generate.
12. **`connectorType` is never threaded into internals.** It is read once (in
    `readContext`) and branched on once at the top of every public entry.
    Resolvers, factories, route assemblers, and per-side helpers operate on
    typed endpoint unions only.
13. **Module scratches are non-re-entrant.** `reroute-connector.ts`,
    `routing-context.ts`, and `routing-astar.ts` all hold module-level
    scratches (point projections, bounds, grid lines, A* state). The reroute
    pipeline is synchronous; callers must not invoke it recursively.
14. **Final route Point[] is the only allocation in the elbow path.** All
    other arrays (cells, gScores, fScores, pathCells, xLines, yLines) are
    module-pool typed arrays reused via a generation counter.

---

## Integration Cheat Sheet

| Need | Call |
|---|---|
| Create new connector | `routeNewConnector(start, end, strokeWidth, type?)` |
| Reroute on endpoint drag (SelectTool) | `rerouteConnectorEndpointDrag(id, endpoint, snap \| pt)` |
| Reroute under shape transform (topology) | `rerouteConnectorTransform(id, startOv, endOv)` |
| Reroute reading Y.Map (no overrides) | `rerouteConnectorCanonical(id)` |
| Find snap target | `findBestSnapTarget(ctx)` |
| All connectors anchored to a shape | `getConnectorsForShape(shapeId)` |
| Anchor → frame point | `anchorFramePoint(anchor, frame)` |
| Elbow anchor → routing point (with cardinal offset) | `elbowAnchorPoint(anchor, frame, dir)` |
| Project normalized anchor → edge point + outward normal + Dir | `projectAnchorToEdge(anchor, frame, shapeType, outEdge, outNormal)` |
| Y.Map anchor record from live snap | `anchorRecordFromSnap(snap)` |
| Where an endpoint's dot should render | `getEndpointEdgePosition(handle, 'start' \| 'end')` |
| Ray-cast interior → shape edge | `rayShapeExitPoint(origin, direction, frame, shapeType, outPoint)` |
| Build render paths | `buildConnectorPaths({ points, strokeWidth, startCap, endCap })` |
| Paint connector | `paintConnector(ctx, paths, color, width)` |
| Render full snap feedback | `drawSnapFeedback(ctx, snap)` |
| Resolve free→anchored elbow direction | `resolveElbowFreeStartDir(fromPos, anchorEnd, strokeWidth)` |
| Resolve anchored→free elbow direction | `computeElbowFreeEndDir(fromPos, toPos)` |
| Check interior (storage vs live) | `anchor.interior` / `snap.interior` |
