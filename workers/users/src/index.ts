import {
  assertSurfaceMatch,
  createCors,
  cspError,
  cspHeaders,
  isAllowedOrigin,
  isDevHost,
  requireAuth,
  userRateLimiter,
} from '@avlo/worker-shared';
import { Hono } from 'hono';
import { csrf } from 'hono/csrf';
import type { UsersApp as PublicSurface } from './app-type';
import type { UsersEnv } from './env';
import { handleGetRooms, handleSetPermission } from './handlers/rooms';
import { consume } from './queue';
import { UsersRpc } from './rpc';

// cors first (short-circuits OPTIONS preflight) → api-json CSP on every returned response (incl.
// the requireAuth 401) → csrf gates the cross-origin PATCH, reusing the CORS origin allowlist,
// before we spend an AUTH RPC → verify the session into c.get('userId') → tier-1 RL_ROOMS → routes.
const app = new Hono<UsersEnv>()
  .use('*', createCors({ methods: ['GET', 'PATCH'], allowHeaders: ['Content-Type', 'x-d1-bookmark'], exposeHeaders: ['x-d1-bookmark'] }))
  .use('*', cspHeaders('api-json'))
  .use('*', csrf({ origin: (o, c) => isAllowedOrigin(o, isDevHost(c.req.header('host'))) !== null }))
  .use('*', requireAuth<UsersEnv>())
  .use(
    '*',
    userRateLimiter<UsersEnv>((c) => c.env.RL_ROOMS),
  )
  .get('/rooms', ...handleGetRooms)
  .patch('/rooms/:id/permission', ...handleSetPermission);

// csrf throws (rather than returns), so its 403 skips the cspHeaders egress stamp — cspError
// re-applies the profile to thrown responses (and keeps Hono's log + 500 for unexpected errors).
app.onError(cspError('api-json'));

// Drift guard — keeps the real app's path × method surface aligned with the
// public mock in ./app-type. See @avlo/worker-shared/surface-drift.
assertSurfaceMatch<typeof app, PublicSurface>(true);

// Default export carries BOTH the Hono fetch handler and the queue consumer (§5/§6) —
// one worker, two entry points (`switch(batch.queue)` inside `consume`).
export default { fetch: app.fetch, queue: consume };
export type { UsersApp } from './app-type';
export { UsersRpc };
