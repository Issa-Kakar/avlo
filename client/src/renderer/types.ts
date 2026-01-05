// Frame performance metrics
export interface FrameStats {
  frameCount: number;
  avgMs: number; // Exponential moving average
  fps: number; // Exponential moving average
  overBudgetCount: number;
  skippedCount: number;
  lastClearType: 'full' | 'dirty' | 'none';
  rectCount: number;
}

// Viewport information
export interface ViewportInfo {
  pixelWidth: number; // Device pixels
  pixelHeight: number; // Device pixels
  cssWidth: number; // CSS pixels
  cssHeight: number; // CSS pixels
  dpr: number;
  visibleWorldBounds?: { minX: number; minY: number; maxX: number; maxY: number };
  clipRegion?: DirtyClipRegion; // NEW: For spatial query optimization
}

// Add type for clip region
export interface DirtyClipRegion {
  worldRects: Array<{
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
  }>;
}

// Invalidation types
export type InvalidationReason =
  | 'transform-change'
  | 'dirty-overflow'
  | 'geometry-change'
  | 'content-change'
  | 'scene-change'
  | 'snapshot-update';

// Rectangles in different coordinate spaces
export interface DevicePixelRect {
  x: number; // Device pixels (CSS * DPR) - used for canvas clearing operations
  y: number; // Device pixels (CSS * DPR) - used for canvas clearing operations
  width: number; // Device pixels (CSS * DPR) - used for canvas clearing operations
  height: number; // Device pixels (CSS * DPR) - used for canvas clearing operations
}

export interface CSSPixelRect {
  x: number; // CSS pixels (before DPR) - used for API inputs
  y: number; // CSS pixels (before DPR) - used for API inputs
  width: number; // CSS pixels (before DPR) - used for API inputs
  height: number; // CSS pixels (before DPR) - used for API inputs
}

export interface WorldBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

// Thresholds
export const DIRTY_RECT_CONFIG = {
  MAX_RECT_COUNT: 20,
  MAX_AREA_RATIO: 0.33,
  AA_MARGIN: 1, // Antialiasing margin in device pixels
  MAX_WORLD_LINE_WIDTH: 50, // Maximum expected stroke size in world units (from config)
  COALESCE_SNAP: 2, // Grid snap for better merging
} as const;

export const FRAME_CONFIG = {
  TARGET_FPS: 60,
  TARGET_MS: 16.6,
  HIDDEN_FPS: 8,
  MOBILE_FPS: 30,
  SKIP_THRESHOLD_MS: 20, // Skip next frame if previous > 20ms
} as const;

// Perfect Freehand configuration
export const PF_OPTIONS_BASE = {
  thinning: 0.50,
  smoothing: 0.50,
  streamline: 0.6,
  simulatePressure: true,
  start: {
    cap: true,
    taper: 0,
  }
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
