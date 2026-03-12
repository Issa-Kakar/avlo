import { Hono } from 'hono';
import { validateImage } from '../lib/image-validation';

const assets = new Hono<{ Bindings: Env }>();

/** POST /upload — multipart form with `file` field */
assets.post('/upload', async (c) => {
  const form = await c.req.formData();
  const file = form.get('file');
  if (!(file instanceof File)) {
    return c.json({ error: 'missing file field' }, 400);
  }

  const buffer = await file.arrayBuffer();
  const { valid, mimeType } = validateImage(new Uint8Array(buffer));
  if (!valid) {
    return c.json({ error: 'unsupported image format' }, 400);
  }

  // Content-addressed key via SHA-256
  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
  const hashArray = new Uint8Array(hashBuffer);
  let key = '';
  for (let i = 0; i < hashArray.length; i++) {
    key += hashArray[i].toString(16).padStart(2, '0');
  }

  // Dedup check
  const existing = await c.env.ASSETS.head(key);
  if (existing) {
    return c.json({ key, status: 'exists' }, 409);
  }

  await c.env.ASSETS.put(key, buffer, {
    httpMetadata: { contentType: mimeType },
  });

  return c.json({ key, status: 'created' }, 201);
});

/** GET /:key — R2 read-through (dev fallback; prod uses CDN domain) */
assets.get('/:key', async (c) => {
  const key = c.req.param('key');
  const object = await c.env.ASSETS.get(key);
  if (!object) {
    return c.text('Not Found', 404);
  }

  const headers = new Headers();
  headers.set('Content-Type', object.httpMetadata?.contentType || 'application/octet-stream');
  headers.set('Cache-Control', 'public, max-age=31536000, immutable');

  return new Response(object.body, { headers });
});

export default assets;
