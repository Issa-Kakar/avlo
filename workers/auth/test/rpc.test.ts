import { createExecutionContext, env } from 'cloudflare:test';
import { generateUserId } from '@avlo/shared';
import { describe, expect, it } from 'vitest';
import { AuthRpc } from '../src/rpc';
import { anonCookie, seedSession } from './harness';

/** Direct construction — the RPC surface without a service-binding round trip. */
const rpc = (overrides: Partial<typeof env> = {}) =>
  new AuthRpc(createExecutionContext() as ExecutionContext, { ...env, ...overrides } as typeof env);

describe('AuthRpc.verifySession', () => {
  it('resolves a KV session to a non-anon identity', async () => {
    const userId = generateUserId();
    const { cookie } = await seedSession(userId);
    expect(await rpc().verifySession(cookie)).toEqual({ userId, isAnon: false });
  });

  it('falls back to the signed anon cookie when no session is present', async () => {
    const userId = generateUserId();
    expect(await rpc().verifySession(await anonCookie(userId))).toEqual({ userId, isAnon: true });
  });

  it('prefers the session when BOTH cookies are present (account wins over device anon)', async () => {
    const sessionUser = generateUserId();
    const anonUser = generateUserId();
    const { cookie } = await seedSession(sessionUser);
    const both = `${cookie}; ${await anonCookie(anonUser)}`;
    expect(await rpc().verifySession(both)).toEqual({ userId: sessionUser, isAnon: false });
  });

  it('returns null for garbage — empty header, junk cookies, tampered anon token', async () => {
    expect(await rpc().verifySession(null)).toBeNull();
    expect(await rpc().verifySession('')).toBeNull();
    expect(await rpc().verifySession('avlo_session=short; other=1')).toBeNull();
    const valid = await anonCookie(generateUserId());
    expect(await rpc().verifySession(valid.replace('avlo_anon=', 'avlo_anon=x'))).toBeNull();
  });

  it('degrades a KV outage to the anon identity, NOT null — the pinned availability tradeoff', async () => {
    // Every gated worker (images/unfurl/users/sync) inherits this behavior: a KV incident
    // downgrades signed-in users to their device identity instead of 500-ing all of them.
    // Flipping to fail-closed = removing the try/catch fallthrough in #resolveSession.
    const sessionUser = generateUserId();
    const anonUser = generateUserId();
    const { cookie } = await seedSession(sessionUser);
    const both = `${cookie}; ${await anonCookie(anonUser)}`;
    const deadKv = { get: () => Promise.reject(new Error('kv down')) } as unknown as KVNamespace;
    expect(await rpc({ SESSIONS: deadKv }).verifySession(both)).toEqual({ userId: anonUser, isAnon: true });
  });
});
