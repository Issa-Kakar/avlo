/**
 * High-Level Connector Rerouting API.
 *
 * Two parallel pipelines (elbow + straight) share a single Y.Map fetch
 * (`readContext`). Each public entry reads `connectorType` once, branches
 * once, and dispatches to a type-specific path. Internal endpoint types
 * are discriminated unions carrying only the fields each path actually
 * uses — no fat shared `ResolvedEndpoint`, no `connectorType` threaded
 * into resolvers, no defensive nullability.
 *
 *   rerouteConnectorEndpointDrag(id, endpoint, override)
 *     Caller: SelectTool. The non-dragged side reads Y.Map; the dragged side
 *     accepts a live SnapTarget or a free Point.
 *
 *   rerouteConnectorTransform(id, startOverride, endOverride)
 *     Caller: connector-topology + ConnectorRouter. Each side:
 *     FrameOverride | Point | null. ConnectorRouter passes (null, null) for
 *     canonical reroute. No SnapTarget branch — transform paths never feed snap.
 *
 *   routeNewConnector(start, end, strokeWidth, type)
 *     Caller: ConnectorTool (creation). No Y.Map read.
 *
 * @module lib/connectors/reroute-connector
 */

import type * as Y from 'yjs';
import { getHandle } from '@/runtime/room-runtime';
import { getConnectorProps, getHandleShapeType } from '../accessors';
import { computeConnectorBBoxFromPoints } from '../geometry/bbox';
import { frameOf } from '../geometry/frame-of';
import type { BBoxTuple, FrameTuple, Point } from '../types/geometry';
import type { ConnectorEndpoint, StoredStraightAnchor } from '../types/objects';
import { anchorFramePoint, elbowAnchorPoint } from './anchor-atoms';
import { getConnectorRoute } from './connector-router';
import { computeElbowFreeEndDir, oppositeDir, resolveElbowFreeStartDir } from './connector-utils';
import { EDGE_CLEARANCE_W } from './constants';
import { computeAStarRoute } from './routing-astar';
import { projectAnchorToEdge, rayShapeExitPoint } from './shape-geometry';
import type { ConnectorType, Dir, SnapTarget } from './types';

/*
 * INVARIANTS — DO NOT BREAK
 * 1. Module scratches in this file and in routing-context.ts/routing-astar.ts are
 *    NOT re-entrant. rerouteConnector* is synchronous; no caller may invoke it
 *    recursively from within an A* hop or a Y.Doc observer reentry.
 * 2. Frame overrides are read-only. The implementation only reads override.frame
 *    via fillAnchorPoint / fillCardinal (each writes a fresh Point output).
 * 3. Free-position overrides (Point) MAY be aliased into points[0] / points[last]
 *    of the result. Callers persisting to Y.Map must clone endpoints. Callers
 *    sharing a Point across multiple reroute calls in one apply pass must use
 *    per-side scratch (see connector-topology.ts FreeSide.scratch).
 * 4. The final route Point[] is freshly allocated on every call. All other arrays
 *    in the elbow pipeline (cells, gScores, fScores, pathCells, xLines, yLines)
 *    are module-pool-owned and reused next call.
 * 5. `connectorType` is read once (in readContext) and branched on once at the
 *    top of every public entry. It is never threaded into resolvers, factories,
 *    route assemblers, or per-side helpers — each pipeline operates on its own
 *    typed endpoint union (ElbowEndpoint xor StraightEndpoint).
 */

// Module-level scratches for projection (synchronous reroute path; not re-entrant).
const PROJECT_EDGE: Point = [0, 0];
const PROJECT_NORMAL: Point = [0, 0];

// Straight pipeline scratches. STRAIGHT_RAY_DIR / STRAIGHT_RAY_EXIT consumed
// sequentially per side inside resolveStraightVisibleEndpoint — never aliased
// into the result. STRAIGHT_PT_START / STRAIGHT_PT_END hold the two visible
// endpoints returned in the final straight route.
const STRAIGHT_RAY_DIR: Point = [0, 0];
const STRAIGHT_RAY_EXIT: Point = [0, 0];
const STRAIGHT_PT_START: Point = [0, 0];
const STRAIGHT_PT_END: Point = [0, 0];

// ============================================================================
// PUBLIC TYPES
// ============================================================================

/** Override that reapplies a connector's stored anchor against a transformed frame. */
export type FrameOverride = { frame: FrameTuple };

/** Per-side override for transform-driven reroutes (translate/scale shape gestures). */
export type TransformOverride = FrameOverride | Point;

/** Per-side override for endpoint-drag reroutes (live snap or free position). */
export type EndpointDragOverride = SnapTarget | Point;

/**
 * Result of a connector reroute operation.
 */
export interface RerouteResult {
  /** Routed path points */
  points: Point[];
  /** Bounding box of the routed path (with arrow/stroke padding) */
  bbox: BBoxTuple;
}

/** Result from routeNewConnector — just the routed path. */
export interface NewRouteResult {
  points: Point[];
}

// ============================================================================
// INTERNAL ENDPOINT TYPES — discriminated unions, no optional fields
// ============================================================================

/**
 * Elbow endpoint. Carries direction (cardinal escape) and frame (obstacle bounds
 * passed to A*). Anchored variant has both; free has only position.
 */
type ElbowEndpoint = { kind: 'free'; pos: Point } | { kind: 'anchored'; pos: Point; dir: Dir; frame: FrameTuple };

/**
 * Straight endpoint. Three states:
 *   free     — no shape attachment.
 *   edge     — anchored on the shape's boundary; visible position is `pos`
 *              minus an along-line pull-back.
 *   interior — anchored inside the shape; needs ray-cast to derive the visible
 *              edge exit, plus the same along-line pull-back.
 *
 * Same-shape interior pairs are detected at the route level (see
 * `computeStraightRoute`) — `shapeId` exists only on the `interior` variant.
 */
type StraightEndpoint =
  | { kind: 'free'; pos: Point }
  | { kind: 'edge'; pos: Point }
  | { kind: 'interior'; pos: Point; frame: FrameTuple; shapeType: string; shapeId: string };

// ============================================================================
// ANCHORED FACTORIES (one per pipeline)
// ============================================================================

/**
 * Elbow: derive `dir` from `(anchor + frame + shapeType)` via `projectAnchorToEdge`,
 * then place position at `EDGE_CLEARANCE_W` outward along that cardinal.
 */
function buildElbowAnchored(frame: FrameTuple, shapeType: string, anchor: Point): ElbowEndpoint {
  const dir = projectAnchorToEdge(anchor, frame, shapeType, PROJECT_EDGE, PROJECT_NORMAL);
  return { kind: 'anchored', pos: elbowAnchorPoint(anchor, frame, dir), dir, frame };
}

/**
 * Straight: position = raw frame point (no offset). Returns the `interior` variant
 * with ray-cast inputs when `interior=true`, or the bare `edge` variant otherwise.
 */
function buildStraightAnchored(frame: FrameTuple, shapeType: string, anchor: Point, interior: boolean, shapeId: string): StraightEndpoint {
  const pos = anchorFramePoint(anchor, frame);
  return interior ? { kind: 'interior', pos, frame, shapeType, shapeId } : { kind: 'edge', pos };
}

// ============================================================================
// ELBOW RESOLVERS
// ============================================================================

/**
 * Cached-route fallback for dangling anchors: the stored anchor points to a shape
 * whose frame is no longer available locally (deleted, not yet hydrated). Returns
 * the route's first or last point as a free Point so the connector renders at its
 * last-known position. `[0, 0]` only when the cache is also empty (never-routed).
 */
function fallbackPoint(cachedRoute: Point[] | null, side: 'start' | 'end'): Point {
  if (cachedRoute && cachedRoute.length > 0) {
    const pt = side === 'start' ? cachedRoute[0] : cachedRoute[cachedRoute.length - 1];
    return [pt[0], pt[1]];
  }
  return [0, 0];
}

/**
 * Transform-or-canonical resolution. `override === null` reads canonical Y.Map;
 * `override` as Point becomes a free endpoint; `override` as FrameOverride
 * reapplies the stored anchor against the supplied frame.
 *
 * `endpoint` is the union from Y.Map. Branches: free Point → trivial; StoredAnchor
 * → resolve frame (override.frame OR frameOf(getHandle(id))); dangling → cached-route.
 */
function resolveElbowSide(
  override: TransformOverride | null,
  endpoint: ConnectorEndpoint | undefined,
  cachedRoute: Point[] | null,
  side: 'start' | 'end',
): ElbowEndpoint {
  if (Array.isArray(override)) return { kind: 'free', pos: override };
  if (!endpoint) return { kind: 'free', pos: fallbackPoint(cachedRoute, side) };
  if (Array.isArray(endpoint)) return { kind: 'free', pos: endpoint };
  // endpoint is StoredAnchor here.
  const handle = getHandle(endpoint.id);
  const frame = override ? override.frame : frameOf(handle);
  if (!frame) return { kind: 'free', pos: fallbackPoint(cachedRoute, side) };
  return buildElbowAnchored(frame, getHandleShapeType(handle), endpoint.anchor);
}

/** SelectTool drag override + ConnectorTool's new-connector input share this shape. */
function resolveElbowFromSnapOrPoint(input: SnapTarget | Point): ElbowEndpoint {
  if (Array.isArray(input)) return { kind: 'free', pos: input };
  const handle = getHandle(input.shapeId);
  const frame = frameOf(handle);
  if (!frame) return { kind: 'free', pos: input.position };
  return buildElbowAnchored(frame, getHandleShapeType(handle), input.normalizedAnchor);
}

// ============================================================================
// STRAIGHT RESOLVERS
// ============================================================================

/**
 * Same shape as `resolveElbowSide` but produces a `StraightEndpoint`. Anchors in
 * the straight pipeline are always `StoredStraightAnchor` (parent's connectorType
 * discriminates the union); the cast is safe and isolated.
 */
function resolveStraightSide(
  override: TransformOverride | null,
  endpoint: ConnectorEndpoint | undefined,
  cachedRoute: Point[] | null,
  side: 'start' | 'end',
): StraightEndpoint {
  if (Array.isArray(override)) return { kind: 'free', pos: override };
  if (!endpoint) return { kind: 'free', pos: fallbackPoint(cachedRoute, side) };
  if (Array.isArray(endpoint)) return { kind: 'free', pos: endpoint };
  // endpoint is StoredAnchor — straight pipeline by parent connectorType invariant.
  const handle = getHandle(endpoint.id);
  const frame = override ? override.frame : frameOf(handle);
  if (!frame) return { kind: 'free', pos: fallbackPoint(cachedRoute, side) };
  const sa = endpoint as StoredStraightAnchor;
  return buildStraightAnchored(frame, getHandleShapeType(handle), sa.anchor, sa.interior, sa.id);
}

/**
 * Straight pipeline always receives `StraightSnapTarget`s by invariant
 * (findBestSnapTarget is called with the connector's type — see snap.ts +
 * core/connectors/CLAUDE.md). The `: false` interior fallback is unreachable
 * in practice; guarding rather than asserting keeps the function total.
 */
function resolveStraightFromSnapOrPoint(input: SnapTarget | Point): StraightEndpoint {
  if (Array.isArray(input)) return { kind: 'free', pos: input };
  const handle = getHandle(input.shapeId);
  const frame = frameOf(handle);
  if (!frame) return { kind: 'free', pos: input.position };
  const interior = input.kind === 'straight' ? input.interior : false;
  return buildStraightAnchored(frame, getHandleShapeType(handle), input.normalizedAnchor, interior, input.shapeId);
}

// ============================================================================
// ELBOW ROUTE ASSEMBLY
// ============================================================================

/**
 * Resolve start + end cardinal directions for the A* path. Four explicit cases
 * over the discriminated union — TypeScript narrowing proves `dir`/`frame`
 * presence on the `'anchored'` branch; no `!`, no `??`, no defensive guards.
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

function computeElbowRoute(start: ElbowEndpoint, end: ElbowEndpoint, strokeWidth: number): NewRouteResult {
  const { startDir, endDir } = resolveElbowDirections(start, end, strokeWidth);
  return computeAStarRoute(
    start.pos,
    startDir,
    end.pos,
    endDir,
    start.kind === 'anchored' ? start.frame : null,
    end.kind === 'anchored' ? end.frame : null,
    strokeWidth,
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
 * the pair level in `computeStraightRoute`, so this function never sees it.
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

/**
 * Compute a straight-line route between two resolved endpoints.
 *
 * Pair-level short-circuit: both interior + same shape → straight raw-to-raw.
 * Ray-casting two interior points on one convex shape produces opposing
 * intersections (the "spinning clock" artifact).
 *
 * Output endpoints are FRESH allocations (cloned from STRAIGHT_PT_*) so callers
 * can safely store them in Y.Map / dirty-rect tracking without aliasing the
 * module scratch.
 */
function computeStraightRoute(start: StraightEndpoint, end: StraightEndpoint): NewRouteResult {
  if (start.kind === 'interior' && end.kind === 'interior' && start.shapeId === end.shapeId) {
    return {
      points: [
        [start.pos[0], start.pos[1]],
        [end.pos[0], end.pos[1]],
      ],
    };
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
      return {
        points: [
          [startRaw[0], startRaw[1]],
          [endRaw[0], endRaw[1]],
        ],
      };
    }
  }

  return {
    points: [
      [STRAIGHT_PT_START[0], STRAIGHT_PT_START[1]],
      [STRAIGHT_PT_END[0], STRAIGHT_PT_END[1]],
    ],
  };
}

// ============================================================================
// CONNECTOR PROPS LOOKUP — shared across pipelines (Y.Map shape doesn't fork)
// ============================================================================

interface ConnectorContext {
  yMap: Y.Map<unknown>;
  start: ConnectorEndpoint | undefined;
  end: ConnectorEndpoint | undefined;
  strokeWidth: number;
  connectorType: ConnectorType;
  /** Cached route for dangling-anchor fallback. Read once at context build, not allocated. */
  cachedRoute: Point[] | null;
}

function readContext(connectorId: string): ConnectorContext | null {
  const handle = getHandle(connectorId);
  if (!handle || handle.kind !== 'connector') return null;
  const yMap = handle.y;
  const props = getConnectorProps(yMap);
  return {
    yMap,
    start: props?.start,
    end: props?.end,
    strokeWidth: props?.width ?? 2,
    connectorType: props?.connectorType ?? 'elbow',
    cachedRoute: getConnectorRoute(connectorId),
  };
}

// ============================================================================
// PER-PIPELINE REROUTE ENTRIES (private)
// ============================================================================

function rerouteElbowDrag(ctx: ConnectorContext, endpoint: 'start' | 'end', override: EndpointDragOverride): RerouteResult {
  const overrideResolved = resolveElbowFromSnapOrPoint(override);
  const start = endpoint === 'start' ? overrideResolved : resolveElbowSide(null, ctx.start, ctx.cachedRoute, 'start');
  const end = endpoint === 'end' ? overrideResolved : resolveElbowSide(null, ctx.end, ctx.cachedRoute, 'end');
  const { points } = computeElbowRoute(start, end, ctx.strokeWidth);
  return { points, bbox: computeConnectorBBoxFromPoints(points, ctx.yMap) };
}

function rerouteStraightDrag(ctx: ConnectorContext, endpoint: 'start' | 'end', override: EndpointDragOverride): RerouteResult {
  const overrideResolved = resolveStraightFromSnapOrPoint(override);
  const start = endpoint === 'start' ? overrideResolved : resolveStraightSide(null, ctx.start, ctx.cachedRoute, 'start');
  const end = endpoint === 'end' ? overrideResolved : resolveStraightSide(null, ctx.end, ctx.cachedRoute, 'end');
  const { points } = computeStraightRoute(start, end);
  return { points, bbox: computeConnectorBBoxFromPoints(points, ctx.yMap) };
}

function rerouteElbowTransform(ctx: ConnectorContext, startOv: TransformOverride | null, endOv: TransformOverride | null): RerouteResult {
  const start = resolveElbowSide(startOv, ctx.start, ctx.cachedRoute, 'start');
  const end = resolveElbowSide(endOv, ctx.end, ctx.cachedRoute, 'end');
  const { points } = computeElbowRoute(start, end, ctx.strokeWidth);
  return { points, bbox: computeConnectorBBoxFromPoints(points, ctx.yMap) };
}

function rerouteStraightTransform(
  ctx: ConnectorContext,
  startOv: TransformOverride | null,
  endOv: TransformOverride | null,
): RerouteResult {
  const start = resolveStraightSide(startOv, ctx.start, ctx.cachedRoute, 'start');
  const end = resolveStraightSide(endOv, ctx.end, ctx.cachedRoute, 'end');
  const { points } = computeStraightRoute(start, end);
  return { points, bbox: computeConnectorBBoxFromPoints(points, ctx.yMap) };
}

// ============================================================================
// PUBLIC ENTRY POINTS
// ============================================================================

/**
 * Reroute a connector for an endpoint drag (SelectTool).
 *
 * `endpoint` is the dragged side. `override` is a live SnapTarget (when the
 * cursor is snapped to a shape) or a free Point (cursor in space). The other
 * side is read canonically from Y.Map.
 */
export function rerouteConnectorEndpointDrag(
  connectorId: string,
  endpoint: 'start' | 'end',
  override: EndpointDragOverride,
): RerouteResult | null {
  const ctx = readContext(connectorId);
  if (!ctx) return null;
  return ctx.connectorType === 'straight' ? rerouteStraightDrag(ctx, endpoint, override) : rerouteElbowDrag(ctx, endpoint, override);
}

/**
 * Reroute a connector for a transform gesture (translate/scale).
 *
 * Each side: a `FrameOverride` (anchor reapplied against transformed frame),
 * a free `Point`, or `null` (canonical — read Y.Map). Hot path: called per
 * frame for every attached connector during a gesture.
 */
export function rerouteConnectorTransform(
  connectorId: string,
  startOverride: TransformOverride | null,
  endOverride: TransformOverride | null,
): RerouteResult | null {
  const ctx = readContext(connectorId);
  if (!ctx) return null;
  return ctx.connectorType === 'straight'
    ? rerouteStraightTransform(ctx, startOverride, endOverride)
    : rerouteElbowTransform(ctx, startOverride, endOverride);
}

/**
 * Route a new connector from endpoint specs.
 * Companion to the reroute family — same pipelines, no Y.Map data needed.
 */
export function routeNewConnector(
  start: SnapTarget | Point,
  end: SnapTarget | Point,
  strokeWidth: number,
  connectorType: ConnectorType = 'elbow',
): NewRouteResult {
  if (connectorType === 'straight') {
    return computeStraightRoute(resolveStraightFromSnapOrPoint(start), resolveStraightFromSnapOrPoint(end));
  }
  return computeElbowRoute(resolveElbowFromSnapOrPoint(start), resolveElbowFromSnapOrPoint(end), strokeWidth);
}
