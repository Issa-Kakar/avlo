/**
 * Scale System — pure math atoms for transform computation.
 *
 * Every function here is a pure math primitive. No types, no factories, no state.
 * Transform orchestration lives in tools/selection/transform.ts.
 */

import type { BBoxTuple, FrameTuple, Point } from '../types/geometry';
import type { HandleId } from '../types/handles';
import { isHorzSide, isVertSide } from '../types/handles';

// Re-export tuple helpers from bounds.ts (canonical location for geometry primitives)
export { frameToBbox, frameToBboxMut, copyBbox, bboxCenter, bboxSize, frameCenter } from './bounds';
import { frameToBboxMut } from './bounds';

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

/** Collapse 2 axes to 1 signed magnitude */
export function uniformFactor(sx: number, sy: number): number {
  const ax = Math.abs(sx),
    ay = Math.abs(sy);
  const MIN = 0.001;

  if (sx < 0 && sy < 0) return -Math.max(ax, ay, MIN);

  if (sy === 1 && sx !== 1) {
    const m = Math.max(ax, MIN);
    return sx < 0 ? -m : m;
  }
  if (sx === 1 && sy !== 1) {
    const m = Math.max(ay, MIN);
    return sy < 0 ? -m : m;
  }

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

// ============================================================================
// Edge-Pin Atoms
// ============================================================================

/** 1D edge-pin: compute delta to pin object to anchor edge on one axis. */
export function edgePinDelta1D(
  objMin: number,
  objMax: number,
  anchorV: number,
  originV: number,
  scale: number,
  handleSign: number,
): number {
  const EPS = 1e-3;
  const touchesMin = Math.abs(objMin - anchorV) < EPS;
  const touchesMax = Math.abs(objMax - anchorV) < EPS;
  if (touchesMin || touchesMax) {
    const edge = scale >= 0 ? (touchesMin ? objMin : objMax) : touchesMin ? objMax : objMin;
    return anchorV - edge;
  }
  const cv = (objMin + objMax) / 2;
  let dv = scaleAround(cv, originV, scale) - cv;
  if (scale < 0) {
    const half = (objMax - objMin) / 2;
    dv += handleSign * half;
  }
  return dv;
}

/** 2D edge-pin: compose 1D per axis based on handle. */
export function edgePinDelta(bbox: BBoxTuple, sel: BBoxTuple, origin: Point, sx: number, sy: number, handleId: HandleId): Point {
  const [minX, minY, maxX, maxY] = bbox;
  if (isHorzSide(handleId)) {
    const anchor = handleId === 'e' ? sel[0] : sel[2];
    const sign = handleId === 'e' ? 1 : -1;
    return [edgePinDelta1D(minX, maxX, anchor, origin[0], sx, sign), 0];
  }
  if (isVertSide(handleId)) {
    const anchor = handleId === 's' ? sel[1] : sel[3];
    const sign = handleId === 's' ? 1 : -1;
    return [0, edgePinDelta1D(minY, maxY, anchor, origin[1], sy, sign)];
  }
  return [0, 0];
}

// ============================================================================
// Non-Uniform Scale
// ============================================================================

/** Non-uniform frame scale: each corner scaled independently. Shapes only. */
export function applyNonUniformFrame(
  f: { frame: FrameTuple },
  ctx: { sx: number; sy: number; origin: Point },
  out: { frame: FrameTuple; bbox: BBoxTuple },
): void {
  const [x, y, w, h] = f.frame;
  const x1 = scaleAround(x, ctx.origin[0], ctx.sx);
  const y1 = scaleAround(y, ctx.origin[1], ctx.sy);
  const x2 = scaleAround(x + w, ctx.origin[0], ctx.sx);
  const y2 = scaleAround(y + h, ctx.origin[1], ctx.sy);
  out.frame[0] = Math.min(x1, x2);
  out.frame[1] = Math.min(y1, y2);
  out.frame[2] = Math.abs(x2 - x1);
  out.frame[3] = Math.abs(y2 - y1);
  frameToBboxMut(out.frame, out.bbox);
}

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
