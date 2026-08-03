/**
 * Scale System — pure scalar math atoms for transform computation.
 *
 * Every function here is a pure math primitive. No types, no factories, no
 * state. The lane-based apply loops live in
 * `tools/selection/transform-kernels.ts` (which imports these atoms); gesture
 * orchestration in `tools/selection/transform.ts`. The old tuple-allocating
 * bbox composites (scaleBBoxUniform/Edges, edgePinDelta, derivePaddedFrame,
 * computeReflowWidth, roundProp, preservePosition) were folded into the
 * kernels as straight-line lane math — their originals survive verbatim as
 * the oracle inside `transform-kernels.selftest.ts`.
 */

import type { BBoxTuple, Point } from '../types/geometry';
import type { HandleId } from '../types/handles';
import { isHorzSide, isVertSide } from '../types/handles';

// ============================================================================
// Number Primitives
// ============================================================================

/** The one primitive op everything composes from */
export const scaleAround = (v: number, origin: number, factor: number): number => origin + (v - origin) * factor;

export const round3 = (n: number): number => Math.round(n * 1000) / 1000;

// ============================================================================
// Scale Computation
// ============================================================================

/** Raw factors from cursor position into `out`. Uses initialDelta, not bounds width. */
export function rawScaleFactorsInto(out: Point, wx: number, wy: number, origin: Point, delta: Point, h: HandleId): void {
  const dx = wx - origin[0];
  const dy = wy - origin[1];
  const MIN = 0.001;
  const safeDx = Math.abs(delta[0]) > MIN ? delta[0] : delta[0] >= 0 ? MIN : -MIN;
  const safeDy = Math.abs(delta[1]) > MIN ? delta[1] : delta[1] >= 0 ? MIN : -MIN;

  if (isHorzSide(h)) {
    out[0] = dx / safeDx;
    out[1] = 1;
    return;
  }
  if (isVertSide(h)) {
    out[0] = 1;
    out[1] = dy / safeDy;
    return;
  }
  out[0] = dx / safeDx;
  out[1] = dy / safeDy;
}

/** Collapse 2 axes to 1 signed magnitude. Handle-aware to avoid corner flicker. */
export function uniformFactor(sx: number, sy: number, h: HandleId): number {
  const ax = Math.abs(sx),
    ay = Math.abs(sy);
  const MIN = 0.001;

  if (sx < 0 && sy < 0) return -Math.max(ax, ay, MIN);

  // Side handles: extract the single active axis (the other is hardcoded 1 by rawScaleFactorsInto)
  if (isHorzSide(h)) {
    const m = Math.max(ax, MIN);
    return sx < 0 ? -m : m;
  }
  if (isVertSide(h)) {
    const m = Math.max(ay, MIN);
    return sy < 0 ? -m : m;
  }

  // Corner handles: always use both axes — never short-circuit on value equality
  const m = Math.max(ax, ay, MIN);
  const dom = ax >= ay ? sx : sy;
  return dom < 0 ? -m : m;
}

/** Position preservation with flip: write relative 0-1 position into `out`, maintained in scaled box. */
export function preservePositionMut(out: Point, cx: number, cy: number, sel: BBoxTuple, origin: Point, factor: number): void {
  const [ox, oy] = origin;
  const bw = sel[2] - sel[0],
    bh = sel[3] - sel[1];
  const tx = bw > 0 ? (cx - sel[0]) / bw : 0.5;
  const ty = bh > 0 ? (cy - sel[1]) / bh : 0.5;

  const c1x = ox + (sel[0] - ox) * factor;
  const c1y = oy + (sel[1] - oy) * factor;
  const c2x = ox + (sel[2] - ox) * factor;
  const c2y = oy + (sel[3] - oy) * factor;

  const nMinX = Math.min(c1x, c2x),
    nMinY = Math.min(c1y, c2y);
  const nW = Math.abs(c2x - c1x),
    nH = Math.abs(c2y - c1y);
  out[0] = nMinX + tx * nW;
  out[1] = nMinY + ty * nH;
}

/**
 * 1D edge-pin position. Spans-full-axis fast-path (objMin ≤ selLo AND objMax ≥ selHi):
 * translate via scaleAround on the object center, since pinning to an edge it owns would freeze it.
 * Otherwise straddle-aware: origin-touching objects pin the nearer edge, others pin the farther.
 */
export function edgePinPosition1D(objMin: number, objMax: number, originV: number, scale: number, selLo: number, selHi: number): number {
  const size = objMax - objMin;
  // Spans full axis: object IS the bound on both sides → translate via scaleAround on center.
  if (objMin <= selLo && objMax >= selHi) {
    const center = (objMin + objMax) / 2;
    return scaleAround(center, originV, scale) - size / 2;
  }
  const l = scaleAround(objMin, originV, scale);
  const r = scaleAround(objMax, originV, scale);
  const left = Math.min(l, r),
    right = Math.max(l, r);
  // Objects straddling origin: pin nearer edge (keeps origin-defining objects fixed)
  if (objMin <= originV && originV <= objMax) return Math.abs(left - originV) <= Math.abs(right - originV) ? left : right - size;
  // All others: pin farther edge (tracks the dragged handle)
  return Math.abs(left - originV) >= Math.abs(right - originV) ? left : right - size;
}

/** Minimum shape frame width/height during non-uniform scale (world units). Small enough that the cross-origin snap reads as smooth; large enough to keep connectors anchored to a collapsing shape well-defined. */
export const MIN_SHAPE_FRAME_DIM = 5.0;
