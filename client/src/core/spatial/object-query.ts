/**
 * Object Query Facade — bridges spatial index → handles → per-kind dispatch.
 *
 * The single module that imports `getSpatialIndex`/`getHandle` from room-runtime
 * into the core query layer. Keeps `ObjectSpatialIndex` as a pure rbush wrapper.
 *
 * Two sibling entry points, intentionally separate (their return shapes differ
 * semantically — forcing them through one conditional-typed function makes
 * inference fragile):
 *
 *   queryHandles(opts)   — returns raw handles, optionally narrowed
 *                          (marquee, region membership, eraser circle)
 *   queryHits(opts)      — returns classified, Z-sorted hit candidates
 *                          (clicks, snap, visible-kind lookups)
 *
 * Filters narrow the generic; `where` is a non-narrowing post-filter; the
 * `precise` selector picks which capability geometry to dispatch.
 *
 * The legacy `queryHitCandidates`/`queryHandlesInBBox` functions are kept as
 * thin shims to avoid a big-bang call-site rewrite.
 */

import type { ObjectHandle, ObjectKind } from '@/core/types/objects';
import type { BBoxTuple } from '@/core/types/geometry';
import { getSpatialIndex, getHandle } from '@/runtime/room-runtime';
import { type HitCandidate } from '@/core/geometry/hit-testing';
import type { Comparator, HandleOf, NarrowingPredicate, Predicate } from './atoms';
import type { Region } from './region';
import { regionEnvelope } from './region';
import { KIND, type AnyCapability } from './kind-capability';
import { sortZTopFirst, byZOrderTopFirst } from './pickers';

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
  radius: number;
  filter?: NarrowingPredicate<ObjectHandle, HandleOf<K>>;
  where?: Predicate<HitCandidate<K>>;
  /** Sort comparator. Default: Z top-first. */
  comparator?: Comparator<HitCandidate<K>>;
  limit?: number;
}

export function queryHits<const K extends ObjectKind = ObjectKind>(opts: QueryHitsOpts<K>): HitCandidate<K>[] {
  const { at, radius, filter, where, comparator, limit } = opts;
  const [wx, wy] = at;
  const entries = getSpatialIndex().queryRadius(wx, wy, radius);
  const kindSet = readKindBrand(filter);
  const out: HitCandidate<K>[] = [];

  for (const e of entries) {
    if (kindSet && !kindSet.has(e.kind)) continue;
    const h = getHandle(e.id);
    if (!h) continue;
    if (filter && !filter(h)) continue;

    // SAFETY: KIND[h.kind] is the cap for h.kind; one cast per loop.
    const cap = KIND[h.kind] as AnyCapability;
    const fields = cap.hitPoint(h, [wx, wy], radius);
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

// ============================================================================
// Backward-compat shims — call sites can migrate incrementally.
// ============================================================================

export function queryHitCandidates(wx: number, wy: number, r: number): HitCandidate[];
export function queryHitCandidates<K extends ObjectKind>(wx: number, wy: number, r: number, kinds: readonly K[]): HitCandidate<K>[];
export function queryHitCandidates(wx: number, wy: number, r: number, kinds?: readonly ObjectKind[]): HitCandidate[] {
  const entries = getSpatialIndex().queryRadius(wx, wy, r);
  const kindSet = kinds ? new Set<ObjectKind>(kinds) : null;
  const out: HitCandidate[] = [];
  for (const e of entries) {
    if (kindSet && !kindSet.has(e.kind)) continue;
    const h = getHandle(e.id);
    if (!h) continue;
    const cap = KIND[h.kind] as AnyCapability;
    const fields = cap.hitPoint(h, [wx, wy], r);
    if (!fields) continue;
    out.push({ handle: h, ...fields } as HitCandidate);
  }
  out.sort(byZOrderTopFirst);
  return out;
}

export function queryHandlesInBBox(bbox: BBoxTuple): ObjectHandle[];
export function queryHandlesInBBox<K extends ObjectKind>(bbox: BBoxTuple, kinds: readonly K[]): (ObjectHandle & { kind: K })[];
export function queryHandlesInBBox(bbox: BBoxTuple, kinds?: readonly ObjectKind[]): ObjectHandle[] {
  const entries = getSpatialIndex().queryBBox(bbox);
  const kindSet = kinds ? new Set<ObjectKind>(kinds) : null;
  const out: ObjectHandle[] = [];
  for (const e of entries) {
    if (kindSet && !kindSet.has(e.kind)) continue;
    const h = getHandle(e.id);
    if (h) out.push(h);
  }
  return out;
}
