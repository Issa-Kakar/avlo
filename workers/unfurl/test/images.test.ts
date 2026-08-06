import { env } from 'cloudflare:test';
import { sha256Hex } from '@avlo/worker-shared';
import { describe, expect, it } from 'vitest';
import { bodyOf, gifBytes, HttpResponse, html, http, pageRoute, server, svgBytes, unfurl, uniqueUrl } from './harness';

/** Serve `bytes` at `url` once, under the given content-type. */
const byteRoute = (url: string, bytes: Uint8Array | string, contentType: string) =>
  server.use(http.get(url, () => new HttpResponse(bytes, { headers: { 'content-type': contentType } }), { once: true }));

describe('og-image + favicon storage', () => {
  it('stores the og-image under its full 64-hex content hash with dimensions in the response', async () => {
    const page = uniqueUrl();
    const img = uniqueUrl('/cover.gif');
    const bytes = gifBytes(320, 200);
    pageRoute(page, html(`<title>T</title><meta property="og:image" content="${img}">`));
    byteRoute(img, bytes, 'image/gif');

    const body = await bodyOf(await unfurl(page));
    const expectedId = await sha256Hex(bytes);
    expect(body.ogImageAssetId).toBe(expectedId);
    expect(body.ogImageWidth).toBe(320);
    expect(body.ogImageHeight).toBe(200);

    const stored = await env.IMAGES.get(expectedId);
    expect(stored).not.toBeNull();
    expect(stored?.httpMetadata?.contentType).toBe('image/gif');
  });

  it('dedups identical image bytes across different pages — one R2 object, same assetId', async () => {
    const bytes = gifBytes(50, 50);
    const [pageA, pageB] = [uniqueUrl(), uniqueUrl()];
    for (const page of [pageA, pageB]) {
      const img = `${new URL(page).origin}/same.gif`;
      pageRoute(page, html(`<title>T</title><meta property="og:image" content="${img}">`));
      byteRoute(img, bytes, 'image/gif');
    }
    const a = await bodyOf(await unfurl(pageA));
    const afterFirst = await env.IMAGES.head(a.ogImageAssetId as string);
    const b = await bodyOf(await unfurl(pageB));
    expect(a.ogImageAssetId).toBe(b.ogImageAssetId);
    // ONE R2 object, ONE upload: R2 mints a fresh `version` on every put (identical
    // bytes included), so an unchanged version proves the head-then-put skip actually
    // skipped — not merely that both unfurls hashed alike.
    const afterSecond = await env.IMAGES.head(a.ogImageAssetId as string);
    expect(afterSecond?.version).toBe(afterFirst?.version);
  });

  it('drops an og-image over the 5 MB cap mid-stream — response ships without image fields', async () => {
    const page = uniqueUrl();
    const img = uniqueUrl('/huge.gif');
    pageRoute(page, html(`<title>Kept</title><meta property="og:image" content="${img}">`));
    const huge = new Uint8Array(5 * 1024 * 1024 + 1024);
    huge.set(gifBytes(1, 1));
    byteRoute(img, huge, 'image/gif');

    const body = await bodyOf(await unfurl(page));
    expect(body.title).toBe('Kept');
    expect(body.ogImageAssetId).toBeUndefined();
  });

  it('drops an SVG og-image (magic-byte validation, not content-type trust)', async () => {
    const page = uniqueUrl();
    const img = uniqueUrl('/vector.svg');
    pageRoute(page, html(`<title>T</title><meta property="og:image" content="${img}">`));
    byteRoute(img, svgBytes(), 'image/png'); // CT lies; bytes decide

    const body = await bodyOf(await unfurl(page));
    expect(body.ogImageAssetId).toBeUndefined();
  });

  it('inlines an SVG favicon as base64 — never stored in R2 (sniffed via content-type)', async () => {
    const page = uniqueUrl();
    const icon = uniqueUrl('/icon.svg');
    const bytes = svgBytes();
    pageRoute(page, html(`<title>T</title><link rel="icon" href="${icon}">`));
    byteRoute(icon, bytes, 'image/svg+xml');

    const body = await bodyOf(await unfurl(page));
    expect(body.faviconSvgBase64).toBe(btoa(String.fromCharCode(...bytes)));
    expect(body.faviconAssetId).toBeUndefined();
    expect(await env.IMAGES.get(await sha256Hex(bytes))).toBeNull();
  });

  it('inlines an SVG favicon served as image/x-icon too (the byte-sniff path)', async () => {
    const page = uniqueUrl();
    const icon = uniqueUrl('/favicon.ico');
    pageRoute(page, html(`<title>T</title><link rel="icon" href="${icon}">`));
    byteRoute(icon, svgBytes(), 'image/x-icon');

    const body = await bodyOf(await unfurl(page));
    expect(body.faviconSvgBase64).toBeTruthy();
    expect(body.faviconAssetId).toBeUndefined();
  });

  it('stores a raster favicon under its content hash', async () => {
    const page = uniqueUrl();
    const icon = uniqueUrl('/favicon.gif');
    const bytes = gifBytes(32, 32);
    pageRoute(page, html(`<title>T</title><link rel="icon" href="${icon}">`));
    byteRoute(icon, bytes, 'image/gif');

    const body = await bodyOf(await unfurl(page));
    expect(body.faviconAssetId).toBe(await sha256Hex(bytes));
    expect(await env.IMAGES.get(body.faviconAssetId ?? '')).not.toBeNull();
  });

  it('drops a favicon that is neither SVG nor a valid raster', async () => {
    const page = uniqueUrl();
    const icon = uniqueUrl('/favicon.ico');
    pageRoute(page, html(`<title>T</title><link rel="icon" href="${icon}">`));
    byteRoute(icon, 'plain text pretending', 'image/x-icon');

    const body = await bodyOf(await unfurl(page));
    expect(body.faviconAssetId).toBeUndefined();
    expect(body.faviconSvgBase64).toBeUndefined();
  });

  it('drops a favicon over the 500 KB cap mid-stream — page still unfurls without it', async () => {
    const page = uniqueUrl();
    const icon = uniqueUrl('/big.gif');
    pageRoute(page, html(`<title>Kept</title><link rel="icon" href="${icon}">`));
    const huge = new Uint8Array(500 * 1024 + 1024); // FAVICON_MAX + 1 KiB
    huge.set(gifBytes(1, 1));
    byteRoute(icon, huge, 'image/gif');

    const body = await bodyOf(await unfurl(page));
    expect(body.title).toBe('Kept');
    expect(body.faviconAssetId).toBeUndefined();
    expect(body.faviconSvgBase64).toBeUndefined();
  });
});
