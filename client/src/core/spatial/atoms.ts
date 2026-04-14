/**
 * Type atoms for the spatial query pipeline.
 *
 * Generic, kind-agnostic building blocks: handles narrowed by kind, predicates
 * (narrowing and non-narrowing), scorers, comparators, transforms, pickers, and
 * the `Paint` classification used by Z-order pickers.
 */

import type { ObjectHandle, ObjectKind } from '@/core/types/objects';

export type HandleOf<K extends ObjectKind> = ObjectHandle & { kind: K };
export type KindOf<H extends ObjectHandle> = H['kind'];

export type Predicate<T> = (x: T) => boolean;
export type NarrowingPredicate<T, U extends T> = (x: T) => x is U;

export type Scorer<T> = (x: T) => number;
export type Comparator<T> = (a: T, b: T) => number;
export type Transform<T, U> = (x: T) => U | null;
export type Picker<C, R = C | null> = (cands: readonly C[]) => R;

/** Paint classification used by occlusion-aware pickers. */
export type Paint = 'ink' | 'fill' | null;
