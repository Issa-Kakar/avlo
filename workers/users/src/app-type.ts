// Public API surface for `hc<UsersApp>(...)`. Encodes the route shape (paths,
// methods, response types) ambient-free so the client's typecheck traverses it
// WITHOUT pulling worker ambients (Env, D1Database, the cross-script rooms DO).
// The real handlers live in ./index.ts + ./handlers; the drift guard there
// keeps this file structurally aligned with the real `typeof app`.

import type { Permission } from '@avlo/shared';
import { Hono } from 'hono';

/** One dashboard row — the §4 query projection. `permission`/`title`/`isOwner`
 *  are display-only (the access decision reads the DO, never D1). `permission` is
 *  the shared `Permission` type (a pure literal union; `import type` keeps this
 *  mock ambient-free, so the client still traverses it without pulling Zod). */
export interface RoomListEntry {
  roomId: string;
  title: string | null;
  permission: Permission;
  isOwner: boolean;
  lastVisitedAt: number;
}

/** `GET /rooms` response — the dashboard list + the advancing D1 bookmark (§5/§12). */
export interface RoomListResponse {
  rooms: RoomListEntry[];
  bookmark: string;
}

const app = new Hono().get('/rooms', (c) => {
  const body: RoomListResponse = { rooms: [], bookmark: '' };
  return c.json(body);
});

export type UsersApp = typeof app;
