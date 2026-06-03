import type { AuthCtx } from '@avlo/worker-shared';
import { WorkerEntrypoint } from 'cloudflare:workers';

// Binary RPC surface for sibling workers: verify a cookie header → resolved
// identity (`AuthCtx`, branded userId), pure (no Set-Cookie — issuance lives on
// direct browser responses, H18). Called at the edge in main's onBeforeConnect
// (§7) and by the images/unfurl auth gates. Implemented in step 3; stubbed null
// until then.
export class AuthRpc extends WorkerEntrypoint<Env> {
  async verifySession(_cookieHeader: string | null): Promise<AuthCtx | null> {
    return null;
  }
}
