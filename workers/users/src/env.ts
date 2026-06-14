import type { UserId } from '@avlo/shared';
import type { AuthRpcSurface, RefineBindings } from '@avlo/worker-shared';

// Hono env for the users app: worker bindings (D1 `DB`, cross-script `rooms` DO, `AUTH`
// service, `RL_ROOMS`) + the `userId` var slot the global `requireAuth` stamps. Every
// HTTP route is auth-gated, so `c.get('userId')` is always present in a handler.
//
// `AUTH` is retyped from the untyped cross-config `Service` to its RPC surface, so
// `requireAuth` reads `c.env.AUTH.verifySession(...)` with no cast. The cross-script
// `rooms` DO stays untyped here — it's reached through `roomDoStub` (§5.1).
export type UsersEnv = {
  Bindings: RefineBindings<Env, { AUTH: AuthRpcSurface }>;
  Variables: { userId: UserId };
};
