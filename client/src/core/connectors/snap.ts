/**
 * Connector Snapping System
 *
 * Finds the best snap target among shapes near the cursor.
 * Implements shape-type-aware edge detection and midpoint hysteresis.
 *
 * PRIORITY LOGIC (matches SelectTool pattern):
 * 1. Sort candidates by area ascending (smallest = most nested first)
 * 2. Among equal-area candidates, prefer higher z-order (ULID descending)
 * 3. Pick the first valid snap target
 *
 * This ensures clicking inside nested shapes snaps to the inner one.
 *
 * @module lib/connectors/snap
 */

import { EDGE_CLEARANCE_W, getSnapRadiiWorld, type SnapRadiiWorld } from './constants';
import { getShapeTypeMidpoints, directionVector } from './connector-utils';
import { pointInsideShape } from '../geometry/hit-primitives';
import { frameOf } from '../geometry/frame-of';
import { scanTopmost, type HitCandidate } from '../geometry/object-pick';
import { queryHitCandidates } from '../spatial/object-query';
import { BINDABLE_KINDS, type BindableKind } from '../types/objects';
import type { FrameTuple } from '../types/geometry';
import { getHandleShapeType } from '../accessors';
import type { Dir, SnapTarget, SnapContext } from './types';
import { isAnchorInterior } from './types';

/**
 * Compute normalized anchor and offset position from edge point.
 */
function computeAnchorAndPosition(
  edgeX: number,
  edgeY: number,
  frame: FrameTuple,
  side: Dir,
): { normalizedAnchor: [number, number]; position: [number, number] } {
  const [x, y, w, h] = frame;
  const normalizedAnchor: [number, number] = [Math.max(0, Math.min(1, (edgeX - x) / w)), Math.max(0, Math.min(1, (edgeY - y) / h))];
  const [dx, dy] = directionVector(side);
  const position: [number, number] = [edgeX + dx * EDGE_CLEARANCE_W, edgeY + dy * EDGE_CLEARANCE_W];
  return { normalizedAnchor, position };
}

/** Nearest midpoint side + world distance from a probe point. */
function nearestMidpoint(cx: number, cy: number, midpoints: Record<Dir, [number, number]>): { side: Dir; dist: number } {
  let side: Dir = 'N';
  let dist = Infinity;
  for (const [s, pos] of Object.entries(midpoints) as [Dir, [number, number]][]) {
    const d = Math.hypot(cx - pos[0], cy - pos[1]);
    if (d < dist) {
      dist = d;
      side = s;
    }
  }
  return { side, dist };
}

/**
 * Shared midpoint-stickiness gate used by straight and elbow paths.
 * Sticks to a midpoint we were already on until the cursor slips past `midOut`,
 * or enters a midpoint on first touch at `midIn`.
 */
function shouldSnapToMidpoint(prevAttach: SnapTarget | null, shapeId: string, side: Dir, dist: number, radii: SnapRadiiWorld): boolean {
  const wasPrev = prevAttach?.shapeId === shapeId && prevAttach?.isMidpoint && prevAttach?.side === side;
  if (wasPrev && dist <= radii.midOut) return true;
  return dist <= radii.midIn;
}

/**
 * Find the best snap target among all shapes near the cursor.
 */
export function findBestSnapTarget(ctx: SnapContext): SnapTarget | null {
  const { cursorWorld } = ctx;
  const [cx, cy] = cursorWorld;
  const { edgeSnap: edgeRadius } = getSnapRadiiWorld();

  const candidates = queryHitCandidates(cx, cy, edgeRadius, BINDABLE_KINDS);
  if (candidates.length === 0) return null;

  const trySnap = (c: HitCandidate<BindableKind>): SnapTarget | null => {
    const frame = frameOf(c.handle);
    if (!frame) return null;
    return computeSnapForShape(c.handle.id, frame, getHandleShapeType(c.handle), ctx);
  };

  return scanTopmost(candidates, {
    accept: trySnap,
    onSeeThrough: trySnap,
  });
}

/**
 * Orchestrator: picks the right sub-mode based on cursor depth + connector type.
 * Each try* helper owns one mode; the first non-null result wins.
 */
export function computeSnapForShape(shapeId: string, frame: FrameTuple, shapeType: string, ctx: SnapContext): SnapTarget | null {
  const { cursorWorld } = ctx;
  const [cx, cy] = cursorWorld;
  const radii = getSnapRadiiWorld();
  const midpoints = getShapeTypeMidpoints(frame, shapeType);

  const isInside = pointInsideShape([cx, cy], frame, shapeType);
  const insideDepth = isInside ? (findNearestEdgePoint(cx, cy, frame, shapeType)?.dist ?? 0) : 0;
  const isStraight = ctx.connectorType === 'straight';

  if (isStraight && isInside && insideDepth > radii.straightInteriorDepth) {
    return tryStraightInteriorSnap(ctx, shapeId, frame, midpoints, radii);
  }
  if (!isStraight && isInside && insideDepth > radii.forceMidpointDepth) {
    return tryElbowInteriorSnap(shapeId, frame, midpoints, cx, cy);
  }
  return tryEdgeSnap(ctx, shapeId, frame, shapeType, midpoints, isInside, radii);
}

/**
 * Straight connector, deep inside shape: center snap → midpoint stickiness → interior anchor.
 */
function tryStraightInteriorSnap(
  ctx: SnapContext,
  shapeId: string,
  frame: FrameTuple,
  midpoints: Record<Dir, [number, number]>,
  radii: SnapRadiiWorld,
): SnapTarget {
  const { cursorWorld, prevAttach } = ctx;
  const [cx, cy] = cursorWorld;
  const [fx, fy, fw, fh] = frame;
  const centerX = fx + fw / 2;
  const centerY = fy + fh / 2;
  const centerDist = Math.hypot(cx - centerX, cy - centerY);

  const wasCenter =
    prevAttach?.shapeId === shapeId &&
    prevAttach.normalizedAnchor[0] === 0.5 &&
    prevAttach.normalizedAnchor[1] === 0.5 &&
    isAnchorInterior(prevAttach.normalizedAnchor);
  const centerThreshold = wasCenter ? radii.centerSnap * 1.3 : radii.centerSnap;

  if (centerDist <= centerThreshold) {
    const nearest = nearestMidpoint(cx, cy, midpoints);
    return {
      shapeId,
      side: nearest.side,
      normalizedAnchor: [0.5, 0.5],
      isMidpoint: false,
      position: [centerX, centerY],
      edgePosition: [centerX, centerY],
      isInside: true,
    };
  }

  const nearest = nearestMidpoint(cx, cy, midpoints);
  if (shouldSnapToMidpoint(prevAttach, shapeId, nearest.side, nearest.dist, radii)) {
    const midpoint = midpoints[nearest.side];
    const { normalizedAnchor, position } = computeAnchorAndPosition(midpoint[0], midpoint[1], frame, nearest.side);
    return {
      shapeId,
      side: nearest.side,
      normalizedAnchor,
      isMidpoint: true,
      position,
      edgePosition: midpoint,
      isInside: true,
    };
  }

  // Interior anchor at cursor position (clamped inside [0.01, 0.99])
  const normalizedAnchor: [number, number] = [
    Math.max(0.01, Math.min(0.99, (cx - fx) / fw)),
    Math.max(0.01, Math.min(0.99, (cy - fy) / fh)),
  ];
  return {
    shapeId,
    side: nearest.side,
    normalizedAnchor,
    isMidpoint: false,
    position: [cx, cy],
    edgePosition: [cx, cy],
    isInside: true,
  };
}

/**
 * Elbow connector, deep inside shape: snap to nearest midpoint only.
 */
function tryElbowInteriorSnap(
  shapeId: string,
  frame: FrameTuple,
  midpoints: Record<Dir, [number, number]>,
  cx: number,
  cy: number,
): SnapTarget {
  const nearest = nearestMidpoint(cx, cy, midpoints);
  const midpoint = midpoints[nearest.side];
  const { normalizedAnchor, position } = computeAnchorAndPosition(midpoint[0], midpoint[1], frame, nearest.side);
  return {
    shapeId,
    side: nearest.side,
    normalizedAnchor,
    isMidpoint: true,
    position,
    edgePosition: midpoint,
    isInside: true,
  };
}

/**
 * Outside / near-edge / shallow-inside: snap to nearest edge point with midpoint hysteresis.
 *
 * Bug #6 fix: the radius gate now applies in both inside- and outside-shape cases — deep
 * interior hovers on large shapes no longer grab distant edges.
 */
function tryEdgeSnap(
  ctx: SnapContext,
  shapeId: string,
  frame: FrameTuple,
  shapeType: string,
  midpoints: Record<Dir, [number, number]>,
  isInside: boolean,
  radii: SnapRadiiWorld,
): SnapTarget | null {
  const { cursorWorld, prevAttach } = ctx;
  const [cx, cy] = cursorWorld;

  const edgeSnap = findNearestEdgePoint(cx, cy, frame, shapeType);
  if (!edgeSnap) return null;
  if (edgeSnap.dist > radii.edgeSnap) return null;

  // When inside: recompute nearest midpoint from the projected edge position so stickiness
  // feels the same as when the cursor is outside.
  const probe = isInside ? nearestMidpoint(edgeSnap.x, edgeSnap.y, midpoints) : nearestMidpoint(cx, cy, midpoints);

  if (shouldSnapToMidpoint(prevAttach, shapeId, probe.side, probe.dist, radii)) {
    const midpoint = midpoints[probe.side];
    const { normalizedAnchor, position } = computeAnchorAndPosition(midpoint[0], midpoint[1], frame, probe.side);
    return {
      shapeId,
      side: probe.side,
      normalizedAnchor,
      isMidpoint: true,
      position,
      edgePosition: midpoint,
      isInside,
    };
  }

  const { normalizedAnchor, position } = computeAnchorAndPosition(edgeSnap.x, edgeSnap.y, frame, edgeSnap.side);
  return {
    shapeId,
    side: edgeSnap.side,
    normalizedAnchor,
    isMidpoint: false,
    position,
    edgePosition: [edgeSnap.x, edgeSnap.y],
    isInside,
  };
}

/**
 * Find nearest point on shape edge (shape-type aware).
 */
export function findNearestEdgePoint(
  cx: number,
  cy: number,
  frame: FrameTuple,
  shapeType: string,
): { side: Dir; t: number; x: number; y: number; dist: number } | null {
  const [x, y, w, h] = frame;

  switch (shapeType) {
    case 'diamond': {
      const top: [number, number] = [x + w / 2, y];
      const right: [number, number] = [x + w, y + h / 2];
      const bottom: [number, number] = [x + w / 2, y + h];
      const left: [number, number] = [x, y + h / 2];

      const edges: { side: Dir; p1: [number, number]; p2: [number, number] }[] = [
        { side: 'N', p1: left, p2: top },
        { side: 'E', p1: top, p2: right },
        { side: 'S', p1: right, p2: bottom },
        { side: 'W', p1: bottom, p2: left },
      ];

      return findNearestOnEdges(cx, cy, edges);
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
      const edges: { side: Dir; p1: [number, number]; p2: [number, number] }[] = [
        { side: 'N', p1: [x, y], p2: [x + w, y] },
        { side: 'E', p1: [x + w, y], p2: [x + w, y + h] },
        { side: 'S', p1: [x, y + h], p2: [x + w, y + h] },
        { side: 'W', p1: [x, y], p2: [x, y + h] },
      ];

      return findNearestOnEdges(cx, cy, edges);
    }
  }
}

/** Helper: find nearest point among a list of edges. */
function findNearestOnEdges(
  cx: number,
  cy: number,
  edges: { side: Dir; p1: [number, number]; p2: [number, number] }[],
): { side: Dir; t: number; x: number; y: number; dist: number } | null {
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
