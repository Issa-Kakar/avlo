/**
 * Canvas Context Registry - Module-level 2D context storage
 *
 * Provides imperative access to canvas rendering contexts for render loops
 * and tools. Follows the same pattern as room-runtime.ts and cursor-manager.ts.
 *
 * @module canvas/canvas-context-registry
 */

let baseCtx: CanvasRenderingContext2D | null = null;
let overlayCtx: CanvasRenderingContext2D | null = null;

/**
 * Set the base canvas 2D context.
 * Called by Canvas.tsx when contexts are obtained.
 */
export function setBaseContext(ctx: CanvasRenderingContext2D | null): void {
  baseCtx = ctx;
}

/**
 * Set the overlay canvas 2D context.
 * Called by Canvas.tsx when contexts are obtained.
 */
export function setOverlayContext(ctx: CanvasRenderingContext2D | null): void {
  overlayCtx = ctx;
}

/**
 * Get the base canvas 2D context.
 * Returns null if canvas not mounted.
 */
export function getBaseContext(): CanvasRenderingContext2D | null {
  return baseCtx;
}

/**
 * Get the overlay canvas 2D context.
 * Returns null if canvas not mounted.
 */
export function getOverlayContext(): CanvasRenderingContext2D | null {
  return overlayCtx;
}
