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

import { SNAP_CONFIG, pxToWorld } from './constants';
import { getShapeFrame, getMidpoints, type Dir, type ShapeFrame } from './shape-utils';
import { pointInRect, pointInDiamond } from '@/lib/geometry/hit-test-primitives';
import { getCurrentSnapshot } from '@/canvas/room-runtime';
import type { ObjectHandle } from '@avlo/shared';

/**
 * Snap target returned by the snapping system.
 */
export interface SnapTarget {
  /** ID of the shape being snapped to */
  shapeId: string;
  /** Which edge (N/E/S/W) */
  side: Dir;
  /** Position along edge (0-1, 0.5 = midpoint) */
  t: number;
  /** True if snapped to exact midpoint (t=0.5) */
  isMidpoint: boolean;
  /** World coordinates of snap point */
  position: [number, number];
  /** True if cursor is inside the shape */
  isInside: boolean;
}

/**
 * Context for snap computation.
 */
export interface SnapContext {
  /** Cursor position in world coordinates */
  cursorWorld: [number, number];
  /** Current zoom scale */
  scale: number;
  /** Previous snap target (for hysteresis) */
  prevAttach: SnapTarget | null;
}

/**
 * Find the best snap target among all shapes near the cursor.
 *
 * Uses spatial index for efficiency, then sorts by area (smallest first)
 * to handle nested shapes correctly.
 *
 * @param ctx - Snap context with cursor position and scale
 * @returns Best snap target or null if no valid snap
 */
export function findBestSnapTarget(ctx: SnapContext): SnapTarget | null {
  const { cursorWorld, scale } = ctx;
  const [cx, cy] = cursorWorld;

  // Query spatial index using edge snap radius
  // We only return a snap target if we'd actually snap, not just hover
  const edgeRadius = pxToWorld(SNAP_CONFIG.EDGE_SNAP_RADIUS_PX, scale);

  const snapshot = getCurrentSnapshot();
  if (!snapshot.spatialIndex) return null;

  const results = snapshot.spatialIndex.query({
    minX: cx - edgeRadius,
    minY: cy - edgeRadius,
    maxX: cx + edgeRadius,
    maxY: cy + edgeRadius,
  });

  // Filter to shapes and text only (connectable)
  const handles: ObjectHandle[] = [];
  for (const entry of results) {
    const h = snapshot.objectsById.get(entry.id);
    if (h && (h.kind === 'shape' || h.kind === 'text')) {
      handles.push(h);
    }
  }

  if (handles.length === 0) return null;

  // Build candidates with area for sorting
  interface Candidate {
    handle: ObjectHandle;
    frame: ShapeFrame;
    area: number;
  }
  const candidates: Candidate[] = [];

  for (const handle of handles) {
    const frame = getShapeFrame(handle);
    if (!frame) continue;
    candidates.push({ handle, frame, area: frame.w * frame.h });
  }

  // Sort by area ascending (smallest first), then ULID descending (topmost first)
  candidates.sort((a, b) => {
    if (a.area !== b.area) return a.area - b.area; // Smallest first
    return a.handle.id > b.handle.id ? -1 : 1; // Topmost first (higher ULID = newer)
  });

  // Find first valid snap (respects nesting order)
  for (const { handle, frame } of candidates) {
    const shapeType = (handle.y.get('shapeType') as string) || 'rect';
    const snap = computeSnapForShape(handle.id, frame, shapeType, ctx);
    if (snap) return snap;
  }

  return null;
}

/**
 * Compute snap target for a single shape.
 *
 * Implements the UX spec:
 * - Inside shape (deep): only midpoints available
 * - Outside/near edge: snap to edge, midpoints are sticky
 *
 * @param shapeId - ID of the shape
 * @param frame - Shape frame
 * @param shapeType - Shape type ('rect', 'ellipse', 'diamond', etc.)
 * @param ctx - Snap context
 * @returns Snap target or null if no valid snap
 */
export function computeSnapForShape(
  shapeId: string,
  frame: ShapeFrame,
  shapeType: string,
  ctx: SnapContext
): SnapTarget | null {
  const { cursorWorld, scale, prevAttach } = ctx;
  const [cx, cy] = cursorWorld;

  // Convert thresholds to world units
  const edgeSnapW = pxToWorld(SNAP_CONFIG.EDGE_SNAP_RADIUS_PX, scale);
  const midInW = pxToWorld(SNAP_CONFIG.MIDPOINT_SNAP_IN_PX, scale);
  const midOutW = pxToWorld(SNAP_CONFIG.MIDPOINT_SNAP_OUT_PX, scale);
  const insideDepthW = pxToWorld(SNAP_CONFIG.INSIDE_DEPTH_PX, scale);

  // Check if inside shape (shape-type aware)
  const isInside = pointInsideShape(cx, cy, frame, shapeType);

  // Compute depth inside (approximate - use distance to nearest edge)
  let insideDepth = 0;
  if (isInside) {
    const edgeResult = findNearestEdgePoint(cx, cy, frame, shapeType);
    insideDepth = edgeResult?.dist ?? 0;
  }

  const forceMidpointsOnly = isInside && insideDepth > insideDepthW;

  // Get midpoints (on actual shape perimeter)
  const midpoints = getShapeMidpoints(frame, shapeType);

  // Find nearest midpoint
  let nearestMidSide: Dir = 'N';
  let nearestMidDist = Infinity;
  for (const [side, pos] of Object.entries(midpoints) as [Dir, [number, number]][]) {
    const dist = Math.hypot(cx - pos[0], cy - pos[1]);
    if (dist < nearestMidDist) {
      nearestMidDist = dist;
      nearestMidSide = side;
    }
  }

  // CASE 1: Deep inside - only snap to midpoints
  if (forceMidpointsOnly) {
    return {
      shapeId,
      side: nearestMidSide,
      t: 0.5,
      isMidpoint: true,
      position: midpoints[nearestMidSide],
      isInside: true,
    };
  }

  // CASE 2: Outside or near edge - find nearest edge point
  const edgeSnap = findNearestEdgePoint(cx, cy, frame, shapeType);
  if (!edgeSnap || edgeSnap.dist > edgeSnapW) {
    // Too far from any edge
    return null;
  }

  // Check midpoint stickiness (hysteresis)
  const wasPreviouslyMidpoint =
    prevAttach?.shapeId === shapeId &&
    prevAttach?.isMidpoint &&
    prevAttach?.side === nearestMidSide;

  const distToNearestMid = nearestMidDist;
  const shouldStayMidpoint = wasPreviouslyMidpoint && distToNearestMid <= midOutW;
  const shouldEnterMidpoint = distToNearestMid <= midInW;

  if (shouldStayMidpoint || shouldEnterMidpoint) {
    return {
      shapeId,
      side: nearestMidSide,
      t: 0.5,
      isMidpoint: true,
      position: midpoints[nearestMidSide],
      isInside,
    };
  }

  // Snap to edge point (not midpoint)
  return {
    shapeId,
    side: edgeSnap.side,
    t: edgeSnap.t,
    isMidpoint: false,
    position: [edgeSnap.x, edgeSnap.y],
    isInside,
  };
}

/**
 * Check if point is inside shape (shape-type aware).
 * Reuses patterns from SelectTool's hit testing.
 */
export function pointInsideShape(
  cx: number,
  cy: number,
  frame: ShapeFrame,
  shapeType: string
): boolean {
  const { x, y, w, h } = frame;

  switch (shapeType) {
    case 'diamond': {
      const top: [number, number] = [x + w / 2, y];
      const right: [number, number] = [x + w, y + h / 2];
      const bottom: [number, number] = [x + w / 2, y + h];
      const left: [number, number] = [x, y + h / 2];
      return pointInDiamond(cx, cy, top, right, bottom, left);
    }

    case 'ellipse': {
      const ecx = x + w / 2;
      const ecy = y + h / 2;
      const rx = w / 2;
      const ry = h / 2;
      if (rx < 0.001 || ry < 0.001) return false;
      const dx = (cx - ecx) / rx;
      const dy = (cy - ecy) / ry;
      return dx * dx + dy * dy <= 1;
    }

    case 'rect':
    case 'roundedRect':
    default:
      return pointInRect(cx, cy, x, y, w, h);
  }
}

/**
 * Get midpoints on actual shape perimeter (not just frame).
 * For all current shape types, midpoints happen to be at frame edge centers.
 */
export function getShapeMidpoints(
  frame: ShapeFrame,
  _shapeType: string
): Record<Dir, [number, number]> {
  // For all current shape types, midpoints are at frame edge centers:
  // - rect: edge midpoints
  // - ellipse: 0°/90°/180°/270° on ellipse = edge midpoints
  // - diamond: vertices are at edge midpoints
  return getMidpoints(frame);
}

/**
 * Find nearest point on shape edge (shape-type aware).
 */
export function findNearestEdgePoint(
  cx: number,
  cy: number,
  frame: ShapeFrame,
  shapeType: string
): { side: Dir; t: number; x: number; y: number; dist: number } | null {
  const { x, y, w, h } = frame;

  switch (shapeType) {
    case 'diamond': {
      // Diamond edges: top→right→bottom→left→top
      const top: [number, number] = [x + w / 2, y];
      const right: [number, number] = [x + w, y + h / 2];
      const bottom: [number, number] = [x + w / 2, y + h];
      const left: [number, number] = [x, y + h / 2];

      const edges: { side: Dir; p1: [number, number]; p2: [number, number] }[] = [
        { side: 'N', p1: left, p2: top }, // NW edge → treated as N
        { side: 'E', p1: top, p2: right }, // NE edge → treated as E
        { side: 'S', p1: right, p2: bottom }, // SE edge → treated as S
        { side: 'W', p1: bottom, p2: left }, // SW edge → treated as W
      ];

      return findNearestOnEdges(cx, cy, edges);
    }

    case 'ellipse': {
      // For ellipse: find closest point on perimeter
      const ecx = x + w / 2;
      const ecy = y + h / 2;
      const rx = w / 2;
      const ry = h / 2;

      if (rx < 0.001 || ry < 0.001) return null;

      // Angle from center to cursor
      const angle = Math.atan2((cy - ecy) / ry, (cx - ecx) / rx);

      // Point on ellipse at that angle
      const px = ecx + rx * Math.cos(angle);
      const py = ecy + ry * Math.sin(angle);
      const dist = Math.hypot(cx - px, cy - py);

      // Determine side based on angle
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

      // t along that side (approximate - project onto side axis)
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
      // Rectangle edges
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

/**
 * Helper: find nearest point among a list of edges.
 */
function findNearestOnEdges(
  cx: number,
  cy: number,
  edges: { side: Dir; p1: [number, number]; p2: [number, number] }[]
): { side: Dir; t: number; x: number; y: number; dist: number } | null {
  let best: { side: Dir; t: number; x: number; y: number; dist: number } | null = null;

  for (const edge of edges) {
    const [x1, y1] = edge.p1;
    const [x2, y2] = edge.p2;
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.hypot(dx, dy);
    if (len < 0.001) continue;

    // Project cursor onto edge
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
