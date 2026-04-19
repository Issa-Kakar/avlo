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
import { getShapeTypeMidpoints } from './connector-utils';
import { pointInsideShape } from '../geometry/hit-primitives';
import { frameOf } from '../geometry/frame-of';
import { pickTopmostBindable } from '../spatial/object-query';
import type { FrameTuple, Point } from '../types/geometry';
import { getHandleShapeType } from '../accessors';
import type { Dir, SnapTarget, ElbowSnapTarget, StraightSnapTarget, SnapContext } from './types';

// =============================================================================
// SHARED HELPERS
// =============================================================================

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

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
  const { edgeSnap: edgeRadius } = getSnapRadiiWorld();

  return pickTopmostBindable([cx, cy], { world: edgeRadius }, (h) => {
    const frame = frameOf(h);
    if (!frame) return null;
    return computeSnapForShape(h.id, frame, getHandleShapeType(h), ctx);
  });
}

export function computeSnapForShape(shapeId: string, frame: FrameTuple, shapeType: string, ctx: SnapContext): SnapTarget | null {
  const radii = getSnapRadiiWorld();
  const midpoints = getShapeTypeMidpoints(frame, shapeType);
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
  const edgeSnap = findNearestEdgePoint(ctx.cursorWorld, frame, shapeType);
  if (!edgeSnap) return null;
  if (!isInside && edgeSnap.dist > radii.edgeSnap) return null;

  const edgePos: Point = [edgeSnap.x, edgeSnap.y];
  const probe = isInside ? nearestMidpoint(edgePos, midpoints) : nearestMidpoint(ctx.cursorWorld, midpoints);

  if (midpointGate(wasOnElbowMidpoint(ctx.prevAttach, shapeId, probe.side), probe.dist, radii)) {
    const midpoint = midpoints[probe.side];
    return {
      kind: 'elbow',
      shapeId,
      side: probe.side,
      normalizedAnchor: normalizedFromEdge(midpoint, frame),
      isMidpoint: true,
      position: midpoint,
      isInside,
    };
  }

  return {
    kind: 'elbow',
    shapeId,
    side: edgeSnap.side,
    normalizedAnchor: normalizedFromEdge(edgePos, frame),
    isMidpoint: false,
    position: edgePos,
    isInside,
  };
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
  const center: Point = [fx + fw / 2, fy + fh / 2];
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
  const edgeSnap = findNearestEdgePoint(ctx.cursorWorld, frame, shapeType);
  if (!edgeSnap) return null;
  if (!isInside && edgeSnap.dist > radii.edgeSnap) return null;

  const edgePos: Point = [edgeSnap.x, edgeSnap.y];
  const probe = isInside ? nearestMidpoint(edgePos, midpoints) : nearestMidpoint(ctx.cursorWorld, midpoints);

  if (midpointGate(wasOnStraightMidpoint(ctx.prevAttach, shapeId, probe.side), probe.dist, radii)) {
    const midpoint = midpoints[probe.side];
    return {
      kind: 'straight',
      shapeId,
      interior: false,
      isCenter: false,
      midpointSide: probe.side,
      normalizedAnchor: normalizedFromEdge(midpoint, frame),
      position: midpoint,
      isInside,
    };
  }

  return {
    kind: 'straight',
    shapeId,
    interior: false,
    isCenter: false,
    midpointSide: null,
    normalizedAnchor: normalizedFromEdge(edgePos, frame),
    position: edgePos,
    isInside,
  };
}

// =============================================================================
// EDGE GEOMETRY (shape-type-aware nearest edge point)
// =============================================================================

/**
 * Find nearest point on shape edge (shape-type aware).
 */
export function findNearestEdgePoint(
  probe: Point,
  frame: FrameTuple,
  shapeType: string,
): { side: Dir; t: number; x: number; y: number; dist: number } | null {
  const [x, y, w, h] = frame;
  const [cx, cy] = probe;

  switch (shapeType) {
    case 'diamond': {
      const top: Point = [x + w / 2, y];
      const right: Point = [x + w, y + h / 2];
      const bottom: Point = [x + w / 2, y + h];
      const left: Point = [x, y + h / 2];

      const edges: { side: Dir; p1: Point; p2: Point }[] = [
        { side: 'N', p1: left, p2: top },
        { side: 'E', p1: top, p2: right },
        { side: 'S', p1: right, p2: bottom },
        { side: 'W', p1: bottom, p2: left },
      ];

      return findNearestOnEdges(probe, edges);
    }

    case 'ellipse': {
      const ecx = x + w / 2;
      const ecy = y + h / 2;
      const rx = w / 2;
      const ry = h / 2;

      if (rx < 0.001 || ry < 0.001) return null;

      const angle = Math.atan2((cy - ecy) / ry, (cx - ecx) / rx);
      const px = ecx + rx * Math.cos(angle);
      const py = ecy + ry * Math.sin(angle);
      const dist = Math.hypot(cx - px, cy - py);

      let side: Dir;
      const normAngle = (angle + Math.PI * 2) % (Math.PI * 2);
      if (normAngle < Math.PI / 4 || normAngle >= (Math.PI * 7) / 4) {
        side = 'E';
      } else if (normAngle < (Math.PI * 3) / 4) {
        side = 'S';
      } else if (normAngle < (Math.PI * 5) / 4) {
        side = 'W';
      } else {
        side = 'N';
      }

      let t = 0.5;
      if (side === 'N' || side === 'S') {
        t = (px - x) / w;
      } else {
        t = (py - y) / h;
      }

      return { side, t: Math.max(0, Math.min(1, t)), x: px, y: py, dist };
    }

    case 'rect':
    case 'roundedRect':
    default: {
      const edges: { side: Dir; p1: Point; p2: Point }[] = [
        { side: 'N', p1: [x, y], p2: [x + w, y] },
        { side: 'E', p1: [x + w, y], p2: [x + w, y + h] },
        { side: 'S', p1: [x, y + h], p2: [x + w, y + h] },
        { side: 'W', p1: [x, y], p2: [x, y + h] },
      ];

      return findNearestOnEdges(probe, edges);
    }
  }
}

/** Helper: find nearest point among a list of edges. */
function findNearestOnEdges(
  probe: Point,
  edges: { side: Dir; p1: Point; p2: Point }[],
): { side: Dir; t: number; x: number; y: number; dist: number } | null {
  const [cx, cy] = probe;
  let best: { side: Dir; t: number; x: number; y: number; dist: number } | null = null;

  for (const edge of edges) {
    const [x1, y1] = edge.p1;
    const [x2, y2] = edge.p2;
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.hypot(dx, dy);
    if (len < 0.001) continue;

    const t = Math.max(0, Math.min(1, ((cx - x1) * dx + (cy - y1) * dy) / (len * len)));

    const px = x1 + t * dx;
    const py = y1 + t * dy;
    const dist = Math.hypot(cx - px, cy - py);

    if (!best || dist < best.dist) {
      best = { side: edge.side, t, x: px, y: py, dist };
    }
  }

  return best;
}
