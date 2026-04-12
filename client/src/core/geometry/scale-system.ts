/**
 * Scale System — pure math atoms for transform computation.
 *
 * Every function here is a pure math primitive. No types, no factories, no state.
 * Transform orchestration lives in tools/selection/transform.ts.
 */

import type { BBoxTuple, Point } from '../types/geometry';
import type { HandleId } from '../types/handles';
import { isHorzSide, isVertSide } from '../types/handles';

// Re-export tuple helpers from bounds.ts (canonical location for geometry primitives)
export { frameToBbox, frameToBboxMut, copyBbox, bboxCenter, bboxSize, frameCenter } from './bounds';

// ============================================================================
// Number Primitives
// ============================================================================

/** The one primitive op everything composes from */
export const scaleAround = (v: number, origin: number, factor: number): number => origin + (v - origin) * factor;

export const round3 = (n: number): number => Math.round(n * 1000) / 1000;

/** Round a numeric property by factor. Returns [rounded, effectiveFactor]. */
export function roundProp(prop: number, af: number): [rounded: number, ef: number] {
  const r = round3(prop * af);
  return [r, r / prop];
}

// ============================================================================
// Scale Computation
// ============================================================================

/** Raw factors from cursor position. Uses initialDelta, not bounds width. */
export function rawScaleFactors(wx: number, wy: number, origin: Point, delta: Point, h: HandleId): [sx: number, sy: number] {
  const dx = wx - origin[0];
  const dy = wy - origin[1];
  const MIN = 0.001;
  const safeDx = Math.abs(delta[0]) > MIN ? delta[0] : delta[0] >= 0 ? MIN : -MIN;
  const safeDy = Math.abs(delta[1]) > MIN ? delta[1] : delta[1] >= 0 ? MIN : -MIN;

  if (isHorzSide(h)) return [dx / safeDx, 1];
  if (isVertSide(h)) return [1, dy / safeDy];
  return [dx / safeDx, dy / safeDy];
}

/** Collapse 2 axes to 1 signed magnitude. Handle-aware to avoid corner flicker. */
export function uniformFactor(sx: number, sy: number, h: HandleId): number {
  const ax = Math.abs(sx),
    ay = Math.abs(sy);
  const MIN = 0.001;

  if (sx < 0 && sy < 0) return -Math.max(ax, ay, MIN);

  // Side handles: extract the single active axis (the other is hardcoded 1 by rawScaleFactors)
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

/** Position preservation with flip: relative 0-1 position maintained in scaled box. */
export function preservePosition(cx: number, cy: number, sel: BBoxTuple, origin: Point, factor: number): Point {
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
  return [nMinX + tx * nW, nMinY + ty * nH];
}

/** Scale both edges around origin, normalize for flip, pin based on origin relationship. */
export function edgePinPosition1D(objMin: number, objMax: number, originV: number, scale: number): number {
  const l = scaleAround(objMin, originV, scale);
  const r = scaleAround(objMax, originV, scale);
  const left = Math.min(l, r),
    right = Math.max(l, r);
  const size = objMax - objMin;
  // Objects straddling origin: pin nearer edge (keeps origin-defining objects fixed)
  if (objMin <= originV && originV <= objMax) return Math.abs(left - originV) <= Math.abs(right - originV) ? left : right - size;
  // All others: pin farther edge (tracks the dragged handle)
  return Math.abs(left - originV) >= Math.abs(right - originV) ? left : right - size;
}

// ============================================================================
// Non-Uniform Scale
// ============================================================================

// ============================================================================
// Reflow Atom
// ============================================================================

/** Shared edge-scaling + min-width clamping for text/code reflow. */
export function computeReflowWidth(
  fx: number,
  fw: number,
  originX: number,
  sx: number,
  minW: number,
): [newLeft: number, targetWidth: number] {
  const l = scaleAround(fx, originX, sx);
  const r = scaleAround(fx + fw, originX, sx);
  const left = Math.min(l, r),
    right = Math.max(l, r);
  const raw = right - left;
  const target = Math.max(minW, raw);
  if (target <= raw) return [left, target];
  return [Math.abs(left - originX) <= Math.abs(right - originX) ? left : right - target, target];
}
