/**
 * Connector Tool Constants
 *
 * 1. SNAP_CONFIG - Screen-space snap thresholds (CSS pixels, converted via pxToWorld)
 * 2. ANCHOR_DOT_CONFIG - Overlay styling for snap indicator dots
 * 3. ROUTING_CONFIG - World-space geometry (permanent, stored in Y.Doc)
 *
 * @module lib/connectors/constants
 */

/**
 * Screen-space snap thresholds (in CSS pixels).
 * Converted to world units at runtime via pxToWorld().
 */
export const SNAP_CONFIG = {
  /** Distance to snap to edge - dots appear within this radius */
  EDGE_SNAP_RADIUS_PX: 15,

  /** Distance to snap into midpoint (slightly larger than edge) */
  MIDPOINT_SNAP_IN_PX: 16,

  /** Distance to unstick from midpoint (hysteresis prevents jitter) */
  MIDPOINT_SNAP_OUT_PX: 16,

  /** Depth inside shape before forcing midpoint-only mode (allows edge sliding when shallow inside) */
  FORCE_MIDPOINT_DEPTH_PX: 35,

  /** Anchor dot visual radius */
  DOT_RADIUS_PX: 7,

  /** Connector endpoint handle radius */
  ENDPOINT_RADIUS_PX: 8,

  /** Center snap radius (small — allows free interior placement around center) */
  CENTER_SNAP_RADIUS_PX: 12,
} as const;

/**
 * Anchor dot rendering configuration.
 * Controls the visual appearance of snap indicator dots.
 */
export const ANCHOR_DOT_CONFIG = {
  // Sizing (screen pixels)
  /** Small dot radius - midpoints when not snapped to midpoint */
  SMALL_RADIUS_PX: 5,
  /** Large dot radius - active dot and all midpoints when snapped */
  LARGE_RADIUS_PX: 7,
  /** Stroke width for dot outlines */
  STROKE_WIDTH_PX: 2,

  // Colors
  /** Active dot fill - deeper blue for visibility */
  ACTIVE_FILL: '#1d4ed8',
  /** Active dot stroke - white for contrast */
  ACTIVE_STROKE: '#ffffff',
  /** Inactive dot fill - white background */
  INACTIVE_FILL: '#ffffff',
  /** Inactive dot stroke - standard blue */
  INACTIVE_STROKE: '#1d4ed8',

  // Glow effect for active dot
  /** Shadow blur radius for glow effect */
  GLOW_BLUR_PX: 6,
  /** Glow color with alpha */
  GLOW_COLOR: 'rgba(59, 130, 246, 0.5)',
} as const;

/**
 * Orthogonal routing configuration (WORLD-SPACE, not screen pixels).
 * Routing geometry is permanent (stored in Y.Doc) - must not vary with zoom.
 */
export const ROUTING_CONFIG = {
  /** Corner radius for arcTo rendering */
  CORNER_RADIUS_W: 26,

  /**
   * Arrow sizing: length = max(MIN, strokeWidth * FACTOR), width = length * ASPECT_RATIO.
   * During rendering, length is capped at segmentLength / 2 (Excalidraw approach).
   */
  ARROW_LENGTH_FACTOR: 3,
  ARROW_MIN_LENGTH_W: 6,
  /** Width as proportion of length (1.0 = balanced triangle) */
  ARROW_ASPECT_RATIO: 1.0,
} as const;

/**
 * A* Routing Cost Configuration.
 *
 * These constants control how the A* algorithm evaluates paths.
 * Higher penalties discourage certain path characteristics.
 */
export const COST_CONFIG = {
  /** Penalty for changing direction (creating a bend) */
  BEND_PENALTY: 1000,
} as const;

/**
 * Convert screen-space distance to world units (for sizes, not positions).
 * Use camera-store's screenToWorld for position conversions.
 */
export function pxToWorld(px: number, scale: number): number {
  return px / scale;
}

/** Compute arrow length: max(MIN, strokeWidth * FACTOR). */
export function computeArrowLength(strokeWidth: number): number {
  return Math.max(
    ROUTING_CONFIG.ARROW_MIN_LENGTH_W,
    strokeWidth * ROUTING_CONFIG.ARROW_LENGTH_FACTOR,
  );
}

/** Compute arrow width: length * ASPECT_RATIO (proportional at all sizes). */
export function computeArrowWidth(strokeWidth: number): number {
  return computeArrowLength(strokeWidth) * ROUTING_CONFIG.ARROW_ASPECT_RATIO;
}

/**
 * Approach offset = CORNER_RADIUS + arrowLength + EDGE_CLEARANCE.
 * Used for grid line placement and A* stub positioning.
 */
export function computeApproachOffset(strokeWidth: number): number {
  const arrowLength = computeArrowLength(strokeWidth);
  return ROUTING_CONFIG.CORNER_RADIUS_W + arrowLength + EDGE_CLEARANCE_W;
}

/** Visual clearance between endpoint and shape edge (prevents caps/arrows entering shapes). */
export const EDGE_CLEARANCE_W = 11;
