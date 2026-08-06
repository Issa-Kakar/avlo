import { describe, expect, it } from 'vitest';
import { decodeSignedPayload, hit, setCookieFor, setCookieValue } from './harness';

// Per-call unique IPs keep every test inside the RL_AUTH per-IP budget with NO reset()
// (a global reset() would wipe other files' KV mid-test under parallel runners). This
// file owns 192.0.2.0/24 (logout: 198.51.100.0/24, oauth-callback: 203.0.113.0/24) so
// parallel files never share a bucket. A counter, never Math.random — a random collision
// would be unreproducible from the failure output.
let ipSeq = 0;
const login = (query = '', ip = `192.0.2.${++ipSeq % 250}`) => hit(`/login/google${query}`, { headers: { 'cf-connecting-ip': ip } });

/** The flow-cookie payload a /login response sealed. */
const flowPayloadOf = (res: Response) =>
  decodeSignedPayload(setCookieValue(res, 'avlo_oauth') ?? '') as {
    state: string;
    codeVerifier: string;
    nonce: string;
    returnTo: string;
    iat: number;
  };

describe('GET /login/google', () => {
  it('302s to Google with PKCE S256, state, nonce, account chooser, and NO offline access', async () => {
    const res = await login();
    expect(res.status).toBe(302);
    const url = new URL(res.headers.get('location') ?? '');
    expect(url.origin).toBe('https://accounts.google.com');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('scope')).toBe('openid email profile');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBeTruthy();
    expect(url.searchParams.get('state')).toBeTruthy();
    expect(url.searchParams.get('nonce')).toBeTruthy();
    expect(url.searchParams.get('prompt')).toBe('select_account');
    expect(url.searchParams.get('redirect_uri')).toBe('https://auth.avlo.io/callback');
    // Google tokens are never stored — no refresh-token grant is ever requested.
    expect(url.searchParams.get('access_type')).toBeNull();
  });

  it('seals state+verifier+nonce into a single-use host-only flow cookie (Max-Age 600, no Domain)', async () => {
    const res = await login();
    const cookie = setCookieFor(res, 'avlo_oauth');
    expect(cookie).toContain('Max-Age=600');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax'); // Strict would drop it on Google's cross-site GET back
    expect(cookie).not.toContain('Domain='); // only this worker's /callback ever reads it

    const flow = flowPayloadOf(res);
    const url = new URL(res.headers.get('location') ?? '');
    expect(flow.state).toBe(url.searchParams.get('state'));
    expect(flow.nonce).toBe(url.searchParams.get('nonce'));
    expect(flow.codeVerifier).toBeTruthy();
    expect(flow.returnTo).toBe('/home');
  });

  it('keeps a valid return_to path and sanitizes every open-redirect shape to /home', async () => {
    const kept = await login(`?return_to=${encodeURIComponent('/room/abcDEF12345678')}`);
    expect(flowPayloadOf(kept).returnTo).toBe('/room/abcDEF12345678');

    // Protocol-relative, backslash, absolute, no-slash, control bytes, oversized.
    const evil = ['//evil.com', '/\\evil.com', 'https://evil.com/x', 'room/x', '/x\r\ny', `/${'a'.repeat(300)}`];
    for (const raw of evil) {
      const res = await login(`?return_to=${encodeURIComponent(raw)}`);
      expect(flowPayloadOf(res).returnTo, `return_to ${JSON.stringify(raw)}`).toBe('/home');
    }
  });

  it('mints fresh state/verifier/nonce per attempt — no cross-attempt reuse', async () => {
    const a = flowPayloadOf(await login());
    const b = flowPayloadOf(await login());
    expect(a.state).not.toBe(b.state);
    expect(a.codeVerifier).not.toBe(b.codeVerifier);
    expect(a.nonce).not.toBe(b.nonce);
  });

  it('rate limits by IP — the 11th hit inside a minute is 429', async () => {
    // Per-RUN unique IP (time-derived, outside every file's counter block): with no
    // reset() to refill buckets, a fixed IP would 429 immediately on a watch-mode re-run
    // inside the limiter's 60 s window.
    const t = Date.now();
    const rlIp = `10.99.${(t >>> 8) & 255}.${t & 255}`;
    for (let i = 0; i < 10; i++) {
      expect((await login('', rlIp)).status).toBe(302);
    }
    expect((await login('', rlIp)).status).toBe(429);
    // A different IP is unaffected — the key is per-IP, not global.
    expect((await login('')).status).toBe(302);
  });
});
