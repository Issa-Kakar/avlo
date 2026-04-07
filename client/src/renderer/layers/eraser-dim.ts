import type { Snapshot } from '@/core/types/snapshot';
import { getWidth, getFillColor } from '@/core/accessors';
import { getTextFrame } from '@/core/text/text-system';
import { getCodeFrame } from '@/core/code/code-system';
import { getPath, getConnectorPaths } from '../geometry-cache';
import { ARROW_ROUNDING_LINE_WIDTH } from '@/core/connectors/connector-paths';

/**
 * Draw dimmed objects with a uniform white lighten effect.
 * Uses 'screen' blend mode for consistent lightening.
 */
export function drawDimmedStrokes(ctx: CanvasRenderingContext2D, hitIds: string[], snapshot: Snapshot, baseOpacity: number): void {
  if (!hitIds.length) return;

  const hitSet = new Set(hitIds);
  const alpha = Math.max(0, Math.min(1, baseOpacity));

  ctx.save();
  ctx.globalCompositeOperation = 'screen';
  ctx.globalAlpha = alpha;
  ctx.fillStyle = '#ffffff';
  ctx.strokeStyle = '#ffffff';

  for (const id of hitSet) {
    const handle = snapshot.objectsById.get(id);
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
    } else if (kind === 'text') {
      // Text: dim the bounding box
      const frame = getTextFrame(handle.id);
      if (!frame) continue;
      const [x, y, w, h] = frame;
      ctx.fillRect(x, y, w, h);
    } else if (kind === 'code') {
      const frame = getCodeFrame(handle.id);
      if (!frame) continue;
      const [x, y, w, h] = frame;
      ctx.fillRect(x, y, w, h);
    } else if (kind === 'note') {
      const frame = getTextFrame(handle.id);
      if (!frame) continue;
      const [x, y, w, h] = frame;
      ctx.fillRect(x, y, w, h);
    }
  }

  ctx.restore();
}
