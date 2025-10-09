import type { StrokePreview, StrokeFinalPreview } from '@/lib/tools/types';
import { getStroke } from 'perfect-freehand';
import { PF_OPTIONS_BASE } from '../stroke-builder/pf-config';

/**
 * Draw preview stroke
 * CRITICAL: This is called INSIDE world transform scope
 * The context has the world transform already applied when this is called
 * The preview is drawn as an authoring overlay AFTER world content but BEFORE transform restore
 * Preview points are in world coordinates and will be transformed to canvas automatically
 */
export function drawPreview(ctx: CanvasRenderingContext2D, preview: StrokePreview): void {
  if (!preview || preview.points.length < 2) return;

  ctx.save();
  ctx.globalAlpha = preview.opacity; // Tool-specific opacity

  // PF input: [x,y][]; output: [x,y][] (not flat)
  const outline = getStroke(preview.points, {
    ...PF_OPTIONS_BASE,
    size: preview.size,
    last: false, // live preview
  });

  if (outline.length > 0) {
    const path = new Path2D();
    path.moveTo(outline[0][0], outline[0][1]);
    for (let i = 1; i < outline.length; i++) {
      path.lineTo(outline[i][0], outline[i][1]);
    }
    path.closePath();
    ctx.fillStyle = preview.color;
    ctx.fill(path);
  }

  ctx.restore();
}

export function drawFinalPreview(ctx: CanvasRenderingContext2D, preview: StrokeFinalPreview): void {
  if (!preview || !preview.outline || preview.outline.length === 0) return;

  ctx.save();
  ctx.globalAlpha = preview.opacity;
  drawOutline(ctx, preview.outline, preview.color);
  ctx.restore();
}

/**
 * Helper to draw PF outline
 */
function drawOutline(ctx: CanvasRenderingContext2D, outline: [number, number][], color: string): void {
  if (outline.length > 0) {
    const path = new Path2D();
    path.moveTo(outline[0][0], outline[0][1]);
    for (let i = 1; i < outline.length; i++) {
      path.lineTo(outline[i][0], outline[i][1]);
    }
    path.closePath();
    ctx.fillStyle = color;
    ctx.fill(path);
  }
}