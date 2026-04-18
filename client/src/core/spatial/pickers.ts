/**
 * Picker atoms for HitCandidate lists.
 *
 * - `areaOf` is the lazy per-handle area dispatch; pickers only pay the cost
 *   when the tournament actually compares.
 * - `firstCandidate` / `pickBestBy` are generic single-line pickers.
 * - `scanTopmostWithMemo` walks Z-sorted candidates with occlusion semantics
 *   (see-through fallback memoization).
 * - `pickFrameAware` is the two-phase frame tournament — bestFrame vs firstPaint
 *   reconciliation with area-smaller-wins and ink short-circuit.
 * - `pickTopmostByKind` is the visible-kind helper used by TextTool/CodeTool:
 *   topmost candidate of the target kind, respecting paint-blocker occlusion.
 *
 * Input to all multi-candidate pickers MUST be Z-sorted top-first
 * (`queryHits` produces this by default).
 */

import type { ObjectHandle, ObjectKind } from '@/core/types/objects';
import type { Comparator, Picker, Scorer } from './atoms';
import { KIND, type AnyCapability, type HitCandidate } from './kind-capability';

/** Lazy per-handle area — only called when the tournament needs it. */
export const areaOf = (h: ObjectHandle): number => (KIND[h.kind] as AnyCapability).area(h);

/** Z-order comparator (top first). Stable for ULIDs. */
export const byZOrderTopFirst: Comparator<HitCandidate> = (a, b) => (a.handle.id < b.handle.id ? 1 : a.handle.id > b.handle.id ? -1 : 0);

/** Mutates in place: sorts Z top-first (ULID descending). */
export function sortZTopFirst<C extends HitCandidate>(cands: C[]): C[] {
  cands.sort(byZOrderTopFirst);
  return cands;
}

/** Trivial picker: first candidate (assumes caller pre-sorted). */
export const firstCandidate: Picker<HitCandidate> = <C extends HitCandidate>(cs: readonly C[]): C | null => cs[0] ?? null;

/** Pick by max score. */
export const pickBestBy =
  <C>(scorer: Scorer<C>): Picker<C> =>
  (cs) => {
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
    if (c.paint === null) {
      const r = onSeeThrough(c);
      if (r !== null) {
        const a = areaOf(c.handle);
        if (a < fallbackArea) {
          fallback = r;
          fallbackArea = a;
        }
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
};

/**
 * Topmost candidate whose kind matches `kind`, respecting paint-blocker
 * occlusion. A filled shape above a text blocks the text; an unfilled shape
 * above a text does not. Used by TextTool / CodeTool for visible click-to-edit.
 */
export function pickTopmostByKind<K extends ObjectKind>(cands: readonly HitCandidate[], kind: K): string | null {
  return scanTopmostWithMemo(cands, (c) => (c.handle.kind === kind ? c.handle.id : null));
}
