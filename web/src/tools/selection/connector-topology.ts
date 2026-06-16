/**
 * Connector Topology — begin-phase classifier + per-frame apply/commit/cancel.
 *
 * Tightly coupled to `transform.ts` (imports `Entry<K>` + `ScaleCtx` type-only).
 * Every classification decision is made at begin; per-frame apply is pure dispatch
 * over pre-built variant rows with zero per-frame allocation.
 *
 * Variants (discriminated by `mode`):
 *   static    — both endpoints canonical; no apply, no commit; renderer draws in-place
 *   translate — both endpoints move together; rigid polyline + bbox shift
 *   reroute   — mixed / scale; per-pipeline apply loops route fresh polylines
 *
 * Reroute entries are partitioned at finalize into `elbowReroutes` / `straightReroutes`,
 * so per-frame apply loops are monomorphic in the endpoint type — `Pipeline<E>`
 * dispatch collapses to direct ELBOW / STRAIGHT calls.
 *
 * **Side ownership.** A `Side` is "an endpoint that knows how to refresh itself."
 *   - `static` — endpoint baked once at begin via `bakeCanonicalEndpoint`; never touched.
 *   - `free`   — endpoint.pos === side.scratch (alias). Per-frame apply mutates scratch
 *                slots; endpoint sees updates automatically. originalPos cloned at begin.
 *   - `bind`   — for ELBOW + STRAIGHT-interior, endpoint.frame === side.frame (alias).
 *                `fillFrameFromBind(side.frame, side)` writes both at once. For
 *                STRAIGHT-edge, side.frame is a standalone scratch fed into
 *                `fillAnchorPoint(anchor, frame, endpoint.pos)`.
 *
 * **Alias contract.**
 *   1. Once aliased, never reassign the array — only mutate slots.
 *   2. Free-side scratches are per-side; never module-shared (the route polyline holds
 *      `scratch` by reference at slot 0 / slot N-1).
 *   3. `commitReroute` clones `[scratch[0], scratch[1]]` into Y.Map.
 */

import { getHandleShapeType } from '@/core/accessors';
import {
  type AnchorSource,
  bakeCanonicalEndpoint,
  buildRouteContext,
  ELBOW,
  type ElbowEndpoint,
  type RouteContext,
  STRAIGHT,
  type StraightEndpoint,
} from '@/core/connectors/reroute-connector';
import { computeConnectorBBoxFromPointsInto } from '@/core/geometry/bbox';
import { bboxToFrameMut, copyBbox, copyFrame, offsetBBox, offsetPoint } from '@/core/geometry/bounds';
import { frameOf } from '@/core/geometry/frame-of';
import { preservePositionMut, scaleAround, uniformFactor } from '@/core/geometry/scale-system';
import type { BBoxTuple, FrameTuple, Point } from '@/core/types/geometry';
import { isCorner } from '@/core/types/handles';
import type { BindableKind, ConnectorEndpoint, ObjectHandle, StoredAnchor, StoredStraightAnchor } from '@/core/types/objects';
import { invalidateWorldAll, invalidateWorldBBox } from '@/renderer/RenderLoop';
import { getAttachedConnectors, getHandle, getObjects } from '@/runtime/room-runtime';
import type { Entry } from './transform';
import type { ScaleCtx } from './types';

// ============================================================================
// Per-pipeline Side types
// ============================================================================
//
// Side variants share a common `kind` discriminator. AnchorSource fields
// (anchor / shapeId / interior) are inlined directly so the bind side IS
// structurally an AnchorSource — `Pipeline.configAnchored(out, frame, shapeType, side)`
// passes the side as the source with no allocation.

type ElbowStaticSide = { readonly kind: 'static'; readonly endpoint: ElbowEndpoint };
type ElbowFreeSide = {
  readonly kind: 'free';
  readonly endpoint: ElbowEndpoint;
  /** Aliased: `endpoint.pos === scratch`. Per-frame apply mutates slots. */
  readonly scratch: Point;
  /** Cloned at begin; gesture-stable input to scale math. */
  readonly originalPos: Point;
};
type ElbowBindSide = {
  readonly kind: 'bind';
  readonly endpoint: ElbowEndpoint;
  readonly bindKind: BindableKind;
  readonly entry: Entry<BindableKind>;
  /** Non-null only for note/bookmark (fillFrameFromBind needs the frozen dims). */
  readonly frozenFrame: FrameTuple | null;
  // AnchorSource fields — inlined so the side satisfies AnchorSource structurally.
  readonly anchor: Point;
  readonly shapeId: string;
  /** Always false for elbow; ELBOW pipeline ignores. */
  readonly interior: boolean;
  /** Frozen at begin; UI invariant prevents shape-type swap mid-gesture. */
  readonly shapeType: string;
  /** Aliased: `frame === endpoint.frame`. fillFrameFromBind writes here. */
  readonly frame: FrameTuple;
};
type ElbowSide = ElbowStaticSide | ElbowFreeSide | ElbowBindSide;

type StraightStaticSide = { readonly kind: 'static'; readonly endpoint: StraightEndpoint };
type StraightFreeSide = {
  readonly kind: 'free';
  readonly endpoint: StraightEndpoint;
  readonly scratch: Point;
  readonly originalPos: Point;
};
type StraightBindSide = {
  readonly kind: 'bind';
  readonly endpoint: StraightEndpoint;
  readonly bindKind: BindableKind;
  readonly entry: Entry<BindableKind>;
  readonly frozenFrame: FrameTuple | null;
  readonly anchor: Point;
  readonly shapeId: string;
  /** Frozen at begin per stored anchor's interior flag; STRAIGHT.configAnchored
   *  branches on endpoint.kind ('edge' vs 'interior'), already fixed at construction. */
  readonly interior: boolean;
  /** Aliased to endpoint.frame for interior; standalone scratch for edge. */
  readonly frame: FrameTuple;
};
type StraightSide = StraightStaticSide | StraightFreeSide | StraightBindSide;

// ============================================================================
// Entry types
// ============================================================================

interface BaseEntry {
  readonly mode: 'static' | 'translate' | 'reroute';
  readonly id: string;
  readonly currBbox: BBoxTuple;
}

interface DirtyEntry extends BaseEntry {
  readonly originalBbox: BBoxTuple;
  readonly prevBbox: BBoxTuple;
}

export interface StaticEntry extends BaseEntry {
  readonly mode: 'static';
}

export interface TranslateEntry extends DirtyEntry {
  readonly mode: 'translate';
  /** Frozen pre-gesture FREE-side endpoint. null = bound (commit skips). */
  readonly frozenStart: Point | null;
  readonly frozenEnd: Point | null;
}

interface RerouteEntryBase<S> extends DirtyEntry {
  readonly mode: 'reroute';
  readonly start: S;
  readonly end: S;
  /** Cap/width/cachedRoute frozen at begin — no per-frame Y.Map reads. */
  readonly routeCtx: RouteContext;
  /** Persistent buffer mutated in place each frame. `length` may exceed `validCount`. */
  readonly pointsBuf: Point[];
  /** Valid prefix length of `pointsBuf`. -1 = routing failed this frame. */
  validCount: number;
}

export type ElbowRerouteEntry = RerouteEntryBase<ElbowSide>;
export type StraightRerouteEntry = RerouteEntryBase<StraightSide>;

/**
 * Endpoint-drag synthetic entry. Allocated ONCE as a scratch on
 * `TransformController` and reused across gestures — `id`, `currBbox` slots,
 * `pointsBuf`, and `validCount` are reset per `beginEndpointDrag`. Renderer
 * reads it via `getEndpointDragEntry()`; same `mode: 'reroute'` shape as
 * topology reroute entries so the per-frame draw dispatch is identical.
 */
export interface EndpointDragEntry {
  readonly mode: 'reroute';
  /** Mutable: written by the controller on each `beginEndpointDrag`. */
  id: string;
  readonly currBbox: BBoxTuple;
  readonly pointsBuf: Point[];
  validCount: number;
}

export type ConnectorEntry = StaticEntry | TranslateEntry | ElbowRerouteEntry | StraightRerouteEntry | EndpointDragEntry;

export type ConnectorTopology = {
  readonly byId: ReadonlyMap<string, ConnectorEntry>;
  readonly translates: readonly TranslateEntry[];
  readonly elbowReroutes: readonly ElbowRerouteEntry[];
  readonly straightReroutes: readonly StraightRerouteEntry[];
  /** Non-selected connectors whose endpoints bind to a selected bindable.
   *  Drives the spatial-loop skip predicate. The full inject set
   *  (selected ∪ attached) is composed by the controller — `injectIds`
   *  is no longer a topology concern. */
  readonly attachedConnectorIds: ReadonlySet<string>;
};

// ============================================================================
// Endpoint classifier
// ============================================================================

type EndpointState = 'canonical' | 'frame-bound' | 'free-moving';

type SelectedBindable = {
  readonly kind: BindableKind;
  readonly entry: Entry<BindableKind>;
  readonly frozenFrame: FrameTuple | null;
};

function classifyEndpoint(
  anchor: StoredAnchor | undefined,
  connectorIsSelected: boolean,
  selectedBindables: ReadonlyMap<string, SelectedBindable>,
): EndpointState {
  if (anchor) return selectedBindables.has(anchor.id) ? 'frame-bound' : 'canonical';
  return connectorIsSelected ? 'free-moving' : 'canonical';
}

const ZERO_POINT: Readonly<Point> = [0, 0];

// ============================================================================
// Frame derivation per bind-side kind
// ============================================================================

/**
 * Fill `scratch` with the current anchor frame of `side.entry`.
 * Reads only `entry.out.*` (+ optionally `entry.frozen.*` + `side.frozenFrame`).
 * Mode-agnostic: whatever apply just wrote is what we read.
 */
function fillFrameFromBind(scratch: FrameTuple, side: ElbowBindSide | StraightBindSide): void {
  const e = side.entry;
  switch (side.bindKind) {
    case 'shape':
    case 'image': {
      const f = (e.out as { frame: FrameTuple }).frame;
      copyFrame(scratch, f);
      return;
    }
    case 'text':
    case 'code': {
      bboxToFrameMut(e.out.bbox, scratch);
      return;
    }
    case 'note':
    case 'bookmark': {
      const frozenScale = (e.frozen as { scale: number }).scale;
      const outScale = (e.out as { scale: number }).scale;
      const outOrigin = (e.out as { origin: Point }).origin;
      const ratio = outScale / frozenScale;
      const fz = side.frozenFrame!;
      scratch[0] = outOrigin[0];
      scratch[1] = outOrigin[1];
      scratch[2] = fz[2] * ratio;
      scratch[3] = fz[3] * ratio;
      return;
    }
  }
}

// ============================================================================
// Side builders (gesture begin) — one allocation per bind / free side
// ============================================================================

function buildElbowSide(
  endpoint: ConnectorEndpoint | undefined,
  anchor: StoredAnchor | undefined,
  state: EndpointState,
  selectedBindables: ReadonlyMap<string, SelectedBindable>,
  cachedRoute: Point[] | null,
  side: 'start' | 'end',
): ElbowSide | null {
  if (state === 'canonical') {
    return { kind: 'static', endpoint: bakeCanonicalEndpoint(ELBOW, endpoint, cachedRoute, side) };
  }
  if (state === 'frame-bound') {
    // classifyEndpoint guarantees anchor + selectedBindables.has
    const sb = selectedBindables.get(anchor!.id)!;
    const handle = getHandle(anchor!.id);
    if (!handle) return null;
    const initFrame = frameOf(handle);
    if (!initFrame) return null;
    const ourFrame: FrameTuple = [initFrame[0], initFrame[1], initFrame[2], initFrame[3]];
    const shapeType = getHandleShapeType(handle);
    const src: AnchorSource = {
      anchor: [anchor!.anchor[0], anchor!.anchor[1]],
      shapeId: anchor!.id,
      interior: false,
    };
    const ep = ELBOW.newAnchored(ourFrame, shapeType, src);
    return {
      kind: 'bind',
      endpoint: ep,
      bindKind: sb.kind,
      entry: sb.entry,
      frozenFrame: sb.frozenFrame,
      anchor: src.anchor,
      shapeId: src.shapeId,
      interior: false,
      shapeType,
      frame: ourFrame,
    };
  }
  // free-moving
  const storedPos = endpoint && Array.isArray(endpoint) ? (endpoint as Point) : ZERO_POINT;
  const scratch: Point = [storedPos[0], storedPos[1]];
  const ep = ELBOW.newFree(scratch);
  return {
    kind: 'free',
    endpoint: ep,
    scratch,
    originalPos: [storedPos[0], storedPos[1]],
  };
}

function buildStraightSide(
  endpoint: ConnectorEndpoint | undefined,
  anchor: StoredAnchor | undefined,
  state: EndpointState,
  selectedBindables: ReadonlyMap<string, SelectedBindable>,
  cachedRoute: Point[] | null,
  side: 'start' | 'end',
): StraightSide | null {
  if (state === 'canonical') {
    return { kind: 'static', endpoint: bakeCanonicalEndpoint(STRAIGHT, endpoint, cachedRoute, side) };
  }
  if (state === 'frame-bound') {
    const sb = selectedBindables.get(anchor!.id)!;
    const handle = getHandle(anchor!.id);
    if (!handle) return null;
    const initFrame = frameOf(handle);
    if (!initFrame) return null;
    const ourFrame: FrameTuple = [initFrame[0], initFrame[1], initFrame[2], initFrame[3]];
    const shapeType = getHandleShapeType(handle);
    const interior = (anchor as StoredStraightAnchor).interior ?? false;
    const src: AnchorSource = {
      anchor: [anchor!.anchor[0], anchor!.anchor[1]],
      shapeId: anchor!.id,
      interior,
    };
    const ep = STRAIGHT.newAnchored(ourFrame, shapeType, src);
    return {
      kind: 'bind',
      endpoint: ep,
      bindKind: sb.kind,
      entry: sb.entry,
      frozenFrame: sb.frozenFrame,
      anchor: src.anchor,
      shapeId: src.shapeId,
      interior,
      frame: ourFrame,
    };
  }
  // free-moving
  const storedPos = endpoint && Array.isArray(endpoint) ? (endpoint as Point) : ZERO_POINT;
  const scratch: Point = [storedPos[0], storedPos[1]];
  const ep = STRAIGHT.newFree(scratch);
  return {
    kind: 'free',
    endpoint: ep,
    scratch,
    originalPos: [storedPos[0], storedPos[1]],
  };
}

// ============================================================================
// Builder
// ============================================================================

export interface TopologyBuilder {
  onSelectedConnector(id: string, handle: ObjectHandle): void;
  onSelectedBindable(id: string, kind: BindableKind, entry: Entry<BindableKind>, handle: ObjectHandle): void;
  finalize(): ConnectorTopology | null;
}

export function newTopologyBuilder(mode: 'translate' | 'scale', selectedIdSet: ReadonlySet<string>): TopologyBuilder {
  const selectedBindables = new Map<string, SelectedBindable>();
  const selectedConnectors: ObjectHandle[] = [];
  const attachedIds = new Set<string>();

  return {
    onSelectedConnector(_id, handle) {
      selectedConnectors.push(handle);
    },

    onSelectedBindable(id, kind, entry, handle) {
      // Check connectors first — `selectedBindables` is only consulted when a connector
      // endpoint's anchor.id lands here, and that can only happen for connectors in this
      // shape's attached set. No attached → the frame freeze + map entry are unreachable.
      const attached = getAttachedConnectors(id);
      if (!attached || attached.size === 0) return;

      let frozenFrame: FrameTuple | null = null;
      if (kind === 'note' || kind === 'bookmark') {
        // note/bookmark frames are populated during hydrate and only become null after delete,
        // which can't happen for a selected handle mid-begin. Non-null assertion is sound here.
        const f = frameOf(handle)!;
        frozenFrame = [f[0], f[1], f[2], f[3]];
      }
      selectedBindables.set(id, { kind, entry, frozenFrame });

      for (const cid of attached) {
        if (selectedIdSet.has(cid)) continue;
        attachedIds.add(cid);
      }
    },

    finalize() {
      const byId = new Map<string, ConnectorEntry>();
      const translates: TranslateEntry[] = [];
      const elbowReroutes: ElbowRerouteEntry[] = [];
      const straightReroutes: StraightRerouteEntry[] = [];

      for (const handle of selectedConnectors) {
        processConnector(handle, true, mode, selectedBindables, translates, elbowReroutes, straightReroutes, byId);
      }
      for (const cid of attachedIds) {
        const h = getHandle(cid);
        if (h?.kind !== 'connector') continue;
        processConnector(h, false, mode, selectedBindables, translates, elbowReroutes, straightReroutes, byId);
      }

      if (byId.size === 0) return null;

      return { byId, translates, elbowReroutes, straightReroutes, attachedConnectorIds: attachedIds };
    },
  };
}

function processConnector(
  conn: ObjectHandle,
  isSelected: boolean,
  mode: 'translate' | 'scale',
  selectedBindables: ReadonlyMap<string, SelectedBindable>,
  translates: TranslateEntry[],
  elbowReroutes: ElbowRerouteEntry[],
  straightReroutes: StraightRerouteEntry[],
  byId: Map<string, ConnectorEntry>,
): void {
  const start = conn.y.get('start') as ConnectorEndpoint | undefined;
  const end = conn.y.get('end') as ConnectorEndpoint | undefined;
  const startAnchor = start && !Array.isArray(start) ? start : undefined;
  const endAnchor = end && !Array.isArray(end) ? end : undefined;
  const startState = classifyEndpoint(startAnchor, isSelected, selectedBindables);
  const endState = classifyEndpoint(endAnchor, isSelected, selectedBindables);

  // STATIC — both endpoints canonical. Only selected connectors enter topology.
  if (startState === 'canonical' && endState === 'canonical') {
    if (!isSelected) return;
    byId.set(conn.id, { mode: 'static', id: conn.id, currBbox: [...conn.bbox] as BBoxTuple });
    return;
  }

  // TRANSLATE-ONLY — both endpoints move rigidly under translate gesture.
  if (mode === 'translate' && startState !== 'canonical' && endState !== 'canonical') {
    const ob = conn.bbox;
    const frozenStart = start && Array.isArray(start) ? ([start[0], start[1]] as Point) : null;
    const frozenEnd = end && Array.isArray(end) ? ([end[0], end[1]] as Point) : null;
    const e: TranslateEntry = {
      mode: 'translate',
      id: conn.id,
      originalBbox: ob,
      currBbox: [ob[0], ob[1], ob[2], ob[3]],
      prevBbox: [ob[0], ob[1], ob[2], ob[3]],
      frozenStart,
      frozenEnd,
    };
    translates.push(e);
    byId.set(conn.id, e);
    return;
  }

  // REROUTE — partition by connectorType for monomorphic apply loops.
  const routeCtx = buildRouteContext(conn.id, conn.y);
  if (!routeCtx) return; // partially-built connector — observer will reroute on next write

  const ob = conn.bbox;
  if (routeCtx.connectorType === 'straight') {
    const startSide = buildStraightSide(start, startAnchor, startState, selectedBindables, routeCtx.cachedRoute, 'start');
    const endSide = buildStraightSide(end, endAnchor, endState, selectedBindables, routeCtx.cachedRoute, 'end');
    if (!startSide || !endSide) return;
    const e: StraightRerouteEntry = {
      mode: 'reroute',
      id: conn.id,
      start: startSide,
      end: endSide,
      originalBbox: ob,
      currBbox: [ob[0], ob[1], ob[2], ob[3]],
      prevBbox: [ob[0], ob[1], ob[2], ob[3]],
      routeCtx,
      pointsBuf: [],
      validCount: 0,
    };
    straightReroutes.push(e);
    byId.set(conn.id, e);
  } else {
    const startSide = buildElbowSide(start, startAnchor, startState, selectedBindables, routeCtx.cachedRoute, 'start');
    const endSide = buildElbowSide(end, endAnchor, endState, selectedBindables, routeCtx.cachedRoute, 'end');
    if (!startSide || !endSide) return;
    const e: ElbowRerouteEntry = {
      mode: 'reroute',
      id: conn.id,
      start: startSide,
      end: endSide,
      originalBbox: ob,
      currBbox: [ob[0], ob[1], ob[2], ob[3]],
      prevBbox: [ob[0], ob[1], ob[2], ob[3]],
      routeCtx,
      pointsBuf: [],
      validCount: 0,
    };
    elbowReroutes.push(e);
    byId.set(conn.id, e);
  }
}

// ============================================================================
// Per-frame apply — monomorphic per pipeline
// ============================================================================

export function runTopologyTranslate(topology: ConnectorTopology, dx: number, dy: number): void {
  applyTranslates(topology.translates, dx, dy);
  applyElbowReroutesTranslate(topology.elbowReroutes, dx, dy);
  applyStraightReroutesTranslate(topology.straightReroutes, dx, dy);
}

export function runTopologyScale(topology: ConnectorTopology, ctx: ScaleCtx): void {
  // `corner`/`uf` depend only on `ctx.handleId`/`sx`/`sy` — same value for every
  // entry this frame; hoist once across both pipelines.
  const corner = isCorner(ctx.handleId);
  const uf = corner ? uniformFactor(ctx.sx, ctx.sy, ctx.handleId) : 0;
  applyElbowReroutesScale(topology.elbowReroutes, ctx, corner, uf);
  applyStraightReroutesScale(topology.straightReroutes, ctx, corner, uf);
}

function applyTranslates(arr: readonly TranslateEntry[], dx: number, dy: number): void {
  for (let i = 0; i < arr.length; i++) {
    const e = arr[i];
    invalidateWorldBBox(e.prevBbox);
    offsetBBox(e.currBbox, e.originalBbox, dx, dy);
    invalidateWorldBBox(e.currBbox);
    copyBbox(e.currBbox, e.prevBbox);
  }
}

// ---- Elbow loops ----

function applyElbowReroutesTranslate(arr: readonly ElbowRerouteEntry[], dx: number, dy: number): void {
  for (let i = 0; i < arr.length; i++) {
    const e = arr[i];
    rebakeElbowSideTranslate(e.start, dx, dy);
    rebakeElbowSideTranslate(e.end, dx, dy);
    publishElbowRoute(e);
  }
}

function applyElbowReroutesScale(arr: readonly ElbowRerouteEntry[], ctx: ScaleCtx, corner: boolean, uf: number): void {
  for (let i = 0; i < arr.length; i++) {
    const e = arr[i];
    rebakeElbowSideScale(e.start, ctx, corner, uf);
    rebakeElbowSideScale(e.end, ctx, corner, uf);
    publishElbowRoute(e);
  }
}

function rebakeElbowSideTranslate(s: ElbowSide, dx: number, dy: number): void {
  switch (s.kind) {
    case 'static':
      return;
    case 'free':
      // endpoint.pos === scratch; mutating slots updates the endpoint automatically.
      offsetPoint(s.scratch, s.originalPos, dx, dy);
      return;
    case 'bind':
      // s.frame === s.endpoint.frame (alias); fillFrameFromBind writes both at once.
      fillFrameFromBind(s.frame, s);
      // configAnchored re-derives endpoint.dir + endpoint.pos in place; frame slots are
      // self-writes (alias).
      ELBOW.configAnchored(s.endpoint, s.frame, s.shapeType, s);
      return;
  }
}

function rebakeElbowSideScale(s: ElbowSide, ctx: ScaleCtx, corner: boolean, uf: number): void {
  switch (s.kind) {
    case 'static':
      return;
    case 'free':
      if (corner) {
        // Corner handles: track the selection's uniform corner scale.
        preservePositionMut(s.scratch, s.originalPos[0], s.originalPos[1], ctx.selBounds, ctx.origin, uf);
      } else {
        // Side handles: axis-aligned. The inactive axis is hardcoded 1 by rawScaleFactors.
        s.scratch[0] = scaleAround(s.originalPos[0], ctx.origin[0], ctx.sx);
        s.scratch[1] = scaleAround(s.originalPos[1], ctx.origin[1], ctx.sy);
      }
      return;
    case 'bind':
      fillFrameFromBind(s.frame, s);
      ELBOW.configAnchored(s.endpoint, s.frame, s.shapeType, s);
      return;
  }
}

function publishElbowRoute(e: ElbowRerouteEntry): void {
  invalidateWorldBBox(e.prevBbox);
  const count = ELBOW.routeInto(e.start.endpoint, e.end.endpoint, e.routeCtx.strokeWidth, e.pointsBuf);
  publishCount(e, count);
  invalidateWorldBBox(e.currBbox);
  copyBbox(e.currBbox, e.prevBbox);
}

// ---- Straight loops ----

function applyStraightReroutesTranslate(arr: readonly StraightRerouteEntry[], dx: number, dy: number): void {
  for (let i = 0; i < arr.length; i++) {
    const e = arr[i];
    rebakeStraightSideTranslate(e.start, dx, dy);
    rebakeStraightSideTranslate(e.end, dx, dy);
    publishStraightRoute(e);
  }
}

function applyStraightReroutesScale(arr: readonly StraightRerouteEntry[], ctx: ScaleCtx, corner: boolean, uf: number): void {
  for (let i = 0; i < arr.length; i++) {
    const e = arr[i];
    rebakeStraightSideScale(e.start, ctx, corner, uf);
    rebakeStraightSideScale(e.end, ctx, corner, uf);
    publishStraightRoute(e);
  }
}

function rebakeStraightSideTranslate(s: StraightSide, dx: number, dy: number): void {
  switch (s.kind) {
    case 'static':
      return;
    case 'free':
      offsetPoint(s.scratch, s.originalPos, dx, dy);
      return;
    case 'bind':
      // Interior: s.frame === s.endpoint.frame (alias). Edge: s.frame is standalone scratch
      // fed into STRAIGHT.configAnchored which writes endpoint.pos via fillAnchorPoint.
      fillFrameFromBind(s.frame, s);
      STRAIGHT.configAnchored(s.endpoint, s.frame, '', s);
      return;
  }
}

function rebakeStraightSideScale(s: StraightSide, ctx: ScaleCtx, corner: boolean, uf: number): void {
  switch (s.kind) {
    case 'static':
      return;
    case 'free':
      if (corner) {
        preservePositionMut(s.scratch, s.originalPos[0], s.originalPos[1], ctx.selBounds, ctx.origin, uf);
      } else {
        s.scratch[0] = scaleAround(s.originalPos[0], ctx.origin[0], ctx.sx);
        s.scratch[1] = scaleAround(s.originalPos[1], ctx.origin[1], ctx.sy);
      }
      return;
    case 'bind':
      fillFrameFromBind(s.frame, s);
      STRAIGHT.configAnchored(s.endpoint, s.frame, '', s);
      return;
  }
}

function publishStraightRoute(e: StraightRerouteEntry): void {
  invalidateWorldBBox(e.prevBbox);
  const count = STRAIGHT.routeInto(e.start.endpoint, e.end.endpoint, e.routeCtx.strokeWidth, e.pointsBuf);
  publishCount(e, count);
  invalidateWorldBBox(e.currBbox);
  copyBbox(e.currBbox, e.prevBbox);
}

// Shared bbox / validCount publish for both pipelines.
function publishCount<S>(e: RerouteEntryBase<S>, count: number): void {
  if (count < 2) {
    e.validCount = -1;
    copyBbox(e.originalBbox, e.currBbox);
    return;
  }
  e.validCount = count;
  computeConnectorBBoxFromPointsInto(e.pointsBuf, count, e.routeCtx.strokeWidth, e.routeCtx.startCap, e.routeCtx.endCap, e.currBbox);
}

// ============================================================================
// Commit
// ============================================================================

export function commitTopology(topology: ConnectorTopology, mode: 'translate' | 'scale', dx: number, dy: number): void {
  if (mode === 'translate') {
    for (const e of topology.translates) commitTranslate(e, dx, dy);
  }
  for (const e of topology.elbowReroutes) commitReroute(e);
  for (const e of topology.straightReroutes) commitReroute(e);
}

/**
 * Commit rule (both translate and reroute): free endpoints commit a Point, bound
 * endpoints commit nothing, `points` is never committed. The bound shape's frame
 * write in the same tx triggers the observer reroute on tx end → router caches
 * the final route → consumers read the fresh cache.
 */
function commitTranslate(e: TranslateEntry, dx: number, dy: number): void {
  const y = getObjects().get(e.id);
  if (!y) return;
  if (e.frozenStart) y.set('start', [e.frozenStart[0] + dx, e.frozenStart[1] + dy] as Point);
  if (e.frozenEnd) y.set('end', [e.frozenEnd[0] + dx, e.frozenEnd[1] + dy] as Point);
}

function commitReroute<S extends ElbowSide | StraightSide>(e: RerouteEntryBase<S>): void {
  const y = getObjects().get(e.id);
  if (!y) return;
  // Free-side scratches were updated each frame by the apply loop. Clone before write —
  // Y.Map preserves references, the scratch must stay private to this gesture.
  if (e.start.kind === 'free') {
    const s = e.start.scratch;
    y.set('start', [s[0], s[1]] as Point);
  }
  if (e.end.kind === 'free') {
    const s = e.end.scratch;
    y.set('end', [s[0], s[1]] as Point);
  }
}

// ============================================================================
// Cancel
// ============================================================================

export function cancelTopology(_topology: ConnectorTopology): void {
  // Full clear matches transform.cancel — both restore idle geometry, so per-entry
  // bbox accounting buys nothing over a single base-canvas repaint.
  invalidateWorldAll();
}
