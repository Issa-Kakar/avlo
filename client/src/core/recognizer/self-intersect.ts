/**
 * Pre-normalization gates: self-intersection and near-touch on raw stroke
 * points. Rewrite of the two live functions from the legacy
 * `geometry-helpers.ts` — zero-allocation, reads `Float64Array` (interleaved xy)
 * directly, pre-bakes segment bboxes into a module-scope scratch.
 *
 * Algorithm and output: byte-identical to the legacy implementation.
 *
 * INVARIANT — module scratches are not re-entrant. Both gates are invoked
 * sequentially inside a single `recognize()` call; no caller may invoke
 * recursively.
 */

import { hypot2 } from '@/utils/math';

// Segment-scratch layout: 8 floats per segment.
//   [0]=x1 [1]=y1 [2]=x2 [3]=y2  [4]=minx [5]=miny [6]=maxx [7]=maxy
const SEG_STRIDE = 8;
const MAX_SEGS = 1024;
const SEGS = new Float64Array(MAX_SEGS * SEG_STRIDE);

/**
 * Build padded-bbox segment list from `count` interleaved points in `buf`.
 * Skips degenerate segments shorter than `eps`. Returns segment count.
 */
function buildSegments(buf: Float64Array, count: number, eps: number): number {
  let s = 0;
  for (let i = 0; i < count - 1; i++) {
    const x1 = buf[2 * i];
    const y1 = buf[2 * i + 1];
    const x2 = buf[2 * i + 2];
    const y2 = buf[2 * i + 3];
    if (Math.hypot(x2 - x1, y2 - y1) < eps) continue;
    if (s >= MAX_SEGS) break;
    const o = s * SEG_STRIDE;
    SEGS[o] = x1;
    SEGS[o + 1] = y1;
    SEGS[o + 2] = x2;
    SEGS[o + 3] = y2;
    SEGS[o + 4] = (x1 < x2 ? x1 : x2) - eps;
    SEGS[o + 5] = (y1 < y2 ? y1 : y2) - eps;
    SEGS[o + 6] = (x1 > x2 ? x1 : x2) + eps;
    SEGS[o + 7] = (y1 > y2 ? y1 : y2) + eps;
    s++;
  }
  return s;
}

/** Classify (point - segment-line) cross product: -1 / 0 (near-collinear) / 1. */
function classify(val: number, epsSq: number): number {
  if (val < epsSq && val > -epsSq) return 0;
  return val > 0 ? 1 : -1;
}

/**
 * True if the stroke crosses itself. Excludes adjacent segment pairs and the
 * shared endpoint when the stroke is effectively closed.
 */
export function hasSelfIntersection(buf: Float64Array, count: number, eps: number): boolean {
  if (count < 4) return false;
  const segs = buildSegments(buf, count, eps);
  if (segs < 3) return false;

  const epsSq = eps * eps;

  for (let i = 0; i < segs; i++) {
    const oi = i * SEG_STRIDE;
    const ax1 = SEGS[oi];
    const ay1 = SEGS[oi + 1];
    const ax2 = SEGS[oi + 2];
    const ay2 = SEGS[oi + 3];
    const aMinX = SEGS[oi + 4];
    const aMinY = SEGS[oi + 5];
    const aMaxX = SEGS[oi + 6];
    const aMaxY = SEGS[oi + 7];
    const adx = ax2 - ax1;
    const ady = ay2 - ay1;

    for (let j = i + 1; j < segs; j++) {
      if (j === i + 1) continue; // adjacent share a point

      const oj = j * SEG_STRIDE;

      // Closed-stroke first-last skip
      if (i === 0 && j === segs - 1) {
        if (hypot2(SEGS[oj + 2] - ax1, SEGS[oj + 3] - ay1) < epsSq) continue;
      }

      // Bbox rejection
      if (aMaxX < SEGS[oj + 4] || SEGS[oj + 6] < aMinX) continue;
      if (aMaxY < SEGS[oj + 5] || SEGS[oj + 7] < aMinY) continue;

      const bx1 = SEGS[oj];
      const by1 = SEGS[oj + 1];
      const bx2 = SEGS[oj + 2];
      const by2 = SEGS[oj + 3];

      // o1, o2: orientation of B's endpoints around segment A
      const o1 = classify(adx * (by1 - ay1) - ady * (bx1 - ax1), epsSq);
      const o2 = classify(adx * (by2 - ay1) - ady * (bx2 - ax1), epsSq);
      // o3, o4: orientation of A's endpoints around segment B
      const bdx = bx2 - bx1;
      const bdy = by2 - by1;
      const o3 = classify(bdx * (ay1 - by1) - bdy * (ax1 - bx1), epsSq);
      const o4 = classify(bdx * (ay2 - by1) - bdy * (ax2 - bx1), epsSq);

      // Collinear segments are not crossings (avoids over-firing on near-straight wobbles)
      if (o1 === 0 && o2 === 0 && o3 === 0 && o4 === 0) continue;

      // Proper intersection: each segment's endpoints land on opposite sides of the other
      if (o1 * o2 < 0 && o3 * o4 < 0) return true;
    }
  }
  return false;
}

/** Squared distance from point (px,py) to segment (x1,y1)-(x2,y2). */
function pointSegSq(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return hypot2(px - x1, py - y1);
  let t = ((px - x1) * dx + (py - y1) * dy) / lenSq;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  return hypot2(px - (x1 + t * dx), py - (y1 + t * dy));
}

/**
 * True if any non-adjacent segment pair has min-distance < eps. Same close-stroke
 * skip as `hasSelfIntersection`.
 */
export function hasNearTouch(buf: Float64Array, count: number, eps: number): boolean {
  if (count < 4) return false;
  const segs = buildSegments(buf, count, eps);
  if (segs < 3) return false;

  const epsSq = eps * eps;

  for (let i = 0; i < segs; i++) {
    const oi = i * SEG_STRIDE;
    const ax1 = SEGS[oi];
    const ay1 = SEGS[oi + 1];
    const ax2 = SEGS[oi + 2];
    const ay2 = SEGS[oi + 3];
    const aMinX = SEGS[oi + 4];
    const aMinY = SEGS[oi + 5];
    const aMaxX = SEGS[oi + 6];
    const aMaxY = SEGS[oi + 7];

    for (let j = i + 1; j < segs; j++) {
      if (j === i + 1) continue;

      const oj = j * SEG_STRIDE;

      if (i === 0 && j === segs - 1) {
        if (hypot2(SEGS[oj + 2] - ax1, SEGS[oj + 3] - ay1) < epsSq) continue;
      }

      if (aMaxX < SEGS[oj + 4] || SEGS[oj + 6] < aMinX) continue;
      if (aMaxY < SEGS[oj + 5] || SEGS[oj + 7] < aMinY) continue;

      const bx1 = SEGS[oj];
      const by1 = SEGS[oj + 1];
      const bx2 = SEGS[oj + 2];
      const by2 = SEGS[oj + 3];

      // Min distance = min of 4 endpoint-to-other-segment distances.
      const d1 = pointSegSq(ax1, ay1, bx1, by1, bx2, by2);
      if (d1 < epsSq) return true;
      const d2 = pointSegSq(ax2, ay2, bx1, by1, bx2, by2);
      if (d2 < epsSq) return true;
      const d3 = pointSegSq(bx1, by1, ax1, ay1, ax2, ay2);
      if (d3 < epsSq) return true;
      const d4 = pointSegSq(bx2, by2, ax1, ay1, ax2, ay2);
      if (d4 < epsSq) return true;
    }
  }
  return false;
}
