import type { ObjectHandle } from '@avlo/shared';
import { getStroke } from 'perfect-freehand';
import { PF_OPTIONS_BASE } from './stroke-builder/pf-config';
import { getSvgPathFromStroke } from './stroke-builder/pf-svg';

// Helper function to create rounded rectangle
function roundedRect(path: Path2D, x: number, y: number, w: number, h: number, r: number): void {
  path.moveTo(x + r, y);
  path.lineTo(x + w - r, y);
  path.quadraticCurveTo(x + w, y, x + w, y + r);
  path.lineTo(x + w, y + h - r);
  path.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  path.lineTo(x + r, y + h);
  path.quadraticCurveTo(x, y + h, x, y + h - r);
  path.lineTo(x, y + r);
  path.quadraticCurveTo(x, y, x + r, y);
}

// DEAD SIMPLE: Just Path2D memoization by ID
export class ObjectRenderCache {
  private cache = new Map<string, Path2D>();
  // No size limit - we already evict aggressively on bbox changes

  getOrBuild(id: string, handle: ObjectHandle): Path2D {
    // Check cache
    const cached = this.cache.get(id);
    if (cached) return cached;

    // Build and store
    const path = this.buildPath(handle);
    this.cache.set(id, path);
    return path;
  }

  private buildPath(handle: ObjectHandle): Path2D {
    const { kind, y } = handle;

    switch (kind) {
      case 'stroke': {
        // STROKES ARE ALWAYS PERFECT FREEHAND POLYGONS
        const points = y.get('points') as [number, number][];
        const width = y.get('width') as number;

        if (!points || points.length === 0) {
          return new Path2D();
        }

        // Generate Perfect Freehand outline
        const outline = getStroke(points, {
          ...PF_OPTIONS_BASE,
          size: width,
          last: true,
        });

        return new Path2D(getSvgPathFromStroke(outline, false));
      }

      case 'shape': {
        // SHAPES ARE ALWAYS GEOMETRIC POLYLINES (built from frame)
        const shapeType = y.get('shapeType') as string;
        const frame = y.get('frame') as [number, number, number, number];
        console.log(shapeType, frame);
        if (!frame) return new Path2D();

        const [x, y0, w, h] = frame;
        const path = new Path2D();

        switch (shapeType) {
          case 'rect':
            path.rect(x, y0, w, h);
            break;
          case 'ellipse':
            path.ellipse(x + w/2, y0 + h/2, w/2, h/2, 0, 0, Math.PI * 2);
            break;
          case 'diamond': {
            const cx = x + w / 2;
            const cy = y0 + h / 2;
            path.moveTo(cx, y0);
            path.lineTo(x + w, cy);
            path.lineTo(cx, y0 + h);
            path.lineTo(x, cy);
            path.closePath();
            break;
          }
          case 'roundedRect': {
            const r = Math.min((y.get('cornerRadius') as number) ?? 8, w / 2, h / 2);
            roundedRect(path, x, y0, w, h, r);
            break;
          }
          default:
            path.rect(x, y0, w, h);
        }

        return path;
      }

      case 'connector': {
        // CONNECTORS ARE ALWAYS POLYLINES (including arrows)
        const points = y.get('points') as [number, number][];
        const endCap = y.get('endCap') as string;
        const startCap = y.get('startCap') as string;

        if (!points || points.length < 2) {
          return new Path2D();
        }

        const path = new Path2D();

        // Draw main line
        path.moveTo(points[0][0], points[0][1]);
        for (let i = 1; i < points.length; i++) {
          path.lineTo(points[i][0], points[i][1]);
        }

        // Add arrow caps if needed (simplified for now)
        if (endCap === 'arrow' && points.length >= 2) {
          const lastIdx = points.length - 1;
          const [x2, y2] = points[lastIdx];
          const [x1, y1] = points[lastIdx - 1];

          const angle = Math.atan2(y2 - y1, x2 - x1);
          const arrowLength = 10;
          const arrowAngle = Math.PI / 6;

          path.moveTo(x2, y2);
          path.lineTo(
            x2 - arrowLength * Math.cos(angle - arrowAngle),
            y2 - arrowLength * Math.sin(angle - arrowAngle)
          );
          path.moveTo(x2, y2);
          path.lineTo(
            x2 - arrowLength * Math.cos(angle + arrowAngle),
            y2 - arrowLength * Math.sin(angle + arrowAngle)
          );
        }

        if (startCap === 'arrow' && points.length >= 2) {
          const [x1, y1] = points[0];
          const [x2, y2] = points[1];

          const angle = Math.atan2(y2 - y1, x2 - x1);
          const arrowLength = 10;
          const arrowAngle = Math.PI / 6;

          path.moveTo(x1, y1);
          path.lineTo(
            x1 + arrowLength * Math.cos(angle - arrowAngle),
            y1 + arrowLength * Math.sin(angle - arrowAngle)
          );
          path.moveTo(x1, y1);
          path.lineTo(
            x1 + arrowLength * Math.cos(angle + arrowAngle),
            y1 + arrowLength * Math.sin(angle + arrowAngle)
          );
        }

        return path;
      }

      case 'text':
        // Text doesn't use Path2D
        return new Path2D();

      default:
        return new Path2D();
    }
  }

  evict(id: string): void {
    this.cache.delete(id);
  }

  evictMany(ids: string[]): void {
    for (const id of ids) {
      this.cache.delete(id);
    }
  }

  clear(): void {
    this.cache.clear();
  }
}

// Singleton instance
let globalCache: ObjectRenderCache | null = null;

export function getObjectCacheInstance(): ObjectRenderCache {
  if (!globalCache) {
    globalCache = new ObjectRenderCache();
  }
  return globalCache;
}