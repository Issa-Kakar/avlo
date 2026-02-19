# text-system.ts — Wrapping Pipeline Implementation

Complete replacement for `lib/text/text-system.ts`. Implements `white-space: pre-wrap` + `overflow-wrap: break-word` matching via a **parse → tokenize → measure → flow** pipeline with three-tier cache invalidation.

**Core behavioral contract (CSS `pre-wrap`):**
- Inter-word whitespace is **pending**: committed only if the next word fits on the same line. Otherwise it **hangs** — logically present but excluded from layout.
- Whitespace **never splits across lines**. An entire space token either stays or hangs.
- **Leading whitespace** (paragraph start, no word placed yet): committed immediately, advances caret, can overflow. Creates at most one visually-blank line if it pushes the first word down.
- End-of-paragraph trailing whitespace hangs (not laid out).

---

## Full file contents

```ts
/**
 * text-system.ts — Wrapped WYSIWYG Text Pipeline
 *
 * Pipeline: parse → tokenize → measure → flow → render
 *
 * Cache tiers:
 *   1. tokenized (content-dependent)       — invalidated on Y.XmlFragment edits
 *   2. measured  (fontSize-dependent)       — invalidated on fontSize change
 *   3. layout    (width/widthMode-dependent) — invalidated on width/widthMode change
 *
 * Whitespace model (matches CSS white-space: pre-wrap):
 *   Leading spaces   → committed immediately, advance caret, may overflow
 *   Inter-word spaces → buffered as "pending"; committed when next word fits,
 *                        otherwise they "hang" (excluded from layout)
 *   Trailing spaces   → hang at paragraph end
 *   Spaces NEVER split across lines (that's break-spaces, not pre-wrap)
 */

import * as Y from 'yjs';
import type { BBoxTuple, FrameTuple } from '@avlo/shared';
import { expandBBox } from '@/lib/geometry/bounds';
import { areFontsLoaded } from './font-loader';
import { FONT_CONFIG } from './font-config';

// Re-export for consumers
export { FONT_CONFIG } from './font-config';

// =============================================================================
// TEXT ALIGNMENT
// =============================================================================

export type TextAlign = 'left' | 'center' | 'right';

export function anchorFactor(align: TextAlign): number {
  return align === 'left' ? 0 : align === 'center' ? 0.5 : 1;
}

// =============================================================================
// FONT METRICS (measured, cached)
// =============================================================================

let _measuredAscentRatio: number | null = null;

export function getMeasuredAscentRatio(): number {
  if (_measuredAscentRatio === null) {
    const ctx = getMeasureContext();
    const testSize = 100;
    ctx.font = buildFontString(false, false, testSize);
    const m = ctx.measureText('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz');
    _measuredAscentRatio = m.fontBoundingBoxAscent / testSize;
  }
  return _measuredAscentRatio;
}

export function getBaselineToTopRatio(): number {
  const halfLeading = (FONT_CONFIG.lineHeightMultiplier - 1) / 2;
  return halfLeading + getMeasuredAscentRatio();
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
// WIDTH / WRAP CONFIG
// =============================================================================

export type WidthMode = 'auto' | 'fixed';

export interface WrapConfig {
  mode: WidthMode;
  width?: number; // world units when mode='fixed'
}

const DEFAULT_WRAP: WrapConfig = { mode: 'auto' };

// =============================================================================
// MEASUREMENT CONTEXT (singleton offscreen canvas)
// =============================================================================

let _measureCtx: CanvasRenderingContext2D | null = null;

function getMeasureContext(): CanvasRenderingContext2D {
  if (!_measureCtx) {
    const c = document.createElement('canvas');
    c.width = 1;
    c.height = 1;
    const ctx = c.getContext('2d');
    if (!ctx) throw new Error('Failed to create measurement canvas');
    ctx.textRendering = 'optimizeSpeed';
    _measureCtx = ctx;
  }
  return _measureCtx;
}

// =============================================================================
// LRU CACHE
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

  clear(): void { this.map.clear(); }
}

// =============================================================================
// GLOBAL MEASUREMENT CACHES
// =============================================================================

interface CachedMeasure {
  width: number;
  ink: BBoxTuple; // [left, top, right, bottom] relative to glyph draw origin
}

const MEASURE_LRU = new LRU<string, CachedMeasure>(75_000);
const GRAPHEME_LRU = new LRU<string, string[]>(10_000);
const SPACE_WIDTH_CACHE = new Map<string, number>(); // font → single-space width

function measureTextCached(font: string, text: string): CachedMeasure {
  const key = font + '\0' + text;
  const hit = MEASURE_LRU.get(key);
  if (hit) return hit;

  const ctx = getMeasureContext();
  ctx.font = font;
  const m = ctx.measureText(text);

  const out: CachedMeasure = {
    width: m.width,
    ink: [
      -m.actualBoundingBoxLeft,
      -m.actualBoundingBoxAscent,
      m.actualBoundingBoxRight,
      m.actualBoundingBoxDescent,
    ],
  };
  MEASURE_LRU.set(key, out);
  return out;
}

function getSpaceWidth(font: string): number {
  let w = SPACE_WIDTH_CACHE.get(font);
  if (w !== undefined) return w;
  w = measureTextCached(font, ' ').width;
  SPACE_WIDTH_CACHE.set(font, w);
  return w;
}

const ZERO_INK: BBoxTuple = [0, 0, 0, 0];

// =============================================================================
// PARSED TYPES
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

type TokenKind = 'word' | 'space';

interface TokenSegment {
  text: string;
  bold: boolean;
  italic: boolean;
}

interface Token {
  kind: TokenKind;
  segments: TokenSegment[];
}

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

interface MeasuredSegment {
  text: string;
  bold: boolean;
  italic: boolean;
  font: string;
  advanceWidth: number;
  ink: BBoxTuple;      // ZERO_INK for whitespace
  isWhitespace: boolean;
}

interface MeasuredToken {
  kind: TokenKind;
  segments: MeasuredSegment[];
  advanceWidth: number; // sum of segment advance widths
}

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

// =============================================================================
// LAYOUT OUTPUT TYPES
// =============================================================================

export interface MeasuredRun {
  text: string;
  bold: boolean;
  italic: boolean;
  font: string;
  advanceWidth: number;
  advanceX: number;       // x offset from line's left edge
  ink: BBoxTuple;         // [l, t, r, b] relative to this run's draw origin
  isWhitespace: boolean;
}

export interface MeasuredLine {
  runs: MeasuredRun[];
  index: number;
  advanceWidth: number;  // total width of committed runs (including leading whitespace)
  visualWidth: number;   // up to last non-whitespace run (for text-align)
  ink: BBoxTuple;        // [left, top, right, bottom] union of run inks, relative to line start
  baselineY: number;     // relative to origin (0 for first line)
  lineHeight: number;
  isEmpty: boolean;      // no ink (may contain whitespace-only runs)
}

export interface TextLayout {
  lines: MeasuredLine[];
  fontSize: number;
  lineHeight: number;
  widthMode: WidthMode;
  boxWidth: number;       // auto: max advanceWidth; fixed: explicit width
  inkBBox: FrameTuple;    // [x, y, w, h] overall ink bounds relative to origin
  logicalBBox: FrameTuple; // [x, y, w, h] based on boxWidth × total line height
  structuralHash: number;
}

// =============================================================================
// PARSER: Y.XmlFragment → ParsedContent
// =============================================================================

function simpleHash(str: string): number {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  }
  return h;
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
      let pText = '';

      for (const textNode of child.toArray()) {
        if (!(textNode instanceof Y.XmlText)) continue;
        for (const op of textNode.toDelta()) {
          if (typeof op.insert !== 'string') continue;
          const text = op.insert;
          const attrs = op.attributes || {};
          const bold = !!attrs.bold;
          const italic = !!attrs.italic;

          // Coalesce consecutive runs with same formatting
          const last = runs[runs.length - 1];
          if (last && last.bold === bold && last.italic === italic) {
            last.text += text;
          } else {
            runs.push({ text, bold, italic });
          }
          pText += text;
          charCount += text.length;
          hashInput += text + (bold ? 'B' : 'b') + (italic ? 'I' : 'i') + '|';
        }
      }
      hashInput += '\n';
      paragraphs.push({ runs, isEmpty: runs.length === 0 || pText.length === 0 });
    }
  }

  if (paragraphs.length === 0) {
    paragraphs.push({ runs: [], isEmpty: true });
  }

  return { paragraphs, structuralHash: simpleHash(hashInput), charCount };
}

// =============================================================================
// TOKENIZER: ParsedContent → TokenizedContent
// =============================================================================

/** Split text into alternating whitespace / non-whitespace chunks */
function splitWsNonWs(text: string): Array<{ text: string; isWs: boolean }> {
  const out: Array<{ text: string; isWs: boolean }> = [];
  const re = /(\s+|\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out.push({ text: m[0], isWs: /^\s+$/.test(m[0]) });
  }
  return out;
}

/**
 * Merge segment into token stream. If the last token has the same kind,
 * append as a new segment (or extend the last segment if same formatting).
 */
function pushSegment(tokens: Token[], kind: TokenKind, seg: TokenSegment): void {
  if (!seg.text) return;
  const last = tokens[tokens.length - 1];
  if (last && last.kind === kind) {
    const lastSeg = last.segments[last.segments.length - 1];
    if (lastSeg && lastSeg.bold === seg.bold && lastSeg.italic === seg.italic) {
      lastSeg.text += seg.text;
    } else {
      last.segments.push(seg);
    }
    return;
  }
  tokens.push({ kind, segments: [seg] });
}

function tokenizeParsedContent(parsed: ParsedContent): TokenizedContent {
  const paragraphs: TokenizedParagraph[] = parsed.paragraphs.map((p) => {
    if (p.isEmpty) return { tokens: [], isEmpty: true };
    const tokens: Token[] = [];
    for (const run of p.runs) {
      for (const ch of splitWsNonWs(run.text)) {
        pushSegment(tokens, ch.isWs ? 'space' : 'word', {
          text: ch.text,
          bold: run.bold,
          italic: run.italic,
        });
      }
    }
    return { tokens, isEmpty: tokens.length === 0 };
  });

  return {
    paragraphs,
    structuralHash: parsed.structuralHash,
    charCount: parsed.charCount,
  };
}

// =============================================================================
// MEASURE: TokenizedContent → MeasuredContent (fontSize-dependent, cached)
// =============================================================================

function measureSeg(font: string, text: string, isWs: boolean): { w: number; ink: BBoxTuple } {
  if (isWs) {
    // Pure spaces: multiply single-space width (no ink)
    if (/^ +$/.test(text)) {
      return { w: getSpaceWidth(font) * text.length, ink: ZERO_INK };
    }
    // Other whitespace (tabs, NBSP): measure but zero ink
    return { w: measureTextCached(font, text).width, ink: ZERO_INK };
  }
  const m = measureTextCached(font, text);
  return { w: m.width, ink: m.ink };
}

function measureTokenizedContent(content: TokenizedContent, fontSize: number): MeasuredContent {
  const lineHeight = fontSize * FONT_CONFIG.lineHeightMultiplier;

  const paragraphs: MeasuredParagraph[] = content.paragraphs.map((p) => {
    if (p.isEmpty) return { tokens: [], isEmpty: true };

    const tokens: MeasuredToken[] = p.tokens.map((t) => {
      const isWs = t.kind === 'space';
      let totalW = 0;
      const segments: MeasuredSegment[] = t.segments.map((s) => {
        const font = buildFontString(s.bold, s.italic, fontSize);
        const { w, ink } = measureSeg(font, s.text, isWs);
        totalW += w;
        return { text: s.text, bold: s.bold, italic: s.italic, font, advanceWidth: w, ink, isWhitespace: isWs };
      });
      return { kind: t.kind, segments, advanceWidth: totalW };
    });

    return { tokens, isEmpty: false };
  });

  return { paragraphs, structuralHash: content.structuralHash, charCount: content.charCount, fontSize, lineHeight };
}

// =============================================================================
// GRAPHEME SEGMENTATION + TEXT SLICING (for overflow-wrap: break-word)
// =============================================================================

function getGraphemes(text: string): string[] {
  const hit = GRAPHEME_LRU.get(text);
  if (hit) return hit;
  let out: string[];
  if (typeof Intl !== 'undefined' && (Intl as any).Segmenter) {
    const seg = new (Intl as any).Segmenter(undefined, { granularity: 'grapheme' });
    out = Array.from(seg.segment(text), (x: any) => x.segment);
  } else {
    out = Array.from(text);
  }
  GRAPHEME_LRU.set(text, out);
  return out;
}

/**
 * Slice text at grapheme boundaries to fit within maxW.
 * Always returns at least 1 grapheme to guarantee forward progress.
 */
function sliceTextToFit(
  font: string,
  text: string,
  maxW: number,
): { head: string; tail: string; headW: number; headInk: BBoxTuple } {
  if (!text) return { head: '', tail: '', headW: 0, headInk: ZERO_INK };

  const full = measureTextCached(font, text);
  if (full.width <= maxW) return { head: text, tail: '', headW: full.width, headInk: full.ink };

  const g = getGraphemes(text);
  // Binary search: find largest prefix that fits
  let lo = 0, hi = g.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    const w = measureTextCached(font, g.slice(0, mid).join('')).width;
    if (w <= maxW) lo = mid;
    else hi = mid - 1;
  }
  // Force at least 1 grapheme to prevent infinite loops
  if (lo === 0) lo = 1;

  const head = g.slice(0, lo).join('');
  const tail = g.slice(lo).join('');
  const m = measureTextCached(font, head);
  return { head, tail, headW: m.width, headInk: m.ink };
}

// =============================================================================
// FLOW ENGINE: MeasuredContent + WrapConfig → TextLayout
//
// This is the core wrapping algorithm. It implements the "deferred space"
// (pending whitespace) pattern to match CSS white-space: pre-wrap.
// =============================================================================

// --- Line builder (accumulates runs for a single line) ---

interface LineBuilder {
  runs: MeasuredRun[];
  advanceX: number;     // total advance including all committed runs
  visualWidth: number;  // advance up to the end of last non-whitespace run
  hasInk: boolean;      // has at least one non-whitespace run
  ink: BBoxTuple;       // [minX, minY, maxX, maxY] running union, relative to line start
}

function newLineBuilder(): LineBuilder {
  return { runs: [], advanceX: 0, visualWidth: 0, hasInk: false, ink: [Infinity, Infinity, -Infinity, -Infinity] };
}

/**
 * Append a run to the line builder.
 * Coalesces with previous run if same font/style to reduce fillText calls.
 * Copies ink tuple on creation so in-place expandBBox won't corrupt measured cache.
 */
function appendRun(b: LineBuilder, seg: MeasuredSegment, text: string, w: number, ink: BBoxTuple): void {
  if (!text) return;

  // Coalesce: merge with previous run if same font+style (reduces fillText calls)
  const prev = b.runs[b.runs.length - 1];
  if (prev && prev.font === seg.font && prev.bold === seg.bold && prev.italic === seg.italic) {
    const offset = prev.advanceWidth;
    prev.text += text;
    prev.advanceWidth += w;
    if (!seg.isWhitespace) {
      prev.isWhitespace = false;
      expandBBox(prev.ink, ink[0] + offset, ink[1], ink[2] + offset, ink[3]);
      b.hasInk = true;
      // End of merged run: run start + merged width (clearer than b.advanceX + w, same result)
      b.visualWidth = prev.advanceX + prev.advanceWidth;
      expandBBox(b.ink, prev.advanceX + prev.ink[0], prev.ink[1], prev.advanceX + prev.ink[2], prev.ink[3]);
    }
    b.advanceX += w;
    return;
  }

  // New run — copy ink so expandBBox on coalesce won't mutate the source segment
  const run: MeasuredRun = {
    text,
    bold: seg.bold,
    italic: seg.italic,
    font: seg.font,
    advanceWidth: w,
    advanceX: b.advanceX,
    ink: [ink[0], ink[1], ink[2], ink[3]],
    isWhitespace: seg.isWhitespace,
  };
  b.runs.push(run);

  if (!seg.isWhitespace) {
    b.hasInk = true;
    b.visualWidth = b.advanceX + w;
    expandBBox(b.ink, b.advanceX + ink[0], ink[1], b.advanceX + ink[2], ink[3]);
  }

  b.advanceX += w;
}

// --- Main flow function ---

function layoutMeasuredContent(content: MeasuredContent, wrap: WrapConfig): TextLayout {
  const { fontSize, lineHeight } = content;

  // maxWidth for line breaking. auto → Infinity (no width-based wrapping).
  // Clamp to a small positive to avoid division issues / infinite loops.
  const maxWidth = wrap.mode === 'fixed'
    ? Math.max(0.01, wrap.width ?? 0.01)
    : Infinity;

  const lines: MeasuredLine[] = [];
  let lineIdx = 0;
  let maxVisualWidth = 0;
  let maxAdvanceWidth = 0;

  // Pre-computed font metrics for this size
  const ascentY = fontSize * getMeasuredAscentRatio();
  const descentY = fontSize - ascentY;

  // Overall ink bounds accumulator [minX, minY, maxX, maxY]
  const ink: BBoxTuple = [Infinity, Infinity, -Infinity, -Infinity];

  // --- Finalize and push a line ---
  const pushLine = (b: LineBuilder) => {
    const baselineY = lineIdx * lineHeight;

    // Resolve line ink: if no ink runs, use font-metric defaults
    const lineInk: BBoxTuple = b.hasInk && isFinite(b.ink[0])
      ? b.ink
      : [0, -ascentY, 0, descentY];

    lines.push({
      runs: b.runs,
      index: lineIdx,
      advanceWidth: b.advanceX,
      visualWidth: b.visualWidth,
      ink: lineInk,
      baselineY,
      lineHeight,
      isEmpty: !b.hasInk,
    });

    maxVisualWidth = Math.max(maxVisualWidth, b.visualWidth);
    maxAdvanceWidth = Math.max(maxAdvanceWidth, b.advanceX);

    // Accumulate global ink (vertical shifted by baselineY)
    expandBBox(ink,
      b.hasInk ? lineInk[0] : 0,
      baselineY + lineInk[1],
      b.hasInk ? lineInk[2] : 0,
      baselineY + lineInk[3],
    );

    lineIdx++;
  };

  // ======================================================================
  // PENDING WHITESPACE STATE
  //
  // Inter-word spaces are buffered here. They're committed to the line
  // only when the next word fits alongside them. If the word wraps,
  // pending spaces "hang" (discarded from layout).
  // ======================================================================

  let pendingSegs: MeasuredSegment[] = [];
  let pendingW = 0;

  const clearPending = () => { pendingSegs.length = 0; pendingW = 0; };

  const stashPending = (tok: MeasuredToken) => {
    for (const seg of tok.segments) {
      pendingSegs.push(seg);
      pendingW += seg.advanceWidth;
    }
  };

  const commitPending = (b: LineBuilder) => {
    for (const seg of pendingSegs) {
      appendRun(b, seg, seg.text, seg.advanceWidth, seg.ink);
    }
    clearPending();
  };

  // ======================================================================
  // WORD PLACEMENT (handles break-word for oversized words)
  // ======================================================================

  /**
   * Place a word token on the current line, breaking across lines if needed.
   * Caller must have already handled pending whitespace before calling this.
   * Returns the (possibly new) line builder.
   */
  const placeWord = (b: LineBuilder, tok: MeasuredToken): LineBuilder => {
    // --- Auto mode: no wrapping, just append ---
    if (maxWidth === Infinity) {
      for (const seg of tok.segments) {
        appendRun(b, seg, seg.text, seg.advanceWidth, seg.ink);
      }
      return b;
    }

    const remaining = maxWidth - b.advanceX;

    // --- Word fits on current line ---
    if (tok.advanceWidth <= remaining) {
      for (const seg of tok.segments) {
        appendRun(b, seg, seg.text, seg.advanceWidth, seg.ink);
      }
      return b;
    }

    // --- Word fits on a FRESH line (standard wrap before word) ---
    if (tok.advanceWidth <= maxWidth) {
      if (b.runs.length > 0) {
        pushLine(b);
        b = newLineBuilder();
      }
      for (const seg of tok.segments) {
        appendRun(b, seg, seg.text, seg.advanceWidth, seg.ink);
      }
      return b;
    }

    // --- Word exceeds maxWidth: overflow-wrap: break-word ---
    // Split across lines at grapheme boundaries.
    // If current line has space, fill it first, then continue on new lines.
    if (remaining <= 0 && b.runs.length > 0) {
      pushLine(b);
      b = newLineBuilder();
    }

    for (let si = 0; si < tok.segments.length; si++) {
      const seg = tok.segments[si];
      let text = seg.text;

      while (text.length > 0) {
        let lineRemaining = maxWidth - b.advanceX;
        if (lineRemaining <= 0) {
          pushLine(b);
          b = newLineBuilder();
          lineRemaining = maxWidth;
        }

        const { head, tail, headW, headInk } = sliceTextToFit(seg.font, text, lineRemaining);

        // head is guaranteed non-empty (sliceTextToFit forces ≥1 grapheme)
        appendRun(b, seg, head, headW, headInk);
        text = tail;

        if (text.length > 0) {
          // More text remains — wrap now
          pushLine(b);
          b = newLineBuilder();
        }
      }
    }

    return b;
  };

  // ======================================================================
  // MAIN FLOW LOOP
  // ======================================================================

  let b = newLineBuilder();

  for (const p of content.paragraphs) {
    // Empty paragraph: emit one empty line
    if (p.isEmpty || p.tokens.length === 0) {
      clearPending();
      pushLine(b);
      b = newLineBuilder();
      continue;
    }

    for (const tok of p.tokens) {
      // ------------------------------------------------------------------
      // SPACE TOKEN
      // ------------------------------------------------------------------
      if (tok.kind === 'space') {
        if (!b.hasInk) {
          // LEADING whitespace (no word on this line yet):
          // Commit immediately. The entire space token goes on this line
          // without splitting. This can overflow maxWidth — that's correct
          // for pre-wrap (leading spaces are never broken across lines).
          for (const seg of tok.segments) {
            appendRun(b, seg, seg.text, seg.advanceWidth, seg.ink);
          }
        } else if (maxWidth === Infinity) {
          // AUTO MODE: no wrapping possible, spaces are real content.
          // Commit immediately — no pending needed since nothing can hang.
          for (const seg of tok.segments) {
            appendRun(b, seg, seg.text, seg.advanceWidth, seg.ink);
          }
        } else {
          // FIXED WIDTH, INTER-WORD whitespace: buffer as pending.
          // Will be committed when next word fits, or hung if it doesn't.
          stashPending(tok);
        }
        continue;
      }

      // ------------------------------------------------------------------
      // WORD TOKEN
      // ------------------------------------------------------------------

      // --- Auto mode: commit pending + word, no wrapping ---
      if (maxWidth === Infinity) {
        if (pendingW > 0) commitPending(b);
        b = placeWord(b, tok);
        continue;
      }

      // --- Fixed width mode ---
      if (b.hasInk) {
        // Line already has a word. Check if pending spaces + this word fit.

        if (tok.advanceWidth <= maxWidth) {
          // Normal-sized word
          if (b.advanceX + pendingW + tok.advanceWidth <= maxWidth) {
            // Fits: commit spaces + word
            if (pendingW > 0) commitPending(b);
            b = placeWord(b, tok);
          } else {
            // Doesn't fit: spaces HANG, word goes to next line
            clearPending();
            pushLine(b);
            b = newLineBuilder();
            b = placeWord(b, tok);
          }
        } else {
          // Oversized word (needs break-word).
          // If we can fit any prefix after pending spaces, commit them.
          if (b.advanceX + pendingW < maxWidth) {
            if (pendingW > 0) commitPending(b);
          } else {
            // No room even for pending + 1 char: spaces hang, word on next line
            clearPending();
            pushLine(b);
            b = newLineBuilder();
          }
          b = placeWord(b, tok);
        }
      } else {
        // No word on this line yet (may have leading whitespace committed).
        // If leading spaces consumed space such that the word can't fit here,
        // wrap to a fresh line. This applies regardless of word size — even
        // oversized words get a fresh line first, THEN break-word from there.
        // This matches browser behavior: break at space/word boundary before
        // breaking within a word.
        if (b.advanceX > 0 && b.advanceX + tok.advanceWidth > maxWidth) {
          // Leading spaces consumed the line; word wraps to next line.
          // This produces the "one blank line" behavior.
          pushLine(b);
          b = newLineBuilder();
        }
        // Clear any stale pending (should be empty, but safety)
        clearPending();
        b = placeWord(b, tok);
      }
    }

    // End of paragraph: any pending inter-word whitespace hangs (not laid out)
    clearPending();
    pushLine(b);
    b = newLineBuilder();
  }

  // Safety: at least one line (handles edge case of no paragraphs)
  if (lines.length === 0) {
    pushLine(newLineBuilder());
  }

  // --- Compute layout-level values ---

  // boxWidth:
  // - fixed: explicit container width
  // - auto: max advanceWidth (includes all spaces — no wrapping means nothing hangs)
  const boxWidth = wrap.mode === 'fixed'
    ? Math.max(0, wrap.width ?? 0)
    : maxAdvanceWidth;

  // Clamp ink bounds for all-empty documents
  if (!isFinite(ink[0])) { ink[0] = 0; ink[1] = 0; ink[2] = 0; ink[3] = fontSize; }

  const inkBBox: FrameTuple = [ink[0], ink[1], ink[2] - ink[0], ink[3] - ink[1]];

  const totalHeight = lines.length * lineHeight;
  const logicalBBox: FrameTuple = [0, 0, boxWidth, totalHeight];

  return {
    lines,
    fontSize,
    lineHeight,
    widthMode: wrap.mode,
    boxWidth,
    inkBBox,
    logicalBBox,
    structuralHash: content.structuralHash,
  };
}

// =============================================================================
// ALIGNMENT HELPERS (container-based, for both auto and fixed width)
// =============================================================================

function getBoxLeftX(originX: number, boxWidth: number, align: TextAlign): number {
  return originX - anchorFactor(align) * boxWidth;
}

function getLineStartX(originX: number, boxWidth: number, lineVisualWidth: number, align: TextAlign): number {
  const left = getBoxLeftX(originX, boxWidth, align);
  if (align === 'left') return left;
  if (align === 'center') return left + (boxWidth - lineVisualWidth) / 2;
  return left + (boxWidth - lineVisualWidth); // right
}

// =============================================================================
// CACHE: TextLayoutCache
//
// Three-tier invalidation:
//   invalidate(id)       — content changed: drop everything
//   invalidateLayout(id) — fontSize changed: keep tokens, drop measured + layout
//   invalidateFlow(id)   — width changed: keep tokens + measured, drop layout
// =============================================================================

interface CacheEntry {
  tokenized: TokenizedContent;

  measured: MeasuredContent;
  measuredFontSize: number;

  layout: TextLayout;
  layoutWidth: number;        // exact width used for this layout (-1 = auto)
  layoutWidthMode: WidthMode;

  frame: FrameTuple | null;   // derived world-coords frame, set by computeTextBBox
}

class TextLayoutCache {
  private cache = new Map<string, CacheEntry>();

  getLayout(
    objectId: string,
    fragment: Y.XmlFragment,
    fontSize: number,
    wrap: WrapConfig = DEFAULT_WRAP,
  ): TextLayout {
    const entry = this.cache.get(objectId);
    const wantWidth = wrap.mode === 'fixed' ? (wrap.width ?? 0) : -1;
    const wantMode = wrap.mode;

    if (!entry) {
      // Cold miss: full pipeline
      const parsed = parseYXmlFragment(fragment);
      const tokenized = tokenizeParsedContent(parsed);
      const measured = measureTokenizedContent(tokenized, fontSize);
      const layout = layoutMeasuredContent(measured, wrap);

      this.cache.set(objectId, {
        tokenized,
        measured,
        measuredFontSize: fontSize,
        layout,
        layoutWidth: wantWidth,
        layoutWidthMode: wantMode,
        frame: null,
      });
      return layout;
    }

    // FontSize changed → re-measure + re-flow
    if (entry.measuredFontSize !== fontSize) {
      entry.measured = measureTokenizedContent(entry.tokenized, fontSize);
      entry.measuredFontSize = fontSize;
      entry.layout = layoutMeasuredContent(entry.measured, wrap);
      entry.layoutWidth = wantWidth;
      entry.layoutWidthMode = wantMode;
      entry.frame = null;
      return entry.layout;
    }

    // Width or widthMode changed → re-flow only
    if (entry.layoutWidth !== wantWidth || entry.layoutWidthMode !== wantMode) {
      entry.layout = layoutMeasuredContent(entry.measured, wrap);
      entry.layoutWidth = wantWidth;
      entry.layoutWidthMode = wantMode;
      entry.frame = null;
      return entry.layout;
    }

    return entry.layout;
  }

  /** Content changed: drop everything */
  invalidate(objectId: string): void {
    this.cache.delete(objectId);
  }

  /** Alias for content changes */
  invalidateContent(objectId: string): void {
    this.cache.delete(objectId);
  }

  /** FontSize changed: keep tokenized, force re-measure + re-flow on next get */
  invalidateLayout(objectId: string): void {
    const e = this.cache.get(objectId);
    if (!e) return;
    e.measuredFontSize = -1;
    e.frame = null;
  }

  /** Width/widthMode changed: keep tokenized + measured, force re-flow on next get */
  invalidateFlow(objectId: string): void {
    const e = this.cache.get(objectId);
    if (!e) return;
    e.layoutWidth = NaN; // NaN !== NaN, forces re-flow
    e.frame = null;
  }

  setFrame(objectId: string, frame: FrameTuple): void {
    const e = this.cache.get(objectId);
    if (e) e.frame = frame;
  }

  getFrame(objectId: string): FrameTuple | null {
    return this.cache.get(objectId)?.frame ?? null;
  }

  clear(): void { this.cache.clear(); }
  has(objectId: string): boolean { return this.cache.has(objectId); }
}

export const textLayoutCache = new TextLayoutCache();

export function getTextFrame(objectId: string): FrameTuple | null {
  return textLayoutCache.getFrame(objectId);
}

// =============================================================================
// RENDERER: renderTextLayout
//
// Draws all runs, coalescing consecutive same-font runs into single fillText
// calls. Whitespace runs are drawn (fillText with spaces is a visual no-op)
// rather than skipped, so adjacent runs can be merged.
// =============================================================================

export function renderTextLayout(
  ctx: CanvasRenderingContext2D,
  layout: TextLayout,
  originX: number,
  originY: number,
  color: string,
  align: TextAlign = 'left',
): void {
  ctx.save();
  ctx.fillStyle = color;
  ctx.textBaseline = 'alphabetic';
  ctx.textRendering = 'optimizeSpeed';

  const { boxWidth } = layout;

  for (const line of layout.lines) {
    if (line.runs.length === 0) continue;

    const lineY = originY + line.baselineY;
    // Auto: spaces are real content → align on advanceWidth (matches per-line anchoring)
    // Fixed: trailing spaces hang → align on visualWidth (content within container)
    const lineW = layout.widthMode === 'auto' ? line.advanceWidth : line.visualWidth;
    const startX = getLineStartX(originX, boxWidth, lineW, align);

    for (const run of line.runs) {
      ctx.font = run.font;
      ctx.fillText(run.text, startX + run.advanceX, lineY);
    }
  }

  ctx.restore();
}

// =============================================================================
// BBOX COMPUTATION: computeTextBBox
//
// Returns BBoxTuple [left, top, right, bottom] in world coordinates.
// Also derives and caches the logical frame for hit testing / selection.
// =============================================================================

export function computeTextBBox(
  objectId: string,
  fragment: Y.XmlFragment,
  fontSize: number,
  origin: [number, number],
  align: TextAlign = 'left',
  wrap: WrapConfig = DEFAULT_WRAP,
): BBoxTuple {
  const layout = textLayoutCache.getLayout(objectId, fragment, fontSize, wrap);
  const [ox, oy] = origin;
  const padding = 2;

  // Container edges
  const boxLeft = getBoxLeftX(ox, layout.boxWidth, align);
  const boxRight = boxLeft + layout.boxWidth;

  let minX = boxLeft;
  let maxX = boxRight;

  for (const line of layout.lines) {
    if (line.isEmpty) continue;
    const lineW = layout.widthMode === 'auto' ? line.advanceWidth : line.visualWidth;
    const lx = getLineStartX(ox, layout.boxWidth, lineW, align);
    minX = Math.min(minX, lx + line.ink[0]); // ink left
    maxX = Math.max(maxX, lx + line.ink[2]); // ink right
  }

  // Derive and cache logical frame: [x, y, w, h]
  const fw = wrap.mode === 'fixed' ? layout.boxWidth : layout.logicalBBox[2];
  const fh = layout.logicalBBox[3];
  const fx = boxLeft;
  const fy = oy - fontSize * getBaselineToTopRatio();
  const frame: FrameTuple = [fx, fy, fw, fh];
  textLayoutCache.setFrame(objectId, frame);

  return [
    minX - padding,
    oy + layout.inkBBox[1] - padding,                       // inkBBox y
    maxX + padding,
    oy + layout.inkBBox[1] + layout.inkBBox[3] + padding,   // inkBBox y + h
  ];
}
```

---

## Key behavioral verification

### Case 1: `"hello     world"` (5 inter-word spaces, container barely fits `"hello "`)

```
Token stream: [word:"hello", space:"     ", word:"world"]

1. word "hello"  → b.hasInk=false, no pending. placeWord → commit.
   b = { advanceX: helloW, visualWidth: helloW, hasInk: true }

2. space "     " → b.hasInk=true → stashPending.
   pendingW = 5 * spaceW

3. word "world"  → b.hasInk=true, fixed width.
   Check: b.advanceX + pendingW + wordW ≤ maxWidth? → NO
   → clearPending() (spaces HANG)
   → pushLine(b) (line 1: "hello", visualWidth=helloW)
   → b = newLineBuilder()
   → placeWord: "world" fits on fresh line.
   b = { advanceX: worldW, visualWidth: worldW }

Result:
  Line 1: "hello"  (spaces are gone — they hung)
  Line 2: "world"  at x=0
  ✓ Matches DOM pre-wrap
```

### Case 2: Paragraph starts with spaces, word pushed to next line

```
Input: "          hello" (10 spaces + word, spaces overflow container)

Token stream: [space:"          ", word:"hello"]

1. space "          " → b.hasInk=false (leading) → commit immediately.
   b = { advanceX: 10*spaceW, hasInk: false }
   (overflows maxWidth — that's correct for pre-wrap leading spaces)

2. word "hello" → b.hasInk=false, b.advanceX > 0.
   Check: b.advanceX + tok.advanceWidth > maxWidth AND tok fits solo? → YES
   → pushLine(b) (line 1: spaces only, isEmpty=true, visually blank)
   → b = newLineBuilder()
   → placeWord: "hello" on fresh line at x=0.

Result:
  Line 1: "          " (visually blank — spaces committed but no ink)
  Line 2: "hello" at x=0
  ✓ One blank line only, regardless of space count
```

### Case 3: Trailing whitespace at paragraph end

```
Input: "hello    "

Token stream: [word:"hello", space:"    "]

1. word "hello" → committed. hasInk=true.
2. space "    " → hasInk=true → stashPending.
3. End of paragraph → clearPending() → pushLine.

Result:
  Line 1: "hello" only (trailing spaces hung)
  ✓ Matches DOM: trailing spaces don't affect layout
```

### Case 4: Leading spaces + oversized word (break-word after wrap)

```
Input: [Space 40px] + [WordSuperLong 60px], box = 50px

1. space (40px) → b.hasInk=false (leading) → committed immediately.
   b = { advanceX: 40, hasInk: false }

2. word (60px) → b.hasInk=false, enter else branch.
   Check: b.advanceX(40) > 0 AND 40+60 > 50 → YES
   → pushLine(b) (line 1: spaces only, visually blank)
   → b = newLineBuilder()

3. placeWord on fresh line:
   remaining = 50, tok.advanceWidth(60) > remaining → doesn't fit
   tok.advanceWidth(60) > maxWidth(50) → break-word path
   sliceTextToFit fills 50px, wraps remainder

Result:
  Line 1: [40px spaces]          ← visually blank
  Line 2: [50px of word]         ← full width used
  Line 3: [10px remainder]
  ✓ Browser wraps at space/word boundary BEFORE breaking within word
```

### Case 5: Break-word for oversized word (no leading spaces)

```
Input: "abcdefghijklmnopqrstuvwxyz" (wider than maxWidth)

1. Single word token, no pending spaces.
2. placeWord detects tok.advanceWidth > maxWidth.
3. sliceTextToFit splits at grapheme boundaries:
   Line 1: "abcdefghijk..." (as many graphemes as fit)
   Line 2: "lmnopqr..." (continue)
   Line N: remaining graphemes
   Each split guaranteed ≥1 grapheme → no infinite loop.
```

### Case 6: Mixed formatting mid-word

```
Input: "he<b>llo</b> world"
Parsed: [{text:"he", bold:false}, {text:"llo", bold:true}, {text:" world"}]

Tokenized: [
  word:{segments: [{text:"he",bold:false}, {text:"llo",bold:true}]},
  space:{segments: [{text:" "}]},
  word:{segments: [{text:"world"}]}
]

Each segment measured with its own font string.
Token advanceWidth = sum of segment widths.
Wrapping decisions use token-level width.
Rendering: each segment becomes a run (or coalesced if same font).
```

---

## Diff summary vs incomplete_plan.md

| Area | Old (incomplete_plan) | New |
|---|---|---|
| **Whitespace handling** | `appendWhitespaceSegment()` splits spaces across lines (break-spaces behavior) | Pending whitespace pattern: buffer, commit-or-hang |
| **InkBounds type** | `{ left, right, top, bottom }` object | `BBoxTuple` everywhere (same as existing codebase) |
| **Layout bbox types** | `{ x, y, width, height }` objects | `FrameTuple = [x, y, w, h]` tuple |
| **Ink expand** | Inline min/max | `expandBBox()` (existing helper, in-place mutation) |
| **Run coalescing** | None (each run = separate fillText) | `appendRun` coalesces same-font adjacent runs at build time; renderer is a simple run loop |
| **wrapKey** | `toFixed(2)` rounding | Exact `number` comparison (no rounding — width is precise) |
| **Cache width tracking** | `layoutKey: string` | `layoutWidth: number` + `layoutWidthMode: WidthMode` (numeric comparison, `NaN` trick for invalidation) |
| **Infinite loop safety** | `sliceTextToFit` forces 1 grapheme; maxWidth clamped | Same + pending space model never splits spaces (no space-splitting loop) |
| **Leading spaces** | Committed AND split across lines (could create multiple blank lines) | Committed as one unit, never split. At most one blank line before first word. |

---

## Call-site changes required

### room-doc-manager.ts — observer

```ts
// Existing:
if (field === 'content') {
  textLayoutCache.invalidate(id);
}
if (field === 'fontSize') {
  textLayoutCache.invalidateLayout(id);
}

// ADD:
if (field === 'width' || field === 'widthMode') {
  textLayoutCache.invalidateFlow(id);
}
```

### Anywhere calling `getLayout` / `computeTextBBox`

```ts
// Before:
const layout = textLayoutCache.getLayout(id, content, fontSize);

// After:
const widthMode = (y.get('widthMode') as WidthMode) ?? 'auto';
const width = y.get('width') as number | undefined;
const wrap: WrapConfig = widthMode === 'fixed' ? { mode: 'fixed', width } : { mode: 'auto' };
const layout = textLayoutCache.getLayout(id, content, fontSize, wrap);
```

Same pattern for `computeTextBBox` — pass `wrap` as last argument.

### Y.Map schema (TextTool.ts — createTextObject)

```ts
// Existing (no change needed — widthMode already set):
yObj.set('widthMode', 'auto');

// When creating fixed-width (future — e.g., from resize handle):
yObj.set('widthMode', 'fixed');
yObj.set('width', desiredWidth);
```