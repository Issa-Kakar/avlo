/**
 * Connector Snapping System
 *
 * Top-level branches on `connectorType` into two pipelines that never alias:
 *
 *   Elbow:     inside-shallow or outside → edge + midpoint stickiness
 *              deep inside                → force midpoint only (no interior)
 *
 *   Straight:  inside-shallow or outside → edge + midpoint stickiness
 *              deep inside                → center snap → midpoint → clamped interior
 *
 * Dead-zone fix: the edge-snap radius gate applies only when the cursor is
 * OUTSIDE the shape. Inside-shallow always allows edge sliding — no gap
 * between the force-midpoint depth and the edge.
 *
 * SnapTarget is a discriminated union — each emitted target carries its `kind`
 * so consumers branch on type explicitly rather than inferring from field shape.
 * `position` is the visual dot + pre-offset routing endpoint; routing owns its
 * own offset/pullback per type.
 *
 * @module lib/connectors/snap
 */

import { getSnapRadiiWorld, type SnapRadiiWorld } from './constants';
import { clamp01, frameCenter, shapeMidpoints, findNearestEdgePoint } from './shape-geometry';
import { pointInsideShape } from '../geometry/hit-primitives';
import { frameOf } from '../geometry/frame-of';
import { pickTopmostBindable } from '../spatial/object-query';
import type { FrameTuple, Point } from '../types/geometry';
import { getHandleShapeType } from '../accessors';
import type { Dir, SnapTarget, ElbowSnapTarget, StraightSnapTarget, SnapContext } from './types';

// =============================================================================
// TYPES
// =============================================================================

/** Intermediate result shared by elbow + straight edge-snap — no `kind` yet. */
interface EdgeSnapProbe {
  side: Dir;
  isMidpoint: boolean;
  position: Point;
  normalizedAnchor: Point;
}

// =============================================================================
// SHARED HELPERS
// =============================================================================

/** Clamped normalized anchor from an on-edge world point. */
function normalizedFromEdge(edge: Point, frame: FrameTuple): Point {
  const [x, y, w, h] = frame;
  return [clamp01((edge[0] - x) / w), clamp01((edge[1] - y) / h)];
}

/** Nearest midpoint side + world distance from a probe point. */
function nearestMidpoint(probe: Point, midpoints: Record<Dir, Point>): { side: Dir; dist: number } {
  let side: Dir = 'N';
  let dist = Infinity;
  for (const [s, pos] of Object.entries(midpoints) as [Dir, Point][]) {
    const d = Math.hypot(probe[0] - pos[0], probe[1] - pos[1]);
    if (d < dist) {
      dist = d;
      side = s;
    }
  }
  return { side, dist };
}

/** Midpoint hysteresis gate: sticky within `midOut`, enters on first touch at `midIn`. */
function midpointGate(wasOnMidpoint: boolean, dist: number, radii: SnapRadiiWorld): boolean {
  if (wasOnMidpoint && dist <= radii.midOut) return true;
  return dist <= radii.midIn;
}

function wasOnElbowMidpoint(prev: SnapTarget | null, shapeId: string, side: Dir): boolean {
  return prev?.kind === 'elbow' && prev.shapeId === shapeId && prev.isMidpoint && prev.side === side;
}

function wasOnStraightMidpoint(prev: SnapTarget | null, shapeId: string, side: Dir): boolean {
  return prev?.kind === 'straight' && prev.shapeId === shapeId && prev.midpointSide === side;
}

// =============================================================================
// TOP-LEVEL ORCHESTRATOR
// =============================================================================

export function findBestSnapTarget(ctx: SnapContext): SnapTarget | null {
  const { cursorWorld } = ctx;
  const [cx, cy] = cursorWorld;
  const radii = getSnapRadiiWorld();

  return pickTopmostBindable([cx, cy], { world: radii.edgeSnap }, (h) => {
    const frame = frameOf(h);
    if (!frame) return null;
    return computeSnapForShape(h.id, frame, getHandleShapeType(h), ctx, radii);
  });
}

export function computeSnapForShape(
  shapeId: string,
  frame: FrameTuple,
  shapeType: string,
  ctx: SnapContext,
  radii: SnapRadiiWorld,
): SnapTarget | null {
  const midpoints = shapeMidpoints(frame, shapeType);
  const isInside = pointInsideShape(ctx.cursorWorld, frame, shapeType);
  const insideDepth = isInside ? (findNearestEdgePoint(ctx.cursorWorld, frame, shapeType)?.dist ?? 0) : 0;

  return ctx.connectorType === 'straight'
    ? computeStraightSnap(ctx, shapeId, frame, shapeType, midpoints, isInside, insideDepth, radii)
    : computeElbowSnap(ctx, shapeId, frame, shapeType, midpoints, isInside, insideDepth, radii);
}

// =============================================================================
// ELBOW PIPELINE — edge or midpoint; never interior
// =============================================================================

function computeElbowSnap(
  ctx: SnapContext,
  shapeId: string,
  frame: FrameTuple,
  shapeType: string,
  midpoints: Record<Dir, Point>,
  isInside: boolean,
  insideDepth: number,
  radii: SnapRadiiWorld,
): ElbowSnapTarget | null {
  if (isInside && insideDepth > radii.forceMidpointDepth) {
    return forceElbowMidpoint(shapeId, frame, midpoints, ctx.cursorWorld);
  }
  return tryElbowEdgeSnap(ctx, shapeId, frame, shapeType, midpoints, isInside, radii);
}

function forceElbowMidpoint(shapeId: string, frame: FrameTuple, midpoints: Record<Dir, Point>, probe: Point): ElbowSnapTarget {
  const nearest = nearestMidpoint(probe, midpoints);
  const midpoint = midpoints[nearest.side];
  return {
    kind: 'elbow',
    shapeId,
    side: nearest.side,
    normalizedAnchor: normalizedFromEdge(midpoint, frame),
    isMidpoint: true,
    position: midpoint,
    isInside: true,
  };
}

function tryElbowEdgeSnap(
  ctx: SnapContext,
  shapeId: string,
  frame: FrameTuple,
  shapeType: string,
  midpoints: Record<Dir, Point>,
  isInside: boolean,
  radii: SnapRadiiWorld,
): ElbowSnapTarget | null {
  const p = probeEdgeSnap(ctx, frame, shapeType, midpoints, isInside, radii, (side) => wasOnElbowMidpoint(ctx.prevAttach, shapeId, side));
  if (!p) return null;
  return {
    kind: 'elbow',
    shapeId,
    side: p.side,
    normalizedAnchor: p.normalizedAnchor,
    isMidpoint: p.isMidpoint,
    position: p.position,
    isInside,
  };
}

// =============================================================================
// SHARED EDGE-SNAP PROBE
// =============================================================================

/**
 * Shared edge-snap pipeline:
 *   find nearest edge → gate on radius (outside only) → midpoint hysteresis.
 * Caller supplies the midpoint-hysteresis predicate so elbow and straight
 * keep their own `prevAttach` shape.
 */
function probeEdgeSnap(
  ctx: SnapContext,
  frame: FrameTuple,
  shapeType: string,
  midpoints: Record<Dir, Point>,
  isInside: boolean,
  radii: SnapRadiiWorld,
  wasOnMidpoint: (side: Dir) => boolean,
): EdgeSnapProbe | null {
  const edgeSnap = findNearestEdgePoint(ctx.cursorWorld, frame, shapeType);
  if (!edgeSnap) return null;
  if (!isInside && edgeSnap.dist > radii.edgeSnap) return null;

  const edgePos: Point = [edgeSnap.x, edgeSnap.y];
  const probe = isInside ? nearestMidpoint(edgePos, midpoints) : nearestMidpoint(ctx.cursorWorld, midpoints);

  if (midpointGate(wasOnMidpoint(probe.side), probe.dist, radii)) {
    const midpoint = midpoints[probe.side];
    return { side: probe.side, isMidpoint: true, position: midpoint, normalizedAnchor: normalizedFromEdge(midpoint, frame) };
  }
  return { side: edgeSnap.side, isMidpoint: false, position: edgePos, normalizedAnchor: normalizedFromEdge(edgePos, frame) };
}

// =============================================================================
// STRAIGHT PIPELINE — edge, edge-midpoint, center, or clamped interior
// =============================================================================

function computeStraightSnap(
  ctx: SnapContext,
  shapeId: string,
  frame: FrameTuple,
  shapeType: string,
  midpoints: Record<Dir, Point>,
  isInside: boolean,
  insideDepth: number,
  radii: SnapRadiiWorld,
): StraightSnapTarget | null {
  if (isInside && insideDepth > radii.straightInteriorDepth) {
    return computeStraightInterior(ctx, shapeId, frame, midpoints, radii);
  }
  return tryStraightEdgeSnap(ctx, shapeId, frame, shapeType, midpoints, isInside, radii);
}

function computeStraightInterior(
  ctx: SnapContext,
  shapeId: string,
  frame: FrameTuple,
  midpoints: Record<Dir, Point>,
  radii: SnapRadiiWorld,
): StraightSnapTarget {
  const { cursorWorld, prevAttach } = ctx;
  const [cx, cy] = cursorWorld;
  const [fx, fy, fw, fh] = frame;
  const center = frameCenter(frame);
  const centerDist = Math.hypot(cx - center[0], cy - center[1]);

  const wasCenter = prevAttach?.kind === 'straight' && prevAttach.shapeId === shapeId && prevAttach.isCenter;
  const centerThreshold = wasCenter ? radii.centerSnap * 1.3 : radii.centerSnap;

  if (centerDist <= centerThreshold) {
    return {
      kind: 'straight',
      shapeId,
      interior: true,
      isCenter: true,
      midpointSide: null,
      normalizedAnchor: [0.5, 0.5],
      position: center,
      isInside: true,
    };
  }

  const nearest = nearestMidpoint(cursorWorld, midpoints);
  if (midpointGate(wasOnStraightMidpoint(prevAttach, shapeId, nearest.side), nearest.dist, radii)) {
    const midpoint = midpoints[nearest.side];
    return {
      kind: 'straight',
      shapeId,
      interior: false,
      isCenter: false,
      midpointSide: nearest.side,
      normalizedAnchor: normalizedFromEdge(midpoint, frame),
      position: midpoint,
      isInside: true,
    };
  }

  const normalizedAnchor: Point = [Math.max(0.01, Math.min(0.99, (cx - fx) / fw)), Math.max(0.01, Math.min(0.99, (cy - fy) / fh))];
  return {
    kind: 'straight',
    shapeId,
    interior: true,
    isCenter: false,
    midpointSide: null,
    normalizedAnchor,
    position: cursorWorld,
    isInside: true,
  };
}

function tryStraightEdgeSnap(
  ctx: SnapContext,
  shapeId: string,
  frame: FrameTuple,
  shapeType: string,
  midpoints: Record<Dir, Point>,
  isInside: boolean,
  radii: SnapRadiiWorld,
): StraightSnapTarget | null {
  const p = probeEdgeSnap(ctx, frame, shapeType, midpoints, isInside, radii, (side) =>
    wasOnStraightMidpoint(ctx.prevAttach, shapeId, side),
  );
  if (!p) return null;
  return {
    kind: 'straight',
    shapeId,
    interior: false,
    isCenter: false,
    midpointSide: p.isMidpoint ? p.side : null,
    normalizedAnchor: p.normalizedAnchor,
    position: p.position,
    isInside,
  };
}
