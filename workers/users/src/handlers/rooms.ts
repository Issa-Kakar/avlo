import { getSessionDB, rooms, roomVisits, withRetry } from '@avlo/db';
import type { RoomDoStub } from '@avlo/worker-shared';
import { zValidator } from '@hono/zod-validator';
import { and, desc, eq } from 'drizzle-orm';
import { createFactory } from 'hono/factory';
import type { RoomListEntry, RoomListResponse } from '../app-type';
import type { UsersEnv } from '../env';
import { permissionBody, permissionParam } from '../zod/permission';

const factory = createFactory<UsersEnv>();

/**
 * `GET /rooms` (§4) — the dashboard list. Sessions-API read threaded with the client's
 * `x-d1-bookmark` (monotonic reads), wrapped in transient-only `withRetry` (user-facing).
 * `isOwner` is derived (`ownerId === me`); `permission`/`title` are display-only — the
 * access decision reads the DO, never D1 (§0). The advanced bookmark rides back out.
 */
export const handleGetRooms = factory.createHandlers(async (c) => {
  const userId = c.get('userId');
  const { db, session } = getSessionDB(c.env.DB, c.req.header('x-d1-bookmark') ?? null);

  const list = await withRetry(() =>
    db
      .select({
        roomId: rooms.roomId,
        title: rooms.title,
        permission: rooms.permission,
        ownerId: rooms.ownerId,
        lastVisitedAt: roomVisits.lastVisitedAt,
      })
      .from(roomVisits)
      .innerJoin(rooms, eq(rooms.roomId, roomVisits.roomId))
      .where(and(eq(roomVisits.userId, userId), eq(rooms.deleted, false))) // tombstoned rooms never listed
      .orderBy(desc(roomVisits.lastVisitedAt))
      .all(),
  );

  const entries: RoomListEntry[] = list.map((r) => ({
    roomId: r.roomId,
    title: r.title,
    permission: r.permission,
    isOwner: r.ownerId === userId,
    lastVisitedAt: r.lastVisitedAt,
  }));

  const bookmark = session.getBookmark() ?? '';
  c.header('x-d1-bookmark', bookmark);
  return c.json({ rooms: entries, bookmark } satisfies RoomListResponse);
});

/**
 * `PATCH /rooms/:id/permission` (§8) — the server-side permission seam (no client UI
 * calls it yet). Validates the id + body, then defers the entire authority decision to
 * the room DO cross-script: the DO is the source of truth and throws `forbidden` if the
 * caller isn't the owner. A thrown error → 403; success → the DO has updated SQLite +
 * `this.meta` + projected to the meta queue + re-pushed/closed live connections.
 */
export const handleSetPermission = factory.createHandlers(
  zValidator('param', permissionParam),
  zValidator('json', permissionBody),
  async (c) => {
    const { id } = c.req.valid('param');
    const { permission } = c.req.valid('json');
    const userId = c.get('userId');

    // Cross-script DO stub is untyped across wrangler configs (§5.1) — cast to the shared surface.
    const stub = c.env.rooms.get(c.env.rooms.idFromName(id)) as unknown as RoomDoStub;
    try {
      await stub.setPermission(userId, permission);
    } catch {
      return c.json({ error: 'forbidden' }, 403);
    }
    return c.json({ ok: true });
  },
);
