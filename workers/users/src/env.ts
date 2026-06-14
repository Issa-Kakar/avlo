import type { UserId } from '@avlo/shared';
import type { AuthRpcSurface, RefineBindings, RoomDoRpc } from '@avlo/worker-shared';

// Hono env for the users app: worker bindings (D1 `DB`, cross-script `rooms` DO, `AUTH`
// service, `RL_ROOMS`) + the `userId` var slot the global `requireAuth` stamps. Every
// HTTP route is auth-gated, so `c.get('userId')` is always present in a handler.
//
// Both cross-config bindings are retyped from their untyped generated forms to their RPC
// surfaces, so call sites need no cast: `AUTH` (`Service`) → `AuthRpcSurface` for
// `c.env.AUTH.verifySession(...)`, and the cross-script `rooms` DO (`DurableObjectNamespace`)
// → `DurableObjectNamespace<RoomDoRpc>` for `c.env.rooms.getByName(id).setTitle(...)`.
export type UsersEnv = {
  Bindings: RefineBindings<Env, { AUTH: AuthRpcSurface; rooms: DurableObjectNamespace<RoomDoRpc> }>;
  Variables: { userId: UserId };
};
