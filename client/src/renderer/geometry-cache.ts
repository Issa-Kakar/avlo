/**
 * Geometry Cache — memoizes Path2D (strokes, shapes) and ConnectorPaths (connectors).
 *
 * Only caches geometry for: stroke, shape, connector.
 * Text, code, note, image, bookmark do NOT use this cache — their rendering
 * is handled by their respective layout systems (text-system, code-system, etc).
 *
 * Shape staleness: stores shapeType alongside geometry. getOrBuild auto-detects
 * shapeType changes (rect→diamond etc.) and rebuilds without external eviction.
 *
 * Eviction contract:
 * - BBox change → evictGeometry(id) — geometry is stale (points/frame changed)
 * - Object deleted → called via removeObjectCaches(id, kind) in object-cache.ts
 * - Room teardown → clearGeometry() via clearAllObjectCaches()
 */

import type { ObjectHandle } from '@/core/types/objects';
import { getPoints, getFrame, getWidth, getShapeType, getStartCap, getEndCap } from '@/core/accessors';
import { getStroke } from 'perfect-freehand';
import { PF_OPTIONS_BASE, getSvgPathFromStroke } from './types';
import { buildConnectorPaths, type ConnectorPaths } from '@/core/connectors/connector-paths';

type CachedGeometry = Path2D | ConnectorPaths;

export function isConnectorPaths(geom: CachedGeometry): geom is ConnectorPaths {
  return typeof geom === 'object' && 'polyline' in geom;
}

interface CacheEntry {
  geometry: CachedGeometry;
  shapeType?: string;
}

const cache = new Map<string, CacheEntry>();

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

function buildGeometry(handle: ObjectHandle): CachedGeometry {
  const { kind, y } = handle;

  switch (kind) {
    case 'stroke': {
      const points = getPoints(y);
      const width = getWidth(y);

      if (points.length === 0) {
        return new Path2D();
      }

      const outline = getStroke(points, {
        ...PF_OPTIONS_BASE,
        size: width,
        last: true,
      });

      return new Path2D(getSvgPathFromStroke(outline, false));
    }

    case 'shape': {
      const shapeType = getShapeType(y);
      const frame = getFrame(y);
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
          const radius = Math.min(20, Math.min(w, h) * 0.1);
          path.moveTo(cx + w / 4, y0 + h / 4);
          path.arcTo(x + w, cy, cx, y0 + h, radius);
          path.arcTo(cx, y0 + h, x, cy, radius);
          path.arcTo(x, cy, cx, y0, radius);
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
      const points = getPoints(y);
      const strokeWidth = getWidth(y);
      const startCap = getStartCap(y);
      const endCap = getEndCap(y);

      return buildConnectorPaths({ points, strokeWidth, startCap, endCap });
    }

    default:
      return new Path2D();
  }
}

function getOrBuild(id: string, handle: ObjectHandle): CachedGeometry {
  const entry = cache.get(id);
  if (entry) {
    if (handle.kind === 'shape') {
      const currentType = getShapeType(handle.y);
      if (entry.shapeType !== currentType) {
        const geometry = buildGeometry(handle);
        cache.set(id, { geometry, shapeType: currentType });
        return geometry;
      }
    }
    return entry.geometry;
  }
  const geometry = buildGeometry(handle);
  cache.set(id, {
    geometry,
    shapeType: handle.kind === 'shape' ? getShapeType(handle.y) : undefined,
  });
  return geometry;
}

export function getPath(id: string, handle: ObjectHandle): Path2D {
  return getOrBuild(id, handle) as Path2D;
}

export function getConnectorPaths(id: string, handle: ObjectHandle): ConnectorPaths {
  return getOrBuild(id, handle) as ConnectorPaths;
}

/** Evict geometry for one object (bbox changed → stale path) */
export function evictGeometry(id: string): void {
  cache.delete(id);
}

/** Clear all geometry (room teardown) */
export function clearGeometry(): void {
  cache.clear();
}
