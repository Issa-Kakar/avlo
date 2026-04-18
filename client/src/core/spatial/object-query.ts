/**
 * Object Query Facade — bridges spatial index → handles → per-kind dispatch.
 *
 * The single module that imports `getSpatialIndex`/`getHandle` from room-runtime
 * into the core query layer. Keeps `ObjectSpatialIndex` as a pure rbush wrapper.
 *
 * Three entry points, each with a distinct return shape so consumers pay only
 * for what they need:
 *
 *   queryEntries(region, kinds?)  — raw IndexEntry[], no handle resolution.
 *                                    Viewport culling, image decode loop.
 *   queryHandles(opts)            — HandleOf<K>[], optional precise intersect.
 *                                    Marquee, eraser, region membership.
 *   queryHits(opts)               — HitCandidate<K>[] (paint-classified,
 *                                    Z-sorted). Clicks, snap.
 *
 * Filters narrow the generic; `where` is a non-narrowing post-filter; the
 * `precise` selector picks which capability geometry to dispatch.
 */

import type { ObjectHandle, ObjectKind, IndexEntry } from '@/core/types/objects';
import { getSpatialIndex, getHandle } from '@/runtime/room-runtime';
import type { Comparator, HandleOf, NarrowingPredicate, Predicate } from './atoms';
import type { Region } from './region';
import { regionEnvelope } from './region';
import { type Radius, resolveRadius } from './radius';
import { KIND, type AnyCapability, type HitCandidate } from './kind-capability';
import { sortZTopFirst } from './pickers';

// ============================================================================
// Internal helpers
// ============================================================================

/**
 * If a `byKind`/`byKinds` filter was provided, this lets us extract the kind
 * set so the spatial-index entry-level prefilter can skip whole categories
 * before any `getHandle()` lookup or hit-test math runs.
 *
 * The plumbing is duck-typed via an optional `__kinds` brand the filter
 * factories attach to themselves. If absent, the prefilter is a no-op.
 */
type KindBranded<F> = F & { __kinds?: ReadonlySet<ObjectKind> };

function readKindBrand(filter: unknown): ReadonlySet<ObjectKind> | null {
  if (!filter || typeof filter !== 'function') return null;
  const k = (filter as KindBranded<unknown>).__kinds;
  return k ?? null;
}

// ============================================================================
// queryEntries — raw IndexEntry list (culling, image viewport decode)
// ============================================================================

export function queryEntries(opts: { region: Region; kinds?: readonly ObjectKind[] }): IndexEntry[] {
  const env = regionEnvelope(opts.region);
  const entries = getSpatialIndex().queryBBox(env);
  if (!opts.kinds || opts.kinds.length === 0) return entries;
  const set = new Set<ObjectKind>(opts.kinds);
  const out: IndexEntry[] = [];
  for (const e of entries) {
    if (set.has(e.kind)) out.push(e);
  }
  return out;
}

// ============================================================================
// queryHandles — region + narrowing filter → handle list
// ============================================================================

export interface QueryHandlesOpts<K extends ObjectKind> {
  region: Region;
  /** Tightness of intersection vs the region. Default: `'bbox'` (envelope-only). */
  precise?: 'bbox' | 'rect' | 'circle';
  /** Narrowing filter — type flows through to the result. */
  filter?: NarrowingPredicate<ObjectHandle, HandleOf<K>>;
  /** Non-narrowing post-filter applied after `filter`. */
  where?: Predicate<HandleOf<K>>;
  limit?: number;
}

export function queryHandles<const K extends ObjectKind = ObjectKind>(opts: QueryHandlesOpts<K>): HandleOf<K>[] {
  const { region, precise = 'bbox', filter, where, limit } = opts;
  const env = regionEnvelope(region);
  const entries = getSpatialIndex().queryBBox(env);
  const kindSet = readKindBrand(filter);
  const out: HandleOf<K>[] = [];

  for (const e of entries) {
    if (kindSet && !kindSet.has(e.kind)) continue;
    const h = getHandle(e.id);
    if (!h) continue;
    if (filter && !filter(h)) continue;
    const narrowed = h as HandleOf<K>;

    if (precise !== 'bbox') {
      // SAFETY: KIND[h.kind] is the cap for h's kind; one cast bridges generics.
      const cap = KIND[h.kind] as AnyCapability;
      if (precise === 'rect') {
        if (region.kind !== 'rect') continue;
        if (!cap.hitRect(h, region.bbox)) continue;
      } else {
        if (region.kind !== 'point') continue;
        if (!cap.hitCircle(h, region.p, region.r)) continue;
      }
    }

    if (where && !where(narrowed)) continue;
    out.push(narrowed);
    if (limit !== undefined && out.length >= limit) break;
  }

  return out;
}

// ============================================================================
// queryHits — point probe → classified candidates, Z-sorted top-first
// ============================================================================

export interface QueryHitsOpts<K extends ObjectKind> {
  at: [number, number];
  /** Hit tolerance — `{ px }` is screen-space (divided by scale), `{ world }` is world units. */
  radius: Radius;
  filter?: NarrowingPredicate<ObjectHandle, HandleOf<K>>;
  where?: Predicate<HitCandidate<K>>;
  /** Sort comparator. Default: Z top-first. */
  comparator?: Comparator<HitCandidate<K>>;
  limit?: number;
}

export function queryHits<const K extends ObjectKind = ObjectKind>(opts: QueryHitsOpts<K>): HitCandidate<K>[] {
  const { at, radius, filter, where, comparator, limit } = opts;
  const [wx, wy] = at;
  const r = resolveRadius(radius);
  const entries = getSpatialIndex().queryRadius(wx, wy, r);
  const kindSet = readKindBrand(filter);
  const out: HitCandidate<K>[] = [];

  for (const e of entries) {
    if (kindSet && !kindSet.has(e.kind)) continue;
    const h = getHandle(e.id);
    if (!h) continue;
    if (filter && !filter(h)) continue;

    // SAFETY: KIND[h.kind] is the cap for h.kind; one cast per loop.
    const cap = KIND[h.kind] as AnyCapability;
    const fields = cap.hitPoint(h, [wx, wy], r);
    if (!fields) continue;

    const cand = { handle: h, ...fields } as HitCandidate<K>;
    if (where && !where(cand)) continue;
    out.push(cand);
    if (limit !== undefined && out.length >= limit) break;
  }

  if (comparator) {
    out.sort(comparator);
  } else {
    sortZTopFirst(out);
  }
  return out;
}
