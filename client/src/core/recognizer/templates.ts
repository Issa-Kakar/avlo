/**
 * $P template library — built once at module load with FIXED aspect ratios
 * (paper-faithful: discrimination on geometry, not on input self-similarity).
 *
 * Storage: ONE packed `Float64Array(NUM_TEMPLATES * 2 * N)` for cache locality
 * during the inner cloud-distance loop. Per-template metadata in parallel
 * arrays (kind code + id string).
 *
 * INVARIANT: templates are frozen for process lifetime after the first
 * `getTemplates()` call. `recognize()` reads only.
 */

import { BOX, CIRCLE, DIAMOND, KIND_FOR_CODE, LINE, PDOLLAR_CONFIG, TEMPLATE_RATIOS } from './constants';
import { normalizeInto } from './normalize';

const N = PDOLLAR_CONFIG.NUM_POINTS;
const STRIDE = 2 * N;

/** Total = 1 circle + 23 box + 11 diamond + 5 line. */
const TEMPLATE_COUNT =
  TEMPLATE_RATIOS.circle.length + TEMPLATE_RATIOS.box.length + TEMPLATE_RATIOS.diamond.length + TEMPLATE_RATIOS.line.length;

/** Packed point buffer: template t starts at offset `templateOffset(t)`. */
let TPL: Float64Array | null = null;
const TPL_KIND = new Uint8Array(TEMPLATE_COUNT);
const TPL_IDS = new Array<string>(TEMPLATE_COUNT);

export const NUM_TEMPLATES = TEMPLATE_COUNT;
export const TEMPLATE_STRIDE = STRIDE;

/** Byte offset (in floats) where template `t`'s point data starts in `TPL`. */
export function templateOffset(t: number): number {
  return t * STRIDE;
}

export function getTemplateKind(t: number): number {
  return TPL_KIND[t];
}

export function getTemplateId(t: number): string {
  return TPL_IDS[t];
}

/** Lazy module-load build. Allocates ~19 KB once. */
export function getTemplates(): Float64Array {
  if (TPL) return TPL;
  const buf = new Float64Array(TEMPLATE_COUNT * STRIDE);
  buildTemplates(buf);
  TPL = buf;
  return buf;
}

// =============================================================================
// CONSTRUCTION (cold path, runs once)
// =============================================================================

/** A scratch large enough to hold the longest raw vertex polyline (circle = 65). */
const RAW_SCRATCH = new Float64Array(2 * 128);

function buildTemplates(buf: Float64Array): void {
  let t = 0;

  // Circle: 1 template
  for (const ratio of TEMPLATE_RATIOS.circle) {
    const count = circlePolylineInto(RAW_SCRATCH, 64);
    normalizeInto(RAW_SCRATCH, count, buf.subarray(templateOffset(t), templateOffset(t) + STRIDE), N);
    TPL_KIND[t] = CIRCLE;
    TPL_IDS[t] = `circle/closed@${ratio.toFixed(2)}`;
    t++;
  }

  // Boxes
  for (const ratio of TEMPLATE_RATIOS.box) {
    const { w, h } = aspectToWH(ratio);
    const count = closedRectInto(RAW_SCRATCH, w, h);
    normalizeInto(RAW_SCRATCH, count, buf.subarray(templateOffset(t), templateOffset(t) + STRIDE), N);
    TPL_KIND[t] = BOX;
    TPL_IDS[t] = `box/closed@${ratio.toFixed(2)}`;
    t++;
  }

  // Diamonds
  for (const ratio of TEMPLATE_RATIOS.diamond) {
    const { w, h } = aspectToWH(ratio);
    const count = closedDiamondInto(RAW_SCRATCH, w, h);
    normalizeInto(RAW_SCRATCH, count, buf.subarray(templateOffset(t), templateOffset(t) + STRIDE), N);
    TPL_KIND[t] = DIAMOND;
    TPL_IDS[t] = `diamond/closed@${ratio.toFixed(2)}`;
    t++;
  }

  // Lines
  for (const ratio of TEMPLATE_RATIOS.line) {
    const { w, h } = aspectToWH(ratio);
    if (ratio > 1) {
      RAW_SCRATCH[0] = -w / 2;
      RAW_SCRATCH[1] = 0;
      RAW_SCRATCH[2] = w / 2;
      RAW_SCRATCH[3] = 0;
    } else {
      RAW_SCRATCH[0] = 0;
      RAW_SCRATCH[1] = -h / 2;
      RAW_SCRATCH[2] = 0;
      RAW_SCRATCH[3] = h / 2;
    }
    normalizeInto(RAW_SCRATCH, 2, buf.subarray(templateOffset(t), templateOffset(t) + STRIDE), N);
    TPL_KIND[t] = LINE;
    TPL_IDS[t] = `line/straight@${ratio.toFixed(2)}`;
    t++;
  }
}

/** Closed polyline approximating a unit circle. Returns point count (segments + 1). */
function circlePolylineInto(out: Float64Array, segments: number): number {
  for (let i = 0; i < segments; i++) {
    const a = (2 * Math.PI * i) / segments;
    out[2 * i] = Math.cos(a);
    out[2 * i + 1] = Math.sin(a);
  }
  out[2 * segments] = out[0];
  out[2 * segments + 1] = out[1];
  return segments + 1;
}

/** TL → TR → BR → BL → TL = 5 points (closed). */
function closedRectInto(out: Float64Array, w: number, h: number): number {
  const hw = w / 2;
  const hh = h / 2;
  out[0] = -hw;
  out[1] = -hh;
  out[2] = hw;
  out[3] = -hh;
  out[4] = hw;
  out[5] = hh;
  out[6] = -hw;
  out[7] = hh;
  out[8] = -hw;
  out[9] = -hh;
  return 5;
}

/** top → right → bottom → left → top = 5 points (closed). */
function closedDiamondInto(out: Float64Array, w: number, h: number): number {
  const hw = w / 2;
  const hh = h / 2;
  out[0] = 0;
  out[1] = -hh;
  out[2] = hw;
  out[3] = 0;
  out[4] = 0;
  out[5] = hh;
  out[6] = -hw;
  out[7] = 0;
  out[8] = 0;
  out[9] = -hh;
  return 5;
}

function aspectToWH(aspect: number): { w: number; h: number } {
  const a = aspect > 1e-6 ? aspect : 1e-6;
  return a >= 1 ? { w: 1, h: 1 / a } : { w: a, h: 1 };
}

// Re-export for symmetry; `KIND_FOR_CODE` is the public mapping consumers use.
export { KIND_FOR_CODE };
