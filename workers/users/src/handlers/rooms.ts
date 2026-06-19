import { getSessionDB, rooms, roomVisits, upsertRoomsFromMeta, users, withRetry } from '@avlo/db';
import { devDrizzleLogger, type MetaEvent } from '@avlo/worker-shared';
import { zValidator } from '@hono/zod-validator';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { createFactory } from 'hono/factory';
import type { RoomListEntry, RoomListResponse } from '../app-type';
import type { UsersEnv } from '../env';
import { permissionBody, roomIdParam, titleBody } from '../zod/rooms';

const factory = createFactory<UsersEnv>();

/**
 * `GET /rooms` (§4) — the dashboard list. Sessions-API read threaded with the client's
 * `x-d1-bookmark` (monotonic reads), wrapped in transient-only `withRetry` (user-facing).
 * `isOwner` is derived (`ownerId === me`); `permission`/`title` are display-only — the
 * access decision reads the DO, never D1 (§0). The advanced bookmark rides back out.
 * `ownerName` left-joins the account directory — null for anon owners (no `users` row by
 * design). Private rooms the caller doesn't own stay in the response as the client's
 * prune signal (roomId + permission + isOwner is all the prune needs), but `title`/
 * `ownerName` are redacted so a denied past visitor can't read post-privatization
 * renames or the owner via DevTools.
 */
export const handleGetRooms = factory.createHandlers(async (c) => {
  const userId = c.get('userId');
  const { db, session } = getSessionDB(c.env.DB, c.req.header('x-d1-bookmark') ?? null, devDrizzleLogger(c.env, '[d1]'));

  const list = await withRetry(() =>
    db
      .select({
        roomId: rooms.roomId,
        title: rooms.title,
        permission: rooms.permission,
        ownerId: rooms.ownerId,
        ownerName: users.name,
        lastVisitedAt: roomVisits.lastVisitedAt,
      })
      .from(roomVisits)
      .innerJoin(rooms, eq(rooms.roomId, roomVisits.roomId))
      .leftJoin(users, eq(users.userId, rooms.ownerId))
      .where(and(eq(roomVisits.userId, userId), isNull(rooms.deletedAt))) // tombstoned rooms never listed
      .orderBy(desc(roomVisits.lastVisitedAt))
      .all(),
  );

  const entries: RoomListEntry[] = list.map((r) => {
    const isOwner = r.ownerId === userId;
    const redact = r.permission === 'private' && !isOwner;
    return {
      roomId: r.roomId,
      title: redact ? '' : r.title,
      permission: r.permission,
      isOwner,
      ownerName: redact ? null : r.ownerName,
      lastVisitedAt: r.lastVisitedAt,
    };
  });

  const bookmark = session.getBookmark() ?? '';
  c.header('x-d1-bookmark', bookmark);
  return c.json({ rooms: entries, bookmark } satisfies RoomListResponse);
});

/**
 * The read-your-writes half of the standardized meta fan-out (§8): after a DO meta RPC
 * commits, mirror its returned snapshot into D1 with the same rev-guarded upsert the
 * queue consumer uses (idempotent in either order), on a `first-primary` session so
 * `getBookmark()` reflects the write. The bookmark rides back to the client, whose next
 * `GET /rooms` threads it — instant navigation home after a rename reads correct.
 * try/catch → `''`: the DO already committed and the queue converges D1, so a failed
 * direct write must never fail the response (the client just keeps its prior bookmark).
 */
async function projectMetaRYW(env: UsersEnv['Bindings'], snapshot: MetaEvent): Promise<string> {
  try {
    const { db, session } = getSessionDB(env.DB, 'first-primary', devDrizzleLogger(env, '[d1]'));
    await withRetry(() => upsertRoomsFromMeta(db, [snapshot]));
    return session.getBookmark() ?? '';
  } catch (err) {
    console.error('meta RYW projection failed', err);
    return '';
  }
}

/**
 * Map a meta-RPC failure to its HTTP shape. The DO's thrown `Error.message` IS the wire
 * contract (`RoomDoRpc`): `forbidden` → 403 (caller isn't the owner), `invalid-title` →
 * 400 (failed the shared normalize — only reachable by a caller bypassing `titleBody`).
 * Everything else — transport failure — is internal: log it (no body/url, H10) and 500,
 * which the client treats as transient/retryable.
 */
function metaRpcFailure(err: unknown): { error: 'forbidden' | 'invalid-title' | 'internal'; status: 400 | 403 | 500 } {
  const msg = err instanceof Error ? err.message : '';
  if (msg === 'forbidden') return { error: 'forbidden', status: 403 };
  if (msg === 'invalid-title') return { error: 'invalid-title', status: 400 };
  console.error('room meta RPC failed', err);
  return { error: 'internal', status: 500 };
}

/**
 * `PATCH /rooms/:id/permission` (§8) — the server-side permission seam (no client UI
 * calls it yet). Validates the id + body, then defers the entire authority decision to
 * the room DO cross-script via `c.env.rooms.getByName(id)`: the DO is the source of truth
 * and derives its own identity from `ctx.id.name`, so only the authenticated caller is
 * passed. Failures map via `metaRpcFailure`; success → the DO has updated SQLite +
 * `this.meta` + re-pushed/closed live connections + projected, and the snapshot is
 * mirrored into D1 here for the read-your-writes bookmark.
 */
export const handleSetPermission = factory.createHandlers(
  zValidator('param', roomIdParam),
  zValidator('json', permissionBody),
  async (c) => {
    const { id } = c.req.valid('param');
    const { permission } = c.req.valid('json');
    const userId = c.get('userId');

    let snapshot: MetaEvent;
    try {
      snapshot = await c.env.rooms.getByName(id).setPermission(userId, permission);
    } catch (err) {
      const { error, status } = metaRpcFailure(err);
      return c.json({ error }, status);
    }
    const bookmark = await projectMetaRYW(c.env, snapshot);
    c.header('x-d1-bookmark', bookmark);
    return c.json({ ok: true, bookmark });
  },
);

/**
 * `PATCH /rooms/:id/title` (§8) — owner-only rename, same RPC shape as the permission
 * seam above. Body is normalized by `titleBody` (shared `normalizeRoomTitle`); the DO
 * re-guards at the authority boundary, broadcasts `title:` to live connections, projects
 * to the meta queue, and returns the snapshot — mirrored into D1 here for the
 * read-your-writes bookmark. The canonical (normalized) title rides back so the client
 * can confirm its optimistic value.
 */
export const handleSetTitle = factory.createHandlers(zValidator('param', roomIdParam), zValidator('json', titleBody), async (c) => {
  const { id } = c.req.valid('param');
  const { title } = c.req.valid('json');
  const userId = c.get('userId');

  let snapshot: MetaEvent;
  try {
    snapshot = await c.env.rooms.getByName(id).setTitle(userId, title);
  } catch (err) {
    const { error, status } = metaRpcFailure(err);
    return c.json({ error }, status);
  }
  const bookmark = await projectMetaRYW(c.env, snapshot);
  c.header('x-d1-bookmark', bookmark);
  return c.json({ ok: true, title: snapshot.title, bookmark });
});
