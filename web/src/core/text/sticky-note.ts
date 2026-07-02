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
import { readNoteRender } from '@/renderer/render-accessors';
import type { FontFamily, NoteProps } from '../accessors';
import { bakeRoundRectShadow } from '../geometry/shadow-bake';
import type { BBoxTuple, FrameTuple } from '../types/geometry';
import type { ObjectHandle } from '../types/objects';
import { FONT_FAMILIES } from './font-config';
import { isBreakOpportunity, nextSoftBreak } from './line-break';
import { buildFontMatrix, fontFromMatrix, getBaselineToTopRatio, measureTextCached } from './text-measure';
import type { MeasuredContent, TextLayout } from './text-system';
import {
  anchorFactor,
  createTextLayout,
  getLineStartX,
  getNoteContentOffsetY,
  layoutMeasuredContent,
  measureTokenizedContent,
  parseAndTokenize,
  sliceTextToFit,
  textLayoutCache,
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
// is now per-kind and no longer shared.
const NOTE_SHADOW_TOP_RATIO = 0.06;
const NOTE_SHADOW_SIDE_RATIO = 0.075;
const NOTE_SHADOW_BOTTOM_RATIO = 0.12;

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

      // Per-sub-segment ladder — mirrors `placeWord`. Two decision systems:
      // UAX#14 (Q1/Q2 gated by `canSoftBreak`) and break-word char-slicing
      // (Q3, not gated by UAX#14). See `placeWord` for the full mental model.
      // Commit pending WS to the current line so intra-word break opportunities
      // can place the leading sub-segment on the same line (e.g. `Char-` after `is `).
      curW += pendingW;
      pendingW = 0;

      const sStart = measured.tokenSegStart[ti];
      const sEnd = measured.tokenSegStart[ti + 1];
      for (let s = sStart; s < sEnd; s++) {
        const font = measured.segFont[s];
        const fullText = measured.segText[s];

        // First seg: word-leading position is a break. Else classify the seam.
        let segEntryIsBreak = true;
        if (s > sStart) {
          const prev = measured.segText[s - 1];
          segEntryIsBreak = isBreakOpportunity(prev.charCodeAt(prev.length - 1), fullText.charCodeAt(0));
        }

        let cursor = 0;
        while (cursor < fullText.length) {
          const segEnd = nextSoftBreak(fullText, cursor);
          const chunk = fullText.substring(cursor, segEnd);
          const chunkW = measureTextCached(font, chunk);
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
              if (lineCount > maxLines) return 'heightOverflow';
              curW = 0;
            }
            curW += chunkW;
            cursor = segEnd;
            continue;
          }
          // Q3 — break-word char-slice. Pre-emptive pushLine only when truly
          // oversized at a real break op (matches DOM: oversized words start
          // fresh). Non-break seams fall straight into the slice loop so the
          // remaining line space gets greedy-filled.
          if (canSoftBreak && chunkW > maxW && curW > 0) {
            lineCount++;
            if (lineCount > maxLines) return 'heightOverflow';
            curW = 0;
          }
          while (cursor < segEnd) {
            let lr = maxW - curW;
            // Guard 1 — line full; wrap before slicing.
            if (lr <= 0 && curW > 0) {
              lineCount++;
              if (lineCount > maxLines) return 'heightOverflow';
              curW = 0;
              lr = maxW;
            }
            const r = sliceTextToFit(font, fullText, lr, cursor, segEnd);
            // Guard 2 — oversized grapheme on a non-empty line; wrap, retry.
            if (r.headW > lr && curW > 0) {
              lineCount++;
              if (lineCount > maxLines) return 'heightOverflow';
              curW = 0;
              continue;
            }
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
// SHADOW SYSTEM — single-entry cache, fixed dimensions
// =============================================================================
//
// Notes are always rendered at NOTE_WIDTH × NOTE_WIDTH inside `ctx.scale(noteScale)`,
// so the cache content is dimension-invariant — one canvas, baked once per DPR,
// drawn with one `drawImage` per note. No LRU, no keying.
//
// Shadow design: dual gaussian (drop + contact), computed analytically via
// `bakeRoundRectShadow` (erf-based SDF — no `ctx.shadowBlur`, no `destination-out`)
// so the bake is bit-identical across engines (the old opaque-fill + punch bake left
// an engine-dependent `c·(1−c)` black residual on AA edges). Asymmetric pad — bottom
// holds the long downward tail, top/sides hold a tight halo. Drop offset > blur pushes
// the gaussian's mass below the body so the above-body extent collapses to ~0.

const SHADOW_DROP_BLUR_RATIO = 0.04;
const SHADOW_DROP_OFFSET_RATIO = 0.045;
const SHADOW_DROP_ALPHA = 0.11;
const SHADOW_CONTACT_BLUR_RATIO = 0.013;
const SHADOW_CONTACT_OFFSET_RATIO = 0.008;
const SHADOW_CONTACT_ALPHA = 0.07;

let _noteShadow: OffscreenCanvas | null = null;
let _noteShadowDpr = 0;

function ensureNoteShadow(dpr: number): OffscreenCanvas {
  if (_noteShadow && _noteShadowDpr === dpr) return _noteShadow;

  const w = NOTE_WIDTH;
  const padTop = w * NOTE_SHADOW_TOP_RATIO;
  const padSide = w * NOTE_SHADOW_SIDE_RATIO;
  const padBottom = w * NOTE_SHADOW_BOTTOM_RATIO;
  const r = getNoteCornerRadius(w);

  _noteShadow = bakeRoundRectShadow(
    w + 2 * padSide, // bakeW
    w + padTop + padBottom, // bakeH
    padSide, // bodyX
    padTop, // bodyY
    w, // bodyW
    w, // bodyH
    r,
    { blur: w * SHADOW_DROP_BLUR_RATIO, offsetX: 0, offsetY: w * SHADOW_DROP_OFFSET_RATIO, alpha: SHADOW_DROP_ALPHA },
    { blur: w * SHADOW_CONTACT_BLUR_RATIO, offsetX: 0, offsetY: w * SHADOW_CONTACT_OFFSET_RATIO, alpha: SHADOW_CONTACT_ALPHA },
    dpr,
  );
  _noteShadowDpr = dpr;
  return _noteShadow;
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
  const { id, y } = handle;
  const layout = textLayoutCache.noteCachedLayout(id);
  if (!layout) return; // cold-miss race — observer fills the cache before render
  const r = readNoteRender(y);
  const noteScale = r.scale;
  const fontFamily = r.fontFamily;
  const align = r.align;
  const alignV = r.alignV;
  const derivedFontSize = textLayoutCache.noteCachedDerivedFontSize(id) ?? NOTE_FONT_STEPS[0];

  ctx.save();
  ctx.translate(r.originX, r.originY);
  ctx.scale(noteScale, noteScale);

  renderNoteBody(ctx, 0, 0, r.fillColor);

  if (isEditing) {
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
  const textColor = getStickyNoteTextColor(r.fillColor);

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
    ctx.fillStyle = textColor;
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
