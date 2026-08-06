import { WorkerEntrypoint } from 'cloudflare:workers';

/**
 * Test stand-in for avlo-auth's AuthRpc, used as a miniflare auxiliary worker by the
 * images / unfurl / users suites. Identity comes from a transparent
 * `avlo-test-user=<userId>[:anon]` cookie instead of the real KV/HMAC chain — that
 * chain is exhaustively tested in the auth worker's own suite, and the sync suite
 * runs the REAL auth worker for full-fidelity coverage of the seam.
 */
export class AuthRpc extends WorkerEntrypoint {
  async verifySession(cookieHeader) {
    if (!cookieHeader) return null;
    const m = /(?:^|;\s*)avlo-test-user=([^;]+)/.exec(cookieHeader);
    if (!m) return null;
    const [userId, flag] = m[1].split(':');
    return { userId, isAnon: flag === 'anon' };
  }
}

export default {
  fetch: () => new Response('stub-auth: RPC-only', { status: 404 }),
};
