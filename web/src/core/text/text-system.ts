/**
 * TEXT LAYOUT SYSTEM — pipeline + facade over the SoA text store
 *
 * Three-stage pipeline: Tokenize → Measure → Flow, all operating on the
 * cross-entry pooled storage in `text-store.ts` (one set of global typed-array
 * lanes for EVERY entry, addressed by per-slot base offsets — no per-id buffer
 * objects, no nested heap layout).
 *
 *   Y.XmlFragment
 *       ↓ tokenizeFragment() → staging          §2
 *       ↓ commitTokenizedToSlot(ts)             (content tier: topology + text + style)
 *       ↓ measureSlot(ts, fontSize, famCode)    §3  — IN PLACE over the pool:
 *                                                    writes only the advance-width
 *                                                    and font-index lanes; the old
 *                                                    tokenized→measured full topology
 *                                                    copy is gone
 *       ↓ flowSlotContent(ts, maxWidth) → staging    §4
 *       ↓ commitFlowToSlot(ts, …)               (layout tier: lines + runs)
 *       ↓ renderRunsForSlot()                   §6  canvas output
 *       ↓ computeTextBBox()                     §7  spatial index
 *
 * The flow engine is ONE base-offset-parameterized core (`flowCore`) — the
 * cache path hands it pool lanes + entry bases; the transform shim hands it a
 * `MeasuredContent` view (same lane types, its own bases), so both paths run
 * the identical monomorphic code. Its output lands in module staging arrays
 * and is committed to a pool range, an object `TextLayout` (transform reflow
 * sidecar), or rendered straight from staging (label transform preview).
 *
 * Staleness is columnar, sentinel-driven (see text-store header): NaN
 * measuredFontSize fails the `=== fontSize` compare exactly like a stale tag,
 * Infinity layoutWidthReq encodes 'auto' AND the flow maxWidth in one value.
 * The three-tier invalidation contract is unchanged:
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
  getUniHlCol,
  HL_STRINGS,
  internHighlight,
  type MeasuredContent,
  measuredViewOf,
  releaseTextSlot,
  resetTextStore,
  syncViewIfAny,
  TS_ALL_BOLD,
  TS_ALL_ITALIC,
  TS_CONTENT_VALID,
  TS_FAM_SHIFT,
  textSlotFast,
  textSlotOf,
} from './text-store';

export type { FontFamily, TextAlign, TextAlignV, TextProps, TextWidth } from '../accessors';
export type { FontFamilyConfig } from './font-config';
export { FONT_FAMILIES, FONT_WEIGHTS } from './font-config';
export type { MeasuredContent } from './text-store';

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
    maxWidthReq: Number.POSITIVE_INFINITY,
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
 *  scalar readers. Consume before the next scalar-returning cache call. */
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
  _scalars.famCode = (R[b16 + 15] >>> TS_FAM_SHIFT) & 255;
  _scalars.lineHeight = S[b8 + 3];
  _scalars.lineCount = R[b16 + 10];
  _scalars.boxWidth = S[b8 + 4];
  return _scalars;
}

// =============================================================================
// §2  TOKENIZE — Y.XmlFragment → staging → content tier
// =============================================================================

// Whitespace producing word-break opportunities. Excludes the NBSP family
// (U+00A0 NBSP, U+202F narrow NBSP, U+2007 figure space, U+2060 WJ, U+FEFF
// ZWNBSP) — those stay inside word tokens; the UAX#14 classifier (LB11/LB12)
// glues across them. Also excludes ZWSP (U+200B), which provides an in-word
// break opportunity via the ZW class instead.
const WS_FIRST_CHAR = /^[\t\n\v\f\r 　]/;
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
let _tUniBits = 0; // TS_ALL_BOLD | TS_ALL_ITALIC result
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
        const attrs = op.attributes || {};
        const styleBits = (attrs.bold ? 1 : 0) | (attrs.italic ? 2 : 0);
        const hlAttr = attrs.highlight;
        let hlIdx = 0;
        if (hlAttr != null) {
          const color =
            typeof hlAttr === 'object' && (hlAttr as Record<string, unknown>).color
              ? String((hlAttr as Record<string, unknown>).color)
              : '#ffd43b';
          hlIdx = internHighlight(color);
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
          stagePush(paraStartTok, WS_FIRST_CHAR.test(chunk) ? 1 : 0, chunk, styleBits, hlIdx);
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

  _tUniBits = hasAnyText !== 0 ? (trackBold !== 0 ? TS_ALL_BOLD : 0) | (trackItalic !== 0 ? TS_ALL_ITALIC : 0) : 0;
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
  const segStyle = getSegStyle();
  const segHl = getSegHl();
  for (let i = 0; i < _tSc; i++) {
    segText[segBase + i] = _tSegText[i];
    segHl[segBase + i] = _tSegHl[i];
  }
  segStyle.set(_tSegStyle.subarray(0, _tSc), segBase);
  R[b16 + 15] = (R[b16 + 15] & ~(TS_CONTENT_VALID | TS_ALL_BOLD | TS_ALL_ITALIC)) | TS_CONTENT_VALID | _tUniBits;
  getUniHlCol()[ts] = _tUniHl;
  const b8 = ts << 3;
  const S = getS();
  S[b8] = Number.NaN; // advance lanes stale
  S[b8 + 5] = Number.NaN; // note auto-size stale
  getFrameCol()[ts << 2] = Number.NaN;
  syncViewIfAny(ts);
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
  for (let ti = 0; ti < tc; ti++) {
    const sStart = segBase + (tokSeg[tokBase + ti] & 0x7fffffff);
    const sEnd = segBase + (tokSeg[tokBase + ti + 1] & 0x7fffffff);
    let total = 0;
    for (let s = sStart; s < sEnd; s++) {
      const style = segStyle[s];
      const fi = quadFontIdx(style & 3);
      segFontIdx[s] = fi;
      const w = style >>> 2 === 1 ? spaceWidthByIdx(fi) * segText[s].length : measureTextByIdx(fi, segText[s]);
      segAdvW[s] = w;
      total += w;
    }
    tokAdvW[tokBase + ti] = total;
  }

  const S = getS();
  const b8 = ts << 3;
  S[b8] = fontSize;
  S[b8 + 6] = fontSize * LINE_HEIGHT_MULT[famCode];
  R[b16 + 15] = (R[b16 + 15] & 0xff) | (famCode << TS_FAM_SHIFT);
  syncViewIfAny(ts);
}

// =============================================================================
// §4  FLOW — measured lanes → staging → (pool | TextLayout | direct render)
// =============================================================================

const SLICE_RESULT = { head: '', tail: '', headW: 0 };

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
): { head: string; tail: string; headW: number } {
  if (start >= endChar) {
    SLICE_RESULT.head = '';
    SLICE_RESULT.tail = '';
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
    SLICE_RESULT.tail = fullCe < text.length ? text.substring(fullCe) : '';
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
  const ce = charEnds[lo];
  const head = text.substring(start, ce);
  SLICE_RESULT.head = head;
  SLICE_RESULT.tail = text.substring(ce);
  SLICE_RESULT.headW = measureTextByIdx(fontIdx, head); // typically a probe cache hit
  return SLICE_RESULT;
}

// --- Flow staging (module-owned, grow-only, base-0) ---
let _fLineRunStart = new Uint32Array(33); // [lc + 1]
let _fLineAdvW = new Float64Array(32);
let _fLineAlignW = new Float64Array(32);
let _fLc = 0;
const _fRunText: string[] = new Array(64).fill('');
let _fRunFontIdx = new Uint16Array(64);
let _fRunHl = new Uint16Array(64);
let _fRunAdvW = new Float64Array(64);
let _fRunAdvX = new Float64Array(64);
let _fRc = 0;
let _fMaxAdvW = 0;

function ensureFlowLineCap(n: number): void {
  if (n < _fLineAdvW.length) return;
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
function ensureFlowRunCap(n: number): void {
  if (n < _fRunFontIdx.length) return;
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

// --- Line-builder scalars (single-threaded; one flow at a time) ---
let _bAdvX = 0;
let _bVisW = 0;
let _bInk = 0;
let _bRunStart = 0;

function resetBuilder(runStart: number): void {
  _bAdvX = 0;
  _bVisW = 0;
  _bInk = 0;
  _bRunStart = runStart;
}

function appendRun(fontIdx: number, hlIdx: number, isWs: number, text: string, w: number): void {
  if (text.length === 0) return;
  const ri = _fRc - 1;
  // Coalesce on identical font + highlight — two int compares.
  if (ri >= _bRunStart && _fRunFontIdx[ri] === fontIdx && _fRunHl[ri] === hlIdx) {
    _fRunText[ri] = _fRunText[ri] + text;
    _fRunAdvW[ri] = _fRunAdvW[ri] + w;
    if (isWs === 0) {
      _bInk = 1;
      _bVisW = _fRunAdvX[ri] + _fRunAdvW[ri];
    }
    _bAdvX += w;
    return;
  }
  ensureFlowRunCap(_fRc + 1);
  const r = _fRc;
  _fRunText[r] = text;
  _fRunFontIdx[r] = fontIdx;
  _fRunHl[r] = hlIdx;
  _fRunAdvW[r] = w;
  _fRunAdvX[r] = _bAdvX;
  _fRc = r + 1;
  if (isWs === 0) {
    _bInk = 1;
    _bVisW = _bAdvX + w;
  }
  _bAdvX += w;
}

function pushLine(): void {
  ensureFlowLineCap(_fLc + 1);
  const li = _fLc;
  _fLineRunStart[li + 1] = _fRc;
  _fLineAdvW[li] = _bAdvX;
  _fLineAlignW[li] = _bVisW;
  _fLc = li + 1;
  resetBuilder(_fRc);
}

function fixupParagraphEnd(maxWidth: number): void {
  if (_fLc === 0) return;
  const i = _fLc - 1;
  const aw = _fLineAdvW[i];
  _fLineAlignW[i] = aw < maxWidth ? aw : maxWidth;
}

// --- Pending inter-word whitespace (absolute segment indices) ---
let _pendSeg = new Int32Array(64);
let _pendCount = 0;
let _pendW = 0;

function clearPending(): void {
  _pendCount = 0;
  _pendW = 0;
}

function stashPending(segAdvW: Float64Array, sStart: number, sEnd: number): void {
  const need = _pendCount + (sEnd - sStart);
  if (need > _pendSeg.length) {
    const next = new Int32Array(need + (need >> 1) + 32);
    next.set(_pendSeg);
    _pendSeg = next;
  }
  for (let s = sStart; s < sEnd; s++) {
    _pendSeg[_pendCount++] = s;
    _pendW += segAdvW[s];
  }
}

function commitPending(segText: string[], segFontIdx: Uint16Array, segHl: Uint16Array, segAdvW: Float64Array): void {
  for (let i = 0; i < _pendCount; i++) {
    const s = _pendSeg[i];
    appendRun(segFontIdx[s], segHl[s], 1, segText[s], segAdvW[s]);
  }
  clearPending();
}

function appendAllSegments(
  segText: string[],
  segFontIdx: Uint16Array,
  segHl: Uint16Array,
  segAdvW: Float64Array,
  sStart: number,
  sEnd: number,
  isWs: number,
): void {
  for (let s = sStart; s < sEnd; s++) appendRun(segFontIdx[s], segHl[s], isWs, segText[s], segAdvW[s]);
}

/** Place a word token (absolute segment range [sStart, sEnd), total advance
 *  `tokAdvance`) on the current line.
 *
 *  Fast path: whole word fits remaining → drop in atomic. Otherwise drive a
 *  per-sub-segment ladder over UAX#14 break opportunities so intra-word break
 *  points (HY, BA, OP, …) are honored before falling back to char-slicing.
 *
 *  Two independent decision systems, layered (mirrors the CSS pipeline):
 *
 *   1. UAX#14 soft-break pass — Q1/Q2 walk break opportunities and place
 *      atomic chunks. Q2 (push-to-fresh-line) is gated by `canSoftBreak`
 *      so style-only seams (e.g. AL × AL across a bold/highlight boundary)
 *      don't behave as break opportunities.
 *
 *   2. break-word char-slice pass — Q3 operates exactly where UAX#14 forbids
 *      a break, so it is NOT gated by `canSoftBreak`. Two slice-loop guards
 *      cover the corner cases:
 *        (a) `lineRemaining ≤ 0` on a non-empty line — wrap before slicing,
 *            otherwise the slicer's forward-progress strands a grapheme on
 *            a full line (overflow).
 *        (b) forward-progress hands back a grapheme wider than `lr` on a
 *            non-empty line — wrap and retry on the fresh line. On an empty
 *            line a single oversized grapheme is appended unavoidably.
 *
 *  Seam classification: a word splits into segments by STYLE runs, not by
 *  UAX#14, so the seam between (s-1) and s is classified explicitly via
 *  `isBreakOpportunity`. Within a segment after the first chunk, cursor > 0
 *  implies a real break op (it's what `nextSoftBreak` just returned). */
function placeWord(
  segText: string[],
  segFontIdx: Uint16Array,
  segHl: Uint16Array,
  segAdvW: Float64Array,
  sStart: number,
  sEnd: number,
  tokAdvance: number,
  maxWidth: number,
): void {
  if (maxWidth === Number.POSITIVE_INFINITY || tokAdvance <= maxWidth - _bAdvX) {
    appendAllSegments(segText, segFontIdx, segHl, segAdvW, sStart, sEnd, 0);
    return;
  }

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
      const lineRemaining = maxWidth - _bAdvX;

      // cursor > 0 ⇒ post-nextSoftBreak position (a real break op by definition).
      const canSoftBreak = cursor > 0 || segEntryIsBreak;

      // Q1 — fits the current line as-is. Always allowed.
      if (chunkW <= lineRemaining) {
        appendRun(fontIdx, hlIdx, 0, chunk, chunkW);
        cursor = segEnd;
        continue;
      }
      // Q2 — UAX#14 soft break: place atomic on a fresh line. Only legal at a
      // real break op; at a non-break seam fall through to Q3 char-slicing so
      // the remaining line space gets greedy-filled — matching DOM
      // `overflow-wrap: break-word`, where style runs never introduce break ops.
      if (canSoftBreak && chunkW <= maxWidth) {
        if (_fRc > _bRunStart) pushLine();
        appendRun(fontIdx, hlIdx, 0, chunk, chunkW);
        cursor = segEnd;
        continue;
      }
      // Q3 — break-word char-slice. Pre-emptive pushLine only when the chunk
      // is truly oversized at a real break op — matches DOM where oversized
      // words start on a fresh line. Non-break seams fall straight into the
      // slice loop; its guards handle the wrap.
      if (canSoftBreak && chunkW > maxWidth && _fRc > _bRunStart) {
        pushLine();
      }
      while (cursor < segEnd) {
        let lr = maxWidth - _bAdvX;
        // Guard 1 — line is full; wrap before slicing.
        if (lr <= 0 && _fRc > _bRunStart) {
          pushLine();
          lr = maxWidth;
        }
        const r = sliceTextToFit(fontIdx, fullText, lr, cursor, segEnd);
        // Guard 2 — oversized grapheme on a non-empty line; wrap, retry.
        if (r.headW > lr && _fRc > _bRunStart) {
          pushLine();
          continue;
        }
        appendRun(fontIdx, hlIdx, 0, r.head, r.headW);
        cursor += r.head.length;
        if (cursor < segEnd) pushLine();
      }
    }
  }
}

/**
 * THE flow engine — measured lanes in, staging out. Both storage worlds call
 * it with the same array types (pool lanes + entry bases, or a MeasuredContent
 * view's lanes), so the body stays monomorphic.
 */
function flowCore(
  paraTok: Uint32Array,
  paraBase: number,
  paraCount: number,
  tokSeg: Uint32Array,
  tokAdvW: Float64Array,
  tokBase: number,
  segText: string[],
  segFontIdx: Uint16Array,
  segHl: Uint16Array,
  segAdvW: Float64Array,
  segBase: number,
  maxWidth: number,
): void {
  _fLc = 0;
  _fRc = 0;
  _fLineRunStart[0] = 0;
  resetBuilder(0);
  clearPending();

  for (let pi = 0; pi < paraCount; pi++) {
    const tStart = paraTok[paraBase + pi];
    const tEnd = paraTok[paraBase + pi + 1];
    if (tStart === tEnd) {
      clearPending();
      pushLine();
      fixupParagraphEnd(maxWidth);
      continue;
    }
    for (let ti = tStart; ti < tEnd; ti++) {
      const tokWord = tokSeg[tokBase + ti];
      const sStart = segBase + (tokWord & 0x7fffffff);
      const sEnd = segBase + (tokSeg[tokBase + ti + 1] & 0x7fffffff);
      if (tokWord >>> 31 === 1) {
        // SPACE token.
        if (_bInk === 0) {
          appendAllSegments(segText, segFontIdx, segHl, segAdvW, sStart, sEnd, 1); // leading ws — can overflow
        } else if (maxWidth === Number.POSITIVE_INFINITY) {
          appendAllSegments(segText, segFontIdx, segHl, segAdvW, sStart, sEnd, 1);
        } else {
          stashPending(segAdvW, sStart, sEnd);
        }
        continue;
      }
      // WORD token. Commit pending inter-word WS to the current line and let
      // placeWord drive the per-sub-segment ladder. Pre-emptive line pushes
      // here would mask intra-word break opportunities.
      if (_bInk !== 0) {
        if (_pendW > 0) commitPending(segText, segFontIdx, segHl, segAdvW);
      } else {
        clearPending();
      }
      placeWord(segText, segFontIdx, segHl, segAdvW, sStart, sEnd, tokAdvW[tokBase + ti], maxWidth);
    }
    commitPending(segText, segFontIdx, segHl, segAdvW);
    pushLine();
    fixupParagraphEnd(maxWidth);
  }
  if (_fLc === 0) pushLine();

  let maxAdvW = 0;
  for (let i = 0; i < _fLc; i++) {
    if (_fLineAdvW[i] > maxAdvW) maxAdvW = _fLineAdvW[i];
  }
  _fMaxAdvW = maxAdvW;
}

/** Flow an entry's own content tier (pool lanes + its bases) into staging. */
export function flowSlotContent(ts: number, maxWidth: number): void {
  const R = getR();
  const b16 = ts << 4;
  flowCore(
    getParaTok(),
    R[b16],
    R[b16 + 1],
    getTokSeg(),
    getTokAdvW(),
    R[b16 + 3],
    getSegText(),
    getSegFontIdx(),
    getSegHl(),
    getSegAdvW(),
    R[b16 + 6],
    maxWidth,
  );
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
  S[b8 + 4] = widthReq === Number.POSITIVE_INFINITY ? _fMaxAdvW : widthReq;
  getFrameCol()[ts << 2] = Number.NaN; // layout changed ⇒ frame stale until bbox recompute
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
  out.boxWidth = widthReq === Number.POSITIVE_INFINITY ? _fMaxAdvW : widthReq;
}

/** Flow a measured view into staging WITHOUT committing anywhere — for callers
 *  that render the result within the same draw (label transform preview). */
export function flowMeasuredToStaging(content: MeasuredContent, maxWidth: number): void {
  flowCore(
    content.paraTok,
    content.paraBase,
    content.paraCount,
    content.tokSeg,
    content.tokAdvW,
    content.tokBase,
    content.segText,
    content.segFontIdx,
    content.segHl,
    content.segAdvW,
    content.segBase,
    maxWidth,
  );
}

/**
 * Object-path flow for shim consumers (transform reflow sidecar): lay `content`
 * out at `width` into `out`. The measured view's lanes feed the same flowCore
 * as the cache path.
 */
export function layoutMeasuredContent(content: MeasuredContent, width: TextWidth, fontSize: number, out?: TextLayout): TextLayout {
  const layout = out ?? createTextLayout();
  const maxW = typeof width === 'number' ? (width > 0.01 ? width : 0.01) : Number.POSITIVE_INFINITY;
  flowMeasuredToStaging(content, maxW);
  commitFlowToLayout(layout, fontSize, content.famCode, maxW, content.lineHeight);
  return layout;
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
  if ((R[b16 + 15] & TS_CONTENT_VALID) !== 0 && S[b8] === fontSize && ((R[b16 + 15] >>> TS_FAM_SHIFT) & 255) === famCode) {
    if (S[b8 + 1] === widthReq) return; // full hit
    // width changed only — reflow
    flowSlotContent(ts, widthReq);
    commitFlowToSlot(ts, fontSize, famCode, widthReq);
    return;
  }
  if ((R[b16 + 15] & TS_CONTENT_VALID) === 0) {
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
    const widthReq = typeof width === 'number' ? (width > 0.01 ? width : 0.01) : Number.POSITIVE_INFINITY;
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
    const R = getR();
    const S = getS();
    R[(ts << 4) + 15] &= ~TS_CONTENT_VALID;
    S[ts << 3] = Number.NaN;
    S[(ts << 3) + 5] = Number.NaN;
    getFrameCol()[ts << 2] = Number.NaN;
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
    if (Number.isNaN(x)) return null;
    const t = frameTupleOf(ts);
    t[0] = x;
    t[1] = fc[o + 1];
    t[2] = fc[o + 2];
    t[3] = fc[o + 3];
    return t;
  }

  /**
   * Measured-content view for reflow consumers (transform freeze, label
   * transform preview). One descriptor per entry, kept coherent by the store
   * across pool relocation — hold it for a gesture, feed it back to
   * `layoutMeasuredContent` per move.
   */
  getMeasuredContent(objectId: string): MeasuredContent | null {
    const ts = textSlotOf(objectId);
    if (ts < 0) return null;
    return measuredViewOf(ts);
  }

  /** Layout scalars without any staleness probe (observer keeps them fresh
   *  whenever the entry exists). Module scratch — consume immediately. */
  getLayoutScalarsById(objectId: string): TextLayoutScalars | null {
    const ts = textSlotOf(objectId);
    if (ts < 0) return null;
    const S = getS();
    if (Number.isNaN(S[(ts << 3) + 1])) return null; // no committed layout
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
    if ((status & TS_CONTENT_VALID) === 0) return null;
    _uniScratch.allBold = (status & TS_ALL_BOLD) !== 0;
    _uniScratch.allItalic = (status & TS_ALL_ITALIC) !== 0;
    const hl = getUniHlCol()[ts];
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

export function getLineStartX(originX: number, boxWidth: number, lineVisualWidth: number, align: TextAlign): number {
  const af = anchorFactor(align);
  return originX - af * boxWidth + (boxWidth - lineVisualWidth) * af;
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
// call): 0 originX · 1 firstBaselineY · 2 alignFactor · 3 boxWidth ·
// 4 lineHeight · 5 baselineToTop · 6 containerL · 7 containerR · 8 hlRadius.
// Unclamped draws pass containerL/R = ∓Infinity: the clamp min/max then return
// the raw edges and the radius picks stay full — the sentinel makes the single
// clamped body compute the unclamped result exactly, no mode branch.
const _rkF = new Float64Array(9);
const _hlRadii: [number, number, number, number] = [0, 0, 0, 0];

export function setRenderKernelScalars(
  originX: number,
  firstBaselineY: number,
  alignFactor: number,
  boxWidth: number,
  lineHeight: number,
  baselineToTop: number,
  containerL: number,
  containerR: number,
  hlRadius: number,
): void {
  _rkF[0] = originX;
  _rkF[1] = firstBaselineY;
  _rkF[2] = alignFactor;
  _rkF[3] = boxWidth;
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
  const boxWidth = _rkF[3];
  const lineHeight = _rkF[4];
  const b2t = _rkF[5];
  const cL = _rkF[6];
  const cR = _rkF[7];
  const hlR = _rkF[8];
  const boxLeft = originX - af * boxWidth;
  const hls = HL_STRINGS;
  const fonts = FONT_STRINGS;
  let lastFi = 0; // index 0 is the '' sentinel — first real run always sets ctx.font
  for (let li = 0; li < lineCount; li++) {
    const sr = runBase + lineRunStart[lineBase + li];
    const er = runBase + lineRunStart[lineBase + li + 1];
    if (sr === er) continue;
    const lineY = firstY + li * lineHeight;
    const startX = boxLeft + (boxWidth - lineW[lineBase + li]) * af;

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
  if (Number.isNaN(widthReq)) return; // no committed layout
  const R = getR();
  const b16 = ts << 4;
  const fontSize = S[b8 + 2];
  const lineHeight = S[b8 + 3];
  const boxWidth = S[b8 + 4];
  const lineCount = R[b16 + 10];
  const famCode = (R[b16 + 15] >>> TS_FAM_SHIFT) & 255;
  const b2t = getBaselineToTopRatioByCode(famCode) * fontSize;
  const af = anchorFactor(align);
  const isFixed = widthReq !== Number.POSITIVE_INFINITY;

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
    boxWidth,
    lineHeight,
    b2t,
    isFixed ? boxLeft : Number.NEGATIVE_INFINITY,
    isFixed ? boxLeft + boxWidth : Number.POSITIVE_INFINITY,
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
  const isFixed = layout.maxWidthReq !== Number.POSITIVE_INFINITY;

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
    boxWidth,
    lineHeight,
    b2t,
    isFixed ? boxLeft : Number.NEGATIVE_INFINITY,
    isFixed ? boxLeft + boxWidth : Number.POSITIVE_INFINITY,
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
