import { describe, expect, it } from 'vitest';
import { bodyOf, gifBytes, HttpResponse, html, http, pageRoute, requested, server, unfurl, uniqueUrl } from './harness';

describe('page fetch + content-type branches', () => {
  it('502s when the page fetch throws (network error)', async () => {
    const page = uniqueUrl();
    server.use(http.get(page, () => HttpResponse.error(), { once: true }));
    expect((await unfurl(page)).status).toBe(502);
  });

  it('502s a non-OK page response', async () => {
    const page = uniqueUrl();
    pageRoute(page, 'gone', { status: 404 });
    expect((await unfurl(page)).status).toBe(502);
  });

  it('204s non-HTML content it cannot extract from', async () => {
    const page = uniqueUrl('/doc.pdf');
    server.use(http.get(page, () => new HttpResponse('%PDF-1.4', { headers: { 'content-type': 'application/pdf' } }), { once: true }));
    expect((await unfurl(page)).status).toBe(204);
  });

  it('204s an HTML page with no useful metadata (no title, no image)', async () => {
    const page = uniqueUrl();
    pageRoute(page, html('', '<p>just text</p>'));
    expect((await unfurl(page)).status).toBe(204);
  });

  it('caps how much HTML feeds the rewriter — a giant page cannot hide metadata past 2 MB', async () => {
    const page = uniqueUrl();
    // Title AFTER ~2.5 MB of body filler: the drain stops at the cap, so it goes unseen.
    const filler = `<p>${'x'.repeat(2_500_000)}</p>`;
    pageRoute(page, `<!doctype html><html><head></head><body>${filler}<title>Too Late</title></body></html>`);
    expect((await unfurl(page)).status).toBe(204);
  });

  it('still extracts head metadata from a giant page — truncation only sheds the tail', async () => {
    const page = uniqueUrl();
    const filler = `<p>${'x'.repeat(2_500_000)}</p>`;
    pageRoute(page, `<!doctype html><html><head><title>Up Front</title></head><body>${filler}</body></html>`);
    const body = await bodyOf(await unfurl(page));
    expect(body.title).toBe('Up Front');
  });

  it('treats a direct image URL as its own unfurl: filename title (decoded) + stored image', async () => {
    const target = uniqueUrl('/photos/Summer%20Trip.gif');
    // Hop 1: the page fetch (content-type sniff). Hop 2: fetchAndStoreImage re-fetches.
    // ONE use() call so the once-handlers serve in hop order.
    const image = () => new HttpResponse(gifBytes(11, 7), { headers: { 'content-type': 'image/gif' } });
    server.use(http.get(target, image, { once: true }), http.get(target, image, { once: true }));

    const res = await unfurl(target);
    expect(res.status).toBe(200);
    const body = await bodyOf(res);
    expect(body.title).toBe('Summer Trip.gif');
    expect(body.ogImageAssetId).toMatch(/^[0-9a-f]{64}$/);
    expect(body.ogImageWidth).toBe(11);
    expect(body.ogImageHeight).toBe(7);
  });

  it('204s a direct image whose bytes fail validation (content-type lies)', async () => {
    const target = uniqueUrl('/fake.png');
    const liar = () => new HttpResponse('not an image at all', { headers: { 'content-type': 'image/png' } });
    server.use(http.get(target, liar, { once: true }), http.get(target, liar, { once: true }));
    expect((await unfurl(target)).status).toBe(204);
    expect(requested(target)).toHaveLength(2); // sniff + re-fetch both fired — the 204 came from validation, not a dead route
  });
});
