/**
 * $P normalization pipeline on `Float64Array` (interleaved xy).
 *   resampleInto    — N evenly-spaced points along the path
 *   scaleToUnitInPlace — fit unit square preserving aspect ratio
 *   translateToOriginInPlace — centroid → origin
 *   normalizeInto   — composition of the three (the public-ish entry)
 *
 * All operations preserve $P paper semantics. Buffers MUST have capacity
 * `2 * n`. `*Into` returns the resulting point count where applicable.
 */

import { pathLength } from './point-buffer';

/**
 * Resample `count` interleaved points in `src` to exactly `n` evenly-spaced
 * points written into `dst`. Matches the $P paper's algorithm: walk the path,
 * synthesize a new point each time accumulated distance crosses `I = totalLen / (n - 1)`.
 *
 * Degenerate input (empty / zero-length / single point) collapses to `n` copies
 * of the first point. Padding at the tail handles float-rounding shortfalls.
 *
 * NOTE: the legacy implementation `splice`-d the synthesized point into the
 * input array and treated it as the next "prev". We replicate that by tracking
 * `prev{X,Y}` in locals and overwriting on synthesis — same numerical path.
 */
export function resampleInto(src: Float64Array, count: number, dst: Float64Array, n: number): number {
  if (count === 0) return 0;

  const firstX = src[0];
  const firstY = src[1];

  if (count === 1) {
    for (let k = 0; k < n; k++) {
      dst[2 * k] = firstX;
      dst[2 * k + 1] = firstY;
    }
    return n;
  }

  const I = pathLength(src, count) / Math.max(1, n - 1);
  if (!Number.isFinite(I) || I <= 1e-9) {
    for (let k = 0; k < n; k++) {
      dst[2 * k] = firstX;
      dst[2 * k + 1] = firstY;
    }
    return n;
  }

  dst[0] = firstX;
  dst[1] = firstY;
  let written = 1;

  let prevX = firstX;
  let prevY = firstY;
  let D = 0;

  for (let i = 1; i < count; i++) {
    const currX = src[2 * i];
    const currY = src[2 * i + 1];
    const dx = currX - prevX;
    const dy = currY - prevY;
    const d = Math.hypot(dx, dy);
    if (d <= 1e-12) {
      prevX = currX;
      prevY = currY;
      continue;
    }

    if (D + d >= I) {
      const t = (I - D) / d;
      const qx = prevX + t * dx;
      const qy = prevY + t * dy;
      if (written < n) {
        dst[2 * written] = qx;
        dst[2 * written + 1] = qy;
      }
      written++;
      // q becomes the next "prev" (legacy `splice(i, 0, q)` semantic).
      // Re-evaluate the same `curr` against q by keeping `i` (loop's `i++` undoes the `i--`).
      prevX = qx;
      prevY = qy;
      D = 0;
      i--;
    } else {
      D += d;
      prevX = currX;
      prevY = currY;
    }
  }

  // Pad with the original last input point (legacy: `points[points.length - 1]`).
  const padX = src[2 * (count - 1)];
  const padY = src[2 * (count - 1) + 1];
  while (written < n) {
    dst[2 * written] = padX;
    dst[2 * written + 1] = padY;
    written++;
  }
  return n;
}

/**
 * Scale `n` interleaved points in `buf` to fit the unit square, preserving
 * aspect ratio (uses `max(width, height)` as the divisor). In-place.
 *
 * Degenerate (zero extent): collapses to all-zero — matches legacy.
 */
export function scaleToUnitInPlace(buf: Float64Array, n: number): void {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = buf[2 * i];
    const y = buf[2 * i + 1];
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  const w = maxX - minX;
  const h = maxY - minY;
  const scale = w > h ? w : h;

  if (!Number.isFinite(scale) || scale <= 1e-12) {
    buf.fill(0, 0, 2 * n);
    return;
  }

  for (let i = 0; i < n; i++) {
    buf[2 * i] = (buf[2 * i] - minX) / scale;
    buf[2 * i + 1] = (buf[2 * i + 1] - minY) / scale;
  }
}

/** Translate `n` interleaved points in `buf` so the centroid is at the origin. In-place. */
export function translateToOriginInPlace(buf: Float64Array, n: number): void {
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < n; i++) {
    cx += buf[2 * i];
    cy += buf[2 * i + 1];
  }
  cx /= n;
  cy /= n;
  for (let i = 0; i < n; i++) {
    buf[2 * i] -= cx;
    buf[2 * i + 1] -= cy;
  }
}

/**
 * Full normalization pipeline: resample → scale → translate. Writes `n` points
 * into `dst`. Returns `n`.
 */
export function normalizeInto(src: Float64Array, count: number, dst: Float64Array, n: number): number {
  resampleInto(src, count, dst, n);
  scaleToUnitInPlace(dst, n);
  translateToOriginInPlace(dst, n);
  return n;
}
