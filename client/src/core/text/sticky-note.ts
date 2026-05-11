/**
 * STICKY NOTE
 *
 * Owns everything sticky-note-specific: constants, geometry helpers, 9-slice
 * shadow cache, body renderer, full canvas draw, and bbox. Reuses the shared
 * tokenize/measure/layout pipeline in `text-system.ts` via `textLayoutCache`.
 *
 * Dependency direction is one-way: sticky-note → text-system.
 */

import type * as Y from 'yjs';
import { useSelectionStore } from '@/stores/selection-store';
import type { FontFamily, NoteProps } from '../accessors';
import { getNoteProps } from '../accessors';
import type { BBoxTuple, FrameTuple } from '../types/geometry';
import type { ObjectHandle } from '../types/objects';
import { FONT_FAMILIES } from './font-config';
import type { MeasuredContent, TextLayout } from './text-system';
import {
  anchorFactor,
  buildFontMatrix,
  createTextLayout,
  fontFromMatrix,
  getBaselineToTopRatio,
  getLineStartX,
  getNoteContentOffsetY,
  layoutMeasuredContent,
  measureTextCached,
  measureTokenizedContent,
  nextSoftBreak,
  parseAndTokenize,
  sliceTextToFit,
  textLayoutCache,
} from './text-system';

// =============================================================================
// CONSTANTS
// =============================================================================

export const NOTE_WIDTH = 145;
export const NOTE_FILL_COLOR = '#FEF3AC';

const NOTE_PADDING_RATIO = 20 / 280;
const NOTE_CORNER_RADIUS_RATIO = 0.06;
// Asymmetric shadow pads — the shadow is directional (mostly downward), so
// top/sides need only a small halo while the bottom contains the downward tail.
// Cache canvas, bbox, and visible halo extent all key off these. Exported so
// bookmarks track the exact same ratios (dirty-rect invariant).
export const NOTE_SHADOW_TOP_RATIO = 0.06; // ~7.5wu — fringe from drop's blur tail
export const NOTE_SHADOW_SIDE_RATIO = 0.075; // ~9.4wu — fits drop's gaussian tail (1.5·blur)
export const NOTE_SHADOW_BOTTOM_RATIO = 0.12; // ~15wu — fits drop's blur + offset with headroom

const BASE_CONTENT_WIDTH = NOTE_WIDTH * (1 - 2 * NOTE_PADDING_RATIO);
const NOTE_FONT_STEPS: number[] = [
  54, 48, 44, 43, 42, 41, 40, 38, 37, 36, 35, 34, 33, 32, 31, 30, 29, 28, 27, 26, 25, 24, 23, 22, 21, 20, 19, 18, 17, 16, 15, 14, 13, 12,
  11, 10, 9, 8,
];
const NOTE_PHASE1_FLOOR = 11;
const NOTE_PHASE1_FLOOR_IDX: number = (() => {
  for (let i = 0; i < NOTE_FONT_STEPS.length; i++) {
    if (NOTE_FONT_STEPS[i] < NOTE_PHASE1_FLOOR) return i;
  }
  return NOTE_FONT_STEPS.length;
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

export function getNoteCornerRadius(w: number): number {
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
// AUTO FONT SIZE — layoutNoteContent (100px ratio strategy, two-phase search)
// =============================================================================

function findStepForWord(wordW100: number, contentWidth: number): number {
  const maxStep = (contentWidth * 100) / wordW100;
  for (let i = 0; i < NOTE_FONT_STEPS.length; i++) {
    if (NOTE_FONT_STEPS[i] <= maxStep) return i;
  }
  return NOTE_FONT_STEPS.length;
}

type NoteFlowResult = 'fits' | 'heightOverflow' | number;

/**
 * Inline flow simulation. Phase 1 atomic words, Phase 2 char-breaking via sliceTextToFit.
 * Reads MeasuredContent SOA directly (per-token + per-segment arrays).
 */
function noteFlowCheck(measured: MeasuredContent, maxW: number, maxLines: number, phase2: boolean, contentWidth: number): NoteFlowResult {
  let lineCount = 0;

  for (let pi = 0; pi < measured.paragraphCount; pi++) {
    const tStart = measured.paragraphTokenStart[pi];
    const tEnd = measured.paragraphTokenStart[pi + 1];

    if (tStart === tEnd) {
      lineCount++;
      if (lineCount > maxLines) return 'heightOverflow';
      continue;
    }

    let curW = 0;
    let hasInk = false;
    let pendingW = 0;

    for (let ti = tStart; ti < tEnd; ti++) {
      const isSpace = measured.tokenKind[ti] === 1;
      const tokAdvance = measured.tokenAdvanceWidth[ti];
      if (isSpace) {
        if (!hasInk) curW += tokAdvance;
        else pendingW += tokAdvance;
        continue;
      }

      // Fast path: word fits remaining space (after committing pending WS).
      if (curW + pendingW + tokAdvance <= maxW) {
        curW += pendingW + tokAdvance;
        pendingW = 0;
        hasInk = true;
        continue;
      }

      // Phase 1 bails out on oversized words — char-breaking not allowed yet.
      if (tokAdvance > maxW && !phase2) return findStepForWord(tokAdvance, contentWidth);

      // Per-sub-segment Q1/Q2/Q3 ladder — mirrors `placeWord`. Commit pending
      // WS to the current line so intra-word break opportunities can place
      // the leading sub-segment on the same line (e.g. `Char-` after `is `).
      curW += pendingW;
      pendingW = 0;

      const sStart = measured.tokenSegStart[ti];
      const sEnd = measured.tokenSegStart[ti + 1];
      for (let s = sStart; s < sEnd; s++) {
        const font = measured.segFont[s];
        const fullText = measured.segText[s];
        let cursor = 0;
        while (cursor < fullText.length) {
          const segEnd = nextSoftBreak(fullText, cursor);
          const chunk = fullText.substring(cursor, segEnd);
          const chunkW = measureTextCached(font, chunk);
          const lineRemaining = maxW - curW;

          // Q1
          if (chunkW <= lineRemaining) {
            curW += chunkW;
            cursor = segEnd;
            continue;
          }
          // Q2
          if (chunkW <= maxW) {
            if (curW > 0) {
              lineCount++;
              if (lineCount > maxLines) return 'heightOverflow';
              curW = 0;
            }
            curW += chunkW;
            cursor = segEnd;
            continue;
          }
          // Q3 — phase 2 only (sub-segs of fits-maxW words can't exceed maxW).
          if (curW > 0) {
            lineCount++;
            if (lineCount > maxLines) return 'heightOverflow';
            curW = 0;
          }
          while (cursor < segEnd) {
            const r = sliceTextToFit(font, fullText, maxW - curW, cursor, segEnd);
            curW += r.headW;
            cursor += r.head.length;
            if (cursor < segEnd) {
              lineCount++;
              if (lineCount > maxLines) return 'heightOverflow';
              curW = 0;
            }
          }
        }
      }
      hasInk = true;
    }

    lineCount++;
    if (lineCount > maxLines) return 'heightOverflow';
  }

  return 'fits';
}

/**
 * Auto-size note content + produce a layout. Mutates MeasuredContent in place from 100px → derived font.
 */
function layoutNoteContent(
  measured: MeasuredContent,
  fontFamily: FontFamily,
  layoutBuf: TextLayout,
): { layout: TextLayout; derivedFontSize: number } {
  const contentWidth = BASE_CONTENT_WIDTH;
  const contentHeight = contentWidth;
  const lhMult = FONT_FAMILIES[fontFamily].lineHeightMultiplier;
  const lineH100 = 100 * lhMult;
  const paraCount = Math.max(1, measured.paragraphCount);

  // Find max word width (single pass)
  let maxWordW100 = 0;
  for (let ti = 0; ti < measured.tokenCount; ti++) {
    if (measured.tokenKind[ti] === 0) {
      const w = measured.tokenAdvanceWidth[ti];
      if (w > maxWordW100) maxWordW100 = w;
    }
  }
  const heightMax = contentHeight / (paraCount * lhMult);
  const phase1Max = maxWordW100 > 0 ? Math.min((contentWidth * 100) / maxWordW100, heightMax) : heightMax;

  let startIdxP1 = 0;
  let startIdxP2 = 0;
  {
    let foundP2 = false;
    for (let i = 0; i < NOTE_FONT_STEPS.length; i++) {
      const s = NOTE_FONT_STEPS[i];
      if (!foundP2 && s <= heightMax) {
        startIdxP2 = i;
        foundP2 = true;
      }
      if (s <= phase1Max) {
        startIdxP1 = i;
        break;
      }
    }
  }

  let derivedFontSize = NOTE_FONT_STEPS[NOTE_FONT_STEPS.length - 1];
  let enterPhase2 = false;

  // Phase 1
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

      const maxW100 = contentWidth / scale;
      const result = noteFlowCheck(measured, maxW100, maxLines, false, contentWidth);

      if (result === 'fits') {
        answer = mid;
        hi = mid;
      } else if (result === 'heightOverflow') {
        lo = mid + 1;
      } else {
        const jumpIdx = result as number;
        if (jumpIdx >= NOTE_PHASE1_FLOOR_IDX) {
          enterPhase2 = true;
          break;
        }
        lo = mid + 1 > jumpIdx ? mid + 1 : jumpIdx;
      }
    }

    if (answer !== -1) {
      derivedFontSize = NOTE_FONT_STEPS[answer];
    } else {
      enterPhase2 = true;
    }
  }

  // Phase 2
  if (enterPhase2) {
    let lo = startIdxP2;
    let hi = NOTE_FONT_STEPS.length;
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

      const maxW100 = contentWidth / scale;
      if (noteFlowCheck(measured, maxW100, maxLines, true, contentWidth) === 'fits') {
        answer = mid;
        hi = mid;
      } else {
        lo = mid + 1;
      }
    }

    if (answer !== -1) derivedFontSize = NOTE_FONT_STEPS[answer];
  }

  // Phase B: mutate measured to derived font size, build layout
  const ratio = derivedFontSize / 100;
  const F = buildFontMatrix(derivedFontSize, fontFamily);

  for (let s = 0; s < measured.segCount; s++) {
    measured.segAdvanceWidth[s] *= ratio;
    measured.segFont[s] = fontFromMatrix(F, measured.segBold[s] !== 0, measured.segItalic[s] !== 0);
  }
  for (let t = 0; t < measured.tokenCount; t++) measured.tokenAdvanceWidth[t] *= ratio;
  measured.lineHeight = derivedFontSize * lhMult;

  const layout = layoutMeasuredContent(measured, contentWidth, derivedFontSize, layoutBuf);
  return { layout, derivedFontSize };
}

/**
 * Get or compute layout for a note. Always at base dimensions; scale-independent.
 * Reads/writes shared cache via narrow accessors in textLayoutCache.
 */
export function getNoteLayout(objectId: string, fragment: Y.XmlFragment, fontFamily: FontFamily): TextLayout {
  const tokenized = textLayoutCache.noteCachedTokenized(objectId);
  const cachedFontFamily = textLayoutCache.noteCachedFontFamily(objectId);
  const derivedFontSize = textLayoutCache.noteCachedDerivedFontSize(objectId);
  const cachedLayout = textLayoutCache.noteCachedLayout(objectId);

  // Tier 1 — full hit
  if (tokenized !== null && cachedFontFamily === fontFamily && derivedFontSize !== null && cachedLayout !== null) {
    return cachedLayout;
  }

  // Tier 2 — content valid, fontFamily or derivedFontSize stale → re-measure + auto-size
  if (tokenized !== null) {
    const measuredBuf = textLayoutCache.noteCachedMeasured(objectId) ?? undefined;
    const measured = measureTokenizedContent(tokenized, 100, fontFamily, measuredBuf);
    const layoutBuf = cachedLayout ?? createTextLayout();
    const { layout, derivedFontSize: ds } = layoutNoteContent(measured, fontFamily, layoutBuf);
    textLayoutCache.setNoteResults(objectId, tokenized, measured, fontFamily, ds, layout);
    return layout;
  }

  // Tier 3 — full pipeline
  const t = parseAndTokenize(fragment);
  const m = measureTokenizedContent(t, 100, fontFamily);
  const lbuf = cachedLayout ?? createTextLayout();
  const { layout, derivedFontSize: ds } = layoutNoteContent(m, fontFamily, lbuf);
  textLayoutCache.setNoteResults(objectId, t, m, fontFamily, ds, layout);
  return layout;
}

/** Auto-derived font size for a note. Falls back to largest step when absent. */
export function getNoteDerivedFontSize(objectId: string): number {
  return textLayoutCache.noteCachedDerivedFontSize(objectId) ?? NOTE_FONT_STEPS[0];
}

// =============================================================================
// SHADOW SYSTEM — directional drop shadow, asymmetric cache (no slicing)
// =============================================================================
//
// Real drop shadows under gravity reach long below, minimal at the sides,
// none above. Native canvas `shadowBlur` is gaussian + isotropic, so blur
// alone always spreads side-to-side. Two coupled knobs make the shadow
// directional without resorting to a (canvas-unsupported) spread:
//
//   - small blur            keeps side spread tight
//   - offsetY ≥ blur·1.2    pushes the gaussian's mass clearly below body
//                           (so above-extent collapses to ~0)
//
// One body silhouette is filled twice — once with a wider drop shadow for
// the downward tail, once with a tight contact shadow that touches the body
// edge and covers any tiny gap left by drop's near edge. The same path is
// then punched. Single roundRect path → no expanded ring → no AA stroke.
//
// Cache canvas is asymmetric: top/sides hold the small halo, bottom holds
// the long downward extent. Saves cache memory and keeps bbox tight.
//
// Per-dimension LRU, max 16 entries. Notes always render at (125,125) → 1
// entry shared forever. Bookmarks render at (300, height) → one per unique
// height. Cleared on DPR change.

const SHADOW_CACHE_MAX = 16;
const _shadowCache = new Map<string, OffscreenCanvas>();
let _shadowCacheDpr = 0;

// All ratios of body width — proportions hold across note (125wu) and bookmark
// (300wu). Drop: visible extent below ≈ blur·1.2 + offset ≈ 9 %, side ≈ 5 %,
// above ≈ 0. Contact: anchors the shadow at the body edge so the halo reads as
// resting on a surface, not floating. Alphas tuned for natural paper-on-desk
// density: combined peak ≈ 0.16 on white (vs ~0.28 when over-cranked).
const SHADOW_DROP_BLUR_RATIO = 0.04;
const SHADOW_DROP_OFFSET_RATIO = 0.045;
const SHADOW_DROP_COLOR = 'rgba(0,0,0,0.11)';
const SHADOW_CONTACT_BLUR_RATIO = 0.013;
const SHADOW_CONTACT_OFFSET_RATIO = 0.008;
const SHADOW_CONTACT_COLOR = 'rgba(0,0,0,0.07)';

function ensureShadow(w: number, h: number, dpr: number): OffscreenCanvas {
  if (_shadowCacheDpr !== dpr) {
    _shadowCache.clear();
    _shadowCacheDpr = dpr;
  }

  const key = `${w.toFixed(2)}|${h.toFixed(2)}`;
  const hit = _shadowCache.get(key);
  if (hit) {
    // LRU touch — re-insert at the end of insertion order.
    _shadowCache.delete(key);
    _shadowCache.set(key, hit);
    return hit;
  }

  // Evict oldest entries until we have headroom for the new one.
  while (_shadowCache.size >= SHADOW_CACHE_MAX) {
    const oldest = _shadowCache.keys().next().value;
    if (oldest === undefined) break;
    _shadowCache.delete(oldest);
  }

  const padTop = w * NOTE_SHADOW_TOP_RATIO;
  const padSide = w * NOTE_SHADOW_SIDE_RATIO;
  const padBottom = w * NOTE_SHADOW_BOTTOM_RATIO;
  const totalW = w + 2 * padSide;
  const totalH = h + padTop + padBottom;
  const r = getNoteCornerRadius(w);

  const canvas = new OffscreenCanvas(Math.ceil(totalW * dpr), Math.ceil(totalH * dpr));
  const ctx = canvas.getContext('2d')!;
  ctx.scale(dpr, dpr);
  ctx.fillStyle = '#000';

  // Single body path — used for both shadow casters and the punch. Identical
  // path each time means the punch removes every black pixel deposited by the
  // fills, leaving only the gaussian halo around the original body silhouette.
  ctx.beginPath();
  ctx.roundRect(padSide, padTop, w, h, r);

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

  _shadowCache.set(key, canvas);
  return canvas;
}

function drawNoteShadow(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void {
  const dpr = window.devicePixelRatio || 1;
  const canvas = ensureShadow(w, h, dpr);
  const padTop = w * NOTE_SHADOW_TOP_RATIO;
  const padSide = w * NOTE_SHADOW_SIDE_RATIO;
  const padBottom = w * NOTE_SHADOW_BOTTOM_RATIO;
  ctx.drawImage(canvas, x - padSide, y - padTop, w + 2 * padSide, h + padTop + padBottom);
}

// =============================================================================
// BODY RENDERER
// =============================================================================

export function renderNoteBody(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, fillColor: string): void {
  drawNoteShadow(ctx, x, y, w, h);

  ctx.fillStyle = fillColor;
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, getNoteCornerRadius(w));
  ctx.fill();
}

// =============================================================================
// STICKY NOTE RENDERER
// =============================================================================

export function drawStickyNote(ctx: CanvasRenderingContext2D, handle: ObjectHandle): void {
  const { id, y } = handle;
  const props = getNoteProps(y);
  if (!props) return;

  const { origin, scale: noteScale, fontFamily, fillColor, content, align, alignV } = props;

  const layout = getNoteLayout(id, content, fontFamily);
  const derivedFontSize = getNoteDerivedFontSize(id);

  ctx.save();
  ctx.translate(origin[0], origin[1]);
  ctx.scale(noteScale, noteScale);

  renderNoteBody(ctx, 0, 0, NOTE_WIDTH, NOTE_WIDTH, fillColor);

  if (useSelectionStore.getState().textEditingId === id) {
    ctx.restore();
    return;
  }

  const padding = getNotePadding(1);
  const contentWidth = getNoteContentWidth(1);
  const maxContentH = contentWidth;
  const { lineHeight, lineCount } = layout;
  const baselineToTop = getBaselineToTopRatio(fontFamily) * derivedFontSize;
  const contentH = lineCount * lineHeight;
  const vOffset = getNoteContentOffsetY(alignV, maxContentH, contentH);
  const textY = padding + vOffset + baselineToTop;
  const noteAnchorX = padding + anchorFactor(align) * contentWidth;
  const containerLeft = padding;
  const containerRight = padding + contentWidth;
  const hlR = derivedFontSize * 0.25;

  const needsClip = contentH > maxContentH;
  if (needsClip) {
    ctx.beginPath();
    ctx.rect(padding, padding, contentWidth, maxContentH);
    ctx.clip();
  }

  ctx.textBaseline = 'alphabetic';

  let lastFont = '';
  for (let li = 0; li < lineCount; li++) {
    const startRun = layout.lineRunStart[li];
    const endRun = layout.lineRunStart[li + 1];
    if (startRun === endRun) continue;
    const lineY = textY + layout.lineBaselineY[li];
    const lineW = layout.lineAlignmentWidth[li];
    const startX = getLineStartX(noteAnchorX, contentWidth, lineW, align);

    // Pass 1: highlights
    for (let r = startRun; r < endRun; r++) {
      const hl = layout.runHighlight[r];
      if (!hl) continue;
      ctx.fillStyle = hl;
      const hlX = startX + layout.runAdvanceX[r];
      const hlY = lineY - baselineToTop;
      const runW = layout.runAdvanceWidth[r];
      const hlEnd = hlX + runW;
      const clL = Math.max(hlX, containerLeft);
      const clR = Math.min(hlEnd, containerRight);
      if (clR > clL) {
        const rL = clL > hlX ? 0 : hlR;
        const rR = clR < hlEnd ? 0 : hlR;
        ctx.beginPath();
        ctx.roundRect(clL, hlY, clR - clL, lineHeight, [rL, rR, rR, rL]);
        ctx.fill();
      }
    }

    // Pass 2: text
    ctx.fillStyle = '#1a1a1a';
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
// BBOX
// =============================================================================

export function computeNoteBBox(objectId: string, props: NoteProps): BBoxTuple {
  const { content, origin, scale, fontFamily } = props;
  const noteW = NOTE_WIDTH * scale;
  const frame: FrameTuple = [origin[0], origin[1], noteW, noteW];
  getNoteLayout(objectId, content, fontFamily);
  textLayoutCache.setFrame(objectId, frame);

  const padTop = getNoteShadowPadTop(scale);
  const padSide = getNoteShadowPadSide(scale);
  const padBottom = getNoteShadowPadBottom(scale);
  return [frame[0] - padSide, frame[1] - padTop, frame[0] + noteW + padSide, frame[1] + noteW + padBottom];
}
