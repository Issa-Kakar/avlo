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

import { getStroke } from 'perfect-freehand';
import { getEndCap, getFrame, getPoints, getShapeType, getStartCap, getWidth } from '@/core/accessors';
import { buildConnectorPaths, type ConnectorPaths } from '@/core/connectors/connector-paths';
import { buildShapePathFromFrame } from '@/core/geometry/shape-path';
import type { ObjectHandle } from '@/core/types/objects';
import { getSvgPathFromStroke, PF_OPTIONS_BASE } from './types';

type CachedGeometry = Path2D | ConnectorPaths;

export function isConnectorPaths(geom: CachedGeometry): geom is ConnectorPaths {
  return typeof geom === 'object' && 'polyline' in geom;
}

interface CacheEntry {
  geometry: CachedGeometry;
  shapeType?: string;
}

const cache = new Map<string, CacheEntry>();

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
      return buildShapePathFromFrame(shapeType, frame);
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
