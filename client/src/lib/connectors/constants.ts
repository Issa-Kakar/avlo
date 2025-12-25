/**
 * Connector Tool Constants
 *
 * Two distinct types of constants:
 *
 * 1. SNAP_CONFIG - Screen-space thresholds (in CSS pixels)
 *    These are converted to world units at runtime via pxToWorld().
 *    Snapping should feel consistent regardless of zoom level.
 *
 * 2. ROUTING_CONFIG - World-space constants (in world units)
 *    These are permanent geometry that gets stored in Y.Doc.
 *    Must NOT change based on zoom level, or connectors drawn at
 *    different zoom levels would have different geometry.
 *
 * DESIGN DECISION: Anchor dots ONLY appear when snapping would occur.
 * No separate "hover preview" zone - if you see dots, you'll connect there.
 * This prevents the confusing UX of seeing dots but not actually snapping.
 *
 * @module lib/connectors/constants
 */

/**
 * Screen-space snap thresholds (in CSS pixels).
 * Converted to world units at runtime via pxToWorld().
 */
export const SNAP_CONFIG = {
  /** Distance to snap to edge - dots appear within this radius */
  EDGE_SNAP_RADIUS_PX: 12,

  /** Distance to snap into midpoint (slightly larger than edge) */
  MIDPOINT_SNAP_IN_PX: 14,

  /** Distance to unstick from midpoint (hysteresis prevents jitter) */
  MIDPOINT_SNAP_OUT_PX: 20,

  /** Depth inside shape before forcing midpoint-only mode */
  INSIDE_DEPTH_PX: 8,

  /** Anchor dot visual radius */
  DOT_RADIUS_PX: 8,

  /** Connector endpoint handle radius */
  ENDPOINT_RADIUS_PX: 8,
} as const;

/**
 * Orthogonal routing configuration.
 *
 * NOTE: These are WORLD-SPACE constants, not screen pixels.
 * Routing geometry is permanent (stored in Y.Doc) and must not
 * change based on zoom level. A connector drawn at any zoom
 * should have identical geometry.
 */
export const ROUTING_CONFIG = {
  /** Jetty length (stub before first turn) in world units */
  JETTY_W: 16,

  /** Corner radius for arcTo rendering in world units */
  CORNER_RADIUS_W: 22,

  /** Dogleg offset when shapes are behind each other in world units */
  DOGLEG_W: 40,

  /**
   * Arrow head sizing - scales with stroke width for visual balance.
   *
   * For filled triangle arrow heads:
   *   arrowLength = max(ARROW_MIN_LENGTH_W, strokeWidth * ARROW_LENGTH_FACTOR)
   *   arrowWidth = max(ARROW_MIN_WIDTH_W, strokeWidth * ARROW_WIDTH_FACTOR)
   *
   * Note: object-cache.ts uses stroked lines (not filled), so lineWidth
   * automatically affects arrow visual thickness. Preview uses filled
   * triangles, so we need explicit scaling.
   */
  ARROW_LENGTH_FACTOR: 4,
  ARROW_WIDTH_FACTOR: 3,
  ARROW_MIN_LENGTH_W: 10,
  ARROW_MIN_WIDTH_W: 8,
} as const;

/**
 * Convert a screen-space DISTANCE to world-space units.
 *
 * This is for converting sizes/distances, NOT positions.
 * - Distances are translation-invariant (pan doesn't matter)
 * - Only scale affects how screen pixels map to world units
 *
 * For position conversions, use camera-store's screenToWorld/worldToCanvas.
 *
 * @param px - Distance in screen pixels
 * @param scale - Current zoom scale
 * @returns Distance in world units
 *
 * @example
 * // "Snap when cursor is within 12 screen pixels of edge"
 * const snapRadius = pxToWorld(12, scale);  // Constant screen feel
 *
 * // "Draw dot that appears as 5 screen pixels"
 * const dotRadius = pxToWorld(5, scale);
 */
export function pxToWorld(px: number, scale: number): number {
  return px / scale;
}
