import type { UserId } from '@avlo/shared';
import type { MiddlewareHandler } from 'hono';
import type { AuthRpcSurface } from './rpc-surfaces';

/**
 * Auth gate for the cross-origin HTTP workers (images/unfurl/users, H13). Verifies the
 * request cookie via the `AUTH` service binding (`AuthRpc.verifySession`) and stamps the
 * resolved `userId` into the Hono context for the downstream rate limiter + handler.
 * `null` → `401` (no `Set-Cookie`, never an issuer — that's the auth worker's job, H18).
 *
 * Generic over the caller's concrete Hono env (pinned at the call site,
 * `requireAuth<MyEnv>()`), so the returned middleware composes with the app's route
 * chain without the env-variance friction a fixed-env middleware hits. The constraint
 * only demands the `AUTH` binding + the `userId` var slot this writes.
 *
 * `c.env.AUTH` is an untyped service binding across wrangler configs (§5.1); the generic
 * constraint pins it to the shared `AuthRpcSurface`, which each caller satisfies by typing
 * its env `RefineBindings<Env, { AUTH: AuthRpcSurface }>` — so the contract is
 * asserted once per worker, not re-cast here.
 */
export const requireAuth =
  <E extends { Bindings: { AUTH: AuthRpcSurface }; Variables: { userId: UserId } }>(): MiddlewareHandler<E> =>
  async (c, next) => {
    const ctx = await c.env.AUTH.verifySession(c.req.header('cookie') ?? null);
    if (!ctx) return c.json({ error: 'unauthenticated' }, 401);
    c.set('userId', ctx.userId);
    await next();
  };
