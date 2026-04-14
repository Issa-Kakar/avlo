import { getWidth, getFillColor } from '@/core/accessors';
import { frameOf } from '@/core/geometry/frame-of';
import { getPath, getConnectorPaths } from '../geometry-cache';
import { ARROW_ROUNDING_LINE_WIDTH } from '@/core/connectors/connector-paths';
import { getHandle } from '@/runtime/room-runtime';

/**
 * Draw dimmed objects with a uniform white lighten effect.
 * Uses 'screen' blend mode for consistent lightening.
 */
export function drawDimmedStrokes(ctx: CanvasRenderingContext2D, hitIds: string[], baseOpacity: number): void {
  if (!hitIds.length) return;

  const hitSet = new Set(hitIds);
  const alpha = Math.max(0, Math.min(1, baseOpacity));

  ctx.save();
  ctx.globalCompositeOperation = 'screen';
  ctx.globalAlpha = alpha;
  ctx.fillStyle = '#ffffff';
  ctx.strokeStyle = '#ffffff';

  for (const id of hitSet) {
    const handle = getHandle(id);
    if (!handle) continue;

    const { kind } = handle;

    if (kind === 'stroke' || kind === 'shape' || kind === 'connector') {
      ctx.save();

      if (kind === 'stroke') {
        // Strokes are filled polygons - dim the fill
        const path = getPath(id, handle);
        ctx.fill(path);
      } else if (kind === 'shape') {
        // For shapes: dim both fill (if present) and stroke
        const path = getPath(id, handle);
        const width = getWidth(handle.y, 0);
        const fillColor = getFillColor(handle.y);

        if (fillColor) {
          ctx.fill(path);
        }

        if (width > 0) {
          ctx.lineJoin = 'round';
          ctx.lineCap = 'round';
          ctx.lineWidth = width;
          ctx.stroke(path);
        }
      } else if (kind === 'connector') {
        // Connectors use multi-path
        const paths = getConnectorPaths(id, handle);
        const width = getWidth(handle.y);

        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        ctx.lineWidth = width;
        ctx.stroke(paths.polyline);

        // Dim arrows too
        if (paths.startArrow) {
          ctx.lineWidth = ARROW_ROUNDING_LINE_WIDTH;
          ctx.fill(paths.startArrow);
          ctx.stroke(paths.startArrow);
        }
        if (paths.endArrow) {
          ctx.lineWidth = ARROW_ROUNDING_LINE_WIDTH;
          ctx.fill(paths.endArrow);
          ctx.stroke(paths.endArrow);
        }
      }

      ctx.restore();
    } else if (kind === 'text' || kind === 'code' || kind === 'note') {
      // Framed kinds: dim the derived frame rect.
      const frame = frameOf(handle);
      if (!frame) continue;
      ctx.fillRect(frame[0], frame[1], frame[2], frame[3]);
    }
  }

  ctx.restore();
}
