import type { WorldBounds } from '@avlo/shared';

// Viewport information
export interface ViewportInfo {
  pixelWidth: number; // Device pixels
  pixelHeight: number; // Device pixels
  cssWidth: number; // CSS pixels
  cssHeight: number; // CSS pixels
  dpr: number;
  visibleWorldBounds?: { minX: number; minY: number; maxX: number; maxY: number };
  clipWorldRects?: WorldBounds[];
}

// Re-export for convenience
export type { WorldBounds };

export const FRAME_CONFIG = {
  TARGET_FPS: 60,
  TARGET_MS: 16.6,
  HIDDEN_FPS: 8,
  MOBILE_FPS: 30,
} as const;

// Perfect Freehand configuration
export const PF_OPTIONS_BASE = {
  thinning: 0.5,
  smoothing: 0.5,
  streamline: 0.6,
  simulatePressure: true,
  start: {
    cap: true,
    taper: 0,
  },
} as const;

/**
 * Quadratic Bézier smoothing of Perfect Freehand outline points → SVG path string.
 * Creates smooth curves instead of faceted lineTo segments.
 */
export function getSvgPathFromStroke(points: number[][], closed = true): string {
  const len = points.length;
  if (len < 2) return '';

  const avg = (a: number, b: number) => (a + b) / 2;

  if (len === 2) {
    const [a, b] = points;
    return `M${a[0]},${a[1]} L${b[0]},${b[1]}${closed ? ' Z' : ''}`;
  }

  let a = points[0];
  let b = points[1];
  let c = points[2];
  let d = `M${a[0]},${a[1]} Q${b[0]},${b[1]} ${avg(b[0], c[0])},${avg(b[1], c[1])} T`;

  for (let i = 2; i < len - 1; i++) {
    a = points[i];
    b = points[i + 1];
    d += `${avg(a[0], b[0])},${avg(a[1], b[1])} `;
  }

  if (closed) d += 'Z';
  return d;
}
