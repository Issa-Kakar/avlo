/**
 * Transform kernels — pure lane math over the gesture engine's SoA buffer.
 *
 * The gesture engine (`transform.ts`) freezes every entry into one interleaved
 * Float64Array (`lanes`, stride 16) and partitions entries into contiguous op
 * ranges; each kernel here is one straight-line loop over such a range. All
 * arithmetic is an EXACT port of the old entry-based apply fns (operation
 * order preserved — `transform-kernels.selftest.ts` proves bit-identical
 * output against verbatim oracle copies). Do not "simplify" float expressions:
 * e.g. `scaleAround(fx + fw, …)` is NOT bit-equal to `scaleAround(maxX, …)`,
 * and `ob2 - ob0` is NOT `w` — the selftest asserts exact equality.
 *
 * Canvas-free leaf: imports only `core/geometry/scale-system` scalar atoms +
 * the K_* kind codes — esbuild+node runnable (see the selftest header).
 * Reflow ops (OP_REFLOW_*) live in transform.ts (they need the layout
 * engines + heap sidecars); this module supplies their shared
 * `reflowLeftWidth` edge math.
 *
 * LANE LAYOUT — per gesture entry `gi`, `base = gi * G_STRIDE`:
 *   +0..3   fBBox  frozen bbox (text: TIGHT frame bbox; code: column ≡ tight;
 *                  others: column rect)
 *   +4..7   fAux   per-kind:  shape/image  frame x, y, w, h
 *                             stroke       ptsOff, ptsCount, width, 0
 *                             text         originX, originY, fontSize, width (NaN = 'auto')
 *                             code         originX, originY, fontSize, width
 *                                          (OFFSET freeze leaves [2..3] = 0 — unread)
 *                             note/bkmk    originX, originY, scale, 0
 *   +8..11  oBBox  output bbox — seeded = fBBox at freeze
 *   +12..15 oAux   output aux — seeded = fAux, EXCEPT STROKE_UNIFORM entries
 *                  seed [frozenCx, frozenCy, 1, 0] (the renderer's stroke arm
 *                  reads oAux as fcx/fcy/factor from the first overlapping
 *                  repaint in the begin→first-move window — a blind fAux copy
 *                  would paint the stroke scaled `width`× around
 *                  `(ptsOff, ptsCount)`)
 *
 * Post-OFFSET stroke oAux is documented garbage (aux0..1 get the offset,
 * aux2..3 the copy) — stroke's offset commit reads frozen lanes + oBBox only.
 */

import { edgePinPosition1D, MIN_SHAPE_FRAME_DIM, scaleAround, uniformFactor } from '@/core/geometry/scale-system';
import type { HandleId } from '@/core/types/handles';
import { K_BOOKMARK, K_CODE, K_IMAGE, K_NOTE, K_SHAPE, K_STROKE, K_TEXT } from '@/core/types/objects';

// ============================================================================
// Lane / op / meta constants
// ============================================================================

export const G_STRIDE = 16;
export const GF_BBOX = 0;
export const GF_AUX = 4;
export const GO_BBOX = 8;
export const GO_AUX = 12;

// Ops — behavior × kind resolved once at begin; entries are counting-sorted
// into contiguous [opStart[op], opStart[op] + opCount[op]) ranges.
export const OP_OFFSET = 0; // translate (gesture delta) / scale-edgePin (per-entry delta)
export const OP_FRAME_UNIFORM = 1; // shape/image uniform
export const OP_FRAME_EDGES = 2; // shape nonUniform (per-axis, min-clamped)
export const OP_STROKE_UNIFORM = 3; // stroke uniform (bbox + fcx/fcy/factor)
export const OP_ORIGIN_UNIFORM = 4; // text/code/note/bookmark uniform
export const OP_REFLOW_TEXT = 5; // text E/W reflow (transform.ts arm)
export const OP_REFLOW_CODE = 6; // code E/W reflow (transform.ts arm)
export const OP_COUNT = 7;

// Behaviors (BEHAVIOR_LUT values) — int mirror of the old ScaleBehavior strings.
export const BEH_UNIFORM = 0;
export const BEH_NON_UNIFORM = 1;
export const BEH_EDGE_PIN = 2;
export const BEH_REFLOW = 3;

// Handle categories (BEHAVIOR_LUT index component; computed once per beginScale).
export const CAT_CORNER = 0;
export const CAT_HSIDE = 1;
export const CAT_VSIDE = 2;

// meta[gi] bit layout: 0–2 kindCode · 3–5 op · 6 DEAD (commit-skip only; hot
// loops never test) · 7–9 code flags (lineNumbers / headerVisible / outputVisible).
export const META_KIND_MASK = 7;
export const META_OP_SHIFT = 3;
export const META_OP_MASK = 7;
export const META_DEAD = 1 << 6;
export const META_CODE_LINE_NUMBERS = 1 << 7;
export const META_CODE_HEADER_VISIBLE = 1 << 8;
export const META_CODE_OUTPUT_VISIBLE = 1 << 9;

// Sparse slot-map encodings (`_slotGesture` in transform.ts): -1 = not in
// gesture · plain gi = gesture entry · TOPO_TAG|ti = topology connector entry
// · EPDRAG_TAG = the endpoint-drag connector.
export const TOPO_TAG = 1 << 30;
export const EPDRAG_TAG = 1 << 29;
export const GIDX_MASK = (1 << 29) - 1;

// ============================================================================
// LUTs
// ============================================================================

/**
 * kindCode*8 + cat*2 + (single ? 1 : 0) → BEH_*. Built from the same
 * declarative rules as the old `resolveBehavior` (defaults + overrides);
 * the selftest proves ≡ over every reachable cell. Slot `cat = 3` unused.
 * The connector row is populated with defaults but unreachable — begin
 * branches connectors to the topology builder before LUT resolution.
 */
export const BEHAVIOR_LUT = new Uint8Array(64);

/**
 * kindCode*4 + behavior → OP_*. Populated cells mirror the old APPLY_SCALE
 * table exactly; every other cell (incl. shape-edgePin, which BEHAVIOR_LUT
 * can never produce, and connector's whole row) stays 0xFF — unreachable by
 * construction, never read.
 */
export const OP_LUT = new Uint8Array(32).fill(0xff);

function buildLuts(): void {
  // Defaults: corner → UNIFORM/UNIFORM; hSide,vSide → single UNIFORM / multi EDGE_PIN.
  for (let kc = 0; kc < 8; kc++) {
    BEHAVIOR_LUT[kc * 8 + CAT_CORNER * 2] = BEH_UNIFORM;
    BEHAVIOR_LUT[kc * 8 + CAT_CORNER * 2 + 1] = BEH_UNIFORM;
    BEHAVIOR_LUT[kc * 8 + CAT_HSIDE * 2] = BEH_EDGE_PIN;
    BEHAVIOR_LUT[kc * 8 + CAT_HSIDE * 2 + 1] = BEH_UNIFORM;
    BEHAVIOR_LUT[kc * 8 + CAT_VSIDE * 2] = BEH_EDGE_PIN;
    BEHAVIOR_LUT[kc * 8 + CAT_VSIDE * 2 + 1] = BEH_UNIFORM;
  }
  // Overrides: shapes nonUniform on sides (always) + corner-single; multi-shape
  // corners stay default UNIFORM so groups scale together. Text/code reflow on E/W always.
  BEHAVIOR_LUT[K_SHAPE * 8 + CAT_CORNER * 2 + 1] = BEH_NON_UNIFORM;
  BEHAVIOR_LUT[K_SHAPE * 8 + CAT_HSIDE * 2] = BEH_NON_UNIFORM;
  BEHAVIOR_LUT[K_SHAPE * 8 + CAT_HSIDE * 2 + 1] = BEH_NON_UNIFORM;
  BEHAVIOR_LUT[K_SHAPE * 8 + CAT_VSIDE * 2] = BEH_NON_UNIFORM;
  BEHAVIOR_LUT[K_SHAPE * 8 + CAT_VSIDE * 2 + 1] = BEH_NON_UNIFORM;
  BEHAVIOR_LUT[K_TEXT * 8 + CAT_HSIDE * 2] = BEH_REFLOW;
  BEHAVIOR_LUT[K_TEXT * 8 + CAT_HSIDE * 2 + 1] = BEH_REFLOW;
  BEHAVIOR_LUT[K_CODE * 8 + CAT_HSIDE * 2] = BEH_REFLOW;
  BEHAVIOR_LUT[K_CODE * 8 + CAT_HSIDE * 2 + 1] = BEH_REFLOW;

  OP_LUT[K_SHAPE * 4 + BEH_UNIFORM] = OP_FRAME_UNIFORM;
  OP_LUT[K_SHAPE * 4 + BEH_NON_UNIFORM] = OP_FRAME_EDGES;
  OP_LUT[K_IMAGE * 4 + BEH_UNIFORM] = OP_FRAME_UNIFORM;
  OP_LUT[K_IMAGE * 4 + BEH_EDGE_PIN] = OP_OFFSET;
  OP_LUT[K_STROKE * 4 + BEH_UNIFORM] = OP_STROKE_UNIFORM;
  OP_LUT[K_STROKE * 4 + BEH_EDGE_PIN] = OP_OFFSET;
  OP_LUT[K_TEXT * 4 + BEH_UNIFORM] = OP_ORIGIN_UNIFORM;
  OP_LUT[K_TEXT * 4 + BEH_EDGE_PIN] = OP_OFFSET;
  OP_LUT[K_TEXT * 4 + BEH_REFLOW] = OP_REFLOW_TEXT;
  OP_LUT[K_CODE * 4 + BEH_UNIFORM] = OP_ORIGIN_UNIFORM;
  OP_LUT[K_CODE * 4 + BEH_EDGE_PIN] = OP_OFFSET;
  OP_LUT[K_CODE * 4 + BEH_REFLOW] = OP_REFLOW_CODE;
  OP_LUT[K_NOTE * 4 + BEH_UNIFORM] = OP_ORIGIN_UNIFORM;
  OP_LUT[K_NOTE * 4 + BEH_EDGE_PIN] = OP_OFFSET;
  OP_LUT[K_BOOKMARK * 4 + BEH_UNIFORM] = OP_ORIGIN_UNIFORM;
  OP_LUT[K_BOOKMARK * 4 + BEH_EDGE_PIN] = OP_OFFSET;
}
buildLuts();

// ============================================================================
// UniformPack — the per-frame hoist for the three *_UNIFORM kernels
// ============================================================================

/**
 * Gesture-global constants of the uniform-scale math (old `scaleBBoxUniform`
 * internals): uf/af + the scaled selection corners. Per-entry residue is
 * tx/ty (0.5 fallback when bw/bh ≤ 0) + center + dims — computed in-loop.
 */
export interface UniformPack {
  uf: number;
  af: number;
  sel0: number;
  sel1: number;
  bw: number;
  bh: number;
  bwPos: boolean;
  bhPos: boolean;
  nMinX: number;
  nMinY: number;
  nW: number;
  nH: number;
}

const _pack: UniformPack = {
  uf: 1,
  af: 1,
  sel0: 0,
  sel1: 0,
  bw: 0,
  bh: 0,
  bwPos: false,
  bhPos: false,
  nMinX: 0,
  nMinY: 0,
  nW: 0,
  nH: 0,
};

/** Fill the module UniformPack scratch for this frame's (sx, sy). Exact port of
 *  `uniformFactor` + `preservePositionMut`'s gesture-global prefix. */
export function fillUniformPack(
  sx: number,
  sy: number,
  handleId: HandleId,
  sel0: number,
  sel1: number,
  sel2: number,
  sel3: number,
  ox: number,
  oy: number,
): UniformPack {
  const uf = uniformFactor(sx, sy, handleId);
  const bw = sel2 - sel0;
  const bh = sel3 - sel1;
  const c1x = ox + (sel0 - ox) * uf;
  const c1y = oy + (sel1 - oy) * uf;
  const c2x = ox + (sel2 - ox) * uf;
  const c2y = oy + (sel3 - oy) * uf;
  _pack.uf = uf;
  _pack.af = Math.abs(uf);
  _pack.sel0 = sel0;
  _pack.sel1 = sel1;
  _pack.bw = bw;
  _pack.bh = bh;
  _pack.bwPos = bw > 0;
  _pack.bhPos = bh > 0;
  _pack.nMinX = Math.min(c1x, c2x);
  _pack.nMinY = Math.min(c1y, c2y);
  _pack.nW = Math.abs(c2x - c1x);
  _pack.nH = Math.abs(c2y - c1y);
  return _pack;
}

// ============================================================================
// Kernels
// ============================================================================

/**
 * Rigid offset over [start, end) — translate's single kind-blind loop AND the
 * shared body of scale-edgePin. Old `applyOffset` + its fontSize/scale
 * propagation, branch-free: every lane layout puts "the two coords that move"
 * in aux 0–1 and "scalars that ride along" in aux 2–3.
 */
export function applyOffsetRange(lanes: Float64Array, start: number, end: number, dx: number, dy: number): void {
  for (let gi = start; gi < end; gi++) {
    const b = gi * G_STRIDE;
    lanes[b + 8] = lanes[b] + dx;
    lanes[b + 9] = lanes[b + 1] + dy;
    lanes[b + 10] = lanes[b + 2] + dx;
    lanes[b + 11] = lanes[b + 3] + dy;
    lanes[b + 12] = lanes[b + 4] + dx;
    lanes[b + 13] = lanes[b + 5] + dy;
    lanes[b + 14] = lanes[b + 6];
    lanes[b + 15] = lanes[b + 7];
  }
}

/** Scale-edgePin over [start, end): per-entry per-axis delta via
 *  `edgePinPosition1D` (old `edgePinDelta`), then the offset writes. */
export function applyEdgePinRange(
  lanes: Float64Array,
  start: number,
  end: number,
  ox: number,
  oy: number,
  sx: number,
  sy: number,
  sel0: number,
  sel1: number,
  sel2: number,
  sel3: number,
): void {
  for (let gi = start; gi < end; gi++) {
    const b = gi * G_STRIDE;
    const dx = edgePinPosition1D(lanes[b], lanes[b + 2], ox, sx, sel0, sel2) - lanes[b];
    const dy = edgePinPosition1D(lanes[b + 1], lanes[b + 3], oy, sy, sel1, sel3) - lanes[b + 1];
    lanes[b + 8] = lanes[b] + dx;
    lanes[b + 9] = lanes[b + 1] + dy;
    lanes[b + 10] = lanes[b + 2] + dx;
    lanes[b + 11] = lanes[b + 3] + dy;
    lanes[b + 12] = lanes[b + 4] + dx;
    lanes[b + 13] = lanes[b + 5] + dy;
    lanes[b + 14] = lanes[b + 6];
    lanes[b + 15] = lanes[b + 7];
  }
}

/**
 * Shape/image uniform over [start, end): uniform bbox scale (old
 * `scaleBBoxUniform`), then the padded-frame derive with the max(0)-clamped
 * frame BACK-WRITTEN into oBBox (old `derivePaddedFrame` — the back-write is
 * load-bearing at small scales).
 */
export function applyFrameUniformRange(lanes: Float64Array, start: number, end: number, U: UniformPack): void {
  for (let gi = start; gi < end; gi++) {
    const b = gi * G_STRIDE;
    const fb0 = lanes[b];
    const fb1 = lanes[b + 1];
    const fb2 = lanes[b + 2];
    const fb3 = lanes[b + 3];
    const cx = (fb0 + fb2) / 2;
    const cy = (fb1 + fb3) / 2;
    const tx = U.bwPos ? (cx - U.sel0) / U.bw : 0.5;
    const ty = U.bhPos ? (cy - U.sel1) / U.bh : 0.5;
    const ncx = U.nMinX + tx * U.nW;
    const ncy = U.nMinY + ty * U.nH;
    const w = (fb2 - fb0) * U.af;
    const h = (fb3 - fb1) * U.af;
    const ob0 = ncx - w / 2;
    const ob1 = ncy - h / 2;
    const ob2 = ob0 + w;
    const ob3 = ob1 + h;
    // derivePaddedFrame inline — pads from the FROZEN frame/bbox pair.
    const padL = lanes[b + 4] - fb0;
    const padT = lanes[b + 5] - fb1;
    const oa0 = ob0 + padL;
    const oa1 = ob1 + padT;
    const oa2 = Math.max(0, ob2 - ob0 - 2 * padL);
    const oa3 = Math.max(0, ob3 - ob1 - 2 * padT);
    lanes[b + 12] = oa0;
    lanes[b + 13] = oa1;
    lanes[b + 14] = oa2;
    lanes[b + 15] = oa3;
    lanes[b + 8] = oa0 - padL;
    lanes[b + 9] = oa1 - padT;
    lanes[b + 10] = oa0 + oa2 + padL;
    lanes[b + 11] = oa1 + oa3 + padT;
  }
}

/**
 * Shape nonUniform over [start, end): per-axis edge scale via
 * `reflowLeftWidth` with `minDim = MIN_SHAPE_FRAME_DIM + 2*pad(axis)` (old
 * `scaleBBoxEdges`), then the same padded-frame derive + back-write.
 */
export function applyFrameEdgesRange(
  lanes: Float64Array,
  start: number,
  end: number,
  ox: number,
  oy: number,
  sx: number,
  sy: number,
): void {
  for (let gi = start; gi < end; gi++) {
    const b = gi * G_STRIDE;
    const fb0 = lanes[b];
    const fb1 = lanes[b + 1];
    const fb2 = lanes[b + 2];
    const fb3 = lanes[b + 3];
    const padL = lanes[b + 4] - fb0;
    const padT = lanes[b + 5] - fb1;
    reflowLeftWidth(fb0, fb2 - fb0, ox, sx, MIN_SHAPE_FRAME_DIM + 2 * padL);
    const ob0 = reflowOut[0];
    const w = reflowOut[1];
    reflowLeftWidth(fb1, fb3 - fb1, oy, sy, MIN_SHAPE_FRAME_DIM + 2 * padT);
    const ob1 = reflowOut[0];
    const h = reflowOut[1];
    const ob2 = ob0 + w;
    const ob3 = ob1 + h;
    const oa0 = ob0 + padL;
    const oa1 = ob1 + padT;
    const oa2 = Math.max(0, ob2 - ob0 - 2 * padL);
    const oa3 = Math.max(0, ob3 - ob1 - 2 * padT);
    lanes[b + 12] = oa0;
    lanes[b + 13] = oa1;
    lanes[b + 14] = oa2;
    lanes[b + 15] = oa3;
    lanes[b + 8] = oa0 - padL;
    lanes[b + 9] = oa1 - padT;
    lanes[b + 10] = oa0 + oa2 + padL;
    lanes[b + 11] = oa1 + oa3 + padT;
  }
}

/**
 * Stroke uniform over [start, end): uniform bbox scale; oAux ←
 * [frozenCx, frozenCy, U.af] (af is ABS — strokes never mirror on flip;
 * old `scaleStrokeBBox` semantics). oAux3 untouched.
 */
export function applyStrokeUniformRange(lanes: Float64Array, start: number, end: number, U: UniformPack): void {
  for (let gi = start; gi < end; gi++) {
    const b = gi * G_STRIDE;
    const fb0 = lanes[b];
    const fb1 = lanes[b + 1];
    const fb2 = lanes[b + 2];
    const fb3 = lanes[b + 3];
    const cx = (fb0 + fb2) / 2;
    const cy = (fb1 + fb3) / 2;
    const tx = U.bwPos ? (cx - U.sel0) / U.bw : 0.5;
    const ty = U.bhPos ? (cy - U.sel1) / U.bh : 0.5;
    const ncx = U.nMinX + tx * U.nW;
    const ncy = U.nMinY + ty * U.nH;
    const w = (fb2 - fb0) * U.af;
    const h = (fb3 - fb1) * U.af;
    const ob0 = ncx - w / 2;
    const ob1 = ncy - h / 2;
    lanes[b + 8] = ob0;
    lanes[b + 9] = ob1;
    lanes[b + 10] = ob0 + w;
    lanes[b + 11] = ob1 + h;
    lanes[b + 12] = cx;
    lanes[b + 13] = cy;
    lanes[b + 14] = U.af;
  }
}

/**
 * Text/code/note/bookmark uniform over [start, end): uniform bbox scale with
 * af; inline roundProp (`r = round(prop·af·1000)/1000; ef = r/prop`); origin
 * reprojects with **ef** (not af); aux3 rides `· ef` (NaN flows for text
 * 'auto'; note/bkmk lane is 0·ef = 0, unread). Old `scaleBBoxOriginProp` +
 * `scaleOriginFontSize`/`scaleOriginScale`.
 */
export function applyOriginUniformRange(lanes: Float64Array, start: number, end: number, U: UniformPack): void {
  for (let gi = start; gi < end; gi++) {
    const b = gi * G_STRIDE;
    const fb0 = lanes[b];
    const fb1 = lanes[b + 1];
    const fb2 = lanes[b + 2];
    const fb3 = lanes[b + 3];
    const cx = (fb0 + fb2) / 2;
    const cy = (fb1 + fb3) / 2;
    const tx = U.bwPos ? (cx - U.sel0) / U.bw : 0.5;
    const ty = U.bhPos ? (cy - U.sel1) / U.bh : 0.5;
    const ncx = U.nMinX + tx * U.nW;
    const ncy = U.nMinY + ty * U.nH;
    const w = (fb2 - fb0) * U.af;
    const h = (fb3 - fb1) * U.af;
    const ob0 = ncx - w / 2;
    const ob1 = ncy - h / 2;
    lanes[b + 8] = ob0;
    lanes[b + 9] = ob1;
    lanes[b + 10] = ob0 + w;
    lanes[b + 11] = ob1 + h;
    const prop = lanes[b + 6];
    const r = Math.round(prop * U.af * 1000) / 1000;
    const ef = r / prop;
    lanes[b + 12] = ob0 + (lanes[b + 4] - fb0) * ef;
    lanes[b + 13] = ob1 + (lanes[b + 5] - fb1) * ef;
    lanes[b + 14] = r;
    lanes[b + 15] = lanes[b + 7] * ef;
  }
}

// ============================================================================
// Reflow edge math (shared by FRAME_EDGES above + the reflow arms in transform.ts)
// ============================================================================

/** 2-slot output scratch for `reflowLeftWidth`: [newLeft, targetWidth]. */
export const reflowOut = new Float64Array(2);

/**
 * Edge-scaling + min-width clamp — exact port of old `computeReflowWidth`,
 * tuple-free. ⚠ The signature takes (fx, fw) and computes
 * `scaleAround(fx + fw, …)` — reconstructing `fx + fw` is NOT always bit-equal
 * to using maxX directly; the selftest asserts exact float equality. Preserve
 * the operation order.
 */
export function reflowLeftWidth(fx: number, fw: number, originX: number, sx: number, minW: number): void {
  const l = scaleAround(fx, originX, sx);
  const r = scaleAround(fx + fw, originX, sx);
  const left = Math.min(l, r),
    right = Math.max(l, r);
  const raw = right - left;
  const target = Math.max(minW, raw);
  if (target <= raw) {
    reflowOut[0] = left;
    reflowOut[1] = target;
    return;
  }
  reflowOut[0] = Math.abs(left - originX) <= Math.abs(right - originX) ? left : right - target;
  reflowOut[1] = target;
}
