/**
 * Auth-suite harness: direct `worker.fetch` driving (unit-style — no SELF round trip
 * needed; nothing here touches caches.default), cookie mint/parse helpers over the
 * dependency-free test-support primitives, and typed control handles for the recording
 * users/images stubs.
 */

import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { generateUserId, type UserId } from '@avlo/shared';
import { mintAnonCookie, signedCookie } from '@avlo/test-support/cookies';
import worker from '../src/index';
import { mintSessionToken, SESSION_TTL_SEC, sessionKvKey } from '../src/session';

/** Mirror the vitest.config.ts test bindings. */
export const ANON_SECRET = 'test-anon-secret';
export const PKCE_SECRET = 'test-pkce-secret';

export { generateUserId };

/** One request against the auth app; waits out `waitUntil`s (session slide/delete).
 *  `envOverride` swaps poisoned bindings in for outage-path tests. */
export async function hit(path: string, init: RequestInit = {}, host = 'auth.avlo.io', envOverride: typeof env = env): Promise<Response> {
  const ctx = createExecutionContext();
  const proto = host.startsWith('localhost') || host.startsWith('127.') ? 'http' : 'https';
  const headers = new Headers(init.headers);
  if (!headers.has('host')) headers.set('host', host);
  const res = await worker.fetch(new Request(`${proto}://${host}${path}`, { ...init, headers }), envOverride, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

export const anonCookie = (userId: string): Promise<string> => mintAnonCookie(userId, ANON_SECRET);

/** Mint a signed `avlo_oauth` flow cookie directly (the network-free /callback entry). */
export function flowCookie(payload: {
  state?: string;
  codeVerifier?: string;
  nonce?: string;
  returnTo?: string;
  iat?: number;
}): Promise<string> {
  const flow = JSON.stringify({
    state: payload.state ?? 'test-state',
    codeVerifier: payload.codeVerifier ?? 'test-verifier',
    nonce: payload.nonce ?? 'test-nonce',
    returnTo: payload.returnTo ?? '/home',
    iat: payload.iat ?? Date.now(),
  });
  return signedCookie('avlo_oauth', flow, PKCE_SECRET);
}

/**
 * Seed a KV session; returns the cookie string + kv key. SEEDING uses the worker's real
 * `mintSessionToken`/`sessionKvKey` — the seeded state must be exactly what production
 * writes, or the tests exercise a parallel universe. (Asserting what the WORKER wrote is
 * the opposite discipline — see `oracleSessionKvKey`.)
 */
export async function seedSession(
  userId: UserId,
  opts: { email?: string; name?: string; avatarHash?: string; expInMs?: number } = {},
): Promise<{ cookie: string; token: string; kvKey: string }> {
  const token = mintSessionToken();
  const kvKey = await sessionKvKey(token);
  const now = Date.now();
  const record = {
    v: 1,
    userId,
    googleSub: `sub-${userId}`,
    email: opts.email ?? 'user@example.com',
    name: opts.name ?? 'Test User',
    ...(opts.avatarHash ? { avatarHash: opts.avatarHash } : {}),
    iat: now,
    exp: now + (opts.expInMs ?? SESSION_TTL_SEC * 1000),
  };
  await env.SESSIONS.put(kvKey, JSON.stringify(record), { expirationTtl: SESSION_TTL_SEC });
  return { cookie: `avlo_session=${token}`, token, kvKey };
}

/**
 * ORACLE-side `sess:<sha256hex(token)>` derivation — deliberately independent of
 * `src/session.ts` (own WebCrypto call, no shared helper). Asserting a callback-minted
 * session through `readSession` would be self-consistency — a symmetric read/write bug
 * survives it; deriving the key here and reading KV raw does not.
 */
export async function oracleSessionKvKey(token: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)));
  let hex = '';
  for (const b of digest) hex += b.toString(16).padStart(2, '0');
  return `sess:${hex}`;
}

/** All Set-Cookie strings on a response. */
export const setCookies = (res: Response): string[] => res.headers.getSetCookie();

/** The full Set-Cookie string for `name`, or null. */
export const setCookieFor = (res: Response, name: string): string | null => setCookies(res).find((c) => c.startsWith(`${name}=`)) ?? null;

/** The raw (still URI-encoded) value part of the `name` Set-Cookie. */
export function setCookieValue(res: Response, name: string): string | null {
  const c = setCookieFor(res, name);
  if (!c) return null;
  return c.slice(name.length + 1, c.indexOf(';') === -1 ? undefined : c.indexOf(';'));
}

/** Decode a signed-cookie value (hono format) into its JSON payload. */
export function decodeSignedPayload(encodedValue: string): unknown {
  const raw = decodeURIComponent(encodedValue);
  return JSON.parse(raw.slice(0, raw.lastIndexOf('.')));
}

/** `avlo_anon` userId minted/re-issued on a response, or null. */
export function anonIdFrom(res: Response): string | null {
  const v = setCookieValue(res, 'avlo_anon');
  return v ? (decodeSignedPayload(v) as { userId: string }).userId : null;
}

export { until } from '@avlo/test-support/until';

// --- Recording-stub control surfaces (service bindings are untyped across configs) ---

export interface RecordedLinkAccount {
  currentUserId: string;
  googleSub: string;
  profile: { email: string; name: string; avatarHash: string | null };
}
export interface RecordedMigrate {
  from: string;
  to: string;
  priorityRoomId: string | null;
}

interface UsersStubControl {
  _reset(): Promise<void>;
  _calls(): Promise<{ linkAccount: RecordedLinkAccount[]; migrate: RecordedMigrate[] }>;
  _set(patch: Record<string, unknown>): Promise<void>;
}
interface ImagesStubControl {
  _reset(): Promise<void>;
  _calls(): Promise<{ ingest: string[] }>;
  _set(patch: Record<string, unknown>): Promise<void>;
}

export const usersStub = env.USERS as unknown as UsersStubControl;
export const imagesStub = env.IMAGES as unknown as ImagesStubControl;
