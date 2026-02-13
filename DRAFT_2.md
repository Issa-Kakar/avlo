# TEXT-SYSTEM.ts fixed-width wrapping upgrade (DOM `pre-wrap` + `break-word`)

This replaces your current single-line-per-paragraph layout engine in `text-system.ts` with a **four-stage pipeline**:

**parse → tokenize → measure → flow**

…and fixes the core semantic bug from the prior plan: **inter-word spaces must be deferred**, so they **never become leading spaces on the next wrapped line** (DOM `white-space: pre-wrap` behavior), while still influencing the wrap decision. This directly addresses the `"hello␠␠␠␠␠world"` case you called out.  

It also updates everything to your **current tuple-based bbox world** (BBoxTuple/FrameTuple + `expandBBox`) exactly like your current `TEXT-SYS.md` file.  

---

## The contrarian take: what was fundamentally wrong in the earlier flow

**1) Splitting whitespace across lines is `break-spaces`-like, not `pre-wrap`.**
Any algorithm that “fills the line with spaces and pushes remaining spaces onto the next line” is modeling a terminal-style whitespace breaker. For `pre-wrap`, the relevant behavior is: **wrap after the whitespace sequence**, not inside it, when it sits between words. 

**2) “visualWidth is correct” doesn’t matter if token-to-line assignment is wrong.**
Your earlier plan computed alignment width excluding trailing spaces correctly, but the **line membership** was wrong because spaces were committed too early. 

**3) Fixed-width alignment must be box-based, not per-line anchored.**
Auto-width cancels out nicely (your existing `lineStartX(originX, lineWidth, align)` works), but fixed-width requires:
`boxLeft = originX - anchorFactor(align) * boxWidth`, then inline offset per line from `visualWidth`.  

**4) Infinite-loop risk exists only in break-word splitting; solve it at the slicer.**
Guarantee progress by consuming **at least one grapheme** whenever you’re forced to split (even if width is tiny). This file does that.

---

## Replace `lib/text/text-system.ts` with the code below

**This is a full, implementation-ready replacement** that keeps your public API shape intact where possible (`parseYXmlFragment`, `layoutContent`, `textLayoutCache`, `renderTextLayout`, `computeTextBBox`, `getTextFrame`) and adds the missing pieces: wrapping config, tokenizer, measured caches, flow engine, and flow-only invalidation.

```ts
/**
 * TEXT MANAGEMENT SYSTEM (WYSIWYG Canvas Renderer)
 *
 * DOM overlay target:
 *   white-space: pre-wrap;
 *   overflow-wrap: break-word;
 *
 * Key semantic rule ("deferred spaces"):
 * - Leading spaces at start-of-line are committed immediately (indent).
 * - Spaces between words are buffered (pending):
 *     If (lineW + pendingSpacesW + nextWordW) fits -> commit pending + word.
 *     Else -> pending spaces HANG on the current line (not laid out), wrap word.
 *
 * Pipeline:
 *   1) parse    : Y.XmlFragment -> ParsedContent (paragraphs, style runs)
 *   2) tokenize : ParsedContent -> TokenizedContent (word/space/hardBreak tokens)
 *   3) measure  : TokenizedContent + fontSize -> MeasuredContent (token widths)
 *   4) flow     : MeasuredContent + WrapConfig -> TextLayout (wrapped lines)
 */

import * as Y from 'yjs';
import type { BBoxTuple, FrameTuple } from '@avlo/shared';
import { expandBBox } from '@/lib/geometry/bounds';
import { areFontsLoaded } from './font-loader';
import { FONT_CONFIG } from './font-config';

// Re-export for consumers (matches current file)
export { FONT_CONFIG } from './font-config';

// =============================================================================
// TEXT ALIGNMENT HELPERS
// =============================================================================

export type TextAlign = 'left' | 'center' | 'right';

export function anchorFactor(align: TextAlign): number {
  return align === 'left' ? 0 : align === 'center' ? 0.5 : 1;
}

/**
 * Kept for backwards compatibility (auto-width cancels out to this anyway),
 * but fixed-width rendering uses box-based alignment (see getLineStartX()).
 */
export function lineStartX(originX: number, lineWidth: number, align: TextAlign): number {
  if (align === 'left') return originX;
  if (align === 'center') return originX - lineWidth / 2;
  return originX - lineWidth;
}

// =============================================================================
// FONT METRICS (measured, not approximated)
// =============================================================================

let _measuredAscentRatio: number | null = null;

/** Known fallback value for Grandstander (used if fonts not loaded yet) */
const FALLBACK_ASCENT_RATIO = 0.73;

export function getMeasuredAscentRatio(): number {
  if (_measuredAscentRatio !== null) return _measuredAscentRatio;

  // If fonts not loaded, we must NOT cache measurements from fallback fonts as "truth".
  if (!areFontsLoaded()) {
    // eslint-disable-next-line no-console
    console.warn('[text-system] getMeasuredAscentRatio before fonts loaded; using fallback ratio.');
    return FALLBACK_ASCENT_RATIO;
  }

  const ctx = getMeasureContext();
  const testSize = 100;
  ctx.font = buildFontString(false, false, testSize);
  const m = ctx.measureText('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz');

  const ascent = m.fontBoundingBoxAscent;
  const descent = m.fontBoundingBoxDescent;
  const totalHeight = ascent + descent;

  // Some fonts include line-gap inside fontBoundingBox metrics.
  const tolerance = testSize * 0.01;
  if (Math.abs(totalHeight - testSize) < tolerance) {
    _measuredAscentRatio = ascent / testSize;
  } else {
    _measuredAscentRatio = ascent / totalHeight;
  }

  // eslint-disable-next-line no-console
  console.log(`[text-system] Measured ascent ratio: ${_measuredAscentRatio.toFixed(4)}`);
  return _measuredAscentRatio;
}

export function resetFontMetrics(): void {
  _measuredAscentRatio = null;
}

/**
 * Offset from baseline to DOM container top, as ratio of fontSize.
 * baselineToTopRatio = halfLeading + ascentRatio
 */
export function getBaselineToTopRatio(): number {
  const halfLeadingRatio = (FONT_CONFIG.lineHeightMultiplier - 1) / 2;
  return halfLeadingRatio + getMeasuredAscentRatio();
}

// =============================================================================
// FONT STRING BUILDER
// =============================================================================

export function buildFontString(bold: boolean, italic: boolean, fontSize: number): string {
  const weight = bold ? FONT_CONFIG.weightBold : FONT_CONFIG.weightNormal;
  const style = italic ? 'italic' : 'normal';
  return `${style} ${weight} ${fontSize}px ${FONT_CONFIG.fallback}`;
}

// =============================================================================
// WRAP CONFIG
// =============================================================================

export type WidthMode = 'auto' | 'fixed';

export type WrapConfig =
  | { mode: 'auto' }
  | { mode: 'fixed'; width: number };

const AUTO_WRAP: WrapConfig = { mode: 'auto' };

function clampWrapWidth(w: number): number {
  // Avoid divide-by-zero / non-progress edge cases.
  // NOTE: You said width is committed on pointer-up, so no rounding here.
  return Math.max(1e-6, w);
}

// =============================================================================
// PARSED TYPES (from Y.XmlFragment)
// =============================================================================

export interface ParsedRun {
  text: string;
  bold: boolean;
  italic: boolean;
}

export interface ParsedParagraph {
  runs: ParsedRun[];
  isEmpty: boolean;
}

export interface ParsedContent {
  paragraphs: ParsedParagraph[];
  structuralHash: number;
  charCount: number;
}

// =============================================================================
// TOKEN TYPES
// =============================================================================

type TokenKind = 'word' | 'space' | 'hardBreak';

interface TokenSegment {
  text: string;
  bold: boolean;
  italic: boolean;
}

type Token =
  | { kind: 'word' | 'space'; segments: TokenSegment[] }
  | { kind: 'hardBreak' };

interface TokenizedParagraph {
  tokens: Token[];
  isEmpty: boolean;
}

interface TokenizedContent {
  paragraphs: TokenizedParagraph[];
  structuralHash: number;
  charCount: number;
}

// =============================================================================
// MEASURED TYPES
// =============================================================================

interface MeasuredSegment extends TokenSegment {
  font: string;
  advanceWidth: number;
  inkBounds: BBoxTuple;     // [l,t,r,b] relative to baseline at x=0
  isWhitespace: boolean;
}

type MeasuredToken =
  | { kind: 'word' | 'space'; segments: MeasuredSegment[]; advanceWidth: number }
  | { kind: 'hardBreak' };

interface MeasuredParagraph {
  tokens: MeasuredToken[];
  isEmpty: boolean;
}

interface MeasuredContent {
  paragraphs: MeasuredParagraph[];
  structuralHash: number;
  charCount: number;
  fontSize: number;
  lineHeight: number;
}

// Draw runs (these are the fillText calls)
export interface MeasuredRun {
  text: string;
  bold: boolean;
  italic: boolean;
  font: string;
  advanceWidth: number;
  advanceX: number;
  isWhitespace: boolean; // true iff this run contains no ink characters
}

export interface MeasuredLine {
  runs: MeasuredRun[];
  index: number;
  advanceWidth: number;     // advance of laid-out content (no hanging pending spaces)
  visualWidth: number;      // excludes trailing whitespace by construction
  inkBounds: BBoxTuple;     // union of ink in this line, relative to line baseline
  baselineY: number;        // lineIndex * lineHeight
  lineHeight: number;
  isEmpty: boolean;         // no ink on this line
}

export interface TextLayout {
  lines: MeasuredLine[];
  fontSize: number;
  lineHeight: number;

  // Container width used for alignment + derived frame:
  // - auto : max(visualWidth)
  // - fixed: wrap.width
  boxWidth: number;
  widthMode: WidthMode;

  inkBBox: FrameTuple;      // [x,y,w,h] in layout coords (lineStartX=0 basis)
  logicalBBox: FrameTuple;  // [0,0,boxWidth,totalHeight]
  structuralHash: number;
}

// =============================================================================
// MEASUREMENT CONTEXT (singleton canvas for text measurement)
// =============================================================================

let measureCtx: CanvasRenderingContext2D | null = null;

function getMeasureContext(): CanvasRenderingContext2D {
  if (!measureCtx) {
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Failed to create measurement context');
    ctx.textRendering = 'optimizeSpeed';
    measureCtx = ctx;
  }
  return measureCtx;
}

// =============================================================================
// GLOBAL CACHES (measurement + grapheme boundaries)
// =============================================================================

class LRU<K, V> {
  private map = new Map<K, V>();
  constructor(private capacity: number) {}

  get(key: K): V | undefined {
    const v = this.map.get(key);
    if (v === undefined) return undefined;
    this.map.delete(key);
    this.map.set(key, v);
    return v;
  }

  set(key: K, val: V): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, val);
    if (this.map.size > this.capacity) {
      const oldest = this.map.keys().next().value as K;
      this.map.delete(oldest);
    }
  }

  clear(): void {
    this.map.clear();
  }
}

type CachedMeasure = { width: number; ink: BBoxTuple };

const MEASURE_LRU = new LRU<string, CachedMeasure>(75_000);
const SPACE_WIDTH = new Map<string, number>();

// Cache grapheme end-index arrays (code unit offsets) for break-word slicing
const GRAPHEME_BREAKS_LRU = new LRU<string, number[]>(10_000);

function fontEpochKey(): string {
  // Prevent reusing fallback-font measurements once real fonts load.
  // (If you want to reclaim memory, call clearTextMeasureCaches() after fonts load.)
  return areFontsLoaded() ? 'L' : 'F';
}

export function clearTextMeasureCaches(): void {
  MEASURE_LRU.clear();
  SPACE_WIDTH.clear();
  GRAPHEME_BREAKS_LRU.clear();
}

function measureTextCached(font: string, text: string): CachedMeasure {
  const key = `${fontEpochKey()}\u0000${font}\u0000${text}`;
  const hit = MEASURE_LRU.get(key);
  if (hit) return hit;

  const ctx = getMeasureContext();
  ctx.font = font;
  const m = ctx.measureText(text);

  const ink: BBoxTuple = [
    -m.actualBoundingBoxLeft,
    -m.actualBoundingBoxAscent,
    m.actualBoundingBoxRight,
    m.actualBoundingBoxDescent,
  ];

  const out = { width: m.width, ink };
  MEASURE_LRU.set(key, out);
  return out;
}

function getSpaceWidth(font: string): number {
  const hit = SPACE_WIDTH.get(font);
  if (hit !== undefined) return hit;
  const w = measureTextCached(font, ' ').width;
  SPACE_WIDTH.set(font, w);
  return w;
}

// =============================================================================
// PARSER: Y.XmlFragment → ParsedContent
// =============================================================================

function simpleHash(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + c;
    hash |= 0;
  }
  return hash;
}

export function parseYXmlFragment(fragment: Y.XmlFragment): ParsedContent {
  const paragraphs: ParsedParagraph[] = [];
  let charCount = 0;
  let hashInput = '';

  const children = fragment.toArray();

  if (children.length === 0) {
    paragraphs.push({ runs: [], isEmpty: true });
  } else {
    for (const child of children) {
      if (!(child instanceof Y.XmlElement) || child.nodeName !== 'paragraph') continue;

      const runs: ParsedRun[] = [];
      let paragraphText = '';

      for (const textNode of child.toArray()) {
        if (!(textNode instanceof Y.XmlText)) continue;

        const delta = textNode.toDelta();
        for (const op of delta) {
          if (typeof op.insert !== 'string') continue;

          const text = op.insert;
          const attrs = op.attributes || {};
          const bold = !!attrs.bold;
          const italic = !!attrs.italic;

          const last = runs[runs.length - 1];
          if (last && last.bold === bold && last.italic === italic) {
            last.text += text;
          } else {
            runs.push({ text, bold, italic });
          }

          paragraphText += text;
          charCount += text.length;

          // Hash includes formatting so style-only changes don’t “look identical”.
          hashInput += text + (bold ? 'B' : 'b') + (italic ? 'I' : 'i') + '|';
        }
      }

      hashInput += '\n';
      paragraphs.push({
        runs,
        isEmpty: runs.length === 0 || paragraphText.length === 0,
      });
    }
  }

  if (paragraphs.length === 0) paragraphs.push({ runs: [], isEmpty: true });

  return {
    paragraphs,
    structuralHash: simpleHash(hashInput),
    charCount,
  };
}

// =============================================================================
// TOKENIZER: ParsedContent → TokenizedContent
// =============================================================================

// Breakable “spaces” for wrapping decisions.
// (We intentionally do NOT treat NBSP as breakable.)
function isBreakableSpaceChar(ch: string): boolean {
  return ch === ' ' || ch === '\t';
}

function pushTokenSegment(
  tokens: Token[],
  kind: 'word' | 'space',
  seg: TokenSegment
): void {
  if (!seg.text) return;

  const lastTok = tokens[tokens.length - 1];
  if (lastTok && lastTok.kind === kind) {
    const segments = (lastTok as any).segments as TokenSegment[];
    const lastSeg = segments[segments.length - 1];

    // Merge with previous segment if identical style
    if (lastSeg && lastSeg.bold === seg.bold && lastSeg.italic === seg.italic) {
      lastSeg.text += seg.text;
    } else {
      segments.push(seg);
    }
    return;
  }

  tokens.push({ kind, segments: [seg] });
}

function tokenizeRunText(run: ParsedRun, tokens: Token[]): void {
  const { bold, italic } = run;

  let buf = '';
  let bufKind: 'word' | 'space' | null = null;

  const flush = () => {
    if (!buf || !bufKind) return;
    pushTokenSegment(tokens, bufKind, { text: buf, bold, italic });
    buf = '';
    bufKind = null;
  };

  for (let i = 0; i < run.text.length; i++) {
    const ch = run.text[i];

    // If literal newline is present, treat it as a hard break.
    // (Paragraph boundaries are still hard breaks too.)
    if (ch === '\n') {
      flush();
      tokens.push({ kind: 'hardBreak' });
      continue;
    }

    const k: 'word' | 'space' = isBreakableSpaceChar(ch) ? 'space' : 'word';

    if (bufKind === null) {
      bufKind = k;
      buf = ch;
      continue;
    }

    if (k === bufKind) {
      buf += ch;
    } else {
      flush();
      bufKind = k;
      buf = ch;
    }
  }

  flush();
}

function tokenizeParsedContent(parsed: ParsedContent): TokenizedContent {
  const paragraphs: TokenizedParagraph[] = [];

  for (const p of parsed.paragraphs) {
    if (p.isEmpty) {
      paragraphs.push({ tokens: [], isEmpty: true });
      continue;
    }

    const tokens: Token[] = [];
    for (const run of p.runs) tokenizeRunText(run, tokens);

    paragraphs.push({ tokens, isEmpty: tokens.length === 0 });
  }

  return {
    paragraphs,
    structuralHash: parsed.structuralHash,
    charCount: parsed.charCount,
  };
}

// =============================================================================
// MEASURE: TokenizedContent + fontSize → MeasuredContent
// =============================================================================

function measureSegment(font: string, text: string, isWhitespace: boolean): { w: number; ink: BBoxTuple } {
  if (isWhitespace) {
    // Fast path: pure ASCII spaces
    if (/^ +$/.test(text)) {
      const w = getSpaceWidth(font) * text.length;
      return { w, ink: [0, 0, 0, 0] };
    }

    // Tabs still advance width; treat ink as 0.
    const m = measureTextCached(font, text);
    return { w: m.width, ink: [0, 0, 0, 0] };
  }

  const m = measureTextCached(font, text);
  return { w: m.width, ink: m.ink };
}

function measureTokenizedContent(content: TokenizedContent, fontSize: number): MeasuredContent {
  const lineHeight = fontSize * FONT_CONFIG.lineHeightMultiplier;

  const paragraphs: MeasuredParagraph[] = content.paragraphs.map((p) => {
    if (p.isEmpty) return { tokens: [], isEmpty: true };

    const tokens: MeasuredToken[] = p.tokens.map((t) => {
      if (t.kind === 'hardBreak') return { kind: 'hardBreak' };

      const isWs = t.kind === 'space';
      const segs: MeasuredSegment[] = t.segments.map((s) => {
        const font = buildFontString(s.bold, s.italic, fontSize);
        const { w, ink } = measureSegment(font, s.text, isWs);
        return {
          text: s.text,
          bold: s.bold,
          italic: s.italic,
          font,
          advanceWidth: w,
          inkBounds: ink,
          isWhitespace: isWs,
        };
      });

      let adv = 0;
      for (const s of segs) adv += s.advanceWidth;
      return { kind: t.kind, segments: segs, advanceWidth: adv };
    });

    return { tokens, isEmpty: tokens.length === 0 };
  });

  return {
    paragraphs,
    structuralHash: content.structuralHash,
    charCount: content.charCount,
    fontSize,
    lineHeight,
  };
}

// =============================================================================
// BREAK-WORD SUPPORT (grapheme boundary slicing)
// =============================================================================

function getGraphemeEndIndices(text: string): number[] {
  const hit = GRAPHEME_BREAKS_LRU.get(text);
  if (hit) return hit;

  // We store end indices in UTF-16 code units (string slice indices).
  const out: number[] = [];

  const Seg = (Intl as any)?.Segmenter as any;
  if (Seg) {
    const seg = new Seg(undefined, { granularity: 'grapheme' });
    // Segmenter yields segments in order; we can accumulate segment lengths.
    let idx = 0;
    for (const part of seg.segment(text)) {
      idx += (part.segment as string).length;
      out.push(idx);
    }
  } else {
    // Fallback: code points (not perfect for ZWJ clusters, but avoids crashes)
    let idx = 0;
    for (const cp of Array.from(text)) {
      idx += cp.length;
      out.push(idx);
    }
  }

  // Ensure we always have at least one break if text non-empty
  if (out.length === 0 && text.length > 0) out.push(text.length);

  GRAPHEME_BREAKS_LRU.set(text, out);
  return out;
}

function sliceTextToFit(font: string, text: string, maxW: number): {
  head: string;
  tail: string;
  headW: number;
  headInk: BBoxTuple;
} {
  if (!text) return { head: '', tail: '', headW: 0, headInk: [0, 0, 0, 0] };

  const full = measureTextCached(font, text);
  if (full.width <= maxW) return { head: text, tail: '', headW: full.width, headInk: full.ink };

  const ends = getGraphemeEndIndices(text);

  // Binary search: largest prefix end index that fits.
  let lo = 0;
  let hi = ends.length - 1;
  let bestEnd = -1;

  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const end = ends[mid];
    const pref = text.slice(0, end);
    const w = measureTextCached(font, pref).width;

    if (w <= maxW) {
      bestEnd = end;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  // Guarantee progress: take at least one grapheme when splitting.
  const end = bestEnd >= 0 ? bestEnd : ends[0];

  const head = text.slice(0, end);
  const tail = text.slice(end);

  const m = measureTextCached(font, head);
  return { head, tail, headW: m.width, headInk: m.ink };
}

// =============================================================================
// FLOW ENGINE: MeasuredContent + WrapConfig → TextLayout
// =============================================================================

function getBoxLeftX(originX: number, boxWidth: number, align: TextAlign): number {
  return originX - anchorFactor(align) * boxWidth;
}

function getLineStartX(originX: number, boxWidth: number, lineVisualWidth: number, align: TextAlign): number {
  const left = getBoxLeftX(originX, boxWidth, align);
  if (align === 'left') return left;
  if (align === 'center') return left + (boxWidth - lineVisualWidth) / 2;
  return left + (boxWidth - lineVisualWidth);
}

type LineBuilder = {
  runs: MeasuredRun[];
  advanceX: number;
  visualWidth: number;
  hasInk: boolean;
  ink: BBoxTuple; // relative to line baseline
};

function newLineBuilder(): LineBuilder {
  return {
    runs: [],
    advanceX: 0,
    visualWidth: 0,
    hasInk: false,
    ink: [Infinity, Infinity, -Infinity, -Infinity],
  };
}

function appendPiece(
  b: LineBuilder,
  seg: Pick<MeasuredSegment, 'bold' | 'italic' | 'font' | 'isWhitespace' | 'inkBounds'>,
  text: string,
  w: number
): void {
  if (!text || w === 0) return;

  const startX = b.advanceX;

  // Coalesce adjacent pieces with identical style/font to reduce fillText calls.
  const last = b.runs[b.runs.length - 1];
  if (last && last.font === seg.font && last.bold === seg.bold && last.italic === seg.italic) {
    last.text += text;
    last.advanceWidth += w;
    last.isWhitespace = last.isWhitespace && seg.isWhitespace;
  } else {
    b.runs.push({
      text,
      bold: seg.bold,
      italic: seg.italic,
      font: seg.font,
      advanceWidth: w,
      advanceX: startX,
      isWhitespace: seg.isWhitespace,
    });
  }

  // Update line ink bounds if this piece has ink.
  if (!seg.isWhitespace) {
    b.hasInk = true;
    b.visualWidth = startX + w;

    const [l, t, r, bb] = seg.inkBounds;
    expandBBox(b.ink, startX + l, t, startX + r, bb);
  }

  b.advanceX += w;
}

function layoutMeasuredContent(content: MeasuredContent, wrap: WrapConfig): TextLayout {
  const { fontSize, lineHeight } = content;

  const maxWidth = wrap.mode === 'fixed' ? clampWrapWidth(wrap.width) : Infinity;

  const ascentY = fontSize * getMeasuredAscentRatio();
  const descentY = fontSize - ascentY;

  const lines: MeasuredLine[] = [];
  const overallInk: BBoxTuple = [Infinity, Infinity, -Infinity, -Infinity];

  let maxVisualWidth = 0;

  // Pending inter-word whitespace (deferred spaces).
  let pendingSegs: MeasuredSegment[] = [];
  let pendingW = 0;

  const clearPending = () => {
    pendingSegs = [];
    pendingW = 0;
  };

  const stashPending = (tok: Extract<MeasuredToken, { kind: 'space' }>) => {
    for (const seg of tok.segments) {
      pendingSegs.push(seg);
      pendingW += seg.advanceWidth;
    }
  };

  const commitPending = (b: LineBuilder) => {
    for (const seg of pendingSegs) {
      appendPiece(b, seg, seg.text, seg.advanceWidth);
    }
    clearPending();
  };

  const pushLine = (b: LineBuilder) => {
    const idx = lines.length;
    const baselineY = idx * lineHeight;

    // If no ink, use baseline bounds so height is correct.
    const inkBounds: BBoxTuple = b.hasInk
      ? b.ink
      : [0, -ascentY, 0, descentY];

    // Ensure finite ink tuple
    if (!isFinite(inkBounds[0])) {
      inkBounds[0] = 0;
      inkBounds[1] = -ascentY;
      inkBounds[2] = 0;
      inkBounds[3] = descentY;
    }

    lines.push({
      runs: b.runs,
      index: idx,
      advanceWidth: b.advanceX,
      visualWidth: b.visualWidth,
      inkBounds,
      baselineY,
      lineHeight,
      isEmpty: !b.hasInk,
    });

    maxVisualWidth = Math.max(maxVisualWidth, b.visualWidth);

    // Overall ink bbox in layout coords (line starts at x=0 here; alignment applied later)
    expandBBox(overallInk, inkBounds[0], baselineY + inkBounds[1], inkBounds[2], baselineY + inkBounds[3]);
  };

  const appendWholeWord = (b: LineBuilder, tok: Extract<MeasuredToken, { kind: 'word' }>) => {
    for (const seg of tok.segments) appendPiece(b, seg, seg.text, seg.advanceWidth);
  };

  const appendBreakWord = (b: LineBuilder, tok: Extract<MeasuredToken, { kind: 'word' }>) => {
    // Break across segments; each slice is measured at grapheme boundaries.
    for (const seg of tok.segments) {
      let remaining = seg.text;

      while (remaining.length > 0) {
        const room = maxWidth - b.advanceX;

        // If there is no room but we already have any content (including leading spaces),
        // finalize line and continue on next line.
        if (room <= 0 && b.advanceX > 0) {
          pushLine(b);
          b = newLineBuilder();
          continue;
        }

        const { head, tail, headW, headInk } = sliceTextToFit(seg.font, remaining, Math.max(0, room));

        // head is guaranteed non-empty for non-empty remaining.
        appendPiece(
          b,
          { ...seg, inkBounds: headInk },
          head,
          headW
        );

        remaining = tail;

        if (remaining.length > 0) {
          pushLine(b);
          b = newLineBuilder();
        }
      }
    }

    return b;
  };

  // Process paragraphs (paragraph boundary is always a hard line break).
  for (const p of content.paragraphs) {
    let b = newLineBuilder();
    clearPending();

    if (p.isEmpty || p.tokens.length === 0) {
      pushLine(b);
      continue;
    }

    for (const tok of p.tokens) {
      if (tok.kind === 'hardBreak') {
        // HardBreak inside paragraph forces line break; pending spaces hang.
        clearPending();
        pushLine(b);
        b = newLineBuilder();
        continue;
      }

      if (tok.kind === 'space') {
        // Leading spaces: commit immediately (indent).
        // Inter-word spaces: defer (pending) and decide at next word.
        if (!b.hasInk && pendingW === 0) {
          // NOTE: line may already have leading spaces committed (b.advanceX > 0),
          // but b.hasInk stays false; still considered "leading".
          for (const seg of tok.segments) appendPiece(b, seg, seg.text, seg.advanceWidth);
        } else {
          stashPending(tok);
        }
        continue;
      }

      // tok.kind === 'word'
      if (wrap.mode === 'auto') {
        // No wrap constraint: pending spaces always commit when a word appears.
        if (pendingW > 0) commitPending(b);
        appendWholeWord(b, tok);
        continue;
      }

      // fixed-width mode
      const wordW = tok.advanceWidth;

      // If we have ink on this line, pending is "inter-word".
      if (b.hasInk) {
        if (wordW <= maxWidth) {
          // Normal wrap decision:
          if (b.advanceX + pendingW + wordW <= maxWidth) {
            if (pendingW > 0) commitPending(b);
            appendWholeWord(b, tok);
          } else {
            // Word wraps: pending spaces hang (dropped), word starts next line.
            clearPending();
            pushLine(b);
            b = newLineBuilder();
            appendWholeWord(b, tok);
          }
        } else {
          // overflow-wrap: break-word
          // If there is room for the word to start on this line (after pending),
          // commit pending and break; otherwise wrap first.
          if (b.advanceX + pendingW < maxWidth) {
            if (pendingW > 0) commitPending(b);
            b = appendBreakWord(b, tok);
          } else {
            clearPending();
            pushLine(b);
            b = newLineBuilder();
            b = appendBreakWord(b, tok);
          }
        }

        continue;
      }

      // Start-of-line (no ink yet). We may have committed leading spaces already.
      // If leading spaces consume the line such that a normal word cannot fit, push
      // a visually empty line (spaces-only), then place the word at x=0 on next line.
      if (wordW <= maxWidth && b.advanceX > 0 && b.advanceX + wordW > maxWidth) {
        pushLine(b);
        b = newLineBuilder();
      }

      // Any pending at start-of-line should not exist; but keep it safe:
      clearPending();

      if (wordW <= maxWidth) {
        appendWholeWord(b, tok);
      } else {
        b = appendBreakWord(b, tok);
      }
    }

    // Paragraph end: pending inter-word spaces hang (discard).
    clearPending();
    pushLine(b);
  }

  if (!isFinite(overallInk[0])) {
    overallInk[0] = 0;
    overallInk[1] = 0;
    overallInk[2] = 0;
    overallInk[3] = fontSize;
  }

  const boxWidth = wrap.mode === 'fixed' ? wrap.width : maxVisualWidth;
  const totalHeight = lines.length * lineHeight;

  return {
    lines,
    fontSize,
    lineHeight,
    boxWidth,
    widthMode: wrap.mode === 'fixed' ? 'fixed' : 'auto',
    inkBBox: [overallInk[0], overallInk[1], overallInk[2] - overallInk[0], overallInk[3] - overallInk[1]],
    logicalBBox: [0, 0, boxWidth, totalHeight],
    structuralHash: content.structuralHash,
  };
}

// =============================================================================
// OPTIONAL: layoutContent (ParsedContent -> TextLayout), kept for compatibility
// =============================================================================

export function layoutContent(content: ParsedContent, fontSize: number, wrap: WrapConfig = AUTO_WRAP): TextLayout {
  const tokenized = tokenizeParsedContent(content);
  const measured = measureTokenizedContent(tokenized, fontSize);
  return layoutMeasuredContent(measured, wrap);
}

// =============================================================================
// CACHE: TextLayoutCache (tokenized + measured + flow keyed by wrap)
// =============================================================================

interface CacheEntry {
  tokenized: TokenizedContent;

  measured: MeasuredContent;
  measuredFontSize: number;

  layout: TextLayout;
  layoutKey: string;

  frame: FrameTuple | null;
}

function wrapKey(wrap: WrapConfig): string {
  if (wrap.mode === 'auto') return 'auto';
  // EXACT width key (no rounding): you commit on pointer-up.
  return `fixed:${wrap.width}`;
}

class TextLayoutCache {
  private cache = new Map<string, CacheEntry>();

  getLayout(objectId: string, fragment: Y.XmlFragment, fontSize: number, wrap: WrapConfig = AUTO_WRAP): TextLayout {
    const key = wrapKey(wrap);
    const entry = this.cache.get(objectId);

    if (!entry) {
      const parsed = parseYXmlFragment(fragment);
      const tokenized = tokenizeParsedContent(parsed);
      const measured = measureTokenizedContent(tokenized, fontSize);
      const layout = layoutMeasuredContent(measured, wrap);

      this.cache.set(objectId, {
        tokenized,
        measured,
        measuredFontSize: fontSize,
        layout,
        layoutKey: key,
        frame: null,
      });

      return layout;
    }

    // Font size invalidates measurement + flow.
    if (entry.measuredFontSize !== fontSize) {
      entry.measured = measureTokenizedContent(entry.tokenized, fontSize);
      entry.measuredFontSize = fontSize;
      entry.layoutKey = '';
      entry.frame = null;
    }

    // Width/widthMode invalidates flow only.
    if (entry.layoutKey !== key) {
      entry.layout = layoutMeasuredContent(entry.measured, wrap);
      entry.layoutKey = key;
      entry.frame = null;
    }

    return entry.layout;
  }

  invalidate(objectId: string): void {
    this.cache.delete(objectId);
  }

  // Font size changed
  invalidateLayout(objectId: string): void {
    const entry = this.cache.get(objectId);
    if (!entry) return;
    entry.measuredFontSize = -1;
    entry.layoutKey = '';
    entry.frame = null;
  }

  // Width / widthMode changed (reflow only)
  invalidateFlow(objectId: string): void {
    const entry = this.cache.get(objectId);
    if (!entry) return;
    entry.layoutKey = '';
    entry.frame = null;
  }

  clear(): void {
    this.cache.clear();
  }

  has(objectId: string): boolean {
    return this.cache.has(objectId);
  }

  setFrame(objectId: string, frame: FrameTuple): void {
    const entry = this.cache.get(objectId);
    if (entry) entry.frame = frame;
  }

  getFrame(objectId: string): FrameTuple | null {
    return this.cache.get(objectId)?.frame ?? null;
  }
}

export const textLayoutCache = new TextLayoutCache();

// =============================================================================
// RENDERER: renderTextLayout (box-based alignment for fixed width)
// =============================================================================

export function renderTextLayout(
  ctx: CanvasRenderingContext2D,
  layout: TextLayout,
  originX: number,
  originY: number,
  color: string,
  align: TextAlign = 'left'
): void {
  ctx.save();
  ctx.fillStyle = color;
  ctx.textBaseline = 'alphabetic';
  ctx.textRendering = 'optimizeSpeed';

  const boxWidth = layout.boxWidth;

  for (const line of layout.lines) {
    if (line.isEmpty) continue;

    const lineY = originY + line.baselineY;
    const startX = getLineStartX(originX, boxWidth, line.visualWidth, align);

    for (const run of line.runs) {
      // Skip whitespace-only runs (no ink).
      if (run.isWhitespace) continue;
      ctx.font = run.font;
      ctx.fillText(run.text, startX + run.advanceX, lineY);
    }
  }

  ctx.restore();
}

// =============================================================================
// BBOX COMPUTATION + DERIVED FRAME: computeTextBBox
// =============================================================================

export function computeTextBBox(
  objectId: string,
  fragment: Y.XmlFragment,
  fontSize: number,
  origin: [number, number],
  align: TextAlign = 'left',
  fixedWidth: number | null = null
): BBoxTuple {
  const wrap: WrapConfig =
    fixedWidth === null ? AUTO_WRAP : { mode: 'fixed', width: fixedWidth };

  const layout = textLayoutCache.getLayout(objectId, fragment, fontSize, wrap);

  const [ox, oy] = origin;
  const [, inkY, , inkH] = layout.inkBBox;
  const padding = 2;

  let minX = Infinity;
  let maxX = -Infinity;

  for (const line of layout.lines) {
    if (line.isEmpty) continue;

    const startX = getLineStartX(ox, layout.boxWidth, line.visualWidth, align);
    minX = Math.min(minX, startX + line.inkBounds[0]);
    maxX = Math.max(maxX, startX + line.inkBounds[2]);
  }

  if (!isFinite(minX)) {
    // No ink anywhere (all-empty). Keep bbox degenerate at originX.
    minX = ox;
    maxX = ox;
  }

  // Derived DOM-matching frame: anchored by originX, baseline originY.
  const fw = layout.boxWidth;
  const fx = ox - anchorFactor(align) * fw;
  const fy = oy - fontSize * getBaselineToTopRatio();
  textLayoutCache.setFrame(objectId, [fx, fy, fw, layout.logicalBBox[3]]);

  return [
    minX - padding,
    oy + inkY - padding,
    maxX + padding,
    oy + inkY + inkH + padding,
  ];
}

export function getTextFrame(objectId: string): FrameTuple | null {
  return textLayoutCache.getFrame(objectId);
}
```

---

## Minimal required call-site hooks (not the focus, but you *do* need these)

These are the only non-`text-system.ts` changes that are *structurally required* for correctness with fixed width, matching how your current system invalidates content/fontSize today.  

### 1) Pass `fixedWidth` into `computeTextBBox` when `widthMode === 'fixed'`

In `room-doc-manager` where you currently do:

```ts
newBBox = computeTextBBox(id, content, fontSize, origin, align);
```

Update to:

```ts
const widthMode = (yObj.get('widthMode') as 'auto' | 'fixed') ?? 'auto';
const width = (yObj.get('width') as number | undefined) ?? 0;

newBBox = computeTextBBox(
  id,
  content,
  fontSize,
  origin,
  align,
  widthMode === 'fixed' ? width : null
);
```

### 2) Invalidate flow (reflow only) on `width` or `widthMode` mutations

Where you currently invalidate on content/fontSize, add:

```ts
if (field === 'width' || field === 'widthMode') {
  textLayoutCache.invalidateFlow(id);
}
```

---

## What this implementation guarantees (directly tied to your success criteria)

* **Fixes “spaces move to next line”** by never committing inter-word spaces until the next word placement is decided (the deferred-space pattern).
* **Never splits inter-word whitespace across lines** (so it won’t accidentally behave like `break-spaces`).
* **Leading spaces can create a spaces-only line** that pushes the word to the next line (your described edge case), while extra spaces don’t “cascade” into additional blank lines because we never wrap inside leading space runs.
* **Break-word is grapheme-aware**, always makes progress (no infinite loops).
* **Caches are layered**: tokenization persists across font changes; measurement persists across width changes; width changes only reflow.
* **Tuple bboxes + `expandBBox`** are used everywhere, consistent with your current codebase style. 
