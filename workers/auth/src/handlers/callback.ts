import { generateUserId, normalizeRoomId, type RoomId } from '@avlo/shared';
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
  const finish = (status: 'ok' | 'denied' | 'error', returnTo: string, roomsBookmark = ''): Response => {
    const url = new URL(c.env.APP_ORIGIN + returnTo);
    url.searchParams.set('auth', status);
    // The post-adopt D1 read-your-writes bookmark (sync slice). `searchParams.set` encodes it;
    // the client (consumeAuthMarker) strips + stashes it for the first /rooms read.
    if (roomsBookmark) url.searchParams.set('rbm', roomsBookmark);
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

  // 10b. Anon rotation — EVERY sign-in that consumed a device anon id (promote AND adopt). Re-issue
  //    a fresh one so the leftover 400-day cookie can't resurrect the consumed id after sign-out on
  //    a shared machine. Adopt's rooms migrate INTO the account (step 11), so rotating strands
  //    nothing; thereafter the anon cookie only ever holds never-linked ids.
  if (anon) {
    await setSignedCookie(c, ANON_COOKIE, mintAnonToken(generateUserId()), c.env.ANON_SECRET, cookieOpts(c.req.raw, ANON_MAX_AGE_SEC));
  }

  // 11. ADOPT owner migration: `anon && linked.userId !== anon.userId` is EXACTLY adopt (promote
  //     has `linked.userId === anon.userId`, skipped above-or-here). It only ever migrates the
  //     ANON id's rooms, never `priorSession`'s account — the required safety property. Never
  //     throws (the orchestrator catches every branch); a failure just lets rooms converge via
  //     the migrate queue / on next reopen. The room signed in from is prioritized into the sync
  //     slice so it's never an overflow (which, if private, would 4403-prune the local board).
  let roomsBookmark = '';
  if (anon && linked.userId !== anon.userId) {
    try {
      const priorityRoomId = roomIdFromReturnTo(returnTo);
      ({ bookmark: roomsBookmark } = await c.env.USERS.migrateOwnedRooms(anon.userId, linked.userId, priorityRoomId));
    } catch {
      console.warn('[auth] owner migration failed — rooms converge via queue/reopen');
    }
  }

  return finish('ok', returnTo, roomsBookmark);
});

/** Parse a `/room/<id>` returnTo into a validated `RoomId` (the room the user signed in from —
 *  prioritized into the migration's synchronous slice). `/home` and any non-room path → undefined. */
function roomIdFromReturnTo(returnTo: string): RoomId | undefined {
  const m = /^\/room\/([^/?#]+)/.exec(returnTo);
  return m ? (normalizeRoomId(m[1]) ?? undefined) : undefined;
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
