/**
 * Connector Topology — begin-phase classifier + per-frame apply/commit/cancel.
 *
 * Tightly coupled to `transform.ts` (imports `Entry<K>` + `ScaleCtx` type-only).
 * Every classification decision is made at begin; per-frame apply is pure dispatch
 * over pre-built variant rows with zero allocation.
 *
 * Variants (discriminated by `mode`):
 *   static    — both endpoints canonical; no apply, no commit; renderer draws in-place
 *   translate — both endpoints move together; rigid polyline + bbox shift
 *   reroute   — mixed / scale; call rerouteConnector per frame with per-side overrides
 *
 * Frame-bound endpoint resolution derives the bound bindable's anchor frame from
 * whatever `entry.out.*` apply just wrote (+ frozenFrame cache for note/bookmark
 * only). No apply-path changes required in transform.ts beyond two surgical
 * extensions (see applyOffset + freezeTranslateEntry note/bookmark branch).
 */

import type { BBoxTuple, FrameTuple, Point } from '@/core/types/geometry';
import type { ObjectHandle, BindableKind, StoredAnchor } from '@/core/types/objects';
import type { Entry } from './transform';
import type { ScaleCtx } from './types';

import { offsetBBox, copyBbox, offsetPoint, copyFrame, bboxToFrameMut } from '@/core/geometry/bounds';
import { scaleAround } from '@/core/geometry/scale-system';
import { frameOf } from '@/core/geometry/frame-of';
import { rerouteConnector, type EndpointOverrideValue } from '@/core/connectors/reroute-connector';
import { getHandle, getConnectorsForShape, getObjects } from '@/runtime/room-runtime';
import { invalidateWorldBBox } from '@/renderer/RenderLoop';
import { getPoints, getEndpoints, getEndpointAnchors } from '@/core/accessors';

// ============================================================================
// DEBUG LOGGING — toggle TOPO_DEBUG to disable. Grep `[TOPO:` in console to filter.
// ============================================================================
const TOPO_DEBUG = true;
let _applyLogCount = 0;
function tlog(tag: string, data: Record<string, unknown>): void {
  if (TOPO_DEBUG) console.log(`[TOPO:${tag}]`, data);
}
function twarn(tag: string, data: Record<string, unknown>): void {
  if (TOPO_DEBUG) console.warn(`[TOPO:${tag}]`, data);
}
/** Tag a point by its reference identity against the shared scratches. */
function aliasTag(p: Readonly<Point> | undefined | null): 'scratch_start' | 'scratch_end' | 'fresh' | 'none' {
  if (!p) return 'none';
  if (p === POINT_SCRATCH_START) return 'scratch_start';
  if (p === POINT_SCRATCH_END) return 'scratch_end';
  return 'fresh';
}

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
  readonly originalPos: Readonly<Point>;
};

type Side = BindSide | FreeSide;

export type StaticEntry = {
  readonly mode: 'static';
  readonly id: string;
  /** Copy of handle.bbox at begin; never mutated. */
  readonly currBbox: BBoxTuple;
};

export type TranslateEntry = {
  readonly mode: 'translate';
  readonly id: string;
  readonly originalBbox: BBoxTuple;
  /** Reference into Y.Map's points array — never mutated. */
  readonly originalPoints: readonly Point[];
  readonly currBbox: BBoxTuple;
  readonly prevBbox: BBoxTuple;
};

export type RerouteEntry = {
  readonly mode: 'reroute';
  readonly id: string;
  /** null = canonical (no override; reroute reads Y.Map for this endpoint). */
  readonly start: Side | null;
  readonly end: Side | null;
  readonly originalBbox: BBoxTuple;
  readonly currBbox: BBoxTuple;
  readonly prevBbox: BBoxTuple;
  /** Last successful reroute result; null if A* failed this frame. */
  currPoints: Point[] | null;
};

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
// the tuple mutates what rerouteConnector reads via `override.frame`.
const FRAME_WRAP_START = { frame: FRAME_SCRATCH_START };
const FRAME_WRAP_END = { frame: FRAME_SCRATCH_END };

const POINT_SCRATCH_START: Point = [0, 0];
const POINT_SCRATCH_END: Point = [0, 0];

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
      // TODO: when italic-overhang widening lands in computeTextBBox, out.bbox will
      // no longer coincide with the visual frame — switch to a layout-derived path.
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

      const attached = getConnectorsForShape(id);
      if (!attached) return;
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

      _applyLogCount = 0;
      let staticCount = 0;
      for (const e of byId.values()) if (e.mode === 'static') staticCount++;
      tlog('begin', {
        mode,
        bindables: selectedBindables.size,
        selConn: selectedConnectors.length,
        attachedConn: attachedIds.size,
        static: staticCount,
        translates: translates.length,
        reroutes: reroutes.length,
      });

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
  // free-moving — this is where cross-gesture scratch aliasing would surface:
  // if storedPos === POINT_SCRATCH_*, the previous commit's ref was preserved by Y.Map.
  const pos = storedPos ?? ZERO_POINT;
  const alias = aliasTag(pos);
  if (alias === 'scratch_start' || alias === 'scratch_end') {
    twarn('side.free.ALIAS', { val: [pos[0], pos[1]], aliases: alias });
  } else {
    tlog('side.free', { val: [pos[0], pos[1]] });
  }
  return { kind: 'free', originalPos: pos };
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
  _applyLogCount++;
  // Throttle: first 3 frames of gesture + every 20th after, to catch trajectory without flood.
  if (arr.length > 0 && (_applyLogCount <= 3 || _applyLogCount % 20 === 0)) {
    const e0 = arr[0];
    tlog('apply.translate', {
      frame: _applyLogCount,
      count: arr.length,
      dx,
      dy,
      scratchStart: [POINT_SCRATCH_START[0], POINT_SCRATCH_START[1]],
      scratchEnd: [POINT_SCRATCH_END[0], POINT_SCRATCH_END[1]],
      // Check whether the first entry's *published* start endpoint aliases a scratch —
      // if 'scratch_start' or 'scratch_end', the entry is already contaminated.
      e0_firstAlias: aliasTag(e0.currPoints?.[0]),
      e0_lastAlias: aliasTag(e0.currPoints?.[e0.currPoints.length - 1]),
      e0_first: e0.currPoints?.[0] && [e0.currPoints[0][0], e0.currPoints[0][1]],
    });
  }
}

function applyReroutesScale(arr: readonly RerouteEntry[], ctx: ScaleCtx): void {
  for (let i = 0; i < arr.length; i++) {
    const e = arr[i];
    OVERRIDES.start = e.start ? resolveStartScale(e.start, ctx) : undefined;
    OVERRIDES.end = e.end ? resolveEndScale(e.end, ctx) : undefined;
    rerouteAndPublish(e);
  }
  _applyLogCount++;
  if (arr.length > 0 && (_applyLogCount <= 3 || _applyLogCount % 20 === 0)) {
    const e0 = arr[0];
    tlog('apply.scale', {
      frame: _applyLogCount,
      count: arr.length,
      sx: ctx.sx,
      sy: ctx.sy,
      scratchStart: [POINT_SCRATCH_START[0], POINT_SCRATCH_START[1]],
      scratchEnd: [POINT_SCRATCH_END[0], POINT_SCRATCH_END[1]],
      e0_firstAlias: aliasTag(e0.currPoints?.[0]),
      e0_lastAlias: aliasTag(e0.currPoints?.[e0.currPoints.length - 1]),
      e0_first: e0.currPoints?.[0] && [e0.currPoints[0][0], e0.currPoints[0][1]],
    });
  }
}

function resolveStartTranslate(s: Side, dx: number, dy: number): EndpointOverrideValue {
  if (s.kind === 'bind') {
    fillFrameFromBind(FRAME_SCRATCH_START, s);
    return FRAME_WRAP_START;
  }
  offsetPoint(POINT_SCRATCH_START, s.originalPos as Point, dx, dy);
  return POINT_SCRATCH_START;
}

function resolveEndTranslate(s: Side, dx: number, dy: number): EndpointOverrideValue {
  if (s.kind === 'bind') {
    fillFrameFromBind(FRAME_SCRATCH_END, s);
    return FRAME_WRAP_END;
  }
  offsetPoint(POINT_SCRATCH_END, s.originalPos as Point, dx, dy);
  return POINT_SCRATCH_END;
}

function resolveStartScale(s: Side, ctx: ScaleCtx): EndpointOverrideValue {
  if (s.kind === 'bind') {
    fillFrameFromBind(FRAME_SCRATCH_START, s);
    return FRAME_WRAP_START;
  }
  POINT_SCRATCH_START[0] = scaleAround(s.originalPos[0], ctx.origin[0], ctx.sx);
  POINT_SCRATCH_START[1] = scaleAround(s.originalPos[1], ctx.origin[1], ctx.sy);
  return POINT_SCRATCH_START;
}

function resolveEndScale(s: Side, ctx: ScaleCtx): EndpointOverrideValue {
  if (s.kind === 'bind') {
    fillFrameFromBind(FRAME_SCRATCH_END, s);
    return FRAME_WRAP_END;
  }
  POINT_SCRATCH_END[0] = scaleAround(s.originalPos[0], ctx.origin[0], ctx.sx);
  POINT_SCRATCH_END[1] = scaleAround(s.originalPos[1], ctx.origin[1], ctx.sy);
  return POINT_SCRATCH_END;
}

function rerouteAndPublish(e: RerouteEntry): void {
  const hasAny = OVERRIDES.start !== undefined || OVERRIDES.end !== undefined;
  const result = rerouteConnector(e.id, hasAny ? OVERRIDES : undefined);
  invalidateWorldBBox(e.prevBbox);
  if (result) {
    copyBbox(result.bbox, e.currBbox);
    e.currPoints = result.points;
    // Surface A* straight-line fallback (or genuinely-straight connector would have length 2).
    // If your selection uses only elbow connectors and you see this, A* fully failed.
    if (result.points.length <= 2) {
      twarn('reroute.short', {
        id: e.id,
        len: result.points.length,
        first: [result.points[0][0], result.points[0][1]],
        last: [result.points[result.points.length - 1][0], result.points[result.points.length - 1][1]],
        firstAlias: aliasTag(result.points[0]),
        lastAlias: aliasTag(result.points[result.points.length - 1]),
      });
    }
  } else {
    // A* failed — reset currBbox so dirty-rect accounting stays consistent
    // with what the renderer will draw (stored route at original position).
    copyBbox(e.originalBbox, e.currBbox);
    e.currPoints = null;
    twarn('reroute.null', { id: e.id });
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
  tlog('commit.translate', {
    id: e.id,
    dx,
    dy,
    len: pts.length,
    first: [pts[0][0], pts[0][1]],
    last: [pts[pts.length - 1][0], pts[pts.length - 1][1]],
  });
  y.set('points', pts);
  y.set('start', pts[0]);
  y.set('end', pts[pts.length - 1]);
}

function commitReroute(e: RerouteEntry): void {
  const y = getObjects().get(e.id);
  if (!y) return;
  const p = e.currPoints;
  if (!p || p.length < 2) {
    twarn('commit.reroute.skip', { id: e.id, len: p == null ? 'null' : p.length });
    return;
  }
  const firstAlias = aliasTag(p[0]);
  const lastAlias = aliasTag(p[p.length - 1]);
  tlog('commit.reroute', {
    id: e.id,
    len: p.length,
    first: [p[0][0], p[0][1]],
    last: [p[p.length - 1][0], p[p.length - 1][1]],
    firstAlias,
    lastAlias,
  });
  y.set('points', p);
  y.set('start', p[0]);
  y.set('end', p[p.length - 1]);
  // One-time Yjs ref-preservation probe: if readback === the scratch we wrote,
  // Y.Map is keeping our reference alive — this is the cross-gesture aliasing vector.
  if (firstAlias !== 'fresh' && firstAlias !== 'none') {
    const readBack = y.get('start') as Readonly<Point> | undefined;
    if (readBack === p[0]) {
      twarn('commit.reroute.yjsPreservesRef', { id: e.id, alias: firstAlias });
    }
  }
}

// ============================================================================
// Cancel
// ============================================================================

export function cancelTopology(topology: ConnectorTopology): void {
  tlog('cancel', {
    translates: topology.translates.length,
    reroutes: topology.reroutes.length,
  });
  for (const e of topology.translates) {
    invalidateWorldBBox(e.prevBbox);
    invalidateWorldBBox(e.originalBbox);
  }
  for (const e of topology.reroutes) {
    invalidateWorldBBox(e.prevBbox);
    invalidateWorldBBox(e.originalBbox);
  }
}
