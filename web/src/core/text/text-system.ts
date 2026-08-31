/**
 * TEXT LAYOUT SYSTEM — pipeline + facade over the SoA text store
 *
 * Three-stage pipeline: Tokenize → Measure → Flow, all operating on the
 * cross-entry pooled storage in `text-store.ts` (one set of global typed-array
 * lanes for EVERY entry, addressed by per-slot base offsets — no per-id buffer
 * objects, no nested heap layout, no view descriptors: an entry is addressed
 * by its slot int everywhere, including across a transform gesture).
 *
 *   Y.XmlFragment
 *       ↓ tokenizeFragment() → staging          §2
 *       ↓ commitTokenizedToSlot(ts)             (content tier: topology + text + style)
 *       ↓ measureSlot(ts, fontSize, famCode)    §3  — IN PLACE over the pool:
 *                                                    writes only the advance-width
 *                                                    and font-index lanes
 *       ↓ flowSlotContent(ts, maxWidth) → staging    §4
 *       ↓ commitFlowToSlot(ts, …)               (layout tier: lines + runs)
 *       ↓ renderRunsForSlot()                   §6  canvas output
 *       ↓ computeTextBBox()                     §7  spatial index
 *
 * The flow engine (`flowSlotContent`) is ONE monolithic body, FlatRTree-query
 * style: pool lanes and staging arrays hoisted into locals once, every scalar
 * of the line builder and the pending-whitespace machine in locals (register
 * traffic, not module-slot traffic), and the whole word-placement ladder
 * inlined — the only calls that survive are the true leaves (measureText,
 * sliceTextToFit, nextSoftBreak, isBreakOpportunity) and the rare staging
 * growers, after which the hoisted refs are refreshed. Its staged output is
 * committed to a pool range (`commitFlowToSlot`), to a caller-owned
 * `TextLayout` (`layoutSlotContent` — the transform reflow sidecar), or
 * rendered straight from staging (`renderRunsFromStaging` — label transform
 * preview; no per-frame layout buffer exists anywhere).
 *
 * Staleness is columnar, sentinel-driven (see text-store header): NaN
 * measuredFontSize fails the `=== fontSize` compare exactly like a stale tag,
 * Infinity layoutWidthReq encodes 'auto' AND the flow maxWidth in one value,
 * and NaN probes are raw self-compares (`w !== w`) — Number.isNaN is a global
 * + property load + call in the tiers that matter. Status-word masks are
 * source literals (module consts don't constant-fold): bit0 CONTENT_VALID,
 * bit1 ALL_BOLD, bit2 ALL_ITALIC, famCode byte at << 8, uniform-highlight
 * intern idx at << 16 — `(status & 0xff01) === (famCode << 8 | 1)` is the
 * fused content-valid + family probe. The three-tier invalidation contract is
 * unchanged:
 *   content change  → re-tokenize + re-measure + re-flow   (observer-driven)
 *   fontSize/family → re-measure + re-flow                 (compare-detected)
 *   width change    → re-flow only                         (compare-detected)
 * (`keysChanged` forwarding was considered instead of compare-detection and
 * deliberately NOT adopted: shape/connector labels populate lazily from the
 * draw path, so an observer-side keysChanged router would need a per-kind
 * eager hook — a load-bearing observer change for zero fewer compares.)
 *
 * Fonts are interned lazily (`text-measure.ts`): segments and runs carry u16
 * font indices, ctx.font changes are int compares, and no font string is ever
 * built for a (size, family, style) combination the content doesn't use.
 * Highlights intern the same way (index 0 = none, so `if (hl !== 0)` replaces
 * the old null probe).
 *
 * Extracted siblings: text-store.ts (data plane) · line-break.ts (UAX #14) ·
 * text-measure.ts (measure ctx, interning, metrics) · shape-label.ts ·
 * sticky-note.ts.
 */

import * as Y from 'yjs';
import type { FontFamily, TextAlign, TextAlignV, TextProps, TextWidth } from '../accessors';
import type { BBoxTuple, FrameTuple } from '../types/geometry';
import { famCodeOf, LINE_HEIGHT_MULT } from './font-config';
import { isBreakOpportunity, nextSoftBreak } from './line-break';
import {
  beginFontQuad,
  clearMeasurementCaches,
  FONT_STRINGS,
  getBaselineToTopRatioByCode,
  getCharEnds,
  getItalicOverhangPad,
  measureTextByIdx,
  quadFontIdx,
  resetFontTable,
  spaceWidthByIdx,
} from './text-measure';
import {
  allocContentRanges,
  allocLayoutRanges,
  ensureTextSlot,
  frameTupleOf,
  getFrameCol,
  getLineAdvW,
  getLineAlignW,
  getLineRunStart,
  getParaTok,
  getR,
  getRunAdvW,
  getRunAdvX,
  getRunFontIdx,
  getRunHl,
  getRunText,
  getS,
  getSegAdvW,
  getSegFontIdx,
  getSegHl,
  getSegStyle,
  getSegText,
  getTokAdvW,
  getTokSeg,
  HL_STRINGS,
  internHighlight,
  releaseTextSlot,
  resetTextStore,
  textSlotFast,
  textSlotOf,
} from './text-store';

export type { FontFamily, TextAlign, TextAlignV, TextProps, TextWidth } from '../accessors';
export type { FontFamilyConfig } from './font-config';
export { FONT_FAMILIES, FONT_WEIGHTS } from './font-config';
export { textSlotFast, textSlotOf } from './text-store';

// =============================================================================
// §1  TYPES
// =============================================================================

export interface UniformStyles {
  allBold: boolean;
  allItalic: boolean;
  uniformHighlight: string | null; // color if uniform, null if none/mixed
}

/**
 * Standalone layout buffer — the transform-shim twin of a slot's layout tier
 * (same lane shapes, base 0). The reflow sidecar owns one per gesture entry and
 * reuses it across pointermoves; `lineCount` is directly writable (the engine
 * zeroes it at freeze as its stale-glyph guard).
 */
export interface TextLayout {
  fontSize: number;
  famCode: number;
  lineHeight: number;
  boxWidth: number;
  maxWidthReq: number; // Infinity = auto — same encoding as the store's widthReq

  lineCount: number;
  lineCap: number;
  lineRunStart: Uint32Array; // [lineCap + 1]; runs of line i are [lineRunStart[i], lineRunStart[i+1])
  lineAdvW: Float64Array;
  lineAlignW: Float64Array;

  runCount: number;
  runCap: number;
  runText: string[];
  runFontIdx: Uint16Array;
  runHl: Uint16Array;
  runAdvW: Float64Array;
  runAdvX: Float64Array;
}

export function createTextLayout(initialLineCap: number = 8, initialRunCap: number = 16): TextLayout {
  const runText: string[] = new Array(initialRunCap).fill('');
  return {
    fontSize: 0,
    famCode: 0,
    lineHeight: 0,
    boxWidth: 0,
    maxWidthReq: Infinity,
    lineCount: 0,
    lineCap: initialLineCap,
    lineRunStart: new Uint32Array(initialLineCap + 1),
    lineAdvW: new Float64Array(initialLineCap),
    lineAlignW: new Float64Array(initialLineCap),
    runCount: 0,
    runCap: initialRunCap,
    runText,
    runFontIdx: new Uint16Array(initialRunCap),
    runHl: new Uint16Array(initialRunCap),
    runAdvW: new Float64Array(initialRunCap),
    runAdvX: new Float64Array(initialRunCap),
  };
}

/** Layout scalars for one entry — module scratch returned by the facade's
 *  scalar readers. Consume before the next scalar-returning call. */
export interface TextLayoutScalars {
  slot: number;
  fontSize: number;
  famCode: number;
  lineHeight: number;
  lineCount: number;
  boxWidth: number;
}

const _scalars: TextLayoutScalars = { slot: -1, fontSize: 0, famCode: 0, lineHeight: 0, lineCount: 0, boxWidth: 0 };

function fillScalars(ts: number): TextLayoutScalars {
  const S = getS();
  const R = getR();
  const b8 = ts << 3;
  const b16 = ts << 4;
  _scalars.slot = ts;
  _scalars.fontSize = S[b8 + 2];
  _scalars.famCode = (R[b16 + 15] >>> 8) & 255;
  _scalars.lineHeight = S[b8 + 3];
  _scalars.lineCount = R[b16 + 10];
  _scalars.boxWidth = S[b8 + 4];
  return _scalars;
}

// =============================================================================
// §2  TOKENIZE — Y.XmlFragment → staging → content tier
// =============================================================================

// Whitespace producing word-break opportunities: \t \n \v \f \r space U+3000.
// Excludes the NBSP family (U+00A0 NBSP, U+202F narrow NBSP, U+2007 figure
// space, U+2060 WJ, U+FEFF ZWNBSP) — those stay inside word tokens; the UAX#14
// classifier (LB11/LB12) glues across them. Also excludes ZWSP (U+200B), which
// provides an in-word break opportunity via the ZW class instead. The split
// regex and the first-char code test below encode the SAME set.
const TOKENIZE_SPLIT_RE = /([\t\n\v\f\r 　]+|[^\t\n\v\f\r 　]+)/g;

/** spaceMode for a whitespace token's text: 1 if all chars === ' ', else 2. */
function classifySpaceText(text: string): number {
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) !== 32) return 2;
  }
  return 1;
}

// --- Tokenize staging (module-owned, grow-only, base-0) ---
let _tPara = new Uint32Array(16); // [pc + 1]
let _tTokSeg = new Uint32Array(64); // [tc + 1]; segStartRel | kind << 31
const _tSegText: string[] = new Array(64).fill('');
let _tSegStyle = new Uint8Array(64); // bit0 bold | bit1 italic | bits2-3 spaceMode
let _tSegHl = new Uint16Array(64);
let _tPc = 0;
let _tTc = 0;
let _tSc = 0;
let _tUniBits = 0; // ALL_BOLD (2) | ALL_ITALIC (4) result
let _tUniHl = 0; // uniform highlight intern idx (0 = none/mixed)

function ensureTokStagingPara(n: number): void {
  if (n < _tPara.length) return;
  const next = new Uint32Array(n + (n >> 1) + 16);
  next.set(_tPara);
  _tPara = next;
}
function ensureTokStagingTok(n: number): void {
  if (n < _tTokSeg.length) return;
  const next = new Uint32Array(n + (n >> 1) + 32);
  next.set(_tTokSeg);
  _tTokSeg = next;
}
function ensureTokStagingSeg(n: number): void {
  if (n < _tSegStyle.length) return;
  const cap = n + (n >> 1) + 32;
  for (let i = _tSegText.length; i < cap; i++) _tSegText[i] = '';
  const ns = new Uint8Array(cap);
  ns.set(_tSegStyle);
  _tSegStyle = ns;
  const nh = new Uint16Array(cap);
  nh.set(_tSegHl);
  _tSegHl = nh;
}

/** Push one styled chunk into the staging token stream. Opens a token when the
 *  kind flips (or at paragraph start), coalesces same-style adjacent segments. */
function stagePush(paraStartTok: number, kind: number, text: string, styleBits: number, hlIdx: number): void {
  const tokIdx = _tTc - 1;
  if (tokIdx < paraStartTok || _tTokSeg[tokIdx] >>> 31 !== kind) {
    ensureTokStagingTok(_tTc + 1);
    _tTokSeg[_tTc] = _tSc | (kind << 31);
    _tTc++;
  } else if (_tSc > (_tTokSeg[tokIdx] & 0x7fffffff)) {
    // Coalesce with the token's last segment on identical style + highlight.
    const last = _tSc - 1;
    const lastStyle = _tSegStyle[last];
    if ((lastStyle & 3) === (styleBits & 3) && _tSegHl[last] === hlIdx) {
      _tSegText[last] = _tSegText[last] + text;
      if (kind === 1 && lastStyle >>> 2 === 1 && classifySpaceText(text) !== 1) {
        _tSegStyle[last] = (lastStyle & 3) | (2 << 2);
      }
      return;
    }
  }
  ensureTokStagingSeg(_tSc + 1);
  _tSegText[_tSc] = text;
  _tSegStyle[_tSc] = (styleBits & 3) | ((kind === 1 ? classifySpaceText(text) : 0) << 2);
  _tSegHl[_tSc] = hlIdx;
  _tSc++;
}

/** Tokenize a fragment into module staging. Also derives the uniform-style
 *  summary (`_tUniBits` / `_tUniHl`) in the same walk. */
export function tokenizeFragment(fragment: Y.XmlFragment): void {
  _tPc = 0;
  _tTc = 0;
  _tSc = 0;

  const children = fragment.toArray();
  let trackBold = 1;
  let trackItalic = 1;
  let hlState = -1; // -1 unseen · -2 mixed · ≥0 candidate intern idx (0 = no highlight)
  let hasAnyText = 0;

  for (const child of children) {
    if (!(child instanceof Y.XmlElement) || child.nodeName !== 'paragraph') continue;
    ensureTokStagingPara(_tPc + 1);
    _tPara[_tPc] = _tTc;
    const paraStartTok = _tTc;
    _tPc++;

    for (const textNode of child.toArray()) {
      if (!(textNode instanceof Y.XmlText)) continue;
      for (const op of textNode.toDelta()) {
        if (typeof op.insert !== 'string') continue;
        const attrs = op.attributes;
        let styleBits = 0;
        let hlIdx = 0;
        if (attrs !== undefined) {
          styleBits = (attrs.bold ? 1 : 0) | (attrs.italic ? 2 : 0);
          const hlAttr = attrs.highlight;
          if (hlAttr != null) {
            const color =
              typeof hlAttr === 'object' && (hlAttr as Record<string, unknown>).color
                ? String((hlAttr as Record<string, unknown>).color)
                : '#ffd43b';
            hlIdx = internHighlight(color);
          }
        }

        if (op.insert.length > 0) {
          hasAnyText = 1;
          if ((styleBits & 1) === 0) trackBold = 0;
          if ((styleBits & 2) === 0) trackItalic = 0;
          if (hlState !== -2) {
            if (hlState === -1) hlState = hlIdx;
            else if (hlState !== hlIdx) hlState = -2;
          }
        }

        TOKENIZE_SPLIT_RE.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = TOKENIZE_SPLIT_RE.exec(op.insert)) !== null) {
          const chunk = m[0];
          const c0 = chunk.charCodeAt(0);
          stagePush(paraStartTok, c0 === 32 || (c0 >= 9 && c0 <= 13) || c0 === 0x3000 ? 1 : 0, chunk, styleBits, hlIdx);
        }
      }
    }
  }

  if (_tPc === 0) {
    ensureTokStagingPara(1);
    _tPara[0] = 0;
    _tPc = 1;
  }
  // Close the half-open ranges with sentinels.
  ensureTokStagingPara(_tPc + 1);
  _tPara[_tPc] = _tTc;
  ensureTokStagingTok(_tTc + 1);
  _tTokSeg[_tTc] = _tSc;

  _tUniBits = hasAnyText !== 0 ? (trackBold !== 0 ? 2 : 0) | (trackItalic !== 0 ? 4 : 0) : 0;
  _tUniHl = hasAnyText !== 0 && hlState > 0 ? hlState : 0;
}

/** Commit the staged tokenization into `ts`'s content tier. Marks content
 *  valid, downstream tiers (measure, note auto-size, frame) stale. */
export function commitTokenizedToSlot(ts: number): void {
  allocContentRanges(ts, _tPc, _tTc, _tSc);
  // Hoist AFTER alloc — it may have grown/repacked the pools.
  const R = getR();
  const b16 = ts << 4;
  getParaTok().set(_tPara.subarray(0, _tPc + 1), R[b16]);
  getTokSeg().set(_tTokSeg.subarray(0, _tTc + 1), R[b16 + 3]);
  const segBase = R[b16 + 6];
  const segText = getSegText();
  for (let i = 0; i < _tSc; i++) segText[segBase + i] = _tSegText[i];
  getSegStyle().set(_tSegStyle.subarray(0, _tSc), segBase);
  getSegHl().set(_tSegHl.subarray(0, _tSc), segBase);
  // status: keep famCode byte, set CONTENT_VALID + uniform bits + uniHl idx
  R[b16 + 15] = (R[b16 + 15] & 0xff00) | 1 | _tUniBits | (_tUniHl << 16);
  const b8 = ts << 3;
  const S = getS();
  S[b8] = NaN; // advance lanes stale
  S[b8 + 5] = NaN; // note auto-size stale
  getFrameCol()[ts << 2] = NaN;
}

// =============================================================================
// §3  MEASURE — in place over the content tier
// =============================================================================

/**
 * Measure every segment of `ts` at (fontSize, famCode): writes the segFontIdx /
 * segAdvW / tokAdvW lanes in place — the topology lanes are shared with the
 * tokenize output and never copied. Font strings resolve through the lazy
 * intern quad, so only the (bold × italic) combos the content actually uses
 * are ever built.
 */
export function measureSlot(ts: number, fontSize: number, famCode: number): void {
  const R = getR();
  const b16 = ts << 4;
  const tokBase = R[b16 + 3];
  const tc = R[b16 + 4];
  const segBase = R[b16 + 6];
  const tokSeg = getTokSeg();
  const tokAdvW = getTokAdvW();
  const segText = getSegText();
  const segStyle = getSegStyle();
  const segFontIdx = getSegFontIdx();
  const segAdvW = getSegAdvW();

  beginFontQuad(fontSize, famCode);
  let sRel = tokSeg[tokBase] & 0x7fffffff;
  for (let ti = 0; ti < tc; ti++) {
    const eRel = tokSeg[tokBase + ti + 1] & 0x7fffffff;
    let total = 0;
    for (let s = segBase + sRel, e = segBase + eRel; s < e; s++) {
      const style = segStyle[s];
      const fi = quadFontIdx(style & 3);
      segFontIdx[s] = fi;
      const w = style >>> 2 === 1 ? spaceWidthByIdx(fi) * segText[s].length : measureTextByIdx(fi, segText[s]);
      segAdvW[s] = w;
      total += w;
    }
    tokAdvW[tokBase + ti] = total;
    sRel = eRel;
  }

  const S = getS();
  const b8 = ts << 3;
  S[b8] = fontSize;
  S[b8 + 6] = fontSize * LINE_HEIGHT_MULT[famCode];
  R[b16 + 15] = (R[b16 + 15] & ~0xff00) | (famCode << 8);
}

// =============================================================================
// §4  FLOW — measured lanes → staging → (pool | TextLayout | direct render)
// =============================================================================

const SLICE_RESULT = { head: '', headW: 0 };

/** Binary search for largest prefix of `text[start..endChar]` fitting within
 *  maxW, probing actual candidate substrings so intra-line kerning matches the
 *  DOM exactly. Forces ≥1 grapheme advance. Returns a module scratch — read
 *  the fields before the next call. `start > 0` must lie on a grapheme
 *  boundary (true for cursors from previous slices / `nextSoftBreak`). */
export function sliceTextToFit(
  fontIdx: number,
  text: string,
  maxW: number,
  start: number = 0,
  endChar: number = text.length,
): { head: string; headW: number } {
  if (start >= endChar) {
    SLICE_RESULT.head = '';
    SLICE_RESULT.headW = 0;
    return SLICE_RESULT;
  }
  const charEnds = getCharEnds(text);

  let startIdx = 0;
  if (start > 0) {
    let slo = 0;
    let shi = charEnds.length - 1;
    while (slo < shi) {
      const mid = (slo + shi) >>> 1;
      if (charEnds[mid] < start) slo = mid + 1;
      else shi = mid;
    }
    startIdx = slo;
  }

  let endIdx = charEnds.length - 1;
  if (endChar < text.length) {
    let elo = startIdx;
    let ehi = charEnds.length - 1;
    while (elo < ehi) {
      const mid = (elo + ehi + 1) >>> 1;
      if (charEnds[mid] <= endChar) elo = mid;
      else ehi = mid - 1;
    }
    endIdx = elo;
  }

  // Fast path: the whole [start..endIdx] fits — one measure call.
  const fullCe = charEnds[endIdx];
  const fullSlice = text.substring(start, fullCe);
  const fullW = measureTextByIdx(fontIdx, fullSlice);
  if (fullW <= maxW) {
    SLICE_RESULT.head = fullSlice;
    SLICE_RESULT.headW = fullW;
    return SLICE_RESULT;
  }

  let lo = startIdx;
  let hi = endIdx;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    const w = measureTextByIdx(fontIdx, text.substring(start, charEnds[mid]));
    if (w <= maxW) lo = mid;
    else hi = mid - 1;
  }
  // Forward progress: fullW > maxW ⇒ endIdx > startIdx ⇒ startIdx + 1 ≤ endIdx.
  if (lo === startIdx) lo = startIdx + 1;
  const head = text.substring(start, charEnds[lo]);
  SLICE_RESULT.head = head;
  SLICE_RESULT.headW = measureTextByIdx(fontIdx, head); // typically a probe cache hit
  return SLICE_RESULT;
}

// --- Flow staging (module-owned, grow-only, base-0) ---
let _fLineRunStart = new Uint32Array(33); // [lc + 1]
let _fLineAdvW = new Float64Array(32);
let _fLineAlignW = new Float64Array(32);
let _fLc = 0;
const _fRunText: string[] = new Array(64).fill(''); // grows in place — identity is stable
let _fRunFontIdx = new Uint16Array(64);
let _fRunHl = new Uint16Array(64);
let _fRunAdvW = new Float64Array(64);
let _fRunAdvX = new Float64Array(64);
let _fRc = 0;
let _fMaxAdvW = 0;

/** Unconditional line-lane growth to hold index `n`. Caller refreshes its
 *  hoisted typed refs afterwards. */
function growFlowLines(n: number): void {
  const cap = n + (n >> 1) + 16;
  const ns = new Uint32Array(cap + 1);
  ns.set(_fLineRunStart);
  _fLineRunStart = ns;
  const na = new Float64Array(cap);
  na.set(_fLineAdvW);
  _fLineAdvW = na;
  const nw = new Float64Array(cap);
  nw.set(_fLineAlignW);
  _fLineAlignW = nw;
}
/** Unconditional run-lane growth to hold index `n`. `_fRunText` grows in
 *  place (stable identity); caller refreshes the typed refs. */
function growFlowRuns(n: number): void {
  const cap = n + (n >> 1) + 32;
  for (let i = _fRunText.length; i < cap; i++) _fRunText[i] = '';
  const nf = new Uint16Array(cap);
  nf.set(_fRunFontIdx);
  _fRunFontIdx = nf;
  const nh = new Uint16Array(cap);
  nh.set(_fRunHl);
  _fRunHl = nh;
  const nw = new Float64Array(cap);
  nw.set(_fRunAdvW);
  _fRunAdvW = nw;
  const nx = new Float64Array(cap);
  nx.set(_fRunAdvX);
  _fRunAdvX = nx;
}

/**
 * THE flow engine — an entry's measured content tier in, staging out.
 * Implements CSS `pre-wrap` + `overflow-wrap: break-word`.
 *
 * ONE monolithic body: pool lanes, staging lanes, the line builder (advX /
 * visW / ink / line run start), and the pending-whitespace machine all live in
 * locals; the run-append (coalesce-or-open) and line-push sequences are
 * expanded at each of their sites instead of routed through helpers. Leaf
 * calls only: nextSoftBreak / isBreakOpportunity (UAX#14), measureTextByIdx,
 * sliceTextToFit, and the rare staging growers (hoisted refs refreshed after).
 *
 * Model (unchanged semantics, previously spread over placeWord/appendRun/…):
 *  - Leading WS (no ink on the line) commits immediately and can overflow;
 *    inter-word WS in fixed mode is BUFFERED as pending and committed only
 *    when a following word fits — pending is always ONE contiguous seg range
 *    [pendS, pendE), because consecutive whitespace coalesces into a single
 *    token (kind must flip between tokens), so word/space tokens alternate.
 *    Pending non-empty ⇒ the line has ink (space with no ink commits
 *    immediately), so no ink test guards the commit.
 *  - Word placement: fast path drops a fitting word in atomically; otherwise
 *    a per-sub-segment Q1/Q2/Q3 ladder over UAX#14 break opportunities:
 *      Q1 — chunk fits the current line as-is. Always allowed.
 *      Q2 — UAX#14 soft break: place atomic on a fresh line. Gated by
 *           canSoftBreak so style-only seams (AL × AL across a bold/highlight
 *           boundary) don't behave as break opportunities.
 *      Q3 — `overflow-wrap: break-word` char-slice via sliceTextToFit. Runs
 *           exactly where UAX#14 forbids a break, so NOT gated. Pre-emptive
 *           push only when truly oversized at a real break op (matches DOM:
 *           oversized words start fresh). Slice-loop guards: (a) full line →
 *           wrap before slicing; (b) slicer hands back a grapheme wider than
 *           the remaining width on a non-empty line → wrap and retry. Both
 *           no-op on an empty line — a single oversized grapheme is appended
 *           unavoidably.
 *    Seams between style segments are classified via isBreakOpportunity on
 *    the boundary char codes; within a segment after the first chunk,
 *    cursor > 0 implies a real break op (it's what nextSoftBreak returned).
 *  - Paragraph end: trailing WS is content (pending commits), and the last
 *    line's alignment width clamps to min(advanceWidth, maxWidth).
 *  - Adjacent runs with identical font + highlight coalesce (two int
 *    compares); on ink the visible width comes from the run lanes
 *    (runAdvX + runAdvW), not the accumulator — bit-exact with the
 *    pre-monolith engine.
 */
export function flowSlotContent(ts: number, maxWidth: number): void {
  const R = getR();
  const b16 = ts << 4;
  const paraTok = getParaTok();
  const paraBase = R[b16];
  const paraCount = R[b16 + 1];
  const tokSeg = getTokSeg();
  const tokAdvW = getTokAdvW();
  const tokBase = R[b16 + 3];
  const segText = getSegText();
  const segFontIdx = getSegFontIdx();
  const segHl = getSegHl();
  const segAdvW = getSegAdvW();
  const segBase = R[b16 + 6];

  // staging hoists (typed refs refreshed after any grower call)
  let lineRunStart = _fLineRunStart;
  let lineAdvW = _fLineAdvW;
  let lineAlignW = _fLineAlignW;
  const runText = _fRunText;
  let runFontIdx = _fRunFontIdx;
  let runHl = _fRunHl;
  let runAdvW = _fRunAdvW;
  let runAdvX = _fRunAdvX;

  let lc = 0;
  let rc = 0;
  lineRunStart[0] = 0;
  // line builder
  let advX = 0;
  let visW = 0;
  let ink = 0;
  let lineStartRun = 0;
  // pending inter-word whitespace — one contiguous seg range
  let pendS = 0;
  let pendE = 0;
  let pendW = 0;

  for (let pi = 0; pi < paraCount; pi++) {
    const tStart = paraTok[paraBase + pi];
    const tEnd = paraTok[paraBase + pi + 1];
    if (tStart === tEnd) {
      // Empty paragraph — one empty line. (Pending is empty at every
      // paragraph boundary: the previous paragraph committed it.)
      if (lc + 1 >= lineAdvW.length) {
        growFlowLines(lc + 1);
        lineRunStart = _fLineRunStart;
        lineAdvW = _fLineAdvW;
        lineAlignW = _fLineAlignW;
      }
      lineRunStart[lc + 1] = rc;
      lineAdvW[lc] = advX;
      lineAlignW[lc] = visW;
      lc++;
      advX = 0;
      visW = 0;
      ink = 0;
      lineStartRun = rc;
      const aw = lineAdvW[lc - 1];
      lineAlignW[lc - 1] = aw < maxWidth ? aw : maxWidth;
      continue;
    }

    for (let ti = tStart; ti < tEnd; ti++) {
      const tokWord = tokSeg[tokBase + ti];
      const sStart = segBase + (tokWord & 0x7fffffff);
      const sEnd = segBase + (tokSeg[tokBase + ti + 1] & 0x7fffffff);

      if (tokWord >>> 31 === 1) {
        // SPACE token.
        if (ink !== 0 && maxWidth !== Infinity) {
          // Buffer as pending. Word/space tokens alternate, so pending is
          // empty here — straight assignment, no accumulation.
          pendS = sStart;
          pendE = sEnd;
          let w = 0;
          for (let s = sStart; s < sEnd; s++) w += segAdvW[s];
          pendW = w;
          continue;
        }
        // Leading WS (or auto mode) — commit each seg now; may overflow.
        for (let s = sStart; s < sEnd; s++) {
          const fi = segFontIdx[s];
          const hl = segHl[s];
          const w = segAdvW[s];
          const ri = rc - 1;
          if (ri >= lineStartRun && runFontIdx[ri] === fi && runHl[ri] === hl) {
            runText[ri] = runText[ri] + segText[s];
            runAdvW[ri] = runAdvW[ri] + w;
          } else {
            if (rc + 1 >= runFontIdx.length) {
              growFlowRuns(rc + 1);
              runFontIdx = _fRunFontIdx;
              runHl = _fRunHl;
              runAdvW = _fRunAdvW;
              runAdvX = _fRunAdvX;
            }
            runText[rc] = segText[s];
            runFontIdx[rc] = fi;
            runHl[rc] = hl;
            runAdvW[rc] = w;
            runAdvX[rc] = advX;
            rc++;
          }
          advX += w;
        }
        continue;
      }

      // WORD token — commit pending inter-word WS to the current line first
      // (pending non-empty ⇒ ink is already set; pre-emptive line pushes here
      // would mask intra-word break opportunities).
      if (pendW > 0) {
        for (let s = pendS; s < pendE; s++) {
          const fi = segFontIdx[s];
          const hl = segHl[s];
          const w = segAdvW[s];
          const ri = rc - 1;
          if (ri >= lineStartRun && runFontIdx[ri] === fi && runHl[ri] === hl) {
            runText[ri] = runText[ri] + segText[s];
            runAdvW[ri] = runAdvW[ri] + w;
          } else {
            if (rc + 1 >= runFontIdx.length) {
              growFlowRuns(rc + 1);
              runFontIdx = _fRunFontIdx;
              runHl = _fRunHl;
              runAdvW = _fRunAdvW;
              runAdvX = _fRunAdvX;
            }
            runText[rc] = segText[s];
            runFontIdx[rc] = fi;
            runHl[rc] = hl;
            runAdvW[rc] = w;
            runAdvX[rc] = advX;
            rc++;
          }
          advX += w;
        }
        pendW = 0;
      }

      // Fast path: the whole word fits the remaining line — drop in atomic.
      if (maxWidth === Infinity || tokAdvW[tokBase + ti] <= maxWidth - advX) {
        for (let s = sStart; s < sEnd; s++) {
          const fi = segFontIdx[s];
          const hl = segHl[s];
          const w = segAdvW[s];
          const ri = rc - 1;
          if (ri >= lineStartRun && runFontIdx[ri] === fi && runHl[ri] === hl) {
            runText[ri] = runText[ri] + segText[s];
            runAdvW[ri] = runAdvW[ri] + w;
            ink = 1;
            visW = runAdvX[ri] + runAdvW[ri];
            advX += w;
          } else {
            if (rc + 1 >= runFontIdx.length) {
              growFlowRuns(rc + 1);
              runFontIdx = _fRunFontIdx;
              runHl = _fRunHl;
              runAdvW = _fRunAdvW;
              runAdvX = _fRunAdvX;
            }
            runText[rc] = segText[s];
            runFontIdx[rc] = fi;
            runHl[rc] = hl;
            runAdvW[rc] = w;
            runAdvX[rc] = advX;
            rc++;
            ink = 1;
            visW = advX + w;
            advX = visW;
          }
        }
        continue;
      }

      // Q1/Q2/Q3 ladder over the word's style segments.
      for (let s = sStart; s < sEnd; s++) {
        const fontIdx = segFontIdx[s];
        const hlIdx = segHl[s];
        const fullText = segText[s];

        // First seg of the word: word-leading position is itself a break.
        // Otherwise classify the seam against the previous seg's last char.
        let segEntryIsBreak = true;
        if (s > sStart) {
          const prev = segText[s - 1];
          segEntryIsBreak = isBreakOpportunity(prev.charCodeAt(prev.length - 1), fullText.charCodeAt(0));
        }

        let cursor = 0;
        while (cursor < fullText.length) {
          const segEnd = nextSoftBreak(fullText, cursor);
          const chunk = fullText.substring(cursor, segEnd);
          const chunkW = measureTextByIdx(fontIdx, chunk);
          const lineRemaining = maxWidth - advX;

          // cursor > 0 ⇒ post-nextSoftBreak position (a real break op).
          const canSoftBreak = cursor > 0 || segEntryIsBreak;

          // Q1 — fits the current line as-is / Q2 — soft break to a fresh
          // line (legal only at a real break op; at a non-break seam fall
          // through to Q3 so the remaining line space gets greedy-filled,
          // matching DOM `overflow-wrap: break-word`).
          if (chunkW <= lineRemaining || (canSoftBreak && chunkW <= maxWidth)) {
            if (chunkW > lineRemaining && rc > lineStartRun) {
              if (lc + 1 >= lineAdvW.length) {
                growFlowLines(lc + 1);
                lineRunStart = _fLineRunStart;
                lineAdvW = _fLineAdvW;
                lineAlignW = _fLineAlignW;
              }
              lineRunStart[lc + 1] = rc;
              lineAdvW[lc] = advX;
              lineAlignW[lc] = visW;
              lc++;
              advX = 0;
              visW = 0;
              ink = 0;
              lineStartRun = rc;
            }
            const ri = rc - 1;
            if (ri >= lineStartRun && runFontIdx[ri] === fontIdx && runHl[ri] === hlIdx) {
              runText[ri] = runText[ri] + chunk;
              runAdvW[ri] = runAdvW[ri] + chunkW;
              ink = 1;
              visW = runAdvX[ri] + runAdvW[ri];
              advX += chunkW;
            } else {
              if (rc + 1 >= runFontIdx.length) {
                growFlowRuns(rc + 1);
                runFontIdx = _fRunFontIdx;
                runHl = _fRunHl;
                runAdvW = _fRunAdvW;
                runAdvX = _fRunAdvX;
              }
              runText[rc] = chunk;
              runFontIdx[rc] = fontIdx;
              runHl[rc] = hlIdx;
              runAdvW[rc] = chunkW;
              runAdvX[rc] = advX;
              rc++;
              ink = 1;
              visW = advX + chunkW;
              advX = visW;
            }
            cursor = segEnd;
            continue;
          }

          // Q3 — break-word char-slice. Pre-emptive push only when the chunk
          // is truly oversized at a real break op.
          if (canSoftBreak && chunkW > maxWidth && rc > lineStartRun) {
            if (lc + 1 >= lineAdvW.length) {
              growFlowLines(lc + 1);
              lineRunStart = _fLineRunStart;
              lineAdvW = _fLineAdvW;
              lineAlignW = _fLineAlignW;
            }
            lineRunStart[lc + 1] = rc;
            lineAdvW[lc] = advX;
            lineAlignW[lc] = visW;
            lc++;
            advX = 0;
            visW = 0;
            ink = 0;
            lineStartRun = rc;
          }
          while (cursor < segEnd) {
            let lr = maxWidth - advX;
            // Guard 1 — line is full; wrap before slicing.
            if (lr <= 0 && rc > lineStartRun) {
              if (lc + 1 >= lineAdvW.length) {
                growFlowLines(lc + 1);
                lineRunStart = _fLineRunStart;
                lineAdvW = _fLineAdvW;
                lineAlignW = _fLineAlignW;
              }
              lineRunStart[lc + 1] = rc;
              lineAdvW[lc] = advX;
              lineAlignW[lc] = visW;
              lc++;
              advX = 0;
              visW = 0;
              ink = 0;
              lineStartRun = rc;
              lr = maxWidth;
            }
            const r = sliceTextToFit(fontIdx, fullText, lr, cursor, segEnd);
            // Guard 2 — oversized grapheme on a non-empty line; wrap, retry.
            if (r.headW > lr && rc > lineStartRun) {
              if (lc + 1 >= lineAdvW.length) {
                growFlowLines(lc + 1);
                lineRunStart = _fLineRunStart;
                lineAdvW = _fLineAdvW;
                lineAlignW = _fLineAlignW;
              }
              lineRunStart[lc + 1] = rc;
              lineAdvW[lc] = advX;
              lineAlignW[lc] = visW;
              lc++;
              advX = 0;
              visW = 0;
              ink = 0;
              lineStartRun = rc;
              continue;
            }
            const head = r.head;
            const headW = r.headW;
            const ri = rc - 1;
            if (ri >= lineStartRun && runFontIdx[ri] === fontIdx && runHl[ri] === hlIdx) {
              runText[ri] = runText[ri] + head;
              runAdvW[ri] = runAdvW[ri] + headW;
              ink = 1;
              visW = runAdvX[ri] + runAdvW[ri];
              advX += headW;
            } else {
              if (rc + 1 >= runFontIdx.length) {
                growFlowRuns(rc + 1);
                runFontIdx = _fRunFontIdx;
                runHl = _fRunHl;
                runAdvW = _fRunAdvW;
                runAdvX = _fRunAdvX;
              }
              runText[rc] = head;
              runFontIdx[rc] = fontIdx;
              runHl[rc] = hlIdx;
              runAdvW[rc] = headW;
              runAdvX[rc] = advX;
              rc++;
              ink = 1;
              visW = advX + headW;
              advX = visW;
            }
            cursor += head.length;
            if (cursor < segEnd) {
              if (lc + 1 >= lineAdvW.length) {
                growFlowLines(lc + 1);
                lineRunStart = _fLineRunStart;
                lineAdvW = _fLineAdvW;
                lineAlignW = _fLineAlignW;
              }
              lineRunStart[lc + 1] = rc;
              lineAdvW[lc] = advX;
              lineAlignW[lc] = visW;
              lc++;
              advX = 0;
              visW = 0;
              ink = 0;
              lineStartRun = rc;
            }
          }
        }
      }
    }

    // Paragraph end: trailing pending WS is content, then close the line and
    // clamp its alignment width to min(advanceWidth, maxWidth).
    if (pendW > 0) {
      for (let s = pendS; s < pendE; s++) {
        const fi = segFontIdx[s];
        const hl = segHl[s];
        const w = segAdvW[s];
        const ri = rc - 1;
        if (ri >= lineStartRun && runFontIdx[ri] === fi && runHl[ri] === hl) {
          runText[ri] = runText[ri] + segText[s];
          runAdvW[ri] = runAdvW[ri] + w;
        } else {
          if (rc + 1 >= runFontIdx.length) {
            growFlowRuns(rc + 1);
            runFontIdx = _fRunFontIdx;
            runHl = _fRunHl;
            runAdvW = _fRunAdvW;
            runAdvX = _fRunAdvX;
          }
          runText[rc] = segText[s];
          runFontIdx[rc] = fi;
          runHl[rc] = hl;
          runAdvW[rc] = w;
          runAdvX[rc] = advX;
          rc++;
        }
        advX += w;
      }
      pendW = 0;
    }
    if (lc + 1 >= lineAdvW.length) {
      growFlowLines(lc + 1);
      lineRunStart = _fLineRunStart;
      lineAdvW = _fLineAdvW;
      lineAlignW = _fLineAlignW;
    }
    lineRunStart[lc + 1] = rc;
    lineAdvW[lc] = advX;
    lineAlignW[lc] = visW;
    lc++;
    advX = 0;
    visW = 0;
    ink = 0;
    lineStartRun = rc;
    const aw = lineAdvW[lc - 1];
    lineAlignW[lc - 1] = aw < maxWidth ? aw : maxWidth;
  }

  let maxAdvW = 0;
  for (let i = 0; i < lc; i++) {
    if (lineAdvW[i] > maxAdvW) maxAdvW = lineAdvW[i];
  }
  _fMaxAdvW = maxAdvW;
  _fLc = lc;
  _fRc = rc;
}

/** Commit staged flow output into `ts`'s layout tier + scalar columns. */
export function commitFlowToSlot(ts: number, fontSize: number, famCode: number, widthReq: number): void {
  const lc = _fLc;
  const rc = _fRc;
  allocLayoutRanges(ts, lc, rc);
  const R = getR();
  const b16 = ts << 4;
  getLineRunStart().set(_fLineRunStart.subarray(0, lc + 1), R[b16 + 9]);
  getLineAdvW().set(_fLineAdvW.subarray(0, lc), R[b16 + 9]);
  getLineAlignW().set(_fLineAlignW.subarray(0, lc), R[b16 + 9]);
  const runBase = R[b16 + 12];
  const runText = getRunText();
  for (let i = 0; i < rc; i++) runText[runBase + i] = _fRunText[i];
  getRunFontIdx().set(_fRunFontIdx.subarray(0, rc), runBase);
  getRunHl().set(_fRunHl.subarray(0, rc), runBase);
  getRunAdvW().set(_fRunAdvW.subarray(0, rc), runBase);
  getRunAdvX().set(_fRunAdvX.subarray(0, rc), runBase);
  const S = getS();
  const b8 = ts << 3;
  S[b8 + 1] = widthReq;
  S[b8 + 2] = fontSize;
  S[b8 + 3] = fontSize * LINE_HEIGHT_MULT[famCode];
  S[b8 + 4] = widthReq === Infinity ? _fMaxAdvW : widthReq;
  getFrameCol()[ts << 2] = NaN; // layout changed ⇒ frame stale until bbox recompute
}

function commitFlowToLayout(out: TextLayout, fontSize: number, famCode: number, widthReq: number, lineHeight: number): void {
  const lc = _fLc;
  const rc = _fRc;
  if (lc > out.lineCap) {
    let cap = out.lineCap;
    while (cap < lc) cap *= 2;
    out.lineRunStart = new Uint32Array(cap + 1);
    out.lineAdvW = new Float64Array(cap);
    out.lineAlignW = new Float64Array(cap);
    out.lineCap = cap;
  }
  if (rc > out.runCap) {
    let cap = out.runCap;
    while (cap < rc) cap *= 2;
    for (let i = out.runText.length; i < cap; i++) out.runText[i] = '';
    out.runFontIdx = new Uint16Array(cap);
    out.runHl = new Uint16Array(cap);
    out.runAdvW = new Float64Array(cap);
    out.runAdvX = new Float64Array(cap);
    out.runCap = cap;
  }
  out.lineRunStart.set(_fLineRunStart.subarray(0, lc + 1));
  out.lineAdvW.set(_fLineAdvW.subarray(0, lc));
  out.lineAlignW.set(_fLineAlignW.subarray(0, lc));
  for (let i = 0; i < rc; i++) out.runText[i] = _fRunText[i];
  out.runFontIdx.set(_fRunFontIdx.subarray(0, rc));
  out.runHl.set(_fRunHl.subarray(0, rc));
  out.runAdvW.set(_fRunAdvW.subarray(0, rc));
  out.runAdvX.set(_fRunAdvX.subarray(0, rc));
  out.lineCount = lc;
  out.runCount = rc;
  out.fontSize = fontSize;
  out.famCode = famCode;
  out.lineHeight = lineHeight;
  out.maxWidthReq = widthReq;
  out.boxWidth = widthReq === Infinity ? _fMaxAdvW : widthReq;
}

/**
 * Slot-path flow for shim consumers (transform reflow sidecar): lay `ts`'s
 * measured content out at `width` into `out`. The slot int IS the frozen
 * reference — lanes and bases are read fresh per call, so relocation between
 * pointermoves is invisible (the semantics held views used to provide).
 */
export function layoutSlotContent(ts: number, width: number, fontSize: number, out: TextLayout): TextLayout {
  const maxW = width > 0.01 ? width : 0.01;
  flowSlotContent(ts, maxW);
  const famCode = (getR()[(ts << 4) + 15] >>> 8) & 255;
  commitFlowToLayout(out, fontSize, famCode, maxW, getS()[(ts << 3) + 6]);
  return out;
}

// =============================================================================
// §5  CACHE FACADE — tiered orchestration over the columns
// =============================================================================

/** Run whatever pipeline stages `ts` needs for (fontSize, famCode, widthReq).
 *  The staleness probes are plain compares — NaN sentinels fall through them. */
function ensureLayoutForSlot(ts: number, fragment: Y.XmlFragment, fontSize: number, famCode: number, widthReq: number): void {
  const R = getR();
  const S = getS();
  const b16 = ts << 4;
  const b8 = ts << 3;
  const status = R[b16 + 15];
  // Fused probe: CONTENT_VALID bit + famCode byte in one masked compare.
  if ((status & 0xff01) === ((famCode << 8) | 1) && S[b8] === fontSize) {
    if (S[b8 + 1] === widthReq) return; // full hit
    // width changed only — reflow
    flowSlotContent(ts, widthReq);
    commitFlowToSlot(ts, fontSize, famCode, widthReq);
    return;
  }
  if ((status & 1) === 0) {
    tokenizeFragment(fragment);
    commitTokenizedToSlot(ts);
  }
  measureSlot(ts, fontSize, famCode);
  flowSlotContent(ts, widthReq);
  commitFlowToSlot(ts, fontSize, famCode, widthReq);
}

const _uniScratch: UniformStyles = { allBold: false, allItalic: false, uniformHighlight: null };

class TextLayoutCache {
  /**
   * Ensure the layout for a text-bearing entry and return its scalars (module
   * scratch — consume before the next scalar-returning call). Three-tier:
   * content → measurement → flow; width/fontSize/family staleness detected by
   * columnar comparison, no explicit invalidation needed.
   */
  getLayout(
    objectId: string,
    fragment: Y.XmlFragment,
    fontSize: number,
    fontFamily: FontFamily = 'Grandstander',
    width: TextWidth = 'auto',
  ): TextLayoutScalars {
    const ts = ensureTextSlot(objectId);
    const widthReq = typeof width === 'number' ? (width > 0.01 ? width : 0.01) : Infinity;
    ensureLayoutForSlot(ts, fragment, fontSize, famCodeOf(fontFamily), widthReq);
    return fillScalars(ts);
  }

  /** Content invalidation. With a fragment: eager re-tokenize (context menu
   *  reads getInlineStyles before the next getLayout). Without: lazy — the
   *  content-valid bit clears and the next getLayout re-runs the pipeline. */
  invalidateContent(objectId: string, fragment?: Y.XmlFragment): void {
    const ts = textSlotOf(objectId);
    if (ts < 0) return;
    if (fragment) {
      tokenizeFragment(fragment);
      commitTokenizedToSlot(ts);
      return;
    }
    const S = getS();
    getR()[(ts << 4) + 15] &= ~1; // clear CONTENT_VALID
    S[ts << 3] = NaN;
    S[(ts << 3) + 5] = NaN;
    getFrameCol()[ts << 2] = NaN;
  }

  evict(objectId: string): void {
    releaseTextSlot(objectId);
  }

  clear(): void {
    resetTextStore();
    resetFontTable();
    clearMeasurementCaches();
  }

  /** Derived frame, or null before first bbox compute / after invalidation.
   *  Returns a per-slot tuple refreshed from the frame column — a borrowed
   *  ref: read now, copy scalars if you need them across cache operations. */
  getFrame(objectId: string): FrameTuple | null {
    const ts = textSlotOf(objectId);
    if (ts < 0) return null;
    const fc = getFrameCol();
    const o = ts << 2;
    const x = fc[o];
    if (x !== x) return null; // NaN ⇒ invalid
    const t = frameTupleOf(ts);
    t[0] = x;
    t[1] = fc[o + 1];
    t[2] = fc[o + 2];
    t[3] = fc[o + 3];
    return t;
  }

  /** Layout scalars without any staleness probe (observer keeps them fresh
   *  whenever the entry exists). Module scratch — consume immediately. */
  getLayoutScalarsById(objectId: string): TextLayoutScalars | null {
    const ts = textSlotOf(objectId);
    if (ts < 0) return null;
    const w = getS()[(ts << 3) + 1];
    if (w !== w) return null; // NaN ⇒ no committed layout
    return fillScalars(ts);
  }

  /** Note-path scalar read (kept for convert-kind's frame inversion). */
  noteCachedLayout(objectId: string): TextLayoutScalars | null {
    return this.getLayoutScalarsById(objectId);
  }

  getInlineStyles(objectId: string): UniformStyles | null {
    const ts = textSlotOf(objectId);
    if (ts < 0) return null;
    const status = getR()[(ts << 4) + 15];
    if ((status & 1) === 0) return null; // content not valid
    _uniScratch.allBold = (status & 2) !== 0;
    _uniScratch.allItalic = (status & 4) !== 0;
    const hl = status >>> 16;
    _uniScratch.uniformHighlight = hl !== 0 ? HL_STRINGS[hl] : null;
    return _uniScratch;
  }
}

export const textLayoutCache = new TextLayoutCache();

// =============================================================================
// §6  OUTPUT — alignment, render kernel, entry renders
// =============================================================================

export function anchorFactor(align: TextAlign): number {
  return align === 'left' ? 0 : align === 'center' ? 0.5 : 1;
}

/** Vertical offset for constrained-box content alignment (matches CSS clamp
 *  behavior). Shared by sticky-note and shape-label rendering. */
export function getNoteContentOffsetY(alignV: TextAlignV, maxContentH: number, contentH: number): number {
  if (alignV === 'top') return 0;
  const space = maxContentH - contentH;
  const clamped = space > 0 ? space : 0;
  return alignV === 'middle' ? clamped / 2 : clamped;
}

// --- Run render kernel ---
//
// One body serves every text-bearing draw: at-rest text/notes/labels off pool
// lanes, transform previews off TextLayout objects, label previews straight
// off flow staging — all the same array types, so the kernel stays monomorphic.
// Scalars travel through `_rkF` (argBox idiom — only ints and arrays cross the
// call): 0 originX · 1 firstBaselineY · 2 alignFactor · 3 (spare) ·
// 4 lineHeight · 5 baselineToTop · 6 containerL · 7 containerR · 8 hlRadius.
// Per line: `startX = originX − alignFactor · lineW` (the boxWidth terms of
// the anchor algebra cancel — one fused multiply-subtract per line).
// Unclamped draws pass containerL/R = ∓Infinity: the clamp min/max then return
// the raw edges and the radius picks stay full — the sentinel makes the single
// clamped body compute the unclamped result exactly, no mode branch.
const _rkF = new Float64Array(9);
const _hlRadii: [number, number, number, number] = [0, 0, 0, 0];

export function setRenderKernelScalars(
  originX: number,
  firstBaselineY: number,
  alignFactor: number,
  lineHeight: number,
  baselineToTop: number,
  containerL: number,
  containerR: number,
  hlRadius: number,
): void {
  _rkF[0] = originX;
  _rkF[1] = firstBaselineY;
  _rkF[2] = alignFactor;
  _rkF[4] = lineHeight;
  _rkF[5] = baselineToTop;
  _rkF[6] = containerL;
  _rkF[7] = containerR;
  _rkF[8] = hlRadius;
}

function renderRunsCore(
  ctx: CanvasRenderingContext2D,
  lineRunStart: Uint32Array,
  lineW: Float64Array,
  lineBase: number,
  lineCount: number,
  runText: string[],
  runFontIdx: Uint16Array,
  runHl: Uint16Array,
  runAdvW: Float64Array,
  runAdvX: Float64Array,
  runBase: number,
  color: string,
): void {
  const originX = _rkF[0];
  const firstY = _rkF[1];
  const af = _rkF[2];
  const lineHeight = _rkF[4];
  const b2t = _rkF[5];
  const cL = _rkF[6];
  const cR = _rkF[7];
  const hlR = _rkF[8];
  const hls = HL_STRINGS;
  const fonts = FONT_STRINGS;
  let lastFi = 0; // index 0 is the '' sentinel — first real run always sets ctx.font
  for (let li = 0; li < lineCount; li++) {
    const sr = runBase + lineRunStart[lineBase + li];
    const er = runBase + lineRunStart[lineBase + li + 1];
    if (sr === er) continue;
    const lineY = firstY + li * lineHeight;
    const startX = originX - af * lineW[lineBase + li];

    // Pass 1: highlights
    for (let r = sr; r < er; r++) {
      const hli = runHl[r];
      if (hli === 0) continue;
      ctx.fillStyle = hls[hli];
      const hlX = startX + runAdvX[r];
      const hlEnd = hlX + runAdvW[r];
      const clL = hlX > cL ? hlX : cL;
      const clR = hlEnd < cR ? hlEnd : cR;
      if (clR > clL) {
        const rL = clL > hlX ? 0 : hlR;
        const rR = clR < hlEnd ? 0 : hlR;
        _hlRadii[0] = rL;
        _hlRadii[1] = rR;
        _hlRadii[2] = rR;
        _hlRadii[3] = rL;
        ctx.beginPath();
        ctx.roundRect(clL, lineY - b2t, clR - clL, lineHeight, _hlRadii);
        ctx.fill();
      }
    }

    // Pass 2: glyphs — font changes are int compares against interned indices
    ctx.fillStyle = color;
    for (let r = sr; r < er; r++) {
      const fi = runFontIdx[r];
      if (fi !== lastFi) {
        ctx.font = fonts[fi];
        lastFi = fi;
      }
      ctx.fillText(runText[r], startX + runAdvX[r], lineY);
    }
  }
}

/** Kernel entry over a slot's committed layout tier. `useAlignW` picks the
 *  per-line width lane (1 = alignment widths, 0 = advance widths). Callers set
 *  the kernel scalars first. */
export function renderRunsForSlot(ctx: CanvasRenderingContext2D, ts: number, useAlignW: number, color: string): void {
  const R = getR();
  const b16 = ts << 4;
  renderRunsCore(
    ctx,
    getLineRunStart(),
    useAlignW !== 0 ? getLineAlignW() : getLineAdvW(),
    R[b16 + 9],
    R[b16 + 10],
    getRunText(),
    getRunFontIdx(),
    getRunHl(),
    getRunAdvW(),
    getRunAdvX(),
    R[b16 + 12],
    color,
  );
}

/** Kernel entry straight off the flow staging (label transform preview — the
 *  layout is consumed within the same draw, so it never touches a pool). */
export function renderRunsFromStaging(ctx: CanvasRenderingContext2D, useAlignW: number, color: string): void {
  renderRunsCore(
    ctx,
    _fLineRunStart,
    useAlignW !== 0 ? _fLineAlignW : _fLineAdvW,
    0,
    _fLc,
    _fRunText,
    _fRunFontIdx,
    _fRunHl,
    _fRunAdvW,
    _fRunAdvX,
    0,
    color,
  );
}

/** Staged flow line count for direct-render callers (valid until the next flow). */
export function stagedFlowLineCount(): number {
  return _fLc;
}

/**
 * Draw a cached text layout by entry — the at-rest text / connector-label /
 * scale-preview draw path. Resolves through the app-slot accelerator and reads
 * pool lanes; silently no-ops when the entry or its layout is absent (cold-miss
 * race — the observer fills the cache before render).
 */
export function renderTextLayoutById(
  ctx: CanvasRenderingContext2D,
  appSlot: number,
  id: string,
  originX: number,
  originY: number,
  color: string,
  align: TextAlign = 'left',
  fillColor?: string,
): void {
  const ts = textSlotFast(appSlot, id);
  if (ts < 0) return;
  const S = getS();
  const b8 = ts << 3;
  const widthReq = S[b8 + 1];
  if (widthReq !== widthReq) return; // NaN ⇒ no committed layout
  const R = getR();
  const b16 = ts << 4;
  const fontSize = S[b8 + 2];
  const lineHeight = S[b8 + 3];
  const boxWidth = S[b8 + 4];
  const lineCount = R[b16 + 10];
  const famCode = (R[b16 + 15] >>> 8) & 255;
  const b2t = getBaselineToTopRatioByCode(famCode) * fontSize;
  const af = anchorFactor(align);
  const isFixed = widthReq !== Infinity;

  ctx.save();
  ctx.textBaseline = 'alphabetic';
  const boxLeft = originX - af * boxWidth;
  if (fillColor) {
    ctx.fillStyle = fillColor;
    ctx.fillRect(boxLeft, originY - b2t, boxWidth, lineCount * lineHeight);
  }
  setRenderKernelScalars(
    originX,
    originY,
    af,
    lineHeight,
    b2t,
    isFixed ? boxLeft : -Infinity,
    isFixed ? boxLeft + boxWidth : Infinity,
    fontSize * 0.25,
  );
  renderRunsForSlot(ctx, ts, isFixed ? 1 : 0, color);
  ctx.restore();
}

/** Object-layout twin of `renderTextLayoutById` for shim consumers (transform
 *  reflow preview). Same kernel, base-0 lanes. */
export function renderTextLayout(
  ctx: CanvasRenderingContext2D,
  layout: TextLayout,
  originX: number,
  originY: number,
  color: string,
  align: TextAlign = 'left',
  fillColor?: string,
): void {
  const { boxWidth, fontSize, lineHeight, lineCount } = layout;
  const b2t = getBaselineToTopRatioByCode(layout.famCode) * fontSize;
  const af = anchorFactor(align);
  const isFixed = layout.maxWidthReq !== Infinity;

  ctx.save();
  ctx.textBaseline = 'alphabetic';
  const boxLeft = originX - af * boxWidth;
  if (fillColor) {
    ctx.fillStyle = fillColor;
    ctx.fillRect(boxLeft, originY - b2t, boxWidth, lineCount * lineHeight);
  }
  setRenderKernelScalars(
    originX,
    originY,
    af,
    lineHeight,
    b2t,
    isFixed ? boxLeft : -Infinity,
    isFixed ? boxLeft + boxWidth : Infinity,
    fontSize * 0.25,
  );
  renderRunsCore(
    ctx,
    layout.lineRunStart,
    isFixed ? layout.lineAlignW : layout.lineAdvW,
    0,
    lineCount,
    layout.runText,
    layout.runFontIdx,
    layout.runHl,
    layout.runAdvW,
    layout.runAdvX,
    0,
    color,
  );
  ctx.restore();
}

// =============================================================================
// §7  SPATIAL — derived frame / BBox
// =============================================================================

const _bboxScratch: BBoxTuple = [0, 0, 0, 0];

export function computeTextBBox(objectId: string, props: TextProps): BBoxTuple {
  const { content, origin, fontSize, fontFamily, align, width } = props;
  const sc = textLayoutCache.getLayout(objectId, content, fontSize, fontFamily, width);
  const fx = origin[0] - anchorFactor(align) * sc.boxWidth;
  const fy = origin[1] - fontSize * getBaselineToTopRatioByCode(sc.famCode);
  const fh = sc.lineCount * sc.lineHeight;
  const fc = getFrameCol();
  const o = sc.slot << 2;
  fc[o] = fx;
  fc[o + 1] = fy;
  fc[o + 2] = sc.boxWidth;
  fc[o + 3] = fh;
  const padH = getItalicOverhangPad(fontSize);
  _bboxScratch[0] = fx - padH;
  _bboxScratch[1] = fy - 2;
  _bboxScratch[2] = fx + sc.boxWidth + padH;
  _bboxScratch[3] = fy + fh + 2;
  return _bboxScratch;
}

export function getTextFrame(objectId: string): FrameTuple | null {
  return textLayoutCache.getFrame(objectId);
}

export function getInlineStyles(objectId: string): UniformStyles | null {
  return textLayoutCache.getInlineStyles(objectId);
}

/** Layout scalars of a known slot (sticky-note's getNoteLayout return path).
 *  Same module scratch as the facade's scalar readers. */
export function layoutScalarsOfSlot(ts: number): TextLayoutScalars {
  return fillScalars(ts);
}
