import type { StrokePreview } from '@/tools/types';
import { traceStroke } from '../freehand';

/**
 * Draw stroke preview using the freehand pipeline, traced straight into the overlay context
 * (no per-frame Path2D allocation).
 * CRITICAL: This is called INSIDE world transform scope — the context already has the world
 * transform applied, so preview points (world coordinates) are transformed automatically.
 */
export function drawStrokePreview(ctx: CanvasRenderingContext2D, preview: StrokePreview): void {
  if (!preview || preview.points.length < 2) return;

  ctx.save();
  ctx.globalAlpha = preview.opacity; // Tool-specific opacity
  ctx.fillStyle = preview.color;
  ctx.beginPath();
  traceStroke(ctx, preview.points, preview.size, false); // live preview
  ctx.fill();
  ctx.restore();
}
