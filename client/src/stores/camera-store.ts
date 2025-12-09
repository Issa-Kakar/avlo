/**
 * Camera Store - Centralized camera/viewport state management
 *
 * Replaces ViewTransformContext with a Zustand store for maximum imperative access.
 * All tools, render loops, and overlays read directly from this store.
 *
 * Key principles:
 * - Single source of truth for camera state (scale, pan, viewport dimensions)
 * - Pure transform functions that read from store synchronously
 * - Module-level canvas reference for screen-to-world coordinate conversion
 * - Selective subscriptions via subscribeWithSelector middleware
 *
 * @module stores/camera-store
 */

import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import { PERFORMANCE_CONFIG } from '@avlo/shared';
import type { ViewTransform } from '@avlo/shared';

// ============================================
// TYPES
// ============================================

export interface CameraState {
  /** Zoom level (1.0 = 100%) */
  scale: number;
  /** World offset in world units */
  pan: { x: number; y: number };
  /** Viewport CSS width */
  cssWidth: number;
  /** Viewport CSS height */
  cssHeight: number;
  /** Device pixel ratio */
  dpr: number;
}

export interface CameraActions {
  /** Set scale with clamping to MIN_ZOOM/MAX_ZOOM */
  setScale: (scale: number) => void;
  /** Set pan with clamping to MAX_PAN_DISTANCE */
  setPan: (pan: { x: number; y: number }) => void;
  /** Set scale and pan atomically (for animations) */
  setScaleAndPan: (scale: number, pan: { x: number; y: number }) => void;
  /** Update viewport dimensions */
  setViewport: (cssWidth: number, cssHeight: number, dpr: number) => void;
  /** Reset view to initial state (scale=1, pan={0,0}) */
  resetView: () => void;
}

export type CameraStore = CameraState & CameraActions;

// ============================================
// MODULE-LEVEL CANVAS REFERENCE
// ============================================

/** Module-level canvas element for coordinate conversion */
let canvasElement: HTMLCanvasElement | null = null;

/**
 * Set the canvas element for coordinate conversion.
 * Called by CanvasStage on mount.
 */
export function setCanvasElement(el: HTMLCanvasElement | null): void {
  canvasElement = el;
}

/**
 * Get the canvas bounding rect for screen-to-canvas conversion.
 * Returns empty DOMRect if canvas not mounted.
 */
export function getCanvasRect(): DOMRect {
  return canvasElement?.getBoundingClientRect() ?? new DOMRect();
}

/**
 * Get the raw canvas element (for event attachment etc.)
 */
export function getCanvasElement(): HTMLCanvasElement | null {
  return canvasElement;
}

// ============================================
// STORE CREATION
// ============================================

/** Initial camera state */
const INITIAL_STATE: CameraState = {
  scale: 1,
  pan: { x: 0, y: 0 },
  cssWidth: 1, // Safe non-zero default
  cssHeight: 1,
  dpr: typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1,
};

/**
 * Camera store with subscribeWithSelector middleware for granular subscriptions.
 */
export const useCameraStore = create<CameraStore>()(
  subscribeWithSelector((set) => ({
    // Initial state
    ...INITIAL_STATE,

    // Actions
    setScale: (scale: number) => {
      const clampedScale = Math.max(
        PERFORMANCE_CONFIG.MIN_ZOOM,
        Math.min(PERFORMANCE_CONFIG.MAX_ZOOM, scale)
      );
      set({ scale: clampedScale });
    },

    setPan: (pan: { x: number; y: number }) => {
      const maxDistance = PERFORMANCE_CONFIG.MAX_PAN_DISTANCE;
      const clampedPan = {
        x: Math.max(-maxDistance, Math.min(maxDistance, pan.x)),
        y: Math.max(-maxDistance, Math.min(maxDistance, pan.y)),
      };
      set({ pan: clampedPan });
    },

    setScaleAndPan: (scale: number, pan: { x: number; y: number }) => {
      const clampedScale = Math.max(
        PERFORMANCE_CONFIG.MIN_ZOOM,
        Math.min(PERFORMANCE_CONFIG.MAX_ZOOM, scale)
      );
      const maxDistance = PERFORMANCE_CONFIG.MAX_PAN_DISTANCE;
      const clampedPan = {
        x: Math.max(-maxDistance, Math.min(maxDistance, pan.x)),
        y: Math.max(-maxDistance, Math.min(maxDistance, pan.y)),
      };
      set({ scale: clampedScale, pan: clampedPan });
    },

    setViewport: (cssWidth: number, cssHeight: number, dpr: number) => {
      set({ cssWidth, cssHeight, dpr });
    },

    resetView: () => {
      set({ scale: 1, pan: { x: 0, y: 0 } });
    },
  }))
);

// ============================================
// PURE TRANSFORM FUNCTIONS
// ============================================

/**
 * Convert world coordinates to canvas (CSS pixel) coordinates.
 * Formula: canvas = (world - pan) * scale
 */
export function worldToCanvas(worldX: number, worldY: number): [number, number] {
  const { scale, pan } = useCameraStore.getState();
  return [(worldX - pan.x) * scale, (worldY - pan.y) * scale];
}

/**
 * Convert canvas (CSS pixel) coordinates to world coordinates.
 * Formula: world = canvas / scale + pan
 */
export function canvasToWorld(canvasX: number, canvasY: number): [number, number] {
  const { scale, pan } = useCameraStore.getState();
  // Guard against zero scale
  const s = Math.max(1e-6, scale);
  return [canvasX / s + pan.x, canvasY / s + pan.y];
}

/**
 * Convert screen (client) coordinates to canvas (CSS pixel) coordinates.
 * Returns null if canvas not yet mounted (rect.width === 0).
 * Useful for zoom pivot calculations where we need canvas-relative position.
 */
export function screenToCanvas(clientX: number, clientY: number): [number, number] | null {
  const rect = getCanvasRect();
  if (rect.width === 0) return null;
  return [clientX - rect.left, clientY - rect.top];
}

/**
 * Convert screen (client) coordinates to world coordinates.
 * Returns null if canvas not yet mounted (rect.width === 0).
 */
export function screenToWorld(clientX: number, clientY: number): [number, number] | null {
  const canvasCoords = screenToCanvas(clientX, clientY);
  if (!canvasCoords) return null;
  return canvasToWorld(canvasCoords[0], canvasCoords[1]);
}

/**
 * Convert world coordinates to screen (client) coordinates.
 */
export function worldToClient(worldX: number, worldY: number): [number, number] {
  const rect = getCanvasRect();
  const [canvasX, canvasY] = worldToCanvas(worldX, worldY);
  return [canvasX + rect.left, canvasY + rect.top];
}

// ============================================
// VIEWPORT UTILITY FUNCTIONS
// ============================================

/**
 * Get the world-space bounds currently visible in the viewport.
 */
export function getVisibleWorldBounds(): {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
} {
  const { cssWidth, cssHeight, scale, pan } = useCameraStore.getState();
  // Guard against invalid scale
  const safeScale = Math.max(0.001, scale);

  return {
    minX: pan.x,
    minY: pan.y,
    maxX: cssWidth / safeScale + pan.x,
    maxY: cssHeight / safeScale + pan.y,
  };
}

/**
 * Get viewport information including device pixel dimensions.
 */
export function getViewportInfo(): {
  pixelWidth: number;
  pixelHeight: number;
  cssWidth: number;
  cssHeight: number;
  dpr: number;
} {
  const { cssWidth, cssHeight, dpr } = useCameraStore.getState();
  return {
    pixelWidth: Math.round(cssWidth * dpr),
    pixelHeight: Math.round(cssHeight * dpr),
    cssWidth,
    cssHeight,
    dpr,
  };
}

// ============================================
// SELECTORS FOR REACT COMPONENTS
// ============================================

/** Selector for scale value */
export const selectScale = (s: CameraStore): number => s.scale;

/** Selector for pan value */
export const selectPan = (s: CameraStore): { x: number; y: number } => s.pan;

/** Selector for DPR value */
export const selectDpr = (s: CameraStore): number => s.dpr;

/** Selector for viewport dimensions */
export const selectViewport = (s: CameraStore): { cssWidth: number; cssHeight: number; dpr: number } => ({
  cssWidth: s.cssWidth,
  cssHeight: s.cssHeight,
  dpr: s.dpr,
});

// ============================================
// VIEWTRANSFORM COMPATIBILITY HELPER
// ============================================

/**
 * Get a ViewTransform object compatible with the existing interface.
 * Use this for backward compatibility during migration.
 */
export function getViewTransform(): ViewTransform {
  const { scale, pan } = useCameraStore.getState();

  return {
    worldToCanvas: (x: number, y: number): [number, number] => {
      return [(x - pan.x) * scale, (y - pan.y) * scale];
    },
    canvasToWorld: (x: number, y: number): [number, number] => {
      const s = Math.max(1e-6, scale);
      return [x / s + pan.x, y / s + pan.y];
    },
    scale,
    pan,
  };
}

/**
 * Create a ViewTransform from explicit scale and pan values.
 * Used when we need a transform with specific values (not current state).
 */
export function createViewTransform(scale: number, pan: { x: number; y: number }): ViewTransform {
  return {
    worldToCanvas: (x: number, y: number): [number, number] => {
      return [(x - pan.x) * scale, (y - pan.y) * scale];
    },
    canvasToWorld: (x: number, y: number): [number, number] => {
      const s = Math.max(1e-6, scale);
      return [x / s + pan.x, y / s + pan.y];
    },
    scale,
    pan,
  };
}
