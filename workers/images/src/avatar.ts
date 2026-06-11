import { avatarHashParam } from '@avlo/worker-shared';
import { zValidator } from '@hono/zod-validator';
import { createFactory } from 'hono/factory';
import type { ImagesEnv } from './env';

const factory = createFactory<ImagesEnv>();

/**
 * `GET /avatars/:hash` — public read of a snapshotted avatar, mirror of `get.ts` minus
 * Range (avatars are ≤1 MiB; partial content buys nothing). The key is write-once
 * content-addressed, so `immutable` caching is CORRECT end-to-end: edge cache, browser,
 * and the SW's cache-first images-origin handling all pin it forever — a changed photo
 * arrives as a NEW hash, never an invalidation. Capability = the unguessable 32-hex hash
 * (same posture as board assets; an auth gate would defeat edge + SW cacheability).
 * CSP via the route's `cspHeaders('asset-body')` — covers 200, 304, 404, and cache hits.
 */
export const handleGetAvatar = factory.createHandlers(zValidator('param', avatarHashParam), async (c) => {
  const { hash } = c.req.valid('param');

  const cache = caches.default;
  const cacheKey = new Request(c.req.url, { method: 'GET' });
  const cached = await cache.match(cacheKey).catch(() => null);
  if (cached) return cached;

  const object = await c.env.IMAGES.get(`avatars/${hash}`, {
    onlyIf: c.req.raw.headers, // R2 parses If-None-Match / If-Modified-Since
  });
  if (!object) return c.text('Not Found', 404);
  if (!('body' in object) || !object.body) return new Response(null, { status: 304 });

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('Cache-Control', 'public, max-age=31536000, immutable');
  headers.set('ETag', object.httpEtag);

  const [cacheBody, responseBody] = object.body.tee();
  c.executionCtx.waitUntil(cache.put(cacheKey, new Response(cacheBody, { headers: new Headers(headers), status: 200 })));
  return new Response(responseBody, { headers, status: 200 });
});
