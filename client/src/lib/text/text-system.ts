/**
 * TEXT LAYOUT SYSTEM
 *
 * Three-stage pipeline: Tokenize → Measure → Layout
 *
 *   Y.XmlFragment
 *       ↓ parseAndTokenize()
 *   TokenizedContent                        §3
 *       ↓ measureTokenizedContent()
 *   MeasuredContent                         §4
 *       ↓ layoutMeasuredContent()
 *   TextLayout                              §5
 *       ↓
 *   renderTextLayout()   canvas output  ┐
 *   computeTextBBox()    spatial index  ┘   §7
 *
 * TextLayoutCache (§6) orchestrates all three stages with three-tier invalidation:
 *   content change  → re-tokenize + re-measure + re-layout
 *   fontSize change → re-measure + re-layout
 *   width change    → re-layout only
 */

import * as Y from 'yjs';
import type {
  BBoxTuple,
  FrameTuple,
  NoteProps,
  TextProps,
  TextAlign,
  TextAlignV,
  TextWidth,
  FontFamily,
} from '@avlo/shared';

import { areFontsLoaded } from './font-loader';
import { FONT_WEIGHTS, FONT_FAMILIES } from './font-config';

export { FONT_WEIGHTS, FONT_FAMILIES } from './font-config';
export type { FontFamilyConfig } from './font-config';
export type { TextAlign, TextAlignV, TextWidth, TextProps, FontFamily } from '@avlo/shared';

// =============================================================================
// STICKY NOTE CONSTANTS & HELPERS
// =============================================================================

export const NOTE_WIDTH = 280;
export const NOTE_FILL_COLOR = '#FEF3AC';
const NOTE_PADDING_RATIO = 12 / 280;
const NOTE_CORNER_RADIUS_RATIO = 0.011;
const NOTE_SHADOW_PAD_RATIO = 0.15;

export function getNotePadding(scale: number): number {
  return NOTE_WIDTH * scale * NOTE_PADDING_RATIO;
}

export function getNoteCornerRadius(scale: number): number {
  return NOTE_WIDTH * scale * NOTE_CORNER_RADIUS_RATIO;
}

export function getNoteContentWidth(scale: number): number {
  return NOTE_WIDTH * scale * (1 - 2 * NOTE_PADDING_RATIO);
}

/** Vertical offset for note content alignment (matches CSS clamp behavior). */
export function getNoteContentOffsetY(
  alignV: TextAlignV,
  maxContentH: number,
  contentH: number,
): number {
  if (alignV === 'top') return 0;
  const space = Math.max(0, maxContentH - contentH);
  return alignV === 'middle' ? space / 2 : space;
}

// --- Auto font size ---

export const NOTE_FONT_STEPS: number[] = [
  72, 64, 56, 48, 44, 40, 36, 34, 32, 30, 28, 26, 24, 22, 20,
  18, 16, 15, 14, 13, 12, 11, 10, 9, 8,
];
const NOTE_PHASE1_FLOOR = 18;

// =============================================================================
// §1  TYPES — Pipeline data model
// =============================================================================

// --- Stage 1 output: Tokenized ---

interface StyledText {
  text: string;
  bold: boolean;
  italic: boolean;
  highlight: string | null;
}

type TokenKind = 'word' | 'space';

interface TokenBase<S extends StyledText> {
  kind: TokenKind;
  segments: S[];
}

type Token = TokenBase<StyledText>;
interface TokenizedParagraph {
  tokens: Token[];
}
export interface UniformStyles {
  allBold: boolean;
  allItalic: boolean;
  uniformHighlight: string | null; // color if uniform, null if none/mixed
}

interface TokenizedContent {
  paragraphs: TokenizedParagraph[];
  uniformStyles: UniformStyles;
}

// --- Stage 2 output: Measured ---

interface MeasuredSegment extends StyledText {
  font: string;
  advanceWidth: number;
  isWhitespace: boolean;
}

interface MeasuredToken extends TokenBase<MeasuredSegment> {
  advanceWidth: number;
}

interface MeasuredParagraph {
  tokens: MeasuredToken[];
}
interface MeasuredContent {
  paragraphs: MeasuredParagraph[];
  lineHeight: number;
  fontFamily: FontFamily;
}

// --- Stage 3 output: Layout (exported — consumed by renderer, objects.ts) ---

export interface MeasuredRun {
  text: string;
  font: string;
  highlight: string | null;
  advanceWidth: number;
  advanceX: number;
}

export interface MeasuredLine {
  runs: MeasuredRun[];
  index: number;
  advanceWidth: number; // Total advance including trailing whitespace runs
  alignmentWidth: number; // Width used for text-align offset calculation (two behaviors):
  //   Wrap-caused line break → b.visualWidth (trailing ws hangs, excluded from alignment)
  //   Paragraph end          → min(advanceWidth, maxWidth) (trailing ws is content, shifts text)
  baselineY: number;
}

export interface TextLayout {
  lines: MeasuredLine[];
  fontSize: number;
  fontFamily: FontFamily;
  lineHeight: number;
  widthMode: 'auto' | 'fixed';
  boxWidth: number;
}

// =============================================================================
// §2  INFRASTRUCTURE — Shared utilities
// =============================================================================

// --- LRU cache ---

class LRU<K, V> {
  private map = new Map<K, V>();
  constructor(private capacity: number) {}
  get(key: K): V | undefined {
    const val = this.map.get(key);
    if (val === undefined) return undefined;
    // Move to end (most recently used)
    this.map.delete(key);
    this.map.set(key, val);
    return val;
  }
  set(key: K, val: V): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, val);
    if (this.map.size > this.capacity) {
      // Delete oldest (first entry)
      this.map.delete(this.map.keys().next().value!);
    }
  }
  clear(): void {
    this.map.clear();
  }
}

// --- Measurement context (singleton offscreen canvas) ---

let measureCtx: CanvasRenderingContext2D | null = null;

function getMeasureContext(): CanvasRenderingContext2D {
  if (!measureCtx) {
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Failed to create measurement context');
    measureCtx = ctx;
  }
  return measureCtx;
}

// --- Font string builder ---

export function buildFontString(
  bold: boolean,
  italic: boolean,
  fontSize: number,
  fontFamily: FontFamily = 'Grandstander',
): string {
  const weight = bold ? FONT_WEIGHTS.bold : FONT_WEIGHTS.normal;
  const style = italic ? 'italic' : 'normal';
  return `${style} ${weight} ${fontSize}px ${FONT_FAMILIES[fontFamily].fallback}`;
}

// --- Font metrics (measured, not approximated) ---

const _measuredAscentRatio = new Map<FontFamily, number>();
const _measuredDescentRatio = new Map<FontFamily, number>();
const _baselineToTopRatio = new Map<FontFamily, number>();
const _minCharWidthRatio = new Map<FontFamily, number>();

/** Generic fallbacks (used if fonts not loaded yet) */
const FALLBACK_ASCENT_RATIO = 0.8;
const FALLBACK_DESCENT_RATIO = 0.2;

/**
 * Get the actual font ascent ratio by measuring with canvas.
 * Uses fontBoundingBoxAscent which is the same metric CSS uses.
 * Cached per font family.
 */
export function getMeasuredAscentRatio(fontFamily: FontFamily = 'Grandstander'): number {
  const cached = _measuredAscentRatio.get(fontFamily);
  if (cached !== undefined) return cached;

  if (!areFontsLoaded()) {
    console.warn(
      '[text-system] getMeasuredAscentRatio called before fonts loaded! Using fallback.',
    );
    return FALLBACK_ASCENT_RATIO;
  }

  const ctx = getMeasureContext();
  const testSize = 100;
  ctx.font = buildFontString(false, false, testSize, fontFamily);
  const metrics = ctx.measureText('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz');

  const ascent = metrics.fontBoundingBoxAscent;

  const ratio = ascent / testSize;

  _measuredAscentRatio.set(fontFamily, ratio);
  return ratio;
}

/**
 * Get the actual font descent ratio by measuring with canvas.
 * Uses fontBoundingBoxDescent which is the same metric CSS uses.
 * Cached per font family. Triggers full measurement via getBaselineToTopRatio.
 */
export function getMeasuredDescentRatio(fontFamily: FontFamily = 'Grandstander'): number {
  const cached = _measuredDescentRatio.get(fontFamily);
  if (cached !== undefined) return cached;
  if (!areFontsLoaded()) return FALLBACK_DESCENT_RATIO;
  getBaselineToTopRatio(fontFamily); // side-populates descent cache
  return _measuredDescentRatio.get(fontFamily) ?? FALLBACK_DESCENT_RATIO;
}

/**
 * Get the offset from baseline to DOM container top (as ratio of fontSize).
 * CSS half-leading formula: halfLeading = (lineHeight - contentArea) / 2
 * where contentArea = fontBoundingBoxAscent + fontBoundingBoxDescent (can differ from fontSize).
 * Result = (halfLeading + fontBoundingBoxAscent) / fontSize
 */
export function getBaselineToTopRatio(fontFamily: FontFamily = 'Grandstander'): number {
  const cached = _baselineToTopRatio.get(fontFamily);
  if (cached !== undefined) return cached;

  const { lineHeightMultiplier } = FONT_FAMILIES[fontFamily];
  if (!areFontsLoaded()) {
    return (lineHeightMultiplier - 1) / 2 + FALLBACK_ASCENT_RATIO;
  }

  const ctx = getMeasureContext();
  const testSize = 100;
  ctx.font = buildFontString(false, false, testSize, fontFamily);
  const m = ctx.measureText('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz');

  const ascent = m.fontBoundingBoxAscent;
  const contentArea = ascent + m.fontBoundingBoxDescent;
  const lineHeight = testSize * lineHeightMultiplier;
  const ratio = ((lineHeight - contentArea) / 2 + ascent) / testSize;

  // Side-populate ascent + descent ratio caches (avoids duplicate measurement)
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
  ctx.font = buildFontString(true, false, 100, fontFamily);
  const ratio = ctx.measureText('W').width / 100;
  _minCharWidthRatio.set(fontFamily, ratio);
  return ratio;
}

export function getMinCharWidth(fontSize: number, fontFamily: FontFamily = 'Grandstander'): number {
  return getMinCharWidthRatio(fontFamily) * fontSize;
}

/**
 * Reset cached font metrics. Call after fonts finish loading.
 */
export function resetFontMetrics(): void {
  _measuredAscentRatio.clear();
  _measuredDescentRatio.clear();
  _baselineToTopRatio.clear();
  _minCharWidthRatio.clear();
}

// --- Measurement caches ---

const MEASURE_LRU = new LRU<string, number>(75_000);
const SPACE_WIDTH_CACHE = new Map<string, number>();

function measureTextCached(font: string, text: string): number {
  const key = font + '\0' + text;
  const hit = MEASURE_LRU.get(key);
  if (hit !== undefined) return hit;
  const ctx = getMeasureContext();
  ctx.font = font;
  const w = ctx.measureText(text).width;
  MEASURE_LRU.set(key, w);
  return w;
}

function getSpaceWidth(font: string): number {
  let w = SPACE_WIDTH_CACHE.get(font);
  if (w !== undefined) return w;
  w = measureTextCached(font, ' ');
  SPACE_WIDTH_CACHE.set(font, w);
  return w;
}

// --- Grapheme segmentation ---

const GRAPHEME_LRU = new LRU<string, string[]>(10_000);

function getGraphemes(text: string): string[] {
  const hit = GRAPHEME_LRU.get(text);
  if (hit) return hit;
  let out: string[];
  if (typeof Intl !== 'undefined' && 'Segmenter' in Intl) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const seg = new (Intl as any).Segmenter(undefined, { granularity: 'grapheme' });
    out = Array.from(seg.segment(text), (x: { segment: string }) => x.segment);
  } else {
    out = Array.from(text);
  }
  GRAPHEME_LRU.set(text, out);
  return out;
}

// =============================================================================
// §3  STAGE 1: TOKENIZE — Y.XmlFragment → TokenizedContent
// =============================================================================

function pushSegment(
  tokens: Token[],
  kind: TokenKind,
  text: string,
  bold: boolean,
  italic: boolean,
  highlight: string | null,
): void {
  if (!text) return;
  const last = tokens[tokens.length - 1];
  if (last && last.kind === kind) {
    const lastSeg = last.segments[last.segments.length - 1];
    if (
      lastSeg &&
      lastSeg.bold === bold &&
      lastSeg.italic === italic &&
      lastSeg.highlight === highlight
    ) {
      lastSeg.text += text; // string concat, no object allocated
      return;
    }
    last.segments.push({ text, bold, italic, highlight });
    return;
  }
  tokens.push({ kind, segments: [{ text, bold, italic, highlight }] });
}

function parseAndTokenize(fragment: Y.XmlFragment): TokenizedContent {
  const paragraphs: TokenizedParagraph[] = [];
  const children = fragment.toArray();

  // Uniform style tracking — piggybacks on delta loop
  let trackBold = true,
    trackItalic = true;
  let hlColor: string | null | false = null; // null=unseen, false=mixed
  let hasAnyText = false;

  if (children.length === 0) {
    paragraphs.push({ tokens: [] });
  } else {
    for (const child of children) {
      if (!(child instanceof Y.XmlElement) || child.nodeName !== 'paragraph') continue;
      const tokens: Token[] = [];
      for (const textNode of child.toArray()) {
        if (!(textNode instanceof Y.XmlText)) continue;
        for (const op of textNode.toDelta()) {
          if (typeof op.insert !== 'string') continue;
          const attrs = op.attributes || {};
          const bold = !!attrs.bold;
          const italic = !!attrs.italic;
          const hlAttr = attrs.highlight;
          const highlight: string | null =
            hlAttr != null
              ? typeof hlAttr === 'object' && (hlAttr as Record<string, unknown>).color
                ? String((hlAttr as Record<string, unknown>).color)
                : '#ffd43b'
              : null;

          // Accumulate uniform style info (before tokenization, zero extra iteration)
          if (op.insert.length > 0) {
            hasAnyText = true;
            if (trackBold && !bold) trackBold = false;
            if (trackItalic && !italic) trackItalic = false;
            if (hlColor !== false) {
              if (hlColor === null) hlColor = highlight;
              else if (hlColor !== highlight) hlColor = false;
            }
          }

          // Inline tokenization — regex splits into whitespace/non-whitespace chunks
          const re = /(\s+|\S+)/g;
          let m: RegExpExecArray | null;
          while ((m = re.exec(op.insert)) !== null) {
            pushSegment(
              tokens,
              /^\s+$/.test(m[0]) ? 'space' : 'word',
              m[0],
              bold,
              italic,
              highlight,
            );
          }
        }
      }
      paragraphs.push({ tokens });
    }
  }

  if (paragraphs.length === 0) {
    paragraphs.push({ tokens: [] });
  }
  return {
    paragraphs,
    uniformStyles: {
      allBold: hasAnyText && trackBold,
      allItalic: hasAnyText && trackItalic,
      uniformHighlight: hasAnyText && typeof hlColor === 'string' ? hlColor : null,
    },
  };
}

// =============================================================================
// §4  STAGE 2: MEASURE — TokenizedContent → MeasuredContent
// =============================================================================

function measureSeg(font: string, text: string, isWs: boolean): number {
  if (isWs && /^ +$/.test(text)) return getSpaceWidth(font) * text.length;
  return measureTextCached(font, text);
}

function measureTokenizedContent(
  content: TokenizedContent,
  fontSize: number,
  fontFamily: FontFamily = 'Grandstander',
): MeasuredContent {
  const lineHeight = fontSize * FONT_FAMILIES[fontFamily].lineHeightMultiplier;
  const paragraphs: MeasuredParagraph[] = content.paragraphs.map((p) => {
    if (p.tokens.length === 0) return { tokens: [] };
    const tokens: MeasuredToken[] = p.tokens.map((t) => {
      const isWs = t.kind === 'space';
      let totalW = 0;
      const segments: MeasuredSegment[] = t.segments.map((s) => {
        const font = buildFontString(s.bold, s.italic, fontSize, fontFamily);
        const w = measureSeg(font, s.text, isWs);
        totalW += w;
        return {
          text: s.text,
          bold: s.bold,
          italic: s.italic,
          highlight: s.highlight,
          font,
          advanceWidth: w,
          isWhitespace: isWs,
        };
      });
      return { kind: t.kind, segments, advanceWidth: totalW };
    });
    return { tokens };
  });
  return { paragraphs, lineHeight, fontFamily };
}

// =============================================================================
// §5  STAGE 3: LAYOUT — MeasuredContent → TextLayout
// =============================================================================

/** Binary search for largest prefix fitting within maxW. Forces >=1 grapheme. */
function sliceTextToFit(
  font: string,
  text: string,
  maxW: number,
): { head: string; tail: string; headW: number } {
  if (!text) return { head: '', tail: '', headW: 0 };
  const fullW = measureTextCached(font, text);
  if (fullW <= maxW) return { head: text, tail: '', headW: fullW };

  const g = getGraphemes(text);
  let lo = 0,
    hi = g.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (measureTextCached(font, g.slice(0, mid).join('')) <= maxW) lo = mid;
    else hi = mid - 1;
  }
  if (lo === 0) lo = 1; // guarantee forward progress

  const head = g.slice(0, lo).join('');
  const tail = g.slice(lo).join('');
  return { head, tail, headW: measureTextCached(font, head) };
}

interface LineBuilder {
  runs: MeasuredRun[];
  advanceX: number; // total advance including all committed runs
  visualWidth: number; // advance up to end of last non-whitespace run
  hasInk: boolean; // at least one non-whitespace run
}

function newLineBuilder(): LineBuilder {
  return { runs: [], advanceX: 0, visualWidth: 0, hasInk: false };
}

function appendRun(b: LineBuilder, seg: MeasuredSegment, text: string, w: number): void {
  if (!text) return;
  const prev = b.runs[b.runs.length - 1];
  if (prev && prev.font === seg.font && prev.highlight === seg.highlight) {
    prev.text += text;
    prev.advanceWidth += w;
    if (!seg.isWhitespace) {
      b.hasInk = true;
      b.visualWidth = prev.advanceX + prev.advanceWidth;
    }
    b.advanceX += w;
    return;
  }
  b.runs.push({
    text,
    font: seg.font,
    highlight: seg.highlight,
    advanceWidth: w,
    advanceX: b.advanceX,
  });
  if (!seg.isWhitespace) {
    b.hasInk = true;
    b.visualWidth = b.advanceX + w;
  }
  b.advanceX += w;
}

export function layoutMeasuredContent(
  content: MeasuredContent,
  width: TextWidth,
  fontSize: number,
): TextLayout {
  const { lineHeight } = content;
  const isFixed = typeof width === 'number';
  const maxWidth = isFixed ? Math.max(0.01, width) : Infinity;

  const lines: MeasuredLine[] = [];
  let lineIdx = 0;
  let maxAdvanceWidth = 0;

  // --- pushLine: finalize and push a line ---
  // Default alignmentWidth = b.visualWidth (hanging — correct for wrap-caused breaks).
  // Paragraph-end call sites follow with fixupParagraphEnd() to override.
  const pushLine = (b: LineBuilder) => {
    const baselineY = lineIdx * lineHeight;
    lines.push({
      runs: b.runs,
      index: lineIdx,
      advanceWidth: b.advanceX,
      alignmentWidth: b.visualWidth,
      baselineY,
    });
    maxAdvanceWidth = Math.max(maxAdvanceWidth, b.advanceX);
    lineIdx++;
  };

  // --- Paragraph-end fixup: trailing ws is content, not hanging ---
  // CSS two-behavior model: wrap-caused trailing ws hangs (doesn't shift alignment),
  // but paragraph-end trailing ws IS content (shifts centered/right text).
  // Clamped to maxWidth so overflow ws doesn't produce negative alignment offsets.
  const fixupParagraphEnd = () => {
    const last = lines[lines.length - 1];
    if (last) last.alignmentWidth = Math.min(last.advanceWidth, maxWidth);
  };

  // --- Pending whitespace state ---
  let pendingSegs: MeasuredSegment[] = [];
  let pendingW = 0;
  const clearPending = () => {
    pendingSegs.length = 0;
    pendingW = 0;
  };
  const stashPending = (tok: MeasuredToken) => {
    for (const seg of tok.segments) {
      pendingSegs.push(seg);
      pendingW += seg.advanceWidth;
    }
  };
  const commitPending = (b: LineBuilder) => {
    for (const seg of pendingSegs) appendRun(b, seg, seg.text, seg.advanceWidth);
    clearPending();
  };

  // --- placeWord: place word on line, break-word if oversized ---
  const placeWord = (b: LineBuilder, tok: MeasuredToken): LineBuilder => {
    if (maxWidth === Infinity) {
      for (const seg of tok.segments) appendRun(b, seg, seg.text, seg.advanceWidth);
      return b;
    }
    const remaining = maxWidth - b.advanceX;
    if (tok.advanceWidth <= remaining) {
      for (const seg of tok.segments) appendRun(b, seg, seg.text, seg.advanceWidth);
      return b;
    }
    if (tok.advanceWidth <= maxWidth) {
      if (b.runs.length > 0) {
        pushLine(b);
        b = newLineBuilder();
      }
      for (const seg of tok.segments) appendRun(b, seg, seg.text, seg.advanceWidth);
      return b;
    }
    // break-word path
    if (remaining <= 0 && b.runs.length > 0) {
      pushLine(b);
      b = newLineBuilder();
    }
    for (const seg of tok.segments) {
      let text = seg.text;
      while (text.length > 0) {
        let lineRemaining = maxWidth - b.advanceX;
        if (lineRemaining <= 0) {
          pushLine(b);
          b = newLineBuilder();
          lineRemaining = maxWidth;
        }
        const { head, tail, headW } = sliceTextToFit(seg.font, text, lineRemaining);
        // Forward-progress guarantee can force a grapheme that doesn't fit.
        // On a non-empty line, wrap first and retry with full line width.
        if (headW > lineRemaining && b.runs.length > 0) {
          pushLine(b);
          b = newLineBuilder();
          continue;
        }
        appendRun(b, seg, head, headW);
        text = tail;
        if (text.length > 0) {
          pushLine(b);
          b = newLineBuilder();
        }
      }
    }
    return b;
  };

  // --- MAIN FLOW LOOP ---
  let b = newLineBuilder();
  for (const p of content.paragraphs) {
    if (p.tokens.length === 0) {
      clearPending();
      pushLine(b);
      fixupParagraphEnd();
      b = newLineBuilder();
      continue;
    }
    for (const tok of p.tokens) {
      if (tok.kind === 'space') {
        if (!b.hasInk) {
          // LEADING ws: commit immediately (can overflow — matches pre-wrap)
          for (const seg of tok.segments) appendRun(b, seg, seg.text, seg.advanceWidth);
        } else if (maxWidth === Infinity) {
          // AUTO: no wrapping, commit immediately
          for (const seg of tok.segments) appendRun(b, seg, seg.text, seg.advanceWidth);
        } else {
          // FIXED, inter-word: buffer as pending
          stashPending(tok);
        }
        continue;
      }
      // WORD token
      if (maxWidth === Infinity) {
        if (pendingW > 0) commitPending(b);
        b = placeWord(b, tok);
        continue;
      }
      // FIXED mode word placement
      if (b.hasInk) {
        if (tok.advanceWidth <= maxWidth) {
          if (b.advanceX + pendingW + tok.advanceWidth <= maxWidth) {
            if (pendingW > 0) commitPending(b);
            b = placeWord(b, tok);
          } else {
            commitPending(b);
            pushLine(b);
            b = newLineBuilder();
            b = placeWord(b, tok);
          }
        } else {
          // Oversized word — commit pending if room for any prefix, else hang + wrap
          if (b.advanceX + pendingW < maxWidth) {
            if (pendingW > 0) commitPending(b);
          } else {
            commitPending(b);
            pushLine(b);
            b = newLineBuilder();
          }
          b = placeWord(b, tok);
        }
      } else {
        // No word on line yet (may have leading ws)
        if (b.advanceX > 0 && b.advanceX + tok.advanceWidth > maxWidth) {
          pushLine(b);
          b = newLineBuilder();
        }
        clearPending();
        b = placeWord(b, tok);
      }
    }
    commitPending(b);
    pushLine(b);
    fixupParagraphEnd();
    b = newLineBuilder();
  }
  if (lines.length === 0) pushLine(newLineBuilder());

  // --- Compute layout-level values ---
  const boxWidth = isFixed ? Math.max(0.01, width) : maxAdvanceWidth;

  return {
    lines,
    fontSize,
    fontFamily: content.fontFamily,
    lineHeight,
    widthMode: isFixed ? 'fixed' : 'auto',
    boxWidth,
  };
}

// =============================================================================
// §5b AUTO FONT SIZE — layoutNoteContent (replaces flowCheck + computeNoteAutoSize)
// =============================================================================

/** Base content width at scale=1 (NOTE_WIDTH=280, padding ratio 12/280 each side). */
const BASE_CONTENT_WIDTH = NOTE_WIDTH * (1 - 2 * NOTE_PADDING_RATIO); // 256

/** Find first step index where the word (at 100px) fits on one line. */
function findStepForWord(wordW100: number, contentWidth: number): number {
  const maxStep = (contentWidth * 100) / wordW100;
  for (let i = 0; i < NOTE_FONT_STEPS.length; i++) {
    if (NOTE_FONT_STEPS[i] <= maxStep) return i;
  }
  return NOTE_FONT_STEPS.length; // no step fits
}

/**
 * Inline flow simulation for note auto-sizing.
 * Mirrors layoutMeasuredContent's pending whitespace state machine.
 * Phase 1: words atomic, returns step index of oversized word.
 * Phase 2: char-breaks oversized words via sliceTextToFit.
 * Returns 'fits' | 'heightOverflow' | step index to jump to (phase 1 only).
 */
type NoteFlowResult = 'fits' | 'heightOverflow' | number; // number = jumpToStepIdx

function noteFlowCheck(
  measured: MeasuredContent,
  maxW: number,
  maxLines: number,
  phase2: boolean,
  contentWidth: number,
): NoteFlowResult {
  let lineCount = 0;

  for (const para of measured.paragraphs) {
    if (para.tokens.length === 0) {
      lineCount++;
      if (lineCount > maxLines) return 'heightOverflow';
      continue;
    }

    let curW = 0;
    let hasInk = false;
    let pendingW = 0;

    for (const tok of para.tokens) {
      if (tok.kind === 'space') {
        if (!hasInk) curW += tok.advanceWidth;
        else pendingW += tok.advanceWidth;
        continue;
      }

      const wordW = tok.advanceWidth;

      if (wordW > maxW) {
        if (!phase2) return findStepForWord(wordW, contentWidth);

        // Phase 2: char-break
        if (hasInk) {
          curW += pendingW;
          pendingW = 0;
        }
        for (const seg of tok.segments) {
          let text = seg.text;
          while (text.length > 0) {
            let remaining = maxW - curW;
            if (remaining <= 0) {
              lineCount++;
              if (lineCount > maxLines) return 'heightOverflow';
              curW = 0;
              remaining = maxW;
            }
            const { tail, headW } = sliceTextToFit(seg.font, text, remaining);
            if (headW > remaining && curW > 0) {
              lineCount++;
              if (lineCount > maxLines) return 'heightOverflow';
              curW = 0;
              continue;
            }
            curW += headW;
            text = tail;
            if (text.length > 0) {
              lineCount++;
              if (lineCount > maxLines) return 'heightOverflow';
              curW = 0;
            }
          }
        }
        hasInk = true;
        pendingW = 0;
        continue;
      }

      if (hasInk) {
        const testW = curW + pendingW + wordW;
        if (testW <= maxW) {
          curW = testW;
          pendingW = 0;
        } else {
          lineCount++;
          if (lineCount > maxLines) return 'heightOverflow';
          curW = wordW;
          pendingW = 0;
        }
      } else {
        if (curW > 0 && curW + wordW > maxW) {
          lineCount++;
          if (lineCount > maxLines) return 'heightOverflow';
          curW = wordW;
        } else {
          curW += wordW;
        }
        hasInk = true;
        pendingW = 0;
      }
    }

    lineCount++;
    if (lineCount > maxLines) return 'heightOverflow';
  }

  return 'fits';
}

/**
 * Auto-size note content and produce a TextLayout at base dimensions.
 * Takes MeasuredContent at 100px (ratio strategy). Always works at BASE_CONTENT_WIDTH (256).
 *
 * Phase A: Find optimal font step (two-phase search with lazy per-word stepping).
 * Phase B: Mutate MeasuredContent to derived font size and build layout.
 */
function layoutNoteContent(
  measured: MeasuredContent,
  fontFamily: FontFamily,
): { layout: TextLayout; derivedFontSize: number } {
  const contentWidth = BASE_CONTENT_WIDTH; // 256
  const contentHeight = contentWidth; // square
  const lhMult = FONT_FAMILIES[fontFamily].lineHeightMultiplier;
  const lineH100 = 100 * lhMult;
  const paraCount = Math.max(1, measured.paragraphs.length);

  // ── Phase A: find font step ──

  // Educated starting index
  let startIdx = 0;
  let maxWordW100 = 0;
  for (const p of measured.paragraphs) {
    for (const tok of p.tokens) {
      if (tok.kind === 'word' && tok.advanceWidth > maxWordW100)
        maxWordW100 = tok.advanceWidth;
    }
  }
  if (maxWordW100 > 0) {
    const widthMax = (contentWidth * 100) / maxWordW100;
    const heightMax = contentHeight / (paraCount * lhMult);
    const maxSize = Math.min(widthMax, heightMax);
    for (let i = 0; i < NOTE_FONT_STEPS.length; i++) {
      if (NOTE_FONT_STEPS[i] <= maxSize) {
        startIdx = i;
        break;
      }
    }
  }

  let derivedFontSize = NOTE_FONT_STEPS[NOTE_FONT_STEPS.length - 1]; // fallback: 8

  // Phase 1: no character breaking
  let enterPhase2 = false;
  search: for (let i = startIdx; i < NOTE_FONT_STEPS.length; i++) {
    const step = NOTE_FONT_STEPS[i];
    if (step < NOTE_PHASE1_FLOOR) {
      enterPhase2 = true;
      break;
    }

    const scale = step / 100;
    const maxLines = Math.floor(contentHeight / (lineH100 * scale));
    if (maxLines < 1 || paraCount > maxLines) continue;

    const maxW100 = contentWidth / scale;
    const result = noteFlowCheck(measured, maxW100, maxLines, false, contentWidth);

    if (result === 'fits') {
      derivedFontSize = step;
      break search;
    }
    if (result === 'heightOverflow') continue;

    // result is a step index (from findStepForWord)
    const jumpIdx = result as number;
    if (jumpIdx >= NOTE_FONT_STEPS.length || NOTE_FONT_STEPS[jumpIdx] < NOTE_PHASE1_FLOOR) {
      enterPhase2 = true;
      break;
    }
    i = jumpIdx - 1; // loop will i++ to reach jumpIdx
  }

  // Phase 2: character breaking from top
  if (enterPhase2) {
    for (const step of NOTE_FONT_STEPS) {
      const scale = step / 100;
      const maxLines = Math.floor(contentHeight / (lineH100 * scale));
      if (maxLines < 1 || paraCount > maxLines) continue;
      const maxW100 = contentWidth / scale;
      if (noteFlowCheck(measured, maxW100, maxLines, true, contentWidth) === 'fits') {
        derivedFontSize = step;
        break;
      }
    }
  }

  // ── Phase B: mutate MeasuredContent to derived font size, build layout ──

  const ratio = derivedFontSize / 100;
  for (const para of measured.paragraphs) {
    for (const tok of para.tokens) {
      tok.advanceWidth *= ratio;
      for (const seg of tok.segments) {
        seg.font = buildFontString(seg.bold, seg.italic, derivedFontSize, fontFamily);
        seg.advanceWidth *= ratio;
      }
    }
  }
  measured.lineHeight = derivedFontSize * lhMult;

  const layout = layoutMeasuredContent(measured, contentWidth, derivedFontSize);
  return { layout, derivedFontSize };
}

// =============================================================================
// §6  CACHE — Three-tier orchestration (tokenize → measure → layout)
// =============================================================================

interface CacheEntry {
  tokenized: TokenizedContent | null; // null = content stale
  measured: MeasuredContent;
  measuredFontSize: number | null; // null = fontSize stale
  measuredFontFamily: FontFamily | null; // null = fontFamily stale
  layout: TextLayout;
  layoutWidth: TextWidth | null; // null = width stale
  frame: FrameTuple | null;
  noteDerivedFontSize: number | null; // null = stale; set by getNoteLayout
}

class TextLayoutCache {
  private cache = new Map<string, CacheEntry>();

  /**
   * Get or compute layout for a text object.
   * Three-tier cache: content → measurement → flow.
   */
  getLayout(
    objectId: string,
    fragment: Y.XmlFragment,
    fontSize: number,
    fontFamily: FontFamily = 'Grandstander',
    width: TextWidth = 'auto',
  ): TextLayout {
    const entry = this.cache.get(objectId);

    // Cache hit — same content, fontSize, fontFamily, and width
    if (
      entry &&
      entry.tokenized !== null &&
      entry.measuredFontSize === fontSize &&
      entry.measuredFontFamily === fontFamily &&
      entry.layoutWidth === width
    ) {
      return entry.layout;
    }

    // Width changed only — re-flow
    if (
      entry &&
      entry.tokenized !== null &&
      entry.measuredFontSize === fontSize &&
      entry.measuredFontFamily === fontFamily
    ) {
      const layout = layoutMeasuredContent(entry.measured, width, fontSize);
      entry.layout = layout;
      entry.layoutWidth = width;
      entry.frame = null;
      return layout;
    }

    // Font size or family changed — re-measure + re-flow
    if (entry && entry.tokenized !== null) {
      const measured = measureTokenizedContent(entry.tokenized, fontSize, fontFamily);
      const layout = layoutMeasuredContent(measured, width, fontSize);
      entry.measured = measured;
      entry.measuredFontSize = fontSize;
      entry.measuredFontFamily = fontFamily;
      entry.layout = layout;
      entry.layoutWidth = width;
      entry.frame = null;
      return layout;
    }

    // Full pipeline (no entry or content stale)
    const tokenized = parseAndTokenize(fragment);
    const measured = measureTokenizedContent(tokenized, fontSize, fontFamily);
    const layout = layoutMeasuredContent(measured, width, fontSize);

    if (entry) {
      entry.tokenized = tokenized;
      entry.measured = measured;
      entry.measuredFontSize = fontSize;
      entry.measuredFontFamily = fontFamily;
      entry.layout = layout;
      entry.layoutWidth = width;
      entry.frame = null;
    } else {
      this.cache.set(objectId, {
        tokenized,
        measured,
        measuredFontSize: fontSize,
        measuredFontFamily: fontFamily,
        layout,
        layoutWidth: width,
        frame: null,
        noteDerivedFontSize: null,
      });
    }

    return layout;
  }

  /** Content invalidation — content changed, must re-parse.
   *  When fragment is provided, eagerly re-tokenizes so getInlineStyles()
   *  returns fresh data immediately (critical for shape labels where no
   *  getLayout() call happens before refreshStyles in the observer path).
   *  Always nulls measuredFontSize to force re-measure + re-layout on next getLayout(). */
  invalidateContent(objectId: string, fragment?: Y.XmlFragment): void {
    const e = this.cache.get(objectId);
    if (e) {
      e.tokenized = fragment ? parseAndTokenize(fragment) : null;
      e.measuredFontSize = null;
      e.noteDerivedFontSize = null;
      e.frame = null;
    }
  }

  /** Layout-only invalidation — fontSize changed. */
  invalidateLayout(objectId: string): void {
    const e = this.cache.get(objectId);
    if (e) {
      e.measuredFontSize = null;
      e.frame = null;
    }
  }

  /** Flow invalidation — width changed. */
  invalidateFlow(objectId: string): void {
    const e = this.cache.get(objectId);
    if (e) {
      e.layoutWidth = null;
      e.frame = null;
    }
  }

  /** Remove entry entirely (object deletion). */
  remove(objectId: string): void {
    this.cache.delete(objectId);
  }

  /** Clear entire cache + measurement caches. */
  clear(): void {
    this.cache.clear();
    MEASURE_LRU.clear();
    GRAPHEME_LRU.clear();
    SPACE_WIDTH_CACHE.clear();
  }

  /** Check if object is cached. */
  has(objectId: string): boolean {
    return this.cache.has(objectId);
  }

  /** Set the derived frame for a text object. */
  setFrame(objectId: string, frame: FrameTuple): void {
    const entry = this.cache.get(objectId);
    if (entry) entry.frame = frame;
  }

  /** Get the derived frame for a text object. */
  getFrame(objectId: string): FrameTuple | null {
    return this.cache.get(objectId)?.frame ?? null;
  }

  /** Get cached measured content for reflow during transforms. */
  getMeasuredContent(objectId: string): MeasuredContent | null {
    return this.cache.get(objectId)?.measured ?? null;
  }

  /**
   * Get or compute layout for a note object.
   * Always works at base dimensions (256×256 content area).
   * No fontSize/width params — layout is scale-independent.
   * Two-tier: content valid → re-measure + auto-size; content stale → full pipeline.
   */
  getNoteLayout(
    objectId: string,
    fragment: Y.XmlFragment,
    fontFamily: FontFamily,
  ): TextLayout {
    const entry = this.cache.get(objectId);

    // Cache hit — same content + fontFamily + derived font size computed
    if (
      entry &&
      entry.tokenized !== null &&
      entry.measuredFontFamily === fontFamily &&
      entry.noteDerivedFontSize !== null
    ) {
      return entry.layout;
    }

    // Content valid, fontFamily or derivedFontSize stale → re-measure + auto-size
    if (entry && entry.tokenized !== null) {
      const measured = measureTokenizedContent(entry.tokenized, 100, fontFamily);
      const { layout, derivedFontSize } = layoutNoteContent(measured, fontFamily);
      entry.measured = measured;
      entry.measuredFontFamily = fontFamily;
      entry.layout = layout;
      entry.noteDerivedFontSize = derivedFontSize;
      entry.frame = null;
      return layout;
    }

    // Full pipeline (no entry or content stale)
    const tokenized = parseAndTokenize(fragment);
    const measured = measureTokenizedContent(tokenized, 100, fontFamily);
    const { layout, derivedFontSize } = layoutNoteContent(measured, fontFamily);

    if (entry) {
      entry.tokenized = tokenized;
      entry.measured = measured;
      entry.measuredFontFamily = fontFamily;
      entry.layout = layout;
      entry.noteDerivedFontSize = derivedFontSize;
      entry.frame = null;
    } else {
      this.cache.set(objectId, {
        tokenized,
        measured,
        measuredFontSize: null,
        measuredFontFamily: fontFamily,
        layout,
        layoutWidth: null,
        frame: null,
        noteDerivedFontSize: derivedFontSize,
      });
    }

    return layout;
  }

  /** Get the derived font size for a note from cache. */
  getNoteDerivedFontSize(objectId: string): number {
    return this.cache.get(objectId)?.noteDerivedFontSize ?? NOTE_FONT_STEPS[0];
  }

  /** Get uniform inline styles from cached tokenized content. */
  getInlineStyles(objectId: string): UniformStyles | null {
    return this.cache.get(objectId)?.tokenized?.uniformStyles ?? null;
  }
}

// Singleton instance
export const textLayoutCache = new TextLayoutCache();

// =============================================================================
// §7  OUTPUT — Alignment, rendering, spatial index
// =============================================================================

// --- Alignment helpers ---

/**
 * Returns the anchor factor for alignment:
 * - left: 0 (origin at left edge)
 * - center: 0.5 (origin at center)
 * - right: 1 (origin at right edge)
 */
export function anchorFactor(align: TextAlign): number {
  return align === 'left' ? 0 : align === 'center' ? 0.5 : 1;
}

/** Container left edge in world coords */
function getBoxLeftX(originX: number, boxWidth: number, align: TextAlign): number {
  return originX - anchorFactor(align) * boxWidth;
}

/** Line start X within container */
export function getLineStartX(
  originX: number,
  boxWidth: number,
  lineVisualWidth: number,
  align: TextAlign,
): number {
  const left = getBoxLeftX(originX, boxWidth, align);
  if (align === 'left') return left;
  if (align === 'center') return left + (boxWidth - lineVisualWidth) / 2;
  return left + (boxWidth - lineVisualWidth);
}

// --- Label text box ---

const LABEL_PADDING = 8;
const SQRT2_OVER_2 = Math.SQRT2 / 2;

export function computeLabelTextBox(shapeType: string, frame: FrameTuple): FrameTuple {
  const [fx, fy, fw, fh] = frame;
  const pad = LABEL_PADDING;
  switch (shapeType) {
    case 'ellipse': {
      const iw = fw * SQRT2_OVER_2,
        ih = fh * SQRT2_OVER_2;
      const cx = fx + fw / 2,
        cy = fy + fh / 2;
      return [
        cx - iw / 2 + pad,
        cy - ih / 2 + pad,
        Math.max(0, iw - 2 * pad),
        Math.max(0, ih - 2 * pad),
      ];
    }
    case 'diamond': {
      const iw = fw / 2,
        ih = fh / 2;
      const cx = fx + fw / 2,
        cy = fy + fh / 2;
      return [
        cx - iw / 2 + pad,
        cy - ih / 2 + pad,
        Math.max(0, iw - 2 * pad),
        Math.max(0, ih - 2 * pad),
      ];
    }
    default:
      return [fx + pad, fy + pad, Math.max(0, fw - 2 * pad), Math.max(0, fh - 2 * pad)];
  }
}

// --- Renderer ---

/**
 * Render a text layout to canvas.
 * Origin is the baseline position of the first line.
 * Text ink extends above origin (ascent) and below (descent).
 */
export function renderTextLayout(
  ctx: CanvasRenderingContext2D,
  layout: TextLayout,
  originX: number,
  originY: number,
  color: string,
  align: TextAlign = 'left',
  fillColor?: string,
): void {
  ctx.save();
  ctx.textBaseline = 'alphabetic';

  const { boxWidth, fontSize, fontFamily, lineHeight } = layout;
  const baselineToTop = getBaselineToTopRatio(fontFamily) * fontSize;
  const isFixed = layout.widthMode === 'fixed';
  // Container bounds for fixed-mode overflow clipping (matches CSS overflow:hidden)
  const containerLeft = isFixed ? getBoxLeftX(originX, boxWidth, align) : 0;
  const containerRight = isFixed ? containerLeft + boxWidth : 0;
  // Pass 0: background fill rect
  if (fillColor) {
    const blockLeft = getBoxLeftX(originX, boxWidth, align);
    const blockTop = originY - baselineToTop;
    const blockHeight = layout.lines.length * lineHeight;
    ctx.fillStyle = fillColor;
    ctx.fillRect(blockLeft, blockTop, boxWidth, blockHeight);
  }
  const hlR = fontSize * 0.25;
  for (const line of layout.lines) {
    if (line.runs.length === 0) continue;
    const lineY = originY + line.baselineY;
    // alignmentWidth handles both cases: wrap lines use visualWidth (hanging ws excluded),
    // paragraph-end lines use min(advanceWidth, maxWidth) (trailing ws shifts alignment).
    const lineW = isFixed ? line.alignmentWidth : line.advanceWidth;
    const startX = getLineStartX(originX, boxWidth, lineW, align);
    // Pass 1: highlight rects (rounded corners — matches CSS border-radius: 0.25em)
    for (const run of line.runs) {
      if (!run.highlight) continue;
      ctx.fillStyle = run.highlight;
      const hlX = startX + run.advanceX;
      const hlY = lineY - baselineToTop;
      if (isFixed) {
        const hlEnd = hlX + run.advanceWidth;
        const clL = Math.max(hlX, containerLeft);
        const clR = Math.min(hlEnd, containerRight);
        if (clR > clL) {
          // Clamped sides get flat edge (radius 0) — matches CSS overflow:hidden
          const rL = clL > hlX ? 0 : hlR,
            rR = clR < hlEnd ? 0 : hlR;
          ctx.beginPath();
          ctx.roundRect(clL, hlY, clR - clL, lineHeight, [rL, rR, rR, rL]);
          ctx.fill();
        }
      } else {
        ctx.beginPath();
        ctx.roundRect(hlX, hlY, run.advanceWidth, lineHeight, hlR);
        ctx.fill();
      }
    }
    // Pass 2: text
    ctx.fillStyle = color;
    for (const run of line.runs) {
      ctx.font = run.font;
      ctx.fillText(run.text, startX + run.advanceX, lineY);
    }
  }
  ctx.restore();
}

// --- Shape label renderer ---

export function renderShapeLabel(
  ctx: CanvasRenderingContext2D,
  layout: TextLayout,
  textBox: FrameTuple,
  color: string,
  fontFamily: FontFamily,
): void {
  const [tbx, tby, tbw, tbh] = textBox;
  if (tbw <= 0 || tbh <= 0 || layout.lines.length === 0) return;

  const { fontSize, lineHeight } = layout;
  const contentHeight = layout.lines.length * lineHeight;
  const baselineToTop = fontSize * getBaselineToTopRatio(fontFamily);
  const needsClip = contentHeight > tbh;

  const contentTopY = needsClip ? tby : tby + (tbh - contentHeight) / 2;
  const firstBaselineY = contentTopY + baselineToTop;

  if (needsClip) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(tbx, tby, tbw, tbh);
    ctx.clip();
  }

  ctx.textBaseline = 'alphabetic';
  ctx.textRendering = 'optimizeSpeed';

  const hlR = fontSize * 0.25;
  for (const line of layout.lines) {
    if (line.runs.length === 0) continue;
    const lineY = firstBaselineY + line.baselineY;
    const lineW = line.alignmentWidth;
    const startX = tbx + (tbw - lineW) / 2;

    // Pass 1: highlights
    for (const run of line.runs) {
      if (!run.highlight) continue;
      ctx.fillStyle = run.highlight;
      const hlX = startX + run.advanceX;
      const hlY = lineY - baselineToTop;
      const hlEnd = hlX + run.advanceWidth;
      const clL = Math.max(hlX, tbx);
      const clR = Math.min(hlEnd, tbx + tbw);
      if (clR > clL) {
        const rL = clL > hlX ? 0 : hlR,
          rR = clR < hlEnd ? 0 : hlR;
        ctx.beginPath();
        ctx.roundRect(clL, hlY, clR - clL, lineHeight, [rL, rR, rR, rL]);
        ctx.fill();
      }
    }

    // Pass 2: text
    ctx.fillStyle = color;
    for (const run of line.runs) {
      ctx.font = run.font;
      ctx.fillText(run.text, startX + run.advanceX, lineY);
    }
  }

  if (needsClip) ctx.restore();
}

// =============================================================================
// STICKY NOTE — Shadow, Body Renderer, BBox
// =============================================================================

function getNoteShadowPad(scale: number): number {
  return NOTE_WIDTH * scale * NOTE_SHADOW_PAD_RATIO;
}

// --- 9-Slice Shadow Cache ---

interface ShadowCache {
  canvas: OffscreenCanvas;
  padPx: number;
  rectPx: number;
  dpr: number;
}

let _shadowCache: ShadowCache | null = null;

function ensureShadowCache(): ShadowCache {
  const dpr = window.devicePixelRatio || 1;
  if (_shadowCache && _shadowCache.dpr === dpr) return _shadowCache;

  const padPx = 100,
    rectPx = 80;
  const total = rectPx + 2 * padPx; // 280
  const radius = 5;

  const canvas = new OffscreenCanvas(total * dpr, total * dpr);
  const ctx = canvas.getContext('2d')!;
  ctx.scale(dpr, dpr);
  ctx.fillStyle = '#000';

  // Layer 1: Floor shadow — wide soft Gaussian with large Y offset.
  // The large offset pushes the shadow almost entirely below the body:
  //   bottom: full opacity at edge (shadow rect overlaps body bottom by offsetY)
  //   sides: α/2 at edge, drops with σ=17 → moderate
  //   top: nearly invisible (offset >> σ cancels blur)
  ctx.shadowColor = 'rgba(0,0,0,0.10)';
  ctx.shadowBlur = 34;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 28;
  ctx.beginPath();
  ctx.roundRect(padPx, padPx, rectPx, rectPx, radius);
  ctx.fill();

  // Layer 2: Contact shadow — tight edge definition.
  // Small blur + small offset → adds ~3% to all edges, fades within ~10px.
  // Combines with floor shadow for correct edge opacity without hard lines.
  ctx.shadowColor = 'rgba(0,0,0,0.06)';
  ctx.shadowBlur = 10;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 3;
  ctx.beginPath();
  ctx.roundRect(padPx, padPx, rectPx, rectPx, radius);
  ctx.fill();

  // Punch out body rect — expanded 1px to eliminate anti-aliased fringe
  // between shadow edge and body fill
  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 0;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 0;
  ctx.globalCompositeOperation = 'destination-out';
  ctx.beginPath();
  ctx.roundRect(padPx - 1, padPx - 1, rectPx + 2, rectPx + 2, radius);
  ctx.fill();
  ctx.globalCompositeOperation = 'source-over';

  _shadowCache = { canvas, padPx, rectPx, dpr };
  return _shadowCache;
}

function drawNoteShadow(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
): void {
  const sc = ensureShadowCache();
  const d = sc.dpr;
  const sp = sc.padPx * d;
  const sm = sc.rectPx * d;
  const dp = w * NOTE_SHADOW_PAD_RATIO;
  const src = sc.canvas;

  // TL, TC, TR
  ctx.drawImage(src, 0, 0, sp, sp, x - dp, y - dp, dp, dp);
  ctx.drawImage(src, sp, 0, sm, sp, x, y - dp, w, dp);
  ctx.drawImage(src, sp + sm, 0, sp, sp, x + w, y - dp, dp, dp);
  // ML, MR
  ctx.drawImage(src, 0, sp, sp, sm, x - dp, y, dp, h);
  ctx.drawImage(src, sp + sm, sp, sp, sm, x + w, y, dp, h);
  // BL, BC, BR
  ctx.drawImage(src, 0, sp + sm, sp, sp, x - dp, y + h, dp, dp);
  ctx.drawImage(src, sp, sp + sm, sm, sp, x, y + h, w, dp);
  ctx.drawImage(src, sp + sm, sp + sm, sp, sp, x + w, y + h, dp, dp);
}

// --- Note body renderer ---

export function renderNoteBody(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  fillColor: string,
): void {
  const radius = w * NOTE_CORNER_RADIUS_RATIO;

  drawNoteShadow(ctx, x, y, w, h);

  ctx.fillStyle = fillColor;
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, radius);
  ctx.fill();
}

// --- Spatial index + derived frame ---

/**
 * Compute bounding box for a text object.
 * Used by room-doc-manager for spatial index.
 * Returns frame (logical bounds matching DOM overlay) + padding.
 */
export function computeTextBBox(objectId: string, props: TextProps): BBoxTuple {
  const { content, origin, fontSize, fontFamily, align, width } = props;
  const layout = textLayoutCache.getLayout(objectId, content, fontSize, fontFamily, width);
  const [ox, oy] = origin;
  const padding = 2;
  const fx = getBoxLeftX(ox, layout.boxWidth, align);
  const fy = oy - fontSize * getBaselineToTopRatio(fontFamily);
  const fh = layout.lines.length * layout.lineHeight;
  textLayoutCache.setFrame(objectId, [fx, fy, layout.boxWidth, fh]);
  return [fx - padding, fy - padding, fx + layout.boxWidth + padding, fy + fh + padding];
}

export function computeNoteBBox(objectId: string, props: NoteProps): BBoxTuple {
  const { content, origin, scale, fontFamily } = props;
  const noteW = NOTE_WIDTH * scale;
  // Always square — no height auto-grow
  const frame: FrameTuple = [origin[0], origin[1], noteW, noteW];
  // Populate cache (ensures derivedFontSize available later)
  textLayoutCache.getNoteLayout(objectId, content, fontFamily);
  textLayoutCache.setFrame(objectId, frame);

  const sp = getNoteShadowPad(scale);
  return [frame[0] - sp, frame[1] - sp, frame[0] + noteW + sp, frame[1] + noteW + sp];
}

/**
 * Get the derived frame for a text object from the layout cache.
 * Returns null if the object hasn't been through computeTextBBox yet.
 */
export function getTextFrame(objectId: string): FrameTuple | null {
  return textLayoutCache.getFrame(objectId);
}

/** Get the auto-derived font size for a note from the layout cache. */
export function getNoteDerivedFontSize(objectId: string): number {
  return textLayoutCache.getNoteDerivedFontSize(objectId);
}

/**
 * Get uniform inline styles for a text object from the layout cache.
 * Returns null if the object hasn't been cached yet.
 */
export function getInlineStyles(objectId: string): UniformStyles | null {
  return textLayoutCache.getInlineStyles(objectId);
}
