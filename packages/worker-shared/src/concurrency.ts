/**
 * Bounded-concurrency map — a dependency-free worker pool over a shared index cursor.
 * `limit` workers each pull the next index and run `fn`, so at most `limit` calls are in
 * flight at once. Results are returned in input order (each worker writes its own slot).
 *
 * Sole consumer today: the second-device ownership migration (§9) — the synchronous
 * fan-out in `users/rpc.ts` and the queue sweep branch both fan out `migrateOwner` DO
 * RPCs across many rooms without hammering N cold DOs at once. `fn` is expected to settle
 * (the migration wraps each call in `withRetry`); a rejection propagates out of the
 * returned promise (Promise.all semantics), so callers that must not abort the batch
 * should make `fn` itself never reject.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < items.length) {
      const i = cursor++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
