import { cookieOpts } from '@avlo/worker-shared';
import { setCookie } from 'hono/cookie';
import { createFactory } from 'hono/factory';
import type { AuthEnv } from '../env';
import { deleteSession, readSession, SESSION_COOKIE } from '../session';

const factory = createFactory<AuthEnv>();

/**
 * `POST /logout` — delete the KV record (retried; on persistent failure the cookie clear
 * still lands and `exp`/`expirationTtl` are the backstop), then clear the cookie with the
 * SAME attributes it was set with (incl. prod Domain — a mismatched clear is a no-op).
 * Always 204: logout is not allowed to fail user-visibly. csrf in the index chain guards
 * the POST. The anon cookie is untouched — the device falls back to the fresh anon
 * identity minted by the sign-in rotation.
 */
export const handleLogout = factory.createHandlers(async (c) => {
  try {
    const sess = await readSession(c.req.raw.headers.get('cookie'), c.env.SESSIONS);
    if (sess) await deleteSession(c.env.SESSIONS, sess.kvKey);
  } catch {
    console.warn('[auth] logout KV delete failed — TTL is the backstop');
  }
  setCookie(c, SESSION_COOKIE, '', cookieOpts(c.req.raw, 0));
  return c.body(null, 204);
});
