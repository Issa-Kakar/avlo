import { cors } from 'hono/cors';

const ALLOWED_PROD = new Set<string>(['https://avlo.io', 'https://www.avlo.io']);

/**
 * Dev iff the request's own `Host` is localhost/127.0.0.1 — mirrors `cookieOpts`' dev split.
 * Gating the localhost-origin allowance behind this means prod never reflects a `http://localhost:*`
 * origin against the credentialed `.avlo.io` cookie (a browser can't forge `Origin`, so this is
 * defense in depth, not a live hole).
 */
export const isDevHost = (host: string | undefined | null): boolean =>
  // Exact boundary, same discipline as isAllowedOrigin below: bare dev host + optional
  // numeric port ONLY (`localhost:3000.evil.com` passed the old startsWith check).
  !!host && /^(localhost|127\.0\.0\.1)(:\d{1,5})?$/.test(host);

/**
 * The single allowed-origin predicate, shared by CORS reflection and the csrf guard — one source
 * of truth for "an origin that is ours". Returns the reflected origin string (CORS needs it) or
 * `null`. `origin` is `''` (from cors) or `undefined` (from csrf) when the header is absent;
 * localhost is allowed only when the request is itself dev.
 */
export const isAllowedOrigin = (origin: string | undefined | null, isDev: boolean): string | null => {
  if (!origin) return null;
  // Exact origin shape, not a prefix — `http://localhost:3000.evil.com` passes a
  // startsWith check and would be reflected with credentials. Same boundary discipline
  // as isDevHost above; a browser Origin is scheme://host[:port], nothing more.
  if (isDev && /^http:\/\/localhost:\d{1,5}$/.test(origin)) return origin;
  if (ALLOWED_PROD.has(origin)) return origin;
  return null;
};

export interface CorsOptions {
  /** The non-OPTIONS verbs this worker serves. `OPTIONS` is appended for the preflight. */
  methods: readonly string[];
  /** Request headers the worker reads. Defaults to `['Content-Type']`. */
  allowHeaders?: readonly string[];
  /** Response headers the browser may read. Defaults to none. */
  exposeHeaders?: readonly string[];
}

/**
 * Per-worker CORS (H6, first middleware). Each worker advertises only the methods + headers it
 * actually uses — no shared catch-all surface. Reflected origin (never `*`) + `credentials` so the
 * SPA's cross-subdomain calls carry the `.avlo.io` cookie. Hono appends `Vary: Origin` automatically.
 */
export const createCors = ({ methods, allowHeaders = ['Content-Type'], exposeHeaders = [] }: CorsOptions) =>
  cors({
    origin: (origin, c) => isAllowedOrigin(origin, isDevHost(c.req.header('host'))),
    credentials: true,
    allowMethods: [...methods, 'OPTIONS'],
    allowHeaders: [...allowHeaders],
    exposeHeaders: [...exposeHeaders],
    maxAge: 86400,
  });
