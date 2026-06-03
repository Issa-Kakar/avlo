import { assertSurfaceMatch, createCors } from '@avlo/worker-shared';
import { Hono } from 'hono';
import type { AuthApp as PublicSurface } from './app-type';
import { handleMe } from './handlers/me';
import { AuthRpc } from './rpc';

const app = new Hono<{ Bindings: Env }>().use('*', createCors('auth')).get('/me', (c) => handleMe(c));

// Drift guard — keeps the real app's path × method surface aligned with the
// public mock in ./app-type. See @avlo/worker-shared/surface-drift.
assertSurfaceMatch<typeof app, PublicSurface>(true);

export default app;
export { AuthRpc };
export type { AuthApp } from './app-type';
