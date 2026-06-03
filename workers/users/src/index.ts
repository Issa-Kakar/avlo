import { assertSurfaceMatch, createCors, requireAuth, userRateLimiter } from '@avlo/worker-shared';
import { Hono } from 'hono';
import type { UsersApp as PublicSurface } from './app-type';
import type { UsersEnv } from './env';
import { handleGetRooms, handleSetPermission } from './handlers/rooms';
import { consume } from './queue';
import { UsersRpc } from './rpc';

// cors first (short-circuits OPTIONS preflight before the auth gate) → verify the session
// into c.get('userId') (401 if absent) → tier-1 RL_ROOMS (keyed on that userId) → routes.
const app = new Hono<UsersEnv>()
  .use('*', createCors('users'))
  .use('*', requireAuth<UsersEnv>())
  .use('*', userRateLimiter<UsersEnv>((c) => c.env.RL_ROOMS))
  .get('/rooms', ...handleGetRooms)
  .patch('/rooms/:id/permission', ...handleSetPermission);

// Drift guard — keeps the real app's path × method surface aligned with the
// public mock in ./app-type. See @avlo/worker-shared/surface-drift.
assertSurfaceMatch<typeof app, PublicSurface>(true);

// Default export carries BOTH the Hono fetch handler and the queue consumer (§5/§6) —
// one worker, two entry points (`switch(batch.queue)` inside `consume`).
export default { fetch: app.fetch, queue: consume };
export { UsersRpc };
export type { UsersApp } from './app-type';
