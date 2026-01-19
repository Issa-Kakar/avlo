import type { ObjectHandle } from '@avlo/shared';
import { getStroke } from 'perfect-freehand';
import { PF_OPTIONS_BASE, getSvgPathFromStroke } from './types';
import { buildConnectorPaths, type ConnectorPaths } from '@/lib/connectors/connector-paths';

/**
 * Union type for cached geometry.
 * Most objects use a single Path2D, but connectors need multiple paths
 * for proper multi-pass rendering (polyline + arrows).
 */
export type CachedGeometry = Path2D | ConnectorPaths;

/**
 * Type guard to check if cached geometry is ConnectorPaths.
 */
export function isConnectorPaths(geom: CachedGeometry): geom is ConnectorPaths {
  return typeof geom === 'object' && 'polyline' in geom;
}

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

// DEAD SIMPLE: Just geometry memoization by ID
// Connectors use ConnectorPaths (multi-path), everything else uses single Path2D
export class ObjectRenderCache {
  private cache = new Map<string, CachedGeometry>();
  // No size limit - we already evict aggressively on bbox changes

  getOrBuild(id: string, handle: ObjectHandle): CachedGeometry {
    // Check cache
    const cached = this.cache.get(id);
    if (cached) return cached;

    // Build and store
    const geometry = this.buildGeometry(handle);
    this.cache.set(id, geometry);
    return geometry;
  }

  private buildGeometry(handle: ObjectHandle): CachedGeometry {
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
        if (!frame) return new Path2D();

        const [x, y0, w, h] = frame;
        const path = new Path2D();

        switch (shapeType) {
          case 'rect':
            path.rect(x, y0, w, h);
            break;
          case 'ellipse':
            path.ellipse(x + w / 2, y0 + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
            break;
          case 'diamond': {
            const cx = x + w / 2;
            const cy = y0 + h / 2;
            // Match preview logic exactly for WYSIWYG (20px max, or 10% of size)
            const radius = Math.min(20, Math.min(w, h) * 0.1);
            // Start on the top-right edge (midpoint)
            path.moveTo(cx + w / 4, y0 + h / 4);
            // Right Tip
            // arcTo(cornerX, cornerY, destX, destY, radius)
            path.arcTo(x + w, cy, cx, y0 + h, radius);
            // Bottom Tip
            path.arcTo(cx, y0 + h, x, cy, radius);
            // Left Tip
            path.arcTo(x, cy, cx, y0, radius);
            // Top Tip
            path.arcTo(cx, y0, x + w, cy, radius);
            path.closePath();
            break;
          }
          case 'roundedRect': {
            const radius = Math.min(20, w * 0.1, h * 0.1);
            roundedRect(path, x, y0, w, h, radius);
            break;
          }
          default:
            path.rect(x, y0, w, h);
        }

        return path;
      }

      case 'connector': {
        // CONNECTORS USE MULTI-PATH: polyline + optional arrows
        const points = (y.get('points') as [number, number][]) ?? [];
        const strokeWidth = (y.get('width') as number) ?? 2;
        const startCap = (y.get('startCap') as 'arrow' | 'none') ?? 'none';
        const endCap = (y.get('endCap') as 'arrow' | 'none') ?? 'none';

        return buildConnectorPaths({ points, strokeWidth, startCap, endCap });
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