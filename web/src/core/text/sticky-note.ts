/**
 * STICKY NOTE
 *
 * Owns everything sticky-note-specific: constants, geometry helpers, the
 * directional shadow cache, body renderer, full canvas draw, bbox, and the
 * auto-font-size search. Runs on the shared SoA text store — one slot resolve
 * per operation, then pure column/pool-lane reads.
 *
 * Auto-size search machinery is engine-shaped end to end:
 *   - `NOTE_FONT_STEPS` is a Uint8Array (every step is a positive integer ≤
 *     54 — loads are Smis, not doubles); the per-oversized-word step lookup
 *     AND the educated phase starts are O(1) floor-LUT loads
 *     (`STEP_FOR_FLOOR`) — legal because integer steps make
 *     `step ≤ x ⟺ step ≤ ⌊x⌋` exact.
 *   - `noteFlowCheck` returns a single int: FLOW_FITS (−1),
 *     FLOW_HEIGHT_OVERFLOW (−2), or a jump-to-step index (≥ 0) — one sign
 *     test splits the jump class from the verdicts, every call site stays
 *     monomorphic on number.
 *   - `layoutNoteContentSlot` returns the derived font size as a plain number
 *     and commits the layout through the shared staging→pool path.
 *
 * Dependency direction is one-way: sticky-note → text-system → text-store.
 */

import type * as Y from 'yjs';
import { readNoteRender } from '@/renderer/render-accessors';
import type { FontFamily, NoteProps } from '../accessors';
import type { BBoxTuple } from '../types/geometry';
import type { ObjectHandle } from '../types/objects';
import { famCodeOf, LINE_HEIGHT_MULT } from './font-config';
import { isBreakOpportunity, nextSoftBreak } from './line-break';
import { beginFontQuad, getBaselineToTopRatioByCode, measureTextByIdx, quadFontIdx } from './text-measure';
import {
  ensureTextSlot,
  getFrameCol,
  getParaTok,
  getR,
  getS,
  getSegAdvW,
  getSegFontIdx,
  getSegStyle,
  getSegText,
  getTokAdvW,
  getTokSeg,
  textSlotFast,
  textSlotOf,
} from './text-store';
import {
  anchorFactor,
  commitFlowToSlot,
  commitTokenizedToSlot,
  flowSlotContent,
  getNoteContentOffsetY,
  layoutScalarsOfSlot,
  measureSlot,
  renderRunsForSlot,
  setRenderKernelScalars,
  sliceTextToFit,
  type TextLayoutScalars,
  tokenizeFragment,
} from './text-system';

// =============================================================================
// CONSTANTS
// =============================================================================

export const NOTE_WIDTH = 145;

const NOTE_PADDING_RATIO = 20 / 280;
const NOTE_CORNER_RADIUS_RATIO = 0.06;
// Asymmetric shadow pads — the shadow is directional (mostly downward), so
// top/sides need only a small halo while the bottom contains the downward tail.
// Bookmarks track their own ratios (see bookmark-render.ts) — the shadow cache
// is per-kind and not shared.
const NOTE_SHADOW_TOP_RATIO = 0.06;
const NOTE_SHADOW_SIDE_RATIO = 0.075;
const NOTE_SHADOW_BOTTOM_RATIO = 0.12;

const BASE_PADDING = NOTE_WIDTH * NOTE_PADDING_RATIO;
const BASE_CONTENT_WIDTH = NOTE_WIDTH * (1 - 2 * NOTE_PADDING_RATIO);
const CW100 = BASE_CONTENT_WIDTH * 100; // widest-word bound numerator, hoisted

// Strictly descending, integer steps — both phases binary-search this array,
// which requires monotonicity of `noteFlowCheck` in font size (smaller step ⇒
// maxW100 and maxLines both grow ⇒ anything that fits at step s fits below it).
// Max step 54 — the LUT clamps (`x >= 54 ? 54 : x | 0`) bake that literal.
const NOTE_FONT_STEPS = new Uint8Array([
  54, 48, 44, 43, 42, 41, 40, 38, 37, 36, 35, 34, 33, 32, 31, 30, 29, 28, 27, 26, 25, 24, 23, 22, 21, 20, 19, 18, 17, 16, 15, 14, 13, 12,
  11, 10, 9, 8,
]);
const NOTE_STEP_COUNT = NOTE_FONT_STEPS.length;
const NOTE_PHASE1_FLOOR = 11;
const NOTE_PHASE1_FLOOR_IDX: number = (() => {
  for (let i = 0; i < NOTE_STEP_COUNT; i++) {
    if (NOTE_FONT_STEPS[i] < NOTE_PHASE1_FLOOR) return i;
  }
  return NOTE_STEP_COUNT;
})();

// O(1) step lookup: STEP_FOR_FLOOR[f] = first step index whose step ≤ f, or
// NOTE_STEP_COUNT when none is (f < 8). Integer steps make the floor lookup
// exact. Serves the oversized-word jump verdict AND both phases' educated
// starts (an index of NOTE_STEP_COUNT simply empties the binary-search range —
// the "nothing can fit" case falls straight through to the fallback).
const STEP_FOR_FLOOR: Uint8Array = (() => {
  const a = new Uint8Array(55);
  for (let f = 0; f <= 54; f++) {
    let idx = NOTE_STEP_COUNT;
    for (let i = 0; i < NOTE_STEP_COUNT; i++) {
      if (NOTE_FONT_STEPS[i] <= f) {
        idx = i;
        break;
      }
    }
    a[f] = idx;
  }
  return a;
})();

// =============================================================================
// GEOMETRY HELPERS
// =============================================================================

export function getNotePadding(scale: number): number {
  return NOTE_WIDTH * scale * NOTE_PADDING_RATIO;
}

export function getNoteContentWidth(scale: number): number {
  return NOTE_WIDTH * scale * (1 - 2 * NOTE_PADDING_RATIO);
}

function getNoteCornerRadius(w: number): number {
  return w * NOTE_CORNER_RADIUS_RATIO;
}

function getNoteShadowPadTop(scale: number): number {
  return NOTE_WIDTH * scale * NOTE_SHADOW_TOP_RATIO;
}
function getNoteShadowPadSide(scale: number): number {
  return NOTE_WIDTH * scale * NOTE_SHADOW_SIDE_RATIO;
}
function getNoteShadowPadBottom(scale: number): number {
  return NOTE_WIDTH * scale * NOTE_SHADOW_BOTTOM_RATIO;
}

// =============================================================================
// TEXT COLOR — contrast pick from fill
// =============================================================================
//
// Called per visible note per frame from `drawStickyNote` (canvas) and from
// `TextTool` (Tiptap `--text-color` CSS var, and on every fillColor undo/redo
// fire). Hot path must be one Map.get with no allocation. The palette has 12
// entries; the cache settles at ≤12 in practice (more only if the context-menu
// hex input feeds custom colors). No eviction needed.

const _stickyTextColorCache = new Map<string, string>();

export function getStickyNoteTextColor(fill: string): string {
  let c = _stickyTextColorCache.get(fill);
  if (c !== undefined) return c;
  c = computeStickyTextColor(fill);
  _stickyTextColorCache.set(fill, c);
  return c;
}

function computeStickyTextColor(hex: string): string {
  const h = hex.charCodeAt(0) === 35 ? hex.slice(1) : hex;
  if (h.length !== 6) return '#1a1a1a';
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  // Rec. 709 luminance (no sRGB gamma) — same approximation as `presence-renderer.ts`.
  // Threshold 0.5 sits between the palette's near-black (#28282C, L≈0.16) and its
  // darkest light fill (#FF6E6E, L≈0.55).
  const L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return L > 0.5 ? '#1a1a1a' : '#ffffff';
}

// =============================================================================
// AUTO FONT SIZE — 100px ratio strategy, two-phase binary search over columns
// =============================================================================

// noteFlowCheck verdicts — negative sentinels so the ≥ 0 range IS the
// jump-to-step-index payload: one sign test separates the classes, and every
// call site stays monomorphic on number.
const FLOW_FITS = -1;
const FLOW_HEIGHT_OVERFLOW = -2;

/** First step index whose step fits `wordW100` on one content line, or
 *  NOTE_STEP_COUNT when none does. */
function findStepForWord(wordW100: number): number {
  const maxStep = CW100 / wordW100;
  // Float compare BEFORE the |0 truncation — maxStep can exceed int32 range.
  return STEP_FOR_FLOOR[maxStep >= 54 ? 54 : maxStep | 0];
}

/**
 * Inline flow simulation over the entry's pool lanes (bases pre-added by the
 * caller for para/tok; seg indices resolve through the packed tokSeg words).
 * Phase 1 treats words as atomic; phase 2 char-breaks via sliceTextToFit.
 * Mirrors the flow engine's Q1/Q2/Q3 ladder — see text-system §4 for the model.
 */
function noteFlowCheck(
  paraTok: Uint32Array,
  paraBase: number,
  paraCount: number,
  tokSeg: Uint32Array,
  tokAdvW: Float64Array,
  tokBase: number,
  segText: string[],
  segFontIdx: Uint16Array,
  segBase: number,
  maxW: number,
  maxLines: number,
  phase2: number,
): number {
  let lineCount = 0;

  for (let pi = 0; pi < paraCount; pi++) {
    const tStart = paraTok[paraBase + pi];
    const tEnd = paraTok[paraBase + pi + 1];

    if (tStart === tEnd) {
      lineCount++;
      if (lineCount > maxLines) return FLOW_HEIGHT_OVERFLOW;
      continue;
    }

    let curW = 0;
    let hasInk = 0;
    let pendingW = 0;

    for (let ti = tStart; ti < tEnd; ti++) {
      const tokWord = tokSeg[tokBase + ti];
      const tokAdvance = tokAdvW[tokBase + ti];
      if (tokWord >>> 31 === 1) {
        if (hasInk === 0) curW += tokAdvance;
        else pendingW += tokAdvance;
        continue;
      }

      // Fast path: word fits remaining space (after committing pending WS).
      if (curW + pendingW + tokAdvance <= maxW) {
        curW += pendingW + tokAdvance;
        pendingW = 0;
        hasInk = 1;
        continue;
      }

      // Phase 1 bails out on oversized words — char-breaking not allowed yet.
      if (tokAdvance > maxW && phase2 === 0) return findStepForWord(tokAdvance);

      // Per-sub-segment ladder — mirrors the flow engine. Commit pending WS to
      // the current line so intra-word break opportunities can place the
      // leading sub-segment on the same line (e.g. `Char-` after `is `).
      curW += pendingW;
      pendingW = 0;

      const sStart = segBase + (tokWord & 0x7fffffff);
      const sEnd = segBase + (tokSeg[tokBase + ti + 1] & 0x7fffffff);
      for (let s = sStart; s < sEnd; s++) {
        const fontIdx = segFontIdx[s];
        const fullText = segText[s];

        // First seg: word-leading position is a break. Else classify the seam.
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
          const lineRemaining = maxW - curW;
          const canSoftBreak = cursor > 0 || segEntryIsBreak;

          // Q1 — fits as-is.
          if (chunkW <= lineRemaining) {
            curW += chunkW;
            cursor = segEnd;
            continue;
          }
          // Q2 — UAX#14 soft break: place atomic on a fresh line. Gated.
          if (canSoftBreak && chunkW <= maxW) {
            if (curW > 0) {
              lineCount++;
              if (lineCount > maxLines) return FLOW_HEIGHT_OVERFLOW;
              curW = 0;
            }
            curW += chunkW;
            cursor = segEnd;
            continue;
          }
          // Q3 — break-word char-slice. Pre-emptive line push only when truly
          // oversized at a real break op (matches DOM: oversized words start
          // fresh). Non-break seams fall straight into the slice loop.
          if (canSoftBreak && chunkW > maxW && curW > 0) {
            lineCount++;
            if (lineCount > maxLines) return FLOW_HEIGHT_OVERFLOW;
            curW = 0;
          }
          while (cursor < segEnd) {
            let lr = maxW - curW;
            // Guard 1 — line full; wrap before slicing.
            if (lr <= 0 && curW > 0) {
              lineCount++;
              if (lineCount > maxLines) return FLOW_HEIGHT_OVERFLOW;
              curW = 0;
              lr = maxW;
            }
            const r = sliceTextToFit(fontIdx, fullText, lr, cursor, segEnd);
            // Guard 2 — oversized grapheme on a non-empty line; wrap, retry.
            if (r.headW > lr && curW > 0) {
              lineCount++;
              if (lineCount > maxLines) return FLOW_HEIGHT_OVERFLOW;
              curW = 0;
              continue;
            }
            curW += r.headW;
            cursor += r.head.length;
            if (cursor < segEnd) {
              lineCount++;
              if (lineCount > maxLines) return FLOW_HEIGHT_OVERFLOW;
              curW = 0;
            }
          }
        }
      }
      hasInk = 1;
    }

    lineCount++;
    if (lineCount > maxLines) return FLOW_HEIGHT_OVERFLOW;
  }

  return FLOW_FITS;
}

/**
 * Auto-size `ts`'s content (measured at 100px) and commit the note layout.
 * Phase B mutates the advance-width lanes in place from 100px to the derived
 * size (never reused for 100px work — the next miss re-measures), then flows
 * at base content width. Returns the derived font size.
 */
function layoutNoteContentSlot(ts: number, famCode: number): number {
  const R = getR();
  const b16 = ts << 4;
  const paraBase = R[b16];
  const paraCount = R[b16 + 1]; // ≥ 1 always — the tokenizer forces one paragraph
  const tokBase = R[b16 + 3];
  const tokCount = R[b16 + 4];
  const segBase = R[b16 + 6];
  const segCount = R[b16 + 7];
  const paraTok = getParaTok();
  const tokSeg = getTokSeg();
  const tokAdvW = getTokAdvW();
  const segText = getSegText();
  const segStyle = getSegStyle();
  const segFontIdx = getSegFontIdx();
  const segAdvW = getSegAdvW();

  const contentWidth = BASE_CONTENT_WIDTH;
  const contentHeight = contentWidth;
  const lhMult = LINE_HEIGHT_MULT[famCode];
  const lineH100 = 100 * lhMult;

  // Single scan: widest word at 100px.
  let maxWordW100 = 0;
  for (let ti = 0; ti < tokCount; ti++) {
    if (tokSeg[tokBase + ti] >>> 31 === 0) {
      const w = tokAdvW[tokBase + ti];
      if (w > maxWordW100) maxWordW100 = w;
    }
  }
  // Educated starts — two LUT loads. heightMax bounds by paragraph count
  // alone; phase 1 additionally requires the widest word to fit one line.
  const heightMax = contentHeight / (paraCount * lhMult);
  const phase1MaxByWord = maxWordW100 > 0 ? CW100 / maxWordW100 : heightMax;
  const phase1Max = phase1MaxByWord < heightMax ? phase1MaxByWord : heightMax;
  const startIdxP2 = STEP_FOR_FLOOR[heightMax >= 54 ? 54 : heightMax | 0];
  const startIdxP1 = STEP_FOR_FLOOR[phase1Max >= 54 ? 54 : phase1Max | 0];

  let derivedFontSize: number = NOTE_FONT_STEPS[NOTE_STEP_COUNT - 1];
  let enterPhase2 = 0;

  // Phase 1 — words atomic, floor 11px.
  {
    let lo = startIdxP1;
    let hi = NOTE_PHASE1_FLOOR_IDX;
    let answer = -1;

    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const step = NOTE_FONT_STEPS[mid];
      const scale = step / 100;
      const maxLines = Math.floor(contentHeight / (lineH100 * scale));

      if (maxLines < 1 || paraCount > maxLines) {
        lo = mid + 1;
        continue;
      }

      const result = noteFlowCheck(
        paraTok,
        paraBase,
        paraCount,
        tokSeg,
        tokAdvW,
        tokBase,
        segText,
        segFontIdx,
        segBase,
        contentWidth / scale,
        maxLines,
        0,
      );

      if (result === FLOW_FITS) {
        answer = mid;
        hi = mid;
      } else if (result === FLOW_HEIGHT_OVERFLOW) {
        lo = mid + 1;
      } else {
        // result ≥ 0 — word-too-wide lower bound (jump-to-step index).
        if (result >= NOTE_PHASE1_FLOOR_IDX) {
          enterPhase2 = 1;
          break;
        }
        lo = mid + 1 > result ? mid + 1 : result;
      }
    }

    if (answer !== -1) derivedFontSize = NOTE_FONT_STEPS[answer];
    else enterPhase2 = 1;
  }

  // Phase 2 — char-breaking relaxes the word-width constraint; height is the
  // only remaining bound, so the check is a pure fits/overflow verdict.
  if (enterPhase2 !== 0) {
    let lo = startIdxP2;
    let hi = NOTE_STEP_COUNT;
    let answer = -1;

    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const step = NOTE_FONT_STEPS[mid];
      const scale = step / 100;
      const maxLines = Math.floor(contentHeight / (lineH100 * scale));

      if (maxLines < 1 || paraCount > maxLines) {
        lo = mid + 1;
        continue;
      }

      if (
        noteFlowCheck(
          paraTok,
          paraBase,
          paraCount,
          tokSeg,
          tokAdvW,
          tokBase,
          segText,
          segFontIdx,
          segBase,
          contentWidth / scale,
          maxLines,
          1,
        ) === FLOW_FITS
      ) {
        answer = mid;
        hi = mid;
      } else {
        lo = mid + 1;
      }
    }

    if (answer !== -1) derivedFontSize = NOTE_FONT_STEPS[answer];
  }

  // Phase B: rescale the measured lanes in place 100px → derived, re-intern
  // fonts at the derived size (lazy quad — only combos the content uses), flow.
  const ratio = derivedFontSize / 100;
  beginFontQuad(derivedFontSize, famCode);
  for (let s = segBase, e = segBase + segCount; s < e; s++) {
    segAdvW[s] *= ratio;
    segFontIdx[s] = quadFontIdx(segStyle[s] & 3);
  }
  for (let t = tokBase, e = tokBase + tokCount; t < e; t++) tokAdvW[t] *= ratio;

  const S = getS();
  const b8 = ts << 3;
  S[b8] = NaN; // lanes are note-scaled now — a text-style getLayout must re-measure
  S[b8 + 6] = derivedFontSize * lhMult;

  flowSlotContent(ts, contentWidth);
  commitFlowToSlot(ts, derivedFontSize, famCode, contentWidth);
  return derivedFontSize;
}

/**
 * Get or compute the note layout. Always at base dimensions; scale-independent.
 * Returns the layout scalars (module scratch — consume before the next
 * scalar-returning cache call); most callers invoke it for population only.
 */
export function getNoteLayout(objectId: string, fragment: Y.XmlFragment, fontFamily: FontFamily): TextLayoutScalars {
  const ts = ensureTextSlot(objectId);
  const famCode = famCodeOf(fontFamily);
  const R = getR();
  const S = getS();
  const status = R[(ts << 4) + 15];
  const dfs = S[(ts << 3) + 5];

  // Tier 1 — fused content-valid + family probe, derived size non-NaN.
  if ((status & 0xff01) === ((famCode << 8) | 1) && dfs === dfs) {
    return layoutScalarsOfSlot(ts);
  }

  // Tier 2/3 — (re-tokenize when content stale, then) measure at 100px + auto-size.
  if ((status & 1) === 0) {
    tokenizeFragment(fragment);
    commitTokenizedToSlot(ts);
  }
  measureSlot(ts, 100, famCode);
  const derived = layoutNoteContentSlot(ts, famCode);
  S[(ts << 3) + 5] = derived;
  return layoutScalarsOfSlot(ts);
}

/** Auto-derived font size for a note. Falls back to the largest step when the
 *  entry is absent or stale (NaN column probe). */
export function getNoteDerivedFontSize(objectId: string): number {
  const ts = textSlotOf(objectId);
  if (ts < 0) return NOTE_FONT_STEPS[0];
  const v = getS()[(ts << 3) + 5];
  return v !== v ? NOTE_FONT_STEPS[0] : v;
}

// =============================================================================
// SHADOW SYSTEM — single-entry cache, fixed dimensions
// =============================================================================
//
// Notes are always rendered at NOTE_WIDTH × NOTE_WIDTH inside `ctx.scale(noteScale)`,
// so the cache content is dimension-invariant — one canvas, baked once per DPR,
// drawn with one `drawImage` per note. No LRU, no keying.
//
// Shadow design: dual gaussian (drop + contact) over the same body path, then
// punched with the same path. The matching paths eliminate AA stroke fringe.
// Asymmetric pad — bottom holds the long downward tail, top/sides hold a tight
// halo. Drop offset > blur pushes the gaussian's mass below the body so the
// above-body extent collapses to ~0.

const SHADOW_DROP_BLUR_RATIO = 0.04;
const SHADOW_DROP_OFFSET_RATIO = 0.045;
const SHADOW_DROP_COLOR = 'rgba(0,0,0,0.11)';
const SHADOW_CONTACT_BLUR_RATIO = 0.013;
const SHADOW_CONTACT_OFFSET_RATIO = 0.008;
const SHADOW_CONTACT_COLOR = 'rgba(0,0,0,0.07)';

let _noteShadow: OffscreenCanvas | null = null;
let _noteShadowDpr = 0;

function ensureNoteShadow(dpr: number): OffscreenCanvas {
  if (_noteShadow && _noteShadowDpr === dpr) return _noteShadow;

  const w = NOTE_WIDTH;
  const padTop = w * NOTE_SHADOW_TOP_RATIO;
  const padSide = w * NOTE_SHADOW_SIDE_RATIO;
  const padBottom = w * NOTE_SHADOW_BOTTOM_RATIO;
  const totalW = w + 2 * padSide;
  const totalH = w + padTop + padBottom;
  const r = getNoteCornerRadius(w);

  const canvas = new OffscreenCanvas(Math.ceil(totalW * dpr), Math.ceil(totalH * dpr));
  const ctx = canvas.getContext('2d')!;
  ctx.scale(dpr, dpr);
  ctx.fillStyle = '#000';

  // Single body path — used for both shadow casters and the punch. Identical
  // path each time means the punch removes every black pixel deposited by the
  // fills, leaving only the gaussian halo around the original body silhouette.
  ctx.beginPath();
  ctx.roundRect(padSide, padTop, w, w, r);

  // Drop — the long downward tail.
  ctx.shadowColor = SHADOW_DROP_COLOR;
  ctx.shadowBlur = w * SHADOW_DROP_BLUR_RATIO;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = w * SHADOW_DROP_OFFSET_RATIO;
  ctx.fill();

  // Contact — tight halo anchored at the body edge.
  ctx.shadowColor = SHADOW_CONTACT_COLOR;
  ctx.shadowBlur = w * SHADOW_CONTACT_BLUR_RATIO;
  ctx.shadowOffsetY = w * SHADOW_CONTACT_OFFSET_RATIO;
  ctx.fill();

  // Punch the body — removes every opaque fill pixel, leaving only the halo.
  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;
  ctx.globalCompositeOperation = 'destination-out';
  ctx.fill();
  ctx.globalCompositeOperation = 'source-over';

  _noteShadow = canvas;
  _noteShadowDpr = dpr;
  return canvas;
}

// Pre-computed pad values for hot path — all derived from NOTE_WIDTH (constant).
const NOTE_PAD_TOP = NOTE_WIDTH * NOTE_SHADOW_TOP_RATIO;
const NOTE_PAD_SIDE = NOTE_WIDTH * NOTE_SHADOW_SIDE_RATIO;
const NOTE_PAD_BOTTOM = NOTE_WIDTH * NOTE_SHADOW_BOTTOM_RATIO;
const NOTE_SHADOW_TOTAL_W = NOTE_WIDTH + 2 * NOTE_PAD_SIDE;
const NOTE_SHADOW_TOTAL_H = NOTE_WIDTH + NOTE_PAD_TOP + NOTE_PAD_BOTTOM;
const NOTE_CORNER_R = getNoteCornerRadius(NOTE_WIDTH);

function drawNoteShadow(ctx: CanvasRenderingContext2D, x: number, y: number): void {
  const dpr = window.devicePixelRatio || 1;
  const canvas = ensureNoteShadow(dpr);
  ctx.drawImage(canvas, x - NOTE_PAD_SIDE, y - NOTE_PAD_TOP, NOTE_SHADOW_TOTAL_W, NOTE_SHADOW_TOTAL_H);
}

// =============================================================================
// BODY RENDERER
// =============================================================================

export function renderNoteBody(ctx: CanvasRenderingContext2D, x: number, y: number, fillColor: string): void {
  drawNoteShadow(ctx, x, y);

  ctx.fillStyle = fillColor;
  ctx.beginPath();
  ctx.roundRect(x, y, NOTE_WIDTH, NOTE_WIDTH, NOTE_CORNER_R);
  ctx.fill();
}

// =============================================================================
// STICKY NOTE RENDERER
// =============================================================================

export function drawStickyNote(ctx: CanvasRenderingContext2D, handle: ObjectHandle, isEditing: boolean): void {
  const ts = textSlotFast(handle.slot, handle.id);
  if (ts < 0) return; // cold-miss race — observer fills the cache before render
  const S = getS();
  const b8 = ts << 3;
  const derivedFontSize = S[b8 + 5];
  if (derivedFontSize !== derivedFontSize) return; // NaN ⇒ note tiers never ran

  const r = readNoteRender(handle.y);
  const af = anchorFactor(r.align);

  ctx.save();
  ctx.translate(r.originX, r.originY);
  ctx.scale(r.scale, r.scale);

  renderNoteBody(ctx, 0, 0, r.fillColor);

  if (isEditing) {
    ctx.restore();
    return;
  }

  const R = getR();
  const b16 = ts << 4;
  const lineCount = R[b16 + 10];
  const lineHeight = S[b8 + 3];
  // famCode off the status word — the deep observer runs getNoteLayout before
  // any draw, so the byte tracks the Y.Map's fontFamily; no string read, no
  // record lookup per frame.
  const b2t = getBaselineToTopRatioByCode((R[b16 + 15] >>> 8) & 255) * derivedFontSize;
  const contentWidth = BASE_CONTENT_WIDTH;
  const maxContentH = contentWidth;
  const contentH = lineCount * lineHeight;
  const vOffset = getNoteContentOffsetY(r.alignV, maxContentH, contentH);
  const textY = BASE_PADDING + vOffset + b2t;
  const noteAnchorX = BASE_PADDING + af * contentWidth;

  if (contentH > maxContentH) {
    ctx.beginPath();
    ctx.rect(BASE_PADDING, BASE_PADDING, contentWidth, maxContentH);
    ctx.clip();
  }

  ctx.textBaseline = 'alphabetic';
  setRenderKernelScalars(noteAnchorX, textY, af, lineHeight, b2t, BASE_PADDING, BASE_PADDING + contentWidth, derivedFontSize * 0.25);
  renderRunsForSlot(ctx, ts, 1, getStickyNoteTextColor(r.fillColor));

  ctx.restore();
}

// =============================================================================
// BBOX
// =============================================================================

const _noteBBoxScratch: BBoxTuple = [0, 0, 0, 0];

export function computeNoteBBox(objectId: string, props: NoteProps): BBoxTuple {
  const { content, origin, scale, fontFamily } = props;
  const noteW = NOTE_WIDTH * scale;
  const sc = getNoteLayout(objectId, content, fontFamily); // populate + slot
  const fc = getFrameCol();
  const o = sc.slot << 2;
  fc[o] = origin[0];
  fc[o + 1] = origin[1];
  fc[o + 2] = noteW;
  fc[o + 3] = noteW;

  const padTop = getNoteShadowPadTop(scale);
  const padSide = getNoteShadowPadSide(scale);
  const padBottom = getNoteShadowPadBottom(scale);
  _noteBBoxScratch[0] = origin[0] - padSide;
  _noteBBoxScratch[1] = origin[1] - padTop;
  _noteBBoxScratch[2] = origin[0] + noteW + padSide;
  _noteBBoxScratch[3] = origin[1] + noteW + padBottom;
  return _noteBBoxScratch;
}
