/// <reference types="vite/client" />
// The triple-slash reference is file-scoped: it loads Vite's ImportMetaEnv
// augmentation only for this file, regardless of host tsconfig. Without it,
// `import.meta.env.PROD` fails to resolve when this file is path-mapped from
// outside a tsconfig `include` (e.g., when client typechecks api-client via
// the path mapping). Doesn't pollute consumers' globals — TS treats triple-
// slash refs as local to the file that contains them.

// Vite substitutes `import.meta.env.PROD` at build time. The main bundle, web
// workers, and the SW rollup entry all receive the substitution — one file,
// one source of truth.
//
// Dev origins MUST be absolute: `hc<App>('/api/images')[':key'].$url(...)`
// throws `Invalid URL` because Hono runs `new URL(path, base)` and a bare
// path is not a valid base. `location.origin` resolves in window, dedicated-
// worker, and SW global scopes (all three are where this module is consumed).
export const IMAGES_ORIGIN = import.meta.env.PROD ? 'https://images.avlo.io' : `${location.origin}/api/images`;
export const UNFURL_ORIGIN = import.meta.env.PROD ? 'https://unfurl.avlo.io' : `${location.origin}/api/unfurl`;
// Credentialed subdomain workers (cookies ride via Domain=.avlo.io + CORS
// credentials). Dev hits them through the Vite proxy (same-origin → cookies
// auto-attach); prod is a true cross-origin subdomain.
export const AUTH_ORIGIN = import.meta.env.PROD ? 'https://auth.avlo.io' : `${location.origin}/api/auth`;
export const USERS_ORIGIN = import.meta.env.PROD ? 'https://users.avlo.io' : `${location.origin}/api/users`;

// Sync host: the realtime layer lives on its own subdomain (sync.avlo.io) in prod — the SPA is
// cross-origin to it (the cookie still rides via Domain=.avlo.io + SameSite=Lax same-site). Drives
// the client WS provider host AND lets the SW match WSS by host. null in dev → the provider falls
// back to `window.location.host` so the upgrade reaches the sync worker via the Vite `/sync` proxy.
export const SYNC_HOST_PROD: string | null = import.meta.env.PROD ? 'sync.avlo.io' : null;

// AI host: same model as sync — WSS-primary (Agents SDK /agents/* — WS + the chat HTTP
// endpoints share the prefix), cross-origin in prod (cookie rides Domain=.avlo.io +
// SameSite=Lax same-site). null in dev → useAgent falls back to `window.location.host`
// so both the upgrade and HTTP hit the ai worker via the Vite `/agents` proxy.
export const AI_HOST_PROD: string | null = import.meta.env.PROD ? 'ai.avlo.io' : null;
