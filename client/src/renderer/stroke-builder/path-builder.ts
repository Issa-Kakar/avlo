import type { StrokeView } from '@avlo/shared';

export interface StrokeRenderData {
  path: Path2D | null; // null when Path2D not available (tests)
  polyline: Float32Array;
  bounds: { x: number; y: number; width: number; height: number }; // Plain object, not DOMRect
  pointCount: number;
  hasPressure: boolean;
}

/**
 * Detects stride robustly - only uses 3-stride if points have pressure-like values.
 * Prevents false positives on 2-stride arrays with length divisible by 3.
 *
 * CRITICAL: This is a Phase 4 heuristic. Phase 5 will enforce consistent stride at commit time:
 * - If any pressure observed during drawing → encode all points as triplets (fill missing with 1.0)
 * - Otherwise encode as pairs only
 * This ensures fixed stride per stroke, eliminating guesswork.
 */
function detectStride(points: ReadonlyArray<number>): 2 | 3 {
  if (points.length >= 3 && points.length % 3 === 0) {
    // Sample entries to verify they look like pressure values
    let samples = 0,
      validPressure = 0;
    for (let i = 2; i < points.length && samples < 12; i += 3) {
      const p = points[i];
      samples++;
      if (Number.isFinite(p) && p >= 0 && p <= 1) validPressure++;
    }
    // Require 80% of samples to be valid pressure values
    if (validPressure >= Math.ceil(samples * 0.8)) return 3;
  }
  return 2;
}

/**
 * Builds render data from stroke points.
 * Creates Float32Array and Path2D at render time only.
 *
 * CRITICAL: Points from snapshot are ReadonlyArray<number>,
 * never Float32Array until this render-time conversion.
 */
export function buildStrokeRenderData(stroke: StrokeView): StrokeRenderData {
  const { points } = stroke;

  // Robust stride detection to avoid mis-parsing
  const stride = detectStride(points);
  const hasPressure = stride === 3;
  const pointCount = Math.floor(points.length / stride);

  // Build Float32Array at render time (never stored)
  const polyline = new Float32Array(pointCount * 2);

  // Feature-detect Path2D for test environments
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const hasPath2D = typeof (globalThis as any).Path2D === 'function';
  const path = hasPath2D ? new Path2D() : null;

  if (pointCount === 0) {
    return {
      path,
      polyline,
      bounds: { x: 0, y: 0, width: 0, height: 0 },
      pointCount: 0,
      hasPressure: false,
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
    // const pressure = hasPressure ? points[srcIdx + 2] : 1.0; // For future use

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

  // Use plain object instead of DOMRect for test compatibility
  const bounds = {
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY,
  };

  return {
    path,
    polyline,
    bounds,
    pointCount,
    hasPressure,
  };
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

  // Inflate by half the stroke width to account for stroke thickness
  const halfWidth = stroke.style.size / 2;

  return !(
    maxX + halfWidth < viewportBounds.minX ||
    minX - halfWidth > viewportBounds.maxX ||
    maxY + halfWidth < viewportBounds.minY ||
    minY - halfWidth > viewportBounds.maxY
  );
}
