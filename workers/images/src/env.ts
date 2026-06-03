import type { UserId } from '@avlo/shared';

// Hono env for the images app: the worker bindings + the `userId` var slot that
// `requireAuth` stamps on the gated PUT path. Threaded through every handler factory
// (upload/get) so the auth gate + rate limiter compose with the route chain without
// env-variance friction. GET never sets `userId` (anonymous, H13) — declaring the slot
// is harmless; it just goes unread there.
export type ImagesEnv = { Bindings: Env; Variables: { userId: UserId } };
