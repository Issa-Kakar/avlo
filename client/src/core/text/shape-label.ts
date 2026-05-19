/**
 * SHAPE-LABEL RENDERING
 *
 * Shape labels reuse the full text pipeline (tokenize → measure → layout) with
 * shape-aware positioning. This module owns the two pieces specific to labels:
 *   - `computeLabelTextBox` — max inscribed rect per shape type, inset by padding
 *   - `renderShapeLabel`    — H+V aligned, overflow-clipped canvas draw
 *
 * `computeLabelTextBox` writes into a module-level scratch (read transiently by
 * the renderer and TextTool, never retained — see the call-site note below);
 * `layoutIntoLabelScratch` writes into a single shared `TextLayout` buffer for
 * the transform-preview path. Dependency direction: shape-label → text-system.
 */

import type { FontFamily, TextAlign, TextAlignV, TextWidth } from '../accessors';
import type { FrameTuple } from '../types/geometry';
import { getBaselineToTopRatio } from './text-measure';
import {
  anchorFactor,
  createTextLayout,
  getLineStartX,
  getNoteContentOffsetY,
  layoutMeasuredContent,
  type MeasuredContent,
  type TextLayout,
} from './text-system';

const LABEL_PADDING = 8;
const SQRT2_OVER_2 = Math.SQRT2 / 2;

// --- Module-scope label-textbox scratch ---
// computeLabelTextBox is a pure computation with no owner — every call site reads
// the four slots immediately (destructure, or pass straight into getLayout /
// renderShapeLabel / layoutIntoLabelScratch, none of which call back into
// computeLabelTextBox) and never retains the tuple. Same idiom as _labelScratch.
const _labelTextBox: FrameTuple = [0, 0, 0, 0];

/** Max inscribed text rect for a shape label, inset by LABEL_PADDING. Writes into
 *  and returns the module-level `_labelTextBox` scratch — `Math.max(0, …)` prevents
 *  negative dims. Consumers must read the four slots before the next call. */
export function computeLabelTextBox(shapeType: string, frame: FrameTuple): FrameTuple {
  const [fx, fy, fw, fh] = frame;
  const pad = LABEL_PADDING;
  switch (shapeType) {
    case 'ellipse': {
      const iw = fw * SQRT2_OVER_2,
        ih = fh * SQRT2_OVER_2;
      const cx = fx + fw / 2,
        cy = fy + fh / 2;
      _labelTextBox[0] = cx - iw / 2 + pad;
      _labelTextBox[1] = cy - ih / 2 + pad;
      _labelTextBox[2] = Math.max(0, iw - 2 * pad);
      _labelTextBox[3] = Math.max(0, ih - 2 * pad);
      return _labelTextBox;
    }
    case 'diamond': {
      const iw = fw / 2,
        ih = fh / 2;
      const cx = fx + fw / 2,
        cy = fy + fh / 2;
      _labelTextBox[0] = cx - iw / 2 + pad;
      _labelTextBox[1] = cy - ih / 2 + pad;
      _labelTextBox[2] = Math.max(0, iw - 2 * pad);
      _labelTextBox[3] = Math.max(0, ih - 2 * pad);
      return _labelTextBox;
    }
    case 'triangle': {
      // Apex-up triangle. Largest inscribed axis-aligned rect that fits with its
      // top edge at the triangle's mid-height: width tapers as `(v/h) · w`, so
      // at v = h/2 the available width is exactly w/2. Place the rect in the
      // lower (wider) half — it just kisses both slanted edges at the top.
      const iw = fw / 2,
        ih = fh / 2;
      const cx = fx + fw / 2;
      _labelTextBox[0] = cx - iw / 2 + pad;
      _labelTextBox[1] = fy + fh / 2 + pad;
      _labelTextBox[2] = Math.max(0, iw - 2 * pad);
      _labelTextBox[3] = Math.max(0, ih - 2 * pad);
      return _labelTextBox;
    }
    default:
      _labelTextBox[0] = fx + pad;
      _labelTextBox[1] = fy + pad;
      _labelTextBox[2] = Math.max(0, fw - 2 * pad);
      _labelTextBox[3] = Math.max(0, fh - 2 * pad);
      return _labelTextBox;
  }
}

// --- Renderer ---

export function renderShapeLabel(
  ctx: CanvasRenderingContext2D,
  layout: TextLayout,
  textBox: FrameTuple,
  color: string,
  fontFamily: FontFamily,
  align: TextAlign = 'center',
  alignV: TextAlignV = 'middle',
): void {
  const [tbx, tby, tbw, tbh] = textBox;
  if (tbw <= 0 || tbh <= 0 || layout.lineCount === 0) return;

  const { fontSize, lineHeight, lineCount } = layout;
  const contentHeight = lineCount * lineHeight;
  const baselineToTop = fontSize * getBaselineToTopRatio(fontFamily);
  const needsClip = contentHeight > tbh;

  const vOffset = getNoteContentOffsetY(alignV, tbh, contentHeight);
  const contentTopY = needsClip ? tby : tby + vOffset;
  const firstBaselineY = contentTopY + baselineToTop;

  if (needsClip) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(tbx, tby, tbw, tbh);
    ctx.clip();
  }

  ctx.textBaseline = 'alphabetic';
  ctx.textRendering = 'optimizeSpeed';

  const shapeAnchorX = tbx + anchorFactor(align) * tbw;
  const hlR = fontSize * 0.25;
  let lastFont = '';
  for (let li = 0; li < lineCount; li++) {
    const startRun = layout.lineRunStart[li];
    const endRun = layout.lineRunStart[li + 1];
    if (startRun === endRun) continue;
    const lineY = firstBaselineY + layout.lineBaselineY[li];
    const lineW = layout.lineAlignmentWidth[li];
    const startX = getLineStartX(shapeAnchorX, tbw, lineW, align);

    // Pass 1: highlights
    for (let r = startRun; r < endRun; r++) {
      const hl = layout.runHighlight[r];
      if (!hl) continue;
      ctx.fillStyle = hl;
      const hlX = startX + layout.runAdvanceX[r];
      const hlY = lineY - baselineToTop;
      const runW = layout.runAdvanceWidth[r];
      const hlEnd = hlX + runW;
      const clL = Math.max(hlX, tbx);
      const clR = Math.min(hlEnd, tbx + tbw);
      if (clR > clL) {
        const rL = clL > hlX ? 0 : hlR,
          rR = clR < hlEnd ? 0 : hlR;
        ctx.beginPath();
        ctx.roundRect(clL, hlY, clR - clL, lineHeight, [rL, rR, rR, rL]);
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

  if (needsClip) ctx.restore();
}

// --- Module-scope label scratch (one buffer for ALL labeled shapes per frame) ---
const _labelScratch = createTextLayout();

/** Layout into a shared module-level scratch buffer. Used by renderer's transform-preview path
 *  for shape labels (drawShapeLabelWithFrame) — eliminates per-shape per-frame allocation. */
export function layoutIntoLabelScratch(measured: MeasuredContent, width: TextWidth, fontSize: number): TextLayout {
  return layoutMeasuredContent(measured, width, fontSize, _labelScratch);
}
