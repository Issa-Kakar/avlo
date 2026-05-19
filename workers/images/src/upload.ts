import { validateImage } from '@avlo/shared';
import { applyCsp, assetKeyParam, contentLengthBound, MAX_UPLOAD_BYTES } from '@avlo/worker-shared';
import { zValidator } from '@hono/zod-validator';
import { createFactory } from 'hono/factory';

const factory = createFactory<{ Bindings: Env }>();

export const handleUpload = factory.createHandlers(
  zValidator('param', assetKeyParam), // H1: 400 fast on malformed key
  zValidator('header', contentLengthBound(MAX_UPLOAD_BYTES)), // H2: reject oversize at header level
  async (c) => {
    const { key } = c.req.valid('param');

    // 1. Dedup BEFORE reading body — saves the entire upload on duplicates.
    if (await c.env.IMAGES.head(key)) {
      return c.json({ key, status: 'exists' as const }, 200);
    }

    // 2. Content-Length already bounded by the zValidator above.
    const buffer = await c.req.arrayBuffer();

    // 3. Magic-byte sniff (allow-list of image formats).
    const bytes = new Uint8Array(buffer);
    const { valid, mimeType } = validateImage(bytes);
    if (!valid) return c.json({ error: 'unsupported image format' }, 400);

    // 4. Hash-verify: content-addressed key must equal computed hash. NEVER trust client.
    const computed = await sha256Hex(buffer);
    if (computed !== key) return c.json({ error: 'key mismatch' }, 400);

    // 5. Persist.
    await c.env.IMAGES.put(key, buffer, { httpMetadata: { contentType: mimeType } });

    const headers = new Headers({ 'Content-Type': 'application/json' });
    applyCsp(headers, 'api-json');
    return new Response(JSON.stringify({ key, status: 'created' }), { status: 201, headers });
  },
);

async function sha256Hex(buffer: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  const arr = new Uint8Array(digest);
  let hex = '';
  for (let i = 0; i < arr.length; i++) hex += arr[i].toString(16).padStart(2, '0');
  return hex;
}
