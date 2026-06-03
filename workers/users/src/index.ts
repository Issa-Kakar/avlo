import { assertSurfaceMatch, createCors } from '@avlo/worker-shared';
import { Hono } from 'hono';
import type { RoomListResponse, UsersApp as PublicSurface } from './app-type';
import { UsersRpc } from './rpc';

const app = new Hono<{ Bindings: Env }>().use('*', createCors('users')).get('/rooms', (c) => {
  // Step 4 implements the D1 Sessions-API dashboard query (auth-gated, §4).
  // Placeholder until then.
  const body: RoomListResponse = { rooms: [], bookmark: '' };
  return c.json(body);
});

// Drift guard — keeps the real app's path × method surface aligned with the
// public mock in ./app-type. See @avlo/worker-shared/surface-drift.
assertSurfaceMatch<typeof app, PublicSurface>(true);

export default app;
export { UsersRpc };
export type { UsersApp } from './app-type';
