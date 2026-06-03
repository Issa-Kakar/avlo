import { hc } from 'hono/client';
// Import from app-type, NOT from index — the real index.ts pulls ambient
// Env/D1Database/the cross-script rooms DO that would leak into client
// compilation; app-type.ts is the public, ambient-free surface.
import type { UsersApp } from '../../../workers/users/src/app-type';
import { USERS_ORIGIN } from './origins';

// `credentials: 'include'` baked in: every users call carries the cookie (§12).
export const usersClient = hc<UsersApp>(USERS_ORIGIN, { init: { credentials: 'include' } });
export type { RoomListEntry, RoomListResponse } from '../../../workers/users/src/app-type';
export type { UsersApp };
