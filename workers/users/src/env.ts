import type { UserId } from '@avlo/shared';

// Hono env for the users app: worker bindings (D1 `DB`, cross-script `rooms` DO, `AUTH`
// service, `RL_ROOMS`) + the `userId` var slot the global `requireAuth` stamps. Every
// HTTP route is auth-gated, so `c.get('userId')` is always present in a handler.
export type UsersEnv = { Bindings: Env; Variables: { userId: UserId } };
