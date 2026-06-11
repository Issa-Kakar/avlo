/**
 * Transient-failure retry for IDEMPOTENT infrastructure ops only — KV put/delete, R2 put,
 * GET fetch. Full-jitter exponential backoff, 100 ms base / 800 ms cap (mirrors
 * `@avlo/db.withRetry`'s curve). Unlike that helper it retries ANY error: the ops it wraps
 * have no deterministic failure mode worth short-circuiting on (a malformed KV put is a
 * programming bug, not a 4xx to classify), and the D1-specific transient regex must not
 * leak outside `@avlo/db` (users-worker-only). NEVER wrap a non-idempotent call — the
 * OAuth token exchange (single-use code) is the canonical counter-example.
 */
export async function retryTransient<T>(fn: () => Promise<T>, maxAttempts = 3): Promise<T> {
  const base = 100;
  const maxDelay = 800;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === maxAttempts) throw err;
      const delay = Math.floor(Math.random() * Math.min(maxDelay, base * 2 ** (attempt - 1)));
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
    }
  }
}
