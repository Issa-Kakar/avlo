/**
 * $P Point-Cloud Shape Recognizer
 *
 * Based on:
 * - Vatavu, R-D., Anthony, L., & Wobbrock, J.O. (2012). "Gestures as Point Clouds"
 *
 * Optimized for hold-detected perfect shapes:
 * - Circle, Rectangle (AABB), Diamond
 * - Single-stroke gestures only
 * - Aspect-ratio aware templates generated dynamically
 * - Open-path variants for rough/incomplete strokes
 *
 * Enhanced with hybrid validation gates:
 * - Self-intersection and near-touch detection (legacy, on raw points)
 * - Turn count validation (on normalized points)
 * - Quadrant occupation (on normalized points)
 */

import { hasSelfIntersection, hasNearTouch } from './geometry-helpers';

// =============================================================================
// TYPES
// =============================================================================

export type Point2 = readonly [number, number];

export type PerfectShapeKind = 'circle' | 'box' | 'diamond' | 'line';

export interface PerfectShapeMatch {
  kind: PerfectShapeKind;
  templateId: string;
  distance: number; // lower is better
}

export interface PerfectShapeRecognition {
  best: PerfectShapeMatch;
  secondBest: PerfectShapeMatch | null;
  ambiguous: boolean;
  margin: number; // 0..1, higher = more separation between best and second
  all: PerfectShapeMatch[]; // sorted ascending by distance
}

export interface RecognizerOpts {
  n?: number; // resample count (default 32)
  epsilon?: number; // greedy step exponent (default 0.5)
  minMargin?: number; // separation gate (default 0.10)
  closeEpsRatio?: number; // if end-start <= ratio*diag, close path (default 0.12)
  // Note: maxDistance is now shape-specific in PDOLLAR_CONFIG
}

// Internal point type with stroke ID
interface Pt {
  x: number;
  y: number;
  strokeId: number;
}

interface Template {
  id: string;
  kind: PerfectShapeKind;
  points: Point2[]; // normalized, length = n
}

// =============================================================================
// CONFIGURATION
// =============================================================================

export const PDOLLAR_CONFIG = {
  NUM_POINTS: 32,
  MIN_MARGIN: 0.1,
  CLOSE_EPS_RATIO: 0.12,
  EPSILON: 0.5,
  MIN_INPUT_POINTS: 6,
  // Shape-specific distance thresholds (lower = stricter)
  MAX_DISTANCE_BOX: 3.5,
  MAX_DISTANCE_DIAMOND: 4.5,
  MAX_DISTANCE_CIRCLE: 6, // Keep circle lenient (already hard to trigger)
  MAX_DISTANCE_LINE: 3.0, // Strict — lines are simple shapes
  // Hybrid validation gates (for box/diamond only)
  MIN_TURN_ANGLE_DEG: 40, // Minimum angle change to count as a "turn"
  MIN_TURNS_BOX: 3, // Require at least 3 turns for box
  MIN_TURNS_BOX_RELAXED: 0, // If distance < 2, skip turn check entirely for box
  MIN_TURNS_BOX_RELAXED_THRESHOLD: 2, // Distance threshold to skip turn check for box
  MIN_TURNS_DIAMOND: 2, // Require at least 2 turns for diamond (resampling messes up angles)
  MIN_TURNS_DIAMOND_RELAXED_THRESHOLD: 3, // If distance < 3, allow 2 turns for diamond
  MAX_TURNS: 8, // Reject if > 8 turns (too messy)
  MIN_QUADRANT_OCCUPATION: 0.75, // Require points in at least 3/4 quadrants
  // Self-intersection and near-touch detection (raw points)
  SELF_INTERSECT_EPS_FACTOR: 0.02, // 2% of diagonal
  NEAR_TOUCH_EPS_FACTOR: 0.015, // 1.5% of diagonal
  MIN_EPS_WU: 1.5, // Minimum epsilon in world units
};

/**
 * Fixed aspect ratios for template generation.
 * Log-spaced for perceptual uniformity (~25% visual difference per step).
 *
 * The key insight: by using FIXED ratios, we force the recognizer to
 * discriminate based on actual shape geometry, not just whether the
 * input "looks like itself".
 */
const TEMPLATE_RATIOS = {
  /**
   * Box ratios: wide range from square to very elongated.
   * Includes reciprocals for tall rectangles.
   * Log-spacing: each step is ~1.25x the previous.
   */
  box: [
    // Wide (width > height)
    1.0, 1.25, 1.6, 2.0, 2.5, 3.2, 4.0, 5.0, 6.3, 8.0, 10.0, 12.5,
    // Tall (height > width) - reciprocals, excluding 1.0
    0.8, 0.625, 0.5, 0.4, 0.3125, 0.25, 0.2, 0.159, 0.125, 0.1, 0.08,
  ],

  /**
   * Diamond ratios: capped at 3:1 to avoid line-like degeneracy.
   * Beyond 3:1, diamond vertices collapse visually.
   */
  diamond: [
    // Wide
    1.0, 1.25, 1.6, 2.0, 2.5, 3.0,
    // Tall - reciprocals, excluding 1.0
    0.8, 0.625, 0.5, 0.4, 0.333,
  ],

  /**
   * Circle: only 1:1 aspect ratio makes geometric sense.
   */
  circle: [1.0],

  /**
   * Line: covers horizontal, vertical, and diagonal angles.
   */
  line: [25.0, 2.0, 1.0, 0.5, 0.04],
} as const;

// =============================================================================
// MATH UTILITIES
// =============================================================================

function sqr(x: number): number {
  return x * x;
}

function sqrDist(a: Point2, b: Point2): number {
  return sqr(a[0] - b[0]) + sqr(a[1] - b[1]);
}

function dist(a: Point2, b: Point2): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

function bboxOf(points: Point2[]): {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
} {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const [x, y] of points) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
}

// =============================================================================
// HYBRID VALIDATION GATES
// =============================================================================

/**
 * Count significant turns in a point sequence.
 * Works on normalized 32-point array (angles preserved after normalization).
 *
 * A "turn" is a direction change > minTurnDeg between consecutive segments.
 *
 * Expected turn counts:
 * - Box/Diamond: 3-4 turns (corners)
 * - Circle: 0-2 turns (smooth curve)
 * - Scribble: Many turns or very few (if wiggly or linear)
 */
function countSignificantTurns(points: Point2[], minTurnDeg: number): number {
  const n = points.length;
  if (n < 3) return 0;

  let turnCount = 0;
  const minTurnRad = (minTurnDeg * Math.PI) / 180;

  for (let i = 1; i < n - 1; i++) {
    const [x0, y0] = points[i - 1];
    const [x1, y1] = points[i];
    const [x2, y2] = points[i + 1];

    const angle1 = Math.atan2(y1 - y0, x1 - x0);
    const angle2 = Math.atan2(y2 - y1, x2 - x1);

    let turn = angle2 - angle1;
    // Normalize to [-π, π]
    while (turn > Math.PI) turn -= 2 * Math.PI;
    while (turn < -Math.PI) turn += 2 * Math.PI;

    if (Math.abs(turn) > minTurnRad) {
      turnCount++;
    }
  }

  return turnCount;
}

/**
 * Check how many quadrants (relative to centroid) contain points.
 * Works on normalized points where centroid is at origin.
 *
 * Returns a score 0-1:
 * - 1.0 = all 4 quadrants have points (good coverage)
 * - 0.75 = 3 quadrants (acceptable for open variants)
 * - 0.5 = 2 quadrants (likely incomplete/sparse)
 * - 0.25 = 1 quadrant (definitely not a closed shape)
 */
function quadrantOccupation(points: Point2[]): number {
  // After normalization, centroid is at origin
  const quadrants = [false, false, false, false]; // NE, NW, SE, SW

  for (const [x, y] of points) {
    // Quadrant index: 0=NE (x>=0, y>=0), 1=NW (x<0, y>=0), 2=SE (x>=0, y<0), 3=SW (x<0, y<0)
    const qIdx = (x < 0 ? 1 : 0) + (y < 0 ? 2 : 0);
    quadrants[qIdx] = true;
  }

  const occupied = quadrants.filter((q) => q).length;
  return occupied / 4;
}

// =============================================================================
// NORMALIZATION PIPELINE
// =============================================================================

function toPts(points: Point2[], strokeId = 1): Pt[] {
  return points.map(([x, y]) => ({ x, y, strokeId }));
}

function pathLength(points: Pt[]): number {
  let d = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    if (a.strokeId !== b.strokeId) continue;
    d += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return d;
}

/**
 * Resample to n evenly-spaced points along the path.
 * Matches $P paper's resample algorithm.
 */
function resample(pointsIn: Pt[], n: number): Pt[] {
  const points = pointsIn.map((p) => ({ ...p })); // local copy

  if (points.length === 0) return [];
  if (points.length === 1) return Array.from({ length: n }, () => ({ ...points[0] }));

  const I = pathLength(points) / Math.max(1, n - 1);
  if (!Number.isFinite(I) || I <= 1e-9) {
    return Array.from({ length: n }, () => ({ ...points[0] }));
  }

  let D = 0;
  const newPoints: Pt[] = [{ ...points[0] }];

  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const curr = points[i];

    if (prev.strokeId !== curr.strokeId) continue;

    const d = Math.hypot(curr.x - prev.x, curr.y - prev.y);
    if (d <= 1e-12) continue;

    if (D + d >= I) {
      const t = (I - D) / d;
      const q: Pt = {
        x: prev.x + t * (curr.x - prev.x),
        y: prev.y + t * (curr.y - prev.y),
        strokeId: curr.strokeId,
      };
      newPoints.push(q);
      points.splice(i, 0, q); // q becomes the next "curr"
      D = 0;
    } else {
      D += d;
    }
  }

  // Pad if rounding leaves us short
  while (newPoints.length < n) newPoints.push({ ...points[points.length - 1] });
  return newPoints.slice(0, n);
}

/**
 * Scale to fit unit square preserving aspect ratio.
 * Uses max(width, height) as the scale factor.
 */
function scaleToUnit(points: Pt[]): void {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;

  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }

  const w = maxX - minX;
  const h = maxY - minY;
  const scale = Math.max(w, h);

  if (!Number.isFinite(scale) || scale <= 1e-12) {
    for (const p of points) {
      p.x = 0;
      p.y = 0;
    }
    return;
  }

  for (const p of points) {
    p.x = (p.x - minX) / scale;
    p.y = (p.y - minY) / scale;
  }
}

/**
 * Translate so centroid is at origin.
 */
function translateToOrigin(points: Pt[]): void {
  let cx = 0,
    cy = 0;
  const n = points.length;
  for (const p of points) {
    cx += p.x;
    cy += p.y;
  }
  cx /= n;
  cy /= n;

  for (const p of points) {
    p.x -= cx;
    p.y -= cy;
  }
}

/**
 * Full normalization: resample → scale → translate to origin.
 */
function normalize(points: Point2[], n: number): Point2[] {
  const pts = resample(toPts(points), n);
  scaleToUnit(pts);
  translateToOrigin(pts);
  return pts.map((p) => [p.x, p.y] as const);
}

// =============================================================================
// $P MATCHING WITH $Q OPTIMIZATIONS
// =============================================================================

/**
 * Cloud distance with $Q optimizations:
 * - Squared distances (no sqrt)
 * - O(1) removal from unmatched list
 * - Early abandoning
 */
function cloudDistanceQ(
  points: Point2[],
  template: Point2[],
  start: number,
  minSoFar: number,
): number {
  const n = points.length;
  const unmatched: number[] = Array.from({ length: n }, (_, i) => i);

  let i = start;
  let weight = n;
  let sum = 0;

  do {
    let bestU = 0;
    let bestD = Infinity;

    for (let u = 0; u < unmatched.length; u++) {
      const j = unmatched[u];
      const d = sqrDist(points[i], template[j]);
      if (d < bestD) {
        bestD = d;
        bestU = u;
      }
    }

    // Remove unmatched[bestU] in O(1) by swapping with last
    unmatched[bestU] = unmatched[unmatched.length - 1];
    unmatched.pop();

    sum += weight * bestD;

    if (sum >= minSoFar) return sum; // early abandon

    weight -= 1;
    i = (i + 1) % n;
  } while (i !== start);

  return sum;
}

/**
 * Greedy cloud match: try multiple starting points and both directions.
 */
function greedyCloudMatchQ(
  points: Point2[],
  template: Point2[],
  n: number,
  epsilon: number,
): number {
  const step = Math.max(1, Math.floor(Math.pow(n, 1 - epsilon)));
  let min = Infinity;

  for (let i = 0; i < n; i += step) {
    min = Math.min(min, cloudDistanceQ(points, template, i, min));
    min = Math.min(min, cloudDistanceQ(template, points, i, min));
  }
  return min;
}

// =============================================================================
// TEMPLATE GENERATION (PROCEDURAL)
// =============================================================================

/**
 * Generate a circle polyline (closed).
 */
function circlePolyline(segments = 64): Point2[] {
  const pts: Point2[] = [];
  for (let i = 0; i < segments; i++) {
    const a = (2 * Math.PI * i) / segments;
    pts.push([Math.cos(a), Math.sin(a)]);
  }
  pts.push(pts[0]); // close
  return pts;
}

/**
 * Rectangle vertices for given width/height (centered at origin).
 */
function rectVertices(w: number, h: number): Point2[] {
  const hw = w / 2;
  const hh = h / 2;
  // TL, TR, BR, BL
  return [
    [-hw, -hh],
    [hw, -hh],
    [hw, hh],
    [-hw, hh],
  ];
}

/**
 * Diamond vertices for given width/height (centered at origin).
 */
function diamondVertices(w: number, h: number): Point2[] {
  const hw = w / 2;
  const hh = h / 2;
  // top, right, bottom, left
  return [
    [0, -hh],
    [hw, 0],
    [0, hh],
    [-hw, 0],
  ];
}

/**
 * Create polyline from cycle vertices.
 * edges = 4 → closed; edges = 3 → open (missing the closing edge)
 */
function polylineFromCycle(vertices: Point2[], startIndex: number, edges: 3 | 4): Point2[] {
  const pts: Point2[] = [];
  const m = vertices.length;
  const s = ((startIndex % m) + m) % m;
  pts.push(vertices[s]);
  for (let k = 1; k <= edges; k++) {
    pts.push(vertices[(s + k) % m]);
  }
  return pts;
}

/**
 * Convert aspect ratio to width/height in unit space.
 */
function aspectToWH(aspect: number): { w: number; h: number } {
  const a = Math.max(1e-6, aspect);
  if (a >= 1) return { w: 1, h: 1 / a };
  return { w: a, h: 1 };
}

/**
 * Build ALL templates at module load time using FIXED aspect ratios.
 *
 * This is the key fix: instead of generating templates dynamically with
 * the candidate's aspect ratio (which defeats $P's discriminative power),
 * we pre-generate templates at fixed ratios. The candidate's shape will
 * naturally match best against templates with similar geometry AND ratio.
 *
 * Template count: 23 box + 11 diamond + 1 circle + 2 line = 37 templates
 * (CLOSED variants only - no open templates)
 */
function buildAllTemplates(n: number): Template[] {
  const templates: Template[] = [];

  // Circle: 1 template (aspect 1:1)
  templates.push({
    id: 'circle/closed@1.00',
    kind: 'circle',
    points: normalize(circlePolyline(64), n),
  });

  // Boxes: 23 ratios × 1 variant (CLOSED ONLY) = 23 templates
  for (const ratio of TEMPLATE_RATIOS.box) {
    const { w, h } = aspectToWH(ratio);
    const ratioStr = ratio.toFixed(2);
    const verts = rectVertices(w, h);

    // Closed variant only - no open templates
    templates.push({
      id: `box/closed@${ratioStr}`,
      kind: 'box',
      points: normalize(polylineFromCycle(verts, 0, 4), n),
    });
  }

  // Diamonds: 11 ratios × 1 variant (CLOSED ONLY) = 11 templates
  for (const ratio of TEMPLATE_RATIOS.diamond) {
    const { w, h } = aspectToWH(ratio);
    const ratioStr = ratio.toFixed(2);
    const verts = diamondVertices(w, h);

    // Closed variant only - no open templates
    templates.push({
      id: `diamond/closed@${ratioStr}`,
      kind: 'diamond',
      points: normalize(polylineFromCycle(verts, 0, 4), n),
    });
  }

  // Lines: 5 templates covering H/V/diagonal angles
  for (const ratio of TEMPLATE_RATIOS.line) {
    const { w, h } = aspectToWH(ratio);
    // Simple 2-point line (horizontal or vertical depending on ratio)
    const pts: Point2[] =
      ratio > 1
        ? [
            [-w / 2, 0],
            [w / 2, 0],
          ]
        : [
            [0, -h / 2],
            [0, h / 2],
          ];
    templates.push({
      id: `line/straight@${ratio.toFixed(2)}`,
      kind: 'line',
      points: normalize(pts, n),
    });
  }

  return templates;
}

// =============================================================================
// CACHED TEMPLATE LIBRARY (lazy, built on first use)
// =============================================================================

let _templates: Template[] | null = null;
function getTemplates(): Template[] {
  if (!_templates) _templates = buildAllTemplates(PDOLLAR_CONFIG.NUM_POINTS);
  return _templates;
}

// =============================================================================
// PUBLIC API
// =============================================================================

/**
 * Recognize a perfect shape from raw stroke points.
 *
 * @param rawPointsWU - Raw stroke points in world units [[x,y], ...]
 * @param opts - Recognition options (thresholds, etc.)
 * @returns Recognition result or null if not enough points
 */
export function recognizePerfectShapePointCloud(
  rawPointsWU: Point2[],
  opts: RecognizerOpts = {},
): PerfectShapeRecognition | null {
  const n = opts.n ?? PDOLLAR_CONFIG.NUM_POINTS;
  const epsilon = opts.epsilon ?? PDOLLAR_CONFIG.EPSILON;
  const minMargin = opts.minMargin ?? PDOLLAR_CONFIG.MIN_MARGIN;
  const closeEpsRatio = opts.closeEpsRatio ?? PDOLLAR_CONFIG.CLOSE_EPS_RATIO;

  if (rawPointsWU.length < PDOLLAR_CONFIG.MIN_INPUT_POINTS) return null;

  // Compute bounding box and diagonal
  const bb = bboxOf(rawPointsWU);
  const w = bb.maxX - bb.minX;
  const h = bb.maxY - bb.minY;
  const diag = Math.hypot(w, h);
  if (!Number.isFinite(diag) || diag <= 1e-6) return null;

  // =========================================================================
  // GATE 1 & 2: Self-intersection and near-touch (RAW points, before normalization)
  // These checks reject scribbles that cross or nearly touch themselves
  // =========================================================================
  const flatPoints = rawPointsWU.flatMap(([x, y]) => [x, y]);
  const selfIntersectEps = Math.max(
    PDOLLAR_CONFIG.MIN_EPS_WU,
    PDOLLAR_CONFIG.SELF_INTERSECT_EPS_FACTOR * diag,
  );
  const nearTouchEps = Math.max(
    PDOLLAR_CONFIG.MIN_EPS_WU,
    PDOLLAR_CONFIG.NEAR_TOUCH_EPS_FACTOR * diag,
  );

  // Check for self-intersection (stroke crosses itself)
  if (hasSelfIntersection(flatPoints, selfIntersectEps)) {
    // Return a "failed" result with ambiguous=true so freehand continues
    return {
      best: { kind: 'line', templateId: 'gate/self-intersect', distance: Infinity },
      secondBest: null,
      ambiguous: true,
      margin: 0,
      all: [],
    };
  }

  // Check for near self-touch (segments come close without crossing)
  if (hasNearTouch(flatPoints, nearTouchEps)) {
    return {
      best: { kind: 'line', templateId: 'gate/near-touch', distance: Infinity },
      secondBest: null,
      ambiguous: true,
      margin: 0,
      all: [],
    };
  }

  // Optional: close path if nearly closed
  const first = rawPointsWU[0];
  const last = rawPointsWU[rawPointsWU.length - 1];
  const gap = dist(first, last);

  const pointsForMatch =
    gap <= closeEpsRatio * diag ? [...rawPointsWU, first] : rawPointsWU.slice();

  // Normalize candidate (aspect ratio is PRESERVED, not matched to templates)
  const candidate = normalize(pointsForMatch, n);

  // Match against ALL fixed templates (not dynamic!)
  // This is the key difference: we use pre-built templates with fixed aspect ratios
  const all: PerfectShapeMatch[] = [];

  for (const t of getTemplates()) {
    const d = greedyCloudMatchQ(candidate, t.points, n, epsilon);
    all.push({ kind: t.kind, templateId: t.id, distance: d });
  }

  // Sort by distance (lower = better)
  all.sort((a, b) => a.distance - b.distance);

  const best = all[0];

  // Find best match of a DIFFERENT shape type (for margin calculation)
  // Margin should compare circle vs box, not box@1.0 vs box@1.25
  const bestOfDifferentKind = all.find((m) => m.kind !== best.kind) ?? null;

  // Compute margin against best match of a DIFFERENT shape type
  // This prevents box@1.0 vs box@1.25 from triggering ambiguity
  const margin =
    bestOfDifferentKind && bestOfDifferentKind.distance > 1e-9
      ? (bestOfDifferentKind.distance - best.distance) / bestOfDifferentKind.distance
      : 1;

  // =========================================================================
  // Shape-specific distance thresholds
  // =========================================================================
  let shapeMaxDistance: number;
  if (best.kind === 'line') {
    shapeMaxDistance = PDOLLAR_CONFIG.MAX_DISTANCE_LINE;
  } else if (best.kind === 'box') {
    shapeMaxDistance = PDOLLAR_CONFIG.MAX_DISTANCE_BOX;
  } else if (best.kind === 'diamond') {
    shapeMaxDistance = PDOLLAR_CONFIG.MAX_DISTANCE_DIAMOND;
  } else {
    shapeMaxDistance = PDOLLAR_CONFIG.MAX_DISTANCE_CIRCLE;
  }

  let ambiguous = best.distance > shapeMaxDistance || margin < minMargin;

  // =========================================================================
  // GATE 3 & 4: Turn count and quadrant occupation (NORMALIZED points)
  // These checks validate that the shape has proper structure
  // Only applied to box/diamond (not circles, per user request)
  // =========================================================================
  if ((best.kind === 'box' || best.kind === 'diamond') && !ambiguous) {
    const turnCount = countSignificantTurns(candidate, PDOLLAR_CONFIG.MIN_TURN_ANGLE_DEG);
    const quadrantScore = quadrantOccupation(candidate);

    // Gate 3: Turn count validation (shape-specific)
    if (best.kind === 'box') {
      // Box: if distance < 2 (very good match), skip turn check entirely
      // Otherwise require at least 3 turns
      if (best.distance >= PDOLLAR_CONFIG.MIN_TURNS_BOX_RELAXED_THRESHOLD) {
        if (turnCount < PDOLLAR_CONFIG.MIN_TURNS_BOX) {
          ambiguous = true;
        }
      }
      // If distance < 2, we skip the turn check (box wins regardless of turn count)
    } else if (best.kind === 'diamond') {
      // Diamond: if distance < 3 (very good match), allow 2 turns
      // Otherwise require the standard minimum
      const minTurnsForDiamond =
        best.distance < PDOLLAR_CONFIG.MIN_TURNS_DIAMOND_RELAXED_THRESHOLD
          ? PDOLLAR_CONFIG.MIN_TURNS_DIAMOND
          : PDOLLAR_CONFIG.MIN_TURNS_BOX; // Fall back to stricter if poor match

      if (turnCount < minTurnsForDiamond) {
        ambiguous = true;
      }
    }

    // Too many turns = too messy (scribble)
    if (turnCount > PDOLLAR_CONFIG.MAX_TURNS) {
      ambiguous = true;
    }

    // Gate 4: Quadrant occupation
    // Points should be distributed across at least 3/4 quadrants
    // This catches U-shapes, partial shapes, sparse strokes
    if (quadrantScore < PDOLLAR_CONFIG.MIN_QUADRANT_OCCUPATION) {
      ambiguous = true;
    }
  }

  return { best, secondBest: bestOfDifferentKind, ambiguous, margin, all };
}

// =============================================================================
// ANCHOR COMPUTATION HELPERS
// =============================================================================

/**
 * Compute bounding box center and half-extents from points.
 */
export function computeBboxCenterExtents(points: Point2[]): {
  cx: number;
  cy: number;
  hx: number;
  hy: number;
} {
  const bb = bboxOf(points);
  return {
    cx: (bb.minX + bb.maxX) / 2,
    cy: (bb.minY + bb.maxY) / 2,
    hx: Math.max(1, (bb.maxX - bb.minX) / 2),
    hy: Math.max(1, (bb.maxY - bb.minY) / 2),
  };
}

// =============================================================================
// DEBUG UTILITIES
// =============================================================================

/**
 * Debug recognition with detailed logging.
 * Call this to see which templates match and their scores.
 */
/* eslint-disable no-console */
export function debugRecognize(rawPointsWU: Point2[], opts: RecognizerOpts = {}): void {
  console.group('🔍 $P Recognition Debug (with Hybrid Gates)');

  const minMargin = opts.minMargin ?? PDOLLAR_CONFIG.MIN_MARGIN;
  const n = opts.n ?? PDOLLAR_CONFIG.NUM_POINTS;
  const closeEpsRatio = opts.closeEpsRatio ?? PDOLLAR_CONFIG.CLOSE_EPS_RATIO;

  // Input stats
  const bb = bboxOf(rawPointsWU);
  const w = bb.maxX - bb.minX;
  const h = bb.maxY - bb.minY;
  const diag = Math.hypot(w, h);
  const aspect = w / Math.max(1e-6, h);
  console.log(
    `Input: ${rawPointsWU.length} points, aspect: ${aspect.toFixed(2)}, diag: ${diag.toFixed(1)}`,
  );
  console.log(`Templates: ${getTemplates().length} (closed only)`);
  console.log(
    `Shape thresholds: box<${PDOLLAR_CONFIG.MAX_DISTANCE_BOX}, diamond<${PDOLLAR_CONFIG.MAX_DISTANCE_DIAMOND}, circle<${PDOLLAR_CONFIG.MAX_DISTANCE_CIRCLE}`,
  );

  // === PRE-NORMALIZATION GATES ===
  console.group('🚧 Pre-Normalization Gates (RAW points)');

  const flatPoints = rawPointsWU.flatMap(([x, y]) => [x, y]);
  const selfIntersectEps = Math.max(
    PDOLLAR_CONFIG.MIN_EPS_WU,
    PDOLLAR_CONFIG.SELF_INTERSECT_EPS_FACTOR * diag,
  );
  const nearTouchEps = Math.max(
    PDOLLAR_CONFIG.MIN_EPS_WU,
    PDOLLAR_CONFIG.NEAR_TOUCH_EPS_FACTOR * diag,
  );

  const hasSelfInt = hasSelfIntersection(flatPoints, selfIntersectEps);
  const hasNearTch = hasNearTouch(flatPoints, nearTouchEps);

  console.log(
    `Gate 1 - Self-intersection (eps=${selfIntersectEps.toFixed(1)}): ${hasSelfInt ? '❌ BLOCKED' : '✅ PASS'}`,
  );
  console.log(
    `Gate 2 - Near-touch (eps=${nearTouchEps.toFixed(1)}): ${hasNearTch ? '❌ BLOCKED' : '✅ PASS'}`,
  );
  console.groupEnd();

  // Run recognition
  const result = recognizePerfectShapePointCloud(rawPointsWU, opts);

  if (!result) {
    console.log('❌ Not enough points or degenerate input');
    console.groupEnd();
    return;
  }

  // Check if blocked by pre-normalization gates
  if (result.best.templateId.startsWith('gate/')) {
    console.log(`❌ Blocked by ${result.best.templateId} - continuing freehand`);
    console.groupEnd();
    return;
  }

  // Log top 10 template scores (too many to show all)
  console.log('Template scores (top 10, lower distance = better):');
  const top10 = result.all.slice(0, 10);
  for (const match of top10) {
    const marker =
      match === result.best ? '✅ BEST' : match === result.secondBest ? '🥈 2nd ' : '     ';
    console.log(`  ${marker} ${match.templateId}: ${match.distance.toFixed(3)}`);
  }

  // === POST-NORMALIZATION GATES (for box/diamond) ===
  if (result.best.kind === 'box' || result.best.kind === 'diamond') {
    console.group('🚧 Post-Normalization Gates (NORMALIZED points)');

    // Normalize for gate analysis
    const first = rawPointsWU[0];
    const last = rawPointsWU[rawPointsWU.length - 1];
    const gap = dist(first, last);
    const pointsForMatch =
      gap <= closeEpsRatio * diag ? [...rawPointsWU, first] : rawPointsWU.slice();
    const candidate = normalize(pointsForMatch, n);

    const turnCount = countSignificantTurns(candidate, PDOLLAR_CONFIG.MIN_TURN_ANGLE_DEG);
    const quadrantScore = quadrantOccupation(candidate);

    // Shape-specific turn requirements
    let minTurns: number;
    let turnSkipped = false;
    if (result.best.kind === 'box') {
      // Box: skip turn check if distance < 2
      if (result.best.distance < PDOLLAR_CONFIG.MIN_TURNS_BOX_RELAXED_THRESHOLD) {
        minTurns = 0;
        turnSkipped = true;
      } else {
        minTurns = PDOLLAR_CONFIG.MIN_TURNS_BOX;
      }
    } else {
      // Diamond: relaxed if distance < 3
      minTurns =
        result.best.distance < PDOLLAR_CONFIG.MIN_TURNS_DIAMOND_RELAXED_THRESHOLD
          ? PDOLLAR_CONFIG.MIN_TURNS_DIAMOND
          : PDOLLAR_CONFIG.MIN_TURNS_BOX;
    }

    const turnPass =
      turnSkipped || (turnCount >= minTurns && turnCount <= PDOLLAR_CONFIG.MAX_TURNS);
    const quadrantPass = quadrantScore >= PDOLLAR_CONFIG.MIN_QUADRANT_OCCUPATION;

    if (turnSkipped) {
      console.log(
        `Gate 3 - Turn count: ${turnCount} (SKIPPED - distance ${result.best.distance.toFixed(2)} < ${PDOLLAR_CONFIG.MIN_TURNS_BOX_RELAXED_THRESHOLD} for box): ✅ PASS`,
      );
    } else {
      console.log(
        `Gate 3 - Turn count: ${turnCount} (need ${minTurns}-${PDOLLAR_CONFIG.MAX_TURNS} for ${result.best.kind}): ${turnPass ? '✅ PASS' : '❌ BLOCKED'}`,
      );
    }
    console.log(
      `Gate 4 - Quadrant occupation: ${(quadrantScore * 100).toFixed(0)}% (need ${(PDOLLAR_CONFIG.MIN_QUADRANT_OCCUPATION * 100).toFixed(0)}%): ${quadrantPass ? '✅ PASS' : '❌ BLOCKED'}`,
    );
    console.groupEnd();
  }

  // Decision summary
  console.log('---');
  console.log(`Best: ${result.best.templateId} (${result.best.distance.toFixed(3)})`);
  if (result.secondBest) {
    console.log(
      `Second: ${result.secondBest.templateId} (${result.secondBest.distance.toFixed(3)})`,
    );
  }
  console.log(`Margin: ${(result.margin * 100).toFixed(1)}%`);
  console.log(`Ambiguous: ${result.ambiguous}`);

  if (result.ambiguous) {
    const reasons: string[] = [];
    if (result.best.kind === 'line') {
      reasons.push('line detected (degenerate input)');
    }
    // Shape-specific distance check
    let shapeMaxDist: number;
    if (result.best.kind === 'box') {
      shapeMaxDist = PDOLLAR_CONFIG.MAX_DISTANCE_BOX;
    } else if (result.best.kind === 'diamond') {
      shapeMaxDist = PDOLLAR_CONFIG.MAX_DISTANCE_DIAMOND;
    } else {
      shapeMaxDist = PDOLLAR_CONFIG.MAX_DISTANCE_CIRCLE;
    }
    if (result.best.distance > shapeMaxDist) {
      reasons.push(
        `distance ${result.best.distance.toFixed(2)} > max ${shapeMaxDist} for ${result.best.kind}`,
      );
    }
    if (result.margin < minMargin) {
      reasons.push(
        `margin ${(result.margin * 100).toFixed(1)}% < min ${(minMargin * 100).toFixed(1)}%`,
      );
    }
    // Check gate failures
    if (result.best.kind === 'box' || result.best.kind === 'diamond') {
      const first = rawPointsWU[0];
      const last = rawPointsWU[rawPointsWU.length - 1];
      const gap = dist(first, last);
      const pointsForMatch =
        gap <= closeEpsRatio * diag ? [...rawPointsWU, first] : rawPointsWU.slice();
      const candidate = normalize(pointsForMatch, n);
      const turnCount = countSignificantTurns(candidate, PDOLLAR_CONFIG.MIN_TURN_ANGLE_DEG);
      const quadrantScore = quadrantOccupation(candidate);

      // Shape-specific turn requirements
      let minTurns: number;
      let turnSkipped = false;
      if (result.best.kind === 'box') {
        if (result.best.distance < PDOLLAR_CONFIG.MIN_TURNS_BOX_RELAXED_THRESHOLD) {
          minTurns = 0;
          turnSkipped = true;
        } else {
          minTurns = PDOLLAR_CONFIG.MIN_TURNS_BOX;
        }
      } else {
        minTurns =
          result.best.distance < PDOLLAR_CONFIG.MIN_TURNS_DIAMOND_RELAXED_THRESHOLD
            ? PDOLLAR_CONFIG.MIN_TURNS_DIAMOND
            : PDOLLAR_CONFIG.MIN_TURNS_BOX;
      }

      if (!turnSkipped && turnCount < minTurns) {
        reasons.push(`turn count ${turnCount} < min ${minTurns} for ${result.best.kind}`);
      } else if (turnCount > PDOLLAR_CONFIG.MAX_TURNS) {
        reasons.push(`turn count ${turnCount} > max ${PDOLLAR_CONFIG.MAX_TURNS}`);
      }
      if (quadrantScore < PDOLLAR_CONFIG.MIN_QUADRANT_OCCUPATION) {
        reasons.push(
          `quadrant ${(quadrantScore * 100).toFixed(0)}% < min ${(PDOLLAR_CONFIG.MIN_QUADRANT_OCCUPATION * 100).toFixed(0)}%`,
        );
      }
    }
    console.log(`Reason: ${reasons.join(', ')}`);
  }

  console.groupEnd();
}
/* eslint-enable no-console */

/**
 * Serialize normalized point cloud for template capture.
 * Use this to log user-drawn shapes and convert them to templates.
 */
export function serializePointCloud(rawPointsWU: Point2[], n = PDOLLAR_CONFIG.NUM_POINTS): string {
  const normalized = normalize(rawPointsWU, n);
  return JSON.stringify(normalized);
}
