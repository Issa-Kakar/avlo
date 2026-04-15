/**
 * Connector Tool Constants
 *
 * 1. SNAP_CONFIG - Screen-space snap thresholds (CSS pixels)
 * 2. ANCHOR_DOT_CONFIG - Overlay styling for snap indicator dots
 * 3. GUIDE_CONFIG - Dashed guide line styling for straight connectors
 * 4. ROUTING_CONFIG - World-space geometry (permanent, stored in Y.Doc)
 *
 * Screen-space constants are materialized into world units via the bundle
 * getters at the bottom of this file: `getSnapRadiiWorld`,
 * `getAnchorDotMetricsWorld`, `getGuideMetricsWorld`. Call sites read the
 * bundle once per function rather than threading `scale` and dividing per use.
 *
 * @module lib/connectors/constants
 */

import { useCameraStore } from '@/stores/camera-store';

/**
 * Screen-space snap thresholds (in CSS pixels).
 * Materialized into world units via `getSnapRadiiWorld()`.
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

  /** Depth inside shape before straight connectors enter interior anchor mode (allows edge sliding when shallow) */
  STRAIGHT_INTERIOR_DEPTH_PX: 20,
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
 * Dashed guide line styling for straight connectors with interior anchors.
 * Materialized via `getGuideMetricsWorld()`.
 */
export const GUIDE_CONFIG = {
  DASH_LENGTH_PX: 6,
  GAP_LENGTH_PX: 4,
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

// ============================================================================
// World-metric bundle getters
// ----------------------------------------------------------------------------
// Each getter reads camera scale once and returns every relevant PX constant
// pre-divided into world units. Call sites fetch the bundle once per function
// and read fields by name — no parameter threading, no per-use `px / scale`.
// ============================================================================

/** Snap radii & thresholds in world units at current zoom. */
export interface SnapRadiiWorld {
  edgeSnap: number;
  midIn: number;
  midOut: number;
  forceMidpointDepth: number;
  straightInteriorDepth: number;
  centerSnap: number;
}

export function getSnapRadiiWorld(): SnapRadiiWorld {
  const scale = useCameraStore.getState().scale;
  return {
    edgeSnap: SNAP_CONFIG.EDGE_SNAP_RADIUS_PX / scale,
    midIn: SNAP_CONFIG.MIDPOINT_SNAP_IN_PX / scale,
    midOut: SNAP_CONFIG.MIDPOINT_SNAP_OUT_PX / scale,
    forceMidpointDepth: SNAP_CONFIG.FORCE_MIDPOINT_DEPTH_PX / scale,
    straightInteriorDepth: SNAP_CONFIG.STRAIGHT_INTERIOR_DEPTH_PX / scale,
    centerSnap: SNAP_CONFIG.CENTER_SNAP_RADIUS_PX / scale,
  };
}

/** Anchor-dot visual sizes in world units at current zoom. */
export interface AnchorDotMetricsWorld {
  smallRadius: number;
  largeRadius: number;
  strokeWidth: number;
  glowBlur: number;
}

export function getAnchorDotMetricsWorld(): AnchorDotMetricsWorld {
  const scale = useCameraStore.getState().scale;
  return {
    smallRadius: ANCHOR_DOT_CONFIG.SMALL_RADIUS_PX / scale,
    largeRadius: ANCHOR_DOT_CONFIG.LARGE_RADIUS_PX / scale,
    strokeWidth: ANCHOR_DOT_CONFIG.STROKE_WIDTH_PX / scale,
    glowBlur: ANCHOR_DOT_CONFIG.GLOW_BLUR_PX / scale,
  };
}

/** Dashed guide line metrics in world units at current zoom. */
export interface GuideMetricsWorld {
  dashLength: number;
  gapLength: number;
}

export function getGuideMetricsWorld(): GuideMetricsWorld {
  const scale = useCameraStore.getState().scale;
  return {
    dashLength: GUIDE_CONFIG.DASH_LENGTH_PX / scale,
    gapLength: GUIDE_CONFIG.GAP_LENGTH_PX / scale,
  };
}

/** Compute arrow length: max(MIN, strokeWidth * FACTOR). */
export function computeArrowLength(strokeWidth: number): number {
  return Math.max(ROUTING_CONFIG.ARROW_MIN_LENGTH_W, strokeWidth * ROUTING_CONFIG.ARROW_LENGTH_FACTOR);
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
