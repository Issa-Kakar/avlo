import { sha256Hex } from '@avlo/worker-shared';
import { describe, expect, it } from 'vitest';
import { bodyOf, gifBytes, HttpResponse, html, http, pageRoute, requested, server, unfurl, uniqueUrl } from './harness';

/** Serve a valid GIF at `url` once (favicon/og-image target). */
const imageRoute = (url: string, w = 4, h = 3) =>
  server.use(http.get(url, () => new HttpResponse(gifBytes(w, h), { headers: { 'content-type': 'image/gif' } }), { once: true }));

describe('metadata extraction', () => {
  it('prefers og:title over twitter:title over <title>, and og:description likewise', async () => {
    const page = uniqueUrl();
    pageRoute(
      page,
      html(
        '<title>Doc Title</title>' +
          '<meta name="twitter:title" content="Twitter Title">' +
          '<meta property="og:title" content="OG Title">' +
          '<meta name="description" content="Meta Desc">' +
          '<meta name="twitter:description" content="Twitter Desc">' +
          '<meta property="og:description" content="OG Desc">',
      ),
    );
    const body = await bodyOf(await unfurl(page));
    expect(body.title).toBe('OG Title');
    expect(body.description).toBe('OG Desc');
  });

  it('falls through the precedence chain when the higher sources are absent', async () => {
    const page = uniqueUrl();
    pageRoute(page, html('<title>  Plain Title  </title><meta name="description" content="Plain Desc">'));
    const body = await bodyOf(await unfurl(page));
    expect(body.title).toBe('Plain Title'); // trimmed
    expect(body.description).toBe('Plain Desc');
  });

  it('accepts og keys via name= as well as property= (both attribute spellings exist in the wild)', async () => {
    const page = uniqueUrl();
    pageRoute(page, html('<meta name="og:title" content="Via Name">'));
    const body = await bodyOf(await unfurl(page));
    expect(body.title).toBe('Via Name');
  });

  it('lets the LAST occurrence of a repeated meta win (single-pass overwrite semantics)', async () => {
    const page = uniqueUrl();
    pageRoute(page, html('<meta property="og:title" content="First"><meta property="og:title" content="Second">'));
    const body = await bodyOf(await unfurl(page));
    expect(body.title).toBe('Second');
  });

  it('reads property= over name= when ONE element carries both (the `property || name` key rule)', async () => {
    // Element 1 claims both slots; element 2 then overwrites twitter:title. If property
    // wins on element 1, og:title="From Property" survives and outranks twitter in the
    // response. If name won instead, element 1's value would land in the twitter slot,
    // be overwritten by element 2, and the response title would read "Twitter Later".
    const page = uniqueUrl();
    pageRoute(
      page,
      html('<meta property="og:title" name="twitter:title" content="From Property"><meta name="twitter:title" content="Twitter Later">'),
    );
    expect((await bodyOf(await unfurl(page))).title).toBe('From Property');
  });

  it('accepts the og:image:url and twitter:image:src aliases (both live in the wild)', async () => {
    const viaOgUrl = uniqueUrl();
    const ogAlias = uniqueUrl('/og-url.gif');
    imageRoute(ogAlias, 7, 3);
    pageRoute(viaOgUrl, html(`<title>T</title><meta property="og:image:url" content="${ogAlias}">`));
    expect((await bodyOf(await unfurl(viaOgUrl))).ogImageWidth).toBe(7);

    const viaTwitterSrc = uniqueUrl();
    const twAlias = uniqueUrl('/tw-src.gif');
    imageRoute(twAlias, 8, 2);
    pageRoute(viaTwitterSrc, html(`<title>T</title><meta name="twitter:image:src" content="${twAlias}">`));
    expect((await bodyOf(await unfurl(viaTwitterSrc))).ogImageWidth).toBe(8);
  });

  it('prefers og:image:secure_url over og:image over twitter:image over image_src', async () => {
    const page = uniqueUrl();
    const secure = uniqueUrl('/secure.gif');
    imageRoute(secure, 9, 5);
    pageRoute(
      page,
      html(
        '<title>T</title>' +
          `<link rel="image_src" href="${uniqueUrl('/linkrel.gif')}">` +
          `<meta name="twitter:image" content="${uniqueUrl('/tw.gif')}">` +
          `<meta property="og:image" content="${uniqueUrl('/og.gif')}">` +
          `<meta property="og:image:secure_url" content="${secure}">`,
      ),
    );
    const body = await bodyOf(await unfurl(page));
    expect(body.ogImageWidth).toBe(9); // the 9×5 dims identify the secure_url target as the one fetched
    expect(requested('/og.gif')).toEqual([]);
  });

  it('resolves relative og:image and favicon hrefs against the page URL', async () => {
    const page = uniqueUrl('/deep/dir/page');
    const origin = new URL(page).origin;
    imageRoute(`${origin}/img/cover.gif`, 6, 4);
    imageRoute(`${origin}/deep/dir/icon.gif`);
    pageRoute(page, html('<title>T</title><meta property="og:image" content="/img/cover.gif"><link rel="icon" href="icon.gif">'));

    const body = await bodyOf(await unfurl(page));
    expect(body.ogImageWidth).toBe(6);
    expect(body.faviconAssetId).toMatch(/^[0-9a-f]{64}$/);
  });

  it('picks the icon with the largest sizes area; "any" beats every numeric size', async () => {
    const page = uniqueUrl();
    const origin = new URL(page).origin;
    imageRoute(`${origin}/any.gif`, 5, 5);
    pageRoute(
      page,
      html(
        '<title>T</title>' +
          `<link rel="icon" sizes="16x16" href="/small.gif">` +
          `<link rel="icon" sizes="64x64 32x32" href="/big.gif">` +
          `<link rel="icon" sizes="any" href="/any.gif">`,
      ),
    );
    const body = await bodyOf(await unfurl(page));
    expect(body.faviconAssetId).toBe(await sha256Hex(gifBytes(5, 5))); // the content hash identifies /any.gif as the stored icon
    expect(requested('/small.gif')).toEqual([]);
    expect(requested('/big.gif')).toEqual([]);
  });

  it('keeps the FIRST size-less icon over later size-less ones', async () => {
    const page = uniqueUrl();
    const origin = new URL(page).origin;
    imageRoute(`${origin}/one.gif`, 6, 6);
    pageRoute(page, html('<title>T</title><link rel="icon" href="/one.gif"><link rel="icon" href="/two.gif">'));
    const body = await bodyOf(await unfurl(page));
    expect(body.faviconAssetId).toBe(await sha256Hex(gifBytes(6, 6))); // /one.gif's bytes
    expect(requested('/two.gif')).toEqual([]);
  });

  it('lets apple-touch-icon trump every rel=icon, sized or not', async () => {
    const page = uniqueUrl();
    const origin = new URL(page).origin;
    imageRoute(`${origin}/apple.gif`, 7, 7);
    pageRoute(
      page,
      html('<title>T</title><link rel="icon" sizes="512x512" href="/huge.gif"><link rel="apple-touch-icon" href="/apple.gif">'),
    );
    const body = await bodyOf(await unfurl(page));
    expect(body.faviconAssetId).toBe(await sha256Hex(gifBytes(7, 7))); // /apple.gif's bytes
    expect(requested('/huge.gif')).toEqual([]);
  });

  it('concatenates <title> text across rewriter chunks and ignores nested-tag boundaries', async () => {
    const page = uniqueUrl();
    // A long title forces multiple text chunks through the streaming rewriter.
    const long = `The ${'Very '.repeat(200)}Long Title`;
    pageRoute(page, html(`<title>${long}</title>`));
    const body = await bodyOf(await unfurl(page));
    expect(body.title).toBe(long);
  });
});
