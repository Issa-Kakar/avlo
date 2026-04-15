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
import type { FrameTuple, BBoxTuple, Point } from '../types/geometry';
import { tupleToFrame } from '../types/geometry';
import { getStart, getEnd, getStartAnchor, getEndAnchor, getWidth, type StoredAnchor } from '../accessors';
import { computeConnectorBBoxFromPoints } from '../geometry/bbox';
import { frameOf } from '../geometry/frame-of';
import { computeAStarRoute } from './routing-astar';
import { resolveFreeStartDir, computeFreeEndDir, computeShapeEdgeIntersection } from './connector-utils';
import { anchorFramePoint, anchorOffsetPoint, sideFromAnchor, isSameShape } from './anchor-atoms';
import type { Dir, AABB, SnapTarget, ConnectorType } from './types';
import { isAnchorInterior } from './types';
import { getConnectorType, getHandleShapeType } from '../accessors';
import { EDGE_CLEARANCE_W } from './constants';

/** AABB == Frame, so a FrameTuple converts via tupleToFrame. Null-safe wrapper for resolve sites. */
function frameToAABB(frame: FrameTuple | null | undefined): AABB | null {
  return frame ? tupleToFrame(frame) : null;
}

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
  const storedStart = getStart(yMap) ?? [0, 0];
  const storedEnd = getEnd(yMap) ?? [0, 0];
  const startAnchor = getStartAnchor(yMap);
  const endAnchor = getEndAnchor(yMap);
  const strokeWidth = getWidth(yMap, 2);

  const startResolved = resolveEndpoint(storedStart, startAnchor, endpointOverrides?.start);
  const endResolved = resolveEndpoint(storedEnd, endAnchor, endpointOverrides?.end);

  if (getConnectorType(yMap) === 'straight') {
    const straight = computeStraightRoute(startResolved, endResolved);
    return { points: straight.points, bbox: computeConnectorBBoxFromPoints(straight.points, yMap) };
  }

  const { startDir, endDir } = resolveDirections(startResolved, endResolved, strokeWidth);
  const result = computeAStarRoute(
    startResolved.position,
    startDir,
    endResolved.position,
    endDir,
    startResolved.shapeBounds,
    endResolved.shapeBounds,
    strokeWidth,
  );
  return { points: result.points, bbox: computeConnectorBBoxFromPoints(result.points, yMap) };
}

/**
 * Resolved endpoint with position, direction, and bounds.
 */
interface ResolvedEndpoint {
  position: Point;
  dir: Dir | null;
  shapeBounds: AABB | null;
  isAnchored: boolean;
  // Straight connector fields (populated when anchored)
  normalizedAnchor?: Point;
  shapeType?: string;
  frame?: FrameTuple;
  shapeId?: string;
}

const FREE_ENDPOINT = (position: Point): ResolvedEndpoint => ({
  position,
  dir: null,
  shapeBounds: null,
  isAnchored: false,
});

/** Resolve a single endpoint, picking the right override branch first. */
function resolveEndpoint(
  storedPosition: Point,
  anchor: StoredAnchor | undefined,
  override: EndpointOverrideValue | undefined,
): ResolvedEndpoint {
  if (override !== undefined) {
    if (Array.isArray(override)) return resolveFreePositionOverride(override);
    if ('frame' in override) return resolveFrameOverride(override.frame, anchor, storedPosition);
    return resolveSnapOverride(override);
  }
  if (!anchor) return FREE_ENDPOINT(storedPosition);

  const anchorHandle = getHandle(anchor.id);
  const frame = frameOf(anchorHandle);
  if (!frame) return FREE_ENDPOINT(storedPosition);

  const shapeType = getHandleShapeType(anchorHandle);
  return {
    position: anchorOffsetPoint(anchor.anchor, frame, shapeType),
    dir: sideFromAnchor(anchor.anchor, frame, shapeType),
    shapeBounds: tupleToFrame(frame),
    isAnchored: true,
    normalizedAnchor: anchor.anchor,
    shapeType,
    frame,
    shapeId: anchor.id,
  };
}

/** Override: caller provided a free world position. */
function resolveFreePositionOverride(position: Point): ResolvedEndpoint {
  return FREE_ENDPOINT(position);
}

/** Override: caller provided a transformed frame — reapply the stored anchor against it. */
function resolveFrameOverride(frame: FrameTuple, anchor: StoredAnchor | undefined, storedPosition: Point): ResolvedEndpoint {
  if (!anchor) return FREE_ENDPOINT(storedPosition);
  const shapeType = getHandleShapeType(getHandle(anchor.id));
  return {
    position: anchorOffsetPoint(anchor.anchor, frame, shapeType),
    dir: sideFromAnchor(anchor.anchor, frame, shapeType),
    shapeBounds: tupleToFrame(frame),
    isAnchored: true,
    normalizedAnchor: anchor.anchor,
    shapeType,
    frame,
    shapeId: anchor.id,
  };
}

/** Override: caller provided a live SnapTarget — used by endpoint-drag + new-connector flows. */
function resolveSnapOverride(snap: SnapTarget): ResolvedEndpoint {
  const handle = getHandle(snap.shapeId);
  const frame = frameOf(handle);
  const shapeType = getHandleShapeType(handle);
  return {
    position: snap.position,
    dir: frame ? sideFromAnchor(snap.normalizedAnchor, frame, shapeType) : snap.side,
    shapeBounds: frameToAABB(frame),
    isAnchored: true,
    normalizedAnchor: snap.normalizedAnchor,
    shapeType,
    frame: frame ?? undefined,
    shapeId: snap.shapeId,
  };
}

/**
 * ELBOW ONLY — resolve routing directions for both endpoints.
 * Straight routing skips direction seeding entirely.
 */
function resolveDirections(start: ResolvedEndpoint, end: ResolvedEndpoint, strokeWidth: number): { startDir: Dir; endDir: Dir } {
  let startDir = start.dir;
  let endDir = end.dir;

  // Free→Anchored: compute start direction from spatial relationship
  if (!start.isAnchored && end.isAnchored && end.shapeBounds) {
    startDir = resolveFreeStartDir(
      start.position,
      { position: end.position, outwardDir: end.dir!, shapeBounds: end.shapeBounds },
      strokeWidth,
    );
  } else if (!start.isAnchored && startDir === null) {
    startDir = computeFreeEndDir(start.position, end.position);
  }

  // Anchored→Free: compute end direction from primary axis
  if (start.isAnchored && !end.isAnchored) {
    endDir = computeFreeEndDir(start.position, end.position);
  } else if (!end.isAnchored && endDir === null) {
    const opposites: Record<Dir, Dir> = { N: 'S', S: 'N', E: 'W', W: 'E' };
    endDir = opposites[startDir!];
  }

  return { startDir: startDir!, endDir: endDir! };
}

// ============================================================================
// NEW CONNECTOR ROUTING (companion to rerouteConnector)
// ============================================================================

/** Result from routeNewConnector — dash info kept for compatibility during refactor. */
export interface NewRouteResult {
  points: Point[];
  startDashTo: Point | null;
  endDashTo: Point | null;
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
  dragDir?: Dir | null,
): NewRouteResult {
  const startResolved = resolveNewEndpoint(start);
  const endResolved = resolveNewEndpoint(end);

  if (connectorType === 'straight') {
    return computeStraightRoute(startResolved, endResolved);
  }

  if (!startResolved.isAnchored && dragDir) {
    startResolved.dir = dragDir;
  }

  const { startDir, endDir } = resolveDirections(startResolved, endResolved, strokeWidth);
  return {
    points: computeAStarRoute(
      startResolved.position,
      startDir,
      endResolved.position,
      endDir,
      startResolved.shapeBounds,
      endResolved.shapeBounds,
      strokeWidth,
    ).points,
    startDashTo: null,
    endDashTo: null,
  };
}

/** Resolve a snap-or-position endpoint for new connector routing. */
function resolveNewEndpoint(value: SnapTarget | Point): ResolvedEndpoint {
  if (Array.isArray(value)) return FREE_ENDPOINT(value);
  return resolveSnapOverride(value);
}

// ============================================================================
// STRAIGHT CONNECTOR ROUTING
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
 * Resolve one endpoint of a straight route.
 *
 * - Free endpoint           → position as-is, no dash.
 * - Edge anchor             → pull-back toward the other endpoint, no dash.
 * - Interior, same shape    → raw position, no dash.
 * - Interior, diff shape    → edge intersection + pull-back, dashed guide to raw.
 */
function resolveStraightEndpoint(
  me: ResolvedEndpoint,
  myRaw: Point,
  otherRaw: Point,
  sameShape: boolean,
): { point: Point; dashTo: Point | null } {
  if (!me.isAnchored || !me.normalizedAnchor || !me.frame) {
    return { point: me.position, dashTo: null };
  }
  if (!isAnchorInterior(me.normalizedAnchor)) {
    return { point: applyPullBack(myRaw, otherRaw), dashTo: null };
  }
  if (sameShape || !me.shapeType) {
    return { point: myRaw, dashTo: null };
  }
  const intersection = computeShapeEdgeIntersection(me.shapeType, me.frame, myRaw, otherRaw);
  if (!intersection) return { point: myRaw, dashTo: null };
  return { point: applyPullBack(intersection.point, otherRaw), dashTo: myRaw };
}

/**
 * Compute a straight-line route between two resolved endpoints.
 * Both sides share `resolveStraightEndpoint` to avoid mirror-image duplication.
 */
function computeStraightRoute(start: ResolvedEndpoint, end: ResolvedEndpoint): NewRouteResult {
  const startRaw = rawAnchorPos(start);
  const endRaw = rawAnchorPos(end);
  const sameShape = isSameShape(start, end);

  const s = resolveStraightEndpoint(start, startRaw, endRaw, sameShape);
  const e = resolveStraightEndpoint(end, endRaw, startRaw, sameShape);

  // Overlap safety: if edge intersections or pullbacks produced a flipped/collapsed segment
  // (overlapping shapes, exit-point overshoot), fall back to raw positions — avoids the
  // "spinning clock" artifact.
  const rawDx = endRaw[0] - startRaw[0];
  const rawDy = endRaw[1] - startRaw[1];
  if (rawDx * rawDx + rawDy * rawDy > 0.001) {
    const visDx = e.point[0] - s.point[0];
    const visDy = e.point[1] - s.point[1];
    if (visDx * rawDx + visDy * rawDy <= 0 || Math.hypot(visDx, visDy) < EDGE_CLEARANCE_W) {
      return { points: [startRaw, endRaw], startDashTo: null, endDashTo: null };
    }
  }

  return { points: [s.point, e.point], startDashTo: s.dashTo, endDashTo: e.dashTo };
}
