import { generateUserId } from '@avlo/shared';
import { ANON_COOKIE, cookieOpts, mintAnonToken, type UsersRpcSurface, verifyAnonToken } from '@avlo/worker-shared';
import { zValidator } from '@hono/zod-validator';
import { deleteCookie, getSignedCookie, setCookie, setSignedCookie } from 'hono/cookie';
import { createFactory } from 'hono/factory';
import type { z } from 'zod/v4';
import type { AuthEnv } from '../env';
import { FLOW_COOKIE, FLOW_MAX_AGE_SEC, makeGoogle, verifyGoogleIdToken } from '../oauth';
import { deleteSession, mintSessionToken, putSession, readSession, SESSION_COOKIE, SESSION_TTL_SEC, sessionKvKey } from '../session';
import { callbackQuery, OAuthFlowToken, sanitizeReturnTo } from '../zod/oauth';
import type { SessionRecord } from '../zod/session';
import { ANON_MAX_AGE_SEC } from './me';

const factory = createFactory<AuthEnv>();

/**
 * `GET /callback` — the OAuth trust pipeline, strictly ordered. Every exit is a top-level
 * 302 back into the app carrying a one-shot `?auth=ok|denied|error` marker; logging is
 * reason-code-only (H10 — the request URL itself carries `code`/`state`, so nothing here
 * may echo URLs, queries, tokens, or cookie payloads). Fail closed: any failure after the
 * token exchange exits with NO session cookie and no partial trust.
 */
export const handleCallback = factory.createHandlers(zValidator('query', callbackQuery), async (c) => {
  const finish = (status: 'ok' | 'denied' | 'error', returnTo: string, d1Bookmark?: string): Response => {
    const url = new URL(c.env.APP_ORIGIN + returnTo);
    url.searchParams.set('auth', status);
    // §9 — the second-device migration's read-your-writes bookmark, single-shot. The SPA's
    // consumeAuthMarker strips it (like `auth`) and seeds it as the rooms-query bookmark so
    // the first post-sign-in /rooms read sees the migrated ownership.
    if (d1Bookmark) url.searchParams.set('d1bm', d1Bookmark);
    return c.redirect(url.toString(), 302);
  };

  // 1. Flow cookie: read → delete UNCONDITIONALLY (single-use: a replayed callback URL
  //    finds no cookie and dies here) → verify shape. `returnTo` is re-sanitized — the
  //    value round-tripped through the browser and the signature only proves WE wrote it.
  const signed = await getSignedCookie(c, c.env.OAUTH_PKCE_SECRET, FLOW_COOKIE);
  deleteCookie(c, FLOW_COOKIE, { path: '/' });
  const flowParsed = OAuthFlowToken.safeParse(typeof signed === 'string' ? safeJson(signed) : null);
  if (!flowParsed.success) return finish('error', '/home');
  const flow = flowParsed.data;
  const returnTo = sanitizeReturnTo(flow.returnTo);

  // 2. Provider verdict. A user clicking "cancel" is `denied`, not an error.
  const { code, state, error } = c.req.valid('query');
  if (error === 'access_denied') return finish('denied', returnTo);
  if (error) {
    console.warn('[auth] oauth provider error');
    return finish('error', returnTo);
  }

  // 3. Freshness (the cookie Max-Age, re-checked server-side) + CSRF binding: the state
  //    echo must equal the cookie's — a cross-site-forged or mixed-up callback dies here.
  if (Date.now() - flow.iat > FLOW_MAX_AGE_SEC * 1000) return finish('error', returnTo);
  if (!code || !state || state !== flow.state) return finish('error', returnTo);

  // 4. Code → tokens (PKCE verifier proves same-browser). NEVER retried: the code is
  //    single-use and the exchange is not idempotent — a retry can only double-consume.
  let idToken: string;
  try {
    idToken = (await makeGoogle(c.env).validateAuthorizationCode(code, flow.codeVerifier)).idToken();
  } catch {
    console.warn('[auth] token exchange failed');
    return finish('error', returnTo);
  }

  // 5. Prove the ID token: signature/iss/aud/exp via Google's JWKS, claim narrowing
  //    (email_verified hard-required), nonce binding to THIS flow.
  const claims = await verifyGoogleIdToken(idToken, c.env.GOOGLE_CLIENT_ID, flow.nonce);
  if (!claims) {
    console.warn('[auth] id-token verification failed');
    return finish('error', returnTo);
  }

  // 6. Resolve the device's current identity. A KV failure here must not kill the login —
  //    it only changes WHICH id gets promoted (worst case a fresh one; adopt still wins on
  //    an existing account). The anon identity is read regardless: step 10b needs it.
  const cookieHeader = c.req.raw.headers.get('cookie');
  const priorSession = await readSession(cookieHeader, c.env.SESSIONS).catch(() => null);
  const anon = await verifyAnonToken(cookieHeader, c.env.ANON_SECRET);
  const currentUserId = priorSession?.record.userId ?? anon?.userId ?? generateUserId();
  const displayName = claims.name ?? claims.email.slice(0, claims.email.indexOf('@'));

  // 7. Avatar snapshot — awaited inline (login may take a beat — accepted), but
  //    best-effort: ANY failure, including a dead images worker, ⇒ null and sign-in
  //    proceeds. Ordered BEFORE linkAccount so the blob exists before anything refers to it.
  let avatarHash: string | null = null;
  if (claims.picture) {
    try {
      avatarHash = await c.env.IMAGES.ingestAvatar(claims.picture);
    } catch {
      console.warn('[auth] avatar ingest rpc failed');
    }
  }

  // 8. Promote-or-adopt + mint the KV session — FAIL CLOSED as one unit: if either write
  //    fails after retries, clear-exit with no session cookie (the upsert is idempotent,
  //    the next attempt converges; a linked-but-unsessioned run strands only an
  //    unreferenced avatar blob). The record carries linkAccount's RETURNED avatarHash —
  //    the post-coalesce truth (adopt may hand back an older snapshot when this device's
  //    ingest failed).
  const token = mintSessionToken();
  let linked: Awaited<ReturnType<UsersRpcSurface['linkAccount']>>;
  try {
    linked = await c.env.USERS.linkAccount(currentUserId, claims.sub, {
      email: claims.email,
      name: displayName,
      avatarHash,
    });
    const now = Date.now();
    const record = {
      v: 1,
      userId: linked.userId,
      googleSub: claims.sub,
      email: claims.email,
      name: displayName,
      ...(linked.avatarHash ? { avatarHash: linked.avatarHash } : {}),
      iat: now,
      exp: now + SESSION_TTL_SEC * 1000,
    } satisfies z.input<typeof SessionRecord>;
    await putSession(c.env.SESSIONS, await sessionKvKey(token), record);
  } catch {
    console.warn('[auth] linkAccount/session mint failed');
    return finish('error', returnTo);
  }

  // 9. The session cookie (Domain=.avlo.io in prod — sibling workers' verifySession reads it).
  setCookie(c, SESSION_COOKIE, token, cookieOpts(c.req.raw, SESSION_TTL_SEC));

  // 10a. Replaced-session hygiene — invisible, stays async.
  if (priorSession) {
    c.executionCtx.waitUntil(
      deleteSession(c.env.SESSIONS, priorSession.kvKey).catch(() =>
        console.warn('[auth] replaced-session delete failed — TTL is the backstop'),
      ),
    );
  }

  // 10b. Anon rotation, promote path ONLY: this sign-in consumed the device's anon id, so
  //    re-issue a fresh one — the leftover 400-day cookie must never resurrect the account
  //    identity after sign-out on a shared machine. The adopt path keeps the cookie (its id
  //    was never linked; rotating would strand that id's rooms). Induction: the anon cookie
  //    only ever holds never-linked ids.
  if (anon && linked.userId === anon.userId) {
    await setSignedCookie(c, ANON_COOKIE, mintAnonToken(generateUserId()), c.env.ANON_SECRET, cookieOpts(c.req.raw, ANON_MAX_AGE_SEC));
  }

  // 11. Second-device adopt migration (§9) — ONLY when this sign-in adopted an existing
  //     account (linked.userId !== the device's current id; PROMOTE returns the same id).
  //     Runs AFTER the session is minted so a partial fan-out can never fail-close sign-in;
  //     the returned bookmark covers the synchronously-migrated rooms and rides back as
  //     `d1bm` for the SPA's first read-your-writes /rooms read. Migration converges via the
  //     room-migrate queue / next sign-in if this call fails, so a throw is swallowed.
  let migrateBookmark = '';
  if (linked.userId !== currentUserId) {
    try {
      migrateBookmark = (await c.env.USERS.migrateOwnership(currentUserId, linked.userId)).bookmark;
    } catch {
      console.warn('[auth] ownership migration failed — eventual');
    }
  }

  return finish('ok', returnTo, migrateBookmark);
});

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
