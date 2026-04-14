/**
 * Filter atoms for the spatial query pipeline.
 *
 * - `byKind` / `byKinds` are narrowing predicates whose return type flows
 *   through `queryHits` / `queryHandles` so call sites get the union
 *   automatically (no manual cast).
 * - `isBindable` reads from the central capability table — adding a new
 *   bindable kind is one edit in `kind-capability.ts`.
 * - `and`/`or`/`not`/`guardAnd` are tiny combinators for non-narrowing
 *   `where` clauses.
 */

import type { ObjectHandle, ObjectKind, BindableHandle, BindableKind } from '@/core/types/objects';
import type { HandleOf, NarrowingPredicate, Predicate } from './atoms';
import { KIND } from './kind-capability';

/**
 * Narrowing predicates produced by `byKind`/`byKinds`/`isBindable` carry a
 * hidden `__kinds` brand. The spatial-index prefilter in `object-query.ts`
 * reads it to skip whole categories of `IndexEntry` before any `getHandle()`
 * lookup. Untagged predicates work too — they just lose that pushdown.
 */
type KindBranded<F> = F & { __kinds: ReadonlySet<ObjectKind> };

function brand<F extends Function>(fn: F, kinds: ReadonlySet<ObjectKind>): KindBranded<F> {
  (fn as KindBranded<F>).__kinds = kinds;
  return fn as KindBranded<F>;
}

export function byKind<const K extends ObjectKind>(k: K): NarrowingPredicate<ObjectHandle, HandleOf<K>> {
  const guard = (h: ObjectHandle): h is HandleOf<K> => h.kind === k;
  return brand(guard, new Set<ObjectKind>([k]));
}

export function byKinds<const K extends readonly ObjectKind[]>(...ks: K): NarrowingPredicate<ObjectHandle, HandleOf<K[number]>> {
  const set = new Set<ObjectKind>(ks);
  const guard = (h: ObjectHandle): h is HandleOf<K[number]> => set.has(h.kind);
  return brand(guard, set);
}

const BINDABLE_SET: ReadonlySet<ObjectKind> = new Set<ObjectKind>(
  (Object.keys(KIND) as ObjectKind[]).filter((k) => KIND[k].bindable) as BindableKind[],
);

export const isBindable: NarrowingPredicate<ObjectHandle, BindableHandle> = brand(
  (h: ObjectHandle): h is BindableHandle => KIND[h.kind].bindable,
  BINDABLE_SET,
);

export function and<T>(...ps: Predicate<T>[]): Predicate<T> {
  return (x) => {
    for (const p of ps) if (!p(x)) return false;
    return true;
  };
}

export function or<T>(...ps: Predicate<T>[]): Predicate<T> {
  return (x) => {
    for (const p of ps) if (p(x)) return true;
    return false;
  };
}

export function not<T>(p: Predicate<T>): Predicate<T> {
  return (x) => !p(x);
}

/** Narrowing AND: `guard` narrows; `rest` further filters the narrowed set. */
export function guardAnd<T, U extends T>(guard: NarrowingPredicate<T, U>, ...rest: Predicate<U>[]): NarrowingPredicate<T, U> {
  return (x): x is U => {
    if (!guard(x)) return false;
    for (const p of rest) if (!p(x)) return false;
    return true;
  };
}
