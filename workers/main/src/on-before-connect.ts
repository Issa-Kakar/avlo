import { ROOM_ID_RE } from '@avlo/shared';
import type { AuthRpcSurface } from '@avlo/worker-shared';
import type { HonoPartyServerOptions } from 'hono-party';

/**
 * Edge format-guard + auth stamp for the WS upgrade (§7/H16). hono-party passes the
 * Hono context as the 3rd arg, giving `c.env.AUTH`. Returns a mutated `Request` that
 * partyserver forwards to the DO (`ctx.request.headers` in `onConnect`).
 *
 * - A non-WS `Response` (the format guard's 400) is SWALLOWED by hono-party (index.js:57)
 *   → the browser sees an opaque 1006. Fine for a format pre-filter (not a security
 *   boundary — existence + permission still resolve in the DO).
 * - INVARIANT: this hook unconditionally OWNS `x-avlo-user-id` — set on verify success,
 *   DELETE on any failure. Never trust an inbound value (a non-browser client can spoof
 *   it on the upgrade; the unconditional delete neutralizes that).
 * - verify is `try/catch`ed so a thrown error funnels to the same absent-header → 4401
 *   in the DO, rather than propagating to hono-party's catch → opaque 1006.
 *
 * `c.env.AUTH` is an untyped service binding across wrangler configs (§5.1) — cast to
 * the shared `AuthRpcSurface`.
 */
export const makeOnBeforeConnect = (): HonoPartyServerOptions<{ Bindings: Env }>['onBeforeConnect'] => async (req, lobby, c) => {
  if (!ROOM_ID_RE.test(lobby.name)) return new Response('Bad Request', { status: 400 });

  let userId: string | null = null;
  try {
    const auth = c.env.AUTH as unknown as AuthRpcSurface;
    userId = (await auth.verifySession(req.headers.get('cookie')))?.userId ?? null;
  } catch {
    userId = null;
  }

  if (userId) req.headers.set('x-avlo-user-id', userId);
  else req.headers.delete('x-avlo-user-id');
  return req;
};
