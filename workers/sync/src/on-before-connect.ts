import { ROOM_ID_RE } from '@avlo/shared';
import { isAllowedOrigin, isDevHost } from '@avlo/worker-shared';
import type { HonoPartyServerOptions } from 'hono-party';
import type { SyncEnv } from './env';

/**
 * Edge Origin guard + format-guard + auth stamp for the WS upgrade (§7/H16). hono-party
 * passes the Hono context as the 3rd arg, giving `c.env.AUTH`. Returns a mutated `Request`
 * that partyserver forwards to the DO (`ctx.request.headers` in `onConnect`).
 *
 * - CSWSH guard FIRST: now that sync is cross-origin from the SPA (`sync.avlo.io`), an Origin
 *   allowlist gates the upgrade. Reuses the shared `isAllowedOrigin`/`isDevHost` predicate
 *   (`avlo.io`/`www.avlo.io` for prod, `http://localhost:*` gated to dev-by-Host) — the SAME
 *   set CORS reflection + the csrf guard read, so there's no allowlist drift. Browsers can't
 *   forge `Origin`, and `SameSite=Lax` already blocks the cross-site cookie send, so this is
 *   layered defense; a rejected upgrade's 403 is swallowed by hono-party → opaque close.
 * - A non-WS `Response` (the format guard's 400 / the 403 above) is SWALLOWED by hono-party
 *   (index.js:57) → the browser sees an opaque 1006. Fine for a pre-filter (not a security
 *   boundary — existence + permission still resolve in the DO).
 * - INVARIANT: this hook unconditionally OWNS `x-avlo-user-id` — set on verify success,
 *   DELETE on any failure. Never trust an inbound value (a non-browser client can spoof
 *   it on the upgrade; the unconditional delete neutralizes that).
 * - verify is `try/catch`ed so a thrown error funnels to the same absent-header → 4401
 *   in the DO, rather than propagating to hono-party's catch → opaque 1006.
 *
 * `c.env.AUTH` is an untyped service binding across wrangler configs (§5.1); `SyncEnv`
 * retypes it to the shared `AuthRpcSurface`, so the verify call needs no cast.
 */
export const makeOnBeforeConnect = (): HonoPartyServerOptions<SyncEnv>['onBeforeConnect'] => async (req, lobby, c) => {
  if (!isAllowedOrigin(req.headers.get('origin'), isDevHost(c.req.header('host')))) return new Response('Forbidden', { status: 403 });
  if (!ROOM_ID_RE.test(lobby.name)) return new Response('Bad Request', { status: 400 });

  let userId: string | null = null;
  try {
    userId = (await c.env.AUTH.verifySession(req.headers.get('cookie')))?.userId ?? null;
  } catch {
    userId = null;
  }

  if (userId) req.headers.set('x-avlo-user-id', userId);
  else req.headers.delete('x-avlo-user-id');
  return req;
};
