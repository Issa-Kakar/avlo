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
}

// Invalidation types
export type InvalidationReason =
  | 'transform-change'
  | 'dirty-overflow'
  | 'geometry-change'
  | 'content-change';

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
  MAX_RECT_COUNT: 64,
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
