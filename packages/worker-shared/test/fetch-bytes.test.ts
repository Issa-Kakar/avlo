import { HttpResponse, http, installMswServer } from '@avlo/test-support/msw';
import { uniqueUrl } from '@avlo/test-support/unique';
import { describe, expect, it } from 'vitest';
import { fetchBytesCapped, fetchGuarded, sha256Hex } from '../src/fetch-bytes';

const { server, requested } = installMswServer();

const redirectTo = (location: string) => () => new HttpResponse(null, { status: 302, headers: { location } });

describe('sha256Hex', () => {
  it('matches the NIST "abc" vector for both buffer shapes', async () => {
    const expected = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
    const bytes = new TextEncoder().encode('abc');
    expect(await sha256Hex(bytes)).toBe(expected);
    expect(await sha256Hex(bytes.buffer as ArrayBuffer)).toBe(expected);
  });
});

describe('fetchGuarded', () => {
  it('refuses a private first hop and non-http(s) schemes without any fetch', async () => {
    expect(await fetchGuarded('http://169.254.169.254/latest')).toBeNull();
    expect(await fetchGuarded('ftp://example.com/x')).toBeNull();
    expect(await fetchGuarded('file:///etc/passwd')).toBeNull();
    expect(requested()).toEqual([]);
  });

  it('re-guards every redirect hop — a public chain landing private is refused mid-flight', async () => {
    const a = uniqueUrl('/a');
    server.use(http.get(a, redirectTo('http://10.0.0.5/loot'), { once: true }));
    expect(await fetchGuarded(a)).toBeNull();
    expect(requested('10.0.0.5')).toEqual([]);
  });

  it('resolves RELATIVE Location headers against the current hop', async () => {
    const a = uniqueUrl('/dir/a');
    const target = `${new URL(a).origin}/dir/final`;
    server.use(
      http.get(a, redirectTo('final'), { once: true }),
      http.get(target, () => new HttpResponse('landed'), { once: true }),
    );
    const res = await fetchGuarded(a);
    expect(await res?.text()).toBe('landed');
  });

  it('follows up to 5 hops and refuses the 6th', async () => {
    const ok = Array.from({ length: 6 }, (_, i) => uniqueUrl(`/ok${i}`));
    server.use(
      ...ok.slice(0, 5).map((url, i) => http.get(url, redirectTo(ok[i + 1]), { once: true })),
      http.get(ok[5], () => new HttpResponse('made it'), { once: true }),
    );
    expect(await (await fetchGuarded(ok[0]))?.text()).toBe('made it');

    const over = Array.from({ length: 7 }, (_, i) => uniqueUrl(`/over${i}`));
    server.use(...over.slice(0, 6).map((url, i) => http.get(url, redirectTo(over[i + 1]))));
    expect(await fetchGuarded(over[0])).toBeNull();
    expect(requested('/over6')).toEqual([]);
  });

  it('layers a caller hostAllowed allowlist on top of the SSRF guard, per hop', async () => {
    const onCdn = 'https://img.cdn.example/pic';
    const offCdn = 'https://other-public.example/pic';
    server.use(http.get(onCdn, redirectTo(offCdn), { once: true }));
    const res = await fetchGuarded(onCdn, { hostAllowed: (h) => h.endsWith('.cdn.example') });
    expect(res).toBeNull(); // public but off-list — refused
    expect(requested('other-public.example')).toEqual([]);
  });

  it('returns the final response as-is (caller owns .ok) — a 404 is a response, not null', async () => {
    const a = uniqueUrl();
    server.use(http.get(a, () => new HttpResponse('gone', { status: 404 }), { once: true }));
    const res = await fetchGuarded(a);
    expect(res?.status).toBe(404);
  });
});

describe('fetchBytesCapped', () => {
  it('returns bytes + content type under the cap', async () => {
    const a = uniqueUrl();
    server.use(
      http.get(a, () => new HttpResponse(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/gif' } }), {
        once: true,
      }),
    );
    const got = await fetchBytesCapped(a, 1024);
    expect(got?.contentType).toBe('image/gif');
    expect([...(got?.bytes ?? [])]).toEqual([1, 2, 3]);
  });

  it('cancels mid-stream and returns null the moment the byte cap is exceeded', async () => {
    const a = uniqueUrl();
    // A body streamed in chunks so the cap trips before the stream completes.
    const endless = () =>
      new HttpResponse(
        new ReadableStream({
          pull(controller) {
            controller.enqueue(new Uint8Array(64 * 1024)); // never signals done — cancel must end it
          },
        }),
      );
    server.use(http.get(a, endless, { once: true }));
    expect(await fetchBytesCapped(a, 100 * 1024)).toBeNull();
  });

  it('nulls non-OK responses and SSRF-refused targets', async () => {
    const a = uniqueUrl();
    server.use(http.get(a, () => new HttpResponse('boom', { status: 500 }), { once: true }));
    expect(await fetchBytesCapped(a, 1024)).toBeNull();
    expect(await fetchBytesCapped('http://127.0.0.1/x', 1024)).toBeNull();
  });
});
