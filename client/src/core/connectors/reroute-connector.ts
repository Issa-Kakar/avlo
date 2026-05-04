/**
 * High-Level Connector Rerouting API.
 *
 * Three specialized public entry points share one private core that branches on
 * `connectorType` exactly once. Each public function takes only the override
 * shape its caller actually produces — no runtime tag-soup discrimination on
 * hot paths.
 *
 *   rerouteConnectorEndpointDrag(id, endpoint, override)
 *     Caller: SelectTool. The non-dragged side reads Y.Map; the dragged side
 *     accepts a live SnapTarget or a free Point.
 *
 *   rerouteConnectorTransform(id, startOverride, endOverride)
 *     Caller: connector-topology. Each side: FrameOverride | Point | null.
 *     No SnapTarget branch — transform paths never feed snap.
 *
 *   rerouteConnectorCanonical(id)
 *     Trust-Y.Map path. Wrapper over Transform with two nulls. Future-facing:
 *     this becomes the surface "update affected connectors" uses after the
 *     point/anchor union refactor.
 *
 *   routeNewConnector(start, end, strokeWidth, type)
 *     Caller: ConnectorTool (creation). No Y.Map read.
 *
 * @module lib/connectors/reroute-connector
 */

import type * as Y from 'yjs';
import { getHandle } from '@/runtime/room-runtime';
import { getConnectorProps, getHandleShapeType, type StoredAnchor } from '../accessors';
import { computeConnectorBBoxFromPoints } from '../geometry/bbox';
import { frameOf } from '../geometry/frame-of';
import type { BBoxTuple, FrameTuple, Point } from '../types/geometry';
import type { StoredStraightAnchor } from '../types/objects';
import { anchorFramePoint, elbowAnchorPoint, isSameShape } from './anchor-atoms';
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
 */

const ZERO_POINT: Point = [0, 0];

// Module-level scratches for projection (synchronous reroute path; not re-entrant).
const PROJECT_EDGE: Point = [0, 0];
const PROJECT_NORMAL: Point = [0, 0];

// Straight pipeline scratches. STRAIGHT_RAY_DIR / STRAIGHT_RAY_EXIT consumed
// sequentially per side inside resolveStraightEndpointInto — never aliased into
// the result. STRAIGHT_PT_START / STRAIGHT_PT_END hold the two visible endpoints
// returned in the final straight route.
const STRAIGHT_RAY_DIR: Point = [0, 0];
const STRAIGHT_RAY_EXIT: Point = [0, 0];
const STRAIGHT_PT_START: Point = [0, 0];
const STRAIGHT_PT_END: Point = [0, 0];

// ============================================================================
// TYPES
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

/**
 * Resolved endpoint with position, direction, and anchor metadata.
 * Free endpoints carry only `position` + `isAnchored=false`; anchored endpoints
 * populate everything else. `frame` doubles as the obstacle-bounds passed into A*.
 */
interface ResolvedEndpoint {
  position: Point;
  dir: Dir | null;
  isAnchored: boolean;
  // Populated for anchored endpoints (both connector types).
  normalizedAnchor?: Point;
  shapeType?: string;
  frame?: FrameTuple;
  shapeId?: string;
  /** Straight-only: true = stored/snapped as interior, false = edge. */
  interior?: boolean;
}

// ============================================================================
// FREE + ANCHORED FACTORIES
// ============================================================================

const FREE_ENDPOINT = (position: Point): ResolvedEndpoint => ({
  position,
  dir: null,
  isAnchored: false,
});

/**
 * Elbow: derive `dir` from `(anchor + frame + shapeType)` via `projectAnchorToEdge`,
 * then place position at `EDGE_CLEARANCE_W` outward along that cardinal.
 */
function buildElbowAnchored(frame: FrameTuple, shapeType: string, shapeId: string, normalizedAnchor: Point): ResolvedEndpoint {
  const dir = projectAnchorToEdge(normalizedAnchor, frame, shapeType, PROJECT_EDGE, PROJECT_NORMAL);
  return {
    position: elbowAnchorPoint(normalizedAnchor, frame, dir),
    dir,
    isAnchored: true,
    normalizedAnchor,
    shapeType,
    frame,
    shapeId,
  };
}

/** Straight: position = raw frame point (no offset); dir = null; carries stored `interior`. */
function buildStraightAnchored(
  frame: FrameTuple,
  shapeType: string,
  shapeId: string,
  normalizedAnchor: Point,
  interior: boolean,
): ResolvedEndpoint {
  return {
    position: anchorFramePoint(normalizedAnchor, frame),
    dir: null,
    isAnchored: true,
    normalizedAnchor,
    shapeType,
    frame,
    shapeId,
    interior,
  };
}

/**
 * Thin dispatcher — the single elbow/straight ternary for the stored-anchor /
 * frame-override branches. Snap-driven overrides use the typed factories
 * directly (they have the snap shape already).
 */
function buildAnchoredByType(connectorType: ConnectorType, frame: FrameTuple, shapeType: string, anchor: StoredAnchor): ResolvedEndpoint {
  return connectorType === 'elbow'
    ? buildElbowAnchored(frame, shapeType, anchor.id, anchor.anchor)
    : buildStraightAnchored(frame, shapeType, anchor.id, anchor.anchor, (anchor as StoredStraightAnchor).interior);
}

// ============================================================================
// CANONICAL ENDPOINT (Y.Map fallback)
// ============================================================================

/** Resolve endpoint from stored Y.Map data — anchored against current frame, or free. */
function resolveCanonical(storedPosition: Point, anchor: StoredAnchor | undefined, connectorType: ConnectorType): ResolvedEndpoint {
  if (!anchor) return FREE_ENDPOINT(storedPosition);
  const anchorHandle = getHandle(anchor.id);
  const frame = frameOf(anchorHandle);
  if (!frame) return FREE_ENDPOINT(storedPosition);
  return buildAnchoredByType(connectorType, frame, getHandleShapeType(anchorHandle), anchor);
}

/** Override: caller provided a transformed frame — reapply the stored anchor against it. */
function resolveFrameOverride(
  frame: FrameTuple,
  anchor: StoredAnchor | undefined,
  storedPosition: Point,
  connectorType: ConnectorType,
): ResolvedEndpoint {
  if (!anchor) return FREE_ENDPOINT(storedPosition);
  return buildAnchoredByType(connectorType, frame, getHandleShapeType(getHandle(anchor.id)), anchor);
}

/**
 * Override: caller provided a live SnapTarget — branches on `snap.kind` and
 * dispatches directly to the typed factory for each kind.
 */
function resolveSnapOverride(snap: SnapTarget): ResolvedEndpoint {
  const handle = getHandle(snap.shapeId);
  const frame = frameOf(handle) ?? undefined;
  const shapeType = getHandleShapeType(handle);
  if (!frame) {
    // No frame available — best-effort free endpoint carrying the snap's position.
    return FREE_ENDPOINT(snap.position);
  }
  return snap.kind === 'elbow'
    ? buildElbowAnchored(frame, shapeType, snap.shapeId, snap.normalizedAnchor)
    : buildStraightAnchored(frame, shapeType, snap.shapeId, snap.normalizedAnchor, snap.interior);
}

// ============================================================================
// STRAIGHT ROUTE ASSEMBLY
// ============================================================================

/** Apply EDGE_CLEARANCE_W pull-back along the line from `point` toward `toward`, writing into `out`. */
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
 * into `out`. For straight endpoints, `me.position` IS the raw frame point —
 * `buildStraightAnchored` writes it via `anchorFramePoint` and never offsets.
 *
 * - Free endpoint           → me.position.
 * - Edge anchor             → pull-back toward the other endpoint.
 * - Interior, same shape    → raw position (skip edge intersection — convex ray flip).
 * - Interior, diff shape    → edge intersection + pull-back.
 *
 * Dashed guides for interior anchors are rendered directly from `snap` by the
 * preview/overlay layers; this function doesn't thread dash metadata.
 */
function resolveStraightEndpointInto(out: Point, me: ResolvedEndpoint, otherRaw: Point, sameShape: boolean): void {
  if (!me.isAnchored || !me.normalizedAnchor || !me.frame) {
    out[0] = me.position[0];
    out[1] = me.position[1];
    return;
  }
  const myRaw = me.position;
  if (!me.interior) {
    applyPullBackInto(out, myRaw, otherRaw);
    return;
  }
  if (sameShape || !me.shapeType) {
    out[0] = myRaw[0];
    out[1] = myRaw[1];
    return;
  }
  STRAIGHT_RAY_DIR[0] = otherRaw[0] - myRaw[0];
  STRAIGHT_RAY_DIR[1] = otherRaw[1] - myRaw[1];
  if (!rayShapeExitPoint(myRaw, STRAIGHT_RAY_DIR, me.frame, me.shapeType, STRAIGHT_RAY_EXIT)) {
    out[0] = myRaw[0];
    out[1] = myRaw[1];
    return;
  }
  applyPullBackInto(out, STRAIGHT_RAY_EXIT, otherRaw);
}

/**
 * Compute a straight-line route between two resolved endpoints.
 * Both sides share `resolveStraightEndpointInto` to avoid mirror-image duplication.
 *
 * Output endpoints are FRESH allocations (cloned from STRAIGHT_PT_*) so callers
 * can safely store them in Y.Map / dirty-rect tracking without aliasing the
 * module scratch.
 */
function computeStraightRoute(start: ResolvedEndpoint, end: ResolvedEndpoint): NewRouteResult {
  const startRaw = start.position;
  const endRaw = end.position;
  const sameShape = isSameShape(start, end);

  resolveStraightEndpointInto(STRAIGHT_PT_START, start, endRaw, sameShape);
  resolveStraightEndpointInto(STRAIGHT_PT_END, end, startRaw, sameShape);

  // Overlap safety: if edge intersections or pullbacks produced a flipped/collapsed segment
  // (overlapping shapes, exit-point overshoot), fall back to raw positions — avoids the
  // "spinning clock" artifact.
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
// ELBOW ROUTE ASSEMBLY
// ============================================================================

/**
 * Resolve routing directions for both endpoints (elbow routing only).
 * Straight routing skips direction seeding entirely.
 */
function resolveElbowDirections(start: ResolvedEndpoint, end: ResolvedEndpoint, strokeWidth: number): { startDir: Dir; endDir: Dir } {
  let startDir = start.dir;
  let endDir = end.dir;

  // Free→Anchored: compute start direction from spatial relationship
  if (!start.isAnchored && end.isAnchored && end.frame) {
    startDir = resolveElbowFreeStartDir(
      start.position,
      { position: end.position, outwardDir: end.dir!, shapeBounds: end.frame },
      strokeWidth,
    );
  } else if (!start.isAnchored && startDir === null) {
    startDir = computeElbowFreeEndDir(start.position, end.position);
  }

  // Anchored→Free: compute end direction from primary axis
  if (start.isAnchored && !end.isAnchored) {
    endDir = computeElbowFreeEndDir(start.position, end.position);
  } else if (!end.isAnchored && endDir === null) {
    endDir = oppositeDir(startDir!);
  }

  return { startDir: startDir!, endDir: endDir! };
}

/** Single wrapper over `computeAStarRoute` — collapses the 7-arg duplication at call sites. */
function callAStar(start: ResolvedEndpoint, startDir: Dir, end: ResolvedEndpoint, endDir: Dir, strokeWidth: number) {
  return computeAStarRoute(start.position, startDir, end.position, endDir, start.frame ?? null, end.frame ?? null, strokeWidth);
}

// ============================================================================
// CONNECTOR PROPS LOOKUP
// ============================================================================

/** Connector props bundle used by every reroute entry — single Y.Map fetch. */
interface ConnectorContext {
  yMap: Y.Map<unknown>;
  storedStart: Point;
  storedEnd: Point;
  startAnchor: StoredAnchor | undefined;
  endAnchor: StoredAnchor | undefined;
  strokeWidth: number;
  connectorType: ConnectorType;
}

function readContext(connectorId: string): ConnectorContext | null {
  const handle = getHandle(connectorId);
  if (!handle || handle.kind !== 'connector') return null;
  const yMap = handle.y;
  const props = getConnectorProps(yMap);
  return {
    yMap,
    storedStart: props?.start ?? ZERO_POINT,
    storedEnd: props?.end ?? ZERO_POINT,
    startAnchor: props?.startAnchor,
    endAnchor: props?.endAnchor,
    strokeWidth: props?.width ?? 2,
    connectorType: props?.connectorType ?? 'elbow',
  };
}

// ============================================================================
// PRIVATE CORE — SINGLE BRANCH ON CONNECTOR TYPE
// ============================================================================

function rerouteCore(ctx: ConnectorContext, startResolved: ResolvedEndpoint, endResolved: ResolvedEndpoint): RerouteResult {
  if (ctx.connectorType === 'straight') {
    const straight = computeStraightRoute(startResolved, endResolved);
    return { points: straight.points, bbox: computeConnectorBBoxFromPoints(straight.points, ctx.yMap) };
  }
  const { startDir, endDir } = resolveElbowDirections(startResolved, endResolved, ctx.strokeWidth);
  const result = callAStar(startResolved, startDir, endResolved, endDir, ctx.strokeWidth);
  return { points: result.points, bbox: computeConnectorBBoxFromPoints(result.points, ctx.yMap) };
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

  const overrideResolved = Array.isArray(override) ? FREE_ENDPOINT(override) : resolveSnapOverride(override);

  const startResolved = endpoint === 'start' ? overrideResolved : resolveCanonical(ctx.storedStart, ctx.startAnchor, ctx.connectorType);
  const endResolved = endpoint === 'end' ? overrideResolved : resolveCanonical(ctx.storedEnd, ctx.endAnchor, ctx.connectorType);

  return rerouteCore(ctx, startResolved, endResolved);
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

  const startResolved = resolveTransformSide(startOverride, ctx.startAnchor, ctx.storedStart, ctx.connectorType);
  const endResolved = resolveTransformSide(endOverride, ctx.endAnchor, ctx.storedEnd, ctx.connectorType);

  return rerouteCore(ctx, startResolved, endResolved);
}

function resolveTransformSide(
  override: TransformOverride | null,
  anchor: StoredAnchor | undefined,
  storedPosition: Point,
  connectorType: ConnectorType,
): ResolvedEndpoint {
  if (override === null) return resolveCanonical(storedPosition, anchor, connectorType);
  if (Array.isArray(override)) return FREE_ENDPOINT(override);
  return resolveFrameOverride(override.frame, anchor, storedPosition, connectorType);
}

/**
 * Reroute a connector reading entirely from Y.Map — no overrides.
 *
 * One-line wrapper over Transform with two nulls. Future "update affected
 * connectors" path lands here once points/anchors collapse out of Y.Map.
 */
export function rerouteConnectorCanonical(connectorId: string): RerouteResult | null {
  return rerouteConnectorTransform(connectorId, null, null);
}

/**
 * Route a new connector from endpoint specs.
 * Companion to the reroute family — same pipeline, no Y.Map data needed.
 */
export function routeNewConnector(
  start: SnapTarget | Point,
  end: SnapTarget | Point,
  strokeWidth: number,
  connectorType: ConnectorType = 'elbow',
): NewRouteResult {
  const startResolved = Array.isArray(start) ? FREE_ENDPOINT(start) : resolveSnapOverride(start);
  const endResolved = Array.isArray(end) ? FREE_ENDPOINT(end) : resolveSnapOverride(end);

  if (connectorType === 'straight') {
    return computeStraightRoute(startResolved, endResolved);
  }

  const { startDir, endDir } = resolveElbowDirections(startResolved, endResolved, strokeWidth);
  return { points: callAStar(startResolved, startDir, endResolved, endDir, strokeWidth).points };
}
