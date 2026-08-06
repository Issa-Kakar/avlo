import { describe, expect, it } from 'vitest';
import { bodyOf, html, pageRoute, requested, unfurl, uniqueUrl } from './harness';

describe('edge caching', () => {
  it('serves a repeat unfurl from the edge cache — the target is fetched exactly once', async () => {
    const page = uniqueUrl();
    pageRoute(page, html('<title>Cache Me</title>'));

    const first = await unfurl(page);
    expect(first.status).toBe(200);
    expect(first.headers.get('cache-control')).toBe('public, max-age=604800');

    const second = await unfurl(page);
    expect(second.status).toBe(200);
    expect((await bodyOf(second)).title).toBe('Cache Me');
    // One page fetch total: the second response came from caches.default, not the site.
    expect(requested(page)).toHaveLength(1);
  });

  it('never caches a 204 (no-metadata) result — a later fix to the page is picked up', async () => {
    const page = uniqueUrl();
    pageRoute(page, html('', '<p>nothing</p>'));
    expect((await unfurl(page)).status).toBe(204);

    // The page gains metadata; the next unfurl re-fetches and sees it.
    pageRoute(page, html('<title>Fixed</title>'));
    const res = await unfurl(page);
    expect(res.status).toBe(200);
    expect((await bodyOf(res)).title).toBe('Fixed');
    expect(requested(page)).toHaveLength(2);
  });

  it('never caches a 502 (fetch failure) — transient outages do not poison the URL', async () => {
    const page = uniqueUrl();
    pageRoute(page, 'down', { status: 500 });
    expect((await unfurl(page)).status).toBe(502);

    pageRoute(page, html('<title>Recovered</title>'));
    const res = await unfurl(page);
    expect(res.status).toBe(200);
    expect((await bodyOf(res)).title).toBe('Recovered');
  });
});
