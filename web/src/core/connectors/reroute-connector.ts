/**
 * High-Level Connector Rerouting API.
 *
 * Two parallel pipelines (elbow + straight) collapsed into a single `Pipeline<E>`
 * strategy record. `connectorType` is read once at `buildRouteContext` and stored
 * as `pipeline: AnyPipeline` on the gesture-stable `RouteContext`.
 *
 * All hot-path entries write into caller-owned buffers (`*Into` family). The
 * topology owns pre-built endpoint objects and mutates them in place each frame
 * via `Pipeline.configAnchored` + scratch aliasing — no override-decoder cost
 * for canonical or bind sides. Router canonical reroute bakes endpoints fresh
 * via `bakeCanonicalEndpoint` and feeds them straight to `Pipeline.routeInto`.
 *
 *   bakeCanonicalEndpoint(P, ep, cachedRoute, side) → E
 *     Used by ConnectorRouter (per-call, fresh) + topology static-side build.
 *
 *   rerouteEndpointDragInto(ctx, slot, override, outBbox, outPoints) → count
 *     Caller: SelectTool. The non-dragged side reads Y.Map; the dragged side
 *     accepts a live SnapTarget or a free Point.
 *
 *   routeNewConnectorInto(start, end, strokeWidth, type, outPoints) → count
 *     Caller: ConnectorTool + connector-flow previews. No Y.Map read. An
 *     endpoint may be a live snap, a free point, or a VirtualAnchor — a shape
 *     not yet in the doc (the flow duplicate/sibling target).
 *
 * @module core/connectors/reroute-connector
 */

import type * as Y from 'yjs';
import { getHandle } from '@/runtime/room-runtime';
import { getConnectorType, getEndCap, getHandleShapeType, getStartCap, getWidth } from '../accessors';
import { computeConnectorBBoxFromPointsInto } from '../geometry/bbox';
import { frameOf } from '../geometry/frame-of';
import type { BBoxTuple, FrameTuple, Point } from '../types/geometry';
import type { ConnectorEndpoint, StoredStraightAnchor } from '../types/objects';
import { fillElbowAnchorPointInto } from './anchor-atoms';
import { getConnectorRoute } from './connector-router';
import { computeElbowFreeEndDir, oppositeDir, resolveElbowFreeStartDir } from './connector-utils';
import { EDGE_CLEARANCE_W } from './constants';
import { computeAStarRouteInto } from './routing-astar';
import { fillAnchorPoint, projectAnchorToEdge, rayShapeExitPoint } from './shape-geometry';
import type { ConnectorCap, ConnectorType, Dir, SnapTarget } from './types';

/*
 * INVARIANTS — DO NOT BREAK
 * 1. Module scratches in this file and in routing-context.ts/routing-astar.ts are
 *    NOT re-entrant. *Into entries are synchronous; no caller may invoke them
 *    recursively from within an A* hop or a Y.Doc observer reentry.
 * 2. `Pipeline.newFree(pos)` preserves the input `pos` reference — `endpoint.pos === pos`.
 *    Topology free sides exploit this to alias the side scratch into endpoint.pos;
 *    callers wanting isolation clone before calling.
 * 3. `Pipeline.newAnchored(frame, ...)` preserves the input `frame` reference for
 *    kinds that carry a `frame` field (ELBOW anchored, STRAIGHT interior). Topology
 *    bind sides exploit this to alias side.frame to endpoint.frame.
 * 4. `outPoints` is mutated in place via find-or-push tuple reuse. Its `.length`
 *    may exceed the returned `validCount` (high-water mark). All consumers MUST
 *    iterate by `count`, never `.length` / `for...of`.
 * 5. `connectorType` is read ONCE inside `buildRouteContext` and stored as
 *    `pipeline: AnyPipeline`. Below the entry boundary, every helper is parametric
 *    in `E` (ELBOW xor STRAIGHT) — no string comparisons, no type threading.
 */

// Module-level scratches for projection (synchronous reroute path; not re-entrant).
const PROJECT_EDGE: Point = [0, 0];
const PROJECT_NORMAL: Point = [0, 0];

// Straight pipeline scratches. STRAIGHT_RAY_DIR / STRAIGHT_RAY_EXIT consumed
// sequentially per side inside resolveStraightVisibleEndpoint — never aliased
// into the result. STRAIGHT_PT_START / STRAIGHT_PT_END hold the two visible
// endpoints written into the final straight route.
const STRAIGHT_RAY_DIR: Point = [0, 0];
const STRAIGHT_RAY_EXIT: Point = [0, 0];
const STRAIGHT_PT_START: Point = [0, 0];
const STRAIGHT_PT_END: Point = [0, 0];

// ============================================================================
// PUBLIC TYPES
// ============================================================================

/** Per-side override for endpoint-drag reroutes (live snap or free position). */
export type EndpointDragOverride = SnapTarget | Point;

/**
 * A routing endpoint for a shape not yet in the doc — the target of a
 * connector-flow duplicate/sibling preview, shown before the shape is committed.
 * Carries the frame + shapeType + normalized anchor explicitly, so routing
 * builds the exact anchored endpoint `bakeCanonicalEndpoint` will build off the
 * committed shape. Discriminated from `SnapTarget` and a free `Point` by `kind`.
 */
export interface VirtualAnchor {
  kind: 'virtual';
  frame: FrameTuple;
  shapeType: string;
  anchor: Point;
}

/** A `routeNewConnectorInto` endpoint — live snap, free point, or uncreated (virtual) anchor. */
export type NewConnectorEndpointInput = SnapTarget | Point | VirtualAnchor;

/** Endpoint slot index — 0 = start, 1 = end. Used by drag-style entry. */
export type Slot = 0 | 1;
export const SLOT_START: Slot = 0;
export const SLOT_END: Slot = 1;
/** Map slot to its Y.Map field name. Only used at the storage boundary. */
export const slotKey = (s: Slot): 'start' | 'end' => (s === 0 ? 'start' : 'end');
/** The opposite slot. */
export const slotOther = (s: Slot): Slot => (1 - s) as Slot;
/** Branchless: index of the slot's point in a `count`-length polyline (start → 0, end → count - 1). */
export const slotPointIndex = (s: Slot, count: number): number => s * (count - 1);

// ============================================================================
// INTERNAL ENDPOINT TYPES — discriminated unions, no optional fields
// ============================================================================

/**
 * Elbow endpoint. Carries direction (cardinal escape) and frame (obstacle bounds
 * passed to A*). Anchored variant has both; free has only position.
 */
export type ElbowEndpoint = { kind: 'free'; pos: Point } | { kind: 'anchored'; pos: Point; dir: Dir; frame: FrameTuple };

/**
 * Straight endpoint. Three states:
 *   free     — no shape attachment.
 *   edge     — anchored on the shape's boundary; visible position is `pos`
 *              minus an along-line pull-back.
 *   interior — anchored inside the shape; needs ray-cast to derive the visible
 *              edge exit, plus the same along-line pull-back.
 *
 * Same-shape interior pairs are detected at the route level (see
 * `computeStraightRouteInto`) — `shapeId` exists only on the `interior` variant.
 */
export type StraightEndpoint =
  | { kind: 'free'; pos: Point }
  | { kind: 'edge'; pos: Point }
  | { kind: 'interior'; pos: Point; frame: FrameTuple; shapeType: string; shapeId: string };

/** Source-form for an anchored endpoint, normalized across stored anchor + snap target. */
export interface AnchorSource {
  anchor: Point;
  shapeId: string;
  /** Straight-only; ignored by the elbow factory. */
  interior: boolean;
}

// ============================================================================
// PIPELINE STRATEGY (one record per connector type)
// ============================================================================

export interface Pipeline<E> {
  /**
   * Free-endpoint factory. Preserves the input `pos` reference — `endpoint.pos === pos`
   * after construction (callers wanting aliasing pass the side scratch; callers wanting
   * isolation clone before calling).
   */
  newFree(pos: Point): E;
  /**
   * Anchored-endpoint factory. Preserves the input `frame` reference for the kinds that
   * carry a `frame` field (ELBOW anchored, STRAIGHT interior) — same alias-friendly
   * contract as `newFree`.
   */
  newAnchored(frame: FrameTuple, shapeType: string, src: AnchorSource): E;
  /**
   * Per-frame mutator for an existing anchored endpoint. Endpoint variant kind is frozen
   * at construction (ELBOW: 'anchored'; STRAIGHT: 'edge' or 'interior' per stored
   * `interior`); callers pass an endpoint produced by `newAnchored`. Writes are
   * alias-safe: `out.frame[i] = frame[i]` is a no-op when `out.frame === frame`.
   */
  configAnchored(out: E, frame: FrameTuple, shapeType: string, src: AnchorSource): void;
  /** Writes into outPoints (find-or-push). Returns valid count, or -1 on failure. */
  routeInto(start: E, end: E, strokeWidth: number, outPoints: Point[]): number;
}

export const ELBOW: Pipeline<ElbowEndpoint> = {
  newFree: (pos) => ({ kind: 'free', pos }),
  newAnchored: (frame, shapeType, s) => {
    const dir = projectAnchorToEdge(s.anchor, frame, shapeType, PROJECT_EDGE, PROJECT_NORMAL);
    const pos: Point = [0, 0];
    fillElbowAnchorPointInto(pos, s.anchor, frame, dir);
    return { kind: 'anchored', pos, dir, frame };
  },
  configAnchored: (out, frame, shapeType, src) => {
    if (out.kind !== 'anchored') return;
    const dir = projectAnchorToEdge(src.anchor, frame, shapeType, PROJECT_EDGE, PROJECT_NORMAL);
    out.dir = dir;
    fillElbowAnchorPointInto(out.pos, src.anchor, frame, dir);
    // Alias-safe: when out.frame === frame these are self-writes.
    out.frame[0] = frame[0];
    out.frame[1] = frame[1];
    out.frame[2] = frame[2];
    out.frame[3] = frame[3];
  },
  routeInto: (start, end, strokeWidth, outPoints) => computeElbowRouteInto(start, end, strokeWidth, outPoints),
};

export const STRAIGHT: Pipeline<StraightEndpoint> = {
  newFree: (pos) => ({ kind: 'free', pos }),
  newAnchored: (frame, shapeType, s) => {
    const pos: Point = [0, 0];
    fillAnchorPoint(s.anchor, frame, pos);
    return s.interior ? { kind: 'interior', pos, frame, shapeType, shapeId: s.shapeId } : { kind: 'edge', pos };
  },
  configAnchored: (out, frame, _shapeType, src) => {
    if (out.kind === 'interior') {
      fillAnchorPoint(src.anchor, frame, out.pos);
      out.frame[0] = frame[0];
      out.frame[1] = frame[1];
      out.frame[2] = frame[2];
      out.frame[3] = frame[3];
      // shapeType / shapeId frozen at begin per invariant — not rewritten.
    } else if (out.kind === 'edge') {
      fillAnchorPoint(src.anchor, frame, out.pos);
    }
  },
  routeInto: (start, end, _strokeWidth, outPoints) => computeStraightRouteInto(start, end, outPoints),
};

export type AnyPipeline = Pipeline<ElbowEndpoint> | Pipeline<StraightEndpoint>;

// ============================================================================
// GENERIC RESOLVERS — single implementation, parametric in E
// ============================================================================

/** Defensive fallback: bound anchor with missing target frame = corrupted doc.
 *  Render at last-known position. `[0, 0]` only when there isn't even a cached route. */
function fallbackPoint(cachedRoute: Point[] | null, side: 'start' | 'end'): Point {
  if (cachedRoute && cachedRoute.length > 0) {
    const pt = side === 'start' ? cachedRoute[0] : cachedRoute[cachedRoute.length - 1];
    return [pt[0], pt[1]];
  }
  return [0, 0];
}

/**
 * Resolve a new-connector endpoint input to a pipeline endpoint.
 *  - free `Point`      → free endpoint.
 *  - `VirtualAnchor`   → anchored endpoint from the explicit frame/shapeType — no
 *                        handle lookup (the shape is not in the doc yet).
 *  - live `SnapTarget` → anchored from the target handle's live frame, or free
 *                        at the snap position if that handle is gone.
 * Shared by the endpoint-drag override and `routeNewConnectorInto`.
 */
function resolveSnap<E>(P: Pipeline<E>, input: NewConnectorEndpointInput): E {
  if (Array.isArray(input)) return P.newFree(input);
  if (input.kind === 'virtual') {
    return P.newAnchored(input.frame, input.shapeType, { anchor: input.anchor, shapeId: '', interior: false });
  }
  const handle = getHandle(input.shapeId);
  const frame = frameOf(handle);
  if (!frame) return P.newFree(input.position);
  return P.newAnchored(frame, getHandleShapeType(handle), {
    anchor: input.normalizedAnchor,
    shapeId: input.shapeId,
    interior: input.kind === 'straight' ? input.interior : false,
  });
}

/**
 * Bake a canonical endpoint from stored Y.Map data. Used by:
 *   - `ConnectorRouter.rerouteCanonical` (one-shot, fresh allocations every call)
 *   - topology builders for `kind: 'static'` (canonical-on-both-sides) and the
 *     non-driven side of a mixed-state RerouteEntry
 *
 * Frame reference is preserved (alias-friendly contract — see `Pipeline.newAnchored`).
 * Free endpoints clone the stored Point to avoid leaking a Y.Map reference into a
 * mutable scratch.
 */
export function bakeCanonicalEndpoint<E>(
  P: Pipeline<E>,
  ep: ConnectorEndpoint | undefined,
  cachedRoute: Point[] | null,
  side: 'start' | 'end',
): E {
  if (!ep) return P.newFree(fallbackPoint(cachedRoute, side));
  if (Array.isArray(ep)) return P.newFree([ep[0], ep[1]]);
  const handle = getHandle(ep.id);
  const frame = frameOf(handle);
  if (!frame) return P.newFree(fallbackPoint(cachedRoute, side));
  return P.newAnchored(frame, getHandleShapeType(handle), {
    anchor: ep.anchor,
    shapeId: ep.id,
    interior: (ep as StoredStraightAnchor).interior ?? false,
  });
}

// ============================================================================
// ELBOW ROUTE ASSEMBLY
// ============================================================================

/**
 * Resolve start + end cardinal directions for the A* path. Four explicit cases
 * over the discriminated union — TypeScript narrowing proves `dir`/`frame`
 * presence on the `'anchored'` branch.
 */
function resolveElbowDirections(start: ElbowEndpoint, end: ElbowEndpoint, strokeWidth: number): { startDir: Dir; endDir: Dir } {
  if (start.kind === 'anchored' && end.kind === 'anchored') {
    return { startDir: start.dir, endDir: end.dir };
  }
  if (start.kind === 'free' && end.kind === 'anchored') {
    const startDir = resolveElbowFreeStartDir(start.pos, { position: end.pos, outwardDir: end.dir, shapeBounds: end.frame }, strokeWidth);
    return { startDir, endDir: end.dir };
  }
  if (start.kind === 'anchored' && end.kind === 'free') {
    return { startDir: start.dir, endDir: computeElbowFreeEndDir(start.pos, end.pos) };
  }
  // both free
  const startDir = computeElbowFreeEndDir(start.pos, end.pos);
  return { startDir, endDir: oppositeDir(startDir) };
}

function computeElbowRouteInto(start: ElbowEndpoint, end: ElbowEndpoint, strokeWidth: number, outPoints: Point[]): number {
  const { startDir, endDir } = resolveElbowDirections(start, end, strokeWidth);
  return computeAStarRouteInto(
    start.pos,
    startDir,
    end.pos,
    endDir,
    start.kind === 'anchored' ? start.frame : null,
    end.kind === 'anchored' ? end.frame : null,
    strokeWidth,
    outPoints,
  );
}

// ============================================================================
// STRAIGHT ROUTE ASSEMBLY
// ============================================================================

/** Apply EDGE_CLEARANCE_W pull-back along the line from `src` toward `toward`, writing into `out`. */
function applyPullBackInto(out: Point, src: Point, toward: Point): void {
  const dx = toward[0] - src[0];
  const dy = toward[1] - src[1];
  const len = Math.hypot(dx, dy);
  if (len < 0.001) {
    out[0] = src[0];
    out[1] = src[1];
    return;
  }
  out[0] = src[0] + (dx / len) * EDGE_CLEARANCE_W;
  out[1] = src[1] + (dy / len) * EDGE_CLEARANCE_W;
}

/**
 * Resolve one endpoint of a straight route to its visible line position, written
 * into `out`. Three cases — the same-shape interior short-circuit is handled at
 * the pair level in `computeStraightRouteInto`, so this function never sees it.
 *
 *   free     → copy `me.pos`.
 *   edge     → pull-back toward `otherPos`.
 *   interior → ray-cast exit + pull-back (different shapes, by construction).
 *
 * Dashed guides for interior anchors are rendered directly from `snap` by the
 * preview/overlay layers; this function doesn't thread dash metadata.
 */
function resolveStraightVisibleEndpoint(out: Point, me: StraightEndpoint, otherPos: Point): void {
  switch (me.kind) {
    case 'free':
      out[0] = me.pos[0];
      out[1] = me.pos[1];
      return;
    case 'edge':
      applyPullBackInto(out, me.pos, otherPos);
      return;
    case 'interior':
      STRAIGHT_RAY_DIR[0] = otherPos[0] - me.pos[0];
      STRAIGHT_RAY_DIR[1] = otherPos[1] - me.pos[1];
      if (!rayShapeExitPoint(me.pos, STRAIGHT_RAY_DIR, me.frame, me.shapeType, STRAIGHT_RAY_EXIT)) {
        out[0] = me.pos[0];
        out[1] = me.pos[1];
        return;
      }
      applyPullBackInto(out, STRAIGHT_RAY_EXIT, otherPos);
      return;
  }
}

/** Write [x, y] into outPoints at index `idx` via find-or-push. Returns idx + 1. */
function writePoint(outPoints: Point[], idx: number, x: number, y: number): number {
  const slot = outPoints[idx];
  if (slot) {
    slot[0] = x;
    slot[1] = y;
  } else {
    outPoints.push([x, y]);
  }
  return idx + 1;
}

/**
 * Compute a straight-line route between two resolved endpoints, written into
 * `outPoints` via find-or-push.
 *
 * Pair-level short-circuit: both interior + same shape → straight raw-to-raw.
 * Ray-casting two interior points on one convex shape produces opposing
 * intersections (the "spinning clock" artifact).
 */
function computeStraightRouteInto(start: StraightEndpoint, end: StraightEndpoint, outPoints: Point[]): number {
  if (start.kind === 'interior' && end.kind === 'interior' && start.shapeId === end.shapeId) {
    let i = writePoint(outPoints, 0, start.pos[0], start.pos[1]);
    i = writePoint(outPoints, i, end.pos[0], end.pos[1]);
    return i;
  }

  const startRaw = start.pos;
  const endRaw = end.pos;
  resolveStraightVisibleEndpoint(STRAIGHT_PT_START, start, endRaw);
  resolveStraightVisibleEndpoint(STRAIGHT_PT_END, end, startRaw);

  // Overlap safety: if edge intersections or pullbacks produced a flipped/collapsed
  // segment (overlapping shapes, exit-point overshoot), fall back to raw positions —
  // avoids the "spinning clock" artifact.
  const rawDx = endRaw[0] - startRaw[0];
  const rawDy = endRaw[1] - startRaw[1];
  if (rawDx * rawDx + rawDy * rawDy > 0.001) {
    const visDx = STRAIGHT_PT_END[0] - STRAIGHT_PT_START[0];
    const visDy = STRAIGHT_PT_END[1] - STRAIGHT_PT_START[1];
    if (visDx * rawDx + visDy * rawDy <= 0 || Math.hypot(visDx, visDy) < EDGE_CLEARANCE_W) {
      let i = writePoint(outPoints, 0, startRaw[0], startRaw[1]);
      i = writePoint(outPoints, i, endRaw[0], endRaw[1]);
      return i;
    }
  }

  let i = writePoint(outPoints, 0, STRAIGHT_PT_START[0], STRAIGHT_PT_START[1]);
  i = writePoint(outPoints, i, STRAIGHT_PT_END[0], STRAIGHT_PT_END[1]);
  return i;
}

// ============================================================================
// ROUTE CONTEXT — built once per gesture / per call, read-only across frames
// ============================================================================

/**
 * All gesture-stable inputs the reroute pipeline needs, captured at gesture-begin
 * (topology, SelectTool drag) or per-call (router canonical reroute). Eliminates
 * per-frame Y.Map reads.
 *
 * `connectorType` is exposed as a value (not just inside `pipeline`) so callers
 * that need the discriminator for orthogonal concerns — snap target lookup,
 * preview rendering — read it without unwrapping the strategy record.
 */
export interface RouteContext {
  readonly start: ConnectorEndpoint | undefined;
  readonly end: ConnectorEndpoint | undefined;
  readonly strokeWidth: number;
  readonly startCap: ConnectorCap;
  readonly endCap: ConnectorCap;
  readonly connectorType: ConnectorType;
  readonly cachedRoute: Point[] | null;
  /** Pre-picked at build, never branched again below this boundary. */
  readonly pipeline: AnyPipeline;
}

/**
 * Build a RouteContext from canonical Y.Map state. Pass yObj directly so callers
 * never need a `getHandle(connectorId)` round-trip for the connector itself.
 */
export function buildRouteContext(connectorId: string, yObj: Y.Map<unknown>): RouteContext | null {
  const start = yObj.get('start') as ConnectorEndpoint | undefined;
  const end = yObj.get('end') as ConnectorEndpoint | undefined;
  if (!start || !end) return null;
  const t = getConnectorType(yObj);
  return {
    start,
    end,
    strokeWidth: getWidth(yObj, 2),
    startCap: getStartCap(yObj),
    endCap: getEndCap(yObj),
    connectorType: t,
    cachedRoute: getConnectorRoute(connectorId),
    pipeline: t === 'straight' ? STRAIGHT : ELBOW,
  };
}

// ============================================================================
// PUBLIC ENTRY POINTS — *Into family
// ============================================================================

/**
 * Reroute for an endpoint drag. `slot` selects which side is driven by the
 * override; the other reads canonically from `ctx`.
 *
 * Returns the valid prefix length of `outPoints`, or `-1` on routing failure.
 */
export function rerouteEndpointDragInto(
  ctx: RouteContext,
  slot: Slot,
  override: EndpointDragOverride,
  outBbox: BBoxTuple,
  outPoints: Point[],
): number {
  return runDrag(ctx.pipeline as Pipeline<unknown>, ctx, slot, override, outBbox, outPoints);
}

/**
 * Route a new connector (no Y.Map data) for creation previews — `ConnectorTool`
 * and the Select-tool connector flows. Each endpoint is a live `SnapTarget`, a
 * free `Point`, or a `VirtualAnchor` (a not-yet-created shape). Routing through
 * a `VirtualAnchor` is byte-identical to the canonical reroute the deep observer
 * runs once that shape lands — same anchored→anchored direction resolution,
 * obstacle set, and edge clearance. Allocation-free once `outPoints` is warm.
 */
export function routeNewConnectorInto(
  start: NewConnectorEndpointInput,
  end: NewConnectorEndpointInput,
  strokeWidth: number,
  connectorType: ConnectorType,
  outPoints: Point[],
): number {
  const P = (connectorType === 'straight' ? STRAIGHT : ELBOW) as Pipeline<unknown>;
  return P.routeInto(resolveSnap(P, start), resolveSnap(P, end), strokeWidth, outPoints);
}

// ============================================================================
// PARAMETRIC RUNNER — Pipeline<unknown> cast contained here
// ============================================================================

function runDrag<E>(
  P: Pipeline<E>,
  ctx: RouteContext,
  slot: Slot,
  override: EndpointDragOverride,
  outBbox: BBoxTuple,
  outPoints: Point[],
): number {
  // Drag side built from the live snap/free input; the other side is canonical
  // (no override possible for a drag — only one endpoint moves).
  const driven = resolveSnap(P, override);
  const start = slot === SLOT_START ? driven : bakeCanonicalEndpoint(P, ctx.start, ctx.cachedRoute, 'start');
  const end = slot === SLOT_END ? driven : bakeCanonicalEndpoint(P, ctx.end, ctx.cachedRoute, 'end');
  const count = P.routeInto(start, end, ctx.strokeWidth, outPoints);
  if (count < 2) return -1;
  computeConnectorBBoxFromPointsInto(outPoints, count, ctx.strokeWidth, ctx.startCap, ctx.endCap, outBbox);
  return count;
}
