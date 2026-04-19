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
import { resolveFreeStartDir, computeFreeEndDir, computeShapeEdgeIntersection, directionVector } from './connector-utils';
import { anchorFramePoint, elbowAnchorPoint, isSameShape } from './anchor-atoms';
import type { Dir, AABB, SnapTarget, ConnectorType, StoredElbowAnchor, StoredStraightAnchor } from './types';
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
  const connectorType = getConnectorType(yMap);

  const startResolved = resolveEndpoint(storedStart, startAnchor, endpointOverrides?.start, connectorType);
  const endResolved = resolveEndpoint(storedEnd, endAnchor, endpointOverrides?.end, connectorType);

  if (connectorType === 'straight') {
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
  // Populated for anchored endpoints (both connector types).
  normalizedAnchor?: Point;
  shapeType?: string;
  frame?: FrameTuple;
  shapeId?: string;
  /** Straight-only: true = stored/snapped as interior, false = edge. */
  interior?: boolean;
}

const FREE_ENDPOINT = (position: Point): ResolvedEndpoint => ({
  position,
  dir: null,
  shapeBounds: null,
  isAnchored: false,
});

/**
 * Resolve a single endpoint, picking the right override branch first.
 *
 * Trusts the stored anchor's shape matches its parent connector's `connectorType`
 * (elbow stores `side`, straight stores `interior`). No runtime normalization —
 * interior-ness was committed at snap time and is authoritative.
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

  const shapeType = getHandleShapeType(anchorHandle);
  return connectorType === 'elbow'
    ? buildElbowResolved(anchor as StoredElbowAnchor, frame, shapeType)
    : buildStraightResolved(anchor as StoredStraightAnchor, frame, shapeType);
}

/** Elbow: position = frame point + EDGE_CLEARANCE_W along stored side; dir = stored side. */
function buildElbowResolved(anchor: StoredElbowAnchor, frame: FrameTuple, shapeType: string): ResolvedEndpoint {
  return {
    position: elbowAnchorPoint(anchor, frame),
    dir: anchor.side,
    shapeBounds: tupleToFrame(frame),
    isAnchored: true,
    normalizedAnchor: anchor.anchor,
    shapeType,
    frame,
    shapeId: anchor.id,
  };
}

/** Straight: position = raw frame point (no offset); dir = null; carries stored `interior`. */
function buildStraightResolved(anchor: StoredStraightAnchor, frame: FrameTuple, shapeType: string): ResolvedEndpoint {
  return {
    position: anchorFramePoint(anchor.anchor, frame),
    dir: null,
    shapeBounds: tupleToFrame(frame),
    isAnchored: true,
    normalizedAnchor: anchor.anchor,
    shapeType,
    frame,
    shapeId: anchor.id,
    interior: anchor.interior,
  };
}

/** Override: caller provided a transformed frame — reapply the stored anchor against it. */
function resolveFrameOverride(
  frame: FrameTuple,
  anchor: StoredAnchor | undefined,
  storedPosition: Point,
  connectorType: ConnectorType,
): ResolvedEndpoint {
  if (!anchor) return FREE_ENDPOINT(storedPosition);
  const shapeType = getHandleShapeType(getHandle(anchor.id));
  return connectorType === 'elbow'
    ? buildElbowResolved(anchor as StoredElbowAnchor, frame, shapeType)
    : buildStraightResolved(anchor as StoredStraightAnchor, frame, shapeType);
}

/**
 * Override: caller provided a live SnapTarget — branches on `snap.kind`.
 * Elbow applies `EDGE_CLEARANCE_W * directionVector(side)` offset here (not in snap).
 * Straight keeps `snap.position` as-is; pull-back lives in `computeStraightRoute`.
 */
function resolveSnapOverride(snap: SnapTarget): ResolvedEndpoint {
  const handle = getHandle(snap.shapeId);
  const frame = frameOf(handle);
  const shapeType = getHandleShapeType(handle);

  if (snap.kind === 'elbow') {
    const [dx, dy] = directionVector(snap.side);
    const position: Point = [snap.position[0] + dx * EDGE_CLEARANCE_W, snap.position[1] + dy * EDGE_CLEARANCE_W];
    return {
      position,
      dir: snap.side,
      shapeBounds: frameToAABB(frame),
      isAnchored: true,
      normalizedAnchor: snap.normalizedAnchor,
      shapeType,
      frame: frame ?? undefined,
      shapeId: snap.shapeId,
    };
  }

  return {
    position: snap.position,
    dir: null,
    shapeBounds: frameToAABB(frame),
    isAnchored: true,
    normalizedAnchor: snap.normalizedAnchor,
    shapeType,
    frame: frame ?? undefined,
    shapeId: snap.shapeId,
    interior: snap.interior,
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
  if (!me.interior) {
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
