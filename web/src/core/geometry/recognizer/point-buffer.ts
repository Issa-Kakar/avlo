/**
 * Float64Array layout helpers for the recognizer.
 *
 * INVARIANT: every recognizer point buffer is `Float64Array` with interleaved
 * xy — `buf[2*i]` = x, `buf[2*i + 1]` = y. Length is always `2 * n` where `n`
 * is the point count. Functions take `(buf, count, ...)` — never read past
 * `2 * count`. The `*Into(out, ...)` family writes into a caller-owned buffer.
 */

import type { BBoxTuple, Point } from '@/core/types/geometry';

/**
 * Copy public `Point[]` into a typed buffer. `out` must have capacity ≥ `2 * src.length`.
 * Returns the point count (= `src.length`).
 */
export function copyPointsInto(src: readonly Point[], out: Float64Array): number {
  const n = src.length;
  for (let i = 0; i < n; i++) {
    const p = src[i];
    out[2 * i] = p[0];
    out[2 * i + 1] = p[1];
  }
  return n;
}

/** Total path length over `count` interleaved points in `buf`. */
export function pathLength(buf: Float64Array, count: number): number {
  let d = 0;
  for (let i = 1; i < count; i++) {
    const dx = buf[2 * i] - buf[2 * (i - 1)];
    const dy = buf[2 * i + 1] - buf[2 * (i - 1) + 1];
    d += Math.hypot(dx, dy);
  }
  return d;
}

/** Write the bbox of `count` interleaved points into `out`. */
export function bboxInto(buf: Float64Array, count: number, out: BBoxTuple): void {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < count; i++) {
    const x = buf[2 * i];
    const y = buf[2 * i + 1];
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  out[0] = minX;
  out[1] = minY;
  out[2] = maxX;
  out[3] = maxY;
}
