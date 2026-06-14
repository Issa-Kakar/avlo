/**
 * WS path prefix for the realtime sync layer — the ONE string the client provider and the
 * `avlo-sync` worker must agree on. Cross-runtime + server-safe (no `import.meta.env`), so the
 * sync worker (`partyserverMiddleware` prefix) and the client (`y-partyserver` provider prefix)
 * both import it.
 *
 * Two consumers can't import it and so carry the literal `'sync'` with a matching comment:
 *   • `packages/api-client/src/sw-matchers.ts` — SW-graph code must not pull `@avlo/shared` into
 *     the SW bundle (the isolation grep); it path-matches the literal instead.
 *   • `web/vite.config.ts` / `scripts/*` — outside the TS source graph.
 */
export const SYNC_WS_PREFIX = 'sync';
