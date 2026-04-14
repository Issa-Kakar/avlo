/**
 * Picker atoms for HitCandidate lists.
 *
 * - `classifyPaint` is the canonical paint classifier — a thin shim over
 *   `KIND[k].classify` so per-kind rules live in exactly one place.
 * - `firstCandidate` / `pickBestBy` are generic single-line pickers.
 * - `scanTopmostWithMemo` walks Z-sorted candidates with occlusion semantics
 *   (see-through fallback memoization).
 * - `pickFrameAware` is the legacy two-phase tournament — kept as a swappable
 *   `Picker<HitCandidate>` because its bestFrame / firstPaint reconciliation
 *   doesn't fit a single-pass scanner cleanly.
 *
 * Input to all multi-candidate pickers MUST be Z-sorted top-first
 * (`queryHits` produces this by default).
 */

import type { HitCandidate } from '@/core/geometry/hit-testing';
import type { ObjectKind } from '@/core/types/objects';
import type { Comparator, Paint, Picker, Scorer } from './atoms';
import { KIND } from './kind-capability';

/** Canonical paint classifier — sourced from the per-kind capability table. */
export function classifyPaint<K extends ObjectKind>(c: HitCandidate<K>): Paint {
  // Per-kind table proves correctness; one cast bridges the indexed type.
  return (KIND[c.handle.kind] as { classify: (c: HitCandidate<ObjectKind>) => Paint }).classify(c as HitCandidate<ObjectKind>);
}

/** Unfilled shape interior is the only see-through candidate class. */
export const isSeeThrough = (c: HitCandidate): boolean => classifyPaint(c) === null;

/** Z-order comparator (top first). Stable for ULIDs. */
export const byZOrderTopFirst: Comparator<HitCandidate> = (a, b) =>
  a.handle.id < b.handle.id ? 1 : a.handle.id > b.handle.id ? -1 : 0;

/** Mutates in place: sorts Z top-first (ULID descending). */
export function sortZTopFirst<C extends HitCandidate>(cands: C[]): C[] {
  cands.sort(byZOrderTopFirst);
  return cands;
}

/** Trivial picker: first candidate (assumes caller pre-sorted). */
export const firstCandidate: Picker<HitCandidate> = <C extends HitCandidate>(cs: readonly C[]): C | null => cs[0] ?? null;

/** Pick by max score. */
export const pickBestBy = <C>(scorer: Scorer<C>): Picker<C> => (cs) => {
  if (cs.length === 0) return null;
  let best = cs[0];
  let bestScore = scorer(best);
  for (let i = 1; i < cs.length; i++) {
    const s = scorer(cs[i]);
    if (s > bestScore) {
      best = cs[i];
      bestScore = s;
    }
  }
  return best;
};

/**
 * Walk Z-sorted (top-first) candidates with occlusion semantics:
 *   - see-through candidate            → remember smallest-area `accept` result, continue
 *   - accept(c) returns non-null       → return immediately
 *   - paint blocker rejects accept     → return remembered fallback (or null)
 *
 * `onSeeThrough` defaults to `accept` so callers usually pass one function.
 */
export function scanTopmostWithMemo<C extends HitCandidate, R>(
  cands: readonly C[],
  accept: (c: C) => R | null,
  onSeeThrough: (c: C) => R | null = accept,
): R | null {
  let fallback: R | null = null;
  let fallbackArea = Infinity;
  for (const c of cands) {
    if (isSeeThrough(c)) {
      const r = onSeeThrough(c);
      if (r !== null && c.area < fallbackArea) {
        fallback = r;
        fallbackArea = c.area;
      }
      continue;
    }
    const picked = accept(c);
    if (picked !== null) return picked;
    return fallback;
  }
  return fallback;
}

/**
 * Frame-aware tournament — preserved verbatim semantics from the legacy
 * `pickFrameAware`. Two-phase scan + reconciliation:
 *   - topmost ink/fill always wins over see-through frames it sits on top of
 *   - if no paint exists, smallest see-through frame wins
 *   - if both filled paint and see-through frames are stacked, smaller area wins
 *   - equal areas: higher Z wins
 */
export const pickFrameAware: Picker<HitCandidate> = <C extends HitCandidate>(candidates: readonly C[]): C | null => {
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];

  let bestFrame: C | null = null;
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
};
