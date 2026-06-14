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
 * **Side classification** comes from `projectAnchorToEdge` — cursor is converted
 * to a normalized anchor and projected against the live frame, so the cardinal
 * matches the world-space outward normal regardless of aspect ratio. This
 * supersedes the old line-distance + atan2 classifiers.
 *
 * @module lib/connectors/snap
 */

import { getHandleShapeType } from '../accessors';
import { frameOf } from '../geometry/frame-of';
import { pointInsideShape } from '../geometry/hit-primitives';
import { pickTopmostBindable } from '../spatial/object-query';
import type { FrameTuple, Point } from '../types/geometry';
import { getSnapRadiiWorld, type SnapRadiiWorld } from './constants';
import { clamp01, frameCenter, midpointFor, projectAnchorToEdge } from './shape-geometry';
import type { Dir, ElbowSnapTarget, SnapContext, SnapTarget, StraightSnapTarget } from './types';

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

interface NearestEdgeProbe {
  side: Dir;
  x: number;
  y: number;
  dist: number;
}

// =============================================================================
// MODULE-LEVEL SCRATCH (synchronous callers only — never interleave probes)
// =============================================================================

const PROBE_NORMALIZED: Point = [0, 0];
const PROBE_EDGE: Point = [0, 0];
const PROBE_NORMAL: Point = [0, 0];
const SCRATCH_MIDPOINT: Point = [0, 0];

const SIDES: readonly Dir[] = ['N', 'E', 'S', 'W'];

// =============================================================================
// SHARED HELPERS
// =============================================================================

/** Project cursor onto the shape's edge (via `projectAnchorToEdge` on cursor-as-anchor). */
function probeNearestEdge(probe: Point, frame: FrameTuple, shapeType: string): NearestEdgeProbe | null {
  if (frame[2] < 0.001 || frame[3] < 0.001) return null;
  PROBE_NORMALIZED[0] = (probe[0] - frame[0]) / frame[2];
  PROBE_NORMALIZED[1] = (probe[1] - frame[1]) / frame[3];
  const side = projectAnchorToEdge(PROBE_NORMALIZED, frame, shapeType, PROBE_EDGE, PROBE_NORMAL);
  return {
    side,
    x: PROBE_EDGE[0],
    y: PROBE_EDGE[1],
    dist: Math.hypot(probe[0] - PROBE_EDGE[0], probe[1] - PROBE_EDGE[1]),
  };
}

/** Clamped normalized anchor from an on-edge world point. */
function normalizedFromEdge(edge: Point, frame: FrameTuple): Point {
  const [x, y, w, h] = frame;
  return [clamp01((edge[0] - x) / w), clamp01((edge[1] - y) / h)];
}

/** Nearest midpoint side + world distance from a probe point. */
function nearestMidpoint(probe: Point, frame: FrameTuple, shapeType: string): { side: Dir; dist: number } {
  let bestSide: Dir = 'N';
  let bestDist = Infinity;
  for (const s of SIDES) {
    midpointFor(frame, shapeType, s, SCRATCH_MIDPOINT);
    const d = Math.hypot(probe[0] - SCRATCH_MIDPOINT[0], probe[1] - SCRATCH_MIDPOINT[1]);
    if (d < bestDist) {
      bestDist = d;
      bestSide = s;
    }
  }
  return { side: bestSide, dist: bestDist };
}

/** Allocate a fresh world-space midpoint Point for a returned snap target. */
function midpointPoint(frame: FrameTuple, shapeType: string, side: Dir): Point {
  const out: Point = [0, 0];
  midpointFor(frame, shapeType, side, out);
  return out;
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
  const isInside = pointInsideShape(ctx.cursorWorld, frame, shapeType);
  const insideDepth = isInside ? (probeNearestEdge(ctx.cursorWorld, frame, shapeType)?.dist ?? 0) : 0;

  return ctx.connectorType === 'straight'
    ? computeStraightSnap(ctx, shapeId, frame, shapeType, isInside, insideDepth, radii)
    : computeElbowSnap(ctx, shapeId, frame, shapeType, isInside, insideDepth, radii);
}

// =============================================================================
// ELBOW PIPELINE — edge or midpoint; never interior
// =============================================================================

function computeElbowSnap(
  ctx: SnapContext,
  shapeId: string,
  frame: FrameTuple,
  shapeType: string,
  isInside: boolean,
  insideDepth: number,
  radii: SnapRadiiWorld,
): ElbowSnapTarget | null {
  if (isInside && insideDepth > radii.forceMidpointDepth) {
    return forceElbowMidpoint(shapeId, frame, shapeType, ctx.cursorWorld);
  }
  return tryElbowEdgeSnap(ctx, shapeId, frame, shapeType, isInside, radii);
}

function forceElbowMidpoint(shapeId: string, frame: FrameTuple, shapeType: string, probe: Point): ElbowSnapTarget {
  const nearest = nearestMidpoint(probe, frame, shapeType);
  const midpoint = midpointPoint(frame, shapeType, nearest.side);
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
  isInside: boolean,
  radii: SnapRadiiWorld,
): ElbowSnapTarget | null {
  const p = probeEdgeSnap(ctx, frame, shapeType, isInside, radii, (side) => wasOnElbowMidpoint(ctx.prevAttach, shapeId, side));
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
 *   project cursor → edge → gate on radius (outside only) → midpoint hysteresis.
 * Caller supplies the midpoint-hysteresis predicate so elbow and straight
 * keep their own `prevAttach` shape.
 */
function probeEdgeSnap(
  ctx: SnapContext,
  frame: FrameTuple,
  shapeType: string,
  isInside: boolean,
  radii: SnapRadiiWorld,
  wasOnMidpoint: (side: Dir) => boolean,
): EdgeSnapProbe | null {
  const edgeSnap = probeNearestEdge(ctx.cursorWorld, frame, shapeType);
  if (!edgeSnap) return null;
  if (!isInside && edgeSnap.dist > radii.edgeSnap) return null;

  const edgePos: Point = [edgeSnap.x, edgeSnap.y];
  const probe = isInside ? nearestMidpoint(edgePos, frame, shapeType) : nearestMidpoint(ctx.cursorWorld, frame, shapeType);

  if (midpointGate(wasOnMidpoint(probe.side), probe.dist, radii)) {
    const midpoint = midpointPoint(frame, shapeType, probe.side);
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
  isInside: boolean,
  insideDepth: number,
  radii: SnapRadiiWorld,
): StraightSnapTarget | null {
  // Clamp the screen-space interior gate to a fraction of the shape's smaller
  // dimension. `radii.straightInteriorDepth = 20px / scale` grows in world
  // units as the user zooms out — at very low zoom it can exceed the shape's
  // entire interior, so the cursor never reaches "deep inside" and
  // `computeStraightInterior` (which owns center + interior snap) never runs.
  // Cap = 30% of `min(w, h)`: at normal zoom the screen-space gate dominates;
  // when the shape is small in world coords the cap takes over and keeps
  // the center dot hittable. Edge snap behavior is unchanged because the cap
  // only LOWERS the gate, never raises it.
  const minDim = Math.min(frame[2], frame[3]);
  const effectiveInteriorDepth = Math.min(radii.straightInteriorDepth, minDim * 0.3);
  if (isInside && insideDepth > effectiveInteriorDepth) {
    return computeStraightInterior(ctx, shapeId, frame, shapeType, radii);
  }
  return tryStraightEdgeSnap(ctx, shapeId, frame, shapeType, isInside, radii);
}

function computeStraightInterior(
  ctx: SnapContext,
  shapeId: string,
  frame: FrameTuple,
  shapeType: string,
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

  const nearest = nearestMidpoint(cursorWorld, frame, shapeType);
  if (midpointGate(wasOnStraightMidpoint(prevAttach, shapeId, nearest.side), nearest.dist, radii)) {
    const midpoint = midpointPoint(frame, shapeType, nearest.side);
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
  isInside: boolean,
  radii: SnapRadiiWorld,
): StraightSnapTarget | null {
  const p = probeEdgeSnap(ctx, frame, shapeType, isInside, radii, (side) => wasOnStraightMidpoint(ctx.prevAttach, shapeId, side));
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
