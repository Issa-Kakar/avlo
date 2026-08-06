import { env } from 'cloudflare:test';
import { colorForUserId, generateUserId, nameForUserId, USER_ID_RE, type UserId } from '@avlo/shared';
import { sha256Hex } from '@avlo/worker-shared';
import { describe, expect, it } from 'vitest';
import { SESSION_SLIDE_THRESHOLD_MS } from '../src/session';
import { anonCookie, anonIdFrom, hit, seedSession, setCookieFor, setCookieValue, until } from './harness';

// Slide-boundary seeds derive from the REAL threshold — a day either side of it — so a
// production threshold change moves the tests with it instead of failing confusingly.
const DAY_MS = 24 * 60 * 60 * 1000;

describe('GET /me', () => {
  it('mints a fresh anon identity with deterministic name/color and prod cookie attrs', async () => {
    const res = await hit('/me');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { userId: UserId; isAnon: boolean; name: string; color: string };
    expect(body.userId).toMatch(USER_ID_RE);
    expect(body.isAnon).toBe(true);
    // name/color derive from the id — the same identity renders identically on every peer.
    expect(body.name).toBe(nameForUserId(body.userId));
    expect(body.color).toBe(colorForUserId(body.userId));

    const cookie = setCookieFor(res, 'avlo_anon');
    expect(cookie).toBeTruthy();
    // Prod host ⇒ cross-subdomain Domain + Secure; Lax for the OAuth top-level redirect.
    expect(cookie).toContain('Domain=.avlo.io');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain(`Max-Age=${400 * 24 * 60 * 60}`);
    expect(anonIdFrom(res)).toBe(body.userId);
  });

  it('omits Domain and Secure on a dev (localhost) request so http dev cookies work', async () => {
    const res = await hit('/me', {}, 'localhost:8792');
    const cookie = setCookieFor(res, 'avlo_anon');
    expect(cookie).toBeTruthy();
    expect(cookie).not.toContain('Domain=');
    expect(cookie).not.toContain('Secure');
  });

  it('re-issues the SAME token for a returning anon visitor (sliding window, stable id)', async () => {
    const first = await hit('/me');
    const firstId = anonIdFrom(first);
    const firstValue = setCookieValue(first, 'avlo_anon');

    const second = await hit('/me', { headers: { cookie: `avlo_anon=${firstValue}` } });
    const body = (await second.json()) as { userId: string };
    expect(body.userId).toBe(firstId);
    // Same token re-signed — the payload (incl. nonce+iat) is byte-identical.
    expect(setCookieValue(second, 'avlo_anon')).toBe(firstValue);
  });

  it('mints a FRESH identity when the anon cookie signature does not verify', async () => {
    const first = await hit('/me');
    const value = setCookieValue(first, 'avlo_anon');
    if (!value) throw new Error('no anon cookie');
    // Flip one payload character — HMAC must fail, never "mostly valid".
    const tampered = value.replace(/%22userId%22/, '%22userXd%22');
    const res = await hit('/me', { headers: { cookie: `avlo_anon=${tampered}` } });
    const body = (await res.json()) as { userId: string };
    expect(body.userId).not.toBe(anonIdFrom(first));
    expect(body.userId).toMatch(USER_ID_RE);
  });

  it('serves the account branch for a valid KV session — email present, cookie re-set, no premature KV slide', async () => {
    const userId = generateUserId();
    // Remaining lifetime one day ABOVE the slide threshold ⇒ no KV re-put.
    const { cookie, kvKey } = await seedSession(userId, {
      email: 'acct@example.com',
      name: 'Acct Name',
      avatarHash: 'ab'.repeat(16),
      expInMs: SESSION_SLIDE_THRESHOLD_MS + DAY_MS,
    });
    const before = await env.SESSIONS.get(kvKey);

    const res = await hit('/me', { headers: { cookie } });
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ userId, isAnon: false, name: 'Acct Name', email: 'acct@example.com', avatarHash: 'ab'.repeat(16) });
    expect(body.color).toBe(colorForUserId(userId));
    // Cookie slides on EVERY hit (header-only)…
    expect(setCookieFor(res, 'avlo_session')).toContain('Max-Age=');
    // …but the KV record does NOT re-put while comfortably inside the slide threshold.
    expect(await env.SESSIONS.get(kvKey)).toBe(before);
    // No anon cookie on the account branch.
    expect(setCookieFor(res, 'avlo_anon')).toBeNull();
  });

  it('re-puts the KV record once remaining lifetime crosses the slide threshold', async () => {
    const userId = generateUserId();
    // Remaining lifetime one day BELOW the slide threshold ⇒ slide expected.
    const { cookie, kvKey } = await seedSession(userId, { expInMs: SESSION_SLIDE_THRESHOLD_MS - DAY_MS });
    const before = JSON.parse((await env.SESSIONS.get(kvKey)) ?? '{}') as { exp: number };

    await hit('/me', { headers: { cookie } });
    const after = await until(async () => {
      const record = JSON.parse((await env.SESSIONS.get(kvKey)) ?? '{}') as { exp: number };
      return record.exp > before.exp ? record : null;
    }, 'KV slide');
    expect(after?.exp).toBeGreaterThan(before.exp);
  });

  it('degrades an expired session record to the anon path', async () => {
    const userId = generateUserId();
    const { cookie } = await seedSession(userId, { expInMs: -1000 }); // exp in the past, KV TTL not yet hit
    const res = await hit('/me', { headers: { cookie } });
    const body = (await res.json()) as { userId: string; isAnon: boolean };
    expect(body.isAnon).toBe(true);
    expect(body.userId).not.toBe(userId);
  });

  it('degrades a corrupt / legacy-shaped KV record to the anon path', async () => {
    const token = 'A'.repeat(43);
    const kvKey = `sess:${await sha256Hex(new TextEncoder().encode(token))}`;

    await env.SESSIONS.put(kvKey, 'not json {{{');
    const corrupt = await hit('/me', { headers: { cookie: `avlo_session=${token}` } });
    expect(((await corrupt.json()) as { isAnon: boolean }).isAnon).toBe(true);

    await env.SESSIONS.put(kvKey, JSON.stringify({ userId: 'someone', legacy: true })); // no v/exp — pre-schema shape
    const legacy = await hit('/me', { headers: { cookie: `avlo_session=${token}` } });
    expect(((await legacy.json()) as { isAnon: boolean }).isAnon).toBe(true);
  });

  it("degrades a KV OUTAGE to the still-valid anon identity — handleMe's own try/catch, not the RPC path", async () => {
    // rpc.test.ts pins the same availability tradeoff inside AuthRpc; this covers the
    // handler's independent catch (me.ts) — a KV incident must not 500 identity boot,
    // and must fall through to the device cookie rather than minting a fresh id.
    const { cookie } = await seedSession(generateUserId());
    const first = await hit('/me');
    const anonId = anonIdFrom(first);
    const anonValue = setCookieValue(first, 'avlo_anon');

    const deadKv = { get: () => Promise.reject(new Error('kv down')) } as unknown as typeof env.SESSIONS;
    const res = await hit('/me', { headers: { cookie: `${cookie}; avlo_anon=${anonValue}` } }, 'auth.avlo.io', {
      ...env,
      SESSIONS: deadKv,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { userId: string; isAnon: boolean };
    expect(body.isAnon).toBe(true);
    expect(body.userId).toBe(anonId);
  });

  it('keeps a valid anon identity alongside a dead session cookie (fallback chains, not resets)', async () => {
    const first = await hit('/me');
    const anonId = anonIdFrom(first);
    const anonValue = setCookieValue(first, 'avlo_anon');
    const res = await hit('/me', { headers: { cookie: `avlo_session=${'B'.repeat(43)}; avlo_anon=${anonValue}` } });
    const body = (await res.json()) as { userId: string };
    expect(body.userId).toBe(anonId);
  });

  it('is NOT rate limited — identity boot must survive NAT-shared IPs', async () => {
    for (let i = 0; i < 15; i++) {
      const res = await hit('/me', { headers: { 'cf-connecting-ip': '10.0.0.99' } });
      expect(res.status).toBe(200);
    }
  });

  it('stamps no-store on identity responses', async () => {
    const res = await hit('/me');
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('round-trips the harness-minted anon cookie (the cross-suite cookie contract)', async () => {
    // test-support/cookies.ts mirrors hono's signed-cookie format; if this drifts, the
    // sync suite's whole identity chain silently degrades to fresh mints.
    const userId = generateUserId();
    const res = await hit('/me', { headers: { cookie: await anonCookie(userId) } });
    const body = (await res.json()) as { userId: string };
    expect(body.userId).toBe(userId);
  });
});
