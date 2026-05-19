import { assertSurfaceMatch, createCors, unfurlQuery } from '@avlo/worker-shared';
import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import type { UnfurlApp as PublicSurface } from './app-type';
import { handleUnfurl } from './unfurl';

const app = new Hono<{ Bindings: Env }>()
  .use('*', createCors('unfurl'))
  .get('/', zValidator('query', unfurlQuery), (c) => handleUnfurl(c, c.req.valid('query').url));

// Drift guard — see @avlo/worker-shared/surface-drift.
assertSurfaceMatch<typeof app, PublicSurface>(true);

export default app;
export type { UnfurlApp } from './app-type';
