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
export const RECT_SIDE_EPSILON_FACTOR = 0.035;  // Tolerance = 4% of diagonal
export const RECT_MIN_SIDE_EPSILON = 1.5;      // Minimum tolerance in world units

// Corner tolerances
export const RECT_CORNER_TIE_TOLERANCE_DEG = 25;  // For the ≥2-corners tie-breaker (stricter)
export const RECT_CORNER_TOLERANCE_DEG = 10; // Legacy tolerance (kept for compatibility)

// Soft thresholds for gentle corner/edge scoring
export const RECT_CORNER_SOFT_TOLERANCE_DEG = 25;    // Wider tolerance for soft scoring
export const RECT_PARALLEL_SOFT_TOLERANCE_DEG = 25;  // Soft parallel check
export const RECT_ORTHOGONAL_SOFT_TOLERANCE_DEG = 25; // Soft orthogonal check

// AABB Coverage parameters (mirroring OBB)
export const RECT_AABB_COVERAGE_TOLERANCE_FACTOR = 0.15; // 15% of min(width,height), mirrors OBB
export const RECT_AABB_COVERAGE_MIN_TOL = 1.5;           // keep a floor in WU so tiny boxes don't collapse

// Right-angle corner requirements and penalties
export const RECT_MIN_RIGHT_ANGLES_FOR_VALIDITY = 1;     // Need at least 1 right angle to be valid
export const RECT_NO_RIGHT_ANGLE_MULTIPLIER = 0.5;        // Severe penalty if no right angles
export const RECT_MIN_RIGHT_ANGLES_FOR_CONFIDENCE = 2;   // Need at least 2 to avoid ambiguity
export const RECT_TWO_RIGHT_ANGLES_PENALTY = 0.03;       // Subtract from score if exactly 2 right angles
export const RECT_MAX_RIGHT_ANGLES = 4;                  // More than 4 right angles = ambiguous

// Rectangle AABB Scoring Weights (MUST sum to 1.0)
export const RECT_WEIGHT_SIDEDIST = 0.40;    // Primary: proximity to sides (40%)
export const RECT_WEIGHT_SIDECOV = 0.20;     // Secondary: side coverage (25%)
export const RECT_WEIGHT_CORNERS = 0.40;     // Tertiary: corner quality - soft (15%)
export const RECT_WEIGHT_PARALLEL = 0.00;    // Gentle parallel hint (10%)
export const RECT_WEIGHT_ORTHOGONAL = 0.00;  // Gentle orthogonal hint (10%)
// Total: 0.40 + 0.25 + 0.15 + 0.10 + 0.10 = 1.00 ✓

// Debug - set to false in production
export const SHAPE_DEBUG_SCORES = true;  // Show detailed score breakdown in console

// ============================================================================
// Line Fallback Ambiguity Detection
// ============================================================================

// Self-intersection detection
export const LINE_SELF_INTERSECT_AMBIGUOUS = true;  // If true, self-intersecting strokes won't snap to lines
export const LINE_SELF_INTERSECT_EPSILON_FACTOR = 0.02;  // 2% of diagonal as base tolerance
export const LINE_SELF_INTERSECT_MIN_EPSILON = 1.5;       // Minimum tolerance in world units

// Near-closure detection (start point ≈ end point)
export const LINE_NEAR_CLOSURE_AMBIGUOUS = true;  // If true, nearly-closed loops won't snap to lines
export const LINE_CLOSE_GAP_RATIO = 0.06;  // Same as rectangle micro-closure threshold (6% of diagonal)

// Near self-touch detection (segments come close without crossing)
export const LINE_NEAR_TOUCH_AMBIGUOUS = true;  // If true, strokes that nearly touch themselves won't snap to lines
export const LINE_NEAR_TOUCH_EPSILON_FACTOR = 0.015;  // 1.5% of diagonal as base tolerance
export const LINE_NEAR_TOUCH_MIN_EPSILON = 1.5;  // Minimum tolerance in world units
export const LINE_NEAR_TOUCH_STROKE_SIZE_FACTOR = 0.6;  // Factor of stroke size to add to tolerance