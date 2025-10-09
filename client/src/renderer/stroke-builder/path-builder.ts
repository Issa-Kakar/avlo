import type { StrokeView } from '@avlo/shared';
import { getStroke } from 'perfect-freehand';
import { PF_OPTIONS_BASE } from './pf-config';

export type PolylineData = {
  kind: 'polyline';
  path: Path2D | null;
  polyline: Float32Array;
  bounds: { x: number; y: number; width: number; height: number };
  pointCount: number;
};

export type PolygonData = {
  kind: 'polygon';
  path: Path2D | null;
  polygon: Float32Array;
  bounds: { x: number; y: number; width: number; height: number };
  pointCount: number;
};

export type StrokeRenderData = PolylineData | PolygonData;

/**
 * Builds POLYLINE render data (for perfect/snap shapes).
 * Creates Float32Array and Path2D at render time only.
 */
export function buildPolylineRenderData(stroke: StrokeView): PolylineData {
  const { points } = stroke;
  const stride = 2;
  const pointCount = Math.floor(points.length / stride);
  const polyline = new Float32Array(pointCount * 2);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const hasPath2D = typeof (globalThis as any).Path2D === 'function';
  const path = hasPath2D ? new Path2D() : null;

  if (pointCount === 0) {
    return {
      kind: 'polyline',
      path,
      polyline,
      bounds: { x: 0, y: 0, width: 0, height: 0 },
      pointCount: 0,
    };
  }

  // Extract first point
  let minX = points[0];
  let maxX = points[0];
  let minY = points[1];
  let maxY = points[1];

  if (path) {
    path.moveTo(points[0], points[1]);
  }
  polyline[0] = points[0];
  polyline[1] = points[1];

  // Process remaining points
  for (let i = 1; i < pointCount; i++) {
    const srcIdx = i * stride;
    const dstIdx = i * 2;

    const x = points[srcIdx];
    const y = points[srcIdx + 1];

    if (path) {
      path.lineTo(x, y);
    }
    polyline[dstIdx] = x;
    polyline[dstIdx + 1] = y;

    // Update bounds
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }

  const bounds = {
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY,
  };

  return { kind: 'polyline', path, polyline, bounds, pointCount };
}

// Use a MUTABLE 2-tuple to match PF's accepted point type
type Vec2 = [number, number];

/**
 * Convert flat points array to PF-native tuples (one-time conversion at cache build).
 */
function flatToPairs(points: ReadonlyArray<number>): Vec2[] {
  const n = (points.length / 2) | 0;
  const out = new Array<Vec2>(n);
  // i = source index (flat), j = tuple index
  for (let i = 0, j = 0; j < n; j++, i += 2) {
    out[j] = [points[i], points[i + 1]]; //perfect freehand expects a mutable 2-tuple
  }
  return out;
}

/**
 * Builds PF POLYGON render data (for freehand).
 * Uses fixed-width PF (no thinning), polygon is filled at render.
 */
export function buildPFPolygonRenderData(stroke: StrokeView): PolygonData {
  const size = stroke.style.size;

  // CRITICAL FIX: Prefer canonical tuples if available
  const inputTuples = stroke.pointsTuples ?? flatToPairs(stroke.points);

  // Use the canonical tuples or fallback conversion
  const outline = getStroke(inputTuples, {
    ...PF_OPTIONS_BASE,
    size,
    last: true, // finalized geometry on base canvas
  });

  // PF returns [[x,y], ...]; flatten once into typed array for draw
  const polygon = new Float32Array(outline.length * 2);
  for (let i = 0; i < outline.length; i++) {
    polygon[i * 2] = outline[i][0];
    polygon[i * 2 + 1] = outline[i][1];
  }

  const pointCount = outline.length;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const hasPath2D = typeof (globalThis as any).Path2D === 'function';
  const path = hasPath2D ? new Path2D() : null;

  if (path && pointCount > 0) {
    path.moveTo(polygon[0], polygon[1]);
    for (let i = 2; i < polygon.length; i += 2) {
      path.lineTo(polygon[i], polygon[i + 1]);
    }
    path.closePath();
  }

  // Bounds from polygon (not centerline) for accurate dirty-rects
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < polygon.length; i += 2) {
    const x = polygon[i], y = polygon[i + 1];
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }

  const bounds = {
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY,
  };

  return { kind: 'polygon', path, polygon, bounds, pointCount };
}

/**
 * Checks if a stroke's bbox is visible in the viewport.
 * Inflates bbox by half the stroke width since bbox is computed from points only.
 * Used for culling optimization.
 */
export function isStrokeVisible(
  stroke: StrokeView,
  viewportBounds: { minX: number; minY: number; maxX: number; maxY: number },
): boolean {
  const [minX, minY, maxX, maxY] = stroke.bbox;
  const halfWidth = stroke.style.size / 2;

  return !(
    maxX + halfWidth < viewportBounds.minX ||
    minX - halfWidth > viewportBounds.maxX ||
    maxY + halfWidth < viewportBounds.minY ||
    minY - halfWidth > viewportBounds.maxY
  );
}
