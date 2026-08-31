/**
 * TEXT MEASUREMENT INFRASTRUCTURE
 *
 * The shared measurement boundary for the whole text stack: the singleton
 * offscreen measure context, font-string builders, per-family font-metric
 * ratios (measured from `fontBoundingBox*`, not hardcoded), and the
 * allocation-free measurement caches (text width, space width, grapheme
 * boundaries).
 *
 * Consumers: text-system (tokenize → measure → layout → bbox), sticky-note,
 * shape-label, bookmark-render, code-system, transform.ts, TextTool.
 * No dependency on text-system — this is a leaf alongside line-break.ts.
 */

import type { FontFamily } from '../accessors';
import { FAMILY_LIST, FONT_FAMILIES, FONT_WEIGHTS } from './font-config';
import { areFontsLoaded } from './font-loader';

// --- Measurement context (singleton offscreen canvas) ---

let measureCtx: CanvasRenderingContext2D | null = null;
let _measureCtxFont = '';

function getMeasureContext(): CanvasRenderingContext2D {
  if (!measureCtx) {
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Failed to create measurement context');
    measureCtx = ctx;
    _measureCtxFont = '';
  }
  return measureCtx;
}

function setMeasureFont(font: string): void {
  if (_measureCtxFont !== font) {
    getMeasureContext().font = font;
    _measureCtxFont = font;
  }
}

// --- Font string builder ---

export function buildFontString(bold: boolean, italic: boolean, fontSize: number, fontFamily: FontFamily = 'Grandstander'): string {
  const weight = bold ? FONT_WEIGHTS.bold : FONT_WEIGHTS.normal;
  const style = italic ? 'italic' : 'normal';
  return `${style} ${weight} ${fontSize}px ${FONT_FAMILIES[fontFamily].fallback}`;
}

// =============================================================================
// FONT INTERN TABLE — lazy, append-only for the room session
// =============================================================================
//
// Every distinct (fontSize, family, bold, italic) combination that is actually
// USED gets one interned index; the font string is built once, on first demand.
// This replaces the old eager `buildFontMatrix`, which allocated all four
// bold×italic strings (plus the tuple) on every measure call whether or not the
// content carried any bold/italic run.
//
// Indices are stored in text-store pool lanes (`segFontIdx`/`runFontIdx`), so
// the table must NOT shrink or reorder mid-session — `resetFontTable()` is
// legal only alongside a full store reset (`textLayoutCache.clear()`).
//
// Key encoding (integer, always a Smi): sizeKey * 16 + famCode * 4 + styleBits,
// where sizeKey = round(fontSize * 1000) (3dp — matches transform commit
// quantization) and styleBits = bold | italic << 1.
//
// Index 0 is reserved as the '' sentinel: `lastFontIdx = 0` in render kernels
// makes the first run of every draw set ctx.font without an extra branch, and
// a zeroed pool lane can never alias a real font.

export const FONT_STRINGS: string[] = [''];
const _fontKeyToIdx = new Map<number, number>();

// Per-font measurement caches keyed by intern index (array load instead of a
// string-keyed Map.get on the outer level). `null` = not yet created.
const _measureByIdx: (Map<string, number> | null)[] = [null];
let _spaceWByIdx = new Float64Array(64).fill(Number.NaN);

export function styleBitsOf(bold: boolean, italic: boolean): number {
  return (bold ? 1 : 0) | (italic ? 2 : 0);
}

export function internFont(fontSize: number, famCode: number, styleBits: number): number {
  const key = ((fontSize * 1000 + 0.5) | 0) * 16 + famCode * 4 + styleBits;
  const hit = _fontKeyToIdx.get(key);
  if (hit !== undefined) return hit;
  const idx = FONT_STRINGS.length;
  FONT_STRINGS[idx] = buildFontString((styleBits & 1) !== 0, (styleBits & 2) !== 0, fontSize, FAMILY_LIST[famCode]);
  _measureByIdx[idx] = null;
  if (idx >= _spaceWByIdx.length) {
    const next = new Float64Array(idx + (idx >> 1) + 16).fill(Number.NaN);
    next.set(_spaceWByIdx);
    _spaceWByIdx = next;
  }
  _fontKeyToIdx.set(key, idx);
  return idx;
}

// --- Per-measure-pass style quad ---
// The four styleBits→fontIdx resolutions for one (fontSize, famCode), filled
// lazily as combos appear. Memoized across calls on the same size/family so
// back-to-back measures of sibling entries skip even the reset.
const _quad = new Int32Array(4).fill(-1);
let _quadSizeKey = -1;
let _quadFam = -1;

export function beginFontQuad(fontSize: number, famCode: number): void {
  const sizeKey = (fontSize * 1000 + 0.5) | 0;
  if (sizeKey === _quadSizeKey && famCode === _quadFam) return;
  _quad[0] = -1;
  _quad[1] = -1;
  _quad[2] = -1;
  _quad[3] = -1;
  _quadSizeKey = sizeKey;
  _quadFam = famCode;
}

export function quadFontIdx(styleBits: number): number {
  let idx = _quad[styleBits];
  if (idx < 0) {
    idx = internFont(_quadSizeKey / 1000, _quadFam, styleBits);
    _quad[styleBits] = idx;
  }
  return idx;
}

export function measureTextByIdx(fontIdx: number, text: string): number {
  let inner = _measureByIdx[fontIdx];
  if (inner !== null) {
    const w = inner.get(text);
    if (w !== undefined) return w;
  } else {
    inner = new Map();
    _measureByIdx[fontIdx] = inner;
  }
  const ctx = getMeasureContext();
  setMeasureFont(FONT_STRINGS[fontIdx]);
  const w = ctx.measureText(text).width;
  inner.set(text, w);
  if (++measureEntryCount > MEASURE_SOFT_CAP) softEvictMeasure();
  return w;
}

export function spaceWidthByIdx(fontIdx: number): number {
  let w = _spaceWByIdx[fontIdx];
  if (Number.isNaN(w)) {
    w = measureTextByIdx(fontIdx, ' ');
    _spaceWByIdx[fontIdx] = w;
  }
  return w;
}

/** Session-level teardown of the intern table. ONLY legal alongside a full
 *  text-store reset — pool lanes hold interned indices. */
export function resetFontTable(): void {
  FONT_STRINGS.length = 1;
  _fontKeyToIdx.clear();
  _measureByIdx.length = 1;
  _measureByIdx[0] = null;
  _spaceWByIdx.fill(Number.NaN);
  _quadSizeKey = -1;
  _quadFam = -1;
}

// --- Font metrics (measured, not approximated) ---

const _measuredAscentRatio = new Map<FontFamily, number>();
const _measuredDescentRatio = new Map<FontFamily, number>();
const _baselineToTopRatio = new Map<FontFamily, number>();
const _minCharWidthRatio = new Map<FontFamily, number>();

const FALLBACK_ASCENT_RATIO = 0.8;
const FALLBACK_DESCENT_RATIO = 0.2;

export function getMeasuredAscentRatio(fontFamily: FontFamily = 'Grandstander'): number {
  const cached = _measuredAscentRatio.get(fontFamily);
  if (cached !== undefined) return cached;

  if (!areFontsLoaded()) {
    console.warn('[text-measure] getMeasuredAscentRatio called before fonts loaded! Using fallback.');
    return FALLBACK_ASCENT_RATIO;
  }

  const ctx = getMeasureContext();
  const testSize = 100;
  const font = buildFontString(false, false, testSize, fontFamily);
  setMeasureFont(font);
  const metrics = ctx.measureText('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz');

  const ratio = metrics.fontBoundingBoxAscent / testSize;
  _measuredAscentRatio.set(fontFamily, ratio);
  return ratio;
}

export function getMeasuredDescentRatio(fontFamily: FontFamily = 'Grandstander'): number {
  const cached = _measuredDescentRatio.get(fontFamily);
  if (cached !== undefined) return cached;
  if (!areFontsLoaded()) return FALLBACK_DESCENT_RATIO;
  getBaselineToTopRatio(fontFamily); // side-populates descent cache
  return _measuredDescentRatio.get(fontFamily) ?? FALLBACK_DESCENT_RATIO;
}

export function getBaselineToTopRatio(fontFamily: FontFamily = 'Grandstander'): number {
  const cached = _baselineToTopRatio.get(fontFamily);
  if (cached !== undefined) return cached;

  const { lineHeightMultiplier } = FONT_FAMILIES[fontFamily];
  if (!areFontsLoaded()) {
    return (lineHeightMultiplier - 1) / 2 + FALLBACK_ASCENT_RATIO;
  }

  const ctx = getMeasureContext();
  const testSize = 100;
  const font = buildFontString(false, false, testSize, fontFamily);
  setMeasureFont(font);
  const m = ctx.measureText('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz');

  const ascent = m.fontBoundingBoxAscent;
  const contentArea = ascent + m.fontBoundingBoxDescent;
  const lineHeight = testSize * lineHeightMultiplier;
  const ratio = ((lineHeight - contentArea) / 2 + ascent) / testSize;

  if (!_measuredAscentRatio.has(fontFamily)) {
    _measuredAscentRatio.set(fontFamily, ascent / testSize);
  }
  if (!_measuredDescentRatio.has(fontFamily)) {
    _measuredDescentRatio.set(fontFamily, m.fontBoundingBoxDescent / testSize);
  }

  _baselineToTopRatio.set(fontFamily, ratio);
  return ratio;
}

// --- Minimum character width (for text reflow clamping) ---

export function getMinCharWidthRatio(fontFamily: FontFamily = 'Grandstander'): number {
  const cached = _minCharWidthRatio.get(fontFamily);
  if (cached !== undefined) return cached;
  if (!areFontsLoaded()) return 0.7;
  const ctx = getMeasureContext();
  const font = buildFontString(true, false, 100, fontFamily);
  setMeasureFont(font);
  const ratio = ctx.measureText('W').width / 100;
  _minCharWidthRatio.set(fontFamily, ratio);
  return ratio;
}

export function getMinCharWidth(fontSize: number, fontFamily: FontFamily = 'Grandstander'): number {
  return getMinCharWidthRatio(fontFamily) * fontSize;
}

const ITALIC_PAD_RATIO = 0.45;
let _italicPadFactor: number | null = null;

export function getItalicOverhangPad(fontSize: number): number {
  if (_italicPadFactor === null) _italicPadFactor = ITALIC_PAD_RATIO * getMinCharWidthRatio('Inter');
  const v = fontSize * _italicPadFactor;
  return v < 2 ? 2 : v;
}

// --- famCode-indexed metric mirrors (NaN = unfilled; the isNaN probe IS the
// cache-hit branch). Filled lazily through the string-keyed getters above so the
// fonts-not-loaded fallback path stays identical; cleared by resetFontMetrics. ---

const _b2tByCode = new Float64Array(4).fill(Number.NaN);

export function getBaselineToTopRatioByCode(famCode: number): number {
  const v = _b2tByCode[famCode];
  if (!Number.isNaN(v)) return v;
  const r = getBaselineToTopRatio(FAMILY_LIST[famCode]);
  _b2tByCode[famCode] = r;
  return r;
}

export function resetFontMetrics(): void {
  _measuredAscentRatio.clear();
  _measuredDescentRatio.clear();
  _baselineToTopRatio.clear();
  _minCharWidthRatio.clear();
  _italicPadFactor = null;
  _b2tByCode.fill(Number.NaN);
}

// =============================================================================
// MEASUREMENT CACHES — Two-level, allocation-free
// =============================================================================

/**
 * Two-level measure cache: outer keyed by font, inner keyed by text.
 * Eliminates per-call concat key allocation; preserves O(1) hit cost.
 */
const MEASURE_BY_FONT = new Map<string, Map<string, number>>();
let measureEntryCount = 0;
const MEASURE_SOFT_CAP = 200_000;

function softEvictMeasure(): void {
  // Cheap path: clear the whole table on cap (string-keyed AND idx-keyed inner
  // maps — both feed measureEntryCount). CHAR_ENDS_CACHE and the space-width
  // caches are independent — typed arrays / single floats, refilled on demand.
  MEASURE_BY_FONT.clear();
  for (let i = 0; i < _measureByIdx.length; i++) _measureByIdx[i] = null;
  measureEntryCount = 0;
}

export function measureTextCached(font: string, text: string): number {
  let inner = MEASURE_BY_FONT.get(font);
  if (inner) {
    const w = inner.get(text);
    if (w !== undefined) return w;
  } else {
    inner = new Map();
    MEASURE_BY_FONT.set(font, inner);
  }
  const ctx = getMeasureContext();
  setMeasureFont(font);
  const w = ctx.measureText(text).width;
  inner.set(text, w);
  if (++measureEntryCount > MEASURE_SOFT_CAP) softEvictMeasure();
  return w;
}

const SPACE_WIDTH_CACHE = new Map<string, number>();

export function getSpaceWidth(font: string): number {
  let w = SPACE_WIDTH_CACHE.get(font);
  if (w !== undefined) return w;
  w = measureTextCached(font, ' ');
  SPACE_WIDTH_CACHE.set(font, w);
  return w;
}

// --- Grapheme boundaries (font-independent) ---

const CHAR_ENDS_CACHE = new Map<string, Uint32Array>();

/** Char-index end-offsets for each grapheme cluster of `text`. `out[0] = 0`,
 *  `out[i+1]` = end of i-th grapheme. Used by `sliceTextToFit` to align cuts on
 *  grapheme boundaries (LB9-correct: never splits CM/ZWJ/ZWNJ/surrogate pairs). */
export function getCharEnds(text: string): Uint32Array {
  const hit = CHAR_ENDS_CACHE.get(text);
  if (hit) return hit;
  // First pass: count graphemes so we can size the typed array exactly. Avoids the
  // intermediate string[] that the old getGraphemes carried just for its length.
  const offsets: number[] = [0];
  let ci = 0;
  if (typeof Intl !== 'undefined' && 'Segmenter' in Intl) {
    const seg = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    for (const { segment } of seg.segment(text)) {
      ci += segment.length;
      offsets.push(ci);
    }
  } else {
    for (const cp of text) {
      ci += cp.length;
      offsets.push(ci);
    }
  }
  const out = new Uint32Array(offsets);
  CHAR_ENDS_CACHE.set(text, out);
  return out;
}

/** Full teardown of every measurement VALUE cache — called by
 *  `textLayoutCache.clear()` on room switch / rebuild. Does NOT touch the font
 *  intern table (`resetFontTable` is its separate, store-coupled teardown);
 *  `softEvictMeasure` is the cap-triggered partial sibling. */
export function clearMeasurementCaches(): void {
  MEASURE_BY_FONT.clear();
  for (let i = 0; i < _measureByIdx.length; i++) _measureByIdx[i] = null;
  measureEntryCount = 0;
  SPACE_WIDTH_CACHE.clear();
  _spaceWByIdx.fill(Number.NaN);
  CHAR_ENDS_CACHE.clear();
}
