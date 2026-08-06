import { describe, expect, it } from 'vitest';
import { bodyOf, gifBytes, HttpResponse, html, http, pageRoute, requested, server, unfurl, uniqueUrl } from './harness';

/**
 * The H9 second half: og:image/favicon URLs are attacker-authored page content that never
 * saw the Zod refine, and redirects can land anywhere. Every "blocked" assertion checks
 * TWO things — the degraded response AND that no request to private space was ever
 * attempted (the guard must refuse before bytes move; an unhandled mock fetch would also
 * error loudly, so a hit here means the request log caught it first).
 */
describe('per-hop SSRF enforcement', () => {
  it('blocks an og:image pointing into private space — the page still unfurls without it', async () => {
    const page = uniqueUrl();
    pageRoute(page, html('<title>Legit Page</title><meta property="og:image" content="http://169.254.169.254/latest/meta-data">'));

    const res = await unfurl(page);
    expect(res.status).toBe(200);
    const body = await bodyOf(res);
    expect(body.title).toBe('Legit Page');
    expect(body.ogImageAssetId).toBeUndefined();
    expect(requested('169.254.169.254')).toEqual([]);
  });

  it('blocks a favicon pointing at loopback (relative-resolution cannot rescue it)', async () => {
    const page = uniqueUrl();
    pageRoute(page, html('<title>T</title><link rel="icon" href="http://127.0.0.1:8787/admin/favicon.ico">'));

    const res = await unfurl(page);
    const body = await bodyOf(res);
    expect(body.faviconAssetId).toBeUndefined();
    expect(body.faviconSvgBase64).toBeUndefined();
    expect(requested('127.0.0.1')).toEqual([]);
  });

  it('blocks a page redirect that lands in private space — 502, zero private requests', async () => {
    const page = uniqueUrl();
    server.use(
      http.get(page, () => new HttpResponse(null, { status: 302, headers: { location: 'http://10.0.0.5/internal' } }), { once: true }),
    );

    expect((await unfurl(page)).status).toBe(502);
    expect(requested('10.0.0.5')).toEqual([]);
  });

  it('blocks an og-image redirect into private space while keeping the page result', async () => {
    const page = uniqueUrl();
    const img = uniqueUrl('/img.gif');
    pageRoute(page, html(`<title>T</title><meta property="og:image" content="${img}">`));
    server.use(
      http.get(img, () => new HttpResponse(null, { status: 302, headers: { location: 'http://192.168.0.10/x.gif' } }), { once: true }),
    );

    const body = await bodyOf(await unfurl(page));
    expect(body.title).toBe('T');
    expect(body.ogImageAssetId).toBeUndefined();
    expect(requested('192.168.0.10')).toEqual([]);
  });

  it('blocks the direct-image branch when its re-fetch redirects to private space', async () => {
    const target = uniqueUrl('/raw.gif');
    // First hop: the page fetch sees an image content-type; the re-fetch then redirects.
    // ONE use() call so the once-handlers serve in hop order.
    server.use(
      http.get(target, () => new HttpResponse(gifBytes(), { headers: { 'content-type': 'image/gif' } }), { once: true }),
      http.get(target, () => new HttpResponse(null, { status: 302, headers: { location: 'http://172.16.0.9/leak.gif' } }), { once: true }),
    );

    expect((await unfurl(target)).status).toBe(204);
    expect(requested('172.16.0.9')).toEqual([]);
  });

  it('follows a legitimate public redirect chain (guard ≠ no-redirects)', async () => {
    const a = uniqueUrl('/a');
    const b = uniqueUrl('/b');
    const c = uniqueUrl('/c');
    server.use(
      http.get(a, () => new HttpResponse(null, { status: 301, headers: { location: b } }), { once: true }),
      http.get(b, () => new HttpResponse(null, { status: 302, headers: { location: c } }), { once: true }),
    );
    pageRoute(c, html('<title>Landed</title>'));

    const body = await bodyOf(await unfurl(a));
    expect(body.title).toBe('Landed');
  });

  it('gives up past the redirect hop cap — 502, the chain is not followed forever', async () => {
    // 7 hops > the 5-hop cap; the tail hops must never be requested (no `once` — tail
    // hops legitimately go unrequested, and an unused plain handler costs nothing).
    const hops = Array.from({ length: 8 }, (_, i) => uniqueUrl(`/hop${i}`));
    server.use(
      ...hops.slice(0, 7).map((hop, i) => http.get(hop, () => new HttpResponse(null, { status: 302, headers: { location: hops[i + 1] } }))),
    );
    expect((await unfurl(hops[0])).status).toBe(502);
    // MAX_REDIRECTS=5 ⇒ fetches hop0..hop5; hop5's redirect target (hop6) is where the
    // chain is cut — asserting hop6 pins the exact cut point, hop7 the safety margin.
    expect(requested('/hop6')).toEqual([]);
    expect(requested('/hop7')).toEqual([]);
  });
});
