import type { Snapshot } from '@avlo/shared';
import { getStrokeCacheInstance } from '../stroke-builder/stroke-cache';

/**
 * Draw dimmed strokes and text with a uniform white lighten effect.
 * Uses 'screen' blend mode for consistent lightening regardless of color.
 */
export function drawDimmedStrokes(
  ctx: CanvasRenderingContext2D,
  hitIds: string[],
  snapshot: Snapshot,
  baseOpacity: number, // Will be 0.75 from EraserTool
): void {
  const hitSet = new Set(hitIds);
  const cache = getStrokeCacheInstance();
  const alpha = Math.max(0, Math.min(1, baseOpacity)); // Expect 0.75

  ctx.save();

  // --- Strokes: lighten using proper geometry type ---
  for (const stroke of snapshot.strokes) {
    if (!hitSet.has(stroke.id)) continue;

    ctx.save();
    ctx.globalCompositeOperation = 'screen'; // Uniform lighten strategy
    ctx.globalAlpha = alpha;                 // 0.75 for strong effect

    // Special case: single-point strokes (1px dots)
    if (stroke.points.length === 2) {
      const x = stroke.points[0];
      const y = stroke.points[1];
      const radius = stroke.style.size / 2;

      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(x, y, radius + 1, 0, Math.PI * 2);
      ctx.fill();
    } else {
      // Multi-point strokes: use cached geometry
      const renderData = cache.getOrBuild(stroke);
      if (renderData.path && renderData.pointCount >= 2) {
        if (stroke.kind === 'freehand' && renderData.kind === 'polygon') {
          // Freehand strokes: FILL the polygon for accurate dimming
          ctx.fillStyle = '#ffffff';
          ctx.fill(renderData.path);
        } else {
          // Shape strokes: STROKE the polyline
          ctx.strokeStyle = '#ffffff';
          ctx.lineWidth = stroke.style.size + 2;   // Slight bump for clean edges
          ctx.lineCap = 'round';
          ctx.lineJoin = 'round';
          ctx.stroke(renderData.path);
        }
      }
    }

    ctx.restore();
  }

  // --- Text: lighten block area uniformly ---
  for (const text of snapshot.texts) {
    if (!hitSet.has(text.id)) continue;

    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    ctx.globalAlpha = alpha;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(text.x, text.y, text.w, text.h);
    ctx.restore();
  }

  ctx.restore();
}