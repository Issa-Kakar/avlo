/**
 * Scale System — composable atoms for transform math.
 *
 * Builds from number primitives → tuple helpers → scale computation →
 * structural constraints → generic factories → composed apply constants.
 * Every function works on the widest possible set of inputs via structural typing.
 */

import type * as Y from 'yjs';
import type { BBoxTuple, FrameTuple, Point } from '../types/geometry';
import type { ObjectKind, TextAlign, TextWidth, FontFamily } from '../types/objects';
import type { HandleId } from '../types/handles';
import { isHorzSide, isVertSide } from '../types/handles';
import { getBaselineToTopRatio, anchorFactor } from '../text/text-system';

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
// Tuple Helpers
// ============================================================================

export const frameCenter = (f: FrameTuple): Point => [f[0] + f[2] / 2, f[1] + f[3] / 2];
export const bboxCenter = (b: BBoxTuple): Point => [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
export const bboxSize = (b: BBoxTuple): [number, number] => [b[2] - b[0], b[3] - b[1]];
export const frameToBbox = (f: FrameTuple): BBoxTuple => [f[0], f[1], f[0] + f[2], f[1] + f[3]];

export function frameToBboxMut(f: FrameTuple, out: BBoxTuple): void {
  out[0] = f[0];
  out[1] = f[1];
  out[2] = f[0] + f[2];
  out[3] = f[1] + f[3];
}

export function copyBbox(src: BBoxTuple, dst: BBoxTuple): void {
  dst[0] = src[0];
  dst[1] = src[1];
  dst[2] = src[2];
  dst[3] = src[3];
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
export function edgePinDelta(
  minX: number,
  maxX: number,
  minY: number,
  maxY: number,
  sel: BBoxTuple,
  origin: Point,
  sx: number,
  sy: number,
  handleId: HandleId,
): Point {
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
// Structural Type Constraints (intersection composition)
// ============================================================================

type WithBBox = { bbox: BBoxTuple };
type WithFrame = { frame: FrameTuple };
type WithOriginBBox = WithBBox & { origin: Point };
type WithOriginScaleBBox = WithOriginBBox & { scale: number };
type WithFontFrame = WithFrame & { fontSize: number };
type WithTextProps = WithFontFrame & { width: TextWidth; align: TextAlign; fontFamily: FontFamily };
type WithCodeProps = WithFontFrame & { width: number };
type WithPointsBBox = WithBBox & { points: Point[]; width: number };

// ============================================================================
// Output Types (inheritance hierarchy)
// ============================================================================

export interface BaseOut {
  bbox: BBoxTuple;
}
export interface FrameOut extends BaseOut {
  frame: FrameTuple;
}
export interface OriginOut extends BaseOut {
  origin: Point;
}
export interface OriginScaleOut extends OriginOut {
  scale: number;
}
export interface TextScaleOut extends OriginOut {
  fontSize: number;
  width: number;
}
export interface ReflowOut extends OriginOut {
  width: number;
}
export interface PointsOut extends BaseOut {
  points: Point[];
  width: number;
}

// ============================================================================
// ScaleCtx + Function Type Aliases
// ============================================================================

/** Scale context: allocated once at beginScale, sx/sy mutated per frame */
export interface ScaleCtx {
  sx: number;
  sy: number;
  origin: Point;
  selBounds: BBoxTuple;
  handleId: HandleId;
}

export type ApplyFn<F, O extends BaseOut> = (frozen: F, ctx: ScaleCtx, out: O) => void;
export type CommitFn<O> = (y: Y.Map<unknown>, out: O) => void;

// ============================================================================
// ScaleEntry + makeEntry
// ============================================================================

/** Generic scale entry. The loop erases generics — just calls e.apply(e.frozen, ctx, e.out). */
export interface ScaleEntry<TFrozen = any, TOut extends BaseOut = any> {
  id: string;
  y: Y.Map<unknown>;
  frozen: TFrozen;
  out: TOut;
  apply: ApplyFn<TFrozen, TOut>;
  commit: CommitFn<TOut>;
  prevBbox: BBoxTuple;
}

/** Type-safe constructor: TS infers TFrozen/TOut from arguments */
export function makeEntry<TFrozen, TOut extends BaseOut>(
  id: string,
  y: Y.Map<unknown>,
  frozen: TFrozen,
  out: TOut,
  apply: ApplyFn<TFrozen, TOut>,
  commit: CommitFn<TOut>,
  bbox: BBoxTuple,
): ScaleEntry<TFrozen, TOut> {
  return { id, y, frozen, out, apply, commit, prevBbox: [...bbox] as BBoxTuple };
}

// ============================================================================
// Output Factories (pre-allocation — zero per-frame allocation)
// ============================================================================

export const createFrameOut = (): FrameOut => ({ frame: [0, 0, 0, 0] as FrameTuple, bbox: [0, 0, 0, 0] as BBoxTuple });
export const createOriginScaleOut = (): OriginScaleOut => ({ origin: [0, 0] as Point, scale: 1, bbox: [0, 0, 0, 0] as BBoxTuple });
export const createOriginOut = (): OriginOut => ({ origin: [0, 0] as Point, bbox: [0, 0, 0, 0] as BBoxTuple });
export const createTextScaleOut = (): TextScaleOut => ({ origin: [0, 0] as Point, fontSize: 0, width: 0, bbox: [0, 0, 0, 0] as BBoxTuple });
export const createPointsOut = (n: number): PointsOut => ({
  points: Array.from({ length: n }, () => [0, 0] as Point),
  width: 0,
  bbox: [0, 0, 0, 0] as BBoxTuple,
});
export const createReflowOut = (): ReflowOut => ({ origin: [0, 0] as Point, width: 0, bbox: [0, 0, 0, 0] as BBoxTuple });

// ============================================================================
// Derivation Atoms (frozen, newCenterX, newCenterY, absFactor, out)
// ============================================================================

function deriveFrame(f: WithFrame, ncx: number, ncy: number, af: number, out: FrameOut): void {
  const nw = f.frame[2] * af,
    nh = f.frame[3] * af;
  out.frame[0] = ncx - nw / 2;
  out.frame[1] = ncy - nh / 2;
  out.frame[2] = nw;
  out.frame[3] = nh;
  frameToBboxMut(out.frame, out.bbox);
}

function offsetFrame(f: WithFrame, dx: number, dy: number, out: FrameOut): void {
  out.frame[0] = f.frame[0] + dx;
  out.frame[1] = f.frame[1] + dy;
  out.frame[2] = f.frame[2];
  out.frame[3] = f.frame[3];
  frameToBboxMut(out.frame, out.bbox);
}

function deriveOriginScale(f: WithOriginScaleBBox, ncx: number, ncy: number, af: number, out: OriginScaleOut): void {
  const [rounded, ef] = roundProp(f.scale, af);
  out.scale = rounded;
  const bw = f.bbox[2] - f.bbox[0],
    bh = f.bbox[3] - f.bbox[1];
  const nbw = bw * ef,
    nbh = bh * ef;
  const nbx = ncx - nbw / 2,
    nby = ncy - nbh / 2;
  out.origin[0] = nbx + (f.origin[0] - f.bbox[0]) * ef;
  out.origin[1] = nby + (f.origin[1] - f.bbox[1]) * ef;
  out.bbox[0] = nbx;
  out.bbox[1] = nby;
  out.bbox[2] = nbx + nbw;
  out.bbox[3] = nby + nbh;
}

function offsetOrigin(f: WithOriginBBox, dx: number, dy: number, out: OriginOut): void {
  out.origin[0] = f.origin[0] + dx;
  out.origin[1] = f.origin[1] + dy;
  out.bbox[0] = f.bbox[0] + dx;
  out.bbox[1] = f.bbox[1] + dy;
  out.bbox[2] = f.bbox[2] + dx;
  out.bbox[3] = f.bbox[3] + dy;
}

function deriveText(f: WithTextProps, ncx: number, ncy: number, af: number, out: TextScaleOut): void {
  const [rounded, ef] = roundProp(f.fontSize, af);
  out.fontSize = rounded;
  const nw = f.frame[2] * ef,
    nh = f.frame[3] * ef;
  const nfx = ncx - nw / 2,
    nfy = ncy - nh / 2;
  out.origin[0] = nfx + anchorFactor(f.align) * nw;
  out.origin[1] = nfy + rounded * getBaselineToTopRatio(f.fontFamily);
  out.width = typeof f.width === 'number' ? f.width * ef : NaN;
  out.bbox[0] = nfx;
  out.bbox[1] = nfy;
  out.bbox[2] = nfx + nw;
  out.bbox[3] = nfy + nh;
}

function deriveCode(f: WithCodeProps, ncx: number, ncy: number, af: number, out: TextScaleOut): void {
  const [rounded, ef] = roundProp(f.fontSize, af);
  out.fontSize = rounded;
  const nw = f.frame[2] * ef,
    nh = f.frame[3] * ef;
  out.origin[0] = ncx - nw / 2;
  out.origin[1] = ncy - nh / 2;
  out.width = f.width * ef;
  out.bbox[0] = out.origin[0];
  out.bbox[1] = out.origin[1];
  out.bbox[2] = out.origin[0] + nw;
  out.bbox[3] = out.origin[1] + nh;
}

function derivePoints(f: WithPointsBBox, ncx: number, ncy: number, af: number, out: PointsOut): void {
  const cx = (f.bbox[0] + f.bbox[2]) / 2,
    cy = (f.bbox[1] + f.bbox[3]) / 2;
  for (let i = 0; i < f.points.length; i++) {
    out.points[i][0] = ncx + (f.points[i][0] - cx) * af;
    out.points[i][1] = ncy + (f.points[i][1] - cy) * af;
  }
  out.width = f.width * af;
  const hw = ((f.bbox[2] - f.bbox[0]) * af) / 2,
    hh = ((f.bbox[3] - f.bbox[1]) * af) / 2;
  out.bbox[0] = ncx - hw;
  out.bbox[1] = ncy - hh;
  out.bbox[2] = ncx + hw;
  out.bbox[3] = ncy + hh;
}

function offsetPoints(f: WithPointsBBox, dx: number, dy: number, out: PointsOut): void {
  for (let i = 0; i < f.points.length; i++) {
    out.points[i][0] = f.points[i][0] + dx;
    out.points[i][1] = f.points[i][1] + dy;
  }
  out.width = f.width;
  out.bbox[0] = f.bbox[0] + dx;
  out.bbox[1] = f.bbox[1] + dy;
  out.bbox[2] = f.bbox[2] + dx;
  out.bbox[3] = f.bbox[3] + dy;
}

// ============================================================================
// Shared Extractors (contravariant — base type works for all subtypes)
// ============================================================================

const _fCx = (f: WithFrame) => f.frame[0] + f.frame[2] / 2;
const _fCy = (f: WithFrame) => f.frame[1] + f.frame[3] / 2;
const _bCx = (f: WithBBox) => (f.bbox[0] + f.bbox[2]) / 2;
const _bCy = (f: WithBBox) => (f.bbox[1] + f.bbox[3]) / 2;

const _fMinX = (f: WithFrame) => f.frame[0];
const _fMaxX = (f: WithFrame) => f.frame[0] + f.frame[2];
const _fMinY = (f: WithFrame) => f.frame[1];
const _fMaxY = (f: WithFrame) => f.frame[1] + f.frame[3];
const _bMinX = (f: WithBBox) => f.bbox[0];
const _bMaxX = (f: WithBBox) => f.bbox[2];
const _bMinY = (f: WithBBox) => f.bbox[1];
const _bMaxY = (f: WithBBox) => f.bbox[3];

// ============================================================================
// Generic Behavior Factories
// ============================================================================

/** Build a uniform-scale apply function. Only needs center extractors — derivation computes its own size. */
export function makeUniformApply<F, O extends BaseOut>(
  getCx: (f: F) => number,
  getCy: (f: F) => number,
  derive: (f: F, ncx: number, ncy: number, af: number, out: O) => void,
): ApplyFn<F, O> {
  return (frozen, ctx, out) => {
    const uf = uniformFactor(ctx.sx, ctx.sy);
    const af = Math.abs(uf);
    const [ncx, ncy] = preservePosition(getCx(frozen), getCy(frozen), ctx.selBounds, ctx.origin, uf);
    derive(frozen, ncx, ncy, af, out);
  };
}

/** Build an edge-pin apply function from bounds extractors + offset writer. */
export function makeEdgePinApply<F, O extends BaseOut>(
  getMinX: (f: F) => number,
  getMaxX: (f: F) => number,
  getMinY: (f: F) => number,
  getMaxY: (f: F) => number,
  writeOffset: (f: F, dx: number, dy: number, out: O) => void,
): ApplyFn<F, O> {
  return (frozen, ctx, out) => {
    const [dx, dy] = edgePinDelta(
      getMinX(frozen),
      getMaxX(frozen),
      getMinY(frozen),
      getMaxY(frozen),
      ctx.selBounds,
      ctx.origin,
      ctx.sx,
      ctx.sy,
      ctx.handleId,
    );
    writeOffset(frozen, dx, dy, out);
  };
}

// ============================================================================
// Composed Apply Constants
// ============================================================================

export const applyUniformFrame = makeUniformApply<WithFrame, FrameOut>(_fCx, _fCy, deriveFrame);
export const applyUniformOriginScale = makeUniformApply<WithOriginScaleBBox, OriginScaleOut>(_bCx, _bCy, deriveOriginScale);
export const applyUniformText = makeUniformApply<WithTextProps, TextScaleOut>(_fCx, _fCy, deriveText);
export const applyUniformCode = makeUniformApply<WithCodeProps, TextScaleOut>(_fCx, _fCy, deriveCode);
export const applyUniformPoints = makeUniformApply<WithPointsBBox, PointsOut>(_bCx, _bCy, derivePoints);

export const applyEdgePinFrame = makeEdgePinApply<WithFrame, FrameOut>(_fMinX, _fMaxX, _fMinY, _fMaxY, offsetFrame);
export const applyEdgePinOrigin = makeEdgePinApply<WithOriginBBox, OriginOut>(_bMinX, _bMaxX, _bMinY, _bMaxY, offsetOrigin);
export const applyEdgePinPoints = makeEdgePinApply<WithPointsBBox, PointsOut>(_bMinX, _bMaxX, _bMinY, _bMaxY, offsetPoints);

// ============================================================================
// Non-Uniform Scale
// ============================================================================

/** Non-uniform frame scale: each corner scaled independently. Shapes only. */
export function applyNonUniformFrame(f: WithFrame, ctx: ScaleCtx, out: FrameOut): void {
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
// Commit Functions
// ============================================================================

export const commitFrame: CommitFn<FrameOut> = (y, o) => {
  y.set('frame', [...o.frame]);
};
export const commitOriginScale: CommitFn<OriginScaleOut> = (y, o) => {
  y.set('origin', [...o.origin]);
  y.set('scale', o.scale);
};
export const commitOrigin: CommitFn<OriginOut> = (y, o) => {
  y.set('origin', [...o.origin]);
};
export const commitTextScale: CommitFn<TextScaleOut> = (y, o) => {
  y.set('origin', [...o.origin]);
  y.set('fontSize', o.fontSize);
  if (!isNaN(o.width)) y.set('width', o.width);
};
export const commitCodeScale: CommitFn<TextScaleOut> = (y, o) => {
  y.set('origin', [...o.origin]);
  y.set('fontSize', o.fontSize);
  y.set('width', o.width);
};
export const commitReflow: CommitFn<ReflowOut> = (y, o) => {
  y.set('origin', [...o.origin]);
  y.set('width', o.width);
};
export const commitPointsWidth: CommitFn<PointsOut> = (y, o) => {
  y.set(
    'points',
    o.points.map((p) => [...p]),
  );
  y.set('width', o.width);
};
export const commitPoints: CommitFn<PointsOut> = (y, o) => {
  y.set(
    'points',
    o.points.map((p) => [...p]),
  );
};

// ============================================================================
// KindCounts
// ============================================================================

export type KindCounts = Record<ObjectKind, number>;

export const countKinds = (c: KindCounts): number => {
  let n = 0;
  for (const k in c) if (c[k as ObjectKind] > 0) n++;
  return n;
};
export const only = (c: KindCounts, k: ObjectKind): boolean => c[k] > 0 && countKinds(c) === 1;
export const has = (c: KindCounts, k: ObjectKind): boolean => c[k] > 0;
export const isMixed = (c: KindCounts): boolean => countKinds(c) > 1;
