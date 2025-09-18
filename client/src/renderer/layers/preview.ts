import type { PreviewData } from '@/lib/tools/types';

/**
 * Draw preview stroke
 * CRITICAL: This is called INSIDE world transform scope
 * The context has the world transform already applied when this is called
 * The preview is drawn as an authoring overlay AFTER world content but BEFORE transform restore
 * Preview points are in world coordinates and will be transformed to canvas automatically
 */
export function drawPreview(ctx: CanvasRenderingContext2D, preview: PreviewData): void {
  if (!preview || preview.points.length < 2) return;

  ctx.save();

  // Apply preview styling
  ctx.strokeStyle = preview.color;
  ctx.lineWidth = preview.size; // World units
  ctx.globalAlpha = preview.opacity; // Tool-specific: 0.35 for pen, 0.25 for highlighter
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // Build path
  ctx.beginPath();
  ctx.moveTo(preview.points[0], preview.points[1]);

  for (let i = 2; i < preview.points.length; i += 2) {
    ctx.lineTo(preview.points[i], preview.points[i + 1]);
  }

  ctx.stroke();
  ctx.restore();
}
