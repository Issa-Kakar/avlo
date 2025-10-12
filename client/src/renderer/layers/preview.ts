import type { StrokePreview, StrokeFinalPreview } from '@/lib/tools/types';
import { getStroke } from 'perfect-freehand';
import { PF_OPTIONS_BASE } from '../stroke-builder/pf-config';
import { getSvgPathFromStroke } from '../stroke-builder/pf-svg';

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

export function drawFinalPreview(ctx: CanvasRenderingContext2D, preview: StrokeFinalPreview): void {
  if (!preview || !preview.outline || preview.outline.length === 0) return;

  ctx.save();
  ctx.globalAlpha = preview.opacity;
  drawOutline(ctx, preview.outline, preview.color);
  ctx.restore();
}

/**
 * Helper to draw PF outline with smooth Bézier curves
 */
function drawOutline(ctx: CanvasRenderingContext2D, outline: number[][], color: string): void {
  if (outline.length > 1) {
    // Convert PF outline to smooth SVG path with quadratic Bézier curves
    // CRITICAL: Do NOT close the path - PF already provides a complete outline
    const svgPath = getSvgPathFromStroke(outline, false);
    const path = new Path2D(svgPath);
    ctx.fillStyle = color;
    // Use default nonzero fill rule (not even-odd) for open PF outlines
    ctx.fill(path);
  }
}