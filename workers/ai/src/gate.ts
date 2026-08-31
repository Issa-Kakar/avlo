import { parseAgentName } from '@avlo/shared';
import { isAllowedOrigin, isDevHost } from '@avlo/worker-shared';
import type { Context } from 'hono';
import type { AiEnv } from './env';

/**
 * Edge guard for `/agents/*` — the sync `on-before-connect` pattern, adapted
 * for `routeAgentRequest`'s partyserver hooks. Runs BEFORE the DO on both the
 * WS upgrade (`onBeforeConnect`) and the chat HTTP endpoints
 * (`onBeforeRequest`).
 *
 * THE EDGE IS THE ENFORCEMENT POINT — unauthenticated or name-mismatched
 * requests are REJECTED here and never reach the DO. This is stricter than
 * sync's stamp-and-let-the-DO-close model, deliberately: AIChatAgent's
 * message layer processes chat frames ahead of user `onMessage` overrides, so
 * a socket admitted to the DO pre-close could trigger model turns billed to
 * the name's owner. Rejecting pre-DO closes that window completely (the DO's
 * own onConnect check remains as defense-in-depth). The browser can't read a
 * failed upgrade's status — acceptable: the panel gates locally on `isAnon`
 * and never attempts an unauthenticated connect.
 *
 * Order (H16 + the AI account gate):
 *  1. CSWSH Origin allowlist — shared `isAllowedOrigin`/`isDevHost` (same set
 *     as CORS/csrf, zero drift). REQUIRED on the WS upgrade (browsers always
 *     send Origin there); on HTTP enforced only when present (same-origin
 *     dev-proxy GETs legitimately omit it — the session cookie is the real
 *     gate, and `SameSite=Lax` blocks cross-site cookie sends).
 *  2. `RL_AI` edge damping, keyed on `cf-connecting-ip` (`'dev'` locally) —
 *     before the AUTH RPC so hammering can't amplify into auth traffic.
 *  3. Instance-name format guard — `parseAgentName` on the RAW segment
 *     (partysocket sends `:` unencoded; an encoded variant would mint a
 *     DIFFERENT DO identity, so `%3A` forms must die here, undecoded).
 *  4. `AUTH.verifySession(cookie)` (try/caught) → require an ACCOUNT session
 *     (`isAnon === false`; KV records are minted only by the Google OAuth
 *     callback). A KV outage degrades signed-in → anon ⇒ AI fails CLOSED —
 *     deliberate for this worker.
 *  5. Require the name's userId === the verified userId — a user reaches only
 *     their OWN agent instances.
 *  6. Stamp `x-avlo-user-id` with the verified id. The hook unconditionally
 *     OWNS the header (set on success — every request that reaches the DO
 *     carries it; inbound values can never survive).
 */
export function makeGateHooks(c: Context<AiEnv>) {
  const isDev = isDevHost(c.req.header('host'));

  const gate = async (req: Request, lobbyName: string, isWs: boolean): Promise<Response | Request> => {
    const origin = req.headers.get('origin');
    if (origin || isWs) {
      if (!isAllowedOrigin(origin, isDev)) return new Response('Forbidden', { status: 403 });
    }

    const { success } = await c.env.RL_AI.limit({ key: req.headers.get('cf-connecting-ip') ?? 'dev' });
    if (!success) return new Response('Too Many Requests', { status: 429 });

    const parsed = parseAgentName(lobbyName);
    if (!parsed) return new Response('Bad Request', { status: 400 });

    let userId: string | null = null;
    try {
      const auth = await c.env.AUTH.verifySession(req.headers.get('cookie'));
      userId = auth && !auth.isAnon ? auth.userId : null;
    } catch {
      userId = null;
    }
    if (!userId) return new Response('Unauthorized', { status: 401 });
    if (userId !== parsed.userId) return new Response('Forbidden', { status: 403 });

    const headers = new Headers(req.headers);
    headers.set('x-avlo-user-id', userId);
    return new Request(req, { headers });
  };

  return {
    onBeforeConnect: (req: Request, lobby: { name: string }) => gate(req, lobby.name, true),
    onBeforeRequest: (req: Request, lobby: { name: string }) => gate(req, lobby.name, false),
  };
}
