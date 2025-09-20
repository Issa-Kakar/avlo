import type { Snapshot } from '@avlo/shared';
import { getStrokeCacheInstance } from '../stroke-builder/stroke-cache';

export function drawDimmedStrokes(
  ctx: CanvasRenderingContext2D,
  hitIds: string[],
  snapshot: Snapshot,
  baseOpacity: number
): void {
  const hitSet = new Set(hitIds);
  const cache = getStrokeCacheInstance();

  ctx.save();

  // Use composite operation to darken strokes
  ctx.globalCompositeOperation = 'multiply';

  // Render hit strokes with a dark overlay to show they'll be erased
  for (const stroke of snapshot.strokes) {
    if (!hitSet.has(stroke.id)) continue;

    const renderData = cache.getOrBuild(stroke);
    if (!renderData.path || renderData.pointCount < 2) continue;

    // Draw a semi-transparent gray stroke over the original
    // This creates a darkening effect that's visible on any color
    ctx.save();

    const dimFactor = stroke.style.tool === 'highlighter' ? 0.7 : 0.5;

    ctx.globalAlpha = 1; // Full opacity for multiply effect
    ctx.strokeStyle = `rgba(128, 128, 128, ${dimFactor})`; // Gray overlay
    ctx.lineWidth = stroke.style.size + 2; // Slightly thicker for visibility
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    ctx.stroke(renderData.path);
    ctx.restore();
  }

  // Reset composite operation for text
  ctx.globalCompositeOperation = 'source-over';

  // Render hit text blocks with darkening overlay
  for (const text of snapshot.texts) {
    if (!hitSet.has(text.id)) continue;

    ctx.fillStyle = 'rgba(0, 0, 0, 0.4)'; // Black overlay
    ctx.fillRect(text.x, text.y, text.w, text.h);
  }

  ctx.restore();
}