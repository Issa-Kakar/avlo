import type { ShapePreview } from '@/tools/types';
import { buildShapePathFromFrame } from '@/core/geometry/shape-path';
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
