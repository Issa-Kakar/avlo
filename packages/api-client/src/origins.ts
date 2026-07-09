/// <reference types="vite/client" />
// The triple-slash reference is file-scoped: it loads Vite's ImportMetaEnv
// augmentation only for this file, regardless of host tsconfig. Without it,
// `import.meta.env.*` fails to resolve when this file is path-mapped from
// outside a tsconfig `include` (e.g., when client typechecks api-client via
// the path mapping). Doesn't pollute consumers' globals — TS treats triple-
// slash refs as local to the file that contains them.

// DEPLOY TARGET — decoupled from Vite's build/optimization axis. `import.meta.env.PROD`
// answers "is this a minified build?" (TRUE for `vite build --mode preview` too), NOT
// "does this target production infra?" — conflating them made a local production-mode
// preview bake the prod subdomains and bypass the Vite `/api/*` proxy, so nothing
// resolved without deployed workers. Resolve off an explicit VITE_TARGET instead:
//   unset            → 'local'   — `vite dev` AND `vite build --mode preview`: same-origin
//                                  Vite proxy → local Miniflare; the SW matches `/api/*`.
//   VITE_TARGET=staging      (web/.env.staging,    `--mode staging`)      → *.staging.avlo.io
//   VITE_TARGET=production   (web/.env.production, the DEFAULT `vite build`) → *.avlo.io
// Vite statically substitutes the value at build; the `|| 'local'` fallback + the constant
// `local` flag dead-code-eliminate to a single branch per build (a preview bundle carries
// no prod URL at all — grep-verifiable).
//
// STAGING CHECKLIST — this file already resolves staging origins, but a staging DEPLOY also needs:
//   1. A per-target CSP. `web/public/_headers` HARDCODES prod hosts (script-src
//      https://py.avlo.io; connect-src … wss://sync.avlo.io; img-src https://images.avlo.io)
//      and would break any non-prod origin — template it by target before deploying staging.
//   2. wrangler `[env.staging]` blocks + staging R2 buckets across the workers.
//   3. Staging DNS + a staging `pnpm py:seed` (R2 is per-bucket).
type DeployTarget = 'local' | 'staging' | 'production';
const TARGET: DeployTarget = (import.meta.env.VITE_TARGET as DeployTarget | undefined) || 'local';
const local = TARGET === 'local';
const domain = TARGET === 'staging' ? 'staging.avlo.io' : 'avlo.io';

// Local origins MUST be absolute: `hc<App>('/api/images')[':key'].$url(...)` throws
// `Invalid URL` because Hono runs `new URL(path, base)` and a bare path is not a valid
// base. `location.origin` resolves in window, dedicated-worker, and SW global scopes —
// all three are where this module is consumed.
export const IMAGES_ORIGIN = local ? `${location.origin}/api/images` : `https://images.${domain}`;
export const UNFURL_ORIGIN = local ? `${location.origin}/api/unfurl` : `https://unfurl.${domain}`;
// Python runtime artifacts (immutable, content-hashed, anonymous GET). Consumed by the py
// supervisor (dedicated worker: fetch + Cache API) AND the SW's cache-first route — both
// must derive the same URLs so the shared `avlo-py-<hash>` cache keys line up.
export const PY_ORIGIN = local ? `${location.origin}/api/py` : `https://py.${domain}`;
// Credentialed subdomain workers (cookies ride via Domain=.avlo.io + CORS credentials).
// Local hits them through the Vite proxy (same-origin → cookies auto-attach); remote is a
// true cross-origin subdomain.
export const AUTH_ORIGIN = local ? `${location.origin}/api/auth` : `https://auth.${domain}`;
export const USERS_ORIGIN = local ? `${location.origin}/api/users` : `https://users.${domain}`;

// Sync host: the realtime layer lives on its own subdomain (sync.avlo.io) remotely — the SPA
// is cross-origin to it (the cookie still rides via Domain=.avlo.io + SameSite=Lax same-site).
// Drives the client WS provider host AND lets the SW match WSS by host. null for local → the
// provider falls back to `window.location.host`, so the upgrade reaches the sync worker via the
// Vite `/sync` proxy.
export const SYNC_HOST: string | null = local ? null : `sync.${domain}`;
