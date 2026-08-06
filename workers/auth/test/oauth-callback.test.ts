import { env } from 'cloudflare:test';
import { generateRoomId, USER_ID_RE } from '@avlo/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { installTokenFailureMock, installTokenMock, signIdToken } from './google-mock';
import {
  anonCookie,
  anonIdFrom,
  flowCookie,
  generateUserId,
  hit,
  imagesStub,
  oracleSessionKvKey,
  seedSession,
  setCookieFor,
  setCookieValue,
  until,
  usersStub,
} from './harness';

// Per-call unique IPs keep RL_AUTH buckets under budget WITHOUT reset() — this file owns
// the 203.0.113.0/24 block (oauth-login: 192.0.2.0/24, logout: 198.51.100.0/24), so
// parallel files never share a bucket.
let nextIp = 0;

/** Drive the REAL /login to get a genuine state/nonce/verifier flow cookie. */
async function startLogin(returnTo?: string) {
  const ip = `203.0.113.${++nextIp % 250}`;
  const res = await hit(`/login/google${returnTo ? `?return_to=${encodeURIComponent(returnTo)}` : ''}`, {
    headers: { 'cf-connecting-ip': ip },
  });
  const loc = new URL(res.headers.get('location') ?? '');
  return {
    ip,
    state: loc.searchParams.get('state') ?? '',
    nonce: loc.searchParams.get('nonce') ?? '',
    challenge: loc.searchParams.get('code_challenge') ?? '',
    cookie: `avlo_oauth=${setCookieValue(res, 'avlo_oauth')}`,
  };
}

function callback(query: Record<string, string>, cookies: string[], ip = `203.0.113.${++nextIp % 250}`) {
  const qs = new URLSearchParams(query).toString();
  return hit(`/callback${qs ? `?${qs}` : ''}`, { headers: { 'cf-connecting-ip': ip, cookie: cookies.filter(Boolean).join('; ') } });
}

const redirectOf = (res: Response) => new URL(res.headers.get('location') ?? '');
const authMarkerOf = (res: Response) => redirectOf(res).searchParams.get('auth');

/** The rejection invariant: died BEFORE the account write — no session cookie minted AND
 *  the users stub never saw a linkAccount (the stubs reset per test, so zero means zero). */
async function expectDeadBeforeAccountWrite(res: Response): Promise<void> {
  expect(setCookieFor(res, 'avlo_session')).toBeNull();
  expect((await usersStub._calls()).linkAccount).toEqual([]);
}

/** The session record the callback wrote, read RAW from KV at the independently-derived
 *  key (never through src `readSession` — a symmetric read/write bug would survive that). */
async function kvRecordFor(token: string | null): Promise<unknown> {
  expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  return env.SESSIONS.get(await oracleSessionKvKey(token as string), { type: 'json' });
}

describe('GET /callback', () => {
  beforeEach(async () => {
    await usersStub._reset();
    await imagesStub._reset();
  });

  // --- Network-free rejections (die before the token exchange) ---

  it('errors to /home and deletes the flow cookie when none was presented (replay defense)', async () => {
    const res = await callback({ code: 'x', state: 'y' }, []);
    expect(res.status).toBe(302);
    expect(redirectOf(res).pathname).toBe('/home');
    expect(authMarkerOf(res)).toBe('error');
    // The delete is UNCONDITIONAL — a second identical callback finds no cookie and dies
    // identically; nothing about the first attempt survives.
    expect(setCookieFor(res, 'avlo_oauth')).toContain('avlo_oauth=;');
    await expectDeadBeforeAccountWrite(res);
  });

  it("maps the user's own cancel (error=access_denied) to auth=denied at the original returnTo", async () => {
    const { cookie } = await startLogin('/room/abcDEF12345678');
    const res = await callback({ error: 'access_denied' }, [cookie]);
    expect(authMarkerOf(res)).toBe('denied');
    expect(redirectOf(res).pathname).toBe('/room/abcDEF12345678');
    await expectDeadBeforeAccountWrite(res);
  });

  it('maps any other provider error to auth=error', async () => {
    const { cookie } = await startLogin();
    const res = await callback({ error: 'temporarily_unavailable' }, [cookie]);
    expect(authMarkerOf(res)).toBe('error');
    await expectDeadBeforeAccountWrite(res);
  });

  it('rejects a stale flow (iat older than the 600 s window) even with a valid signature', async () => {
    const stale = await flowCookie({ iat: Date.now() - 601_000 });
    const res = await callback({ code: 'x', state: 'test-state' }, [`avlo_oauth=${stale}`]);
    expect(authMarkerOf(res)).toBe('error');
    await expectDeadBeforeAccountWrite(res);
  });

  it('rejects a state echo that does not equal the sealed state (CSRF binding)', async () => {
    const { cookie } = await startLogin();
    const res = await callback({ code: 'x', state: 'not-the-sealed-state' }, [cookie]);
    expect(authMarkerOf(res)).toBe('error');
    await expectDeadBeforeAccountWrite(res);
  });

  it('rejects a callback missing the code entirely', async () => {
    const { cookie, state } = await startLogin();
    const res = await callback({ state }, [cookie]);
    expect(authMarkerOf(res)).toBe('error');
    await expectDeadBeforeAccountWrite(res);
  });

  it('errors (never retries) when the token exchange fails — the code is single-use', async () => {
    const { cookie, state } = await startLogin();
    installTokenFailureMock();
    const res = await callback({ code: 'bad-code', state }, [cookie]);
    expect(authMarkerOf(res)).toBe('error');
    await expectDeadBeforeAccountWrite(res);
  });

  // --- ID-token verification failures (mocked exchange succeeds, trust pipeline rejects) ---

  it('rejects an ID token signed by a key outside the JWKS', async () => {
    const { cookie, state, nonce } = await startLogin();
    installTokenMock(await signIdToken({ nonce, wrongKey: true }));
    const res = await callback({ code: 'c', state }, [cookie]);
    expect(authMarkerOf(res)).toBe('error');
    await expectDeadBeforeAccountWrite(res);
  });

  it('rejects an ID token minted for a different audience', async () => {
    const { cookie, state, nonce } = await startLogin();
    installTokenMock(await signIdToken({ nonce, aud: 'someone-elses-client' }));
    const res = await callback({ code: 'c', state }, [cookie]);
    expect(authMarkerOf(res)).toBe('error');
    await expectDeadBeforeAccountWrite(res);
  });

  it('rejects an ID token from a non-Google issuer', async () => {
    const { cookie, state, nonce } = await startLogin();
    installTokenMock(await signIdToken({ nonce, iss: 'https://evil.example' }));
    const res = await callback({ code: 'c', state }, [cookie]);
    expect(authMarkerOf(res)).toBe('error');
    await expectDeadBeforeAccountWrite(res);
  });

  it("rejects an ID token whose nonce is not THIS flow's", async () => {
    const { cookie, state } = await startLogin();
    installTokenMock(await signIdToken({ nonce: 'a-different-flows-nonce' }));
    const res = await callback({ code: 'c', state }, [cookie]);
    expect(authMarkerOf(res)).toBe('error');
    await expectDeadBeforeAccountWrite(res);
  });

  it('hard-requires email_verified — an unverified address must never key an account', async () => {
    const { cookie, state, nonce } = await startLogin();
    installTokenMock(await signIdToken({ nonce, email_verified: false }));
    const res = await callback({ code: 'c', state }, [cookie]);
    expect(authMarkerOf(res)).toBe('error');
    await expectDeadBeforeAccountWrite(res);
  });

  // --- Happy paths ---

  it('PKCE roundtrip: the callback sends a code_verifier whose S256 equals the challenge /login registered', async () => {
    // Full flow, verifier-checked: /login mints challenge+state+flow cookie → /callback
    // exchanges the code. The token mock 400s unless base64url(sha256(code_verifier))
    // equals THIS flow's code_challenge — so auth=ok proves the worker round-trips a
    // genuine PKCE pair. (Deleting the verifier from the exchange fails this test; every
    // other test would stay green.)
    const { cookie, state, nonce, challenge } = await startLogin();
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/); // S256 challenge shape, never `plain`
    installTokenMock(await signIdToken({ nonce }), { expectedChallenge: challenge });

    const res = await callback({ code: 'c', state }, [cookie]);
    expect(authMarkerOf(res)).toBe('ok');
    expect(setCookieValue(res, 'avlo_session')).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('PROMOTE: keeps the device anon id, mints the session, rotates the anon cookie, never migrates', async () => {
    const deviceAnonId = generateUserId();
    const { cookie, state, nonce } = await startLogin();
    installTokenMock(await signIdToken({ nonce, sub: 'promote-sub', email: 'p@example.com', name: 'Promoted P' }));

    const res = await callback({ code: 'c', state }, [cookie, await anonCookie(deviceAnonId)]);
    expect(authMarkerOf(res)).toBe('ok');

    // linkAccount saw the device's anon id (the stub echoes it back = promote).
    const calls = await usersStub._calls();
    expect(calls.linkAccount).toEqual([
      { currentUserId: deviceAnonId, googleSub: 'promote-sub', profile: { email: 'p@example.com', name: 'Promoted P', avatarHash: null } },
    ]);
    expect(calls.migrate).toEqual([]); // promote — same id, nothing to migrate

    // Session cookie + KV record carry the promoted id (raw KV read — the independent oracle).
    const record = await kvRecordFor(setCookieValue(res, 'avlo_session'));
    expect(record).toMatchObject({ userId: deviceAnonId, email: 'p@example.com', name: 'Promoted P' });

    // Anon ROTATION: a fresh id — the consumed one can never resurrect from the old cookie.
    const rotated = anonIdFrom(res);
    expect(rotated).toMatch(USER_ID_RE);
    expect(rotated).not.toBe(deviceAnonId);
  });

  it('ADOPT: session takes the account id, rooms migrate anon→account with the sign-in room prioritized, bookmark rides the redirect', async () => {
    const deviceAnonId = generateUserId();
    const accountId = generateUserId();
    const roomId = generateRoomId();
    await usersStub._set({
      linkAccountResult: { userId: accountId, avatarHash: 'cd'.repeat(16), bookmark: 'link-bm' },
      migrateResult: { bookmark: 'migrate-bm', migrated: 2, queued: 1 },
    });

    const { cookie, state, nonce } = await startLogin(`/room/${roomId}`);
    installTokenMock(await signIdToken({ nonce, sub: 'adopt-sub' }));
    const res = await callback({ code: 'c', state }, [cookie, await anonCookie(deviceAnonId)]);

    expect(authMarkerOf(res)).toBe('ok');
    const loc = redirectOf(res);
    expect(loc.pathname).toBe(`/room/${roomId}`);
    expect(loc.searchParams.get('rbm')).toBe('migrate-bm'); // the migration's RYW bookmark

    const calls = await usersStub._calls();
    expect(calls.migrate).toEqual([{ from: deviceAnonId, to: accountId, priorityRoomId: roomId }]);

    // The KV record holds the ACCOUNT id + linkAccount's post-coalesce avatarHash.
    const record = await kvRecordFor(setCookieValue(res, 'avlo_session'));
    expect(record).toMatchObject({ userId: accountId, avatarHash: 'cd'.repeat(16) });

    // Adopt consumed the anon id too — rotation still applies.
    expect(anonIdFrom(res)).not.toBe(deviceAnonId);
  });

  it('passes the ingested avatar hash into linkAccount when the picture claim is present', async () => {
    await imagesStub._set({ ingestResult: 'ef'.repeat(16) });
    const { cookie, state, nonce } = await startLogin();
    installTokenMock(await signIdToken({ nonce, picture: 'https://lh3.googleusercontent.com/a/pic=s96-c' }));

    const res = await callback({ code: 'c', state }, [cookie]);
    expect(authMarkerOf(res)).toBe('ok');
    expect((await imagesStub._calls()).ingest).toEqual(['https://lh3.googleusercontent.com/a/pic=s96-c']);
    expect((await usersStub._calls()).linkAccount[0]?.profile.avatarHash).toBe('ef'.repeat(16));
  });

  it('treats avatar-ingest RPC failure as non-fatal — sign-in proceeds with a null hash', async () => {
    await imagesStub._set({ ingestResult: 'throw' });
    const { cookie, state, nonce } = await startLogin();
    installTokenMock(await signIdToken({ nonce, picture: 'https://lh3.googleusercontent.com/a/pic=s96-c' }));

    const res = await callback({ code: 'c', state }, [cookie]);
    expect(authMarkerOf(res)).toBe('ok');
    expect((await usersStub._calls()).linkAccount[0]?.profile.avatarHash).toBeNull();
  });

  it('fails CLOSED when linkAccount fails: auth=error, no session cookie, no KV record', async () => {
    await usersStub._set({ linkAccountResult: 'throw' });
    const { cookie, state, nonce } = await startLogin();
    installTokenMock(await signIdToken({ nonce }));

    // The would-be session token never escapes on failure (no cookie), so the write is
    // pinned by a scoped before/after diff of this namespace slice — NOT a global
    // "KV is empty" assert, which parallel files seeding their own sessions would break.
    const keysBefore = (await env.SESSIONS.list({ prefix: 'sess:' })).keys.map((k) => k.name);
    const res = await callback({ code: 'c', state }, [cookie]);
    expect(authMarkerOf(res)).toBe('error');
    expect(setCookieFor(res, 'avlo_session')).toBeNull();
    const keysAfter = (await env.SESSIONS.list({ prefix: 'sess:' })).keys.map((k) => k.name);
    expect(keysAfter.sort()).toEqual(keysBefore.sort());
  });

  it('deletes the replaced KV session when a signed-in user signs in again', async () => {
    const priorUserId = generateUserId();
    const prior = await seedSession(priorUserId);
    const { cookie, state, nonce } = await startLogin();
    installTokenMock(await signIdToken({ nonce, sub: 'resignin-sub' }));

    const res = await callback({ code: 'c', state }, [cookie, prior.cookie]);
    expect(authMarkerOf(res)).toBe('ok');
    // The prior record dies via waitUntil — poll it out.
    await until(async () => (await env.SESSIONS.get(prior.kvKey)) === null, 'replaced-session delete');
    // With no anon cookie in play there is nothing to rotate and nothing to migrate.
    expect(anonIdFrom(res)).toBeNull();
    expect((await usersStub._calls()).migrate).toEqual([]);
    // The prior session's identity was what linkAccount consumed (account continuity).
    expect((await usersStub._calls()).linkAccount[0]?.currentUserId).toBe(priorUserId);
  });

  it('a replayed callback URL dies at the missing flow cookie — the full replay-defense round trip', async () => {
    const { cookie, state, nonce } = await startLogin();
    installTokenMock(await signIdToken({ nonce }));
    const ok = await callback({ code: 'c', state }, [cookie]);
    expect(authMarkerOf(ok)).toBe('ok');

    // Same URL again — the browser's flow cookie is gone (deleted by the first response).
    const replay = await callback({ code: 'c', state }, []);
    expect(authMarkerOf(replay)).toBe('error');
    expect(setCookieFor(replay, 'avlo_session')).toBeNull();
  });
});
