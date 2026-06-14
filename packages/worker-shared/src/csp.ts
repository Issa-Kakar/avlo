// SPA HTTP headers are NOT set by a worker. The `avlo` site worker is assets-only (no
// worker script at all), so SPA-level CSP, COOP, COEP, and X-Content-Type-Options live in
// `web/public/_headers`, applied by the Static Assets layer to all matching responses.

import type { MiddlewareHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';

export type CspProfile = 'asset-body' | 'api-json';

const PROFILES: Record<CspProfile, Record<string, string>> = {
  'asset-body': {
    'Content-Security-Policy': "default-src 'none'; sandbox",
    'X-Content-Type-Options': 'nosniff',
    'Cross-Origin-Resource-Policy': 'cross-origin',
  },
  'api-json': {
    'X-Content-Type-Options': 'nosniff',
    'Cross-Origin-Resource-Policy': 'same-site',
    'Referrer-Policy': 'no-referrer',
  },
};

export function applyCsp(headers: Headers, profile: CspProfile): void {
  for (const [k, v] of Object.entries(PROFILES[profile])) headers.set(k, v);
}

/**
 * Egress-middleware form of `applyCsp` (H5) — stamps the profile on `c.res` AFTER the handler,
 * so every *returned* response carries it without a per-handler call to forget: success bodies,
 * the 304/404 early returns, the `requireAuth` 401, a rate-limit 429. Register it early (right
 * after `createCors`) so its post-`next()` wraps those inner returns.
 *
 * Mutating `c.res.headers` post-`next()` is safe even on a `cache.match()` hit: `createCors`
 * (always first) touches `c.res` before `next()`, so Hono rebuilds the response via `new Response`
 * on assignment, yielding a mutable `Headers`. This is the same pattern the cors middleware itself
 * uses. Thrown `HTTPException`s (csrf's 403) bypass this line — stamp those via `app.onError`.
 */
export const cspHeaders =
  (profile: CspProfile): MiddlewareHandler =>
  async (c, next) => {
    await next();
    applyCsp(c.res.headers, profile);
  };

/**
 * `app.onError` companion to `cspHeaders`. csrf throws an `HTTPException` (it does not return), so
 * its 403 bypasses the egress middleware — this stamps the profile on that thrown response. Other
 * (unexpected) errors keep Hono's default behaviour — `console.error` + 500, so a custom handler
 * doesn't go dark on a D1/R2 outage — and get the profile too. `app.onError(cspError('api-json'))`.
 */
export const cspError =
  (profile: CspProfile) =>
  (err: Error): Response => {
    if (err instanceof HTTPException) {
      const res = err.getResponse();
      applyCsp(res.headers, profile);
      return res;
    }
    console.error(err);
    const res = new Response('Internal Server Error', { status: 500 });
    applyCsp(res.headers, profile);
    return res;
  };
