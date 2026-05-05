import { buildShapePathFromFrame, emitShapeIntoSink } from '@/core/geometry/shape-path';
import type { FrameTuple } from '@/core/types/geometry';
import type { ShapePreview } from '@/tools/types';
import { createFillFromStroke } from '@/utils/color';

/**
 * Draw a shape preview. Context is already in world transform.
 *
 * The tool owns all geometry — the renderer never computes frames:
 *   - line: direct `ctx.moveTo/lineTo/stroke` at `preview.width` (no PF, no taper).
 *   - framed: `buildShapePathFromFrame(shapeType, frame)` on the tool-supplied frame.
 */
export function drawShapePreview(ctx: CanvasRenderingContext2D, preview: ShapePreview): void {
  ctx.save();
  ctx.globalAlpha = preview.opacity;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.setLineDash([]);
  ctx.strokeStyle = preview.color;
  ctx.lineWidth = preview.width;

  if (preview.shapeType === 'line') {
    ctx.beginPath();
    ctx.moveTo(preview.a[0], preview.a[1]);
    ctx.lineTo(preview.b[0], preview.b[1]);
    ctx.stroke();
    ctx.restore();
    return;
  }

  const frame = preview.frame;
  if (frame[2] < 1 || frame[3] < 1) {
    ctx.restore();
    return;
  }

  const path = buildShapePathFromFrame(preview.shapeType, frame);
  if (preview.fill) {
    ctx.fillStyle = createFillFromStroke(preview.color);
    ctx.fill(path);
  }
  ctx.stroke(path);
  ctx.restore();
}

/**
 * Paint a shape frame directly into ctx (zero Path2D allocation).
 * Mirrors the shape rendering ctx-state sequence in `objects.ts:drawShape` so
 * output is byte-identical to the cached-path render. Used by the per-frame
 * scale preview to skip Path2D creation entirely.
 */
export function paintShapeFrame(
  ctx: CanvasRenderingContext2D,
  shapeType: string,
  frame: FrameTuple,
  fillColor: string | null | undefined,
  strokeColor: string | null | undefined,
  strokeWidth: number,
  opacity: number,
): void {
  ctx.save();
  ctx.globalAlpha = opacity;
  ctx.beginPath();
  emitShapeIntoSink(ctx, shapeType, frame);
  if (fillColor) {
    ctx.fillStyle = fillColor;
    ctx.fill();
  }
  if (strokeColor && strokeWidth > 0) {
    ctx.strokeStyle = strokeColor;
    ctx.lineWidth = strokeWidth;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke();
  }
  ctx.restore();
}
