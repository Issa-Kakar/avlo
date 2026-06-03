import { type AuthCtx, verifyAnonToken } from '@avlo/worker-shared';
import { WorkerEntrypoint } from 'cloudflare:workers';

// Binary RPC surface for sibling workers: verify a cookie header → resolved identity
// (`AuthCtx`, branded userId), pure (no Set-Cookie — issuance lives on direct browser
// responses, H18). Called at the edge in main's onBeforeConnect (§7) and by the
// images/unfurl/users auth gates. The account (`avlo_session` KV) branch is the OAuth
// seam — `verifyAnonToken` is anon-only today.
export class AuthRpc extends WorkerEntrypoint<Env> {
  async verifySession(cookieHeader: string | null): Promise<AuthCtx | null> {
    return verifyAnonToken(cookieHeader, this.env.ANON_SECRET);
  }
}
