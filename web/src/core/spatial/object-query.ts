/**
 * Object Query — the single entry point for spatial hit testing.
 *
 * Three point-pickers and one region-membership query. Each owns its full
 * pipeline (rbush envelope → optional prefilter → hit dispatch → packed-key
 * sort → inline picker walk) and returns the single result its caller
 * actually wants. No call site materializes an intermediate hit array,
 * no call site passes option-bag knobs, no per-call allocation.
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
import { getHandlesBySlot } from '@/core/slots/slot-table';
import type { BBoxTuple, Point } from '@/core/types/geometry';
import { BINDABLE_KINDS, type BindableHandle, type ObjectHandle, type ObjectKind } from '@/core/types/objects';
import { getSpatialIndex, getZOrder } from '@/runtime/room-runtime';
import { useCameraStore } from '@/stores/camera-store';
import { sortU32Range } from '@/utils/sort-u32';
import { hitCircleFor, hitPointFor, hitRectFor } from './hit-dispatch';

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

function regionEnvelope(region: Region): BBoxTuple {
  if (region.kind === 'rect') return region.bbox;
  const [x, y] = region.p;
  return [x - region.r, y - region.r, x + region.r, y + region.r];
}

// ============================================================================
// Bindable kind set — built once at import
// ============================================================================

const BINDABLE_KINDS_SET: ReadonlySet<ObjectKind> = new Set<ObjectKind>(BINDABLE_KINDS);

// ============================================================================
// Internal scratch — never leaks to callers
// ============================================================================

// Paint codes for key packing (`rank * 4 + code`; recover `key & 3`).
// hit-dispatch keeps its string union — mapped once at pack time.
const PAINT_INK = 0;
const PAINT_FILL = 1;
const PAINT_SEETHROUGH = 2;

// Packed hit keys, reused across the three pickers; never retained past one
// picker call (single-threaded JS). Pow2 growth.
let _hitKeys = new Uint32Array(64);

/** Shape-only area for the frame-aware tournament. Called only when `paint ∈ {'seethrough','fill'}`. */
function shapeArea(h: ObjectHandle): number {
  const f = getFrame(h.y);
  return f ? f[2] * f[3] : 0;
}

/** Shared hit-collection loop for the three pickers — fills `_hitKeys[0..n)` with packed
 *  `rank * 4 + paintCode` keys and returns `n`. Ranks are validated FIRST (keys embed them).
 *  `lo` = lock-owner column: remote-locked objects (owner > 1) are untouchable — invisible
 *  to click/marquee/eraser/editor-entry. `lf` = durable-lock column: locked objects are
 *  skipped where the pick leads to mutation or edit entry. Either `null` opts that filter
 *  out (bindable snap passes both — attaching a connector never mutates the target;
 *  click-pick passes `lf: null` — a locked object stays click-selectable). */
function collectHits(
  entries: readonly ObjectHandle[],
  p: Point,
  r: number,
  kindFilter: ReadonlySet<ObjectKind> | null,
  lo: Uint32Array | null,
  lf: Uint8Array | null,
): number {
  const zOrder = getZOrder();
  zOrder.ensureRanksValid(); // before packing — keys embed ranks
  const ranks = zOrder.getRanks();
  if (entries.length > _hitKeys.length) {
    let cap = _hitKeys.length;
    while (cap < entries.length) cap *= 2;
    _hitKeys = new Uint32Array(cap);
  }
  let n = 0;
  for (const e of entries) {
    if (kindFilter && !kindFilter.has(e.kind)) continue;
    if (lo !== null && lo[e.slot] > 1) continue;
    if (lf !== null && lf[e.slot] === 1) continue;
    const paint = hitPointFor(e, p, r);
    if (paint === null) continue;
    const code = paint === 'ink' ? PAINT_INK : paint === 'fill' ? PAINT_FILL : PAINT_SEETHROUGH;
    _hitKeys[n++] = ranks[e.slot] * 4 + code;
  }
  return n;
}

// ============================================================================
// queryHandleIds — region membership (marquee, eraser)
// ============================================================================

/**
 * IDs of objects whose geometry actually intersects `region`. Envelope
 * prefilter via rbush, then per-kind precise intersect (`hitRectFor` for
 * rect regions, `hitCircleFor` for point regions). Returns `string[]` so
 * consumers don't `.map(h => h.id)` afterward.
 *
 * Tight-bbox fast path: for kinds whose stored rbush bbox equals their
 * frame (image, code), `hitRectFor` returns `true` unconditionally — the
 * envelope filter we just passed IS the precision rect check. Marquee
 * runs precision for every viewport entry, so skipping a redundant
 * `bboxesIntersect` per image/code matters when many are on screen.
 */
export function queryHandleIds(region: Region): string[] {
  const env = regionEnvelope(region);
  const entries = getSpatialIndex().queryBBox(env);
  const lo = getLockOwners();
  const lf = getLockedFlags();
  const out: string[] = [];
  for (const e of entries) {
    if (lo[e.slot] > 1 || lf[e.slot] === 1) continue; // remote- or durably-locked — untouchable to marquee + eraser
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
  const entries = getSpatialIndex().queryRadius(at[0], at[1], r);
  const n = collectHits(entries, at, r, null, getLockOwners(), null); // lf null — locked objects stay click-selectable
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
  const entries = getSpatialIndex().queryRadius(at[0], at[1], r);
  const n = collectHits(entries, at, r, null, getLockOwners(), getLockedFlags()); // locked → create-over, never edit-into
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
  const entries = getSpatialIndex().queryRadius(at[0], at[1], r);
  const n = collectHits(entries, at, r, BINDABLE_KINDS_SET, null, null);
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
