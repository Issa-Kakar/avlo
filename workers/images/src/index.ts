import { assertSurfaceMatch, createCors, requireAuth, userRateLimiter } from '@avlo/worker-shared';
import { Hono } from 'hono';
import type { ImagesApp as PublicSurface } from './app-type';
import type { ImagesEnv } from './env';
import { handleGetAsset } from './get';
import { handleUpload } from './upload';

const app = new Hono<ImagesEnv>()
  .use('*', createCors('images'))
  // PUT writes to R2 → H13 gate (verified session) + tier-1 userId rate limiter (RL_UPLOAD).
  // requireAuth runs first so the limiter has a userId to key on.
  .put('/:key', requireAuth<ImagesEnv>(), userRateLimiter<ImagesEnv>((c) => c.env.RL_UPLOAD), ...handleUpload)
  // GET is the anonymous content-addressed read — it opts OUT of the userId gate + limiter
  // (H13): the response is cache-served + WAF-perimetered, and there is no per-user budget
  // to charge a content-hash fetch against.
  .get('/:key', ...handleGetAsset);

// Drift guard — keeps the real app's path × method surface aligned with the
// public mock in ./app-type. See @avlo/worker-shared/surface-drift.
assertSurfaceMatch<typeof app, PublicSurface>(true);

export default app;
export type { ImagesApp } from './app-type';
