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
export const IMAGES_ORIGIN = import.meta.env.PROD ? 'https://images.avlo.io' : '/api/images';
export const UNFURL_ORIGIN = import.meta.env.PROD ? 'https://unfurl.avlo.io' : '/api/unfurl';

// Sync host: SPA is same-origin with main worker in prod, so `window.location.host`
// works untouched. Exposed here only so the SW can match WSS by host.
export const SYNC_HOST_PROD: string | null = import.meta.env.PROD ? 'avlo.io' : null;
