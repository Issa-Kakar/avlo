import { hc } from 'hono/client';
// Import from app-type, NOT from index — the real index.ts pulls ambient
// Env/KVNamespace/RateLimit that would leak into client compilation;
// app-type.ts is the public, ambient-free surface.
import type { AuthApp } from '../../../workers/auth/src/app-type';
import { AUTH_ORIGIN } from './origins';

// `credentials: 'include'` baked in: every auth call carries the cookie (§12).
export const authClient = hc<AuthApp>(AUTH_ORIGIN, { init: { credentials: 'include' } });
export type { AuthApp };
