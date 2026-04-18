/**
 * Object Query — the single entry point for spatial hit testing.
 *
 * Three point-pickers and one region-membership query. Each owns its full
 * pipeline (rbush envelope → optional prefilter → getHandle → cap dispatch →
 * in-place z-sort → inline picker walk) and returns the single result its
 * caller actually wants. No call site materializes an intermediate hit array,
 * no call site passes option-bag knobs, no per-call `new Set` allocation.
 *
 * Region + Radius helpers live here too (used only by the picker entry
 * points; no reason to split them into their own module).
 */

import type { BBoxTuple, Point } from '@/core/types/geometry';
import type { BindableHandle, ObjectHandle, ObjectKind, IndexEntry } from '@/core/types/objects';
import { getFrame } from '@/core/accessors';
import { getSpatialIndex, getHandle } from '@/runtime/room-runtime';
import { useCameraStore } from '@/stores/camera-store';
import { KIND, type AnyCapability, type Paint } from './kind-capability';

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

const BINDABLE_KINDS_SET: ReadonlySet<ObjectKind> = new Set<ObjectKind>(
  (Object.keys(KIND) as ObjectKind[]).filter((k) => KIND[k].bindable),
);

// ============================================================================
// Internal scratch — never leaks to callers
// ============================================================================

interface Cand {
  readonly handle: ObjectHandle;
  readonly paint: Paint;
}

/** ULID-desc z-sort (top first), in-place. */
function sortTopFirst(cs: Cand[]): void {
  cs.sort((a, b) => (a.handle.id < b.handle.id ? 1 : a.handle.id > b.handle.id ? -1 : 0));
}

/** Shape-only area for the frame-aware tournament. Called only when `paint ∈ {'seethrough','fill'}`. */
function shapeArea(h: ObjectHandle): number {
  const f = getFrame(h.y);
  return f ? f[2] * f[3] : 0;
}

/** Shared hit-collection loop for the three pickers. */
function collectHits(entries: readonly IndexEntry[], p: Point, r: number, kindFilter: ReadonlySet<ObjectKind> | null): Cand[] {
  const out: Cand[] = [];
  for (const e of entries) {
    if (kindFilter && !kindFilter.has(e.kind)) continue;
    const h = getHandle(e.id);
    if (!h) continue;
    const cap = KIND[h.kind] as AnyCapability;
    const paint = cap.hitPoint(h, p, r);
    if (paint === null) continue;
    out.push({ handle: h, paint });
  }
  return out;
}

// ============================================================================
// queryHandleIds — region membership (marquee, eraser)
// ============================================================================

/**
 * IDs of objects whose geometry actually intersects `region`. Envelope
 * prefilter via rbush, then per-kind precise intersect (`cap.hitRect` for
 * rect regions, `cap.hitCircle` for point regions). Returns `string[]` so
 * consumers don't `.map(h => h.id)` afterward.
 */
export function queryHandleIds(region: Region): string[] {
  const env = regionEnvelope(region);
  const entries = getSpatialIndex().queryBBox(env);
  const out: string[] = [];
  for (const e of entries) {
    const h = getHandle(e.id);
    if (!h) continue;
    const cap = KIND[h.kind] as AnyCapability;
    const ok = region.kind === 'rect' ? cap.hitRect(h, region.bbox) : cap.hitCircle(h, region.p, region.r);
    if (ok) out.push(h.id);
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
  const cs = collectHits(entries, at, r, null);
  if (cs.length === 0) return null;
  if (cs.length === 1) return cs[0].handle;
  sortTopFirst(cs);

  let bestFrame: Cand | null = null;
  let bestFrameArea = Infinity;
  let bestFrameIdx = -1;
  let firstPaint: Cand | null = null;
  let firstPaintIdx = -1;

  for (let i = 0; i < cs.length; i++) {
    const c = cs[i];
    if (c.paint === 'seethrough') {
      const a = shapeArea(c.handle);
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

  if (!firstPaint) return bestFrame?.handle ?? cs[0].handle;
  if (firstPaint.paint === 'ink') return firstPaint.handle;
  if (!bestFrame) return firstPaint.handle;

  // firstPaint.paint === 'fill' → firstPaint is a shape; compare areas.
  const paintArea = shapeArea(firstPaint.handle);
  if (bestFrameArea < paintArea) return bestFrame.handle;
  if (paintArea < bestFrameArea) return firstPaint.handle;
  return firstPaintIdx <= bestFrameIdx ? firstPaint.handle : bestFrame.handle;
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
  const cs = collectHits(entries, at, r, null);
  if (cs.length === 0) return null;
  sortTopFirst(cs);
  for (const c of cs) {
    if (c.paint === 'seethrough') continue; // unfilled shape above target — doesn't block
    return c.handle.kind === kind ? c.handle.id : null;
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
  const cs = collectHits(entries, at, r, BINDABLE_KINDS_SET);
  if (cs.length === 0) return null;
  sortTopFirst(cs);

  let fallback: T | null = null;
  let fallbackArea = Infinity;
  for (const c of cs) {
    const bh = c.handle as BindableHandle;
    if (c.paint === 'seethrough') {
      const v = accept(bh);
      if (v !== null) {
        const a = shapeArea(c.handle);
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
