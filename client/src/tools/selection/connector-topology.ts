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
 *   reroute   — mixed / scale; call rerouteConnector per frame with per-side overrides
 *
 * Free endpoints own a per-instance `scratch: Point` (allocated once at build, written
 * per frame). Frame-bound endpoints share module-level frame scratches — safe because
 * `rerouteConnector` allocates fresh position tuples from the frame + anchor.
 */

import { getEndpointAnchors, getEndpoints, getPoints } from '@/core/accessors';
import { type EndpointOverrideValue, rerouteConnector } from '@/core/connectors/reroute-connector';
import { bboxToFrameMut, copyBbox, copyFrame, offsetBBox, offsetPoint } from '@/core/geometry/bounds';
import { frameOf } from '@/core/geometry/frame-of';
import { preservePositionMut, scaleAround, uniformFactor } from '@/core/geometry/scale-system';
import type { BBoxTuple, FrameTuple, Point } from '@/core/types/geometry';
import { isCorner } from '@/core/types/handles';
import type { BindableKind, ObjectHandle, StoredAnchor } from '@/core/types/objects';
import { invalidateWorldAll, invalidateWorldBBox } from '@/renderer/RenderLoop';
import { getConnectorsForShape, getHandle, getObjects } from '@/runtime/room-runtime';
import type { Entry } from './transform';
import type { ScaleCtx } from './types';

// ============================================================================
// Types
// ============================================================================

type BindSide = {
  readonly kind: 'bind';
  readonly bindKind: BindableKind;
  readonly entry: Entry<BindableKind>;
  /** Non-null only for note/bookmark (fillFrameFromBind needs the frozen dims). */
  readonly frozenFrame: FrameTuple | null;
};

type FreeSide = {
  readonly kind: 'free';
  /** Independent snapshot — cloned at build so Y.Map-preserved refs can't alias us. */
  readonly originalPos: Readonly<Point>;
  /** Per-instance scratch for apply results; reused across frames for this side only. */
  readonly scratch: Point;
};

type Side = BindSide | FreeSide;

interface BaseEntry {
  readonly mode: 'static' | 'translate' | 'reroute';
  readonly id: string;
  readonly currBbox: BBoxTuple;
}

/** Entries that track dirty rects across frames (every mode except `static`). */
interface DirtyEntry extends BaseEntry {
  readonly originalBbox: BBoxTuple;
  readonly prevBbox: BBoxTuple;
}

export interface StaticEntry extends BaseEntry {
  readonly mode: 'static';
}

export interface TranslateEntry extends DirtyEntry {
  readonly mode: 'translate';
  /** Reference into Y.Map's points array — never mutated. */
  readonly originalPoints: readonly Point[];
}

export interface RerouteEntry extends DirtyEntry {
  readonly mode: 'reroute';
  /** null = canonical (no override; reroute reads Y.Map for this endpoint). */
  readonly start: Side | null;
  readonly end: Side | null;
  /** Last successful reroute result; null if A* failed this frame. */
  currPoints: Point[] | null;
}

export type ConnectorEntry = StaticEntry | TranslateEntry | RerouteEntry;

export type ConnectorTopology = {
  readonly byId: ReadonlyMap<string, ConnectorEntry>;
  readonly translates: readonly TranslateEntry[];
  readonly reroutes: readonly RerouteEntry[];
  /** selectedIds ∪ non-selected-attached-connectors (pre-deduplicated). */
  readonly injectIds: readonly string[];
};

// ============================================================================
// Module-level scratches — zero allocation per frame
// ============================================================================

const FRAME_SCRATCH_START: FrameTuple = [0, 0, 0, 0];
const FRAME_SCRATCH_END: FrameTuple = [0, 0, 0, 0];

// Pre-linked wrappers kept permanently bound to their frame scratches. Mutating
// the tuple mutates what rerouteConnector reads via `override.frame`. Frame
// overrides are safe to share: rerouteConnector allocates fresh position tuples
// from `anchorFramePoint`/`elbowAnchorPoint`, so the frame is only read.
const FRAME_WRAP_START = { frame: FRAME_SCRATCH_START };
const FRAME_WRAP_END = { frame: FRAME_SCRATCH_END };

// Shared overrides — keys set/cleared per entry; rerouteConnector reads synchronously.
const OVERRIDES: { start?: EndpointOverrideValue; end?: EndpointOverrideValue } = {};

const ZERO_POINT: Readonly<Point> = [0, 0];

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

// ============================================================================
// Frame derivation per bind-side kind
// ============================================================================

/**
 * Fill `scratch` with the current anchor frame of `side.entry`.
 * Reads only `entry.out.*` (+ optionally `entry.frozen.*` + `side.frozenFrame`).
 * Mode-agnostic: whatever apply just wrote is what we read.
 */
function fillFrameFromBind(scratch: FrameTuple, side: BindSide): void {
  const e = side.entry;
  switch (side.bindKind) {
    case 'shape':
    case 'image': {
      // Apply writes out.frame in every mode (uniform/nonUniform/edgePin/translate).
      const f = (e.out as { frame: FrameTuple }).frame;
      copyFrame(scratch, f);
      return;
    }
    case 'text':
    case 'code': {
      // out.bbox is the tight visual frame for text/code (frozen reads frameToBbox(getTextFrame));
      // dirty-rect padding lives on entry.prevBbox via fillDirty, not on out.bbox.
      bboxToFrameMut(e.out.bbox, scratch);
      return;
    }
    case 'note':
    case 'bookmark': {
      // out.bbox carries shadow padding — cannot alias as frame.
      // ratio matches renderer (objects.ts, renderScaleEntry note/bookmark branch).
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
      const attached = getConnectorsForShape(id);
      if (!attached || attached.size === 0) return;

      let frozenFrame: FrameTuple | null = null;
      if (kind === 'note' || kind === 'bookmark') {
        const f = frameOf(handle);
        // Defensive: un-hydrated note/bookmark can't serve as a frame-bound anchor.
        // Skipping here keeps attached connectors out of topology; rerouteConnector's
        // Y.Map-read path will degrade to free-endpoint gracefully.
        if (!f) return;
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
      const reroutes: RerouteEntry[] = [];

      for (const handle of selectedConnectors) {
        processConnector(handle, true, mode, selectedBindables, translates, reroutes, byId);
      }
      for (const cid of attachedIds) {
        const h = getHandle(cid);
        if (!h || h.kind !== 'connector') continue;
        processConnector(h, false, mode, selectedBindables, translates, reroutes, byId);
      }

      if (byId.size === 0) return null;

      const injectIds: string[] = [];
      for (const id of selectedIdSet) injectIds.push(id);
      for (const id of attachedIds) injectIds.push(id);

      return { byId, translates, reroutes, injectIds };
    },
  };
}

function processConnector(
  conn: ObjectHandle,
  isSelected: boolean,
  mode: 'translate' | 'scale',
  selectedBindables: ReadonlyMap<string, SelectedBindable>,
  translates: TranslateEntry[],
  reroutes: RerouteEntry[],
  byId: Map<string, ConnectorEntry>,
): void {
  const { startAnchor, endAnchor } = getEndpointAnchors(conn.y);
  const startState = classifyEndpoint(startAnchor, isSelected, selectedBindables);
  const endState = classifyEndpoint(endAnchor, isSelected, selectedBindables);

  // STATIC — both endpoints canonical. Only selected connectors enter topology;
  // non-selected static has no reason to (nothing moves).
  if (startState === 'canonical' && endState === 'canonical') {
    if (!isSelected) return;
    const e: StaticEntry = { mode: 'static', id: conn.id, currBbox: [...conn.bbox] as BBoxTuple };
    byId.set(conn.id, e);
    return;
  }

  // TRANSLATE-ONLY — both endpoints move rigidly under translate gesture.
  if (mode === 'translate' && startState !== 'canonical' && endState !== 'canonical') {
    const pts = getPoints(conn.y);
    let originalPoints: Readonly<Point[]>;
    if (pts.length > 0) {
      originalPoints = pts;
    } else {
      const { start, end } = getEndpoints(conn.y);
      originalPoints = [start ?? ZERO_POINT, end ?? ZERO_POINT] as Point[];
    }
    const ob = conn.bbox;
    const e: TranslateEntry = {
      mode: 'translate',
      id: conn.id,
      originalBbox: ob,
      originalPoints,
      currBbox: [ob[0], ob[1], ob[2], ob[3]],
      prevBbox: [ob[0], ob[1], ob[2], ob[3]],
    };
    translates.push(e);
    byId.set(conn.id, e);
    return;
  }

  // REROUTE — everything else. Per-side overrides computed per frame.
  const { start: storedStart, end: storedEnd } = getEndpoints(conn.y);
  const ob = conn.bbox;
  const e: RerouteEntry = {
    mode: 'reroute',
    id: conn.id,
    start: makeSide(startState, startAnchor, storedStart, selectedBindables),
    end: makeSide(endState, endAnchor, storedEnd, selectedBindables),
    originalBbox: ob,
    currBbox: [ob[0], ob[1], ob[2], ob[3]],
    prevBbox: [ob[0], ob[1], ob[2], ob[3]],
    currPoints: null,
  };
  reroutes.push(e);
  byId.set(conn.id, e);
}

function makeSide(
  state: EndpointState,
  anchor: StoredAnchor | undefined,
  storedPos: Point | undefined,
  selectedBindables: ReadonlyMap<string, SelectedBindable>,
): Side | null {
  if (state === 'canonical') return null;
  if (state === 'frame-bound') {
    const sb = selectedBindables.get(anchor!.id);
    if (!sb) return null;
    return { kind: 'bind', bindKind: sb.kind, entry: sb.entry, frozenFrame: sb.frozenFrame };
  }
  // free-moving — clone the stored point into an independent tuple. Y.Map may have
  // preserved a previous gesture's scratch reference (we now clone at commit too,
  // but belt-and-suspenders: any prior stored value becomes our private snapshot).
  const src = storedPos ?? ZERO_POINT;
  return { kind: 'free', originalPos: [src[0], src[1]], scratch: [0, 0] };
}

// ============================================================================
// Per-frame apply
// ============================================================================

export function runTopologyTranslate(topology: ConnectorTopology, dx: number, dy: number): void {
  applyTranslates(topology.translates, dx, dy);
  applyReroutesTranslate(topology.reroutes, dx, dy);
}

export function runTopologyScale(topology: ConnectorTopology, ctx: ScaleCtx): void {
  applyReroutesScale(topology.reroutes, ctx);
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

function applyReroutesTranslate(arr: readonly RerouteEntry[], dx: number, dy: number): void {
  for (let i = 0; i < arr.length; i++) {
    const e = arr[i];
    OVERRIDES.start = e.start ? resolveStartTranslate(e.start, dx, dy) : undefined;
    OVERRIDES.end = e.end ? resolveEndTranslate(e.end, dx, dy) : undefined;
    rerouteAndPublish(e);
  }
}

function applyReroutesScale(arr: readonly RerouteEntry[], ctx: ScaleCtx): void {
  for (let i = 0; i < arr.length; i++) {
    const e = arr[i];
    OVERRIDES.start = e.start ? resolveStartScale(e.start, ctx) : undefined;
    OVERRIDES.end = e.end ? resolveEndScale(e.end, ctx) : undefined;
    rerouteAndPublish(e);
  }
}

// Free-branch helpers — identical math across start/end; extracted so corner-uniform
// logic lives in one place and the 4 slot-specific resolvers stay pure dispatch.

function resolveFreeTranslate(s: FreeSide, dx: number, dy: number): Point {
  offsetPoint(s.scratch, s.originalPos as Point, dx, dy);
  return s.scratch;
}

/**
 * Corner handles: uniform-factor + preserve-position, so free endpoints track the
 * selection's uniform corner scale instead of stretching diagonally with independent
 * sx/sy. Matches `scaleBBoxUniform` behavior for shapes/images on corners.
 * Side handles: axis-aligned — `rawScaleFactors` hardcodes the inactive axis to 1,
 * so `scaleAround` with that axis is a no-op.
 */
function resolveFreeScale(s: FreeSide, ctx: ScaleCtx): Point {
  if (isCorner(ctx.handleId)) {
    const uf = uniformFactor(ctx.sx, ctx.sy, ctx.handleId);
    preservePositionMut(s.scratch, s.originalPos[0], s.originalPos[1], ctx.selBounds, ctx.origin, uf);
  } else {
    s.scratch[0] = scaleAround(s.originalPos[0], ctx.origin[0], ctx.sx);
    s.scratch[1] = scaleAround(s.originalPos[1], ctx.origin[1], ctx.sy);
  }
  return s.scratch;
}

function resolveStartTranslate(s: Side, dx: number, dy: number): EndpointOverrideValue {
  if (s.kind === 'bind') {
    fillFrameFromBind(FRAME_SCRATCH_START, s);
    return FRAME_WRAP_START;
  }
  return resolveFreeTranslate(s, dx, dy);
}

function resolveEndTranslate(s: Side, dx: number, dy: number): EndpointOverrideValue {
  if (s.kind === 'bind') {
    fillFrameFromBind(FRAME_SCRATCH_END, s);
    return FRAME_WRAP_END;
  }
  return resolveFreeTranslate(s, dx, dy);
}

function resolveStartScale(s: Side, ctx: ScaleCtx): EndpointOverrideValue {
  if (s.kind === 'bind') {
    fillFrameFromBind(FRAME_SCRATCH_START, s);
    return FRAME_WRAP_START;
  }
  return resolveFreeScale(s, ctx);
}

function resolveEndScale(s: Side, ctx: ScaleCtx): EndpointOverrideValue {
  if (s.kind === 'bind') {
    fillFrameFromBind(FRAME_SCRATCH_END, s);
    return FRAME_WRAP_END;
  }
  return resolveFreeScale(s, ctx);
}

function rerouteAndPublish(e: RerouteEntry): void {
  const hasAny = OVERRIDES.start !== undefined || OVERRIDES.end !== undefined;
  const result = rerouteConnector(e.id, hasAny ? OVERRIDES : undefined);
  invalidateWorldBBox(e.prevBbox);
  if (result) {
    copyBbox(result.bbox, e.currBbox);
    e.currPoints = result.points;
  } else {
    // A* failed — reset currBbox so dirty-rect accounting stays consistent
    // with what the renderer will draw (stored route at original position).
    copyBbox(e.originalBbox, e.currBbox);
    e.currPoints = null;
  }
  invalidateWorldBBox(e.currBbox);
  copyBbox(e.currBbox, e.prevBbox);
}

// ============================================================================
// Commit
// ============================================================================

export function commitTopology(topology: ConnectorTopology, mode: 'translate' | 'scale', dx: number, dy: number): void {
  if (mode === 'translate') {
    for (const e of topology.translates) commitTranslate(e, dx, dy);
  }
  for (const e of topology.reroutes) commitReroute(e);
}

function commitTranslate(e: TranslateEntry, dx: number, dy: number): void {
  const y = getObjects().get(e.id);
  if (!y) return;
  const src = e.originalPoints;
  const pts: Point[] = new Array(src.length);
  for (let i = 0; i < src.length; i++) pts[i] = [src[i][0] + dx, src[i][1] + dy];
  y.set('points', pts);
  y.set('start', pts[0]);
  y.set('end', pts[pts.length - 1]);
}

function commitReroute(e: RerouteEntry): void {
  const y = getObjects().get(e.id);
  if (!y) return;
  const p = e.currPoints;
  if (!p || p.length < 2) return;
  // Clone endpoints so Y.Map never holds a reference that we (or any future topology
  // reroute path) might mutate on a subsequent gesture. Interior points are fresh
  // from A*/simplify, so `points` array can be stored as-is.
  y.set('points', p);
  y.set('start', [p[0][0], p[0][1]]);
  y.set('end', [p[p.length - 1][0], p[p.length - 1][1]]);
}

// ============================================================================
// Cancel
// ============================================================================

export function cancelTopology(_topology: ConnectorTopology): void {
  // Full clear matches transform.cancel — both restore idle geometry, so per-entry
  // bbox accounting buys nothing over a single base-canvas repaint.
  invalidateWorldAll();
}
