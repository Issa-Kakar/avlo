import type { StrokePreview } from '@/tools/types';
import { getStroke } from 'perfect-freehand';
import { PF_OPTIONS_BASE, getSvgPathFromStroke } from '../types';

/**
 * Draw stroke preview using Perfect Freehand
 * CRITICAL: This is called INSIDE world transform scope
 * The context has the world transform already applied when this is called
 * Preview points are in world coordinates and will be transformed to canvas automatically
 */
export function drawStrokePreview(ctx: CanvasRenderingContext2D, preview: StrokePreview): void {
  if (!preview || preview.points.length < 2) return;

  ctx.save();
  ctx.globalAlpha = preview.opacity; // Tool-specific opacity

  // PF input: [x,y][]; output: [x,y][] (not flat)
  const outline = getStroke(preview.points, {
    ...PF_OPTIONS_BASE,
    size: preview.size,
    last: false, // live preview
  });

  if (outline.length > 1) {
    // Convert PF outline to smooth SVG path with quadratic Bézier curves
    // CRITICAL: Do NOT close the path - PF already provides a complete outline
    const svgPath = getSvgPathFromStroke(outline, false);
    const path = new Path2D(svgPath);
    ctx.fillStyle = preview.color;
    // Use default nonzero fill rule (not even-odd) for open PF outlines
    ctx.fill(path);
  }

  ctx.restore();
}
