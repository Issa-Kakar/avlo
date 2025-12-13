/**
 * Invalidation Helpers - Global invalidation functions
 *
 * Provides module-level access to render loop invalidation.
 * Set by CanvasRuntime during initialization, used by tools and other imperative code.
 *
 * @module canvas/invalidation-helpers
 */

import type { WorldBounds } from '@avlo/shared';

/**
 * Module-level references to render loop functions.
 * Set by CanvasRuntime, used by tools and other imperative code.
 */
let worldInvalidator: ((bounds: WorldBounds) => void) | null = null;
let overlayInvalidator: (() => void) | null = null;
let holdPreviewFn: (() => void) | null = null;

/**
 * Register the world (base canvas) invalidation function.
 * Called by CanvasRuntime on render loop start.
 */
export function setWorldInvalidator(fn: ((bounds: WorldBounds) => void) | null): void {
  worldInvalidator = fn;
}

/**
 * Register the overlay canvas invalidation function.
 * Called by CanvasRuntime on overlay loop start.
 */
export function setOverlayInvalidator(fn: (() => void) | null): void {
  overlayInvalidator = fn;
}

/**
 * Register the hold preview function.
 * Called by CanvasRuntime on overlay loop start.
 */
export function setHoldPreviewFn(fn: (() => void) | null): void {
  holdPreviewFn = fn;
}

/**
 * Invalidate a region of the world canvas (dirty rect).
 * Safe no-op if no runtime is active.
 */
export function invalidateWorld(bounds: WorldBounds): void {
  worldInvalidator?.(bounds);
}

/**
 * Invalidate the entire overlay canvas (full clear, cheap).
 * Safe no-op if no runtime is active.
 */
export function invalidateOverlay(): void {
  overlayInvalidator?.();
}

/**
 * Hold the preview for one frame during snapshot transitions.
 * Prevents preview flash when committing strokes.
 * Safe no-op if no runtime is active.
 */
export function holdPreviewForOneFrame(): void {
  holdPreviewFn?.();
}
