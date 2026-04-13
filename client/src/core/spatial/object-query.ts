/**
 * Object Query Facade — bridges spatial index → handles → per-object hit testing.
 *
 * The single module that imports `getSpatialIndex`/`getHandle` from room-runtime
 * into the core query layer. Keeps ObjectSpatialIndex as a pure rbush wrapper.
 *
 * Dependency direction: core/spatial/object-query.ts → core/geometry/hit-testing.ts
 * and core/geometry/object-pick.ts. geometry/ never imports from spatial/.
 */

import type { ObjectHandle, ObjectKind } from '@/core/types/objects';
import type { BBoxTuple } from '@/core/types/geometry';
import { getSpatialIndex, getHandle } from '@/runtime/room-runtime';
import { testObjectHit, type HitCandidate } from '@/core/geometry/hit-testing';
import { sortZTopFirst } from '@/core/geometry/object-pick';

/**
 * Query hit candidates within radius around a point.
 *
 * Spatial index radius query → per-handle testObjectHit → Z-sorted top-first.
 * The optional `kinds` array filters at the IndexEntry layer (before any
 * handle lookup or hit-test math) and propagates kind narrowing into the
 * returned HitCandidate array.
 */
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
    const c = testObjectHit(wx, wy, r, h);
    if (c) out.push(c);
  }
  return sortZTopFirst(out);
}

/**
 * Marquee/selection variant: rect query, no per-object hit test.
 * Returns raw handles (not candidates) for geometry intersection testing downstream.
 * Kind filter runs at the IndexEntry layer (before getHandle).
 */
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
