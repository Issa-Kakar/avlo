/**
 * Object Pick — Z-order scanner + paint classifier + frame tournament.
 *
 * Canonical primitives for walking Z-sorted HitCandidate lists with occlusion
 * semantics. Shared between:
 *   - SelectTool.hitTestObjects (pickFrameAware tournament)
 *   - snap.findBestSnapTarget (bindable pre-filtered)
 *   - hitTestVisibleText/Code/Note (kind-accept filter)
 *
 * `c.paint` is precomputed by `KIND[k].hitPoint` so the scanner/tournament
 * never redispatch per candidate.
 */

import type { HitCandidate } from './hit-testing';
import type { Paint } from '../spatial/atoms';
import { areaOf } from '../spatial/pickers';

export type { HitCandidate };
export type { Paint };

/** Thin shim — the paint class is now precomputed in `hitPoint`. */
export const classifyPaint = (c: HitCandidate): Paint => c.paint;

/** Unfilled shape interior: the only "see-through" candidate class. */
export const isSeeThrough = (c: HitCandidate): boolean => c.paint === null;

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
    if (c.paint === null) {
      if (opts.onSeeThrough) {
        const r = opts.onSeeThrough(c);
        if (r !== null) {
          const a = areaOf(c.handle);
          if (a < fallbackArea) {
            fallback = r;
            fallbackArea = a;
          }
        }
      }
      continue;
    }

    const accepted = opts.accept(c);
    if (accepted !== null) return accepted;
    // Non-see-through candidate rejected by accept → it blocks.
    return fallback;
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
  let bestFrameArea = Infinity;
  let firstPaint: C | null = null;
  let firstPaintIdx = -1;
  let bestFrameIdx = -1;

  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    if (c.paint === null) {
      const a = areaOf(c.handle);
      if (a < bestFrameArea) {
        bestFrame = c;
        bestFrameArea = a;
        bestFrameIdx = i;
      }
      continue;
    }
    firstPaint = c;
    firstPaintIdx = i;
    break;
  }

  if (!firstPaint && bestFrame) return bestFrame;
  if (!firstPaint) return candidates[0];
  if (firstPaint.paint === 'ink') return firstPaint;
  if (!bestFrame) return firstPaint;

  const paintArea = areaOf(firstPaint.handle);
  if (bestFrameArea < paintArea) return bestFrame;
  if (paintArea < bestFrameArea) return firstPaint;
  return firstPaintIdx <= bestFrameIdx ? firstPaint : bestFrame;
}
