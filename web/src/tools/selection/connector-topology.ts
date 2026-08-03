/**
 * Connector Topology — begin-phase classifier + per-frame apply/commit/cancel.
 *
 * Tightly coupled to `transform.ts` (bind sides hold a gesture-entry index
 * `gi` into the engine's lane buffer; the buffer itself is THREADED into the
 * apply fns as a parameter so no topology→transform import exists). Every
 * classification decision is made at begin; per-frame apply is pure dispatch
 * over pre-built variant rows with zero per-frame allocation. Dirty rects go
 * through the shared damage accumulator (`transform-damage.ts`) — the gesture
 * update fns flush once per pointermove.
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
import { unionConnectorLabelRectInto } from '@/core/connectors/connector-label';
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
import { copyBbox, offsetBBox, offsetPoint } from '@/core/geometry/bounds';
import { frameOf } from '@/core/geometry/frame-of';
import { preservePositionMut, scaleAround, uniformFactor } from '@/core/geometry/scale-system';
import { getLockedFlags, getLockOwners } from '@/core/locks/lock-table';
import { getBBoxColumn } from '@/core/slots/slot-table';
import type { BBoxTuple, FrameTuple, Point } from '@/core/types/geometry';
import { isCorner } from '@/core/types/handles';
import type { BindableKind, ConnectorEndpoint, ObjectHandle, StoredAnchor, StoredStraightAnchor } from '@/core/types/objects';
import { invalidateWorldAll } from '@/renderer/RenderLoop';
import { getAttachedConnectors, getHandle, getObjects, getObjectsById } from '@/runtime/room-runtime';
import { pushDamage } from './transform-damage';
import { G_STRIDE } from './transform-kernels';
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
  /** Gesture-entry index into the engine's lane buffer (lanes threaded per frame). */
  readonly gi: number;
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
  readonly gi: number;
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
  /** The connector's slot — the engine registers it as `TOPO_TAG | entryIndex`
   *  in the sparse slot map at begin and clears it at derender. */
  readonly slot: number;
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
 * Endpoint-drag synthetic entry. Allocated ONCE as an engine-owned scratch
 * and reused across gestures — `id`, `slot`, `currBbox` slots, `pointsBuf`,
 * and `validCount` are reset per `beginEndpointDrag`. Renderer reads it via
 * `getEndpointDragEntry()`; same `mode: 'reroute'` shape as topology reroute
 * entries so the per-frame draw dispatch is identical.
 */
export interface EndpointDragEntry {
  readonly mode: 'reroute';
  /** Mutable: written by the engine on each `beginEndpointDrag`. */
  id: string;
  /** Mutable, like `id` — the dragged connector's object slot. */
  slot: number;
  readonly currBbox: BBoxTuple;
  readonly pointsBuf: Point[];
  validCount: number;
}

export type ConnectorEntry = StaticEntry | TranslateEntry | ElbowRerouteEntry | StraightRerouteEntry | EndpointDragEntry;

export type ConnectorTopology = {
  /** All entries in registration order (selected first, then attached) — the
   *  engine registers entry i as `TOPO_TAG | i` in the sparse slot map; the
   *  renderer routes through that, so no id-keyed lookup exists. */
  readonly entries: readonly ConnectorEntry[];
  readonly translates: readonly TranslateEntry[];
  readonly elbowReroutes: readonly ElbowRerouteEntry[];
  readonly straightReroutes: readonly StraightRerouteEntry[];
  /** Non-selected connectors whose endpoints bind to a selected bindable.
   *  Exactly ONE consumer: the engine's injectIds push for LOCK acquisition —
   *  it must be the FULL attached set (an attached connector whose entry
   *  construction bailed is still lock-acquired). The renderer never sees it. */
  readonly attachedConnectorIds: ReadonlySet<string>;
};

// ============================================================================
// Endpoint classifier
// ============================================================================

type EndpointState = 'canonical' | 'frame-bound' | 'free-moving';

type SelectedBindable = {
  readonly kind: BindableKind;
  /** Gesture-entry index into the engine's lane buffer. */
  readonly gi: number;
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
 * Fill `scratch` with the current anchor frame of the bind target, read off
 * the engine's lane buffer at `side.gi` (lanes threaded per frame — no
 * topology→transform import). Mode-agnostic: whatever the kernels just wrote
 * is what we read.
 *   shape/image → oAux IS the live frame
 *   text/code   → oBBox read as a frame (out bboxes are tight for these kinds)
 *   note/bkmk   → ratio = oAux2/fAux2 (OFFSET's aux-copy gives ratio=1 under
 *                 translate/edgePin), dims = frozenFrame × ratio
 */
function fillFrameFromBind(scratch: FrameTuple, side: ElbowBindSide | StraightBindSide, lanes: Float64Array): void {
  const b = side.gi * G_STRIDE;
  switch (side.bindKind) {
    case 'shape':
    case 'image': {
      scratch[0] = lanes[b + 12];
      scratch[1] = lanes[b + 13];
      scratch[2] = lanes[b + 14];
      scratch[3] = lanes[b + 15];
      return;
    }
    case 'text':
    case 'code': {
      scratch[0] = lanes[b + 8];
      scratch[1] = lanes[b + 9];
      scratch[2] = lanes[b + 10] - lanes[b + 8];
      scratch[3] = lanes[b + 11] - lanes[b + 9];
      return;
    }
    case 'note':
    case 'bookmark': {
      const ratio = lanes[b + 14] / lanes[b + 6];
      const fz = side.frozenFrame!;
      scratch[0] = lanes[b + 12];
      scratch[1] = lanes[b + 13];
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
      gi: sb.gi,
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
      gi: sb.gi,
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
  onSelectedBindable(id: string, kind: BindableKind, gi: number, handle: ObjectHandle): void;
  finalize(): ConnectorTopology | null;
}

export function newTopologyBuilder(mode: 'translate' | 'scale', selectedIdSet: ReadonlySet<string>): TopologyBuilder {
  const selectedBindables = new Map<string, SelectedBindable>();
  const selectedConnectors: ObjectHandle[] = [];
  const attachedIds = new Set<string>();
  const lo = getLockOwners();

  return {
    onSelectedConnector(_id, handle) {
      selectedConnectors.push(handle);
    },

    onSelectedBindable(id, kind, gi, handle) {
      // Check connectors first — `selectedBindables` is only consulted when a connector
      // endpoint's anchor.id lands here, and that can only happen for connectors in this
      // shape's attached set. No attached → the frame freeze + map entry are unreachable.
      const attached = getAttachedConnectors(id);
      if (!attached || attached.size === 0) return;

      let frozenFrame: FrameTuple | null = null;
      if (kind === 'note' || kind === 'bookmark') {
        // note/bookmark frames are populated during hydrate and only become null after delete,
        // which can't happen for a selected handle mid-begin. Non-null assertion is sound here.
        // (Bookmark height isn't in the lanes — the frozen clone stays load-bearing.)
        const f = frameOf(handle)!;
        frozenFrame = [f[0], f[1], f[2], f[3]];
      }
      selectedBindables.set(id, { kind, gi, frozenFrame });

      for (const cid of attached) {
        if (selectedIdSet.has(cid)) continue;
        // A remote-locked attached connector never enters the topology (no entry, no
        // injectIds via the controller) — it renders on the normal background path and
        // its route heals via the observer's cache-only reroute at our commit.
        const h = getHandle(cid);
        if (!h || lo[h.slot] > 1) continue;
        attachedIds.add(cid);
      }
    },

    finalize() {
      const entries: ConnectorEntry[] = [];
      const translates: TranslateEntry[] = [];
      const elbowReroutes: ElbowRerouteEntry[] = [];
      const straightReroutes: StraightRerouteEntry[] = [];

      for (const handle of selectedConnectors) {
        processConnector(handle, true, mode, selectedBindables, translates, elbowReroutes, straightReroutes, entries);
      }
      for (const cid of attachedIds) {
        const h = getHandle(cid);
        if (h?.kind !== 'connector') continue;
        processConnector(h, false, mode, selectedBindables, translates, elbowReroutes, straightReroutes, entries);
      }

      if (entries.length === 0) return null;

      return { entries, translates, elbowReroutes, straightReroutes, attachedConnectorIds: attachedIds };
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
  entries: ConnectorEntry[],
): void {
  const start = conn.y.get('start') as ConnectorEndpoint | undefined;
  const end = conn.y.get('end') as ConnectorEndpoint | undefined;
  const startAnchor = start && !Array.isArray(start) ? start : undefined;
  const endAnchor = end && !Array.isArray(end) ? end : undefined;
  const startState = classifyEndpoint(startAnchor, isSelected, selectedBindables);
  const endState = classifyEndpoint(endAnchor, isSelected, selectedBindables);
  const col = getBBoxColumn();
  const o4 = conn.slot * 4;

  // STATIC — both endpoints canonical. Only selected connectors enter topology.
  if (startState === 'canonical' && endState === 'canonical') {
    if (!isSelected) return;
    entries.push({ mode: 'static', id: conn.id, slot: conn.slot, currBbox: [col[o4], col[o4 + 1], col[o4 + 2], col[o4 + 3]] });
    return;
  }

  // TRANSLATE-ONLY — both endpoints move rigidly under translate gesture.
  if (mode === 'translate' && startState !== 'canonical' && endState !== 'canonical') {
    const frozenStart = start && Array.isArray(start) ? ([start[0], start[1]] as Point) : null;
    const frozenEnd = end && Array.isArray(end) ? ([end[0], end[1]] as Point) : null;
    // originalBbox is CLONED from the column, never aliased to live geometry:
    // a peer moving a non-selected anchor shape mid-gesture reroutes this
    // connector (reroute is lock-agnostic) and upsertHandle rewrites the lane
    // in place — an alias would corrupt the frozen begin-time baseline the
    // per-frame translate and cancel restore read.
    const e: TranslateEntry = {
      mode: 'translate',
      id: conn.id,
      slot: conn.slot,
      originalBbox: [col[o4], col[o4 + 1], col[o4 + 2], col[o4 + 3]],
      currBbox: [col[o4], col[o4 + 1], col[o4 + 2], col[o4 + 3]],
      prevBbox: [col[o4], col[o4 + 1], col[o4 + 2], col[o4 + 3]],
      frozenStart,
      frozenEnd,
    };
    translates.push(e);
    entries.push(e);
    return;
  }

  // REROUTE — partition by connectorType for monomorphic apply loops.
  const routeCtx = buildRouteContext(conn.id, conn.y);
  if (!routeCtx) return; // partially-built connector — observer will reroute on next write

  if (routeCtx.connectorType === 'straight') {
    const startSide = buildStraightSide(start, startAnchor, startState, selectedBindables, routeCtx.cachedRoute, 'start');
    const endSide = buildStraightSide(end, endAnchor, endState, selectedBindables, routeCtx.cachedRoute, 'end');
    if (!startSide || !endSide) return;
    const e: StraightRerouteEntry = {
      mode: 'reroute',
      id: conn.id,
      slot: conn.slot,
      start: startSide,
      end: endSide,
      originalBbox: [col[o4], col[o4 + 1], col[o4 + 2], col[o4 + 3]], // cloned — see TranslateEntry note
      currBbox: [col[o4], col[o4 + 1], col[o4 + 2], col[o4 + 3]],
      prevBbox: [col[o4], col[o4 + 1], col[o4 + 2], col[o4 + 3]],
      routeCtx,
      pointsBuf: [],
      validCount: 0,
    };
    straightReroutes.push(e);
    entries.push(e);
  } else {
    const startSide = buildElbowSide(start, startAnchor, startState, selectedBindables, routeCtx.cachedRoute, 'start');
    const endSide = buildElbowSide(end, endAnchor, endState, selectedBindables, routeCtx.cachedRoute, 'end');
    if (!startSide || !endSide) return;
    const e: ElbowRerouteEntry = {
      mode: 'reroute',
      id: conn.id,
      slot: conn.slot,
      start: startSide,
      end: endSide,
      originalBbox: [col[o4], col[o4 + 1], col[o4 + 2], col[o4 + 3]], // cloned — see TranslateEntry note
      currBbox: [col[o4], col[o4 + 1], col[o4 + 2], col[o4 + 3]],
      prevBbox: [col[o4], col[o4 + 1], col[o4 + 2], col[o4 + 3]],
      routeCtx,
      pointsBuf: [],
      validCount: 0,
    };
    elbowReroutes.push(e);
    entries.push(e);
  }
}

// ============================================================================
// Per-frame apply — monomorphic per pipeline
// ============================================================================

export function runTopologyTranslate(topology: ConnectorTopology, dx: number, dy: number, lanes: Float64Array): void {
  applyTranslates(topology.translates, dx, dy);
  applyElbowReroutesTranslate(topology.elbowReroutes, dx, dy, lanes);
  applyStraightReroutesTranslate(topology.straightReroutes, dx, dy, lanes);
}

export function runTopologyScale(topology: ConnectorTopology, ctx: ScaleCtx, lanes: Float64Array): void {
  // `corner`/`uf` depend only on `ctx.handleId`/`sx`/`sy` — same value for every
  // entry this frame; hoist once across both pipelines.
  const corner = isCorner(ctx.handleId);
  const uf = corner ? uniformFactor(ctx.sx, ctx.sy, ctx.handleId) : 0;
  applyElbowReroutesScale(topology.elbowReroutes, ctx, corner, uf, lanes);
  applyStraightReroutesScale(topology.straightReroutes, ctx, corner, uf, lanes);
}

function applyTranslates(arr: readonly TranslateEntry[], dx: number, dy: number): void {
  for (let i = 0; i < arr.length; i++) {
    const e = arr[i];
    pushDamage(e.prevBbox[0], e.prevBbox[1], e.prevBbox[2], e.prevBbox[3]);
    offsetBBox(e.currBbox, e.originalBbox, dx, dy);
    pushDamage(e.currBbox[0], e.currBbox[1], e.currBbox[2], e.currBbox[3]);
    copyBbox(e.currBbox, e.prevBbox);
  }
}

// ---- Elbow loops ----

function applyElbowReroutesTranslate(arr: readonly ElbowRerouteEntry[], dx: number, dy: number, lanes: Float64Array): void {
  for (let i = 0; i < arr.length; i++) {
    const e = arr[i];
    rebakeElbowSideTranslate(e.start, dx, dy, lanes);
    rebakeElbowSideTranslate(e.end, dx, dy, lanes);
    publishElbowRoute(e);
  }
}

function applyElbowReroutesScale(arr: readonly ElbowRerouteEntry[], ctx: ScaleCtx, corner: boolean, uf: number, lanes: Float64Array): void {
  for (let i = 0; i < arr.length; i++) {
    const e = arr[i];
    rebakeElbowSideScale(e.start, ctx, corner, uf, lanes);
    rebakeElbowSideScale(e.end, ctx, corner, uf, lanes);
    publishElbowRoute(e);
  }
}

function rebakeElbowSideTranslate(s: ElbowSide, dx: number, dy: number, lanes: Float64Array): void {
  switch (s.kind) {
    case 'static':
      return;
    case 'free':
      // endpoint.pos === scratch; mutating slots updates the endpoint automatically.
      offsetPoint(s.scratch, s.originalPos, dx, dy);
      return;
    case 'bind':
      // s.frame === s.endpoint.frame (alias); fillFrameFromBind writes both at once.
      fillFrameFromBind(s.frame, s, lanes);
      // configAnchored re-derives endpoint.dir + endpoint.pos in place; frame slots are
      // self-writes (alias).
      ELBOW.configAnchored(s.endpoint, s.frame, s.shapeType, s);
      return;
  }
}

function rebakeElbowSideScale(s: ElbowSide, ctx: ScaleCtx, corner: boolean, uf: number, lanes: Float64Array): void {
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
      fillFrameFromBind(s.frame, s, lanes);
      ELBOW.configAnchored(s.endpoint, s.frame, s.shapeType, s);
      return;
  }
}

function publishElbowRoute(e: ElbowRerouteEntry): void {
  pushDamage(e.prevBbox[0], e.prevBbox[1], e.prevBbox[2], e.prevBbox[3]);
  const count = ELBOW.routeInto(e.start.endpoint, e.end.endpoint, e.routeCtx.strokeWidth, e.pointsBuf);
  publishCount(e, count);
  pushDamage(e.currBbox[0], e.currBbox[1], e.currBbox[2], e.currBbox[3]);
  copyBbox(e.currBbox, e.prevBbox);
}

// ---- Straight loops ----

function applyStraightReroutesTranslate(arr: readonly StraightRerouteEntry[], dx: number, dy: number, lanes: Float64Array): void {
  for (let i = 0; i < arr.length; i++) {
    const e = arr[i];
    rebakeStraightSideTranslate(e.start, dx, dy, lanes);
    rebakeStraightSideTranslate(e.end, dx, dy, lanes);
    publishStraightRoute(e);
  }
}

function applyStraightReroutesScale(
  arr: readonly StraightRerouteEntry[],
  ctx: ScaleCtx,
  corner: boolean,
  uf: number,
  lanes: Float64Array,
): void {
  for (let i = 0; i < arr.length; i++) {
    const e = arr[i];
    rebakeStraightSideScale(e.start, ctx, corner, uf, lanes);
    rebakeStraightSideScale(e.end, ctx, corner, uf, lanes);
    publishStraightRoute(e);
  }
}

function rebakeStraightSideTranslate(s: StraightSide, dx: number, dy: number, lanes: Float64Array): void {
  switch (s.kind) {
    case 'static':
      return;
    case 'free':
      offsetPoint(s.scratch, s.originalPos, dx, dy);
      return;
    case 'bind':
      // Interior: s.frame === s.endpoint.frame (alias). Edge: s.frame is standalone scratch
      // fed into STRAIGHT.configAnchored which writes endpoint.pos via fillAnchorPoint.
      fillFrameFromBind(s.frame, s, lanes);
      STRAIGHT.configAnchored(s.endpoint, s.frame, '', s);
      return;
  }
}

function rebakeStraightSideScale(s: StraightSide, ctx: ScaleCtx, corner: boolean, uf: number, lanes: Float64Array): void {
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
      fillFrameFromBind(s.frame, s, lanes);
      STRAIGHT.configAnchored(s.endpoint, s.frame, '', s);
      return;
  }
}

function publishStraightRoute(e: StraightRerouteEntry): void {
  pushDamage(e.prevBbox[0], e.prevBbox[1], e.prevBbox[2], e.prevBbox[3]);
  const count = STRAIGHT.routeInto(e.start.endpoint, e.end.endpoint, e.routeCtx.strokeWidth, e.pointsBuf);
  publishCount(e, count);
  pushDamage(e.currBbox[0], e.currBbox[1], e.currBbox[2], e.currBbox[3]);
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
  // Label dims are frozen during a drag — only the midpoint moves; union the live
  // rect so the dirty rect tracks the label as the route reroutes (zero alloc).
  unionConnectorLabelRectInto(e.id, e.pointsBuf, count, e.currBbox);
}

// ============================================================================
// Commit
// ============================================================================

export function commitTopology(topology: ConnectorTopology, mode: 'translate' | 'scale', dx: number, dy: number): void {
  // Same loser-heal as transform.commit(): skip entries a peer locked mid-gesture,
  // plus durably-locked connectors (lock landed in the same race window).
  const lo = getLockOwners();
  const lf = getLockedFlags();
  const byId = getObjectsById();
  const lockedElsewhere = (id: string): boolean => {
    const h = byId.get(id);
    return h !== undefined && (lo[h.slot] > 1 || lf[h.slot] === 1);
  };
  if (mode === 'translate') {
    for (const e of topology.translates) {
      if (lockedElsewhere(e.id)) continue;
      commitTranslate(e, dx, dy);
    }
  }
  for (const e of topology.elbowReroutes) {
    if (lockedElsewhere(e.id)) continue;
    commitReroute(e);
  }
  for (const e of topology.straightReroutes) {
    if (lockedElsewhere(e.id)) continue;
    commitReroute(e);
  }
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
