/**
 * Object Pick — Z-order scanner + paint classifier + frame tournament.
 *
 * Canonical primitives for walking Z-sorted HitCandidate lists with occlusion
 * semantics. Shared between:
 *   - SelectTool.hitTestObjects (pickFrameAware tournament)
 *   - snap.findBestSnapTarget (bindable pre-filtered)
 *   - hitTestVisibleText/Code/Note (kind-accept filter)
 *
 * The scanner and tournament resolver share `classifyPaint` so they can never
 * drift on what "opaque" means for each kind.
 */

import type { HitCandidate } from './hit-testing';

export type { HitCandidate };

/** Paint classification used by scanTopmost and the frame tournament. */
export type Paint = 'ink' | 'fill' | null;

/**
 * Canonical paint classifier.
 *   ink     — line/edge paint (strokes, connectors, shape borders, text on edge)
 *   fill    — area paint (filled shape interior, text/code fill interior)
 *   null    — see-through (unfilled shape interior — the only see-through class)
 */
export function classifyPaint(c: HitCandidate): Paint {
  const k = c.handle.kind;
  if (k === 'stroke' || k === 'connector') return 'ink';

  if (k === 'text') {
    if (c.isFilled && c.insideInterior) return 'fill';
    return 'ink';
  }

  if (k === 'code') {
    if (c.insideInterior) return 'fill';
    return 'ink';
  }

  if (k === 'shape') {
    if (c.isFilled) return 'fill';
    if (!c.insideInterior) return 'ink';
    return null;
  }

  return 'ink';
}

/** Unfilled shape interior: the only "see-through" candidate class. */
export const isSeeThrough = (c: HitCandidate): boolean => c.handle.kind === 'shape' && !c.isFilled && c.insideInterior;

/** Mutates in place: sorts Z top-first (ULID descending). */
export function sortZTopFirst<C extends HitCandidate>(cands: C[]): C[] {
  cands.sort((a, b) => (a.handle.id < b.handle.id ? 1 : a.handle.id > b.handle.id ? -1 : 0));
  return cands;
}

export interface ScanOptions<R, C extends HitCandidate = HitCandidate> {
  accept: (c: C) => R | null;
  /**
   * Called on see-through candidates (unfilled shape interiors).
   * Return non-null to memoize as smallest-area fallback; scanner picks the
   * min-area result if no accept() fires before a paint blocker.
   * Omit for pure pass-through.
   */
  onSeeThrough?: (c: C) => R | null;
}

/**
 * Walk Z-sorted (top-first) candidates with occlusion semantics:
 *   - see-through candidate + onSeeThrough set → memoize smallest-area fallback, continue
 *   - see-through candidate + no onSeeThrough  → pass-through, continue
 *   - accept(c) returns non-null                → return it immediately
 *   - paint blocker, accept rejected            → return fallback (or null)
 *
 * `C` is inferred from the candidates array, so narrowing done by the
 * `queryHitCandidates(kinds)` overload flows into the accept/onSeeThrough
 * callbacks without a cast.
 *
 * Input MUST already be Z-sorted top-first (use sortZTopFirst or queryHitCandidates).
 */
export function scanTopmost<R, C extends HitCandidate>(candidates: C[], opts: ScanOptions<R, C>): R | null {
  let fallback: R | null = null;
  let fallbackArea = Infinity;

  for (const c of candidates) {
    if (isSeeThrough(c)) {
      if (opts.onSeeThrough) {
        const r = opts.onSeeThrough(c);
        if (r !== null && c.area < fallbackArea) {
          fallback = r;
          fallbackArea = c.area;
        }
      }
      continue;
    }

    const accepted = opts.accept(c);
    if (accepted !== null) return accepted;

    // Non-see-through candidate rejected by accept → it blocks.
    if (classifyPaint(c) !== null) return fallback;
  }

  return fallback;
}

/**
 * Pick the best candidate from a Z-sorted list using the frame tournament:
 *   - Topmost ink/fill always wins over see-through frames it sits on top of
 *   - If no paint exists, smallest see-through frame wins
 *   - If both filled paint and see-through frames are stacked, smaller area wins
 *   - Equal areas: higher Z wins
 *
 * Input MUST already be Z-sorted top-first (queryHitCandidates does this).
 * Single-element lists short-circuit.
 */
export function pickFrameAware<C extends HitCandidate>(candidates: C[]): C | null {
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];

  let bestFrame: C | null = null; // Smallest see-through (unfilled shape interior)
  let firstPaint: C | null = null;
  let firstPaintClass: Paint = null;
  let firstPaintIdx = -1;
  let bestFrameIdx = -1;

  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    if (isSeeThrough(c)) {
      if (!bestFrame || c.area < bestFrame.area) {
        bestFrame = c;
        bestFrameIdx = i;
      }
      continue;
    }
    const paintClass = classifyPaint(c);
    if (paintClass !== null) {
      firstPaint = c;
      firstPaintClass = paintClass;
      firstPaintIdx = i;
      break;
    }
  }

  if (!firstPaint && bestFrame) return bestFrame;
  if (!firstPaint) return candidates[0];

  if (firstPaintClass === 'ink') return firstPaint;
  if (!bestFrame) return firstPaint;

  if (bestFrame.area < firstPaint.area) return bestFrame;
  if (firstPaint.area < bestFrame.area) return firstPaint;

  return firstPaintIdx <= bestFrameIdx ? firstPaint : bestFrame;
}
