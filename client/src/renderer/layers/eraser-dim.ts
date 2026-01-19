import type { Snapshot } from '@avlo/shared';
import { getObjectCacheInstance } from '../object-cache';
import { ARROW_ROUNDING_LINE_WIDTH } from '@/lib/connectors/connector-paths';

/**
 * Draw dimmed objects with a uniform white lighten effect.
 * Uses 'screen' blend mode for consistent lightening.
 */
export function drawDimmedStrokes(
  ctx: CanvasRenderingContext2D,
  hitIds: string[],
  snapshot: Snapshot,
  baseOpacity: number,
): void {
  if (!hitIds.length) return;

  const hitSet = new Set(hitIds);
  const alpha = Math.max(0, Math.min(1, baseOpacity));
  const cache = getObjectCacheInstance();

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
        const path = cache.getPath(id, handle);
        ctx.fill(path);
      } else if (kind === 'shape') {
        // For shapes: dim both fill (if present) and stroke
        const path = cache.getPath(id, handle);
        const width = handle.y.get('width') as number | undefined;
        const fillColor = handle.y.get('fillColor') as string | undefined;

        if (fillColor) {
          ctx.fill(path);
        }

        if (width && width > 0) {
          ctx.lineJoin = 'round';
          ctx.lineCap = 'round';
          ctx.lineWidth = width;
          ctx.stroke(path);
        }
      } else if (kind === 'connector') {
        // Connectors use multi-path
        const paths = cache.getConnectorPaths(id, handle);
        const width = handle.y.get('width') as number | undefined;

        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        ctx.lineWidth = width ?? 2;
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
      const frame = handle.y.get('frame') as [number, number, number, number] | undefined;
      if (!frame) continue;
      const [x, y, w, h] = frame;
      ctx.fillRect(x, y, w, h);
    }
  }

  ctx.restore();
}