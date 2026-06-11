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
import type { ImagesApp as PublicSurface } from './app-type';
import { handleGetAvatar } from './avatar';
import type { ImagesEnv } from './env';
import { handleGetAsset } from './get';
import { ImagesRpc } from './rpc';
import { handleUpload } from './upload';

const app = new Hono<ImagesEnv>()
  .use(
    '*',
    createCors({
      methods: ['GET', 'PUT'],
      allowHeaders: ['Content-Type', 'Content-Length', 'Range', 'If-None-Match', 'If-Modified-Since'],
      exposeHeaders: ['ETag', 'Content-Range', 'Accept-Ranges'],
    }),
  )
  // PUT writes to R2 → api-json CSP on every return + csrf gate (reusing the CORS origin allowlist)
  // + H13 gate (verified session) + tier-1 userId limiter (RL_UPLOAD). requireAuth runs before the
  // limiter so it has a userId to key on.
  .put(
    '/:key',
    cspHeaders('api-json'),
    csrf({ origin: (o, c) => isAllowedOrigin(o, isDevHost(c.req.header('host'))) !== null }),
    requireAuth<ImagesEnv>(),
    userRateLimiter<ImagesEnv>((c) => c.env.RL_UPLOAD),
    ...handleUpload,
  )
  // GET is the anonymous content-addressed read — asset-body CSP covers 200/206, the 304/404 early
  // returns, AND cache hits. It opts OUT of the userId gate + limiter (H13): the response is
  // cache-served + WAF-perimetered, with no per-user budget to charge a content-hash fetch against.
  .get('/:key', cspHeaders('asset-body'), ...handleGetAsset)
  // Avatar read — same anonymous content-addressed posture (write-once `avatars/` key, the
  // unguessable hash is the capability). Two segments, so no collision with `/:key` above.
  .get('/avatars/:hash', cspHeaders('asset-body'), ...handleGetAvatar);

// csrf throws (rather than returns) → its 403 skips the cspHeaders egress stamp; cspError re-applies
// the profile to thrown responses (and keeps Hono's log + 500 for unexpected errors).
app.onError(cspError('api-json'));

// Drift guard — keeps the real app's path × method surface aligned with the
// public mock in ./app-type. See @avlo/worker-shared/surface-drift.
assertSurfaceMatch<typeof app, PublicSurface>(true);

export default app;
export type { ImagesApp } from './app-type';
export { ImagesRpc };
