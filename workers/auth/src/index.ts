import {
  assertSurfaceMatch,
  createCors,
  cspError,
  cspHeaders,
  devRequestLogger,
  ipRateLimiter,
  isAllowedOrigin,
  isDevHost,
} from '@avlo/worker-shared';
import type { MiddlewareHandler } from 'hono';
import { Hono } from 'hono';
import { csrf } from 'hono/csrf';
import type { AuthApp as PublicSurface } from './app-type';
import type { AuthEnv } from './env';
import { handleCallback } from './handlers/callback';
import { handleLogin } from './handlers/login';
import { handleLogout } from './handlers/logout';
import { handleMe } from './handlers/me';
import { AuthRpc } from './rpc';

// Identity responses and OAuth redirects must never be cached by any intermediary: /me is
// per-cookie identity, /login mints per-attempt secrets, and the callback 302 rides a URL
// that carried the authorization code. Egress-stamped like cspHeaders — nothing to forget.
const noStore: MiddlewareHandler = async (c, next) => {
  await next();
  c.res.headers.set('Cache-Control', 'no-store');
};

// IP-keyed (pre-auth routes have no userId). /me is deliberately NOT limited — it is every
// client's identity boot; a 10/min IP key would 429 whole NATs.
const rl = ipRateLimiter<AuthEnv>((c) => c.env.RL_AUTH);

const app = new Hono<AuthEnv>()
  .use('*', createCors({ methods: ['GET', 'POST'] }))
  .use('*', devRequestLogger()) // dev-only request log — dormant in prod (DEV_LOGS unset)
  .use('*', cspHeaders('api-json'))
  .use('*', noStore)
  // Skips GET/HEAD (the cross-site callback is unaffected); guards POST /logout against
  // cross-site form posts, reusing the CORS origin allowlist. This resolves the H-table
  // tripwire: the session cookie stays SameSite=Lax AND csrf now covers this worker.
  .use('*', csrf({ origin: (o, c) => isAllowedOrigin(o, isDevHost(c.req.header('host'))) !== null }))
  .get('/me', (c) => handleMe(c))
  .get('/login/google', rl, ...handleLogin)
  .get('/callback', rl, ...handleCallback)
  .post('/logout', rl, ...handleLogout);

// csrf throws (rather than returns), so its 403 skips the egress stamps — cspError
// re-applies the profile to thrown responses (and keeps Hono's log + 500 for the rest).
app.onError(cspError('api-json'));

// Drift guard vs the ./app-type mock (see @avlo/worker-shared/surface-drift).
assertSurfaceMatch<typeof app, PublicSurface>(true);

export default app;
export type { AuthApp } from './app-type';
export { AuthRpc };
