/**
 * $Q-optimized cloud distance — the recognizer's hot loop. Called
 * `2 * ceil(n / step)` times per template, 37 templates per recognition.
 *
 * INVARIANT: `UNMATCHED` is module-scope scratch, written by both directions
 * of `greedyCloudMatch` sequentially (never concurrent).
 */

import { PDOLLAR_CONFIG } from './constants';

const N = PDOLLAR_CONFIG.NUM_POINTS;
const UNMATCHED = new Uint16Array(N);

/**
 * $Q cloud distance: greedily pair every point in `aBuf[aOff..aOff+2n]` with
 * its nearest unmatched point in `bBuf[bOff..bOff+2n]`, weighted by remaining
 * unmatched count. Squared distances throughout (no sqrt). Early-abandons
 * when `sum >= minSoFar`.
 *
 * Both buffers are interleaved xy. `start` is the starting index in `a`'s
 * pairing rotation (`0..n-1`).
 */
export function cloudDistance(aBuf: Float64Array, aOff: number, bBuf: Float64Array, bOff: number, start: number, minSoFar: number): number {
  const n = N;
  for (let u = 0; u < n; u++) UNMATCHED[u] = u;

  let i = start;
  let weight = n;
  let sum = 0;
  let unmatchedLen = n;

  do {
    const ax = aBuf[aOff + 2 * i];
    const ay = aBuf[aOff + 2 * i + 1];

    let bestU = 0;
    let bestD = Infinity;

    for (let u = 0; u < unmatchedLen; u++) {
      const j = UNMATCHED[u];
      const dx = ax - bBuf[bOff + 2 * j];
      const dy = ay - bBuf[bOff + 2 * j + 1];
      const d = dx * dx + dy * dy;
      if (d < bestD) {
        bestD = d;
        bestU = u;
      }
    }

    // Swap-pop UNMATCHED[bestU]
    UNMATCHED[bestU] = UNMATCHED[unmatchedLen - 1];
    unmatchedLen--;

    sum += weight * bestD;
    if (sum >= minSoFar) return sum;

    weight -= 1;
    i = (i + 1) % n;
  } while (i !== start);

  return sum;
}

/**
 * Greedy match: try multiple starting indices and both directions
 * (a→b, then b→a). Step decays as `floor(n^(1 - epsilon))`.
 */
export function greedyCloudMatch(aBuf: Float64Array, aOff: number, bBuf: Float64Array, bOff: number, epsilon: number): number {
  const n = N;
  const stepRaw = Math.floor(n ** (1 - epsilon));
  const step = stepRaw > 1 ? stepRaw : 1;
  let min = Infinity;

  for (let i = 0; i < n; i += step) {
    const d1 = cloudDistance(aBuf, aOff, bBuf, bOff, i, min);
    if (d1 < min) min = d1;
    const d2 = cloudDistance(bBuf, bOff, aBuf, aOff, i, min);
    if (d2 < min) min = d2;
  }
  return min;
}
