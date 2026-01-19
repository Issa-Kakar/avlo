import type { Snapshot } from '@avlo/shared';
import { getObjectCacheInstance, isConnectorPaths } from '../object-cache';
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
      const geometry = cache.getOrBuild(id, handle);
      if (!geometry) continue;

      ctx.save();

      if (kind === 'stroke') {
        // Strokes are filled polygons - dim the fill (always Path2D)
        ctx.fill(geometry as Path2D);
      } else if (kind === 'shape') {
        // For shapes: dim both fill (if present) and stroke (always Path2D)
        const path = geometry as Path2D;
        const width = handle.y.get('width') as number | undefined;
        const fillColor = handle.y.get('fillColor') as string | undefined;

        // Dim fill if shape is filled
        if (fillColor) {
          ctx.fill(path);
        }

        // Dim the stroke
        if (width && width > 0) {
          ctx.lineJoin = 'round';
          ctx.lineCap = 'round';
          ctx.lineWidth = width;
          ctx.stroke(path);
        }
      } else if (kind === 'connector') {
        // Connectors use multi-path (ConnectorPaths)
        if (isConnectorPaths(geometry)) {
          const width = handle.y.get('width') as number | undefined;
          ctx.lineJoin = 'round';
          ctx.lineCap = 'round';
          ctx.lineWidth = width ?? 2;
          ctx.stroke(geometry.polyline);

          // Dim arrows too
          if (geometry.startArrow) {
            ctx.lineWidth = ARROW_ROUNDING_LINE_WIDTH;
            ctx.fill(geometry.startArrow);
            ctx.stroke(geometry.startArrow);
          }
          if (geometry.endArrow) {
            ctx.lineWidth = ARROW_ROUNDING_LINE_WIDTH;
            ctx.fill(geometry.endArrow);
            ctx.stroke(geometry.endArrow);
          }
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