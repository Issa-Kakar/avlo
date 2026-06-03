import { applyCsp, assetKeyParam } from '@avlo/worker-shared';
import { zValidator } from '@hono/zod-validator';
import { createFactory } from 'hono/factory';
import type { ImagesEnv } from './env';

const factory = createFactory<ImagesEnv>();

export const handleGetAsset = factory.createHandlers(zValidator('param', assetKeyParam), async (c) => {
  const { key } = c.req.valid('param');

  // Skip caches.default for Range — full-body cached entries served back to Range
  // requests would silently satisfy RFC 9110 but defeat partial-content workflows.
  const hasRange = c.req.raw.headers.has('Range');
  const cache = hasRange ? null : caches.default;
  const cacheKey = cache ? new Request(c.req.url, { method: 'GET' }) : null;
  if (cache && cacheKey) {
    const cached = await cache.match(cacheKey).catch(() => null);
    if (cached) return cached;
  }

  // Only forward the headers to R2's range parser when the client actually sent
  // a Range — miniflare's R2 simulator always populates `object.range` (defaulting
  // to `{ offset: 0, length: size }` when no Range was requested), and any
  // downstream code that conflates "object.range is truthy" with "client asked for
  // partial content" leaks 206s into no-Range fetches in dev.
  const object = await c.env.IMAGES.get(key, {
    range: hasRange ? c.req.raw.headers : undefined,
    onlyIf: c.req.raw.headers, // R2 parses If-None-Match / If-Modified-Since
  });
  if (!object) return c.text('Not Found', 404);
  if (!('body' in object) || !object.body) return new Response(null, { status: 304 });

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('Cache-Control', 'public, max-age=31536000, immutable');
  headers.set('ETag', object.httpEtag);
  headers.set('Accept-Ranges', 'bytes'); // capability advertisement
  applyCsp(headers, 'asset-body');

  // Compute Content-Range / 206 only when the client opted in via Range. The
  // start !== 0 || end !== size - 1 guard then handles the legitimate case of
  // a Range that happens to cover the whole object (e.g., `bytes=0-`).
  let contentRange: string | undefined;
  if (hasRange && object.range) {
    if ('suffix' in object.range) {
      const start = object.size - object.range.suffix;
      contentRange = `bytes ${start}-${object.size - 1}/${object.size}`;
    } else {
      const start = object.range.offset ?? 0;
      const end = object.range.length ? start + object.range.length - 1 : object.size - 1;
      if (start !== 0 || end !== object.size - 1) {
        contentRange = `bytes ${start}-${end}/${object.size}`;
      }
    }
    if (contentRange) headers.set('Content-Range', contentRange);
  }

  const status = contentRange ? 206 : 200;
  if (status === 200 && cache && cacheKey) {
    const [cacheBody, responseBody] = object.body.tee();
    c.executionCtx.waitUntil(cache.put(cacheKey, new Response(cacheBody, { headers: new Headers(headers), status })));
    return new Response(responseBody, { headers, status });
  }
  return new Response(object.body, { headers, status });
});
