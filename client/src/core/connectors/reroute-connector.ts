/**
 * High-Level Connector Rerouting API for SelectTool
 *
 * Provides a simplified interface for rerouting connectors with optional overrides.
 * Reads connector data from Y.map and applies per-endpoint overrides as needed.
 *
 * Override types per endpoint:
 * - SnapTarget: snap to shape edge (has shapeId property)
 * - [x, y]: free position override
 * - { frame: FrameTuple }: apply anchor to a transformed frame
 *
 * @module lib/connectors/reroute-connector
 */

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

const ZERO_POINT: Point = [0, 0];

// Module-level scratches for projection (synchronous reroute path; not re-entrant).
const PROJECT_EDGE: Point = [0, 0];
const PROJECT_NORMAL: Point = [0, 0];
const RAY_DIRECTION: Point = [0, 0];
const RAY_EXIT: Point = [0, 0];

// ============================================================================
// TYPES
// ============================================================================

/**
 * Endpoint override value for rerouteConnector.
 * - SnapTarget: snap to shape edge (has shapeId property)
 * - Point: free position override
 * - { frame: FrameTuple }: apply anchor to a transformed frame
 */
export type EndpointOverrideValue = SnapTarget | Point | { frame: FrameTuple };

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
// ENDPOINT RESOLUTION (override-shape dispatchers)
// ============================================================================

/**
 * Resolve a single endpoint, picking the right override branch first.
 *
 * Elbow side is derived from `(anchor + frame + shapeType)` via `projectAnchorToEdge`
 * — never persisted. Straight `interior` is committed at snap time and is read
 * straight from the stored anchor; no runtime normalization.
 */
function resolveEndpoint(
  storedPosition: Point,
  anchor: StoredAnchor | undefined,
  override: EndpointOverrideValue | undefined,
  connectorType: ConnectorType,
): ResolvedEndpoint {
  if (override !== undefined) {
    if (Array.isArray(override)) return FREE_ENDPOINT(override);
    if ('frame' in override) return resolveFrameOverride(override.frame, anchor, storedPosition, connectorType);
    return resolveSnapOverride(override);
  }
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

/** Thin wrapper over resolveSnapOverride for route-new flow (accepts free positions too). */
function resolveNewEndpoint(value: SnapTarget | Point): ResolvedEndpoint {
  if (Array.isArray(value)) return FREE_ENDPOINT(value);
  return resolveSnapOverride(value);
}

// ============================================================================
// STRAIGHT ROUTE ASSEMBLY
// ============================================================================

/** Apply EDGE_CLEARANCE_W pull-back along the line from `point` toward `toward`. */
function applyPullBack(point: Point, toward: Point): Point {
  const dx = toward[0] - point[0];
  const dy = toward[1] - point[1];
  const len = Math.hypot(dx, dy);
  if (len < 0.001) return point;
  return [point[0] + (dx / len) * EDGE_CLEARANCE_W, point[1] + (dy / len) * EDGE_CLEARANCE_W];
}

/** Raw (un-offset) position of an endpoint — frame point for anchored, position for free. */
function rawAnchorPos(ep: ResolvedEndpoint): Point {
  if (ep.isAnchored && ep.normalizedAnchor && ep.frame) {
    return anchorFramePoint(ep.normalizedAnchor, ep.frame);
  }
  return ep.position;
}

/**
 * Resolve one endpoint of a straight route to its visible line position.
 *
 * - Free endpoint           → position as-is.
 * - Edge anchor             → pull-back toward the other endpoint.
 * - Interior, same shape    → raw position (skip edge intersection — convex ray flip).
 * - Interior, diff shape    → edge intersection + pull-back.
 *
 * Dashed guides for interior anchors are rendered directly from `snap` by the
 * preview/overlay layers; this function doesn't thread dash metadata.
 */
function resolveStraightEndpoint(me: ResolvedEndpoint, myRaw: Point, otherRaw: Point, sameShape: boolean): Point {
  if (!me.isAnchored || !me.normalizedAnchor || !me.frame) return me.position;
  if (!me.interior) return applyPullBack(myRaw, otherRaw);
  if (sameShape || !me.shapeType) return myRaw;
  RAY_DIRECTION[0] = otherRaw[0] - myRaw[0];
  RAY_DIRECTION[1] = otherRaw[1] - myRaw[1];
  if (!rayShapeExitPoint(myRaw, RAY_DIRECTION, me.frame, me.shapeType, RAY_EXIT)) return myRaw;
  return applyPullBack(RAY_EXIT, otherRaw);
}

/**
 * Compute a straight-line route between two resolved endpoints.
 * Both sides share `resolveStraightEndpoint` to avoid mirror-image duplication.
 */
function computeStraightRoute(start: ResolvedEndpoint, end: ResolvedEndpoint): NewRouteResult {
  const startRaw = rawAnchorPos(start);
  const endRaw = rawAnchorPos(end);
  const sameShape = isSameShape(start, end);

  const startPt = resolveStraightEndpoint(start, startRaw, endRaw, sameShape);
  const endPt = resolveStraightEndpoint(end, endRaw, startRaw, sameShape);

  // Overlap safety: if edge intersections or pullbacks produced a flipped/collapsed segment
  // (overlapping shapes, exit-point overshoot), fall back to raw positions — avoids the
  // "spinning clock" artifact.
  const rawDx = endRaw[0] - startRaw[0];
  const rawDy = endRaw[1] - startRaw[1];
  if (rawDx * rawDx + rawDy * rawDy > 0.001) {
    const visDx = endPt[0] - startPt[0];
    const visDy = endPt[1] - startPt[1];
    if (visDx * rawDx + visDy * rawDy <= 0 || Math.hypot(visDx, visDy) < EDGE_CLEARANCE_W) {
      return { points: [startRaw, endRaw] };
    }
  }

  return { points: [startPt, endPt] };
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
// PUBLIC ENTRY POINTS
// ============================================================================

/**
 * Reroute a connector with optional per-endpoint overrides.
 */
export function rerouteConnector(
  connectorId: string,
  endpointOverrides?: {
    start?: EndpointOverrideValue;
    end?: EndpointOverrideValue;
  },
): RerouteResult | null {
  const handle = getHandle(connectorId);
  if (!handle || handle.kind !== 'connector') return null;

  const yMap = handle.y;
  const props = getConnectorProps(yMap);
  const storedStart = props?.start ?? ZERO_POINT;
  const storedEnd = props?.end ?? ZERO_POINT;
  const startAnchor = props?.startAnchor;
  const endAnchor = props?.endAnchor;
  const strokeWidth = props?.width ?? 2;
  const connectorType = props?.connectorType ?? 'elbow';

  const startResolved = resolveEndpoint(storedStart, startAnchor, endpointOverrides?.start, connectorType);
  const endResolved = resolveEndpoint(storedEnd, endAnchor, endpointOverrides?.end, connectorType);

  if (connectorType === 'straight') {
    const straight = computeStraightRoute(startResolved, endResolved);
    return { points: straight.points, bbox: computeConnectorBBoxFromPoints(straight.points, yMap) };
  }

  const { startDir, endDir } = resolveElbowDirections(startResolved, endResolved, strokeWidth);
  const result = callAStar(startResolved, startDir, endResolved, endDir, strokeWidth);
  return { points: result.points, bbox: computeConnectorBBoxFromPoints(result.points, yMap) };
}

/**
 * Route a new connector from endpoint specs.
 * Companion to rerouteConnector — same pipeline, no Y.map data needed.
 */
export function routeNewConnector(
  start: SnapTarget | Point,
  end: SnapTarget | Point,
  strokeWidth: number,
  connectorType: ConnectorType = 'elbow',
): NewRouteResult {
  const startResolved = resolveNewEndpoint(start);
  const endResolved = resolveNewEndpoint(end);

  if (connectorType === 'straight') {
    return computeStraightRoute(startResolved, endResolved);
  }

  const { startDir, endDir } = resolveElbowDirections(startResolved, endResolved, strokeWidth);
  return { points: callAStar(startResolved, startDir, endResolved, endDir, strokeWidth).points };
}
