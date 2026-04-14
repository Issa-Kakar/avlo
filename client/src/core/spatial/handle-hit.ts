/**
 * Handle hit testing — non-spatial sibling layer.
 *
 * Resize handles and connector endpoint dots are tiny, transient, and derived
 * from selection state — they don't live in the spatial index. But the mental
 * model ("find the nearest probe within a radius") matches the spatial pipeline,
 * so we keep the same vocabulary here without touching the spatial index.
 *
 * Caller passes the radius explicitly, so screen-vs-world units are unambiguous.
 */

import type { Point } from '@/core/types/geometry';

export interface HandleProbe<T> {
  readonly center: Point;
  readonly value: T;
}

/**
 * Find the nearest probe within `r` of `p`. Returns the matching probe's
 * value, or `null` if no probe is within range. Squared distance comparison —
 * no `Math.hypot` per probe.
 */
export function hitNearestHandle<T>(p: Point, r: number, probes: Iterable<HandleProbe<T>>): T | null {
  const r2 = r * r;
  let bestDist2 = Infinity;
  let best: T | null = null;
  for (const probe of probes) {
    const dx = p[0] - probe.center[0];
    const dy = p[1] - probe.center[1];
    const d2 = dx * dx + dy * dy;
    if (d2 <= r2 && d2 < bestDist2) {
      bestDist2 = d2;
      best = probe.value;
    }
  }
  return best;
}
