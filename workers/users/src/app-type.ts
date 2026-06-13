// Public API surface for `hc<UsersApp>(...)`. Encodes the route shape (paths,
// methods, response types) ambient-free so the client's typecheck traverses it
// WITHOUT pulling worker ambients (Env, D1Database, the cross-script rooms DO).
// The real handlers live in ./index.ts + ./handlers; the drift guard there
// keeps this file structurally aligned with the real `typeof app`.

import { Permission, type RoomId } from '@avlo/shared';
import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { z } from 'zod/v4';

/** One dashboard row — the §4 query projection. `permission`/`title`/`isOwner`
 *  are display-only (the access decision reads the DO, never D1). `permission` is
 *  the shared `Permission` type (a pure literal union). Private rooms the caller
 *  doesn't own arrive with `title: ''` + `ownerName: null` (server-side redaction;
 *  the row itself is the client's prune signal). */
export interface RoomListEntry {
  roomId: RoomId;
  title: string; // NOT NULL in D1 (DEFAULT 'Untitled'); renamed via PATCH /rooms/:id/title
  permission: Permission;
  isOwner: boolean;
  ownerName: string | null; // account directory join — null for anon owners (no `users` row)
  lastVisitedAt: number;
}

/** `GET /rooms` response — the dashboard list + the advancing D1 bookmark (§5/§12). */
export interface RoomListResponse {
  rooms: RoomListEntry[];
  bookmark: string;
}

const app = new Hono()
  .get('/rooms', (c) => {
    const body: RoomListResponse = { rooms: [], bookmark: '' };
    return c.json(body);
  })
  // §8 meta-mutation seams — body shapes so client PATCHes are typed (the surface match
  // is path × method, not response type). Both return the read-your-writes `bookmark`
  // (also exposed as the `x-d1-bookmark` response header); title returns the canonical
  // normalized title so the client can confirm its optimistic value.
  .patch(
    '/rooms/:id/permission',
    zValidator('param', z.object({ id: z.string() })),
    zValidator('json', z.object({ permission: Permission })),
    (c) => c.json({} as { ok: true; bookmark: string } | { error: string }),
  )
  .patch('/rooms/:id/title', zValidator('param', z.object({ id: z.string() })), zValidator('json', z.object({ title: z.string() })), (c) =>
    c.json({} as { ok: true; title: string; bookmark: string } | { error: string }),
  );

export type UsersApp = typeof app;
