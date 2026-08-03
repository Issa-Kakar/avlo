/**
 * Transform damage accumulator — a leaf between the gesture engine and RenderLoop.
 *
 * transform.ts and connector-topology.ts both push per-entry dirty rects here
 * during a gesture frame; the gesture update fns flush ONCE per pointermove via
 * `invalidateWorldRects` (one camera hoist + one gated markDirty for the whole
 * batch). Living in its own module breaks what would otherwise be a
 * topology→transform runtime import back-edge.
 *
 * CONTRACT
 * - Rects are FINAL world rects — already padded for paint (stroke/shadow/
 *   italic overhang). No inflation happens downstream.
 * - `flushDamage()` is called exactly once per pointermove by the gesture
 *   update fns (updateScale / updateTranslate / updateEndpointDrag / cancel's
 *   precise path). Pushers never flush.
 * - The buffer grows pow2 on demand and never shrinks (high-water persistence,
 *   FlatRTree `results` idiom).
 */

import { invalidateWorldRects } from '@/renderer/RenderLoop';

let _dmg = new Float64Array(64 * 4);
let _n = 0;

/** Append one world rect (4 lanes) to the pending batch. */
export function pushDamage(minX: number, minY: number, maxX: number, maxY: number): void {
  if ((_n + 1) * 4 > _dmg.length) {
    let cap = _dmg.length;
    const need = (_n + 1) * 4;
    while (cap < need) cap *= 2;
    const next = new Float64Array(cap);
    next.set(_dmg);
    _dmg = next;
  }
  const o = _n * 4;
  _dmg[o] = minX;
  _dmg[o + 1] = minY;
  _dmg[o + 2] = maxX;
  _dmg[o + 3] = maxY;
  _n++;
}

/** Publish the pending batch to RenderLoop and reset the cursor. */
export function flushDamage(): void {
  invalidateWorldRects(_dmg, _n);
  _n = 0;
}
