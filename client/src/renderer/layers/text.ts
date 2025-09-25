import type { Snapshot, ViewTransform } from '@avlo/shared';
import type { ViewportInfo } from '../types';

export function drawText(
  ctx: CanvasRenderingContext2D,
  snapshot: Snapshot,
  _view: ViewTransform,
  viewport: ViewportInfo,
): void {
  const texts = snapshot.texts;
  if (!texts || texts.length === 0) return;

  // Save context state
  ctx.save();

  // Use viewport visible bounds for culling
  const visibleBounds = (viewport as any).visibleWorldBounds;

  for (const text of texts) {
    // Culling check
    if (visibleBounds) {
      if (
        text.x + text.w < visibleBounds.minX ||
        text.x > visibleBounds.maxX ||
        text.y + text.h < visibleBounds.minY ||
        text.y > visibleBounds.maxY
      ) {
        continue;
      }
    }

    // Draw text
    ctx.fillStyle = text.color;
    ctx.font = `${text.size}px Inter, system-ui, -apple-system, sans-serif`;
    ctx.textBaseline = 'top';

    // Simple rendering at x,y position
    ctx.fillText(text.content, text.x, text.y);

    // Debug: Draw bounding box in dev
    if (import.meta.env.DEV && import.meta.env.VITE_DEBUG_RENDER_LAYERS) {
      ctx.strokeStyle = 'rgba(255, 0, 255, 0.3)';
      ctx.lineWidth = 1;
      ctx.strokeRect(text.x, text.y, text.w, text.h);
    }
  }

  ctx.restore();
}
