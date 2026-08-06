import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { icoBytes, jpegBytes, keyFor, pngBytes, svgBytes, uniqueGif, uniquePng, upload, webpBytes } from './harness';

describe('PUT /:key', () => {
  it('403s an identity-less cross-site PUT — CSRF precedes auth in the middleware chain', async () => {
    // No identity AND a csrf trigger (disallowed origin, no content-type): the 403 wins
    // over the 401, pinning csrf's position ahead of requireAuth.
    const bytes = pngBytes();
    const res = await upload(await keyFor(bytes), bytes, { user: null, origin: 'https://evil.example', contentType: null });
    expect(res.status).toBe(403);
  });

  it('401s an allowed-Origin PUT without an identity cookie', async () => {
    const bytes = pngBytes();
    const res = await upload(await keyFor(bytes), bytes, { user: null });
    expect(res.status).toBe(401);
  });

  it('403s a cross-site form/content-type-less PUT even WITH a valid identity (csrf precedes auth)', async () => {
    const bytes = pngBytes();
    const key = await keyFor(bytes);
    // No Content-Type ⇒ csrf treats it as form-capable; disallowed origin ⇒ 403.
    expect((await upload(key, bytes, { origin: 'https://evil.example', contentType: null })).status).toBe(403);
    expect((await upload(key, bytes, { origin: null, contentType: null })).status).toBe(403);
    expect((await upload(key, bytes, { origin: 'https://evil.example', contentType: 'text/plain' })).status).toBe(403);
  });

  it('lets binary content-types through csrf regardless of origin absence (hc-style uploads)', async () => {
    // application/octet-stream is not form-capable — csrf does not engage; the request
    // proceeds to auth + validation and succeeds.
    const bytes = uniquePng(); // R2 state persists across tests; allocator bytes never collide
    const res = await upload(await keyFor(bytes), bytes, { origin: null });
    expect(res.status).toBe(201);
  });

  it('400s malformed keys before anything else — uppercase hex and wrong lengths', async () => {
    for (const key of ['A'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), 'g'.repeat(64)]) {
      expect((await upload(key, pngBytes())).status, `key ${key.slice(0, 8)}… len ${key.length}`).toBe(400);
    }
  });

  it('bounds Content-Length at the header level — missing, zero, non-numeric, oversize', async () => {
    const key = 'a'.repeat(64);
    expect((await upload(key, pngBytes(), { contentLength: null })).status).toBe(400); // absent → "required"
    expect((await upload(key, new Uint8Array(0))).status).toBe(400); // CL 0 → "must be positive"
    expect((await upload(key, pngBytes(), { contentLength: 'abc' })).status).toBe(400);
    expect((await upload(key, pngBytes(), { contentLength: String(10 * 1024 * 1024 + 1) })).status).toBe(400);
  });

  it('accepts every allow-listed format and stores the SNIFFED content type, ignoring the client header', async () => {
    const formats: [string, Uint8Array][] = [
      ['image/png', uniquePng()],
      ['image/jpeg', jpegBytes()], // fixed-byte formats (jpeg/webp/ico) upload only here — no collision axis
      ['image/gif', uniqueGif()],
      ['image/webp', webpBytes()],
      ['image/x-icon', icoBytes()],
    ];
    for (const [expectedMime, bytes] of formats) {
      const key = await keyFor(bytes);
      // Client lies about the type; the magic bytes decide what R2 stores.
      const res = await upload(key, bytes, { contentType: 'application/pdf' });
      expect(res.status, expectedMime).toBe(201);
      const stored = await env.IMAGES.get(key);
      expect(stored?.httpMetadata?.contentType, expectedMime).toBe(expectedMime);
    }
  });

  it('rejects SVG, sub-12-byte, and garbage bodies via magic-byte sniff (400 unsupported)', async () => {
    for (const bytes of [svgBytes(), new Uint8Array([0x89, 0x50]), new TextEncoder().encode('clearly not an image')]) {
      const res = await upload(await keyFor(bytes), bytes);
      expect(res.status).toBe(400);
      expect(await res.text()).toContain('unsupported image format');
    }
  });

  it('400s a hash mismatch — valid image, wrong content-addressed key (server recomputes, never trusts)', async () => {
    const res = await upload('b'.repeat(64), pngBytes());
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('key mismatch');
    expect(await env.IMAGES.head('b'.repeat(64))).toBeNull();

    // A lying Content-Length (within the H2 bound, misstating the real size) changes
    // nothing: the server hashes the bytes it actually received, so the mismatch still
    // 400s and R2 stays clean.
    const lying = await upload('b'.repeat(64), pngBytes(), { contentLength: '64' });
    expect(lying.status).toBe(400);
    expect(await env.IMAGES.head('b'.repeat(64))).toBeNull();
  });

  it('201s a fresh upload and 200s `exists` on the duplicate — dedup head-check first', async () => {
    const bytes = uniqueGif();
    const key = await keyFor(bytes);
    const first = await upload(key, bytes);
    expect(first.status).toBe(201);
    expect(await first.json()).toEqual({ key, status: 'created' });

    const second = await upload(key, bytes);
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ key, status: 'exists' });
  });

  it('CHARACTERIZED: the dedup short-circuit precedes validation — a garbage body against an existing key still 200s', async () => {
    // Deliberate: dedup saves the whole body read on duplicates, and the stored object
    // is already hash-verified, so nothing unverified can enter R2 through this path.
    const bytes = pngBytes(3, 3);
    const key = await keyFor(bytes);
    await upload(key, bytes);
    const res = await upload(key, 'total garbage, never validated');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ key, status: 'exists' });
    // The stored bytes are untouched.
    const stored = await env.IMAGES.get(key);
    expect(new Uint8Array((await stored?.arrayBuffer()) ?? new ArrayBuffer(0))).toEqual(bytes);
  });
});
