/**
 * Internal helper functions for Canvas 2D context management.
 * These utilities are used internally by canvas components and are not exposed to UI.
 *
 * @module canvas/internal/context2d
 */

export interface Context2DConfig {
  imageSmoothingEnabled?: boolean;
  lineCap?: CanvasLineCap; // eslint-disable-line no-undef
  lineJoin?: CanvasLineJoin; // eslint-disable-line no-undef
}

/**
 * Configures baseline defaults for a 2D canvas rendering context.
 * Sets properties that affect rendering quality and appearance.
 *
 * @param ctx - The Canvas 2D rendering context to configure
 * @param config - Optional configuration overrides
 */
export function configureContext2D(
  ctx: CanvasRenderingContext2D,
  config: Context2DConfig = {},
): void {
  // Image smoothing for better quality when scaling
  ctx.imageSmoothingEnabled = config.imageSmoothingEnabled ?? true;

  // Line cap style for stroke endings (round for smooth pen/highlighter)
  ctx.lineCap = config.lineCap ?? 'round';

  // Line join style for path corners (round for smooth strokes)
  ctx.lineJoin = config.lineJoin ?? 'round';
}
