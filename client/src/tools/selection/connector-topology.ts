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
 *   reroute   — mixed / scale; call rerouteTransformInto per frame with per-side overrides
 *
 * RerouteEntry hoists a `RouteContext` (cap/width/cachedRoute/pipeline frozen at
 * begin — no per-frame Y.Map reads) and owns a permanent `pointsBuf` + `validCount`
 * mutated in place each frame. Renderer iterates `pointsBuf[0..validCount)`.
 *
 * Free endpoints own a per-instance `scratch: Point` (allocated once at build, written
 * per frame). Frame-bound endpoints share slot-indexed module-level frame scratches —
 * safe because `rerouteTransformInto` allocates fresh position tuples from the frame
 * + anchor.
 */

import {
  buildRouteContext,
  type FrameOverride,
  type RouteContext,
  rerouteTransformInto,
  SLOT_END,
  SLOT_START,
  type Slot,
  type TransformOverride,
} from '@/core/connectors/reroute-connector';
import { bboxToFrameMut, copyBbox, copyFrame, offsetBBox, offsetPoint } from '@/core/geometry/bounds';
import { frameOf } from '@/core/geometry/frame-of';
import { preservePositionMut, scaleAround, uniformFactor } from '@/core/geometry/scale-system';
import type { BBoxTuple, FrameTuple, Point } from '@/core/types/geometry';
import { isCorner } from '@/core/types/handles';
import type { BindableKind, ConnectorEndpoint, ObjectHandle, StoredAnchor } from '@/core/types/objects';
import { invalidateWorldAll, invalidateWorldBBox } from '@/renderer/RenderLoop';
import { getAttachedConnectors, getHandle, getObjects } from '@/runtime/room-runtime';
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
  /** Frozen pre-gesture FREE-side endpoint. null = bound (commit skips). */
  readonly frozenStart: Point | null;
  readonly frozenEnd: Point | null;
}

export interface RerouteEntry extends DirtyEntry {
  readonly mode: 'reroute';
  /** null = canonical (no override; reroute reads Y.Map for this endpoint). */
  readonly start: Side | null;
  readonly end: Side | null;
  /** Cap/width/cachedRoute/pipeline frozen at begin — no per-frame Y.Map reads. */
  readonly routeCtx: RouteContext;
  /** Persistent buffer mutated in place each frame. `length` may exceed `validCount`. */
  readonly pointsBuf: Point[];
  /** Valid prefix length of `pointsBuf`. -1 = routing failed this frame. */
  validCount: number;
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
// Module-level scratches — slot-indexed, zero allocation per frame
// ============================================================================

const FRAME_SCRATCH: readonly [FrameTuple, FrameTuple] = [
  [0, 0, 0, 0],
  [0, 0, 0, 0],
];

// Pre-linked wrappers kept permanently bound to their frame scratches. Mutating
// the tuple mutates what rerouteTransformInto reads via `override.frame`.
// Frame overrides are safe to share: the implementation allocates fresh position
// tuples from `anchorFramePoint`/`elbowAnchorPoint`, so the frame is only read.
const FRAME_WRAP: readonly [FrameOverride, FrameOverride] = [{ frame: FRAME_SCRATCH[0] }, { frame: FRAME_SCRATCH[1] }];

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
  // Read the union directly. `start`/`end` are `ConnectorEndpoint | undefined` —
  // anchored side carries StoredAnchor, free side carries Point (or undefined for
  // partially-built connectors, which become canonical free-fallback below).
  const start = conn.y.get('start') as ConnectorEndpoint | undefined;
  const end = conn.y.get('end') as ConnectorEndpoint | undefined;
  const startAnchor = start && !Array.isArray(start) ? start : undefined;
  const endAnchor = end && !Array.isArray(end) ? end : undefined;
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
  // No originalPoints: rendering reads cached route + applies ctx.translate(dx, dy).
  if (mode === 'translate' && startState !== 'canonical' && endState !== 'canonical') {
    const ob = conn.bbox;
    // Freeze each FREE-side endpoint (bound sides commit nothing). Cloned so a Y.Map-preserved
    // ref from a prior gesture can't alias us; commit reads frozen + dx/dy (no Y.Map read).
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

  // REROUTE — everything else. Per-side overrides computed per frame.
  // RouteContext built once at begin — drives every per-frame route call.
  const routeCtx = buildRouteContext(conn.id, conn.y);
  if (!routeCtx) return; // partially-built connector — observer will reroute on next write

  const ob = conn.bbox;
  const startStoredPos = start && Array.isArray(start) ? (start as Point) : undefined;
  const endStoredPos = end && Array.isArray(end) ? (end as Point) : undefined;
  const e: RerouteEntry = {
    mode: 'reroute',
    id: conn.id,
    start: startState === 'canonical' ? null : makeSide(startAnchor, startStoredPos, selectedBindables, startState),
    end: endState === 'canonical' ? null : makeSide(endAnchor, endStoredPos, selectedBindables, endState),
    originalBbox: ob,
    currBbox: [ob[0], ob[1], ob[2], ob[3]],
    prevBbox: [ob[0], ob[1], ob[2], ob[3]],
    routeCtx,
    pointsBuf: [],
    validCount: 0,
  };
  reroutes.push(e);
  byId.set(conn.id, e);
}

function makeSide(
  anchor: StoredAnchor | undefined,
  storedPos: Point | undefined,
  selectedBindables: ReadonlyMap<string, SelectedBindable>,
  state: 'frame-bound' | 'free-moving',
): Side {
  if (state === 'frame-bound') {
    // classifyEndpoint returned 'frame-bound' only after `selectedBindables.has(anchor.id)`
    // — Map's contract guarantees the get is non-undefined.
    const sb = selectedBindables.get(anchor!.id)!;
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
    const startOv = e.start ? resolveSlotTranslate(SLOT_START, e.start, dx, dy) : null;
    const endOv = e.end ? resolveSlotTranslate(SLOT_END, e.end, dx, dy) : null;
    rerouteAndPublish(e, startOv, endOv);
  }
}

function applyReroutesScale(arr: readonly RerouteEntry[], ctx: ScaleCtx): void {
  // Hoist gesture-stable invariants out of the per-entry loop. `corner`/`uf`
  // depend only on `ctx.handleId`/`sx`/`sy` — same value for every entry this frame.
  const corner = isCorner(ctx.handleId);
  const uf = corner ? uniformFactor(ctx.sx, ctx.sy, ctx.handleId) : 0;
  for (let i = 0; i < arr.length; i++) {
    const e = arr[i];
    const startOv = e.start ? resolveSlotScale(SLOT_START, e.start, ctx, corner, uf) : null;
    const endOv = e.end ? resolveSlotScale(SLOT_END, e.end, ctx, corner, uf) : null;
    rerouteAndPublish(e, startOv, endOv);
  }
}

// Free-branch helpers — identical math across start/end; extracted so corner-uniform
// logic lives in one place and the slot-parametric resolvers stay pure dispatch.

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
 *
 * `corner` and `uf` are pre-hoisted by `applyReroutesScale` (gesture-stable).
 */
function resolveFreeScale(s: FreeSide, ctx: ScaleCtx, corner: boolean, uf: number): Point {
  if (corner) {
    preservePositionMut(s.scratch, s.originalPos[0], s.originalPos[1], ctx.selBounds, ctx.origin, uf);
  } else {
    s.scratch[0] = scaleAround(s.originalPos[0], ctx.origin[0], ctx.sx);
    s.scratch[1] = scaleAround(s.originalPos[1], ctx.origin[1], ctx.sy);
  }
  return s.scratch;
}

function resolveSlotTranslate(slot: Slot, s: Side, dx: number, dy: number): TransformOverride {
  if (s.kind === 'bind') {
    fillFrameFromBind(FRAME_SCRATCH[slot], s);
    return FRAME_WRAP[slot];
  }
  return resolveFreeTranslate(s, dx, dy);
}

function resolveSlotScale(slot: Slot, s: Side, ctx: ScaleCtx, corner: boolean, uf: number): TransformOverride {
  if (s.kind === 'bind') {
    fillFrameFromBind(FRAME_SCRATCH[slot], s);
    return FRAME_WRAP[slot];
  }
  return resolveFreeScale(s, ctx, corner, uf);
}

function rerouteAndPublish(e: RerouteEntry, startOv: TransformOverride | null, endOv: TransformOverride | null): void {
  invalidateWorldBBox(e.prevBbox);
  const count = rerouteTransformInto(e.routeCtx, startOv, endOv, e.currBbox, e.pointsBuf);
  if (count < 0) {
    // Routing failed — reset currBbox so dirty-rect accounting stays consistent
    // with what the renderer will draw (stored route at original position).
    e.validCount = -1;
    copyBbox(e.originalBbox, e.currBbox);
  } else {
    e.validCount = count;
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

/**
 * Commit rule (both translate and reroute): free endpoints commit a Point, bound
 * endpoints commit nothing, `points` is never committed. The bound shape's frame
 * write in the same tx triggers the observer reroute on tx end → router caches
 * the final route → consumers read the fresh cache.
 */
function commitTranslate(e: TranslateEntry, dx: number, dy: number): void {
  const y = getObjects().get(e.id);
  if (!y) return;
  // Free side → frozen + dx/dy. Bound side → skip (the bound shape's frame write
  // in this tx triggers observer reroute → router caches the new route).
  if (e.frozenStart) y.set('start', [e.frozenStart[0] + dx, e.frozenStart[1] + dy] as Point);
  if (e.frozenEnd) y.set('end', [e.frozenEnd[0] + dx, e.frozenEnd[1] + dy] as Point);
}

function commitReroute(e: RerouteEntry): void {
  const y = getObjects().get(e.id);
  if (!y) return;
  // Free-side scratches were updated each frame by resolveFreeScale/resolveFreeTranslate.
  // Bound-side commits skipped — the bound bindable's commit (frame/origin/scale) writes
  // its own change, which the observer turns into a propagation → rerouteIds → canonical reroute.
  if (e.start && e.start.kind === 'free') y.set('start', [e.start.scratch[0], e.start.scratch[1]] as Point);
  if (e.end && e.end.kind === 'free') y.set('end', [e.end.scratch[0], e.end.scratch[1]] as Point);
}

// ============================================================================
// Cancel
// ============================================================================

export function cancelTopology(_topology: ConnectorTopology): void {
  // Full clear matches transform.cancel — both restore idle geometry, so per-entry
  // bbox accounting buys nothing over a single base-canvas repaint.
  invalidateWorldAll();
}
