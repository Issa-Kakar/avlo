/**
 * STICKY NOTE
 *
 * Owns everything sticky-note-specific: constants, geometry helpers, 9-slice
 * shadow cache, body renderer, full canvas draw, and bbox. Reuses the shared
 * tokenize/measure/layout pipeline in `text-system.ts` via `textLayoutCache`.
 *
 * Dependency direction is one-way: sticky-note → text-system.
 */

import type { ObjectHandle } from '../types/objects';
import type { BBoxTuple, FrameTuple } from '../types/geometry';
import type { NoteProps } from '../accessors';
import { getNoteProps } from '../accessors';
import { useSelectionStore } from '@/stores/selection-store';
import { textLayoutCache, anchorFactor, getBaselineToTopRatio, getLineStartX, getNoteContentOffsetY } from './text-system';

// =============================================================================
// CONSTANTS
// =============================================================================

export const NOTE_WIDTH = 280;
export const NOTE_FILL_COLOR = '#FEF3AC';

const NOTE_PADDING_RATIO = 12 / 280;
const NOTE_CORNER_RADIUS_RATIO = 0.011;
const NOTE_SHADOW_PAD_RATIO = 0.15;

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

  const layout = textLayoutCache.getNoteLayout(id, content, fontFamily);
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
  textLayoutCache.getNoteLayout(objectId, content, fontFamily);
  textLayoutCache.setFrame(objectId, frame);

  const sp = getNoteShadowPad(scale);
  return [frame[0] - sp, frame[1] - sp, frame[0] + noteW + sp, frame[1] + noteW + sp];
}

/** Auto-derived font size for a note from the shared layout cache. */
export function getNoteDerivedFontSize(objectId: string): number {
  return textLayoutCache.getNoteDerivedFontSize(objectId);
}
