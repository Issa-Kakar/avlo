import type { Vec2 } from './types';

/**
 * Fit an Axis-Aligned Bounding Box to points using robust statistics.
 * Uses trimmed extents to ignore outliers and tails.
 */
export function fitAABB(points: Vec2[]): {
  cx: number;
  cy: number;
  hx: number;
  hy: number;
  angle: number; // Always 0 for AABB
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
} {
  const n = points.length;
  if (n < 2) {
    return { cx: 0, cy: 0, hx: 10, hy: 10, angle: 0, minX: -10, minY: -10, maxX: 10, maxY: 10 };
  }

  // Collect all x and y coordinates
  const xs = points.map(p => p[0]).sort((a, b) => a - b);
  const ys = points.map(p => p[1]).sort((a, b) => a - b);

  // Robust extent calculation: use 5th and 95th percentiles
  // This ignores outliers and tails
  // For small strokes (n < 20), use full extent
  const trim = n < 20 ? 0 : Math.floor(n * 0.05);
  const minX = xs[trim];
  const maxX = xs[n - 1 - trim];
  const minY = ys[trim];
  const maxY = ys[n - 1 - trim];

  // Compute center and half-extents
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const hx = Math.max(1, (maxX - minX) / 2);
  const hy = Math.max(1, (maxY - minY) / 2);

  return {
    cx, cy, hx, hy,
    angle: 0, // AABB is always axis-aligned
    minX, minY, maxX, maxY
  };
}