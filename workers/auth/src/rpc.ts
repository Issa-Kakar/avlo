import { WorkerEntrypoint } from 'cloudflare:workers';
import { type AuthCtx, type AuthRpcSurface, traceRpc, verifyAnonToken } from '@avlo/worker-shared';
import { readSession } from './session';

// Binary RPC surface for sibling workers: verify a cookie header → resolved identity
// (`AuthCtx`, branded userId), pure (no Set-Cookie — issuance lives on direct browser
// responses, H18). Called at the edge in main's onBeforeConnect (§7) and by the
// images/unfurl/users auth gates. Session (KV) branch first, anon HMAC fallback — the
// signature is unchanged, so every consumer inherits Google sessions with zero changes.
export class AuthRpc extends WorkerEntrypoint<Env> implements AuthRpcSurface {
  async verifySession(cookieHeader: string | null): Promise<AuthCtx | null> {
    return traceRpc(
      this.env,
      'auth.verifySession',
      () => this.#resolveSession(cookieHeader),
      (r) => (r ? (r.isAnon ? 'anon' : 'session') : 'null'),
    );
  }

  async #resolveSession(cookieHeader: string | null): Promise<AuthCtx | null> {
    // KV outage degrades a signed-in user to their anon identity rather than 500-ing
    // every gated worker — availability over fail-closed, documented tradeoff (the same
    // call in /me degrades identically, so the two views agree). Flip = remove the
    // try/catch fallthrough.
    try {
      const sess = await readSession(cookieHeader, this.env.SESSIONS);
      if (sess) return { userId: sess.record.userId, isAnon: false };
    } catch {
      console.warn('[auth] verifySession KV read failed — degrading to anon');
    }
    return verifyAnonToken(cookieHeader, this.env.ANON_SECRET);
  }
}
