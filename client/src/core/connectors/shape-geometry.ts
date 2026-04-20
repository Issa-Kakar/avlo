/**
 * Pure shape geometry — rect / ellipse / diamond math with zero connector dependencies.
 *
 * Home for the atoms that the snap pipeline, straight ray-cast, and elbow/straight
 * renderers all need: centers, half-extents, edge arrays, midpoints, nearest-edge,
 * ray × shape intersection, ellipse-angle → Dir.
 *
 * Every caller gets the same named primitive instead of rebuilding `w/2`,
 * `h/2`, four-entry N/E/S/W arrays, or atan2 quadrant maps inline.
 *
 * @module core/connectors/shape-geometry
 */
import type { FrameTuple, Point } from '../types/geometry';
import { frameCenter } from '../geometry/bounds';
import type { Dir } from './types';

// ============================================================================
// TYPES
// ============================================================================

/** A shape edge with its authoritative cardinal side. */
export interface ShapeEdge {
  side: Dir;
  p1: Point;
  p2: Point;
}

/** A successful nearest-edge probe result. */
export interface NearestEdgeHit {
  side: Dir;
  t: number;
  x: number;
  y: number;
  dist: number;
}

// ============================================================================
// ATOMS
// ============================================================================

export const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

export { frameCenter };

export function halfExtents(f: FrameTuple): [number, number] {
  return [f[2] / 2, f[3] / 2];
}

/** Bring an atan2 result into [0, 2π). */
export function normalizeAngle(a: number): number {
  return (a + Math.PI * 2) % (Math.PI * 2);
}

/** 8-octant thresholds → Dir (shared by ellipse nearest-edge + ellipse ray cast). */
export function ellipseSideFromAngle(normAngle: number): Dir {
  if (normAngle < Math.PI / 4 || normAngle >= (Math.PI * 7) / 4) return 'E';
  if (normAngle < (Math.PI * 3) / 4) return 'S';
  if (normAngle < (Math.PI * 5) / 4) return 'W';
  return 'N';
}

// ============================================================================
// EDGE + VERTEX CONSTRUCTORS
// ============================================================================

/** Rect edge midpoints (also used for ellipse/roundedRect). */
export function rectMidpoints(f: FrameTuple): Record<Dir, Point> {
  const [x, y, w, h] = f;
  return {
    N: [x + w / 2, y],
    E: [x + w, y + h / 2],
    S: [x + w / 2, y + h],
    W: [x, y + h / 2],
  };
}

/** Diamond apex vertices — rect midpoints align with the mathematical diamond vertices. */
export function diamondVertices(f: FrameTuple): Record<Dir, Point> {
  return rectMidpoints(f);
}

/** Rect's four edges — consumed by ray-cast + nearest-edge. */
export function rectEdges(f: FrameTuple): ShapeEdge[] {
  const [x, y, w, h] = f;
  return [
    { side: 'N', p1: [x, y], p2: [x + w, y] },
    { side: 'E', p1: [x + w, y], p2: [x + w, y + h] },
    { side: 'S', p1: [x, y + h], p2: [x + w, y + h] },
    { side: 'W', p1: [x, y], p2: [x, y + h] },
  ];
}

/** Diamond's four edges (between vertex midpoints) — consumed by ray-cast + nearest-edge. */
export function diamondEdges(f: FrameTuple): ShapeEdge[] {
  const v = diamondVertices(f);
  return [
    { side: 'N', p1: v.W, p2: v.N },
    { side: 'E', p1: v.N, p2: v.E },
    { side: 'S', p1: v.E, p2: v.S },
    { side: 'W', p1: v.S, p2: v.W },
  ];
}

// ============================================================================
// SHAPE MIDPOINTS
// ============================================================================

/**
 * N/E/S/W world points on a shape's edge.
 * Rect / ellipse / roundedRect: frame edge centers.
 * Diamond: apex of each rounded corner (inset from the mathematical vertex).
 */
export function shapeMidpoints(frame: FrameTuple, shapeType: string): Record<Dir, Point> {
  if (shapeType === 'diamond') return getDiamondApexMidpoints(frame);
  return rectMidpoints(frame);
}

/**
 * Rounded-diamond apex positions.
 *
 * For a rounded corner, the visual tip is the apex of the inscribed arc —
 * inset from the mathematical vertex by `radius * (csc(halfAngle) - 1)`
 * where halfAngle is half the angle between the two edges meeting at the vertex.
 * Corner radius matches the diamond render in `object-cache.ts`.
 */
function getDiamondApexMidpoints(frame: FrameTuple): Record<Dir, Point> {
  const [x, y, w, h] = frame;
  const radius = Math.min(20, Math.min(w, h) * 0.1);

  if (radius < 0.5) return rectMidpoints(frame);

  const [cx, cy] = frameCenter(frame);
  const h2 = h * h;
  const w2 = w * w;
  const sumSq = h2 + w2;

  // Corner angles (top/bottom vs left/right) via dot product of edge vectors.
  const halfTheta_TB = Math.acos(Math.max(-1, Math.min(1, (h2 - w2) / sumSq))) / 2;
  const halfTheta_LR = Math.acos(Math.max(-1, Math.min(1, (w2 - h2) / sumSq))) / 2;

  const minSin = 0.1; // ~6° half-angle minimum; prevents explosion for very acute angles
  const maxOffset = radius * 2;
  const offset_TB = Math.min(radius * (1 / Math.max(Math.sin(halfTheta_TB), minSin) - 1), maxOffset);
  const offset_LR = Math.min(radius * (1 / Math.max(Math.sin(halfTheta_LR), minSin) - 1), maxOffset);

  return {
    N: [cx, y + offset_TB],
    E: [x + w - offset_LR, cy],
    S: [cx, y + h - offset_TB],
    W: [x + offset_LR, cy],
  };
}

// ============================================================================
// NEAREST-EDGE-POINT
// ============================================================================

/** Closest point on the shape's boundary to `probe`, with authoritative side. */
export function findNearestEdgePoint(probe: Point, frame: FrameTuple, shapeType: string): NearestEdgeHit | null {
  if (shapeType === 'diamond') return findNearestOnEdges(probe, diamondEdges(frame));
  if (shapeType === 'ellipse') {
    const [cx, cy] = frameCenter(frame);
    const [rx, ry] = halfExtents(frame);
    if (rx < 0.001 || ry < 0.001) return null;
    const angle = Math.atan2((probe[1] - cy) / ry, (probe[0] - cx) / rx);
    const px = cx + rx * Math.cos(angle);
    const py = cy + ry * Math.sin(angle);
    const side = ellipseSideFromAngle(normalizeAngle(angle));
    const dist = Math.hypot(probe[0] - px, probe[1] - py);
    const t = clamp01(side === 'N' || side === 'S' ? (px - frame[0]) / frame[2] : (py - frame[1]) / frame[3]);
    return { side, t, x: px, y: py, dist };
  }
  return findNearestOnEdges(probe, rectEdges(frame));
}

/** Nearest point among a list of edges (shared by rect and diamond). */
function findNearestOnEdges(probe: Point, edges: ShapeEdge[]): NearestEdgeHit | null {
  const [cx, cy] = probe;
  let best: NearestEdgeHit | null = null;

  for (const edge of edges) {
    const [x1, y1] = edge.p1;
    const [x2, y2] = edge.p2;
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.hypot(dx, dy);
    if (len < 0.001) continue;

    const t = clamp01(((cx - x1) * dx + (cy - y1) * dy) / (len * len));
    const px = x1 + t * dx;
    const py = y1 + t * dy;
    const dist = Math.hypot(cx - px, cy - py);

    if (!best || dist < best.dist) {
      best = { side: edge.side, t, x: px, y: py, dist };
    }
  }

  return best;
}

// ============================================================================
// RAY × SHAPE
// ============================================================================

/**
 * Find where a ray from an interior point toward a target exits a convex shape.
 * Used by straight connectors with interior anchors — the visible line stops at
 * the shape edge; a dashed guide covers the interior segment.
 */
export function computeShapeEdgeIntersection(
  shapeType: string,
  frame: FrameTuple,
  interiorPoint: Point,
  target: Point,
): { point: Point; side: Dir } | null {
  if (frame[2] < 0.001 || frame[3] < 0.001) return null;
  const dir: Point = [target[0] - interiorPoint[0], target[1] - interiorPoint[1]];
  if (Math.abs(dir[0]) < 1e-9 && Math.abs(dir[1]) < 1e-9) return null;

  switch (shapeType) {
    case 'ellipse':
      return rayEllipseIntersection(frame, interiorPoint, dir);
    case 'diamond':
      return rayDiamondIntersection(frame, interiorPoint, dir);
    default:
      return rayRectIntersection(frame, interiorPoint, dir); // rect, roundedRect
  }
}

/** Ray vs axis-aligned rectangle — smallest positive t across four edges. */
function rayRectIntersection(frame: FrameTuple, origin: Point, dir: Point): { point: Point; side: Dir } | null {
  const [ox, oy] = origin;
  const [dx, dy] = dir;
  let bestT = Infinity;
  let bestSide: Dir = 'N';

  for (const edge of rectEdges(frame)) {
    const horizontal = edge.side === 'N' || edge.side === 'S';
    const d = horizontal ? dy : dx;
    const o = horizontal ? oy : ox;
    const edgeVal = horizontal ? edge.p1[1] : edge.p1[0];
    if (Math.abs(d) < 1e-12) continue;

    const t = (edgeVal - o) / d;
    if (t <= 1e-9 || t >= bestT) continue;

    const cross = horizontal ? ox + t * dx : oy + t * dy;
    const cMin = horizontal ? Math.min(edge.p1[0], edge.p2[0]) : Math.min(edge.p1[1], edge.p2[1]);
    const cMax = horizontal ? Math.max(edge.p1[0], edge.p2[0]) : Math.max(edge.p1[1], edge.p2[1]);
    if (cross >= cMin - 0.001 && cross <= cMax + 0.001) {
      bestT = t;
      bestSide = edge.side;
    }
  }

  if (bestT === Infinity) return null;
  return { point: [ox + bestT * dx, oy + bestT * dy], side: bestSide };
}

/** Ray vs ellipse — solve quadratic in parameter t. */
function rayEllipseIntersection(frame: FrameTuple, origin: Point, dir: Point): { point: Point; side: Dir } | null {
  const [ox, oy] = origin;
  const [dx, dy] = dir;
  const [cx, cy] = frameCenter(frame);
  const [rx, ry] = halfExtents(frame);

  const a = (dx * dx) / (rx * rx) + (dy * dy) / (ry * ry);
  const b = 2 * (((ox - cx) * dx) / (rx * rx) + ((oy - cy) * dy) / (ry * ry));
  const c = (ox - cx) ** 2 / (rx * rx) + (oy - cy) ** 2 / (ry * ry) - 1;

  const disc = b * b - 4 * a * c;
  if (disc < 0) return null;

  const sqrtDisc = Math.sqrt(disc);
  const t1 = (-b + sqrtDisc) / (2 * a);
  const t2 = (-b - sqrtDisc) / (2 * a);

  let t = Infinity;
  if (t1 > 1e-9 && t1 < t) t = t1;
  if (t2 > 1e-9 && t2 < t) t = t2;
  if (t === Infinity) return null;

  const px = ox + t * dx;
  const py = oy + t * dy;
  const side = ellipseSideFromAngle(normalizeAngle(Math.atan2(py - cy, px - cx)));
  return { point: [px, py], side };
}

/** Ray vs diamond (4 diagonal segments, Cramer's rule per segment). */
function rayDiamondIntersection(frame: FrameTuple, origin: Point, dir: Point): { point: Point; side: Dir } | null {
  const [ox, oy] = origin;
  const [dx, dy] = dir;
  let bestT = Infinity;
  let bestSide: Dir = 'N';

  for (const seg of diamondEdges(frame)) {
    const ex = seg.p2[0] - seg.p1[0];
    const ey = seg.p2[1] - seg.p1[1];
    const denom = dx * ey - dy * ex;
    if (Math.abs(denom) < 1e-12) continue;

    const t = ((seg.p1[0] - ox) * ey - (seg.p1[1] - oy) * ex) / denom;
    const u = ((seg.p1[0] - ox) * dy - (seg.p1[1] - oy) * dx) / denom;

    if (t > 1e-9 && t < bestT && u >= -0.001 && u <= 1.001) {
      bestT = t;
      bestSide = seg.side;
    }
  }

  if (bestT === Infinity) return null;
  return { point: [ox + bestT * dx, oy + bestT * dy], side: bestSide };
}
