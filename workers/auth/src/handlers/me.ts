import { colorForUserId, generateUserId, nameForUserId, type UserId } from '@avlo/shared';
import { ANON_COOKIE, AnonToken, cookieOpts, mintAnonToken } from '@avlo/worker-shared';
import type { Context } from 'hono';
import { getSignedCookie, setCookie, setSignedCookie } from 'hono/cookie';
import type { MeResponse } from '../app-type';
import type { AuthEnv } from '../env';
import { readSession, SESSION_COOKIE, SESSION_SLIDE_THRESHOLD_MS, SESSION_TTL_SEC, type SessionHit, slideSession } from '../session';

// 400 days — the browser Max-Age ceiling. Sliding (re-bumped every /me), so the
// anon cookie is effectively permanent for any returning visitor (§3/§11).
// Exported for the callback's sign-in anon rotation.
export const ANON_MAX_AGE_SEC = 400 * 24 * 60 * 60;

/**
 * `GET /me` — the single identity resolver (§2). Account branch first: a valid
 * `avlo_session` KV record wins; its cookie re-sets on every hit (header-only slide) and
 * the KV record re-puts only when it's within the slide threshold. KV infrastructure
 * failure degrades to the anon path (see `verifySession`). Anon path: verify `avlo_anon`;
 * present → re-bump Max-Age
 * (header-only); absent/invalid → mint a fresh `userId`. `name`/`color` are
 * deterministic from `userId` for anon; an account carries its Google name + avatar.
 */
export async function handleMe(c: Context<AuthEnv>): Promise<Response> {
  let sess: SessionHit | null = null;
  try {
    sess = await readSession(c.req.raw.headers.get('cookie'), c.env.SESSIONS);
  } catch {
    console.warn('[auth] /me session read failed — degrading to anon');
  }
  if (sess) {
    const { record, token, kvKey } = sess;
    setCookie(c, SESSION_COOKIE, token, cookieOpts(c.req.raw, SESSION_TTL_SEC));
    if (record.exp - Date.now() < SESSION_SLIDE_THRESHOLD_MS) {
      c.executionCtx.waitUntil(slideSession(c.env.SESSIONS, kvKey, record).catch(() => console.warn('[auth] session slide failed')));
    }
    const body: MeResponse = {
      userId: record.userId,
      isAnon: false,
      name: record.name,
      color: colorForUserId(record.userId),
      email: record.email,
      ...(record.avatarHash ? { avatarHash: record.avatarHash } : {}),
    };
    return c.json(body);
  }

  const secret = c.env.ANON_SECRET;

  // getSignedCookie → verified JSON string | false (bad signature) | undefined (absent).
  const signed = await getSignedCookie(c, secret, ANON_COOKIE);
  let userId: UserId | null = null;

  if (typeof signed === 'string') {
    const parsed = AnonToken.safeParse(safeJson(signed));
    if (parsed.success) {
      userId = parsed.data.userId;
      // Returning visitor — re-issue the SAME token to slide the window (no I/O).
      await setSignedCookie(c, ANON_COOKIE, signed, secret, cookieOpts(c.req.raw, ANON_MAX_AGE_SEC));
    }
  }

  if (!userId) {
    userId = generateUserId();
    await setSignedCookie(c, ANON_COOKIE, mintAnonToken(userId), secret, cookieOpts(c.req.raw, ANON_MAX_AGE_SEC));
  }

  const body: MeResponse = { userId, isAnon: true, name: nameForUserId(userId), color: colorForUserId(userId) };
  return c.json(body);
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
