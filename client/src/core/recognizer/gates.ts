/**
 * Post-normalization gates: turn count + quadrant occupation.
 * Operates on normalized 32-point buffers (centroid at origin, fits unit square).
 *
 * Re-exports the pre-normalization gates from `self-intersect.ts` so callers
 * import "gates" once and get all four checks.
 */

export { hasNearTouch, hasSelfIntersection } from './self-intersect';

/**
 * Count significant turns ( > `minTurnDeg`) between consecutive segments in
 * an interleaved-xy buffer of `n` points. Used on normalized candidates.
 */
export function countSignificantTurns(buf: Float64Array, n: number, minTurnDeg: number): number {
  if (n < 3) return 0;
  const minTurnRad = (minTurnDeg * Math.PI) / 180;
  const TWO_PI = 2 * Math.PI;
  let turns = 0;

  for (let i = 1; i < n - 1; i++) {
    const x0 = buf[2 * (i - 1)];
    const y0 = buf[2 * (i - 1) + 1];
    const x1 = buf[2 * i];
    const y1 = buf[2 * i + 1];
    const x2 = buf[2 * (i + 1)];
    const y2 = buf[2 * (i + 1) + 1];

    const a1 = Math.atan2(y1 - y0, x1 - x0);
    const a2 = Math.atan2(y2 - y1, x2 - x1);
    let turn = a2 - a1;
    if (turn > Math.PI) turn -= TWO_PI;
    else if (turn < -Math.PI) turn += TWO_PI;

    if (turn > minTurnRad || turn < -minTurnRad) turns++;
  }
  return turns;
}

/**
 * Fraction of the four quadrants (around origin) that contain at least one
 * point. Returns 0, 0.25, 0.5, 0.75, or 1. Buffer is assumed centered.
 */
export function quadrantOccupation(buf: Float64Array, n: number): number {
  let q0 = false,
    q1 = false,
    q2 = false,
    q3 = false;
  for (let i = 0; i < n; i++) {
    const x = buf[2 * i];
    const y = buf[2 * i + 1];
    // 0=NE (x≥0,y≥0), 1=NW (x<0,y≥0), 2=SE (x≥0,y<0), 3=SW (x<0,y<0)
    const idx = (x < 0 ? 1 : 0) + (y < 0 ? 2 : 0);
    if (idx === 0) q0 = true;
    else if (idx === 1) q1 = true;
    else if (idx === 2) q2 = true;
    else q3 = true;
  }
  return ((q0 ? 1 : 0) + (q1 ? 1 : 0) + (q2 ? 1 : 0) + (q3 ? 1 : 0)) / 4;
}
