// biome-ignore-all lint/suspicious/noConsole: standalone test runner — console IS the output surface
/**
 * Transform-kernels self-test runner.
 *
 * Not part of the app bundle — executed standalone via esbuild+node:
 *   pnpm exec esbuild web/src/tools/selection/transform-kernels.selftest.ts \
 *     --bundle --platform=node --format=esm --tsconfig=web/tsconfig.json \
 *     --outfile=<scratch>/kernels-selftest.mjs
 *   node <scratch>/kernels-selftest.mjs
 *
 * Method: the ORACLE side is a VERBATIM freeze of the pre-SoA implementation
 * (old transform.ts apply/commit fns + scale-system atoms + bounds helpers +
 * handles guards, copied here so later pruning of those modules can't hollow
 * the test). The NEW side runs the real kernels over lane buffers. Every case
 * asserts EXACT float equality (NaN-aware for the text width lane) — the
 * kernels preserve operation order, so results must be bit-identical, not
 * epsilon-close.
 *
 * Coverage:
 *   1. K_* codes ≡ OBJECT_KINDS order (drift guard for the literal consts).
 *   2. BEHAVIOR_LUT ≡ verbatim resolveBehavior over all 42 reachable cells
 *      (7 ScalableKinds × 3 cats × 2 comps; connector cells unreachable by
 *      construction). OP_LUT ≡ verbatim APPLY_SCALE cell map, 0xFF elsewhere.
 *   3. Fuzz ≥5k cases/op — OFFSET, EDGE_PIN, FRAME_UNIFORM, FRAME_EDGES,
 *      STROKE_UNIFORM, ORIGIN_UNIFORM (text incl. 'auto'→NaN width + note
 *      scale flavor) — random geometry/ctx, all 8 handleIds, sx/sy flips,
 *      zeros, tiny scales crossing the min clamps, edgePin span-full /
 *      straddle-origin / outside cases, degenerate selection bounds. Cases
 *      run in 3-entry lane batches so range indexing is exercised.
 *   4. reflowLeftWidth ≡ computeReflowWidth (incl. clamp branch + ties).
 *   5. Commit-value builders (lane mirrors of transform.ts §commit) vs the
 *      old commit fns: stroke uniform point mapping + width, stroke offset
 *      point mapping, frame commit, text uniform commit (NaN width skip).
 *   6. fillFrameFromBind lane-read mirrors vs the old entry-based oracle
 *      (3 branches: frame kinds / tight-bbox kinds / scale-ratio kinds).
 *
 * Reflow ops (OP_REFLOW_*) are excluded — they run through the layout engines
 * (canvas-adjacent); their edge math IS reflowLeftWidth (suite 4) and the
 * exact-port spec lives in transform.ts.
 */

import { isCorner, isHorzSide } from '@/core/types/handles';
import { K_BOOKMARK, K_CODE, K_CONNECTOR, K_IMAGE, K_NOTE, K_SHAPE, K_STROKE, K_TEXT, KIND_CODE, OBJECT_KINDS } from '@/core/types/objects';
import {
  applyEdgePinRange,
  applyFrameEdgesRange,
  applyFrameUniformRange,
  applyOffsetRange,
  applyOriginUniformRange,
  applyStrokeUniformRange,
  BEH_EDGE_PIN,
  BEH_NON_UNIFORM,
  BEH_REFLOW,
  BEH_UNIFORM,
  BEHAVIOR_LUT,
  CAT_CORNER,
  CAT_HSIDE,
  CAT_VSIDE,
  fillUniformPack,
  G_STRIDE,
  OP_FRAME_EDGES,
  OP_FRAME_UNIFORM,
  OP_LUT,
  OP_OFFSET,
  OP_ORIGIN_UNIFORM,
  OP_REFLOW_CODE,
  OP_REFLOW_TEXT,
  OP_STROKE_UNIFORM,
  reflowLeftWidth,
  reflowOut,
} from './transform-kernels';

// ───────────────────────────────────────────────────────────── harness ──

type BBoxTuple = [number, number, number, number];
type FrameTuple = [number, number, number, number];
type Point = [number, number];
type HandleId = 'nw' | 'ne' | 'se' | 'sw' | 'n' | 's' | 'e' | 'w';
interface ScaleCtx {
  sx: number;
  sy: number;
  origin: Point;
  selBounds: BBoxTuple;
  handleId: HandleId;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let failures = 0;
let checks = 0;
function check(cond: boolean, msg: string): void {
  checks++;
  if (!cond) {
    failures++;
    if (failures <= 40) console.error(`  ✗ ${msg}`);
  }
}

/** Exact equality, NaN-aware (NaN ≡ NaN — the text 'auto' width lane). */
const feq = (a: number, b: number): boolean => a === b || (Number.isNaN(a) && Number.isNaN(b));

function lanesEq(lanes: Float64Array, gi: number, off: number, expected: ArrayLike<number>, n: number): boolean {
  const b = gi * G_STRIDE + off;
  for (let i = 0; i < n; i++) if (!feq(lanes[b + i], expected[i])) return false;
  return true;
}

// ═══════════════════════════════════════════════════ ORACLE (verbatim) ══
// Copied from the pre-SoA sources; do NOT re-derive or simplify.

// -- handles.ts guards + tables --
const isCorner_O = (h: HandleId): boolean => h === 'nw' || h === 'ne' || h === 'se' || h === 'sw';
const isHorzSide_O = (h: HandleId): boolean => h === 'e' || h === 'w';
const isVertSide_O = (h: HandleId): boolean => h === 'n' || h === 's';
const OPPOSITE_O: Record<HandleId, HandleId> = { nw: 'se', ne: 'sw', se: 'nw', sw: 'ne', n: 's', s: 'n', e: 'w', w: 'e' };
const HANDLE_TX_O: Record<HandleId, 0 | 0.5 | 1> = { nw: 0, w: 0, sw: 0, n: 0.5, s: 0.5, ne: 1, e: 1, se: 1 };
const HANDLE_TY_O: Record<HandleId, 0 | 0.5 | 1> = { nw: 0, n: 0, ne: 0, w: 0.5, e: 0.5, sw: 1, s: 1, se: 1 };
function handlePosition_O(h: HandleId, bounds: BBoxTuple): Point {
  return [bounds[0] + (bounds[2] - bounds[0]) * HANDLE_TX_O[h], bounds[1] + (bounds[3] - bounds[1]) * HANDLE_TY_O[h]];
}
const scaleOrigin_O = (h: HandleId, bounds: BBoxTuple): Point => handlePosition_O(OPPOSITE_O[h], bounds);

// -- bounds.ts helpers --
const bboxCenter_O = (b: Readonly<BBoxTuple>): Point => [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
function setBBoxXYWH_O(out: BBoxTuple, x: number, y: number, w: number, h: number): void {
  out[0] = x;
  out[1] = y;
  out[2] = x + w;
  out[3] = y + h;
}
function offsetPoint_O(dst: Point, src: Point, dx: number, dy: number): void {
  dst[0] = src[0] + dx;
  dst[1] = src[1] + dy;
}
function offsetBBox_O(dst: BBoxTuple, src: BBoxTuple, dx: number, dy: number): void {
  dst[0] = src[0] + dx;
  dst[1] = src[1] + dy;
  dst[2] = src[2] + dx;
  dst[3] = src[3] + dy;
}
function offsetFrame_O(dst: FrameTuple, src: FrameTuple, dx: number, dy: number): void {
  dst[0] = src[0] + dx;
  dst[1] = src[1] + dy;
  dst[2] = src[2];
  dst[3] = src[3];
}

// -- scale-system.ts atoms --
const scaleAround_O = (v: number, origin: number, factor: number): number => origin + (v - origin) * factor;
const round3_O = (n: number): number => Math.round(n * 1000) / 1000;
function roundProp_O(prop: number, af: number): [number, number] {
  const r = round3_O(prop * af);
  return [r, r / prop];
}
function uniformFactor_O(sx: number, sy: number, h: HandleId): number {
  const ax = Math.abs(sx),
    ay = Math.abs(sy);
  const MIN = 0.001;
  if (sx < 0 && sy < 0) return -Math.max(ax, ay, MIN);
  if (isHorzSide_O(h)) {
    const m = Math.max(ax, MIN);
    return sx < 0 ? -m : m;
  }
  if (isVertSide_O(h)) {
    const m = Math.max(ay, MIN);
    return sy < 0 ? -m : m;
  }
  const m = Math.max(ax, ay, MIN);
  const dom = ax >= ay ? sx : sy;
  return dom < 0 ? -m : m;
}
function preservePositionMut_O(out: Point, cx: number, cy: number, sel: BBoxTuple, origin: Point, factor: number): void {
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
function preservePosition_O(cx: number, cy: number, sel: BBoxTuple, origin: Point, factor: number): Point {
  const out: Point = [0, 0];
  preservePositionMut_O(out, cx, cy, sel, origin, factor);
  return out;
}
function edgePinPosition1D_O(objMin: number, objMax: number, originV: number, scale: number, selLo: number, selHi: number): number {
  const size = objMax - objMin;
  if (objMin <= selLo && objMax >= selHi) {
    const center = (objMin + objMax) / 2;
    return scaleAround_O(center, originV, scale) - size / 2;
  }
  const l = scaleAround_O(objMin, originV, scale);
  const r = scaleAround_O(objMax, originV, scale);
  const left = Math.min(l, r),
    right = Math.max(l, r);
  if (objMin <= originV && originV <= objMax) return Math.abs(left - originV) <= Math.abs(right - originV) ? left : right - size;
  return Math.abs(left - originV) >= Math.abs(right - originV) ? left : right - size;
}
function computeReflowWidth_O(fx: number, fw: number, originX: number, sx: number, minW: number): [number, number] {
  const l = scaleAround_O(fx, originX, sx);
  const r = scaleAround_O(fx + fw, originX, sx);
  const left = Math.min(l, r),
    right = Math.max(l, r);
  const raw = right - left;
  const target = Math.max(minW, raw);
  if (target <= raw) return [left, target];
  return [Math.abs(left - originX) <= Math.abs(right - originX) ? left : right - target, target];
}
function scaleBBoxUniform_O(out: BBoxTuple, src: BBoxTuple, ctx: ScaleCtx): number {
  const [cx, cy] = bboxCenter_O(src);
  const uf = uniformFactor_O(ctx.sx, ctx.sy, ctx.handleId);
  const [ncx, ncy] = preservePosition_O(cx, cy, ctx.selBounds, ctx.origin, uf);
  const af = Math.abs(uf);
  const w = (src[2] - src[0]) * af;
  const h = (src[3] - src[1]) * af;
  setBBoxXYWH_O(out, ncx - w / 2, ncy - h / 2, w, h);
  return af;
}
const MIN_SHAPE_FRAME_DIM_O = 5.0;
function scaleBBoxEdges_O(out: BBoxTuple, src: BBoxTuple, ctx: ScaleCtx, minW: number, minH: number): void {
  const [newX, newW] = computeReflowWidth_O(src[0], src[2] - src[0], ctx.origin[0], ctx.sx, minW);
  const [newY, newH] = computeReflowWidth_O(src[1], src[3] - src[1], ctx.origin[1], ctx.sy, minH);
  setBBoxXYWH_O(out, newX, newY, newW, newH);
}
function edgePinDelta_O(src: BBoxTuple, ctx: ScaleCtx): Point {
  const sel = ctx.selBounds;
  return [
    edgePinPosition1D_O(src[0], src[2], ctx.origin[0], ctx.sx, sel[0], sel[2]) - src[0],
    edgePinPosition1D_O(src[1], src[3], ctx.origin[1], ctx.sy, sel[1], sel[3]) - src[1],
  ];
}
function derivePaddedFrame_O(outFrame: FrameTuple, outBbox: BBoxTuple, srcFrame: FrameTuple, srcBbox: BBoxTuple): void {
  const padL = srcFrame[0] - srcBbox[0];
  const padT = srcFrame[1] - srcBbox[1];
  outFrame[0] = outBbox[0] + padL;
  outFrame[1] = outBbox[1] + padT;
  outFrame[2] = Math.max(0, outBbox[2] - outBbox[0] - 2 * padL);
  outFrame[3] = Math.max(0, outBbox[3] - outBbox[1] - 2 * padT);
  outBbox[0] = outFrame[0] - padL;
  outBbox[1] = outFrame[1] - padT;
  outBbox[2] = outFrame[0] + outFrame[2] + padL;
  outBbox[3] = outFrame[1] + outFrame[3] + padT;
}

// -- transform.ts apply fns --
interface FrameGeo {
  frame: FrameTuple;
  bbox: BBoxTuple;
}
function scaleFrameUniform_O(f: FrameGeo, ctx: ScaleCtx, o: FrameGeo): void {
  scaleBBoxUniform_O(o.bbox, f.bbox, ctx);
  derivePaddedFrame_O(o.frame, o.bbox, f.frame, f.bbox);
}
function scaleFrameNonUniform_O(f: FrameGeo, ctx: ScaleCtx, o: FrameGeo): void {
  const padX = f.frame[0] - f.bbox[0];
  const padY = f.frame[1] - f.bbox[1];
  scaleBBoxEdges_O(o.bbox, f.bbox, ctx, MIN_SHAPE_FRAME_DIM_O + 2 * padX, MIN_SHAPE_FRAME_DIM_O + 2 * padY);
  derivePaddedFrame_O(o.frame, o.bbox, f.frame, f.bbox);
}
interface StrokeGeo {
  points: Point[];
  width?: number;
  bbox: BBoxTuple;
}
interface StrokeOut {
  bbox: BBoxTuple;
  factor: number;
  fcx: number;
  fcy: number;
}
function scaleStrokeBBox_O(f: StrokeGeo, ctx: ScaleCtx, o: StrokeOut): void {
  const [fcx, fcy] = bboxCenter_O(f.bbox);
  o.fcx = fcx;
  o.fcy = fcy;
  o.factor = scaleBBoxUniform_O(o.bbox, f.bbox, ctx);
}
interface OriginGeo {
  origin: Point;
  bbox: BBoxTuple;
  fontSize?: number;
  width?: number | 'auto';
  scale?: number;
}
interface OriginOut {
  origin: Point;
  bbox: BBoxTuple;
  fontSize?: number;
  width?: number;
  scale?: number;
}
function scaleBBoxOriginProp_O(f: OriginGeo, ctx: ScaleCtx, o: OriginOut, propVal: number): [number, number] {
  const af = scaleBBoxUniform_O(o.bbox, f.bbox, ctx);
  const [rounded, ef] = roundProp_O(propVal, af);
  o.origin[0] = o.bbox[0] + (f.origin[0] - f.bbox[0]) * ef;
  o.origin[1] = o.bbox[1] + (f.origin[1] - f.bbox[1]) * ef;
  return [rounded, ef];
}
function scaleOriginFontSize_O(f: OriginGeo, ctx: ScaleCtx, o: OriginOut): void {
  const [rounded, ef] = scaleBBoxOriginProp_O(f, ctx, o, f.fontSize!);
  o.fontSize = rounded;
  o.width = typeof f.width === 'number' ? f.width * ef : NaN;
}
function scaleOriginScale_O(f: OriginGeo, ctx: ScaleCtx, o: OriginOut): void {
  const [rounded] = scaleBBoxOriginProp_O(f, ctx, o, f.scale!);
  o.scale = rounded;
}
// biome-ignore lint/suspicious/noExplicitAny: verbatim oracle copy
function applyOffset_O(f: any, dx: number, dy: number, o: any): void {
  if ('frame' in o) offsetFrame_O(o.frame, f.frame, dx, dy);
  if ('origin' in o) offsetPoint_O(o.origin, f.origin, dx, dy);
  if ('scale' in o && 'scale' in f) o.scale = f.scale;
  if ('fontSize' in o && 'fontSize' in f) o.fontSize = f.fontSize;
  offsetBBox_O(o.bbox, f.bbox, dx, dy);
}
// biome-ignore lint/suspicious/noExplicitAny: verbatim oracle copy
function edgePinOffset_O(f: any, ctx: ScaleCtx, o: any): void {
  const [dx, dy] = edgePinDelta_O(f.bbox, ctx);
  applyOffset_O(f, dx, dy, o);
}

// -- transform.ts commit fns (Y.Map write payloads captured as values) --
function commitStrokeUniform_O(o: StrokeOut, f: StrokeGeo): { points: Point[]; width: number } {
  const [ncx, ncy] = bboxCenter_O(o.bbox);
  const af = o.factor;
  return {
    points: f.points.map(([px, py]) => [ncx + (px - o.fcx) * af, ncy + (py - o.fcy) * af]),
    width: f.width! * af,
  };
}
function commitStrokeOffset_O(o: StrokeOut, f: StrokeGeo): { points: Point[] } {
  const dx = o.bbox[0] - f.bbox[0];
  const dy = o.bbox[1] - f.bbox[1];
  return { points: f.points.map(([px, py]) => [px + dx, py + dy]) };
}

// -- transform.ts behavior resolution --
type ScalableKind = 'stroke' | 'shape' | 'text' | 'code' | 'image' | 'note' | 'bookmark';
type ScaleBehavior = 'uniform' | 'nonUniform' | 'edgePin' | 'reflow';
type HandleCat = 'corner' | 'hSide' | 'vSide';
type Comp = 'single' | 'multi';
type BKey = `${ScalableKind}_${HandleCat}_${Comp}`;
const DEFAULT_BEHAVIOR_O: Record<HandleCat, Record<Comp, ScaleBehavior>> = {
  corner: { single: 'uniform', multi: 'uniform' },
  hSide: { single: 'uniform', multi: 'edgePin' },
  vSide: { single: 'uniform', multi: 'edgePin' },
};
const BEHAVIOR_OVERRIDES_O: Partial<Record<BKey, ScaleBehavior>> = {
  shape_corner_single: 'nonUniform',
  shape_hSide_single: 'nonUniform',
  shape_hSide_multi: 'nonUniform',
  shape_vSide_single: 'nonUniform',
  shape_vSide_multi: 'nonUniform',
  text_hSide_single: 'reflow',
  text_hSide_multi: 'reflow',
  code_hSide_single: 'reflow',
  code_hSide_multi: 'reflow',
};
function resolveBehavior_O(kind: ScalableKind, handleId: HandleId, single: boolean): ScaleBehavior {
  const cat: HandleCat = isCorner_O(handleId) ? 'corner' : isHorzSide_O(handleId) ? 'hSide' : 'vSide';
  const comp: Comp = single ? 'single' : 'multi';
  return BEHAVIOR_OVERRIDES_O[`${kind}_${cat}_${comp}`] ?? DEFAULT_BEHAVIOR_O[cat][comp];
}

// -- connector-topology.ts fillFrameFromBind (entry-based oracle) --
function fillFrameFromBind_O(
  scratch: FrameTuple,
  bindKind: string,
  out: { frame?: FrameTuple; bbox: BBoxTuple; scale?: number; origin?: Point },
  frozen: { scale?: number },
  frozenFrame: FrameTuple | null,
): void {
  switch (bindKind) {
    case 'shape':
    case 'image': {
      const f = out.frame!;
      scratch[0] = f[0];
      scratch[1] = f[1];
      scratch[2] = f[2];
      scratch[3] = f[3];
      return;
    }
    case 'text':
    case 'code': {
      const b = out.bbox;
      scratch[0] = b[0];
      scratch[1] = b[1];
      scratch[2] = b[2] - b[0];
      scratch[3] = b[3] - b[1];
      return;
    }
    default: {
      const ratio = out.scale! / frozen.scale!;
      const fz = frozenFrame!;
      scratch[0] = out.origin![0];
      scratch[1] = out.origin![1];
      scratch[2] = fz[2] * ratio;
      scratch[3] = fz[3] * ratio;
      return;
    }
  }
}

// ═════════════════════════════════════════ NEW-SIDE MIRRORS (spec pins) ══
// Lane-reading builders exactly as transform.ts / connector-topology.ts
// implement them post-swap — pinned here so the formulas can't drift.

function commitStrokeUniformLanes(
  lanes: Float64Array,
  gi: number,
  pool: Float64Array,
  off: number,
  n: number,
): { points: Point[]; width: number } {
  const b = gi * G_STRIDE;
  const ncx = (lanes[b + 8] + lanes[b + 10]) / 2;
  const ncy = (lanes[b + 9] + lanes[b + 11]) / 2;
  const fcx = lanes[b + 12];
  const fcy = lanes[b + 13];
  const af = lanes[b + 14];
  const points: Point[] = new Array(n);
  for (let i = 0; i < n; i++) points[i] = [ncx + (pool[off + i * 2] - fcx) * af, ncy + (pool[off + i * 2 + 1] - fcy) * af];
  return { points, width: lanes[b + 6] * af };
}
function commitStrokeOffsetLanes(lanes: Float64Array, gi: number, pool: Float64Array, off: number, n: number): { points: Point[] } {
  const b = gi * G_STRIDE;
  const dx = lanes[b + 8] - lanes[b];
  const dy = lanes[b + 9] - lanes[b + 1];
  const points: Point[] = new Array(n);
  for (let i = 0; i < n; i++) points[i] = [pool[off + i * 2] + dx, pool[off + i * 2 + 1] + dy];
  return { points };
}
function fillFrameFromBindLanes(
  scratch: FrameTuple,
  kindCode: number,
  lanes: Float64Array,
  gi: number,
  frozenFrame: FrameTuple | null,
): void {
  const b = gi * G_STRIDE;
  if (kindCode === K_SHAPE || kindCode === K_IMAGE) {
    scratch[0] = lanes[b + 12];
    scratch[1] = lanes[b + 13];
    scratch[2] = lanes[b + 14];
    scratch[3] = lanes[b + 15];
    return;
  }
  if (kindCode === K_TEXT || kindCode === K_CODE) {
    scratch[0] = lanes[b + 8];
    scratch[1] = lanes[b + 9];
    scratch[2] = lanes[b + 10] - lanes[b + 8];
    scratch[3] = lanes[b + 11] - lanes[b + 9];
    return;
  }
  const ratio = lanes[b + 14] / lanes[b + 6];
  const fz = frozenFrame!;
  scratch[0] = lanes[b + 12];
  scratch[1] = lanes[b + 13];
  scratch[2] = fz[2] * ratio;
  scratch[3] = fz[3] * ratio;
}

// ═══════════════════════════════════════════════════════════ generators ══

const HANDLES: readonly HandleId[] = ['nw', 'ne', 'se', 'sw', 'n', 's', 'e', 'w'];

function randScaleFactor(rng: () => number): number {
  const r = rng();
  if (r < 0.06) return 0; // rawScaleFactors can yield exact 0
  if (r < 0.18) return (rng() - 0.5) * 2e-4; // tiny — crosses the 0.001 min clamps
  if (r < 0.24) return rng() < 0.5 ? 1 : -1;
  return (rng() - 0.5) * 6; // [-3, 3), flips included
}

function randCtx(rng: () => number): ScaleCtx {
  const handleId = HANDLES[Math.floor(rng() * 8)];
  const x = (rng() - 0.5) * 2000;
  const y = (rng() - 0.5) * 2000;
  const w = rng() < 0.06 ? 0 : rng() * 900; // degenerate bw → tx=0.5 fallback
  const h = rng() < 0.06 ? 0 : rng() * 900;
  const selBounds: BBoxTuple = [x, y, x + w, y + h];
  const origin: Point = rng() < 0.7 ? scaleOrigin_O(handleId, selBounds) : [x + (rng() - 0.5) * 1200, y + (rng() - 0.5) * 1200];
  return { sx: randScaleFactor(rng), sy: randScaleFactor(rng), origin, selBounds, handleId };
}

/** Frozen bbox tickling edgePin's three branches: span-full / straddle-origin / inside / outside. */
function randFrozenBBox(rng: () => number, ctx: ScaleCtx): BBoxTuple {
  const sel = ctx.selBounds;
  const roll = rng();
  if (roll < 0.12) return [sel[0], sel[1], sel[2], sel[3]]; // spans full on both axes
  if (roll < 0.24) {
    // straddles the origin on both axes
    const [ox, oy] = ctx.origin;
    const w = rng() * 200 + 1;
    const h = rng() * 200 + 1;
    return [ox - w * rng(), oy - h * rng(), ox + w * rng() + 0.5, oy + h * rng() + 0.5];
  }
  if (roll < 0.36) {
    // entirely outside the selection/origin neighborhood
    const x = sel[2] + rng() * 500 + 10;
    const y = sel[3] + rng() * 500 + 10;
    return [x, y, x + rng() * 120 + 1, y + rng() * 120 + 1];
  }
  // random box overlapping the selection
  const x = sel[0] + (rng() - 0.25) * (sel[2] - sel[0] + 120);
  const y = sel[1] + (rng() - 0.25) * (sel[3] - sel[1] + 120);
  return [x, y, x + rng() * 300, y + rng() * 300];
}

/** Frame inside a bbox with a constant pad (shape strokePad ≥ 0; 0 = image). */
function frameForBBox(rng: () => number, b: BBoxTuple): FrameTuple {
  const pad = rng() < 0.25 ? 0 : rng() * 12;
  return [b[0] + pad, b[1] + pad, Math.max(0, b[2] - b[0] - 2 * pad), Math.max(0, b[3] - b[1] - 2 * pad)];
}

function fillFrozenLanes(lanes: Float64Array, gi: number, fb: Readonly<BBoxTuple>, aux: Readonly<[number, number, number, number]>): void {
  const b = gi * G_STRIDE;
  lanes[b] = fb[0];
  lanes[b + 1] = fb[1];
  lanes[b + 2] = fb[2];
  lanes[b + 3] = fb[3];
  lanes[b + 4] = aux[0];
  lanes[b + 5] = aux[1];
  lanes[b + 6] = aux[2];
  lanes[b + 7] = aux[3];
  // seed out = frozen (transform.ts freeze contract)
  lanes[b + 8] = fb[0];
  lanes[b + 9] = fb[1];
  lanes[b + 10] = fb[2];
  lanes[b + 11] = fb[3];
  lanes[b + 12] = aux[0];
  lanes[b + 13] = aux[1];
  lanes[b + 14] = aux[2];
  lanes[b + 15] = aux[3];
}

// ═══════════════════════════════════════════════════════════════ suites ══

const N = 5200; // cases per op (≥5k), run in 3-entry batches
const BATCH = 3;
const lanes = new Float64Array(BATCH * G_STRIDE);

function testKindCodes(): void {
  console.log('K_* ≡ OBJECT_KINDS order');
  const KS = [K_STROKE, K_SHAPE, K_TEXT, K_CONNECTOR, K_CODE, K_IMAGE, K_NOTE, K_BOOKMARK];
  for (let i = 0; i < OBJECT_KINDS.length; i++) {
    check(KS[i] === i, `K_${OBJECT_KINDS[i].toUpperCase()} === ${i}`);
    check(KIND_CODE[OBJECT_KINDS[i]] === KS[i], `KIND_CODE[${OBJECT_KINDS[i]}] === K_*`);
  }
}

function testLuts(): void {
  console.log('BEHAVIOR_LUT / OP_LUT vs resolveBehavior + APPLY_SCALE cells');
  const BEH_INT: Record<ScaleBehavior, number> = {
    uniform: BEH_UNIFORM,
    nonUniform: BEH_NON_UNIFORM,
    edgePin: BEH_EDGE_PIN,
    reflow: BEH_REFLOW,
  };
  const SCALABLE: readonly ScalableKind[] = ['stroke', 'shape', 'text', 'code', 'image', 'note', 'bookmark'];
  for (const kind of SCALABLE) {
    const kc = KIND_CODE[kind];
    for (const h of HANDLES) {
      for (const single of [false, true]) {
        // cat computed the way transform.ts computes it (real guards, not oracle copies)
        const cat = isCorner(h) ? CAT_CORNER : isHorzSide(h) ? CAT_HSIDE : CAT_VSIDE;
        const got = BEHAVIOR_LUT[kc * 8 + cat * 2 + (single ? 1 : 0)];
        const want = BEH_INT[resolveBehavior_O(kind, h, single)];
        check(got === want, `BEHAVIOR_LUT ${kind} ${h} ${single ? 'single' : 'multi'}: got ${got} want ${want}`);
      }
    }
  }

  // OP_LUT ≡ APPLY_SCALE's populated cells; 0xFF everywhere else.
  const APPLY_CELLS_O: Record<ScalableKind, Partial<Record<ScaleBehavior, number>>> = {
    shape: { uniform: OP_FRAME_UNIFORM, nonUniform: OP_FRAME_EDGES },
    image: { uniform: OP_FRAME_UNIFORM, edgePin: OP_OFFSET },
    stroke: { uniform: OP_STROKE_UNIFORM, edgePin: OP_OFFSET },
    text: { uniform: OP_ORIGIN_UNIFORM, edgePin: OP_OFFSET, reflow: OP_REFLOW_TEXT },
    code: { uniform: OP_ORIGIN_UNIFORM, edgePin: OP_OFFSET, reflow: OP_REFLOW_CODE },
    note: { uniform: OP_ORIGIN_UNIFORM, edgePin: OP_OFFSET },
    bookmark: { uniform: OP_ORIGIN_UNIFORM, edgePin: OP_OFFSET },
  };
  const ALL_BEH: readonly ScaleBehavior[] = ['uniform', 'nonUniform', 'edgePin', 'reflow'];
  for (const kind of SCALABLE) {
    const kc = KIND_CODE[kind];
    for (const beh of ALL_BEH) {
      const want = APPLY_CELLS_O[kind][beh];
      const got = OP_LUT[kc * 4 + BEH_INT[beh]];
      if (want !== undefined) check(got === want, `OP_LUT ${kind}/${beh}: got ${got} want ${want}`);
      else check(got === 0xff, `OP_LUT ${kind}/${beh} unreachable → 0xFF (got ${got})`);
    }
  }
  for (let b = 0; b < 4; b++) check(OP_LUT[K_CONNECTOR * 4 + b] === 0xff, `OP_LUT connector/${b} → 0xFF`);
  // Every reachable (kind, handle, single) resolves to a populated op cell.
  for (const kind of SCALABLE) {
    const kc = KIND_CODE[kind];
    for (const h of HANDLES) {
      for (const single of [false, true]) {
        const cat = isCorner(h) ? CAT_CORNER : isHorzSide(h) ? CAT_HSIDE : CAT_VSIDE;
        const op = OP_LUT[kc * 4 + BEHAVIOR_LUT[kc * 8 + cat * 2 + (single ? 1 : 0)]];
        check(op !== 0xff, `reachable path ${kind}/${h}/${single} resolves to a real op`);
      }
    }
  }
}

function testOffsetAndEdgePin(): void {
  console.log('OP_OFFSET (translate) + edgePin fuzz');
  const rng = mulberry32(0x0ff5e7);
  for (let c = 0; c < N; c += BATCH) {
    const ctx = randCtx(rng);
    const dx = (rng() - 0.5) * 800;
    const dy = (rng() - 0.5) * 800;
    type Case = { fb: BBoxTuple; aux: [number, number, number, number]; flavor: number };
    const cases: Case[] = [];
    for (let gi = 0; gi < BATCH; gi++) {
      const fb = randFrozenBBox(rng, ctx);
      const flavor = Math.floor(rng() * 3); // 0=frame kinds, 1=origin+scale, 2=origin+fontSize(+width/NaN)
      let aux: [number, number, number, number];
      if (flavor === 0) {
        const fr = frameForBBox(rng, fb);
        aux = [fr[0], fr[1], fr[2], fr[3]];
      } else if (flavor === 1) {
        aux = [fb[0] + rng() * 50, fb[1] + rng() * 50, 0.1 + rng() * 5, 0];
      } else {
        aux = [fb[0] + rng() * 50, fb[1] + rng() * 50, 8 + rng() * 120, rng() < 0.3 ? NaN : 40 + rng() * 400];
      }
      fillFrozenLanes(lanes, gi, fb, aux);
      cases.push({ fb, aux, flavor });
    }

    // --- translate semantics ---
    applyOffsetRange(lanes, 0, BATCH, dx, dy);
    for (let gi = 0; gi < BATCH; gi++) {
      const { fb, aux, flavor } = cases[gi];
      if (flavor === 0) {
        const f = { frame: [aux[0], aux[1], aux[2], aux[3]] as FrameTuple, bbox: fb };
        const o = { frame: [0, 0, 0, 0] as FrameTuple, bbox: [0, 0, 0, 0] as BBoxTuple };
        applyOffset_O(f, dx, dy, o);
        check(lanesEq(lanes, gi, 8, o.bbox, 4), `offset frame-flavor bbox gi=${gi} c=${c}`);
        check(lanesEq(lanes, gi, 12, o.frame, 4), `offset frame-flavor aux gi=${gi} c=${c}`);
      } else {
        const f = { origin: [aux[0], aux[1]] as Point, scale: aux[2], bbox: fb };
        const o = { origin: [0, 0] as Point, scale: 0, bbox: [0, 0, 0, 0] as BBoxTuple };
        applyOffset_O(f, dx, dy, o);
        check(lanesEq(lanes, gi, 8, o.bbox, 4), `offset origin-flavor bbox gi=${gi} c=${c}`);
        check(lanesEq(lanes, gi, 12, [o.origin[0], o.origin[1], o.scale, aux[3]], 4), `offset origin-flavor aux gi=${gi} c=${c}`);
      }
    }

    // --- edgePin semantics (same frozen lanes; re-seed outputs first) ---
    for (let gi = 0; gi < BATCH; gi++) fillFrozenLanes(lanes, gi, cases[gi].fb, cases[gi].aux);
    applyEdgePinRange(
      lanes,
      0,
      BATCH,
      ctx.origin[0],
      ctx.origin[1],
      ctx.sx,
      ctx.sy,
      ctx.selBounds[0],
      ctx.selBounds[1],
      ctx.selBounds[2],
      ctx.selBounds[3],
    );
    for (let gi = 0; gi < BATCH; gi++) {
      const { fb, aux, flavor } = cases[gi];
      if (flavor === 0) {
        const f = { frame: [aux[0], aux[1], aux[2], aux[3]] as FrameTuple, bbox: fb };
        const o = { frame: [0, 0, 0, 0] as FrameTuple, bbox: [0, 0, 0, 0] as BBoxTuple };
        edgePinOffset_O(f, ctx, o);
        check(lanesEq(lanes, gi, 8, o.bbox, 4), `edgePin frame-flavor bbox gi=${gi} c=${c}`);
        check(lanesEq(lanes, gi, 12, o.frame, 4), `edgePin frame-flavor aux gi=${gi} c=${c}`);
      } else {
        const f = { origin: [aux[0], aux[1]] as Point, scale: aux[2], bbox: fb };
        const o = { origin: [0, 0] as Point, scale: 0, bbox: [0, 0, 0, 0] as BBoxTuple };
        edgePinOffset_O(f, ctx, o);
        check(lanesEq(lanes, gi, 8, o.bbox, 4), `edgePin origin-flavor bbox gi=${gi} c=${c}`);
        check(lanesEq(lanes, gi, 12, [o.origin[0], o.origin[1], o.scale, aux[3]], 4), `edgePin origin-flavor aux gi=${gi} c=${c}`);
      }

      // stroke offset commit spec vs oracle (pool ↔ points equivalence)
      if (flavor === 1 && gi === 0) {
        const nPts = 1 + Math.floor(rng() * 6);
        const pool = new Float64Array(nPts * 2);
        const pts: Point[] = [];
        for (let i = 0; i < nPts; i++) {
          pool[i * 2] = (rng() - 0.5) * 500;
          pool[i * 2 + 1] = (rng() - 0.5) * 500;
          pts.push([pool[i * 2], pool[i * 2 + 1]]);
        }
        const oldOut: StrokeOut = { bbox: [lanes[8], lanes[9], lanes[10], lanes[11]], factor: 1, fcx: 0, fcy: 0 };
        const want = commitStrokeOffset_O(oldOut, { points: pts, bbox: fb });
        const got = commitStrokeOffsetLanes(lanes, 0, pool, 0, nPts);
        let ok = true;
        for (let i = 0; i < nPts; i++)
          if (!feq(got.points[i][0], want.points[i][0]) || !feq(got.points[i][1], want.points[i][1])) ok = false;
        check(ok, `stroke offset commit points c=${c}`);
      }
    }
  }
}

function testFrameUniform(): void {
  console.log('OP_FRAME_UNIFORM fuzz');
  const rng = mulberry32(0xf7a3e1);
  for (let c = 0; c < N; c += BATCH) {
    const ctx = randCtx(rng);
    const U = fillUniformPack(
      ctx.sx,
      ctx.sy,
      ctx.handleId,
      ctx.selBounds[0],
      ctx.selBounds[1],
      ctx.selBounds[2],
      ctx.selBounds[3],
      ctx.origin[0],
      ctx.origin[1],
    );
    const cases: { fb: BBoxTuple; fr: FrameTuple }[] = [];
    for (let gi = 0; gi < BATCH; gi++) {
      const fb = randFrozenBBox(rng, ctx);
      const fr = frameForBBox(rng, fb);
      fillFrozenLanes(lanes, gi, fb, [fr[0], fr[1], fr[2], fr[3]]);
      cases.push({ fb, fr });
    }
    applyFrameUniformRange(lanes, 0, BATCH, U);
    for (let gi = 0; gi < BATCH; gi++) {
      const { fb, fr } = cases[gi];
      const o = { frame: [0, 0, 0, 0] as FrameTuple, bbox: [0, 0, 0, 0] as BBoxTuple };
      scaleFrameUniform_O({ frame: fr, bbox: fb }, ctx, o);
      check(lanesEq(lanes, gi, 8, o.bbox, 4), `frameUniform bbox gi=${gi} c=${c}`);
      check(lanesEq(lanes, gi, 12, o.frame, 4), `frameUniform frame gi=${gi} c=${c}`);
      // frame commit value == oAux lanes (commitFrame reads o.frame verbatim)
      check(lanesEq(lanes, gi, 12, o.frame, 4), `frame commit value gi=${gi} c=${c}`);
      // fillFrameFromBind: shape/image branch reads oAux as the live frame
      const scr: FrameTuple = [0, 0, 0, 0];
      fillFrameFromBindLanes(scr, K_SHAPE, lanes, gi, null);
      const scrO: FrameTuple = [0, 0, 0, 0];
      fillFrameFromBind_O(scrO, 'shape', o, {}, null);
      check(
        feq(scr[0], scrO[0]) && feq(scr[1], scrO[1]) && feq(scr[2], scrO[2]) && feq(scr[3], scrO[3]),
        `bind frame branch gi=${gi} c=${c}`,
      );
    }
  }
}

function testFrameEdges(): void {
  console.log('OP_FRAME_EDGES fuzz');
  const rng = mulberry32(0xed6e5);
  for (let c = 0; c < N; c += BATCH) {
    const ctx = randCtx(rng);
    const cases: { fb: BBoxTuple; fr: FrameTuple }[] = [];
    for (let gi = 0; gi < BATCH; gi++) {
      const fb = randFrozenBBox(rng, ctx);
      const fr = frameForBBox(rng, fb);
      fillFrozenLanes(lanes, gi, fb, [fr[0], fr[1], fr[2], fr[3]]);
      cases.push({ fb, fr });
    }
    applyFrameEdgesRange(lanes, 0, BATCH, ctx.origin[0], ctx.origin[1], ctx.sx, ctx.sy);
    for (let gi = 0; gi < BATCH; gi++) {
      const { fb, fr } = cases[gi];
      const o = { frame: [0, 0, 0, 0] as FrameTuple, bbox: [0, 0, 0, 0] as BBoxTuple };
      scaleFrameNonUniform_O({ frame: fr, bbox: fb }, ctx, o);
      check(lanesEq(lanes, gi, 8, o.bbox, 4), `frameEdges bbox gi=${gi} c=${c}`);
      check(lanesEq(lanes, gi, 12, o.frame, 4), `frameEdges frame gi=${gi} c=${c}`);
    }
  }
}

function testStrokeUniform(): void {
  console.log('OP_STROKE_UNIFORM fuzz (+ uniform commit)');
  const rng = mulberry32(0x570c8e);
  for (let c = 0; c < N; c += BATCH) {
    const ctx = randCtx(rng);
    const U = fillUniformPack(
      ctx.sx,
      ctx.sy,
      ctx.handleId,
      ctx.selBounds[0],
      ctx.selBounds[1],
      ctx.selBounds[2],
      ctx.selBounds[3],
      ctx.origin[0],
      ctx.origin[1],
    );
    const cases: { fb: BBoxTuple; width: number }[] = [];
    for (let gi = 0; gi < BATCH; gi++) {
      const fb = randFrozenBBox(rng, ctx);
      const width = 1 + rng() * 30;
      // stroke frozen aux = [ptsOff, ptsCount, width, 0]; the kernel never reads 0..1
      fillFrozenLanes(lanes, gi, fb, [Math.floor(rng() * 64) * 2, Math.floor(rng() * 16), width, 0]);
      // transform.ts seeds STROKE_UNIFORM oAux = [fcx, fcy, 1, 0] — replicate to
      // prove the kernel overwrites (aux3 stays untouched garbage)
      const b = gi * G_STRIDE;
      lanes[b + 12] = (fb[0] + fb[2]) / 2;
      lanes[b + 13] = (fb[1] + fb[3]) / 2;
      lanes[b + 14] = 1;
      lanes[b + 15] = 0;
      cases.push({ fb, width });
    }
    applyStrokeUniformRange(lanes, 0, BATCH, U);
    for (let gi = 0; gi < BATCH; gi++) {
      const { fb, width } = cases[gi];
      const o: StrokeOut = { bbox: [0, 0, 0, 0], factor: 1, fcx: 0, fcy: 0 };
      const nPts = 1 + Math.floor(rng() * 6);
      const pool = new Float64Array(nPts * 2);
      const pts: Point[] = [];
      for (let i = 0; i < nPts; i++) {
        pool[i * 2] = fb[0] + rng() * (fb[2] - fb[0]);
        pool[i * 2 + 1] = fb[1] + rng() * (fb[3] - fb[1]);
        pts.push([pool[i * 2], pool[i * 2 + 1]]);
      }
      scaleStrokeBBox_O({ points: pts, width, bbox: fb }, ctx, o);
      check(lanesEq(lanes, gi, 8, o.bbox, 4), `strokeUniform bbox gi=${gi} c=${c}`);
      check(feq(lanes[gi * G_STRIDE + 12], o.fcx), `strokeUniform fcx gi=${gi} c=${c}`);
      check(feq(lanes[gi * G_STRIDE + 13], o.fcy), `strokeUniform fcy gi=${gi} c=${c}`);
      check(feq(lanes[gi * G_STRIDE + 14], o.factor), `strokeUniform factor gi=${gi} c=${c}`);

      const want = commitStrokeUniform_O(o, { points: pts, width, bbox: fb });
      const got = commitStrokeUniformLanes(lanes, gi, pool, 0, nPts);
      let ok = feq(got.width, want.width);
      for (let i = 0; i < nPts; i++) if (!feq(got.points[i][0], want.points[i][0]) || !feq(got.points[i][1], want.points[i][1])) ok = false;
      check(ok, `stroke uniform commit gi=${gi} c=${c}`);
    }
  }
}

function testOriginUniform(): void {
  console.log('OP_ORIGIN_UNIFORM fuzz (text fontSize/width incl. NaN + note scale)');
  const rng = mulberry32(0x0716a1);
  for (let c = 0; c < N; c += BATCH) {
    const ctx = randCtx(rng);
    const U = fillUniformPack(
      ctx.sx,
      ctx.sy,
      ctx.handleId,
      ctx.selBounds[0],
      ctx.selBounds[1],
      ctx.selBounds[2],
      ctx.selBounds[3],
      ctx.origin[0],
      ctx.origin[1],
    );
    type Case = { fb: BBoxTuple; aux: [number, number, number, number]; text: boolean; width: number | 'auto' };
    const cases: Case[] = [];
    for (let gi = 0; gi < BATCH; gi++) {
      const fb = randFrozenBBox(rng, ctx);
      const text = rng() < 0.6;
      const ox = fb[0] + rng() * Math.max(1, fb[2] - fb[0]);
      const oy = fb[1] + rng() * Math.max(1, fb[3] - fb[1]);
      let aux: [number, number, number, number];
      let width: number | 'auto' = 'auto';
      if (text) {
        width = rng() < 0.3 ? 'auto' : 40 + rng() * 400;
        aux = [ox, oy, 8 + rng() * 120, typeof width === 'number' ? width : NaN];
      } else {
        aux = [ox, oy, 0.1 + rng() * 5, 0];
      }
      fillFrozenLanes(lanes, gi, fb, aux);
      cases.push({ fb, aux, text, width });
    }
    applyOriginUniformRange(lanes, 0, BATCH, U);
    for (let gi = 0; gi < BATCH; gi++) {
      const { fb, aux, text, width } = cases[gi];
      const b = gi * G_STRIDE;
      if (text) {
        const f: OriginGeo = { origin: [aux[0], aux[1]], bbox: fb, fontSize: aux[2], width };
        const o: OriginOut = { origin: [0, 0], bbox: [0, 0, 0, 0], fontSize: 0, width: 0 };
        scaleOriginFontSize_O(f, ctx, o);
        check(lanesEq(lanes, gi, 8, o.bbox, 4), `originUniform text bbox gi=${gi} c=${c}`);
        check(feq(lanes[b + 12], o.origin[0]) && feq(lanes[b + 13], o.origin[1]), `originUniform text origin gi=${gi} c=${c}`);
        check(feq(lanes[b + 14], o.fontSize!), `originUniform text fontSize gi=${gi} c=${c}`);
        check(feq(lanes[b + 15], o.width!), `originUniform text width (NaN-aware) gi=${gi} c=${c}`);
        // commitTextScale spec: skip width iff NaN — lane NaN ⇔ frozen 'auto'
        check(Number.isNaN(lanes[b + 15]) === (width === 'auto'), `text width NaN ⇔ 'auto' gi=${gi} c=${c}`);
      } else {
        const f: OriginGeo = { origin: [aux[0], aux[1]], bbox: fb, scale: aux[2] };
        const o: OriginOut = { origin: [0, 0], bbox: [0, 0, 0, 0], scale: 0 };
        scaleOriginScale_O(f, ctx, o);
        check(lanesEq(lanes, gi, 8, o.bbox, 4), `originUniform note bbox gi=${gi} c=${c}`);
        check(feq(lanes[b + 12], o.origin[0]) && feq(lanes[b + 13], o.origin[1]), `originUniform note origin gi=${gi} c=${c}`);
        check(feq(lanes[b + 14], o.scale!), `originUniform note scale gi=${gi} c=${c}`);
        check(lanes[b + 15] === 0, `originUniform note aux3 stays 0 gi=${gi} c=${c}`);

        // fillFrameFromBind note branch: ratio = oAux2/fAux2 against entry oracle
        const fz: FrameTuple = [aux[0], aux[1], 10 + rng() * 300, 10 + rng() * 300];
        const scr: FrameTuple = [0, 0, 0, 0];
        fillFrameFromBindLanes(scr, K_NOTE, lanes, gi, fz);
        const scrO: FrameTuple = [0, 0, 0, 0];
        fillFrameFromBind_O(scrO, 'note', { bbox: o.bbox, scale: o.scale, origin: o.origin }, { scale: aux[2] }, fz);
        check(
          feq(scr[0], scrO[0]) && feq(scr[1], scrO[1]) && feq(scr[2], scrO[2]) && feq(scr[3], scrO[3]),
          `bind note branch gi=${gi} c=${c}`,
        );
      }
      // fillFrameFromBind text/code branch: out bbox read as frame
      const scr: FrameTuple = [0, 0, 0, 0];
      fillFrameFromBindLanes(scr, K_TEXT, lanes, gi, null);
      const ob: BBoxTuple = [lanes[b + 8], lanes[b + 9], lanes[b + 10], lanes[b + 11]];
      const scrO: FrameTuple = [0, 0, 0, 0];
      fillFrameFromBind_O(scrO, 'text', { bbox: ob }, {}, null);
      check(
        feq(scr[0], scrO[0]) && feq(scr[1], scrO[1]) && feq(scr[2], scrO[2]) && feq(scr[3], scrO[3]),
        `bind text branch gi=${gi} c=${c}`,
      );
    }
  }
}

function testReflowLeftWidth(): void {
  console.log('reflowLeftWidth ≡ computeReflowWidth');
  const rng = mulberry32(0x8ef1c3);
  for (let c = 0; c < N; c++) {
    const fx = (rng() - 0.5) * 2000;
    const fw = rng() < 0.08 ? 0 : rng() * 900;
    const roll = rng();
    // origin left of / inside / right of the [fx, fx+fw] span
    const originX = roll < 0.33 ? fx - rng() * 500 : roll < 0.66 ? fx + fw * rng() : fx + fw + rng() * 500;
    const sx = randScaleFactor(rng);
    const minW = rng() < 0.3 ? 0 : rng() * 200; // 0 disables the clamp; big values force it
    const [wantLeft, wantWidth] = computeReflowWidth_O(fx, fw, originX, sx, minW);
    reflowLeftWidth(fx, fw, originX, sx, minW);
    check(feq(reflowOut[0], wantLeft) && feq(reflowOut[1], wantWidth), `reflowLeftWidth c=${c}`);
  }
}

// ───────────────────────────────────────────────────────────────── run ──

const t0 = performance.now();
testKindCodes();
testLuts();
testOffsetAndEdgePin();
testFrameUniform();
testFrameEdges();
testStrokeUniform();
testOriginUniform();
testReflowLeftWidth();

const elapsed = performance.now() - t0;
console.log(`\n${checks} checks, ${failures} failures (${elapsed.toFixed(0)} ms)`);
if (failures > 0) process.exit(1);
