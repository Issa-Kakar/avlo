import type { UserId } from '@avlo/shared';
import type { AuthRpcSurface, RefineBindings } from '@avlo/worker-shared';

// Hono env for the unfurl app: worker bindings + the `userId` var slot `requireAuth`
// stamps. The single GET route is gated (it triggers an outbound fetch + R2 write — a
// real-cost path, H13), so `userId` is always present by the time the handler runs.
//
// `AUTH` is retyped from the untyped cross-config `Service` to its RPC surface, so
// `requireAuth` reads `c.env.AUTH.verifySession(...)` with no cast (§5.1).
export type UnfurlEnv = {
  Bindings: RefineBindings<Env, { AUTH: AuthRpcSurface }>;
  Variables: { userId: UserId };
};
