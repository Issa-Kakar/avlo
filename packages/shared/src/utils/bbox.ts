import type * as Y from 'yjs';
import type { ObjectKind, WorldBounds } from '../types/objects';

export function computeBBoxFor(kind: ObjectKind, yMap: Y.Map<any>): [number, number, number, number] {
  switch (kind) {
    case 'stroke': {
      const points = (yMap.get('points') as [number, number][]) ?? [];
      if (points.length < 1) return [0, 0, 0, 0];

      let minX = points[0][0], minY = points[0][1];
      let maxX = minX, maxY = minY;

      for (let i = 1; i < points.length; i++) {
        const [x, y] = points[i];
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }

      // CRITICAL: Width IS part of bbox!
      // If width changes → bbox changes → geometry eviction
      const width = (yMap.get('width') as number) ?? 1;
      const padding = width * 0.5 + 1;

      return [
        minX - padding,
        minY - padding,
        maxX + padding,
        maxY + padding
      ];
    }

    case 'shape':
    case 'text': {
      const frame = (yMap.get('frame') as [number, number, number, number]) ?? [0, 0, 0, 0];
      return [
        frame[0],
        frame[1],
        frame[0] + frame[2],
        frame[1] + frame[3]
      ];
    }

    case 'connector': {
      const points = (yMap.get('points') as [number, number][]) ?? [];
      if (points.length < 2) return [0, 0, 0, 0];

      let minX = points[0][0], minY = points[0][1];
      let maxX = minX, maxY = minY;

      for (let i = 1; i < points.length; i++) {
        const [x, y] = points[i];
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }

      const width = (yMap.get('width') as number) ?? 2;
      const padding = width * 0.5 + 1;

      return [
        minX - padding,
        minY - padding,
        maxX + padding,
        maxY + padding
      ];
    }

    default:
      return [0, 0, 0, 0];
  }
}

export function bboxEquals(
  a: [number, number, number, number],
  b: [number, number, number, number]
): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];
}

export function bboxToBounds(bbox: [number, number, number, number]): WorldBounds {
  return {
    minX: bbox[0],
    minY: bbox[1],
    maxX: bbox[2],
    maxY: bbox[3]
  };
}