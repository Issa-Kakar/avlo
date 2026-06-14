import type { ImagesRpcSurface, RefineBindings, UsersRpcSurface } from '@avlo/worker-shared';

// Hono env for the auth app. The OAuth callback calls the USERS + IMAGES service bindings
// (`linkAccount` / `ingestAvatar`), so both are retyped from the untyped cross-config
// `Service` to their RPC surfaces — `c.env.USERS.linkAccount(...)` /
// `c.env.IMAGES.ingestAvatar(...)` read with no cast (§5.1). The whole app threads this one
// env (not just the callback) because Hono can't mount a refined-env handler on an
// unrefined app: `Service` and the surface are mutually non-assignable. No `userId` var
// slot — auth has no gate of its own; it IS the identity resolver.
export type AuthEnv = {
  Bindings: RefineBindings<Env, { USERS: UsersRpcSurface; IMAGES: ImagesRpcSurface }>;
};
