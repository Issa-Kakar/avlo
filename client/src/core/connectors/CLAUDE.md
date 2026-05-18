# Connector Routing System

> **Maintenance:** Architectural overview, not a changelog. Keep terse — file headers and inline comments carry the per-function detail.

Two routing modes (elbow + straight), one shared pipeline. Routes are deterministic from `Y.Map` state + live shape frames. The polyline never hits the wire — it lives in a local cache owned by `ConnectorRouter`, populated by the deep observer.

| Concern | Elbow | Straight |
|---|---|---|
| Stored anchor | `{ id, anchor }` | `{ id, interior, anchor }` |
| Endpoint direction | derived at route time (`projectAnchorToEdge`) | `null` (not needed) |
| Endpoint offset | cardinal `EDGE_CLEARANCE_W` (`elbowAnchorPoint`) | along-line pull-back (`applyPullBackInto`) |
| Routing | A* over sparse grid + obstacles | two points (+ ray-cast for interior) |
| Deep-inside snap | nearest midpoint only | center → midpoint → clamped interior |

---

## File Map

| Task | Files |
|---|---|
| Add a shape kind to snap/route | `shape-geometry.ts` (`projectAnchorToEdge`, `rayShapeExitPoint`), `snap.ts` |
| Change snap thresholds / tiers | `constants.ts`, `snap.ts` |
| Change reroute on transform | `reroute-connector.ts`, `tools/selection/connector-topology.ts` |
| Add a connector type | Y.Map schema + `types.ts` + `snap.ts` + `reroute-connector.ts` |
| Change arrow / polyline render | `connector-paths.ts` + `renderer/layers/connector-render-atoms.ts` |
| Change A* / grid / heuristics | `routing-context.ts`, `routing-astar.ts` |
| Fix interior anchor visuals | `connector-render-atoms.ts`, `connector-preview.ts` |

```
core/connectors/
├── types.ts              # Dir, SnapTarget, RoutingContext, Grid
├── constants.ts          # SNAP_CONFIG, ROUTING_CONFIG, EDGE_CLEARANCE_W + bundle getters
├── shape-geometry.ts     # projectAnchorToEdge, rayShapeExitPoint, midpointFor
├── anchor-atoms.ts       # anchorFramePoint, elbowAnchorPoint, fillElbowAnchorPointInto, anchorRecordFromSnap, getEndpointEdgePosition
├── connector-utils.ts    # Direction primitives, spatialRelation, elbow direction resolution
├── snap.ts               # findBestSnapTarget + two pipelines + shared edge probe
├── routing-context.ts    # Centerlines, routing bounds, stubs, grid construction
├── routing-astar.ts      # computeAStarRouteInto — typed-array pool + generation counter
├── connector-paths.ts    # Path2D builders (polyline + arrows, trim compensation)
├── connector-router.ts   # Route cache + reverse shape→connector map + detach helper
├── reroute-connector.ts  # Pipeline<E> + Side helpers + 3 entry points
└── binary-heap.ts        # MinHeap for A*
```

No barrel — import from specific files. `FrameTuple` / `Point` / `StoredAnchor*` come from `@/core/types/*`. Renderer glue: `renderer/layers/connector-render-atoms.ts`, `renderer/layers/connector-preview.ts`.

---

## Y.Map Schema

```typescript
{
  id, kind: 'connector',
  connectorType: 'elbow' | 'straight',  // discriminator — always written
  start: ConnectorEndpoint,             // single field per side: Point | StoredAnchor
  end:   ConnectorEndpoint,
  startCap, endCap: 'none' | 'arrow',
  color, width, ownerId, createdAt
}
type ConnectorEndpoint = [number, number] | StoredAnchor;
//   [number, number] → free Point
//   StoredAnchor    → shape-bound; discriminated by parent connectorType:
//     elbow    → { id, anchor: [0-1, 0-1] }
//     straight → { id, interior: boolean, anchor: [0-1, 0-1] }
```

- **`connectorType`** is the authoritative branch — every routing decision follows from it. `getConnectorType(y)` defaults to `'elbow'` on stale reads.
- **No `points`** — routed polyline is local-cache only.
- **Elbow `side` is *derived***, not stored. `projectAnchorToEdge` re-derives at route time, so it auto-corrects when the shape's aspect ratio or `shapeType` changes.
- **Straight `interior`** is committed at snap time (user intent — center vs edge). Cannot be reconstructed from anchor alone.
- **`anchor: [0-1, 0-1]`** is normalized into the shape's frame; resizes/moves reduce to linear interpolation.
- Connectors always render at opacity 1. No stored `opacity`.

---

## Pipeline + Endpoint Types

Single strategy record per connector type. `connectorType` is read once inside `buildRouteContext` and stored as `pipeline: AnyPipeline`. Below the entry boundary, every helper is parametric in `E` (ELBOW xor STRAIGHT) — no string comparisons, no type threading.

```typescript
interface Pipeline<E> {
  newFree(pos: Point): E;                                                            // pos REFERENCE preserved
  newAnchored(frame: FrameTuple, shapeType: string, src: AnchorSource): E;           // frame ref preserved
  configAnchored(out: E, frame: FrameTuple, shapeType: string, src: AnchorSource): void;  // alias-safe mutator
  routeInto(start: E, end: E, strokeWidth: number, outPoints: Point[]): number;      // -1 on fail
}

interface AnchorSource { anchor: Point; shapeId: string; interior: boolean; }  // straight-only flag

type ElbowEndpoint =
  | { kind: 'free';     pos: Point }
  | { kind: 'anchored'; pos: Point; dir: Dir; frame: FrameTuple };

type StraightEndpoint =
  | { kind: 'free';     pos: Point }
  | { kind: 'edge';     pos: Point }
  | { kind: 'interior'; pos: Point; frame: FrameTuple; shapeType: string; shapeId: string };
```

- `ELBOW.newAnchored` → `projectAnchorToEdge` + `fillElbowAnchorPointInto` (places `pos` at `EDGE_CLEARANCE_W` along the cardinal).
- `STRAIGHT.newAnchored` → `'interior'` xor `'edge'` per `src.interior`.
- `configAnchored` mutates the variant produced by `newAnchored`; **never transitions kind** (frozen at begin).

---

## Side Ownership Model (topology hot path)

A `Side` is "an endpoint that knows how to refresh itself." The topology pre-builds endpoints at gesture begin and mutates them in place each frame; the pipeline turns a pair of refreshed endpoints into a route via `routeInto(start.endpoint, end.endpoint, ...)`. Per-pipeline Side unions live in `tools/selection/connector-topology.ts`.

| Side | Endpoint built via | Per-frame work |
|---|---|---|
| `static` | `bakeCanonicalEndpoint(P, ep, cachedRoute, side)` at begin | none |
| `free`   | `P.newFree(scratch)` — `endpoint.pos === scratch` (alias) | mutate scratch slots |
| `bind`   | `P.newAnchored(frame, shapeType, src)` — for ELBOW + STRAIGHT-interior, `endpoint.frame === side.frame` (alias) | `fillFrameFromBind(side.frame, side)` then `P.configAnchored(endpoint, frame, shapeType, side)` |

Reroute entries are partitioned at finalize into `elbowReroutes` / `straightReroutes`, so per-frame loops dispatch directly to ELBOW or STRAIGHT — no `Pipeline<unknown>` cast, no bimorphic dispatch in the hot path. The cold paths (router canonical bake, drag reroute) take the bimorphic cast — well within IC capacity.

The topology **bind side** is structurally an `AnchorSource` (the `anchor` / `shapeId` / `interior` fields are inlined directly onto it), so `P.configAnchored(endpoint, frame, shapeType, side)` passes `side` as `src` with no allocation.

---

## Pool / Memory / Alias Invariants — DO NOT BREAK

Authoritative list. Mirror code-side comments in `reroute-connector.ts` (lines 42–59) and `connector-topology.ts` (header).

1. **Module scratches are non-re-entrant.** `reroute-connector.ts`, `routing-context.ts`, `routing-astar.ts` hold module-level scratches (point projections, bounds, grid lines, A* state). All `*Into` entries are synchronous; **callers MUST NOT invoke them recursively** — not from an A* hop, not from a Y.Doc observer reentry. (Y.Doc observers don't run inside `transact()`.)
2. **Free-pos alias.** `Pipeline.newFree(pos)` preserves the input reference — `endpoint.pos === pos`. Topology free sides exploit this; callers wanting isolation clone before calling. Once aliased, **never reassign the array** (`endpoint.pos = [...]` forbidden); mutate slots only.
3. **Free scratches are per-side.** The route polyline holds `scratch` by reference at slot 0 / slot N-1; sharing one across two free sides corrupts a read.
4. **Bind-frame alias.** `Pipeline.newAnchored(frame, ...)` preserves the input frame reference for kinds with a `frame` field (ELBOW anchored, STRAIGHT interior). Topology aliases `side.frame === side.endpoint.frame`. STRAIGHT-edge has no `endpoint.frame` — `side.frame` is a standalone scratch fed into `STRAIGHT.configAnchored` (writes `endpoint.pos` only).
5. **Endpoint variant kind frozen at begin.** ELBOW bind: always `'anchored'`. STRAIGHT bind: `'edge'` xor `'interior'` per stored anchor. `configAnchored` mutates fields; never transitions kind.
6. **`shapeType` frozen at begin** for elbow bind sides. UI invariant (context menu hidden during transforms) prevents mid-gesture swaps; per-frame rebake reads `side.shapeType`, never `getHandleShapeType`.
7. **Y.Map never holds a live topology reference.** `commitReroute` clones `[scratch[0], scratch[1]]`; topology builder clones the stored baseline into `originalPos`; the route polyline is local-cache only.
8. **Buffer-length contract.** `outPoints` / `pointsBuf` is mutated in place via find-or-push tuple reuse. `.length` may exceed the returned `validCount` (high-water mark). **Hot-path consumers MUST iterate by `count`**, never `.length` / `for...of`. Renderer (`drawConnectorFromPoints`) and `connector-paths.ts` take an explicit count. Off-gesture readers (`getConnectorRoute`) can use `.length` because the router trims its cache after every canonical write.
9. **`connectorType` is read once at `buildRouteContext`** and stored as `pipeline: AnyPipeline`. No helper below the entry boundary inspects it.
10. **A* uses generation-counter pooling.** Module-level typed arrays (`closedGen` / `gScores` / `fScores` / `parentNode` / `pathCells`, `MAX_CELLS = 64`, `MAX_NODES = 256`); `astarGen` bumps per call → "clear" is a single increment. Pool exhaustion is dev-mode warned.
11. **No bbox-dummy.** `objectsById` never holds a connector handle with a `[0,0,0,0]` placeholder. `rerouteCanonical(id, yObj)` takes `yObj` directly to skip the `getHandle(connectorId)` round-trip.
12. **Route count: ≥2 or -1, never 1.** Every routing fn (`Pipeline.routeInto`, `computeAStarRouteInto`, `computeStraightRouteInto`) emits ≥2 points or signals failure with -1. Returning 1 propagates as `count < 2` through `runDrag` (→ -1, skips `outBbox` write) and `rerouteCanonical` (→ `routes.delete(id)`); `updateEndpointDrag`'s NEW-dirty-rect gate (`count > 0`) bails → half-cleared canvas + cached gesture-start fallback. Degenerate coincident-endpoint routes emit two identical points; `paintConnectorFromPoints` strokes zero-length with `lineCap='round'` as a dot.

---

## Public Entry Points

All hot-path entries write into a caller-owned `outPoints` buffer and return a valid prefix length. `outPoints.length` may exceed the count.

```typescript
// Bake a canonical endpoint from stored Y.Map state. Used by router + topology static sides.
bakeCanonicalEndpoint<E>(P, ep, cachedRoute, side: 'start'|'end') → E

// SelectTool endpoint drag — slot drives one side, the other reads canonically from ctx.
rerouteEndpointDragInto(ctx, slot: 0|1, override: SnapTarget|Point, outBbox, outPoints) → count

// ConnectorTool — no Y.Map.
routeNewConnectorInto(start, end, strokeWidth, type, outPoints) → count

// RouteContext — gesture-stable inputs (start/end/cap/width/cachedRoute/connectorType/pipeline).
//   Pass yObj directly so the router never round-trips through getHandle(connectorId).
buildRouteContext(connectorId, yObj) → RouteContext | null

// Slot taxonomy (used by endpoint-drag entry, EndpointHit, and topology side-builders)
type Slot = 0 | 1
SLOT_START: Slot = 0
SLOT_END:   Slot = 1
slotKey(s):                  'start' | 'end'   // storage-boundary only
slotOther(s):                Slot              // 1 - s
slotPointIndex(s, count):    number            // branchless: s * (count - 1)
```

The router's canonical reroute composes `bakeCanonicalEndpoint` + `Pipeline.routeInto` directly — no override decoder. Topology shape transforms don't go through any single entry — see the Side model above.

---

## Snapping (`snap.ts`)

```typescript
findBestSnapTarget(ctx: SnapContext): SnapTarget | null
type SnapTarget = ElbowSnapTarget | StraightSnapTarget;  // discriminated by `kind`
```

Iterates Z-order via `pickTopmostBindable`. Connectable kinds = `BINDABLE_KINDS` (shape, text, code; text/code use derived frames as filled rects).

**Fill-aware ordering (in `pickTopmostBindable`):**
1. Filled shape interior → occluding; snap or reject, stop scanning.
2. Unfilled shape interior → transparent; remember as innermost, keep scanning.
3. Edge region → always valid regardless of fill.

**Two pipelines, shared edge probe:**

| Cursor | Elbow (`computeElbowSnap`) | Straight (`computeStraightSnap`) |
|---|---|---|
| Outside snap radius | no snap | no snap |
| Near edge | edge + midpoint hysteresis (`tryElbowEdgeSnap`) | edge + midpoint hysteresis (`tryStraightEdgeSnap`) |
| Deep inside | nearest midpoint (`forceElbowMidpoint`) | center → midpoint → clamped (`computeStraightInterior`) |

**Dead-zone guarantee.** The edge-radius gate applies only **outside** the shape; shallow-inside always permits edge sliding.

**Straight interior (three-tier, `STRAIGHT_INTERIOR_DEPTH_PX = 20`):**
1. Center snap — `CENTER_SNAP_RADIUS_PX = 12`, 1.3× unstick hysteresis once active. Sets `isCenter, interior, anchor=[0.5, 0.5]`.
2. Midpoint stickiness — within 16px → `midpointSide: Dir, interior: false` (it's an edge anchor).
3. Clamped interior — anchor = clamped cursor, `[0.01, 0.99]` per axis.

**Ctrl held** → `isCtrlHeld()` (live, from `cursor-tracking.ts`) forces `snap = null` before every `findBestSnapTarget` call.

`position` on every `SnapTarget` is the **un-offset** visual dot AND the un-offset routing endpoint. Per-type offset (elbow cardinal / straight along-line) runs in routing — snap never bakes offsets into `position`.

Thresholds bundled via `getSnapRadiiWorld()` in `constants.ts`. Don't read raw constants — call the bundle.

---

## Routing

### Straight (`reroute-connector.ts`)

Bypasses A* entirely. `computeStraightRouteInto(start, end, outPoints)` writes 2 points.

- **Same-shape interior short-circuit** (pair-level): both `interior` + same `shapeId` → `[start.pos, end.pos]` direct. Avoids the "spinning clock" artifact (opposing ray intersections on convex shapes).
- **Per-side** via `resolveStraightVisibleEndpoint`: `free` copies `pos`; `edge` pulls back along the line (`applyPullBackInto`); `interior` ray-casts (`rayShapeExitPoint`) then pulls back. Module scratches `STRAIGHT_PT_START` / `STRAIGHT_PT_END` / `STRAIGHT_RAY_DIR` / `STRAIGHT_RAY_EXIT` consumed sequentially per side.
- **Overlap safety**: when `visDelta · rawDelta ≤ 0` or `|visDelta| < EDGE_CLEARANCE_W`, fall back to `[startRaw, endRaw]`.
- **Dashed guides** (`drawConnectorDashGuide`) for interior anchors are computed render-side from `snap.kind === 'straight' && snap.interior` — not threaded through route results.

### Elbow (`routing-astar.ts`)

`computeAStarRouteInto(startPos, startDir, endPos, endDir, startFrame, endFrame, strokeWidth, outPoints)`. Returns valid count.

- **Index-based, zero-alloc.** Cells addressed by `yi * xStride + xi`. State pools: cell-keyed (`closedGen`/`gScoreGen`/`gScores`, `MAX_CELLS = 64`) and node-keyed (`fScores`/`parentNode`/`arrivalDir`/`nodeCell`, `MAX_NODES = 256`). `astarGen++` per call replaces O(N) clear with O(1).
- **Heap stores node indices.** `MinHeap<number>` reused (`.clear()`); comparator reads `fScores[idx]`.
- **Cost** = Manhattan + `BEND_PENALTY (1000)` on direction change. Backwards moves skipped (no U-turns). Cardinals encoded `0..3` (`OPPOSITE_INT` table).
- **Obstacle check** is per-segment slab intersection (`segmentIntersectsFrame`), not cell blocking — handles thin shapes and arbitrary segment directions.
- **Path reconstruction** walks parent indices; `emitOrMerge` writes into `outPoints` with collinear simplification inline (find-or-push tuple reuse).
- **Fallbacks:** no path → recurse with `EMPTY_OBSTACLES`; still nothing → direct `[startPos, endPos]`.
- **Dynamic routing bounds** encode centerline knowledge in their edges (`routing-context.ts`). Facing-side = centerline (when shapes face each other); non-facing padded by approach offset = `CORNER_RADIUS_W + arrowLength + EDGE_CLEARANCE_W`. Stubs land on centerlines automatically.
- **Centerline computation** (`computeAxisCenterline`) returns `null` when ranges overlap, when a Free→Anchored gap is below approach offset, or when gap ≤ `EDGE_CLEARANCE_W`.

**Direction resolution** (`resolveElbowDirections`):
- Anchored→Anchored: stored `dir`s.
- Free→Anchored: `resolveElbowFreeStartDir` (4-case decision tree over `spatialRelation` — sliver-escape, wrap, L-route).
- Anchored→Free: `computeElbowFreeEndDir` (one-liner over `directionFromDelta`).

---

## Connector Router (`connector-router.ts`)

Three private maps + a reroute queue. The router owns its own queue — `RoomDocManager`'s observer pokes it via typed events and drains the queue in Phase C; it never touches the internals.

| Map / Set | Shape | Updated |
|---|---|---|
| `shapeToConnectors` | `shapeId → Set<connectorId>` | connector add/remove/anchor change, shape delete |
| `anchorIds` | `connectorId → [startShapeId, endShapeId]` (mutated in place) | same; tuple slots reused |
| `routes` | `connectorId → Point[]` (per-connector pooled buffer) | `rerouteCanonical` mutates + trims to `count` |
| `_rerouteQueue` | `Set<connectorId>` | added by `on*` events; drained in Phase C |

Self-loops dedupe inline with four `!==` checks (no Set allocation per update). `removeConnector` / `removeShape` are unconditional no-ops on unknown ids.

```typescript
// Event API (called from observer — typed by event, not operation)
onConnectorAdded(id, y):              void   // top-level add → register + queue
onObjectDeleted(id):                  void   // top-level delete → removeConnector + removeShape
onConnectorEdited(id, y, startEnd):   void   // start/end/connectorType change → updateAnchors? + queue
onBindableChanged(id):                void   // bindable bbox/shapeType change → propagate to attached
isQueuedForReroute(id):               boolean
drainRerouteQueue():                  IterableIterator<string>  // exhaust before next observer fire

// Read API (module-level — getActiveRoomDoc().connectorRouter under the hood)
getConnectorRoute(id):           Point[] | null              // .length === validCount post-trim
getAttachedConnectors(shapeId):  ReadonlySet<string> | undefined
detachConnectorFromShape(connectorId, shapeId):  void        // shape-deletion helper (transact-required)

// Reroute API
rerouteCanonical(id, yObj):      BBoxTuple | null            // direct yObj, no getHandle round-trip
computeBBox(id, y, outBbox):     boolean                     // *Into; style-only branch (Phase B)
```

Lifecycle:
- **Hydrate**: Pass 1 `registerConnector` per connector; Pass 2 `rerouteCanonical` after non-connectors are seeded.
- **Observer**: top-level add → `onConnectorAdded`; top-level delete → `onObjectDeleted`; connector start/end/connectorType change → `onConnectorEdited`; bindable bbox/shapeType change → `onBindableChanged` (Phase B fires this on every bindable bbox change, including first-insert — so a connector that anchors to a shape arriving after it on remote sync still reroutes).
- **Phase C**: `for (const id of router.drainRerouteQueue())` → `rerouteCanonical` → `upsertHandle`. `finalizeUpsert(..., alwaysEvict=true, ...)` evicts geometry unconditionally — route changed.
- **Destroy**: `router.clear()` (also clears `_rerouteQueue`).

`detachConnectorFromShape` reads the cached route, replaces any bound endpoint pointing at `shapeId` with the route's first/last point (cloned). No-op when no cached route. Caller must run inside `transact()`.

---

## Anchor Atoms (`anchor-atoms.ts`)

Six classifiers / writers. Interior-ness is stored; elbow `dir` is supplied by the caller (derived via `projectAnchorToEdge`).

| Function | Purpose |
|---|---|
| `anchorFramePoint(anchor, frame)` | Raw `[0-1]` interpolation into frame. Both types. |
| `elbowAnchorPoint(anchor, frame, dir)` | Raw + `EDGE_CLEARANCE_W` along `directionVector(dir)`. Allocates. |
| `fillElbowAnchorPointInto(out, anchor, frame, dir)` | Write-into form. Used by `Pipeline.configAnchored`. |
| `isSameShape(a, b)` | Both endpoints → same `shapeId`. |
| `isAnchored(handle)` | True iff connector has at least one shape-bound endpoint (StoredAnchor, not free Point). |
| `isInteriorAnchored(handle, slot)` | True iff the given slot is bound AND `interior === true` (straight deep snap). |
| `anchorRecordFromSnap(snap)` | Elbow → `{id, anchor}`; straight → `{id, interior, anchor}`. |
| `getEndpointEdgePosition(handle, 'start'\|'end')` | Where the dot renders: raw frame point when bound, free pos when free, cached-route fallback when target frame is gone. |

---

## Render Atoms (`renderer/layers/connector-render-atoms.ts`)

Single paint atom owns every connector stroke (committed render, transform preview, in-flight preview share one pass).

| Atom | Purpose |
|---|---|
| `paintConnector(ctx, paths, color, width)` | Polyline + arrow caps at `ARROW_ROUNDING_LINE_WIDTH`, opacity 1. |
| `drawSnapFeedback(ctx, snap)` | Highlight + midpoint dots + (straight) center dot + active anchor dot. |
| `drawConnectorDashGuide(ctx, from, to)` | Interior-straight guide. |
| `isCenterSnap(snap)`, `resolveSnapContext(snap)` | Helpers — center check; `{handle, frame, shapeType}` resolution via `BINDABLE_KINDS` + `frameOf`. |

`buildConnectorPaths({ points, count, strokeWidth, startCap, endCap })` (in `connector-paths.ts`) returns `{ polyline, startArrow, endArrow }`. Rounded corners via `arcTo`, radius clamped to `min(CORNER_RADIUS_W (22), lenIn/2, lenOut/2)`. Arrow size = `max(ARROW_MIN_LENGTH_W (6), strokeWidth * 3)`, capped at `segLen / 2`. Polyline trimmed before each arrow-capped end so the stroke doesn't poke through.

---

## Constants (`constants.ts`)

Two classes, two accessor styles:

- **Screen-space (`_PX`)** — `SNAP_CONFIG`, `ANCHOR_DOT_CONFIG`, `GUIDE_CONFIG`. Materialized per-call via bundle getters: `getSnapRadiiWorld()`, `getAnchorDotMetricsWorld()`, `getGuideMetricsWorld()`. Read the bundle once per function, don't thread `scale`.
- **World-space (`_W`)** — `CORNER_RADIUS_W`, `ARROW_MIN_LENGTH_W`, `EDGE_CLEARANCE_W`, `BEND_PENALTY`. Permanent (stored in Y.Doc) — must not vary with zoom.

Derived: `computeArrowLength(strokeWidth)`, `computeArrowWidth(strokeWidth)`, `computeApproachOffset(strokeWidth)`.

---

## Integration Cheat Sheet

| Need | Call |
|---|---|
| Create new connector | `routeNewConnectorInto(start, end, w, type, outPoints)` |
| Reroute on endpoint drag | `rerouteEndpointDragInto(ctx, slot, snap\|pt, outBbox, outPoints)` |
| Reroute under shape transform | `runTopologyScale` / `runTopologyTranslate` (per-frame, partitioned) |
| Bake a canonical endpoint | `bakeCanonicalEndpoint(P, ep, cachedRoute, side)` |
| Build RouteContext | `buildRouteContext(connectorId, yObj)` |
| Canonical reroute (observer / hydrate) | `connectorRouter.rerouteCanonical(id, yObj)` |
| Read cached route | `getConnectorRoute(id)` |
| Find snap target | `findBestSnapTarget(ctx)` |
| Connectors anchored to a shape | `getAttachedConnectors(shapeId)` |
| Detach on shape delete | `detachConnectorFromShape(cId, sId)` (inside `transact()`) |
| Anchor → frame point | `anchorFramePoint(anchor, frame)` |
| Elbow routing point (with cardinal offset) | `elbowAnchorPoint(anchor, frame, dir)` |
| Write-into elbow point | `fillElbowAnchorPointInto(out, anchor, frame, dir)` |
| Project anchor → edge + normal + Dir | `projectAnchorToEdge(anchor, frame, shapeType, outEdge, outNormal)` |
| Y.Map record from live snap | `anchorRecordFromSnap(snap)` |
| Endpoint dot position | `getEndpointEdgePosition(handle, 'start'\|'end')` |
| Ray-cast interior → edge | `rayShapeExitPoint(origin, dir, frame, shapeType, outPoint)` |
| Build render paths | `buildConnectorPaths({ points, count, strokeWidth, startCap, endCap })` |
| Paint connector | `paintConnector(ctx, paths, color, width)` |
| BBox into pre-allocated tuple | `computeConnectorBBoxFromPointsInto(points, count, w, sCap, eCap, outBbox)` |
