/**
 * Transform utilities for canvas coordinate conversion
 * These helpers ensure consistent transform application across the codebase
 *
 * IMPORTANT: Pan is in WORLD units per OVERVIEW.MD specification
 * Transform: canvas = (world - pan) × scale
 *
 * IMPORTANT: Transform order for world rendering:
 * ctx.scale(scale, scale) THEN ctx.translate(-pan.x, -pan.y)
 * This composes to: canvasPoint = (worldPoint - pan) × scale
 *
 * Note: IMPLEMENTATION.MD Phase 3.2 incorrectly says "Add pan offset"
 * but OVERVIEW.MD is authoritative and specifies subtract pan.
 *
 * @module canvas/internal/transforms
 */

import { PERFORMANCE_CONFIG } from '@avlo/shared';

export interface Point {
  x: number;
  y: number;
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/**
 * Apply view transform to a context for world-space rendering
 * @param ctx - Canvas context
 * @param scale - Zoom level
 * @param pan - World offset in world units
 */
export function applyViewTransform(
  ctx: CanvasRenderingContext2D,
  scale: number,
  pan: { x: number; y: number },
): void {
  // CRITICAL: Scale first, then translate by negative pan
  // This order composes to: canvasPoint = (worldPoint - pan) * scale
  // DO NOT CHANGE THIS ORDER - it's mathematically required for correct world units pan
  ctx.scale(scale, scale);
  ctx.translate(-pan.x, -pan.y);
}

/**
 * Convert a world-space bounding box to canvas space
 * @param bounds - World space bounds
 * @param scale - Zoom level
 * @param pan - World offset in world units
 */
export function transformBounds(
  bounds: Bounds,
  scale: number,
  pan: { x: number; y: number },
): Bounds {
  // Transform: canvasPoint = (worldPoint - pan) * scale
  return {
    minX: (bounds.minX - pan.x) * scale,
    minY: (bounds.minY - pan.y) * scale,
    maxX: (bounds.maxX - pan.x) * scale,
    maxY: (bounds.maxY - pan.y) * scale,
  };
}

/**
 * Check if a world-space bounds is visible in the viewport
 * Used for culling in Phase 3.3
 */
export function isInViewport(
  worldBounds: Bounds,
  viewportWidth: number,
  viewportHeight: number,
  scale: number,
  pan: { x: number; y: number },
): boolean {
  const screenBounds = transformBounds(worldBounds, scale, pan);

  // Check if any part of bounds intersects viewport
  return !(
    screenBounds.maxX < 0 ||
    screenBounds.minX > viewportWidth ||
    screenBounds.maxY < 0 ||
    screenBounds.minY > viewportHeight
  );
}

/**
 * Calculate the world-space bounds visible in the viewport
 * Used for spatial queries in Phase 6
 * @param viewportWidth - Canvas width in pixels
 * @param viewportHeight - Canvas height in pixels
 * @param scale - Zoom level
 * @param pan - World offset in world units
 */
export function getVisibleWorldBounds(
  viewportWidth: number,
  viewportHeight: number,
  scale: number,
  pan: { x: number; y: number },
): Bounds {
  // Inverse transform: worldPoint = canvasPoint / scale + pan
  const topLeftWorld = {
    x: 0 / scale + pan.x,
    y: 0 / scale + pan.y,
  };

  const bottomRightWorld = {
    x: viewportWidth / scale + pan.x,
    y: viewportHeight / scale + pan.y,
  };

  return {
    minX: topLeftWorld.x,
    minY: topLeftWorld.y,
    maxX: bottomRightWorld.x,
    maxY: bottomRightWorld.y,
  };
}

/**
 * Clamp a scale value to config limits
 */
export function clampScale(scale: number): number {
  return Math.max(PERFORMANCE_CONFIG.MIN_ZOOM, Math.min(PERFORMANCE_CONFIG.MAX_ZOOM, scale));
}

/**
 * Calculate zoom transform for a specific point (for zoom-to-point in Phase 5)
 * @param currentScale - Current zoom level
 * @param currentPan - Current pan in world units
 * @param zoomFactor - Multiplier for zoom (e.g., 1.2 for zoom in)
 * @param zoomCenter - Focus point in canvas coordinates
 */
export function calculateZoomTransform(
  currentScale: number,
  currentPan: Point,
  zoomFactor: number,
  zoomCenter: Point, // In canvas coordinates
): { scale: number; pan: Point } {
  const newScale = clampScale(currentScale * zoomFactor);

  // Calculate world position of zoom center
  // worldPos = canvasPos / scale + pan
  const worldX = zoomCenter.x / currentScale + currentPan.x;
  const worldY = zoomCenter.y / currentScale + currentPan.y;

  // Calculate new pan to keep the same world point at zoom center
  // After zoom: canvasPos = (worldPos - newPan) * newScale
  // We want: zoomCenter = (worldPos - newPan) * newScale
  // So: newPan = worldPos - zoomCenter / newScale
  const newPan = {
    x: worldX - zoomCenter.x / newScale,
    y: worldY - zoomCenter.y / newScale,
  };

  return { scale: newScale, pan: newPan };
}
