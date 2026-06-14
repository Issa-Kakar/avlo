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
import { FONT_FAMILIES, FONT_WEIGHTS } from './font-config';
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

/** Pre-build the four (bold × italic) font strings for a given (fontSize, fontFamily). */
export function buildFontMatrix(fontSize: number, fontFamily: FontFamily): readonly [string, string, string, string] {
  return [
    buildFontString(false, false, fontSize, fontFamily),
    buildFontString(false, true, fontSize, fontFamily),
    buildFontString(true, false, fontSize, fontFamily),
    buildFontString(true, true, fontSize, fontFamily),
  ] as const;
}

export function fontFromMatrix(F: readonly [string, string, string, string], bold: boolean, italic: boolean): string {
  return F[(bold ? 2 : 0) | (italic ? 1 : 0)];
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

export function resetFontMetrics(): void {
  _measuredAscentRatio.clear();
  _measuredDescentRatio.clear();
  _baselineToTopRatio.clear();
  _minCharWidthRatio.clear();
  _italicPadFactor = null;
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
  // Cheap path: clear the whole table on cap. CHAR_ENDS_CACHE and SPACE_WIDTH_CACHE
  // are independent — they cache typed arrays / single floats and don't depend on this LRU.
  MEASURE_BY_FONT.clear();
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

/** Full teardown of every measurement cache — called by `TextLayoutCache.clear()`
 *  on room switch / rebuild. `softEvictMeasure` is the cap-triggered partial sibling. */
export function clearMeasurementCaches(): void {
  MEASURE_BY_FONT.clear();
  measureEntryCount = 0;
  SPACE_WIDTH_CACHE.clear();
  CHAR_ENDS_CACHE.clear();
}
