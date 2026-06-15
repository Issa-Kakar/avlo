import type { MiddlewareHandler } from 'hono';
import { logger } from 'hono/logger';

/**
 * Dev-only logging, gated by the orchestrator-injected `DEV_LOGS` binding.
 *
 * `scripts/dev-miniflare.mjs` sets `DEV_LOGS='1'` on every worker's bindings; prod
 * (`wrangler deploy`, no such var) leaves it undefined. So everything gated here is LIVE in
 * `npm run dev` and DORMANT in prod with NOTHING to remember before deploy — the "easy
 * cleanup pass" is nil. (The one exception is the queue projection summary in
 * `users/src/queue.ts`, which is always-on by design — counts + timing only, H10-safe.)
 *
 * `DEV_LOGS` is intentionally absent from every `wrangler.jsonc`, so it never reaches the
 * generated `Env` type — one localized cast here is the whole surface (mirrors the untyped
 * service-binding casts elsewhere). A raw `wrangler dev` on a single worker doesn't set it
 * either; there you get wrangler's own request UI instead.
 */
const isDevLogs = (env: unknown): boolean => !!(env as { DEV_LOGS?: unknown } | null | undefined)?.DEV_LOGS;

/**
 * Dev-only request log (method · path · status · ms, via `hono/logger`). Gated so prod NEVER
 * logs paths — room ids (`/sync/...`) and asset keys (`/:hash`) live there (H10). Register
 * right AFTER `createCors` (H6) so cors stays the first functional middleware:
 *   app.use('*', devRequestLogger())
 * Miniflare's own `Log` covers the entry worker (main); requests to the direct-socket workers
 * bypass that loopback, so this is what surfaces their per-request lines.
 */
export function devRequestLogger(): MiddlewareHandler {
  const log = logger();
  return (c, next) => (isDevLogs(c.env) ? log(c, next) : next());
}

/**
 * Dev-only Drizzle query logger for `drizzle(db, { logger: devDrizzleLogger(env, label) })`.
 * Logs SQL + bound params (params can carry user data → dev only). Structurally typed to
 * Drizzle's `Logger` so worker-shared needn't depend on drizzle-orm.
 */
export function devDrizzleLogger(env: unknown, label = '[db]'): { logQuery(query: string, params: unknown[]): void } | false {
  return isDevLogs(env) ? { logQuery: (q, p) => console.warn(label, q, p.length ? p : '') } : false;
}

/**
 * Trace a cross-worker / cross-script-DO RPC: `method → outcome · ms`. Dev-gated — calls like
 * `verifySession` fire on every gated request + WS connect, so always-on would flood prod logs
 * (and cost). H10-safe regardless (no args, no urls). Wrap the implementation:
 *   verifySession(cookie) { return traceRpc(this.env, 'auth.verifySession', () => this.#impl(cookie), r => r ? 'hit' : 'null') }
 * Errors are logged (the DO meta RPCs throw `forbidden`/`invalid-title` as
 * their wire contract — informative here) and rethrown unchanged, so callers' handling is
 * untouched. Non-dev path returns `fn()` directly — zero added overhead beyond one branch.
 */
export function traceRpc<T>(env: unknown, method: string, fn: () => Promise<T>, outcome?: (r: T) => string): Promise<T> {
  if (!isDevLogs(env)) return fn();
  const t0 = Date.now();
  return fn().then(
    (r) => {
      console.warn(`[rpc] ${method} → ${outcome ? outcome(r) : 'ok'} (${Date.now() - t0}ms)`);
      return r;
    },
    (e) => {
      console.warn(`[rpc] ${method} ✗ ${e instanceof Error ? e.message : 'error'} (${Date.now() - t0}ms)`);
      throw e;
    },
  );
}

export { isDevLogs };
