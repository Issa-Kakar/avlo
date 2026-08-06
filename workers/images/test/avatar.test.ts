import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { hit, sha256Hex, uniqueGif } from './harness';

/** Seed an avatar under its prefixed write-once key; returns the 32-hex hash. */
async function seedAvatar(bytes: Uint8Array): Promise<string> {
  const hash = (await sha256Hex(bytes)).slice(0, 32);
  await env.IMAGES.put(`avatars/${hash}`, bytes, { httpMetadata: { contentType: 'image/gif' } });
  return hash;
}

describe('GET /avatars/:hash', () => {
  it('400s a malformed hash and 404s an absent one', async () => {
    expect((await hit(`/avatars/${'X'.repeat(32)}`)).status).toBe(400);
    expect((await hit('/avatars/deadbeef')).status).toBe(400); // wrong length
    expect((await hit(`/avatars/${'d'.repeat(32)}`)).status).toBe(404);
  });

  it('serves anonymously from the avatars/ prefix with immutable caching', async () => {
    const bytes = uniqueGif();
    const hash = await seedAvatar(bytes);
    const res = await hit(`/avatars/${hash}`, {}, { user: null });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(res.headers.get('etag')).toBeTruthy();
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
  });

  it('does not collide with the bare 64-hex asset route — a 64-hex avatar path is a different resource', async () => {
    const bytes = uniqueGif();
    const hash = await seedAvatar(bytes);
    // The bare-key route can never reach an `avatars/`-prefixed object.
    expect((await hit(`/${hash.repeat(2)}`)).status).toBe(404);
    expect((await hit(`/avatars/${hash}`)).status).toBe(200);
  });

  it('ignores Range — avatars always serve the full body (no 206 path)', async () => {
    const bytes = uniqueGif();
    const hash = await seedAvatar(bytes);
    const res = await hit(`/avatars/${hash}`, { headers: { range: 'bytes=0-3' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-range')).toBeNull();
    expect((await res.arrayBuffer()).byteLength).toBe(bytes.byteLength);
  });

  it('304s a cold conditional via R2 onlyIf', async () => {
    const hash = await seedAvatar(uniqueGif());
    const etag = (await env.IMAGES.head(`avatars/${hash}`))?.httpEtag ?? '';
    expect((await hit(`/avatars/${hash}`, { headers: { 'if-none-match': etag } })).status).toBe(304);
  });

  it('edge-caches via waitUntil — a repeat hit survives R2 deletion', async () => {
    const bytes = uniqueGif();
    const hash = await seedAvatar(bytes);
    expect((await hit(`/avatars/${hash}`)).status).toBe(200);
    await env.IMAGES.delete(`avatars/${hash}`);
    const cached = await hit(`/avatars/${hash}`);
    expect(cached.status).toBe(200);
    expect(new Uint8Array(await cached.arrayBuffer())).toEqual(bytes);
  });
});
