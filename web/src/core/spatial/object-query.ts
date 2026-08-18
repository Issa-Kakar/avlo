/**
 * Object Query — the single entry point for spatial hit testing.
 *
 * Three point-pickers and one region-membership query. Each owns its full
 * pipeline (spatialTree envelope query → slot-keyed lock/kind prefilter →
 * hit dispatch → packed-key sort → inline picker walk) and
 * returns the single result its caller actually wants. No call site
 * materializes an intermediate hit array, no call site passes option-bag
 * knobs, no per-call allocation.
 *
 * Queries fill `spatialTree.results` with dense u32 slots — `collectHits`
 * consumes it immediately (fetched fresh after the query; see the
 * results-lifetime contract in `spatial-tree.ts`). Twin by rect size: point
 * probes (radius picks, eraser circles) run `queryPrecise`; rect regions
 * (marquee) run the wide `query` — marquees routinely grow to viewport scale,
 * where the branchless leaf compaction wins.
 *
 * Hits pack into u32 keys `rank * 4 + paintCode` (module scratch), sorted
 * ascending by `sortU32Range` and walked DESCENDING — higher key ⇔ higher
 * rank ⇔ higher stack position, so the walk is top-first. Recover
 * `paint = key & 3` and the handle via the rank→slot inverse permutation
 * (`getSlotsByRank` + the slot table's reverse map). No comparator, no
 * per-hit candidate object.
 *
 * Region + Radius helpers live here too (used only by the picker entry
 * points; no reason to split them into their own module).
 */

import { getFrame } from '@/core/accessors';
import { getLockedFlags, getLockOwners } from '@/core/locks/lock-table';
import { getHandlesBySlot, getKindCodes } from '@/core/slots/slot-table';
import type { BBoxTuple, Point } from '@/core/types/geometry';
import { BINDABLE_KIND_MASK, type BindableHandle, type ObjectHandle, type ObjectKind } from '@/core/types/objects';
import { getZOrder } from '@/runtime/room-runtime';
import { useCameraStore } from '@/stores/camera-store';
import { sortU32Range } from '@/utils/sort-u32';
import { hitCircleFor, hitPointFor, hitRectFor } from './hit-dispatch';
import { spatialTree } from './spatial-tree';

// ============================================================================
// Radius + Region
// ============================================================================

/** Hit tolerance — `{ px }` is screen-space (divided by camera scale); `{ world }` passes through. */
export type Radius = { readonly px: number } | { readonly world: number };

/** Exposed for `handle-hit.ts`; not part of the call-site surface. */
export function resolveRadius(r: Radius): number {
  if ('world' in r) return r.world;
  const s = Math.max(0.001, useCameraStore.getState().scale);
  return r.px / s;
}

export type Region =
  | { readonly kind: 'point'; readonly p: Point; readonly r: number }
  | { readonly kind: 'rect'; readonly bbox: BBoxTuple };

export const atPoint = (p: Point, radius: Radius): Region => ({ kind: 'point', p, r: resolveRadius(radius) });
export const inBBox = (bbox: BBoxTuple): Region => ({ kind: 'rect', bbox });

// ============================================================================
// Internal scratch — never leaks to callers
// ============================================================================

// Paint codes for key packing (`rank * 4 + code`; recover `key & 3`).
// hit-dispatch keeps its string union — mapped once at pack time.
const PAINT_INK = 0;
const PAINT_FILL = 1;
const PAINT_SEETHROUGH = 2;

// Kind-mask for collectHits' slot-column prefilter: bit i ⇔ kind code i passes.
// All 8 codes fit in a u8, so 0xff = unfiltered.
const KIND_MASK_ALL = 0xff;

// Packed hit keys, reused across the three pickers; never retained past one
// picker call (single-threaded JS). Pow2 growth.
let _hitKeys = new Uint32Array(64);

/** Shape-only area for the frame-aware tournament. Called only when `paint ∈ {'seethrough','fill'}`. */
function shapeArea(h: ObjectHandle): number {
  const f = getFrame(h.y);
  return f ? f[2] * f[3] : 0;
}

/** Shared hit-collection loop for the three pickers — consumes the `n` slots the caller's
 *  query just wrote into `spatialTree.results` (fetched here, AFTER the query — growth
 *  swaps the buffer), fills `_hitKeys[0..k)` with packed `rank * 4 + paintCode` keys and
 *  returns `k`. Ranks are validated FIRST (keys embed them). Lock checks run on the raw
 *  slot before handle recovery — cheapest filters first.
 *  `lo` = lock-owner column: remote-locked objects (owner > 1) are untouchable — invisible
 *  to click/marquee/eraser/editor-entry. `lf` = durable-lock column: locked objects are
 *  skipped where the pick leads to mutation or edit entry. Either `null` opts that filter
 *  out (bindable snap passes both — attaching a connector never mutates the target;
 *  click-pick passes `lf: null` — a locked object stays click-selectable). */
function collectHits(
  n: number,
  p: Point,
  r: number,
  kindMask: number, // bit per kind code; KIND_MASK_ALL = unfiltered
  lo: Uint32Array | null,
  lf: Uint8Array | null,
): number {
  const zOrder = getZOrder();
  zOrder.ensureRanksValid(); // before packing — keys embed ranks
  const ranks = zOrder.getRanks();
  const res = spatialTree.results;
  const bySlot = getHandlesBySlot();
  const kinds = getKindCodes();
  if (n > _hitKeys.length) {
    // Sized from n, not res.length — the results buffer is a high-water alias.
    let cap = _hitKeys.length;
    while (cap < n) cap *= 2;
    _hitKeys = new Uint32Array(cap);
  }
  let k = 0;
  for (let i = 0; i < n; i++) {
    const slot = res[i];
    if (lo !== null && lo[slot] > 1) continue;
    if (lf !== null && lf[slot] === 1) continue;
    if (((kindMask >>> kinds[slot]) & 1) === 0) continue; // slot-decidable — before handle recovery
    const e = bySlot[slot]!; // live by query contract
    const paint = hitPointFor(e, p, r);
    if (paint === null) continue;
    const code = paint === 'ink' ? PAINT_INK : paint === 'fill' ? PAINT_FILL : PAINT_SEETHROUGH;
    _hitKeys[k++] = ranks[slot] * 4 + code;
  }
  return k;
}

// ============================================================================
// queryHandleIds — region membership (marquee, eraser)
// ============================================================================

/**
 * IDs of objects whose geometry actually intersects `region`. Envelope
 * prefilter picks the twin by rect size — wide `query` for rect regions
 * (marquees grow to viewport scale), `queryPrecise` for point probes — then
 * per-kind precise intersect (`hitRectFor` for rect regions, `hitCircleFor`
 * for point regions). Returns `string[]` so consumers don't `.map(h => h.id)`
 * afterward (slot-keyed selection is a deferred slice).
 *
 * Tight-bbox fast path: for kinds whose stored bbox equals their frame
 * (image, code), `hitRectFor` returns `true` unconditionally — the envelope
 * filter we just passed IS the precision rect check. Marquee runs precision
 * for every viewport entry, so skipping a redundant `bboxesIntersect` per
 * image/code matters when many are on screen.
 */
export function queryHandleIds(region: Region): string[] {
  // Envelope scalars computed inline per branch — no tuple alloc for the point case.
  let n: number;
  if (region.kind === 'rect') {
    const b = region.bbox;
    n = spatialTree.query(b[0], b[1], b[2], b[3]);
  } else {
    const x = region.p[0];
    const y = region.p[1];
    const r = region.r;
    n = spatialTree.queryPrecise(x - r, y - r, x + r, y + r);
  }
  const res = spatialTree.results;
  const bySlot = getHandlesBySlot();
  const lo = getLockOwners();
  const lf = getLockedFlags();
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const slot = res[i];
    if (lo[slot] > 1 || lf[slot] === 1) continue; // remote- or durably-locked — untouchable to marquee + eraser
    const e = bySlot[slot]!;
    const ok = region.kind === 'rect' ? hitRectFor(e, region.bbox) : hitCircleFor(e, region.p, region.r);
    if (ok) out.push(e.id);
  }
  return out;
}

// ============================================================================
// pickTopmostPaint — SelectTool click (frame-aware tournament)
// ============================================================================

/**
 * Topmost paint hit with the frame-aware tournament:
 *   - topmost ink wins outright (short-circuits before any area math)
 *   - between a topmost `fill` (shape only) and see-through frames stacked
 *     above it, the smaller area wins; ties go to higher Z
 *   - if nothing paints, the smallest see-through frame wins
 */
export function pickTopmostPaint(at: Point, radius: Radius): ObjectHandle | null {
  const r = resolveRadius(radius);
  const n0 = spatialTree.queryPrecise(at[0] - r, at[1] - r, at[0] + r, at[1] + r);
  const n = collectHits(n0, at, r, KIND_MASK_ALL, getLockOwners(), null); // lf null — locked objects stay click-selectable
  if (n === 0) return null;
  const slotsByRank = getZOrder().getSlotsByRank();
  const bySlot = getHandlesBySlot();
  if (n === 1) return bySlot[slotsByRank[_hitKeys[0] >>> 2]]!;
  sortU32Range(_hitKeys, 0, n);

  // Tournament state holds raw keys — higher key ⇔ higher stack position.
  // The seethrough set and the first non-seethrough are disjoint, so key
  // equality between the two is impossible.
  let bestFrameKey = 0;
  let bestFrameHandle: ObjectHandle | null = null;
  let bestFrameArea = Infinity;
  let firstPaintKey = 0;
  let firstPaintHandle: ObjectHandle | null = null;

  for (let i = n - 1; i >= 0; i--) {
    const key = _hitKeys[i];
    if ((key & 3) === PAINT_SEETHROUGH) {
      const h = bySlot[slotsByRank[key >>> 2]]!;
      const a = shapeArea(h);
      if (a < bestFrameArea) {
        bestFrameKey = key;
        bestFrameHandle = h;
        bestFrameArea = a;
      }
      continue;
    }
    firstPaintKey = key;
    firstPaintHandle = bySlot[slotsByRank[key >>> 2]]!;
    break;
  }

  // Nothing paints → smallest see-through frame, else the topmost hit outright.
  if (firstPaintHandle === null) return bestFrameHandle ?? bySlot[slotsByRank[_hitKeys[n - 1] >>> 2]]!;
  if ((firstPaintKey & 3) === PAINT_INK) return firstPaintHandle;
  if (bestFrameHandle === null) return firstPaintHandle;

  // firstPaint is 'fill' → a shape; compare areas.
  const paintArea = shapeArea(firstPaintHandle);
  if (bestFrameArea < paintArea) return bestFrameHandle;
  if (paintArea < bestFrameArea) return firstPaintHandle;
  return firstPaintKey > bestFrameKey ? firstPaintHandle : bestFrameHandle;
}

// ============================================================================
// pickTopmostOfKind — TextTool / CodeTool visible-kind lookup
// ============================================================================

/**
 * Topmost object of `kind`, occluded by paint blockers above it. A non-see-
 * through paint of a different kind sitting above the target returns null
 * (blocked). Since target is always a framed kind (text/code/note) whose
 * paint is always `'ink'`, see-through fallback tracking would be dead code —
 * omitted.
 */
export function pickTopmostOfKind(at: Point, radius: Radius, kind: ObjectKind): string | null {
  const r = resolveRadius(radius);
  const n0 = spatialTree.queryPrecise(at[0] - r, at[1] - r, at[0] + r, at[1] + r);
  const n = collectHits(n0, at, r, KIND_MASK_ALL, getLockOwners(), getLockedFlags()); // locked → create-over, never edit-into
  if (n === 0) return null;
  sortU32Range(_hitKeys, 0, n);
  const slotsByRank = getZOrder().getSlotsByRank();
  const bySlot = getHandlesBySlot();
  for (let i = n - 1; i >= 0; i--) {
    const key = _hitKeys[i];
    if ((key & 3) === PAINT_SEETHROUGH) continue; // unfilled shape above target — doesn't block
    const h = bySlot[slotsByRank[key >>> 2]]!;
    return h.kind === kind ? h.id : null;
  }
  return null;
}

// ============================================================================
// pickTopmostBindable — snap-style accept callback over bindable hits
// ============================================================================

/**
 * Walk bindable hits z-sorted top-first, feeding each handle to `accept`:
 *   - see-through (unfilled bindable shape interior): memoize smallest-area
 *     accept result as fallback, continue
 *   - non-see-through (ink/fill): if accept hits, return; else return the
 *     memoized fallback
 */
export function pickTopmostBindable<T>(at: Point, radius: Radius, accept: (h: BindableHandle) => T | null): T | null {
  const r = resolveRadius(radius);
  const n0 = spatialTree.queryPrecise(at[0] - r, at[1] - r, at[0] + r, at[1] + r);
  const n = collectHits(n0, at, r, BINDABLE_KIND_MASK, null, null);
  if (n === 0) return null;
  sortU32Range(_hitKeys, 0, n);
  const slotsByRank = getZOrder().getSlotsByRank();
  const bySlot = getHandlesBySlot();

  let fallback: T | null = null;
  let fallbackArea = Infinity;
  for (let i = n - 1; i >= 0; i--) {
    const key = _hitKeys[i];
    const bh = bySlot[slotsByRank[key >>> 2]]! as BindableHandle;
    if ((key & 3) === PAINT_SEETHROUGH) {
      const v = accept(bh);
      if (v !== null) {
        const a = shapeArea(bh);
        if (a < fallbackArea) {
          fallback = v;
          fallbackArea = a;
        }
      }
      continue;
    }
    const v = accept(bh);
    return v !== null ? v : fallback;
  }
  return fallback;
}
