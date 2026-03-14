import type { Context } from 'hono';
import { validateImage } from '@avlo/shared';

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

const ALLOWED_ORIGINS = new Set(['https://avlo.io']);

function isAllowedOrigin(origin: string | null): boolean {
  if (!origin) return false;
  if (origin.startsWith('http://localhost:')) return true;
  return ALLOWED_ORIGINS.has(origin);
}

// --- PUT /api/assets/:key ---

export const handleUpload = async (c: Context<{ Bindings: Env }>) => {
  try {
    const origin = c.req.header('origin') ?? null;
    if (!isAllowedOrigin(origin)) {
      return c.json({ error: 'forbidden' }, 403);
    }

    const key = c.req.param('key')!;

    // Dedup check — avoid reading body if already stored
    if (await c.env.ASSETS.head(key)) {
      return c.json({ key, status: 'exists' }, 200);
    }

    const buffer = await c.req.arrayBuffer();
    if (buffer.byteLength > MAX_FILE_SIZE) {
      return c.json({ error: 'file too large (10 MB max)' }, 413);
    }

    const bytes = new Uint8Array(buffer);
    const { valid, mimeType } = validateImage(bytes);
    if (!valid) {
      return c.json({ error: 'unsupported image format' }, 400);
    }

    // Verify content-addressed key — never trust client-provided hash
    const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
    const hashArray = new Uint8Array(hashBuffer);
    let computedKey = '';
    for (let i = 0; i < hashArray.length; i++) {
      computedKey += hashArray[i].toString(16).padStart(2, '0');
    }
    if (computedKey !== key) {
      return c.json({ error: 'key mismatch' }, 400);
    }

    await c.env.ASSETS.put(key, buffer, {
      httpMetadata: { contentType: mimeType },
    });

    return c.json({ key, status: 'created' }, 201);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[assets/upload]', err);
    return c.json({ error: message }, 500);
  }
};

// --- GET /api/assets/:key — edge-cached R2 proxy ---

export const handleGetAsset = async (c: Context<{ Bindings: Env }>) => {
  try {
    const key = c.req.param('key')!;

    // Edge cache check
    const cacheKey = new Request(c.req.url, { method: 'GET' });
    let cache: Cache | null = null;
    try {
      cache = caches.default;
      const cached = await cache.match(cacheKey);
      if (cached) return cached;
    } catch { cache = null; }

    // R2 handles range + conditional parsing from raw headers
    const object = await c.env.ASSETS.get(key, {
      range: c.req.raw.headers,
      onlyIf: c.req.raw.headers,
    });
    if (!object) return c.text('Not Found', 404);

    // 304 Not Modified
    if (!('body' in object) || !object.body) {
      return new Response(null, { status: 304 });
    }

    // R2 writes Content-Type etc. from stored httpMetadata
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set('Cache-Control', 'public, max-age=31536000, immutable');
    headers.set('ETag', object.httpEtag);
    headers.set('Content-Security-Policy', "default-src 'none'");
    headers.set('X-Content-Type-Options', 'nosniff');

    // Content-Range for partial responses
    let contentRange: string | undefined;
    if (object.range) {
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

    // Edge cache population on full 200
    if (status === 200 && cache) {
      const [cacheBody, responseBody] = object.body.tee();
      c.executionCtx.waitUntil(
        cache.put(cacheKey, new Response(cacheBody, { headers: new Headers(headers), status }))
      );
      return new Response(responseBody, { headers, status });
    }

    return new Response(object.body, { headers, status });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[assets/get]', err);
    return c.json({ error: message }, 500);
  }
};
