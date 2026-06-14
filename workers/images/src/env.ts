import type { UserId } from '@avlo/shared';
import type { AuthRpcSurface, RefineBindings } from '@avlo/worker-shared';

// Hono env for the images app: the worker bindings + the `userId` var slot that
// `requireAuth` stamps on the gated PUT path. Threaded through every handler factory
// (upload/get) so the auth gate + rate limiter compose with the route chain without
// env-variance friction. GET never sets `userId` (anonymous, H13) — declaring the slot
// is harmless; it just goes unread there.
//
// `AUTH` is retyped from the untyped cross-config `Service` to its RPC surface, so
// `requireAuth` reads `c.env.AUTH.verifySession(...)` with no cast (§5.1).
export type ImagesEnv = {
  Bindings: RefineBindings<Env, { AUTH: AuthRpcSurface }>;
  Variables: { userId: UserId };
};
