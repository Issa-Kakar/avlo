import { env } from 'cloudflare:test';
import { generateUserId } from '@avlo/shared';
import { describe, expect, it } from 'vitest';
import { anonCookie, hit, seedSession, setCookieFor, setCookies } from './harness';

// Distinct IP per call keeps every RL_AUTH bucket under budget with NO reset() (a global
// reset() would wipe other files' KV mid-test under parallel runners). This file owns
// 198.51.100.0/24 (oauth-login: 192.0.2.0/24, oauth-callback: 203.0.113.0/24), so
// parallel files never share a bucket. A counter, never Math.random — a random collision
// would be unreproducible from the failure output.
let ipSeq = 0;
const logout = (cookies: string[], headers: Record<string, string> = {}) =>
  hit('/logout', {
    method: 'POST',
    headers: {
      'cf-connecting-ip': `198.51.100.${++ipSeq}`,
      origin: 'https://avlo.io',
      cookie: cookies.join('; '),
      ...headers,
    },
  });

describe('POST /logout', () => {
  it('is always 204 — even with no session at all', async () => {
    const res = await logout([]);
    expect(res.status).toBe(204);
  });

  it('deletes the KV record and clears the cookie with matching prod attributes', async () => {
    const { cookie, kvKey } = await seedSession(generateUserId());
    const res = await logout([cookie]);
    expect(res.status).toBe(204);
    expect(await env.SESSIONS.get(kvKey)).toBeNull();
    const clear = setCookieFor(res, 'avlo_session');
    // Max-Age=0 with the SAME Domain/Secure the cookie was set with — else the clear no-ops.
    expect(clear).toContain('avlo_session=;');
    expect(clear).toContain('Max-Age=0');
    expect(clear).toContain('Domain=.avlo.io');
    expect(clear).toContain('Secure');
  });

  it('leaves the anon cookie untouched — the device falls back to its rotated anon identity', async () => {
    const { cookie } = await seedSession(generateUserId());
    const res = await logout([cookie, await anonCookie(generateUserId())]);
    expect(setCookies(res).some((c) => c.startsWith('avlo_anon='))).toBe(false);
  });

  it('rejects a cross-site form POST with 403 (csrf over the shared origin allowlist)', async () => {
    const { cookie, kvKey } = await seedSession(generateUserId());
    const res = await logout([cookie], { origin: 'https://evil.example', 'content-type': 'application/x-www-form-urlencoded' });
    expect(res.status).toBe(403);
    expect(await env.SESSIONS.get(kvKey)).not.toBeNull(); // the delete never ran
  });

  it('rejects a content-type-less cross-site POST too (the bare-fetch CSRF shape)', async () => {
    const { cookie } = await seedSession(generateUserId());
    const ip = '198.51.100.250';
    const res = await hit('/logout', { method: 'POST', headers: { 'cf-connecting-ip': ip, origin: 'https://evil.example', cookie } });
    expect(res.status).toBe(403);
  });

  it('accepts the allowed origin for the same form content-type (the matrix pivot is origin, not content-type)', async () => {
    const { cookie, kvKey } = await seedSession(generateUserId());
    const res = await logout([cookie], { 'content-type': 'application/x-www-form-urlencoded' });
    expect(res.status).toBe(204);
    expect(await env.SESSIONS.get(kvKey)).toBeNull();
  });
});
