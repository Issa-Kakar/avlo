import { createExecutionContext, env } from 'cloudflare:test';
import { HttpResponse, http, installMswServer } from '@avlo/test-support/msw';
import { describe, expect, it } from 'vitest';
import { ImagesRpc } from '../src/rpc';
import { sha256Hex, svgBytes, uniqueGif } from './harness';

const { server, requested } = installMswServer();

/** Direct construction against the real env — the RPC's only caller is auth's OAuth callback. */
function rpc() {
  return new ImagesRpc(createExecutionContext() as ExecutionContext, env);
}

/** A body response the ingest fetch will stream (content type sniffed server-side, never trusted). */
const body = (bytes: Uint8Array, contentType = 'image/gif') => new HttpResponse(bytes, { headers: { 'content-type': contentType } });

const CDN = 'https://lh3.googleusercontent.com';

describe('ImagesRpc.ingestAvatar', () => {
  it('refuses non-https, non-Google, and trailing-dot hosts without ever fetching', async () => {
    for (const url of [
      'http://lh3.googleusercontent.com/a/photo=s96-c', // scheme downgrade
      'https://evil.example/a/photo=s96-c',
      'https://googleusercontent.com.evil.example/a/photo', // suffix game
      'https://lh3.googleusercontent.com./a/photo=s96-c', // trailing-dot FQDN twin
    ]) {
      expect(await rpc().ingestAvatar(url), url).toBeNull();
    }
    expect(requested()).toEqual([]);
  });

  it('rewrites the size suffix =s<N>(-c) to =s256-c before fetching (retina-ready snapshot)', async () => {
    server.use(http.get(/photo=s256-c$/, () => body(uniqueGif()), { once: true }));
    const hash = await rpc().ingestAvatar(`${CDN}/a/photo=s96-c`);
    expect(hash).toMatch(/^[0-9a-f]{32}$/);
    expect(requested('=s256-c')).toHaveLength(1);
    expect(requested('=s96-c')).toEqual([]);
  });

  it('nulls an oversize avatar (mid-stream 1 MiB cap) and a non-image body', async () => {
    const huge = new Uint8Array(1024 * 1024 + 1024);
    huge.set(uniqueGif());
    server.use(http.get(/\/big=s256-c$/, () => body(huge), { once: true }));
    expect(await rpc().ingestAvatar(`${CDN}/a/big=s96-c`)).toBeNull();
    expect(requested('/big=s256-c')).toHaveLength(1);

    server.use(http.get(/\/svg=s256-c$/, () => body(svgBytes()), { once: true })); // CT lies image/gif; the sniff decides
    expect(await rpc().ingestAvatar(`${CDN}/a/svg=s96-c`)).toBeNull();
    expect(requested('/svg=s256-c')).toHaveLength(1);
  });

  it('stores under avatars/<32-hex> with the SNIFFED content type; re-ingest never rewrites the R2 object', async () => {
    const bytes = uniqueGif();
    server.use(
      http.get(/\/pic=s256-c$/, () => body(bytes, 'application/octet-stream'), { once: true }),
      http.get(/\/pic=s256-c$/, () => body(bytes, 'application/octet-stream'), { once: true }),
    );

    const hash = await rpc().ingestAvatar(`${CDN}/a/pic=s96-c`);
    expect(hash).toBe((await sha256Hex(bytes)).slice(0, 32));
    const first = await env.IMAGES.head(`avatars/${hash}`);
    expect(first?.httpMetadata?.contentType).toBe('image/gif'); // sniffed, not Google's header

    // Same bytes again (idempotent re-sign-in): the stored object is NOT rewritten. R2
    // mints a fresh `version` on every put (identical bytes included), so an unchanged
    // version pins the skip — how the ingest skips (head-then-put today) stays its business.
    const again = await rpc().ingestAvatar(`${CDN}/a/pic=s96-c`);
    expect(again).toBe(hash);
    expect((await env.IMAGES.head(`avatars/${hash}`))?.version).toBe(first?.version);
    expect(requested('/pic=s256-c')).toHaveLength(2);
  });

  it('re-checks the host allowlist per redirect hop — a CDN 302 cannot walk the fetch off Google', async () => {
    server.use(
      http.get(/\/hop=s256-c$/, () => new HttpResponse(null, { status: 302, headers: { location: 'https://attacker.example/exfil' } }), {
        once: true,
      }),
    );
    expect(await rpc().ingestAvatar(`${CDN}/a/hop=s96-c`)).toBeNull();
    expect(requested('attacker.example')).toEqual([]);
  });

  it('follows a WITHIN-CDN redirect to success', async () => {
    // ONE use() call in hop order: handlers resolve in array order, and a consumed
    // `once` handler deactivates, so hop 1 matches the 302 and hop 2 the final body.
    server.use(
      http.get(/\/moved=s256-c$/, () => new HttpResponse(null, { status: 302, headers: { location: `${CDN}/b/final-loc` } }), {
        once: true,
      }),
      http.get(`${CDN}/b/final-loc`, () => body(uniqueGif()), { once: true }),
    );
    expect(await rpc().ingestAvatar(`${CDN}/a/moved=s96-c`)).toMatch(/^[0-9a-f]{32}$/);
    expect(requested('/b/final-loc')).toHaveLength(1);
  });

  it('nulls (never throws) on a network failure — a missing avatar must not fail sign-in', async () => {
    server.use(http.get(/\/down=s256-c$/, () => HttpResponse.error(), { once: true }));
    expect(await rpc().ingestAvatar(`${CDN}/a/down=s96-c`)).toBeNull();
    expect(requested('/down=s256-c')).toHaveLength(1);
  });
});
