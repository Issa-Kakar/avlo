// Public API surface for `hc<AuthApp>(...)`. Encodes the route shape (paths,
// methods, response types) ambient-free so the client's typecheck traverses it
// WITHOUT pulling worker ambients (Env, KVNamespace, RateLimit). The real
// handlers live in ./index.ts + ./handlers; the drift guard there keeps this
// file structurally aligned with the real `typeof app`.

import type { UserId } from '@avlo/shared';
import { Hono } from 'hono';

/** `GET /me` response — the single identity resolver (§2). `userId` is branded:
 *  Hono's `hc` preserves it through inference (`JSONParsed<UserId> = UserId`), so the
 *  client reads `UserId` with no boundary cast. */
export interface MeResponse {
  userId: UserId;
  isAnon: boolean;
  name: string;
  color: string;
}

const app = new Hono().get('/me', (c) => {
  // Mock body — wire-shape placeholder for `hc` inference, never executed.
  const body: MeResponse = { userId: '' as UserId, isAnon: true, name: '', color: '' };
  return c.json(body);
});

export type AuthApp = typeof app;
