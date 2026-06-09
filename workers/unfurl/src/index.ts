import { assertSurfaceMatch, createCors, cspHeaders, requireAuth, unfurlQuery, userRateLimiter } from '@avlo/worker-shared';
import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import type { UnfurlApp as PublicSurface } from './app-type';
import type { UnfurlEnv } from './env';
import { handleUnfurl } from './unfurl';

const app = new Hono<UnfurlEnv>()
  .use('*', createCors({ methods: ['GET'] }))
  .use('*', cspHeaders('api-json'))
  // GET fetches a remote URL + writes its OG image to R2 → H13 gate + tier-1 userId limiter.
  .get(
    '/',
    requireAuth<UnfurlEnv>(),
    userRateLimiter<UnfurlEnv>((c) => c.env.RL_UPLOAD),
    zValidator('query', unfurlQuery),
    (c) => handleUnfurl(c, c.req.valid('query').url),
  );

// Drift guard — see @avlo/worker-shared/surface-drift.
assertSurfaceMatch<typeof app, PublicSurface>(true);

export default app;
export type { UnfurlApp } from './app-type';
