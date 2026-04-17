/**
 * STICKY NOTE
 *
 * Owns everything sticky-note-specific: constants, geometry helpers, 9-slice
 * shadow cache, body renderer, full canvas draw, and bbox. Reuses the shared
 * tokenize/measure/layout pipeline in `text-system.ts` via `textLayoutCache`.
 *
 * Dependency direction is one-way: sticky-note → text-system.
 */

import * as Y from 'yjs';
import type { ObjectHandle } from '../types/objects';
import type { BBoxTuple, FrameTuple } from '../types/geometry';
import type { NoteProps, FontFamily } from '../accessors';
import { getNoteProps } from '../accessors';
import { useSelectionStore } from '@/stores/selection-store';
import {
  textLayoutCache,
  parseAndTokenize,
  measureTokenizedContent,
  measureTextCached,
  sliceTextToFit,
  nextSoftBreak,
  buildFontString,
  layoutMeasuredContent,
  anchorFactor,
  getBaselineToTopRatio,
  getLineStartX,
  getNoteContentOffsetY,
} from './text-system';
import { FONT_FAMILIES } from './font-config';
import type { MeasuredContent, TextLayout } from './text-system';

// =============================================================================
// CONSTANTS
// =============================================================================

export const NOTE_WIDTH = 125;
export const NOTE_FILL_COLOR = '#FEF3AC';

const NOTE_PADDING_RATIO = 20 / 280;
const NOTE_CORNER_RADIUS_RATIO = 0.011;
const NOTE_SHADOW_PAD_RATIO = 0.15;

/** Base content width at scale=1, derived from NOTE_WIDTH and NOTE_PADDING_RATIO. */
const BASE_CONTENT_WIDTH = NOTE_WIDTH * (1 - 2 * NOTE_PADDING_RATIO);
/** Descending font steps tried during auto-sizing. */
const NOTE_FONT_STEPS: number[] = [
  54, 48, 44, 43, 42, 41, 40, 38, 37, 36, 35, 34, 33, 32, 31, 30, 29, 28, 27, 26, 25, 24, 23, 22, 21, 20, 19, 18, 17, 16, 15, 14, 13, 12,
  11, 10, 9, 8,
];
/** Below this step, phase-2 character breaking activates. */
const NOTE_PHASE1_FLOOR = 11;

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

function getNoteShadowPad(scale: number): number {
  return NOTE_WIDTH * scale * NOTE_SHADOW_PAD_RATIO;
}

// =============================================================================
// AUTO FONT SIZE — layoutNoteContent (100px ratio strategy, two-phase search)
// =============================================================================

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

function noteFlowCheck(measured: MeasuredContent, maxW: number, maxLines: number, phase2: boolean, contentWidth: number): NoteFlowResult {
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

        // Phase 2: char-break — push to new line first if line has ink (matches browser)
        if (hasInk) {
          lineCount++;
          if (lineCount > maxLines) return 'heightOverflow';
          curW = 0;
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
            // Try soft segments before char-level (mirrors placeWord)
            const segEnd = nextSoftBreak(text);
            if (segEnd < text.length) {
              const chunkW = measureTextCached(seg.font, text.slice(0, segEnd));
              if (chunkW <= remaining) {
                curW += chunkW;
                text = text.slice(segEnd);
                continue;
              }
              if (chunkW <= maxW) {
                if (curW > 0) {
                  lineCount++;
                  if (lineCount > maxLines) return 'heightOverflow';
                  curW = 0;
                }
                curW += chunkW;
                text = text.slice(segEnd);
                continue;
              }
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
 * Takes MeasuredContent at 100px (ratio strategy). Always works at BASE_CONTENT_WIDTH.
 *
 * Phase A: Find optimal font step (two-phase search with lazy per-word stepping).
 * Phase B: Mutate MeasuredContent to derived font size and build layout.
 */
function layoutNoteContent(measured: MeasuredContent, fontFamily: FontFamily): { layout: TextLayout; derivedFontSize: number } {
  const contentWidth = BASE_CONTENT_WIDTH;
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
      if (tok.kind === 'word' && tok.advanceWidth > maxWordW100) maxWordW100 = tok.advanceWidth;
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

/**
 * Get or compute layout for a note object. Always works at base dimensions.
 * No fontSize/width params — layout is scale-independent.
 * Two-tier: content valid → re-measure + auto-size; content stale → full pipeline.
 * Reads/writes shared cache via `textLayoutCache.getNoteCache` / `setNoteCache`.
 */
export function getNoteLayout(objectId: string, fragment: Y.XmlFragment, fontFamily: FontFamily): TextLayout {
  const snap = textLayoutCache.getNoteCache(objectId);

  // Tier 1 hit — same content + fontFamily + derived font size computed
  if (
    snap &&
    snap.tokenized !== null &&
    snap.measuredFontFamily === fontFamily &&
    snap.noteDerivedFontSize !== null &&
    snap.layout !== null
  ) {
    return snap.layout;
  }

  // Tier 2 — content valid, fontFamily or derivedFontSize stale → re-measure + auto-size
  if (snap && snap.tokenized !== null) {
    const measured = measureTokenizedContent(snap.tokenized, 100, fontFamily);
    const { layout, derivedFontSize } = layoutNoteContent(measured, fontFamily);
    textLayoutCache.setNoteCache(objectId, {
      tokenized: snap.tokenized,
      measured,
      measuredFontFamily: fontFamily,
      noteDerivedFontSize: derivedFontSize,
      layout,
    });
    return layout;
  }

  // Tier 3 — full pipeline (no entry or content stale)
  const tokenized = parseAndTokenize(fragment);
  const measured = measureTokenizedContent(tokenized, 100, fontFamily);
  const { layout, derivedFontSize } = layoutNoteContent(measured, fontFamily);
  textLayoutCache.setNoteCache(objectId, {
    tokenized,
    measured,
    measuredFontFamily: fontFamily,
    noteDerivedFontSize: derivedFontSize,
    layout,
  });
  return layout;
}

/** Auto-derived font size for a note. Falls back to largest step when absent. */
export function getNoteDerivedFontSize(objectId: string): number {
  return textLayoutCache.getNoteCache(objectId)?.noteDerivedFontSize ?? NOTE_FONT_STEPS[0];
}

// =============================================================================
// SHADOW SYSTEM — 9-slice cache, DPR-scaled, dual-layer Gaussian
// =============================================================================

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

function drawNoteShadow(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void {
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

// =============================================================================
// BODY RENDERER — shared shadow + rounded-rect fill for notes AND bookmarks
// =============================================================================

/** Shadow + rounded-rect fill. Shared primitive used by sticky notes and bookmark cards. */
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

  // Body at base dimensions (shadow + fill rect) — always drawn, even during editing
  renderNoteBody(ctx, 0, 0, NOTE_WIDTH, NOTE_WIDTH, fillColor);

  if (useSelectionStore.getState().textEditingId === id) {
    ctx.restore();
    return;
  }

  // Text rendering at base dimensions
  const padding = getNotePadding(1);
  const contentWidth = getNoteContentWidth(1);
  const maxContentH = contentWidth;
  const { lineHeight } = layout;
  const baselineToTop = getBaselineToTopRatio(fontFamily) * derivedFontSize;
  const contentH = layout.lines.length * lineHeight;
  const vOffset = getNoteContentOffsetY(alignV, maxContentH, contentH);
  const textY = padding + vOffset + baselineToTop;
  const noteAnchorX = padding + anchorFactor(align) * contentWidth;
  const containerLeft = padding;
  const containerRight = padding + contentWidth;
  const hlR = derivedFontSize * 0.25;

  // Clip overflow (at min step + content overflows)
  const needsClip = contentH > maxContentH;
  if (needsClip) {
    ctx.beginPath();
    ctx.rect(padding, padding, contentWidth, maxContentH);
    ctx.clip();
  }

  ctx.textBaseline = 'alphabetic';

  for (const line of layout.lines) {
    if (line.runs.length === 0) continue;
    const lineY = textY + line.baselineY;
    const lineW = line.alignmentWidth;
    const startX = getLineStartX(noteAnchorX, contentWidth, lineW, align);

    // Pass 1: highlight rects
    for (const run of line.runs) {
      if (!run.highlight) continue;
      ctx.fillStyle = run.highlight;
      const hlX = startX + run.advanceX;
      const hlY = lineY - baselineToTop;
      const hlEnd = hlX + run.advanceWidth;
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
    for (const run of line.runs) {
      ctx.font = run.font;
      ctx.fillText(run.text, startX + run.advanceX, lineY);
    }
  }

  ctx.restore();
}

// =============================================================================
// BBOX + CACHE ACCESSOR
// =============================================================================

export function computeNoteBBox(objectId: string, props: NoteProps): BBoxTuple {
  const { content, origin, scale, fontFamily } = props;
  const noteW = NOTE_WIDTH * scale;
  // Always square — no height auto-grow
  const frame: FrameTuple = [origin[0], origin[1], noteW, noteW];
  // Populate cache (ensures derivedFontSize available later)
  getNoteLayout(objectId, content, fontFamily);
  textLayoutCache.setFrame(objectId, frame);

  const sp = getNoteShadowPad(scale);
  return [frame[0] - sp, frame[1] - sp, frame[0] + noteW + sp, frame[1] + noteW + sp];
}
