import { describe, expect, it } from 'vitest';
import { unfurl } from './harness';

// No handlers are registered in this file, and the harness's MSW server errors any
// unhandled request — a leaked outbound fetch cannot pass silently.
describe('request validation', () => {
  it('401s an unauthenticated request BEFORE any validation — garbage url included', async () => {
    // requireAuth precedes zValidator in the chain; an anonymous prober learns nothing
    // about the URL grammar, and no outbound fetch can ever fire (none is mocked).
    const res = await unfurl('not even a url', { user: null });
    expect(res.status).toBe(401);
  });

  it('400s a missing url param', async () => {
    expect((await unfurl(null)).status).toBe(400);
  });

  it('400s unparseable and non-http(s) URLs', async () => {
    for (const bad of ['not a url', 'ftp://files.example.com/x', 'javascript:alert(1)', 'https://', 'http://nodots']) {
      expect((await unfurl(bad)).status, `url ${JSON.stringify(bad)}`).toBe(400);
    }
  });

  it('400s every private-host class, including the hardened IPv6/trailing-dot/decimal forms', async () => {
    const blocked = [
      'http://localhost/x', // needs no dot — normalizeUrl special-cases it, the refine kills it
      'http://localhost./x', // trailing-dot resolution twin
      'http://sub.localhost/x',
      'http://foo.local/x',
      'http://internal.corp.internal/x',
      'http://127.0.0.1/x',
      'http://127.9.9.9/x',
      'http://10.1.2.3/x',
      'http://172.16.0.1/x',
      'http://192.168.1.1/x',
      'http://169.254.169.254/latest/meta-data', // the metadata endpoint itself
      'http://100.64.0.1/x', // CGNAT
      'http://192.0.0.1/x',
      'http://198.18.0.1/x', // benchmarking
      'http://224.0.0.1/x', // multicast
      'http://255.255.255.255/x',
      'http://0.0.0.0/x',
      'http://[::1]/x',
      'http://[::]/x',
      'http://[fd00::1]/x', // ULA
      'http://[fe80::1]/x', // link-local
      'http://[::ffff:127.0.0.1]/x', // IPv4-mapped loopback
      'http://[::ffff:10.0.0.1]/x', // IPv4-mapped RFC1918
      'http://2130706433/x', // decimal 127.0.0.1 — WHATWG normalizes before the refine
      'http://0x7f.0.0.1/x', // hex octet form
      'http://127.1/x', // shorthand
    ];
    for (const url of blocked) {
      expect((await unfurl(url)).status, `url ${url}`).toBe(400);
    }
  });

  it("labels the SSRF rejection 'URL not allowed' (distinct from a malformed URL)", async () => {
    const res = await unfurl('http://169.254.169.254/latest');
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('URL not allowed');
  });
});
