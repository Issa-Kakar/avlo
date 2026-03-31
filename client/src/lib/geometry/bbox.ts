import type * as Y from 'yjs';
import type { ObjectKind } from '@/types/objects';
import type { WorldBounds } from '@/types/geometry';
import { getPoints, getFrame, getWidth, getStartCap, getEndCap } from '@/lib/object-accessors';

export function computeBBoxFor(
  kind: ObjectKind,
  yMap: Y.Map<unknown>,
): [number, number, number, number] {
  switch (kind) {
    case 'stroke': {
      const points = getPoints(yMap);
      if (points.length < 1) return [0, 0, 0, 0];

      let minX = points[0][0],
        minY = points[0][1];
      let maxX = minX,
        maxY = minY;

      for (let i = 1; i < points.length; i++) {
        const [x, y] = points[i];
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }

      // CRITICAL: Width IS part of bbox!
      // If width changes → bbox changes → geometry eviction
      const width = getWidth(yMap, 1);
      const padding = width * 0.5 + 1;

      return [minX - padding, minY - padding, maxX + padding, maxY + padding];
    }

    case 'shape': {
      const frame = getFrame(yMap) ?? [0, 0, 0, 0];
      const strokeWidth = getWidth(yMap, 1);
      const padding = strokeWidth * 0.5 + 1;

      return [
        frame[0] - padding,
        frame[1] - padding,
        frame[0] + frame[2] + padding,
        frame[1] + frame[3] + padding,
      ];
    }

    case 'text':
    case 'code':
    case 'image': {
      const frame = getFrame(yMap) ?? [0, 0, 0, 0];
      return [frame[0], frame[1], frame[0] + frame[2], frame[1] + frame[3]];
    }

    case 'bookmark': {
      const frame = getFrame(yMap) ?? [0, 0, 0, 0];
      const shadowPad = frame[2] * 0.15;
      return [
        frame[0] - shadowPad,
        frame[1] - shadowPad,
        frame[0] + frame[2] + shadowPad,
        frame[1] + frame[3] + shadowPad,
      ];
    }

    case 'note': {
      // Fallback only — room-doc-manager uses computeNoteBBox from text-system
      const origin = (yMap.get('origin') as [number, number] | undefined) ?? [0, 0];
      const w = (yMap.get('width') as number) ?? 280;
      return [origin[0], origin[1], origin[0] + w, origin[1] + w];
    }

    case 'connector': {
      const points = getPoints(yMap);
      if (points.length < 2) return [0, 0, 0, 0];

      let minX = points[0][0],
        minY = points[0][1];
      let maxX = minX,
        maxY = minY;

      for (let i = 1; i < points.length; i++) {
        const [x, y] = points[i];
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }

      const width = getWidth(yMap);
      const startCap = getStartCap(yMap);
      const endCap = getEndCap(yMap);

      // Polyline stroke extends perpendicular by half width
      const strokePadding = width / 2;

      // Arrow sizing (matches ROUTING_CONFIG in connectors/constants.ts):
      // - arrowLength = max(ARROW_MIN_LENGTH_W=6, width * ARROW_LENGTH_FACTOR=3)
      // - arrowHalfWidth = arrowLength * ARROW_ASPECT_RATIO / 2 = arrowLength / 2
      // - Rounding stroke (roundingLineWidth=5) extends triangle by 2.5
      const hasArrow = startCap === 'arrow' || endCap === 'arrow';

      let padding: number;
      if (hasArrow) {
        const arrowLength = Math.max(6, width * 3);
        const arrowHalfWidth = arrowLength / 2;
        const arrowRounding = 2.5;
        padding = Math.max(strokePadding, arrowHalfWidth + arrowRounding) + 1;
      } else {
        padding = strokePadding + 1;
      }

      return [minX - padding, minY - padding, maxX + padding, maxY + padding];
    }

    default:
      return [0, 0, 0, 0];
  }
}

/**
 * Compute connector bbox from externally-provided points.
 * Reads width and cap info from the Y.Map (which is never stale for style props).
 * Use this when you have rerouted points that haven't been committed yet.
 */
export function computeConnectorBBoxFromPoints(
  points: [number, number][],
  yMap: Y.Map<unknown>,
): [number, number, number, number] {
  if (points.length < 2) return [0, 0, 0, 0];

  let minX = points[0][0],
    minY = points[0][1];
  let maxX = minX,
    maxY = minY;

  for (let i = 1; i < points.length; i++) {
    const [x, y] = points[i];
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }

  const width = getWidth(yMap);
  const startCap = getStartCap(yMap);
  const endCap = getEndCap(yMap);

  const strokePadding = width / 2;
  const hasArrow = startCap === 'arrow' || endCap === 'arrow';

  let padding: number;
  if (hasArrow) {
    const arrowLength = Math.max(6, width * 3);
    const arrowHalfWidth = arrowLength / 2;
    const arrowRounding = 2.5;
    padding = Math.max(strokePadding, arrowHalfWidth + arrowRounding) + 1;
  } else {
    padding = strokePadding + 1;
  }

  return [minX - padding, minY - padding, maxX + padding, maxY + padding];
}

export function bboxEquals(
  a: [number, number, number, number],
  b: [number, number, number, number],
): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];
}

export function bboxToBounds(bbox: [number, number, number, number]): WorldBounds {
  return {
    minX: bbox[0],
    minY: bbox[1],
    maxX: bbox[2],
    maxY: bbox[3],
  };
}
