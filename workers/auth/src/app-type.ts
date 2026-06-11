// Public API surface for `hc<AuthApp>(...)`. Encodes the route shape (paths,
// methods, response types) ambient-free so the client's typecheck traverses it
// WITHOUT pulling worker ambients (Env, KVNamespace, RateLimit). The real
// handlers live in ./index.ts + ./handlers; the drift guard there keeps this
// file structurally aligned with the real `typeof app`.

import type { UserId } from '@avlo/shared';
import { Hono } from 'hono';

/** `GET /me` response — the single identity resolver (§2). `userId` is branded:
 *  Hono's `hc` preserves it through inference (`JSONParsed<UserId> = UserId`), so the
 *  client reads `UserId` with no boundary cast. `email`/`avatarHash` are present only
 *  on an account session (Google sign-in); `avatarHash` is the 32-hex `avatars/` key
 *  suffix served by the images worker — never a URL. */
export interface MeResponse {
  userId: UserId;
  isAnon: boolean;
  name: string;
  color: string;
  email?: string;
  avatarHash?: string;
}

const app = new Hono()
  .get('/me', (c) => {
    // Mock body — wire-shape placeholder for `hc` inference, never executed.
    const body: MeResponse = { userId: '' as UserId, isAnon: true, name: '', color: '' };
    return c.json(body);
  })
  // OAuth navigation routes — the client builds /login/google via `$url()` and assigns
  // `location` (top-level nav, not fetch); /callback is browser-only. Both mock as bare
  // redirects: hc only needs path × method here.
  .get('/login/google', (c) => c.redirect('https://accounts.google.com/'))
  .get('/callback', (c) => c.redirect('/'))
  .post('/logout', (c) => c.body(null, 204));

export type AuthApp = typeof app;
