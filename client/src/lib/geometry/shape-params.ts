/**
 * Shape Recognition Parameters
 * Centralized constants for all shape recognition thresholds and scoring weights.
 * These values have been tuned for aggressive but accurate shape detection.
 */

// Global confidence threshold - shapes must score >= this to be accepted
export const SHAPE_CONFIDENCE_MIN = 0.58;

// NEW: Near-miss detection - prevents snap when shape was "close but not quite"
export const SHAPE_AMBIGUITY_DELTA = 0.1; // No snap if any shape score is within 0.10 of confidence threshold

// ============================================================================
// Circle Recognition Parameters (UNCHANGED)
// ============================================================================

// Circle Hard Gates (immediate rejection if not met)
export const CIRCLE_MIN_COVERAGE = 0.667;   // Minimum angular coverage (≥240° of circle)
export const CIRCLE_MAX_AXIS_RATIO = 1.70;  // Maximum PCA axis ratio sqrt(λ₁/λ₂) for roundness
export const CIRCLE_MAX_RMS_RATIO = 0.24;   // Maximum normalized RMS residual (RMS/radius)

// Circle Scoring Weights (must sum to 1.0)
export const CIRCLE_WEIGHT_COVERAGE = 0.50;  // Dominant factor - how complete the arc is
export const CIRCLE_WEIGHT_FIT = 0.30;       // Quality of fit to ideal circle
export const CIRCLE_WEIGHT_ROUND = 0.20;     // Roundness based on PCA axis ratio

// ============================================================================
// Rectangle AABB Recognition Parameters (ALL SOFT - NO HARD GATES)
// ============================================================================

// Rectangle AABB parameters
export const RECT_SIDE_EPSILON_FACTOR = 0.04;  // Tolerance = 4% of diagonal
export const RECT_MIN_SIDE_EPSILON = 1.5;      // Minimum tolerance in world units

// Corner tolerances
export const RECT_CORNER_TIE_TOLERANCE_DEG = 25;  // For the ≥2-corners tie-breaker (stricter)
export const RECT_CORNER_TOLERANCE_DEG = 25; // Legacy tolerance (kept for compatibility)

// Soft thresholds for gentle corner/edge scoring
export const RECT_CORNER_SOFT_TOLERANCE_DEG = 25;    // Wider tolerance for soft scoring
export const RECT_PARALLEL_SOFT_TOLERANCE_DEG = 25;  // Soft parallel check
export const RECT_ORTHOGONAL_SOFT_TOLERANCE_DEG = 25; // Soft orthogonal check

// Rectangle AABB Scoring Weights (MUST sum to 1.0)
export const RECT_WEIGHT_SIDEDIST = 0.40;    // Primary: proximity to sides (40%)
export const RECT_WEIGHT_SIDECOV = 0.25;     // Secondary: side coverage (25%)
export const RECT_WEIGHT_CORNERS = 0.15;     // Tertiary: corner quality - soft (15%)
export const RECT_WEIGHT_PARALLEL = 0.10;    // Gentle parallel hint (10%)
export const RECT_WEIGHT_ORTHOGONAL = 0.10;  // Gentle orthogonal hint (10%)
// Total: 0.40 + 0.25 + 0.15 + 0.10 + 0.10 = 1.00 ✓

// Debug - set to false in production
export const SHAPE_DEBUG_SCORES = true;  // Show detailed score breakdown in console