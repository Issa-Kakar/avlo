/**
 * Hit Primitives — pure geometry math, tuple-first.
 *
 * All functions here are stateless and take Point tuples or concrete
 * BBoxTuple/FrameTuple. No ObjectHandle/Y.Map dependencies. No WorldBounds
 * objects cross the boundary — use converters in bounds.ts if needed.
 */

import type { BBoxTuple, FrameTuple, Point } from '../types/geometry';

// ============================================================================
// Point / segment primitives
// ============================================================================

/** Distance from a point to a line segment. */
export function pointToSegmentDistance(p: Point, a: Point, b: Point): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];

  if (dx === 0 && dy === 0) {
    return Math.hypot(p[0] - a[0], p[1] - a[1]);
  }

  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy)));
  const projX = a[0] + t * dx;
  const projY = a[1] + t * dy;

  return Math.hypot(p[0] - projX, p[1] - projY);
}

/** Point inside a BBoxTuple [minX, minY, maxX, maxY]. */
export function pointInBBox(p: Point, bbox: BBoxTuple): boolean {
  return p[0] >= bbox[0] && p[0] <= bbox[2] && p[1] >= bbox[1] && p[1] <= bbox[3];
}

/** Segment-segment intersection (CCW orientation). */
export function segmentsIntersect(a1: Point, a2: Point, b1: Point, b2: Point): boolean {
  const ccw = (ax: number, ay: number, bx: number, by: number, cx: number, cy: number) => (cy - ay) * (bx - ax) > (by - ay) * (cx - ax);
  return (
    ccw(a1[0], a1[1], b1[0], b1[1], b2[0], b2[1]) !== ccw(a2[0], a2[1], b1[0], b1[1], b2[0], b2[1]) &&
    ccw(a1[0], a1[1], a2[0], a2[1], b1[0], b1[1]) !== ccw(a1[0], a1[1], a2[0], a2[1], b2[0], b2[1])
  );
}

/** Two BBoxes intersect. */
export function bboxesIntersect(a: BBoxTuple, b: BBoxTuple): boolean {
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}

/** Segment intersects a BBoxTuple. */
export function segmentIntersectsBBox(a: Point, b: Point, bbox: BBoxTuple): boolean {
  if (pointInBBox(a, bbox) || pointInBBox(b, bbox)) return true;

  const [minX, minY, maxX, maxY] = bbox;
  const tl: Point = [minX, minY];
  const tr: Point = [maxX, minY];
  const br: Point = [maxX, maxY];
  const bl: Point = [minX, maxY];
  if (segmentsIntersect(a, b, tl, tr)) return true;
  if (segmentsIntersect(a, b, tr, br)) return true;
  if (segmentsIntersect(a, b, br, bl)) return true;
  if (segmentsIntersect(a, b, bl, tl)) return true;
  return false;
}

/**
 * Polyline intersects a BBoxTuple — fused per-segment loop with bbox prefilter.
 *
 * For each segment: cheap reject if both endpoints are outside the same side
 * of the bbox, then endpoint-in-bbox shortcut (free since we just read them),
 * finally a 4-edge cross test only for segments that straddle the bbox. Long
 * strokes that miss the query bbox short-circuit at the first compare per
 * segment.
 */
export function polylineIntersectsBBox(points: readonly Point[], bbox: BBoxTuple): boolean {
  const [bxMin, byMin, bxMax, byMax] = bbox;
  const n = points.length;
  if (n === 0) return false;
  if (n === 1) {
    const [x, y] = points[0];
    return x >= bxMin && x <= bxMax && y >= byMin && y <= byMax;
  }
  for (let i = 0; i < n - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const x1 = a[0],
      y1 = a[1],
      x2 = b[0],
      y2 = b[1];
    if ((x1 < bxMin && x2 < bxMin) || (x1 > bxMax && x2 > bxMax) || (y1 < byMin && y2 < byMin) || (y1 > byMax && y2 > byMax)) continue;
    if (x1 >= bxMin && x1 <= bxMax && y1 >= byMin && y1 <= byMax) return true;
    if (x2 >= bxMin && x2 <= bxMax && y2 >= byMin && y2 <= byMax) return true;
    if (segmentsIntersect(a, b, [bxMin, byMin], [bxMax, byMin])) return true;
    if (segmentsIntersect(a, b, [bxMax, byMin], [bxMax, byMax])) return true;
    if (segmentsIntersect(a, b, [bxMax, byMax], [bxMin, byMax])) return true;
    if (segmentsIntersect(a, b, [bxMin, byMax], [bxMin, byMin])) return true;
  }
  return false;
}

/** Point inside a radius of a polyline (stroke hit test). */
export function strokeHitTest(p: Point, points: readonly Point[], radius: number): boolean {
  if (points.length === 1) {
    const dx = p[0] - points[0][0];
    const dy = p[1] - points[0][1];
    return dx * dx + dy * dy <= radius * radius;
  }
  for (let i = 0; i < points.length - 1; i++) {
    if (pointToSegmentDistance(p, points[i], points[i + 1]) <= radius) return true;
  }
  return false;
}

/** Circle-rect intersection against a FrameTuple. */
export function circleRectIntersect(c: Point, r: number, frame: FrameTuple): boolean {
  const [x, y, w, h] = frame;
  const closestX = Math.max(x, Math.min(c[0], x + w));
  const closestY = Math.max(y, Math.min(c[1], y + h));
  const dx = c[0] - closestX;
  const dy = c[1] - closestY;
  return dx * dx + dy * dy <= r * r;
}

// ============================================================================
// Shape primitives (diamond, ellipse, rect/roundedRect)
// ============================================================================

/** Diamond vertices from frame tuple — vertices at edge midpoints (top, right, bottom, left). */
export function getDiamondVertices(frame: FrameTuple): [Point, Point, Point, Point] {
  const [x, y, w, h] = frame;
  return [
    [x + w / 2, y],
    [x + w, y + h / 2],
    [x + w / 2, y + h],
    [x, y + h / 2],
  ];
}

/** Point inside a diamond (convex polygon via cross product sign test). */
export function pointInDiamond(p: Point, vertices: readonly [Point, Point, Point, Point]): boolean {
  let sign: number | null = null;
  for (let i = 0; i < 4; i++) {
    const [x1, y1] = vertices[i];
    const [x2, y2] = vertices[(i + 1) % 4];
    const cross = (x2 - x1) * (p[1] - y1) - (y2 - y1) * (p[0] - x1);
    if (sign === null) {
      sign = cross >= 0 ? 1 : -1;
    } else if ((cross >= 0 ? 1 : -1) !== sign) {
      return false;
    }
  }
  return true;
}

/** Point inside a shape interior (rect/roundedRect/ellipse/diamond). */
export function pointInsideShape(c: Point, frame: FrameTuple, shapeType: string): boolean {
  const [x, y, w, h] = frame;

  switch (shapeType) {
    case 'diamond':
      return pointInDiamond(c, getDiamondVertices(frame));
    case 'ellipse': {
      const ecx = x + w / 2;
      const ecy = y + h / 2;
      const rx = w / 2;
      const ry = h / 2;
      if (rx < 0.001 || ry < 0.001) return false;
      const dx = (c[0] - ecx) / rx;
      const dy = (c[1] - ecy) / ry;
      return dx * dx + dy * dy <= 1;
    }
    case 'rect':
    case 'roundedRect':
    default:
      return c[0] >= x && c[0] <= x + w && c[1] >= y && c[1] <= y + h;
  }
}

/** Distance from cursor to the nearest shape edge, if within tolerance. */
export function shapeEdgeHitTest(c: Point, tolerance: number, frame: FrameTuple, shapeType: string): number | null {
  const [x, y, w, h] = frame;

  switch (shapeType) {
    case 'diamond': {
      const v = getDiamondVertices(frame);
      let minDist = Infinity;
      for (let i = 0; i < 4; i++) {
        const dist = pointToSegmentDistance(c, v[i], v[(i + 1) % 4]);
        if (dist < minDist) minDist = dist;
      }
      return minDist <= tolerance ? minDist : null;
    }
    case 'ellipse': {
      const ecx = x + w / 2;
      const ecy = y + h / 2;
      const rx = w / 2;
      const ry = h / 2;
      if (rx < 0.001 || ry < 0.001) return null;
      const dx = (c[0] - ecx) / rx;
      const dy = (c[1] - ecy) / ry;
      const normalizedDist = Math.sqrt(dx * dx + dy * dy);
      const avgRadius = (rx + ry) / 2;
      const normalizedTolerance = tolerance / avgRadius;
      const distFromEdge = Math.abs(normalizedDist - 1);
      return distFromEdge <= normalizedTolerance ? distFromEdge * avgRadius : null;
    }
    case 'rect':
    case 'roundedRect':
    default: {
      const tl: Point = [x, y];
      const tr: Point = [x + w, y];
      const br: Point = [x + w, y + h];
      const bl: Point = [x, y + h];
      let minDist = Infinity;
      const d1 = pointToSegmentDistance(c, tl, tr);
      if (d1 < minDist) minDist = d1;
      const d2 = pointToSegmentDistance(c, tr, br);
      if (d2 < minDist) minDist = d2;
      const d3 = pointToSegmentDistance(c, br, bl);
      if (d3 < minDist) minDist = d3;
      const d4 = pointToSegmentDistance(c, bl, tl);
      if (d4 < minDist) minDist = d4;
      return minDist <= tolerance ? minDist : null;
    }
  }
}

/**
 * Shape hit test: returns distance (0 if inside) and interior flag.
 * Pure geometry — caller decides fill-awareness.
 */
export function shapeHitTest(
  c: Point,
  tolerance: number,
  frame: FrameTuple,
  shapeType: string,
  strokeWidth: number,
): { distance: number; insideInterior: boolean } | null {
  const insideInterior = pointInsideShape(c, frame, shapeType);
  if (insideInterior) {
    return { distance: 0, insideInterior: true };
  }
  const halfStroke = strokeWidth / 2;
  const nearEdge = shapeEdgeHitTest(c, tolerance + halfStroke, frame, shapeType);
  if (nearEdge !== null) {
    return { distance: nearEdge, insideInterior: false };
  }
  return null;
}

/**
 * Point-vs-rect hit test for framed kinds (text/code/note/image/bookmark).
 * No shapeType switch, no stroke padding — these kinds always paint their
 * full frame and have no border to be near.
 */
export function rectFrameHit(c: Point, r: number, frame: FrameTuple): { distance: number; insideInterior: boolean } | null {
  const [x, y, w, h] = frame;
  if (c[0] >= x && c[0] <= x + w && c[1] >= y && c[1] <= y + h) {
    return { distance: 0, insideInterior: true };
  }
  const closestX = Math.max(x, Math.min(c[0], x + w));
  const closestY = Math.max(y, Math.min(c[1], y + h));
  const dx = c[0] - closestX;
  const dy = c[1] - closestY;
  const dist = Math.hypot(dx, dy);
  return dist <= r ? { distance: dist, insideInterior: false } : null;
}

/**
 * Circle-vs-shape hit test for the eraser. Handles rect/roundedRect/ellipse/diamond
 * with fill-aware semantics (filled = anywhere inside hits; unfilled = edge only).
 */
export function circleHitsShape(
  c: Point,
  r: number,
  frame: FrameTuple,
  shapeType: string,
  strokeWidth: number,
  isFilled: boolean,
): boolean {
  const [x, y, w, h] = frame;
  const halfStroke = strokeWidth / 2;

  switch (shapeType) {
    case 'diamond': {
      const v = getDiamondVertices(frame);
      if (isFilled && pointInDiamond(c, v)) return true;
      for (let i = 0; i < 4; i++) {
        if (pointToSegmentDistance(c, v[i], v[(i + 1) % 4]) <= r + halfStroke) return true;
      }
      return false;
    }

    case 'ellipse': {
      const ecx = x + w / 2;
      const ecy = y + h / 2;
      const rx = w / 2;
      const ry = h / 2;
      if (rx < 0.001 || ry < 0.001) {
        return circleRectIntersect(c, r, frame);
      }
      const dx = (c[0] - ecx) / rx;
      const dy = (c[1] - ecy) / ry;
      const normalizedDist = Math.sqrt(dx * dx + dy * dy);
      const avgRadius = (rx + ry) / 2;
      const normalizedR = r / avgRadius;
      const normalizedStroke = halfStroke / avgRadius;
      if (isFilled) {
        return normalizedDist <= 1 + normalizedR + normalizedStroke;
      }
      const distFromEdge = Math.abs(normalizedDist - 1);
      return distFromEdge <= normalizedR + normalizedStroke;
    }

    case 'rect':
    case 'roundedRect':
    default: {
      if (isFilled) {
        return circleRectIntersect(c, r + halfStroke, frame);
      }
      const tl: Point = [x, y];
      const tr: Point = [x + w, y];
      const br: Point = [x + w, y + h];
      const bl: Point = [x, y + h];
      const tol = r + halfStroke;
      if (pointToSegmentDistance(c, tl, tr) <= tol) return true;
      if (pointToSegmentDistance(c, tr, br) <= tol) return true;
      if (pointToSegmentDistance(c, br, bl) <= tol) return true;
      if (pointToSegmentDistance(c, bl, tl) <= tol) return true;
      return false;
    }
  }
}

// ============================================================================
// Marquee intersections (tuple-first)
// ============================================================================

/** Ellipse (centered) intersects BBox. */
export function ellipseIntersectsBBox(ecx: number, ecy: number, rx: number, ry: number, bbox: BBoxTuple): boolean {
  const ellipseBBox: BBoxTuple = [ecx - rx, ecy - ry, ecx + rx, ecy + ry];
  if (!bboxesIntersect(ellipseBBox, bbox)) return false;
  if (pointInBBox([ecx, ecy], bbox)) return true;

  const [minX, minY, maxX, maxY] = bbox;
  const corners: Point[] = [
    [minX, minY],
    [maxX, minY],
    [maxX, maxY],
    [minX, maxY],
  ];
  for (const [cx, cy] of corners) {
    const dx = (cx - ecx) / rx;
    const dy = (cy - ecy) / ry;
    if (dx * dx + dy * dy <= 1) return true;
  }

  const SAMPLES = 16;
  for (let i = 0; i < SAMPLES; i++) {
    const angle = (i / SAMPLES) * Math.PI * 2;
    if (pointInBBox([ecx + rx * Math.cos(angle), ecy + ry * Math.sin(angle)], bbox)) return true;
  }
  return false;
}

/** Diamond intersects BBox. */
export function diamondIntersectsBBox(vertices: readonly [Point, Point, Point, Point], bbox: BBoxTuple): boolean {
  for (const v of vertices) {
    if (pointInBBox(v, bbox)) return true;
  }
  const [minX, minY, maxX, maxY] = bbox;
  const corners: Point[] = [
    [minX, minY],
    [maxX, minY],
    [maxX, maxY],
    [minX, maxY],
  ];
  for (const c of corners) {
    if (pointInDiamond(c, vertices)) return true;
  }
  for (let i = 0; i < 4; i++) {
    if (segmentIntersectsBBox(vertices[i], vertices[(i + 1) % 4], bbox)) return true;
  }
  return false;
}
