/**
 * TEXT LAYOUT SYSTEM
 *
 * The canonical "read this to understand text" module — pipeline + cache.
 * Three-stage pipeline: Tokenize → Measure → Layout
 *
 *   Y.XmlFragment
 *       ↓ parseAndTokenize()
 *   TokenizedContent (SOA)                  §2
 *       ↓ measureTokenizedContent()
 *   MeasuredContent (SOA)                   §3
 *       ↓ layoutMeasuredContent()
 *   TextLayout (SOA)                        §4
 *       ↓
 *   renderTextLayout()   canvas output      §6
 *   computeTextBBox()    spatial index      §7
 *
 * TextLayoutCache (§5) orchestrates all three stages with three-tier invalidation:
 *   content change  → re-tokenize + re-measure + re-layout
 *   fontSize change → re-measure + re-layout
 *   width change    → re-layout only
 *
 * Pooling: TokenizedContent / MeasuredContent / TextLayout are parallel-array (SOA)
 * buffers reused across re-tokenize / re-measure / re-flow on a per-id basis.
 *
 * Extracted siblings (kept out so this file stays the focused canonical read):
 *   line-break.ts   — UAX #14 soft-break machinery (nextSoftBreak)
 *   text-measure.ts — measure context, font-string builders, font metrics, measure caches
 *   shape-label.ts  — computeLabelTextBox + renderShapeLabel + label scratch
 */

import * as Y from 'yjs';
import type { FontFamily, TextAlign, TextAlignV, TextProps, TextWidth } from '../accessors';
import type { BBoxTuple, FrameTuple } from '../types/geometry';
import { FONT_FAMILIES } from './font-config';
import { nextSoftBreak } from './line-break';
import {
  buildFontMatrix,
  clearMeasurementCaches,
  fontFromMatrix,
  getBaselineToTopRatio,
  getCharEnds,
  getItalicOverhangPad,
  getSpaceWidth,
  measureTextCached,
} from './text-measure';

export type { FontFamily, TextAlign, TextAlignV, TextProps, TextWidth } from '../accessors';
export type { FontFamilyConfig } from './font-config';
export { FONT_FAMILIES, FONT_WEIGHTS } from './font-config';

// =============================================================================
// §1  TYPES — Pipeline data model (SOA)
// =============================================================================

export interface UniformStyles {
  allBold: boolean;
  allItalic: boolean;
  uniformHighlight: string | null; // color if uniform, null if none/mixed
}

// --- Stage 1 output: Tokenized (SOA) ---

// segSpaceMode: 0 = non-space, 1 = all-ASCII-space (charCode 32), 2 = mixed-WS
export interface TokenizedContent {
  uniformStyles: UniformStyles;
  paragraphCount: number;
  paragraphTokenStart: Uint32Array; // [paragraphCount + 1]
  tokenCount: number;
  tokenSegStart: Uint32Array; // [tokenCount + 1]
  tokenKind: Uint8Array; // 0 = word, 1 = space
  segCount: number;
  segText: string[];
  segBold: Uint8Array;
  segItalic: Uint8Array;
  segHighlight: (string | null)[];
  segSpaceMode: Uint8Array;
  // capacities (>= counts)
  paragraphCap: number;
  tokenCap: number;
  segCap: number;
}

// --- Stage 2 output: Measured (SOA) ---

export interface MeasuredContent {
  fontFamily: FontFamily;
  lineHeight: number;
  paragraphCount: number;
  paragraphTokenStart: Uint32Array;
  tokenCount: number;
  tokenSegStart: Uint32Array;
  tokenKind: Uint8Array;
  tokenAdvanceWidth: Float64Array;
  segCount: number;
  segText: string[];
  segFont: string[];
  segBold: Uint8Array;
  segItalic: Uint8Array;
  segHighlight: (string | null)[];
  segAdvanceWidth: Float64Array;
  segSpaceMode: Uint8Array;
  paragraphCap: number;
  tokenCap: number;
  segCap: number;
}

// --- Stage 3 output: Layout (SOA) ---

export interface TextLayout {
  fontSize: number;
  fontFamily: FontFamily;
  lineHeight: number;
  widthMode: 'auto' | 'fixed';
  boxWidth: number;

  // line data
  lineCount: number;
  lineCap: number;
  lineRunStart: Uint32Array; // [lineCap + 1]; runs of line i are [lineRunStart[i], lineRunStart[i+1])
  lineAdvanceWidth: Float64Array;
  // alignmentWidth: two behaviors:
  //   wrap-caused break  → b.visualWidth (trailing ws hangs)
  //   paragraph end      → min(advanceWidth, maxWidth) (trailing ws is content)
  lineAlignmentWidth: Float64Array;
  lineBaselineY: Float64Array; // i * lineHeight, cached for hot read

  // run data (parallel arrays)
  runCount: number;
  runCap: number;
  runText: string[];
  runFont: string[];
  runHighlight: (string | null)[];
  runAdvanceWidth: Float64Array;
  runAdvanceX: Float64Array;
}

// =============================================================================
// §2  TOKENIZE — Y.XmlFragment → TokenizedContent (SOA, in-place)
// =============================================================================

// Whitespace producing word-break opportunities. Excludes the NBSP family
// (U+00A0 NBSP, U+202F narrow NBSP, U+2007 figure space, U+2060 WJ, U+FEFF
// ZWNBSP) — those stay inside word tokens; the UAX#14 classifier (LB11/LB12)
// glues across them. Also excludes ZWSP (U+200B), which provides an in-word
// break opportunity via the ZW class instead.
const WS_FIRST_CHAR = /^[\t\n\v\f\r 　]/;
const TOKENIZE_SPLIT_RE = /([\t\n\v\f\r 　]+|[^\t\n\v\f\r 　]+)/g;

/** Compute spaceMode for a whitespace token's text: 1 if all chars === ' ', else 2. */
function classifySpaceText(text: string): number {
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) !== 32) return 2;
  }
  return 1;
}

function createTokenizedContent(): TokenizedContent {
  return {
    uniformStyles: { allBold: false, allItalic: false, uniformHighlight: null },
    paragraphCount: 0,
    paragraphTokenStart: new Uint32Array(8),
    tokenCount: 0,
    tokenSegStart: new Uint32Array(16),
    tokenKind: new Uint8Array(16),
    segCount: 0,
    segText: [],
    segBold: new Uint8Array(16),
    segItalic: new Uint8Array(16),
    segHighlight: [],
    segSpaceMode: new Uint8Array(16),
    paragraphCap: 8,
    tokenCap: 16,
    segCap: 16,
  };
}

function ensureTokenParaCap(t: TokenizedContent, n: number): void {
  if (t.paragraphCap >= n) return;
  let cap = t.paragraphCap;
  while (cap < n) cap *= 2;
  const next = new Uint32Array(cap + 1);
  next.set(t.paragraphTokenStart);
  t.paragraphTokenStart = next;
  t.paragraphCap = cap;
}
function ensureTokenTokCap(t: TokenizedContent, n: number): void {
  if (t.tokenCap >= n) return;
  let cap = t.tokenCap;
  while (cap < n) cap *= 2;
  const ns = new Uint32Array(cap + 1);
  ns.set(t.tokenSegStart);
  t.tokenSegStart = ns;
  const nk = new Uint8Array(cap);
  nk.set(t.tokenKind);
  t.tokenKind = nk;
  t.tokenCap = cap;
}
function ensureTokenSegCap(t: TokenizedContent, n: number): void {
  if (t.segCap >= n) return;
  let cap = t.segCap;
  while (cap < n) cap *= 2;
  if (t.segText.length < cap) t.segText.length = cap;
  if (t.segHighlight.length < cap) t.segHighlight.length = cap;
  const nb = new Uint8Array(cap);
  nb.set(t.segBold);
  t.segBold = nb;
  const ni = new Uint8Array(cap);
  ni.set(t.segItalic);
  t.segItalic = ni;
  const nm = new Uint8Array(cap);
  nm.set(t.segSpaceMode);
  t.segSpaceMode = nm;
  t.segCap = cap;
}

/** Push a segment into the current token. Coalesces with the prior segment if same style/kind. */
function pushSegmentSOA(t: TokenizedContent, kind: number, text: string, bold: boolean, italic: boolean, highlight: string | null): void {
  if (!text) return;
  const tokIdx = t.tokenCount - 1;
  // Coalesce with previous segment if same token-kind, same token, same style.
  if (tokIdx >= 0 && t.tokenKind[tokIdx] === kind && t.segCount > t.tokenSegStart[tokIdx]) {
    const lastSeg = t.segCount - 1;
    if (t.segBold[lastSeg] === (bold ? 1 : 0) && t.segItalic[lastSeg] === (italic ? 1 : 0) && t.segHighlight[lastSeg] === highlight) {
      t.segText[lastSeg] = t.segText[lastSeg] + text;
      if (kind === 1 && t.segSpaceMode[lastSeg] === 1) {
        // already all-space, only stays so if appended chars are all-space too
        if (classifySpaceText(text) !== 1) t.segSpaceMode[lastSeg] = 2;
      }
      return;
    }
  }
  // Need a new segment slot. If no current token of this kind, callers must already
  // have started one — pushSegmentSOA assumes a token slot is open.
  ensureTokenSegCap(t, t.segCount + 1);
  const s = t.segCount;
  t.segText[s] = text;
  t.segBold[s] = bold ? 1 : 0;
  t.segItalic[s] = italic ? 1 : 0;
  t.segHighlight[s] = highlight;
  t.segSpaceMode[s] = kind === 1 ? classifySpaceText(text) : 0;
  t.segCount = s + 1;
}

/** Open a new token of the given kind (sets segStart to current segCount). */
function openTokenSOA(t: TokenizedContent, kind: number): void {
  ensureTokenTokCap(t, t.tokenCount + 1);
  const i = t.tokenCount;
  t.tokenSegStart[i] = t.segCount;
  t.tokenKind[i] = kind;
  t.tokenCount = i + 1;
}

/** Push: opens a new token only if kind differs from last token in this paragraph. */
function pushSegmentBoundary(
  t: TokenizedContent,
  paraStartTok: number,
  kind: number,
  text: string,
  bold: boolean,
  italic: boolean,
  highlight: string | null,
): void {
  if (!text) return;
  const tokIdx = t.tokenCount - 1;
  if (tokIdx < paraStartTok || t.tokenKind[tokIdx] !== kind) {
    openTokenSOA(t, kind);
  }
  pushSegmentSOA(t, kind, text, bold, italic, highlight);
}

export function parseAndTokenize(fragment: Y.XmlFragment, out?: TokenizedContent): TokenizedContent {
  const t = out ?? createTokenizedContent();
  // reset
  t.paragraphCount = 0;
  t.tokenCount = 0;
  t.segCount = 0;
  // Free string slots above current count to avoid retaining old strings indefinitely.
  // Cap text array to last segCap; further re-tokenizes will overwrite slots.

  const children = fragment.toArray();

  let trackBold = true;
  let trackItalic = true;
  let hlColor: string | null | false = null; // null=unseen, false=mixed
  let hasAnyText = false;

  if (children.length === 0) {
    ensureTokenParaCap(t, t.paragraphCount + 1);
    t.paragraphTokenStart[t.paragraphCount] = t.tokenCount;
    t.paragraphCount++;
  } else {
    for (const child of children) {
      if (!(child instanceof Y.XmlElement) || child.nodeName !== 'paragraph') continue;
      ensureTokenParaCap(t, t.paragraphCount + 1);
      t.paragraphTokenStart[t.paragraphCount] = t.tokenCount;
      const paraStartTok = t.tokenCount;

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

          if (op.insert.length > 0) {
            hasAnyText = true;
            if (trackBold && !bold) trackBold = false;
            if (trackItalic && !italic) trackItalic = false;
            if (hlColor !== false) {
              if (hlColor === null) hlColor = highlight;
              else if (hlColor !== highlight) hlColor = false;
            }
          }

          // Inline tokenization — regex splits into whitespace/non-whitespace chunks.
          // First-char test determines kind (regex split is alternation of \s+|\S+, all-or-nothing).
          // /^\s/ on the first char handles Unicode whitespace (NBSP, etc.) correctly.
          TOKENIZE_SPLIT_RE.lastIndex = 0;
          let m: RegExpExecArray | null;
          while ((m = TOKENIZE_SPLIT_RE.exec(op.insert)) !== null) {
            const chunk = m[0];
            const kind = WS_FIRST_CHAR.test(chunk) ? 1 : 0;
            pushSegmentBoundary(t, paraStartTok, kind, chunk, bold, italic, highlight);
          }
        }
      }

      t.paragraphCount++;
    }
  }

  // Always close the array with a sentinel for half-open ranges.
  ensureTokenParaCap(t, t.paragraphCount + 1);
  t.paragraphTokenStart[t.paragraphCount] = t.tokenCount;
  ensureTokenTokCap(t, t.tokenCount + 1);
  t.tokenSegStart[t.tokenCount] = t.segCount;

  if (t.paragraphCount === 0) {
    ensureTokenParaCap(t, 2);
    t.paragraphTokenStart[0] = 0;
    t.paragraphTokenStart[1] = t.tokenCount;
    t.paragraphCount = 1;
  }

  t.uniformStyles.allBold = hasAnyText && trackBold;
  t.uniformStyles.allItalic = hasAnyText && trackItalic;
  t.uniformStyles.uniformHighlight = hasAnyText && typeof hlColor === 'string' ? hlColor : null;

  return t;
}

// =============================================================================
// §3  MEASURE — TokenizedContent → MeasuredContent (SOA, in-place)
// =============================================================================

function createMeasuredContent(): MeasuredContent {
  return {
    fontFamily: 'Grandstander',
    lineHeight: 0,
    paragraphCount: 0,
    paragraphTokenStart: new Uint32Array(8),
    tokenCount: 0,
    tokenSegStart: new Uint32Array(16),
    tokenKind: new Uint8Array(16),
    tokenAdvanceWidth: new Float64Array(16),
    segCount: 0,
    segText: [],
    segFont: [],
    segBold: new Uint8Array(16),
    segItalic: new Uint8Array(16),
    segHighlight: [],
    segAdvanceWidth: new Float64Array(16),
    segSpaceMode: new Uint8Array(16),
    paragraphCap: 8,
    tokenCap: 16,
    segCap: 16,
  };
}

function ensureMeasuredParaCap(m: MeasuredContent, n: number): void {
  if (m.paragraphCap >= n) return;
  let cap = m.paragraphCap;
  while (cap < n) cap *= 2;
  const next = new Uint32Array(cap + 1);
  next.set(m.paragraphTokenStart);
  m.paragraphTokenStart = next;
  m.paragraphCap = cap;
}
function ensureMeasuredTokCap(m: MeasuredContent, n: number): void {
  if (m.tokenCap >= n) return;
  let cap = m.tokenCap;
  while (cap < n) cap *= 2;
  const ns = new Uint32Array(cap + 1);
  ns.set(m.tokenSegStart);
  m.tokenSegStart = ns;
  const nk = new Uint8Array(cap);
  nk.set(m.tokenKind);
  m.tokenKind = nk;
  const naw = new Float64Array(cap);
  naw.set(m.tokenAdvanceWidth);
  m.tokenAdvanceWidth = naw;
  m.tokenCap = cap;
}
function ensureMeasuredSegCap(m: MeasuredContent, n: number): void {
  if (m.segCap >= n) return;
  let cap = m.segCap;
  while (cap < n) cap *= 2;
  if (m.segText.length < cap) m.segText.length = cap;
  if (m.segFont.length < cap) m.segFont.length = cap;
  if (m.segHighlight.length < cap) m.segHighlight.length = cap;
  const nb = new Uint8Array(cap);
  nb.set(m.segBold);
  m.segBold = nb;
  const ni = new Uint8Array(cap);
  ni.set(m.segItalic);
  m.segItalic = ni;
  const naw = new Float64Array(cap);
  naw.set(m.segAdvanceWidth);
  m.segAdvanceWidth = naw;
  const nsm = new Uint8Array(cap);
  nsm.set(m.segSpaceMode);
  m.segSpaceMode = nsm;
  m.segCap = cap;
}

function measureSegRaw(font: string, text: string, spaceMode: number): number {
  if (spaceMode === 1) return getSpaceWidth(font) * text.length;
  return measureTextCached(font, text);
}

export function measureTokenizedContent(
  content: TokenizedContent,
  fontSize: number,
  fontFamily: FontFamily = 'Grandstander',
  out?: MeasuredContent,
): MeasuredContent {
  const m = out ?? createMeasuredContent();
  m.fontFamily = fontFamily;
  m.lineHeight = fontSize * FONT_FAMILIES[fontFamily].lineHeightMultiplier;

  // Mirror SOA shapes
  ensureMeasuredParaCap(m, content.paragraphCount + 1);
  ensureMeasuredTokCap(m, content.tokenCount + 1);
  ensureMeasuredSegCap(m, content.segCount);

  m.paragraphCount = content.paragraphCount;
  for (let i = 0; i <= content.paragraphCount; i++) m.paragraphTokenStart[i] = content.paragraphTokenStart[i];

  m.tokenCount = content.tokenCount;
  for (let i = 0; i <= content.tokenCount; i++) m.tokenSegStart[i] = content.tokenSegStart[i];
  for (let i = 0; i < content.tokenCount; i++) m.tokenKind[i] = content.tokenKind[i];

  m.segCount = content.segCount;
  for (let i = 0; i < content.segCount; i++) {
    m.segText[i] = content.segText[i];
    m.segBold[i] = content.segBold[i];
    m.segItalic[i] = content.segItalic[i];
    m.segHighlight[i] = content.segHighlight[i];
    m.segSpaceMode[i] = content.segSpaceMode[i];
  }

  // Pre-build the four font strings (bold × italic)
  const F = buildFontMatrix(fontSize, fontFamily);

  // Measure each segment + sum into per-token advance width
  for (let ti = 0; ti < content.tokenCount; ti++) {
    const sStart = content.tokenSegStart[ti];
    const sEnd = content.tokenSegStart[ti + 1];
    let totalW = 0;
    for (let s = sStart; s < sEnd; s++) {
      const font = fontFromMatrix(F, m.segBold[s] !== 0, m.segItalic[s] !== 0);
      m.segFont[s] = font;
      const w = measureSegRaw(font, m.segText[s], m.segSpaceMode[s]);
      m.segAdvanceWidth[s] = w;
      totalW += w;
    }
    m.tokenAdvanceWidth[ti] = totalW;
  }

  return m;
}

// =============================================================================
// §4  LAYOUT — MeasuredContent → TextLayout (SOA, in-place)
// =============================================================================

const SLICE_RESULT = { head: '', tail: '', headW: 0 };

/** Binary search for largest prefix of `text[start..endChar]` fitting within maxW.
 *  Forces >=1 grapheme advance (or reaches `endChar`). Returns module scratch — consumers
 *  must read fields immediately. When `start > 0`, callers must ensure `start` lies on a
 *  grapheme boundary (true for cursors produced by previous slices or `nextSoftBreak`).
 *
 *  Each probe measures the actual candidate substring via `measureTextCached` rather than
 *  reading from a per-grapheme cumulative-widths table. The DOM shapes each broken line
 *  independently — line N's rendered width is `ctx.measureText(line_text).width`, including
 *  intra-line kerning but NO kerning across the break. Direct probing reproduces that exactly,
 *  so canvas char-break decisions match the DOM down to the subpixel. The previous summed
 *  per-grapheme widths overestimated by the cumulative kerning, evicting tail chars (e.g. a
 *  trailing '.') that the DOM would have kept on the line. */
export function sliceTextToFit(
  font: string,
  text: string,
  maxW: number,
  start: number = 0,
  endChar: number = text.length,
): { head: string; tail: string; headW: number } {
  if (start >= endChar) {
    SLICE_RESULT.head = '';
    SLICE_RESULT.tail = '';
    SLICE_RESULT.headW = 0;
    return SLICE_RESULT;
  }
  const charEnds = getCharEnds(text);

  // Find startIdx: smallest grapheme index where charEnds[startIdx] >= start.
  // Caller invariant guarantees start lies on a grapheme boundary, so equality holds.
  let startIdx = 0;
  if (start > 0) {
    let slo = 0,
      shi = charEnds.length - 1;
    while (slo < shi) {
      const mid = (slo + shi) >>> 1;
      if (charEnds[mid] < start) slo = mid + 1;
      else shi = mid;
    }
    startIdx = slo;
  }

  // Find endIdx: largest grapheme index where charEnds[endIdx] <= endChar.
  let endIdx = charEnds.length - 1;
  if (endChar < text.length) {
    let elo = startIdx,
      ehi = charEnds.length - 1;
    while (elo < ehi) {
      const mid = (elo + ehi + 1) >>> 1;
      if (charEnds[mid] <= endChar) elo = mid;
      else ehi = mid - 1;
    }
    endIdx = elo;
  }

  // Fast path: the whole [start..endIdx] fits in one shot. One measureText call.
  const fullCe = charEnds[endIdx];
  const fullSlice = text.substring(start, fullCe);
  const fullW = measureTextCached(font, fullSlice);
  if (fullW <= maxW) {
    SLICE_RESULT.head = fullSlice;
    SLICE_RESULT.tail = fullCe < text.length ? text.substring(fullCe) : '';
    SLICE_RESULT.headW = fullW;
    return SLICE_RESULT;
  }

  // Binary search probing actual candidate substrings — kerning-exact, DOM-faithful.
  let lo = startIdx,
    hi = endIdx;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    const w = measureTextCached(font, text.substring(start, charEnds[mid]));
    if (w <= maxW) lo = mid;
    else hi = mid - 1;
  }
  // Forward progress: at least one grapheme must advance even if oversized.
  // Reaching here implies fullW > maxW > 0 ⇒ endIdx > startIdx ⇒ startIdx + 1 ≤ endIdx.
  if (lo === startIdx) lo = startIdx + 1;
  const ce = charEnds[lo];
  const head = text.substring(start, ce);
  SLICE_RESULT.head = head;
  SLICE_RESULT.tail = text.substring(ce);
  SLICE_RESULT.headW = measureTextCached(font, head); // typically a cache hit from probe
  return SLICE_RESULT;
}

// --- Layout buffer helpers ---

export function createTextLayout(initialLineCap: number = 8, initialRunCap: number = 16): TextLayout {
  return {
    fontSize: 0,
    fontFamily: 'Grandstander',
    lineHeight: 0,
    widthMode: 'auto',
    boxWidth: 0,
    lineCount: 0,
    lineCap: initialLineCap,
    lineRunStart: new Uint32Array(initialLineCap + 1),
    lineAdvanceWidth: new Float64Array(initialLineCap),
    lineAlignmentWidth: new Float64Array(initialLineCap),
    lineBaselineY: new Float64Array(initialLineCap),
    runCount: 0,
    runCap: initialRunCap,
    runText: new Array(initialRunCap),
    runFont: new Array(initialRunCap),
    runHighlight: new Array(initialRunCap),
    runAdvanceWidth: new Float64Array(initialRunCap),
    runAdvanceX: new Float64Array(initialRunCap),
  };
}

export function resetTextLayout(l: TextLayout): void {
  l.lineCount = 0;
  l.runCount = 0;
}

function ensureLineCap(l: TextLayout, n: number): void {
  if (l.lineCap >= n) return;
  let cap = l.lineCap;
  while (cap < n) cap *= 2;
  const nrs = new Uint32Array(cap + 1);
  nrs.set(l.lineRunStart);
  l.lineRunStart = nrs;
  const naw = new Float64Array(cap);
  naw.set(l.lineAdvanceWidth);
  l.lineAdvanceWidth = naw;
  const nalw = new Float64Array(cap);
  nalw.set(l.lineAlignmentWidth);
  l.lineAlignmentWidth = nalw;
  const nby = new Float64Array(cap);
  nby.set(l.lineBaselineY);
  l.lineBaselineY = nby;
  l.lineCap = cap;
}

function ensureRunCap(l: TextLayout, n: number): void {
  if (l.runCap >= n) return;
  let cap = l.runCap;
  while (cap < n) cap *= 2;
  if (l.runText.length < cap) l.runText.length = cap;
  if (l.runFont.length < cap) l.runFont.length = cap;
  if (l.runHighlight.length < cap) l.runHighlight.length = cap;
  const naw = new Float64Array(cap);
  naw.set(l.runAdvanceWidth);
  l.runAdvanceWidth = naw;
  const nax = new Float64Array(cap);
  nax.set(l.runAdvanceX);
  l.runAdvanceX = nax;
  l.runCap = cap;
}

// --- Module-scope LineBuilder scratch (single-threaded; one layout call at a time). ---
const _b = { advanceX: 0, visualWidth: 0, hasInk: false, runStart: 0 };
function resetBuilder(runStart: number): void {
  _b.advanceX = 0;
  _b.visualWidth = 0;
  _b.hasInk = false;
  _b.runStart = runStart;
}

function appendRun(l: TextLayout, font: string, highlight: string | null, isWs: boolean, text: string, w: number): void {
  if (!text) return;
  const ri = l.runCount - 1;
  if (ri >= _b.runStart && l.runFont[ri] === font && l.runHighlight[ri] === highlight) {
    l.runText[ri] = l.runText[ri] + text;
    l.runAdvanceWidth[ri] = l.runAdvanceWidth[ri] + w;
    if (!isWs) {
      _b.hasInk = true;
      _b.visualWidth = l.runAdvanceX[ri] + l.runAdvanceWidth[ri];
    }
    _b.advanceX += w;
    return;
  }
  ensureRunCap(l, l.runCount + 1);
  const r = l.runCount;
  l.runText[r] = text;
  l.runFont[r] = font;
  l.runHighlight[r] = highlight;
  l.runAdvanceWidth[r] = w;
  l.runAdvanceX[r] = _b.advanceX;
  l.runCount = r + 1;
  if (!isWs) {
    _b.hasInk = true;
    _b.visualWidth = _b.advanceX + w;
  }
  _b.advanceX += w;
}

function appendAllSegments(l: TextLayout, m: MeasuredContent, ti: number, isWs: boolean): void {
  const sStart = m.tokenSegStart[ti];
  const sEnd = m.tokenSegStart[ti + 1];
  for (let s = sStart; s < sEnd; s++) {
    appendRun(l, m.segFont[s], m.segHighlight[s], isWs, m.segText[s], m.segAdvanceWidth[s]);
  }
}

function pushLine(l: TextLayout): void {
  ensureLineCap(l, l.lineCount + 1);
  const li = l.lineCount;
  l.lineRunStart[li + 1] = l.runCount;
  l.lineAdvanceWidth[li] = _b.advanceX;
  l.lineAlignmentWidth[li] = _b.visualWidth;
  l.lineBaselineY[li] = li * l.lineHeight;
  l.lineCount = li + 1;
  resetBuilder(l.runCount);
}

function fixupParagraphEnd(l: TextLayout, maxWidth: number): void {
  if (l.lineCount === 0) return;
  const i = l.lineCount - 1;
  const aw = l.lineAdvanceWidth[i];
  l.lineAlignmentWidth[i] = aw < maxWidth ? aw : maxWidth;
}

// --- Pending whitespace state ---
const _pending: { segIdx: Int32Array; count: number; totalW: number } = {
  segIdx: new Int32Array(64),
  count: 0,
  totalW: 0,
};

function ensurePendingCap(n: number): void {
  if (_pending.segIdx.length >= n) return;
  let cap = _pending.segIdx.length;
  while (cap < n) cap *= 2;
  const next = new Int32Array(cap);
  next.set(_pending.segIdx);
  _pending.segIdx = next;
}

function clearPending(): void {
  _pending.count = 0;
  _pending.totalW = 0;
}

function stashPending(m: MeasuredContent, ti: number): void {
  const sStart = m.tokenSegStart[ti];
  const sEnd = m.tokenSegStart[ti + 1];
  ensurePendingCap(_pending.count + (sEnd - sStart));
  for (let s = sStart; s < sEnd; s++) {
    _pending.segIdx[_pending.count++] = s;
    _pending.totalW += m.segAdvanceWidth[s];
  }
}

function commitPending(m: MeasuredContent, l: TextLayout): void {
  for (let i = 0; i < _pending.count; i++) {
    const s = _pending.segIdx[i];
    appendRun(l, m.segFont[s], m.segHighlight[s], true, m.segText[s], m.segAdvanceWidth[s]);
  }
  clearPending();
}

/** Place a word token on the current line.
 *
 *  Fast path: whole word fits remaining → drop in atomic. Otherwise drive a
 *  per-sub-segment Q1/Q2/Q3 ladder over the soft-break opportunities so that
 *  intra-word break points (HY, BA, OP candidate, etc.) are honored before
 *  falling back to char-slicing. Q3 is unreachable when `tokAdvance <= maxWidth`
 *  because no sub-segment can exceed the whole-word width. */
function placeWord(m: MeasuredContent, l: TextLayout, ti: number, maxWidth: number): void {
  const tokAdvance = m.tokenAdvanceWidth[ti];
  const sStart = m.tokenSegStart[ti];
  const sEnd = m.tokenSegStart[ti + 1];

  if (maxWidth === Infinity || tokAdvance <= maxWidth - _b.advanceX) {
    appendAllSegments(l, m, ti, false);
    return;
  }

  // Per-sub-segment Q1/Q2/Q3 ladder. Cut the word at UAX#14 soft-break
  // opportunities and ask, for each chunk in order: fits current line, fits a
  // fresh empty line, or oversized → char-slice across as many lines as needed.
  for (let s = sStart; s < sEnd; s++) {
    const font = m.segFont[s];
    const highlight = m.segHighlight[s];
    const fullText = m.segText[s];
    let cursor = 0;
    while (cursor < fullText.length) {
      const segEnd = nextSoftBreak(fullText, cursor);
      const chunk = fullText.substring(cursor, segEnd);
      const chunkW = measureTextCached(font, chunk);
      const lineRemaining = maxWidth - _b.advanceX;

      // Q1: fits the current line as-is.
      if (chunkW <= lineRemaining) {
        appendRun(l, font, highlight, false, chunk, chunkW);
        cursor = segEnd;
        continue;
      }
      // Q2: fits a fresh empty line.
      if (chunkW <= maxWidth) {
        if (l.runCount > _b.runStart) pushLine(l);
        appendRun(l, font, highlight, false, chunk, chunkW);
        cursor = segEnd;
        continue;
      }
      // Q3: oversized chunk — char-slice. Always start on a fresh line if dirty.
      if (l.runCount > _b.runStart) pushLine(l);
      while (cursor < segEnd) {
        const r = sliceTextToFit(font, fullText, maxWidth - _b.advanceX, cursor, segEnd);
        appendRun(l, font, highlight, false, r.head, r.headW);
        cursor += r.head.length;
        if (cursor < segEnd) pushLine(l);
      }
      // Tail of slicing sits on the current line; next outer iter handles the next sub-segment.
    }
  }
}

export function layoutMeasuredContent(content: MeasuredContent, width: TextWidth, fontSize: number, out?: TextLayout): TextLayout {
  const layout = out ?? createTextLayout();
  resetTextLayout(layout);
  layout.fontSize = fontSize;
  layout.fontFamily = content.fontFamily;
  layout.lineHeight = content.lineHeight;

  const isFixed = typeof width === 'number';
  const maxWidth = isFixed ? Math.max(0.01, width) : Infinity;

  // Sentinel for half-open run range: lineRunStart[0] = 0
  ensureLineCap(layout, 1);
  layout.lineRunStart[0] = 0;
  resetBuilder(0);
  clearPending();

  let maxAdvanceWidth = 0;

  for (let pi = 0; pi < content.paragraphCount; pi++) {
    const tStart = content.paragraphTokenStart[pi];
    const tEnd = content.paragraphTokenStart[pi + 1];
    if (tStart === tEnd) {
      clearPending();
      pushLine(layout);
      fixupParagraphEnd(layout, maxWidth);
      continue;
    }
    for (let ti = tStart; ti < tEnd; ti++) {
      const isSpaceTok = content.tokenKind[ti] === 1;
      if (isSpaceTok) {
        if (!_b.hasInk) {
          // LEADING ws — commit immediately (can overflow)
          appendAllSegments(layout, content, ti, true);
        } else if (maxWidth === Infinity) {
          appendAllSegments(layout, content, ti, true);
        } else {
          stashPending(content, ti);
        }
        continue;
      }
      // WORD token. Commit pending inter-word WS to the current line and let
      // placeWord drive the per-sub-segment ladder. Pre-emptive line pushes
      // here would mask intra-word break opportunities (e.g. the `-` inside
      // `Char-level` when only `Char-` fits on the current line).
      if (_b.hasInk) {
        if (_pending.totalW > 0) commitPending(content, layout);
      } else {
        clearPending();
      }
      placeWord(content, layout, ti, maxWidth);
    }
    commitPending(content, layout);
    pushLine(layout);
    fixupParagraphEnd(layout, maxWidth);
  }
  if (layout.lineCount === 0) {
    pushLine(layout);
  }

  for (let i = 0; i < layout.lineCount; i++) {
    if (layout.lineAdvanceWidth[i] > maxAdvanceWidth) maxAdvanceWidth = layout.lineAdvanceWidth[i];
  }

  layout.widthMode = isFixed ? 'fixed' : 'auto';
  layout.boxWidth = isFixed ? Math.max(0.01, width as number) : maxAdvanceWidth;

  return layout;
}

// =============================================================================
// §5  CACHE — Three-tier orchestration (tokenize → measure → layout)
// =============================================================================

interface CacheEntry {
  tokenized: TokenizedContent | null; // null = content stale; non-null = pooled buffer
  measured: MeasuredContent; // pooled buffer (always allocated)
  measuredFontSize: number | null; // null = fontSize stale
  measuredFontFamily: FontFamily | null; // null = fontFamily stale
  layout: TextLayout; // pooled buffer (always allocated)
  layoutWidth: TextWidth | null; // null = width stale
  frame: FrameTuple | null;
  noteDerivedFontSize: number | null; // null = stale; set by sticky-note path
}

class TextLayoutCache {
  private cache = new Map<string, CacheEntry>();

  /** Get or compute layout for a text object. Three-tier cache: content → measurement → flow. */
  getLayout(
    objectId: string,
    fragment: Y.XmlFragment,
    fontSize: number,
    fontFamily: FontFamily = 'Grandstander',
    width: TextWidth = 'auto',
  ): TextLayout {
    const entry = this.cache.get(objectId);

    // Hit
    if (
      entry &&
      entry.tokenized !== null &&
      entry.measuredFontSize === fontSize &&
      entry.measuredFontFamily === fontFamily &&
      entry.layoutWidth === width
    ) {
      return entry.layout;
    }

    // Width changed only — re-flow into cached layout
    if (entry && entry.tokenized !== null && entry.measuredFontSize === fontSize && entry.measuredFontFamily === fontFamily) {
      const layout = layoutMeasuredContent(entry.measured, width, fontSize, entry.layout);
      entry.layout = layout;
      entry.layoutWidth = width;
      entry.frame = null;
      return layout;
    }

    // Font size or family changed — re-measure + re-flow
    if (entry && entry.tokenized !== null) {
      const measured = measureTokenizedContent(entry.tokenized, fontSize, fontFamily, entry.measured);
      const layout = layoutMeasuredContent(measured, width, fontSize, entry.layout);
      entry.measured = measured;
      entry.measuredFontSize = fontSize;
      entry.measuredFontFamily = fontFamily;
      entry.layout = layout;
      entry.layoutWidth = width;
      entry.frame = null;
      return layout;
    }

    // Full pipeline (no entry or content stale).
    if (entry) {
      const tokBuf = entry.tokenized ?? createTokenizedContent();
      const tokenized = parseAndTokenize(fragment, tokBuf);
      const measured = measureTokenizedContent(tokenized, fontSize, fontFamily, entry.measured);
      const layout = layoutMeasuredContent(measured, width, fontSize, entry.layout);
      entry.tokenized = tokenized;
      entry.measured = measured;
      entry.measuredFontSize = fontSize;
      entry.measuredFontFamily = fontFamily;
      entry.layout = layout;
      entry.layoutWidth = width;
      entry.frame = null;
      return layout;
    }

    // No entry — fresh allocation
    const tokenized = parseAndTokenize(fragment);
    const measured = measureTokenizedContent(tokenized, fontSize, fontFamily);
    const layout = layoutMeasuredContent(measured, width, fontSize);
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

    return layout;
  }

  /** Content invalidation. When fragment provided, eagerly re-tokenizes into pooled buffer. */
  invalidateContent(objectId: string, fragment?: Y.XmlFragment): void {
    const e = this.cache.get(objectId);
    if (!e) return;
    if (fragment) {
      const tokBuf = e.tokenized ?? createTokenizedContent();
      e.tokenized = parseAndTokenize(fragment, tokBuf);
    } else {
      e.tokenized = null;
    }
    e.measuredFontSize = null;
    e.noteDerivedFontSize = null;
    e.frame = null;
  }

  invalidateLayout(objectId: string): void {
    const e = this.cache.get(objectId);
    if (e) {
      e.measuredFontSize = null;
      e.frame = null;
    }
  }

  invalidateFlow(objectId: string): void {
    const e = this.cache.get(objectId);
    if (e) {
      e.layoutWidth = null;
      e.frame = null;
    }
  }

  evict(objectId: string): void {
    this.cache.delete(objectId);
  }

  clear(): void {
    this.cache.clear();
    clearMeasurementCaches();
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

  getMeasuredContent(objectId: string): MeasuredContent | null {
    return this.cache.get(objectId)?.measured ?? null;
  }

  /**
   * Pure cache read for the renderer hot path. Returns the pooled `layout` buffer
   * for `objectId` if an entry exists, else null. The observer pipeline guarantees
   * the layout is fresh whenever `objectsById.get(id)` resolves, so the renderer
   * skips the staleness probe.
   */
  getLayoutById(objectId: string): TextLayout | null {
    return this.cache.get(objectId)?.layout ?? null;
  }

  getInlineStyles(objectId: string): UniformStyles | null {
    return this.cache.get(objectId)?.tokenized?.uniformStyles ?? null;
  }

  // ── Sticky-note bridge — narrow, allocation-free accessors ──

  noteCachedTokenized(objectId: string): TokenizedContent | null {
    return this.cache.get(objectId)?.tokenized ?? null;
  }

  noteCachedMeasured(objectId: string): MeasuredContent | null {
    const e = this.cache.get(objectId);
    return e ? e.measured : null;
  }

  noteCachedFontFamily(objectId: string): FontFamily | null {
    return this.cache.get(objectId)?.measuredFontFamily ?? null;
  }

  noteCachedDerivedFontSize(objectId: string): number | null {
    return this.cache.get(objectId)?.noteDerivedFontSize ?? null;
  }

  noteCachedLayout(objectId: string): TextLayout | null {
    return this.cache.get(objectId)?.layout ?? null;
  }

  /** Single setter used by sticky-note's getNoteLayout. Initializes entry on first call. */
  setNoteResults(
    objectId: string,
    tokenized: TokenizedContent,
    measured: MeasuredContent,
    fontFamily: FontFamily,
    derivedFontSize: number,
    layout: TextLayout,
  ): void {
    const e = this.cache.get(objectId);
    if (e) {
      e.tokenized = tokenized;
      e.measured = measured;
      e.measuredFontFamily = fontFamily;
      e.noteDerivedFontSize = derivedFontSize;
      e.layout = layout;
      e.frame = null;
      // Note layouts run at base dims (no fontSize/width tracking) — keep these null
      // so a later text-style getLayout() call would re-pipeline if needed.
      return;
    }
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
}

export const textLayoutCache = new TextLayoutCache();

// =============================================================================
// §6  OUTPUT — Alignment, rendering, spatial index
// =============================================================================

export function anchorFactor(align: TextAlign): number {
  return align === 'left' ? 0 : align === 'center' ? 0.5 : 1;
}

function getBoxLeftX(originX: number, boxWidth: number, align: TextAlign): number {
  return originX - anchorFactor(align) * boxWidth;
}

export function getLineStartX(originX: number, boxWidth: number, lineVisualWidth: number, align: TextAlign): number {
  const left = getBoxLeftX(originX, boxWidth, align);
  if (align === 'left') return left;
  if (align === 'center') return left + (boxWidth - lineVisualWidth) / 2;
  return left + (boxWidth - lineVisualWidth);
}

/** Vertical offset for constrained-box content alignment (matches CSS clamp behavior).
 *  Shared by sticky-note rendering and shape-label rendering. */
export function getNoteContentOffsetY(alignV: TextAlignV, maxContentH: number, contentH: number): number {
  if (alignV === 'top') return 0;
  const space = Math.max(0, maxContentH - contentH);
  return alignV === 'middle' ? space / 2 : space;
}

// --- Renderer ---

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

  const { boxWidth, fontSize, fontFamily, lineHeight, lineCount } = layout;
  const baselineToTop = getBaselineToTopRatio(fontFamily) * fontSize;
  const isFixed = layout.widthMode === 'fixed';
  const containerLeft = isFixed ? getBoxLeftX(originX, boxWidth, align) : 0;
  const containerRight = isFixed ? containerLeft + boxWidth : 0;

  if (fillColor) {
    const blockLeft = getBoxLeftX(originX, boxWidth, align);
    const blockTop = originY - baselineToTop;
    const blockHeight = lineCount * lineHeight;
    ctx.fillStyle = fillColor;
    ctx.fillRect(blockLeft, blockTop, boxWidth, blockHeight);
  }

  const hlR = fontSize * 0.25;
  let lastFont = '';
  for (let li = 0; li < lineCount; li++) {
    const startRun = layout.lineRunStart[li];
    const endRun = layout.lineRunStart[li + 1];
    if (startRun === endRun) continue;
    const lineY = originY + layout.lineBaselineY[li];
    const lineW = isFixed ? layout.lineAlignmentWidth[li] : layout.lineAdvanceWidth[li];
    const startX = getLineStartX(originX, boxWidth, lineW, align);

    // Pass 1: highlights
    for (let r = startRun; r < endRun; r++) {
      const hl = layout.runHighlight[r];
      if (!hl) continue;
      ctx.fillStyle = hl;
      const hlX = startX + layout.runAdvanceX[r];
      const hlY = lineY - baselineToTop;
      const runW = layout.runAdvanceWidth[r];
      if (isFixed) {
        const hlEnd = hlX + runW;
        const clL = Math.max(hlX, containerLeft);
        const clR = Math.min(hlEnd, containerRight);
        if (clR > clL) {
          const rL = clL > hlX ? 0 : hlR,
            rR = clR < hlEnd ? 0 : hlR;
          ctx.beginPath();
          ctx.roundRect(clL, hlY, clR - clL, lineHeight, [rL, rR, rR, rL]);
          ctx.fill();
        }
      } else {
        ctx.beginPath();
        ctx.roundRect(hlX, hlY, runW, lineHeight, hlR);
        ctx.fill();
      }
    }

    // Pass 2: text
    ctx.fillStyle = color;
    for (let r = startRun; r < endRun; r++) {
      const f = layout.runFont[r];
      if (f !== lastFont) {
        ctx.font = f;
        lastFont = f;
      }
      ctx.fillText(layout.runText[r], startX + layout.runAdvanceX[r], lineY);
    }
  }
  ctx.restore();
}

// =============================================================================
// §7  SPATIAL — Derived frame / BBox for text objects
// =============================================================================

export function computeTextBBox(objectId: string, props: TextProps): BBoxTuple {
  const { content, origin, fontSize, fontFamily, align, width } = props;
  const layout = textLayoutCache.getLayout(objectId, content, fontSize, fontFamily, width);
  const [ox, oy] = origin;
  const fx = getBoxLeftX(ox, layout.boxWidth, align);
  const fy = oy - fontSize * getBaselineToTopRatio(fontFamily);
  const fh = layout.lineCount * layout.lineHeight;
  textLayoutCache.setFrame(objectId, [fx, fy, layout.boxWidth, fh]);
  const padH = getItalicOverhangPad(fontSize);
  return [fx - padH, fy - 2, fx + layout.boxWidth + padH, fy + fh + 2];
}

export function getTextFrame(objectId: string): FrameTuple | null {
  return textLayoutCache.getFrame(objectId);
}

export function getInlineStyles(objectId: string): UniformStyles | null {
  return textLayoutCache.getInlineStyles(objectId);
}
