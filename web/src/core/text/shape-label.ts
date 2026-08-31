/**
 * SHAPE-LABEL RENDERING
 *
 * Shape labels reuse the full text pipeline (tokenize → measure → flow) with
 * shape-aware positioning. This module owns the pieces specific to labels:
 *   - `computeLabelTextBox`      — max inscribed rect per shape type, inset by padding
 *   - `renderShapeLabelSlot`     — at-rest draw off the entry's pooled layout tier
 *   - `renderShapeLabelPreview`  — transform-preview draw: flow the cached
 *     measured view into staging and paint straight from it — no per-frame
 *     layout buffer, no commit copy, no cache pollution
 *
 * The two render bodies are deliberate twins over the shared run kernel
 * (`setRenderKernelScalars` + renderRuns*) rather than one body with a source
 * flag — each keeps its own monomorphic call into the kernel.
 *
 * `computeLabelTextBox` writes into a module-level scratch (read transiently by
 * the renderer and TextTool, never retained — see the call-site note below).
 * Dependency direction: shape-label → text-system.
 */

import type { TextAlign, TextAlignV } from '../accessors';
import type { FrameTuple } from '../types/geometry';
import { getBaselineToTopRatioByCode } from './text-measure';
import { getR, getS, TS_FAM_SHIFT } from './text-store';
import {
  anchorFactor,
  flowMeasuredToStaging,
  getNoteContentOffsetY,
  type MeasuredContent,
  renderRunsForSlot,
  renderRunsFromStaging,
  setRenderKernelScalars,
  stagedFlowLineCount,
} from './text-system';

export const LABEL_PADDING = 8;
const SQRT2_OVER_2 = Math.SQRT2 / 2;

// --- Module-scope label-textbox scratch ---
// computeLabelTextBox is a pure computation with no owner — every call site reads
// the four slots immediately (destructure, or pass straight into getLayout /
// renderShapeLabel*, none of which call back into computeLabelTextBox) and never
// retains the tuple.
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

// --- Renderers (twin bodies over the shared run kernel) ---

/** At-rest label draw off the entry's committed layout tier. `ts` comes from
 *  the caller's `textLayoutCache.getLayout(...).slot` (which also refreshed
 *  the layout for the current fontSize/family/width). */
export function renderShapeLabelSlot(
  ctx: CanvasRenderingContext2D,
  ts: number,
  textBox: FrameTuple,
  color: string,
  align: TextAlign = 'center',
  alignV: TextAlignV = 'middle',
): void {
  const tbx = textBox[0];
  const tby = textBox[1];
  const tbw = textBox[2];
  const tbh = textBox[3];
  const R = getR();
  const b16 = ts << 4;
  const lineCount = R[b16 + 10];
  if (tbw <= 0 || tbh <= 0 || lineCount === 0) return;
  const S = getS();
  const b8 = ts << 3;
  const fontSize = S[b8 + 2];
  const lineHeight = S[b8 + 3];
  const famCode = (R[b16 + 15] >>> TS_FAM_SHIFT) & 255;

  const contentHeight = lineCount * lineHeight;
  const b2t = fontSize * getBaselineToTopRatioByCode(famCode);
  const needsClip = contentHeight > tbh;
  const vOffset = getNoteContentOffsetY(alignV, tbh, contentHeight);
  const firstBaselineY = (needsClip ? tby : tby + vOffset) + b2t;

  if (needsClip) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(tbx, tby, tbw, tbh);
    ctx.clip();
  }

  ctx.textBaseline = 'alphabetic';
  ctx.textRendering = 'optimizeSpeed';

  const af = anchorFactor(align);
  setRenderKernelScalars(tbx + af * tbw, firstBaselineY, af, tbw, lineHeight, b2t, tbx, tbx + tbw, fontSize * 0.25);
  renderRunsForSlot(ctx, ts, 1, color);

  if (needsClip) ctx.restore();
}

/** Transform-preview label draw: flow the cached measured view at the preview
 *  frame's text-box width straight into staging and paint from it. Zero cache
 *  writes, zero per-frame layout buffers. */
export function renderShapeLabelPreview(
  ctx: CanvasRenderingContext2D,
  measured: MeasuredContent,
  fontSize: number,
  textBox: FrameTuple,
  color: string,
  align: TextAlign = 'center',
  alignV: TextAlignV = 'middle',
): void {
  const tbx = textBox[0];
  const tby = textBox[1];
  const tbw = textBox[2];
  const tbh = textBox[3];
  if (tbw <= 0 || tbh <= 0) return;

  flowMeasuredToStaging(measured, tbw > 0.01 ? tbw : 0.01);
  const lineCount = stagedFlowLineCount();
  if (lineCount === 0) return;
  const lineHeight = measured.lineHeight;

  const contentHeight = lineCount * lineHeight;
  const b2t = fontSize * getBaselineToTopRatioByCode(measured.famCode);
  const needsClip = contentHeight > tbh;
  const vOffset = getNoteContentOffsetY(alignV, tbh, contentHeight);
  const firstBaselineY = (needsClip ? tby : tby + vOffset) + b2t;

  if (needsClip) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(tbx, tby, tbw, tbh);
    ctx.clip();
  }

  ctx.textBaseline = 'alphabetic';
  ctx.textRendering = 'optimizeSpeed';

  const af = anchorFactor(align);
  setRenderKernelScalars(tbx + af * tbw, firstBaselineY, af, tbw, lineHeight, b2t, tbx, tbx + tbw, fontSize * 0.25);
  renderRunsFromStaging(ctx, 1, color);

  if (needsClip) ctx.restore();
}
