/**
 * Type-level sanity checks for the spatial query pipeline.
 *
 * This file is checked by `tsc` but produces no runtime code (the bodies are
 * unreachable). If a type assertion below fails to compile, the public type
 * surface of `queryHits` / `queryHandles` / `hitNearest` regressed.
 */

import type { ObjectHandle, BindableHandle } from '@/core/types/objects';
import type { HandleId } from '@/tools/types';

import { queryHits, queryHandles } from './object-query';
import { byKind, byKinds, isBindable } from './filters';
import { atPoint, inBBox } from './region';
import { hitNearest, type HandleProbe } from './handle-hit';
import type { HitCandidate } from './kind-capability';

type Eq<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
function expectType<T>(_v: T): void {
  /* type-only */
}
function assertEq<A, B>(_proof: Eq<A, B>): void {
  /* type-only */
}

// Guard against accidental execution: this entire file is dead code at runtime.
if (false as boolean) {
  // queryHits with `byKind` narrows to a single-kind candidate array.
  const shapes = queryHits({ at: [0, 0], radius: { px: 5 }, filter: byKind('shape') });
  expectType<HitCandidate<'shape'>[]>(shapes);
  assertEq<typeof shapes, HitCandidate<'shape'>[]>(true);

  // queryHits with variadic `byKinds` produces a union candidate.
  const mixed = queryHits({ at: [0, 0], radius: { world: 5 }, filter: byKinds('shape', 'text') });
  expectType<HitCandidate<'shape' | 'text'>[]>(mixed);
  assertEq<typeof mixed, HitCandidate<'shape' | 'text'>[]>(true);
  // The handle's `kind` is the inferred union — no manual cast required.
  const k: 'shape' | 'text' | undefined = mixed[0]?.handle.kind;
  expectType<'shape' | 'text' | undefined>(k);

  // queryHandles default returns a generic ObjectHandle list.
  const inBox = queryHandles({ region: inBBox([0, 0, 10, 10]), precise: 'rect' });
  expectType<ObjectHandle[]>(inBox);

  // queryHandles with `isBindable` narrows to BindableHandle.
  const bindables = queryHandles({
    region: atPoint([0, 0], { px: 5 }),
    precise: 'circle',
    filter: isBindable,
  });
  expectType<BindableHandle[]>(bindables);
  assertEq<typeof bindables, BindableHandle[]>(true);

  // hitNearest returns the probe value (or null), generically inferred.
  const probes: HandleProbe<HandleId>[] = [];
  const hit = hitNearest({ at: [0, 0], radius: { px: 10 }, probes });
  expectType<HandleId | null>(hit);
  assertEq<typeof hit, HandleId | null>(true);
}
