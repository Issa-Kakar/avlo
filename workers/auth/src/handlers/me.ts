import { colorForUserId, generateUserId, nameForUserId, type UserId } from '@avlo/shared';
import { ANON_COOKIE, AnonToken, cookieOpts, mintAnonToken } from '@avlo/worker-shared';
import type { Context } from 'hono';
import { getSignedCookie, setSignedCookie } from 'hono/cookie';
import type { MeResponse } from '../app-type';

// 400 days — the browser Max-Age ceiling. Sliding (re-bumped every /me), so the
// anon cookie is effectively permanent for any returning visitor (§3/§11).
const MAX_AGE_SEC = 400 * 24 * 60 * 60;

/**
 * `GET /me` — the single identity resolver (§2). Anonymous path only (account/KV is
 * the OAuth seam): verify `avlo_anon`; present → re-bump Max-Age (header-only);
 * absent/invalid → mint a fresh `userId`, set the signed cookie. `name`/`color` are
 * deterministic from `userId` (`@avlo/shared`), so the cookie is the sole source.
 */
export async function handleMe(c: Context<{ Bindings: Env }>): Promise<Response> {
  const secret = c.env.ANON_SECRET;

  // getSignedCookie → verified JSON string | false (bad signature) | undefined (absent).
  const signed = await getSignedCookie(c, secret, ANON_COOKIE);
  let userId: UserId | null = null;

  if (typeof signed === 'string') {
    const parsed = AnonToken.safeParse(safeJson(signed));
    if (parsed.success) {
      userId = parsed.data.userId;
      // Returning visitor — re-issue the SAME token to slide the window (no I/O).
      await setSignedCookie(c, ANON_COOKIE, signed, secret, cookieOpts(c.req.raw, MAX_AGE_SEC));
    }
  }

  if (!userId) {
    userId = generateUserId();
    await setSignedCookie(c, ANON_COOKIE, mintAnonToken(userId), secret, cookieOpts(c.req.raw, MAX_AGE_SEC));
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
