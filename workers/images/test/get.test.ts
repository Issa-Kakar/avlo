import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { gifBytes, hit, keyFor, uniqueGif } from './harness';

/** Seed a content-addressed object directly (uploads are upload.test.ts's concern). */
async function seed(bytes: Uint8Array): Promise<string> {
  const key = await keyFor(bytes);
  await env.IMAGES.put(key, bytes, { httpMetadata: { contentType: 'image/gif' } });
  return key;
}

/** A 100-byte body for range math — unique via its `uniqueGif` header. */
function rangeBytes(): Uint8Array {
  const b = new Uint8Array(100);
  b.set(uniqueGif());
  for (let i = 16; i < 100; i++) b[i] = i;
  return b;
}

describe('GET /:key', () => {
  it('is anonymous — no cookie required for a content-hash read', async () => {
    const key = await seed(uniqueGif());
    expect((await hit(`/${key}`, {}, { user: null })).status).toBe(200);
  });

  it('404s an absent key and 400s a malformed one', async () => {
    expect((await hit(`/${'c'.repeat(64)}`)).status).toBe(404);
    expect((await hit(`/${'C'.repeat(64)}`)).status).toBe(400);
  });

  it('serves 200 with immutable caching, ETag, and the Accept-Ranges advertisement', async () => {
    const bytes = uniqueGif();
    const key = await seed(bytes);
    const res = await hit(`/${key}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(res.headers.get('etag')).toBeTruthy();
    expect(res.headers.get('accept-ranges')).toBe('bytes');
    expect(res.headers.get('content-type')).toBe('image/gif');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
  });

  it('304s a matching If-None-Match on the cold path (R2 onlyIf)', async () => {
    const key = await seed(uniqueGif());
    // R2's own httpEtag, so the conditional can be the FIRST request — a true cold hit
    // (any earlier full GET would have already populated the edge cache).
    const etag = (await env.IMAGES.head(key))?.httpEtag ?? '';
    const probe = await hit(`/${key}`, { headers: { 'if-none-match': etag } });
    expect(probe.status).toBe(304);
  });

  it('serves the documented Range matrix: closed, suffix, open — and 200 for a full-cover range', async () => {
    const bytes = rangeBytes();
    const key = await seed(bytes);

    const closed = await hit(`/${key}`, { headers: { range: 'bytes=0-49' } });
    expect(closed.status).toBe(206);
    expect(closed.headers.get('content-range')).toBe('bytes 0-49/100');
    expect((await closed.arrayBuffer()).byteLength).toBe(50);

    const suffix = await hit(`/${key}`, { headers: { range: 'bytes=-10' } });
    expect(suffix.status).toBe(206);
    expect(suffix.headers.get('content-range')).toBe('bytes 90-99/100');

    const open = await hit(`/${key}`, { headers: { range: 'bytes=50-' } });
    expect(open.status).toBe(206);
    expect(open.headers.get('content-range')).toBe('bytes 50-99/100');

    // `bytes=0-` covers the whole object — deliberately a plain 200, not a 206.
    const full = await hit(`/${key}`, { headers: { range: 'bytes=0-' } });
    expect(full.status).toBe(200);
    expect(full.headers.get('content-range')).toBeNull();
  });

  it('never caches Range responses — a later full GET gets the full body', async () => {
    const bytes = rangeBytes();
    const key = await seed(bytes);
    await hit(`/${key}`, { headers: { range: 'bytes=0-9' } });
    // Nothing entered the edge cache for this URL…
    expect(await caches.default.match(`https://images.avlo.io/${key}`)).toBeUndefined();
    // …so the full GET streams all 100 bytes from R2.
    const full = await hit(`/${key}`);
    expect((await full.arrayBuffer()).byteLength).toBe(100);
  });

  it('populates the edge cache via waitUntil — a repeat hit survives R2 deletion', async () => {
    const bytes = uniqueGif();
    const key = await seed(bytes);
    expect((await hit(`/${key}`)).status).toBe(200); // harness waits out the cache put

    await env.IMAGES.delete(key); // the origin object vanishes…
    const cached = await hit(`/${key}`);
    expect(cached.status).toBe(200); // …but the edge copy serves
    expect(new Uint8Array(await cached.arrayBuffer())).toEqual(bytes);
  });

  it('CHARACTERIZED: a warm cache hit ignores If-None-Match — 200 with body, never 304', async () => {
    // caches.default.match does not evaluate conditional headers; revalidation only
    // happens on the cold path. Immutable content-addressed keys make this harmless.
    const key = await seed(gifBytes(38, 1));
    const first = await hit(`/${key}`);
    const etag = first.headers.get('etag') ?? '';
    const warm = await hit(`/${key}`, { headers: { 'if-none-match': etag } });
    expect(warm.status).toBe(200);
  });
});
