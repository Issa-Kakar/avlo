/**
 * $P/$Q Point-Cloud Shape Recognizer — public entry.
 *
 * Recognizes a single-stroke gesture as one of `circle | box | diamond | line`
 * by matching against 37 pre-built templates with FIXED aspect ratios. Output
 * (kind, distances, ambiguity) is byte-identical to the prior implementation.
 *
 * Algorithm: Vatavu, Anthony, & Wobbrock (2012) "$P Point-Cloud Recognizer";
 *   $Q optimization: Vatavu (2018). Treated as a black box — implementation
 *   notes describe layout, not algorithm changes.
 *
 * INVARIANTS — DO NOT BREAK
 *
 *  1. Module scratches (`RAW`, `CANDIDATE`) are NOT re-entrant. `recognize()`
 *     is synchronous and called once per HoldDetector fire — no caller may
 *     invoke it from within itself.
 *  2. All recognizer point buffers are `Float64Array` interleaved xy:
 *     `buf[2*i]` = x, `buf[2*i + 1]` = y. Length is always `2 * n`.
 *  3. Templates are built once on first `getTemplates()` and frozen for
 *     process lifetime. `recognize()` reads them only.
 *  4. The pre-gates read `RAW` directly (no flat-array allocation). The
 *     resample step writes into `CANDIDATE`. Gates and resample are
 *     sequential — never concurrent.
 */

import type { BBoxTuple, Point } from '@/core/types/geometry';
import { greedyCloudMatch } from './cloud-distance';
import { KIND_FOR_CODE, PDOLLAR_CONFIG, SHAPE_MAX_DISTANCE } from './constants';
import { countSignificantTurns, hasNearTouch, hasSelfIntersection, quadrantOccupation } from './gates';
import { normalizeInto } from './normalize';
import { bboxInto, copyPointsInto } from './point-buffer';
import { getTemplateId, getTemplateKind, getTemplates, NUM_TEMPLATES, templateOffset } from './templates';
import type { PerfectShapeKind, PerfectShapeMatch, PerfectShapeRecognition, RecognizerOpts } from './types';

const N = PDOLLAR_CONFIG.NUM_POINTS;

// Module scratches.
let RAW_CAPACITY = 1024;
let RAW = new Float64Array(2 * RAW_CAPACITY);
const CANDIDATE = new Float64Array(2 * N);
const RAW_BBOX: BBoxTuple = [0, 0, 0, 0];

function ensureRawCapacity(needed: number): void {
  if (needed <= RAW_CAPACITY) return;
  RAW_CAPACITY = needed > RAW_CAPACITY * 2 ? needed : RAW_CAPACITY * 2;
  RAW = new Float64Array(2 * RAW_CAPACITY);
}

/**
 * Match a raw stroke against the template library. Returns `null` if input is
 * too short to attempt recognition; otherwise a result whose `ambiguous` flag
 * indicates whether the caller should accept the snap.
 */
export function recognizePerfectShapePointCloud(rawPointsWU: readonly Point[], opts: RecognizerOpts = {}): PerfectShapeRecognition | null {
  const count = rawPointsWU.length;
  if (count < PDOLLAR_CONFIG.MIN_INPUT_POINTS) return null;

  const epsilon = opts.epsilon ?? PDOLLAR_CONFIG.EPSILON;
  const minMargin = opts.minMargin ?? PDOLLAR_CONFIG.MIN_MARGIN;
  const closeEpsRatio = opts.closeEpsRatio ?? PDOLLAR_CONFIG.CLOSE_EPS_RATIO;

  // Stage RAW (also used by the pre-gates and resample, sequentially).
  ensureRawCapacity(count + 1);
  copyPointsInto(rawPointsWU, RAW);

  // Bbox + diagonal.
  bboxInto(RAW, count, RAW_BBOX);
  const w = RAW_BBOX[2] - RAW_BBOX[0];
  const h = RAW_BBOX[3] - RAW_BBOX[1];
  const diag = Math.hypot(w, h);
  if (!Number.isFinite(diag) || diag <= 1e-6) return null;

  // Pre-normalization gates (raw points).
  const selfEps = Math.max(PDOLLAR_CONFIG.MIN_EPS_WU, PDOLLAR_CONFIG.SELF_INTERSECT_EPS_FACTOR * diag);
  const nearEps = Math.max(PDOLLAR_CONFIG.MIN_EPS_WU, PDOLLAR_CONFIG.NEAR_TOUCH_EPS_FACTOR * diag);
  if (hasSelfIntersection(RAW, count, selfEps)) return GATE_SELF_INTERSECT;
  if (hasNearTouch(RAW, count, nearEps)) return GATE_NEAR_TOUCH;

  // Optional path closing — append first point if endpoints are close.
  const firstX = RAW[0];
  const firstY = RAW[1];
  const lastX = RAW[2 * (count - 1)];
  const lastY = RAW[2 * (count - 1) + 1];
  const gap = Math.hypot(firstX - lastX, firstY - lastY);
  let normCount = count;
  if (gap <= closeEpsRatio * diag) {
    RAW[2 * count] = firstX;
    RAW[2 * count + 1] = firstY;
    normCount = count + 1;
  }

  // Normalize candidate.
  normalizeInto(RAW, normCount, CANDIDATE, N);

  // Match against every template.
  const tplBuf = getTemplates();
  const all: PerfectShapeMatch[] = new Array(NUM_TEMPLATES);
  for (let t = 0; t < NUM_TEMPLATES; t++) {
    const distance = greedyCloudMatch(CANDIDATE, 0, tplBuf, templateOffset(t), epsilon);
    all[t] = {
      kind: KIND_FOR_CODE[getTemplateKind(t)],
      templateId: getTemplateId(t),
      distance,
    };
  }
  all.sort(compareDistance);

  const best = all[0];
  const secondBest = findFirstOfDifferentKind(all, best.kind);
  const margin = secondBest && secondBest.distance > 1e-9 ? (secondBest.distance - best.distance) / secondBest.distance : 1;

  let ambiguous = best.distance > SHAPE_MAX_DISTANCE[best.kind] || margin < minMargin;

  // Post-normalization gates — box/diamond only (circles + lines pass-through).
  if (!ambiguous && (best.kind === 'box' || best.kind === 'diamond')) {
    const turns = countSignificantTurns(CANDIDATE, N, PDOLLAR_CONFIG.MIN_TURN_ANGLE_DEG);
    const quad = quadrantOccupation(CANDIDATE, N);

    if (best.kind === 'box') {
      // Skip turn check entirely on very-good matches; otherwise require min turns.
      if (best.distance >= PDOLLAR_CONFIG.MIN_TURNS_BOX_RELAXED_THRESHOLD && turns < PDOLLAR_CONFIG.MIN_TURNS_BOX) {
        ambiguous = true;
      }
    } else {
      // Diamond: relaxed when distance < threshold, stricter otherwise.
      const minTurns =
        best.distance < PDOLLAR_CONFIG.MIN_TURNS_DIAMOND_RELAXED_THRESHOLD
          ? PDOLLAR_CONFIG.MIN_TURNS_DIAMOND
          : PDOLLAR_CONFIG.MIN_TURNS_BOX;
      if (turns < minTurns) ambiguous = true;
    }

    if (turns > PDOLLAR_CONFIG.MAX_TURNS) ambiguous = true;
    if (quad < PDOLLAR_CONFIG.MIN_QUADRANT_OCCUPATION) ambiguous = true;
  }

  return { best, secondBest, ambiguous, margin, all };
}

/**
 * Bounding-box center and half-extents of raw stroke points. Used by
 * DrawingTool to anchor the snap-shape preview.
 *
 * Half-extents are floored at 1 to keep the snap frame finite for degenerate
 * inputs (preserves legacy semantics).
 */
export function computeBboxCenterExtents(points: readonly Point[]): {
  cx: number;
  cy: number;
  hx: number;
  hy: number;
} {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    const x = p[0];
    const y = p[1];
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  const halfW = (maxX - minX) / 2;
  const halfH = (maxY - minY) / 2;
  return {
    cx: (minX + maxX) / 2,
    cy: (minY + maxY) / 2,
    hx: halfW > 1 ? halfW : 1,
    hy: halfH > 1 ? halfH : 1,
  };
}

// =============================================================================
// HELPERS
// =============================================================================

function compareDistance(a: PerfectShapeMatch, b: PerfectShapeMatch): number {
  return a.distance - b.distance;
}

function findFirstOfDifferentKind(matches: PerfectShapeMatch[], kind: PerfectShapeKind): PerfectShapeMatch | null {
  for (const m of matches) if (m.kind !== kind) return m;
  return null;
}

// Pre-allocated gate-failure results — avoid building a new object on every block.
const GATE_SELF_INTERSECT: PerfectShapeRecognition = {
  best: { kind: 'line', templateId: 'gate/self-intersect', distance: Infinity },
  secondBest: null,
  ambiguous: true,
  margin: 0,
  all: [],
};

const GATE_NEAR_TOUCH: PerfectShapeRecognition = {
  best: { kind: 'line', templateId: 'gate/near-touch', distance: Infinity },
  secondBest: null,
  ambiguous: true,
  margin: 0,
  all: [],
};
