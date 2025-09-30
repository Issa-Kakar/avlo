/**
 * Shape Recognition Parameters
 * Centralized constants for all shape recognition thresholds and scoring weights.
 * These values have been tuned for aggressive but accurate shape detection.
 */

// Global confidence threshold - shapes must score >= this to be accepted
export const SHAPE_CONFIDENCE_MIN = 0.58;

// ============================================================================
// Circle Recognition Parameters
// ============================================================================

// Circle Hard Gates (immediate rejection if not met)
export const CIRCLE_MIN_COVERAGE = 0.667;   // Minimum angular coverage (≥240° of circle)
export const CIRCLE_MAX_AXIS_RATIO = 1.70;  // Maximum PCA axis ratio sqrt(λ₁/λ₂) for roundness
export const CIRCLE_MAX_RMS_RATIO = 0.25;   // Maximum normalized RMS residual (RMS/radius)

// Circle Scoring Weights (must sum to 1.0)
export const CIRCLE_WEIGHT_COVERAGE = 0.50;  // Dominant factor - how complete the arc is
export const CIRCLE_WEIGHT_FIT = 0.30;       // Quality of fit to ideal circle
export const CIRCLE_WEIGHT_ROUND = 0.20;     // Roundness based on PCA axis ratio

// ============================================================================
// Rectangle Recognition Parameters
// ============================================================================

// Rectangle Hard Gates
export const RECT_MIN_CORNERS = 1;           // Minimum number of right-angle corners required
export const RECT_CORNER_TOLERANCE_DEG = 30; // Tolerance for corner angle from 90° (±20°)

// Rectangle Soft Thresholds (for scoring, not hard rejection)
export const RECT_PARALLEL_TOLERANCE_DEG = 35;   // Tolerance for opposite edges being parallel
export const RECT_ORTHOGONAL_TOLERANCE_DEG = 35; // Tolerance for adjacent edges being perpendicular

// Rectangle Scoring Weights (must sum to 1.0)
export const RECT_WEIGHT_CORNERS = 0.40;     // Quality of right-angle corners
export const RECT_WEIGHT_PARALLEL = 0.25;    // How parallel opposite edges are
export const RECT_WEIGHT_ORTHOGONAL = 0.20;  // How perpendicular adjacent edges are
export const RECT_WEIGHT_COVERAGE = 0.15;    // Distribution across all four sides