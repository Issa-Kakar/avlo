import type { UserId } from '@avlo/shared';

// Hono env for the unfurl app: worker bindings + the `userId` var slot `requireAuth`
// stamps. The single GET route is gated (it triggers an outbound fetch + R2 write — a
// real-cost path, H13), so `userId` is always present by the time the handler runs.
export type UnfurlEnv = { Bindings: Env; Variables: { userId: UserId } };
