import { WorkerEntrypoint } from 'cloudflare:workers';
import { chunk, getSessionDB, rooms, upsertRoomsFromMeta, users, visitCopyStmt, withRetry } from '@avlo/db';
import { generateUserId, type Permission, type RoomId, type UserId } from '@avlo/shared';
import { devDrizzleLogger, type MetaEvent, type MigrateEvent, traceRpc, type UsersRpcSurface } from '@avlo/worker-shared';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { z } from 'zod/v4';
import type { UsersEnv } from './env';

// `withRetry`'s transient regex deliberately does NOT match UNIQUE errors — they are
// deterministic, surface on attempt 1, and only this one is expected: the device's id is
// already a row linked to a DIFFERENT Google account (second account on one browser), so
// the retry promotes a fresh id instead. Everything else rethrows → the callback fails closed.
function isUserIdPkConflict(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /UNIQUE constraint failed:.*users\.user_id/i.test(msg);
}

// Adopt-migration tunables. The bound is the ~+2s sign-in budget, NOT subrequests — most
// users migrate fully synchronously. CAP is sliced AFTER ordering (priority/private first),
// so a private overflow can never 4403-prune a local board on reconnect.
const MIGRATE_SYNC_CAP = 50;
const MIGRATE_CONCURRENCY = 10;
const MIGRATE_SEND_MAX = 100; // Queues sendBatch cap; one send-per-room would blow the 1000-subrequest limit for power users
const VISIT_COPY_IDS_MAX = 90; // D1 100-param cap: 2 (from/to) + ids
const META_ROWS_MAX = 12; // upsertRoomsFromMeta binds 8 params/row → ≤96/statement

/** Minimal bounded-concurrency pool — run `fn` over `items`, at most `concurrency` in flight. */
async function mapPool<T>(items: readonly T[], concurrency: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const run = async (): Promise<void> => {
    while (next < items.length) await fn(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
}

/**
 * Binary RPC surface called only by the auth worker during OAuth sign-in (§9) — no public
 * endpoint. Promote-or-adopt in ONE atomic upsert on a `first-primary` session:
 *
 *   • new `googleSub`            → INSERT promotes `currentUserId` into a durable account row;
 *   • existing `googleSub`       → DO UPDATE adopts that row's `user_id` (every room/object
 *     minted under it follows), refreshing email/name and COALESCING `avatar_hash` so a
 *     failed ingest (null) never clobbers a stored avatar. RETURNING hands back the
 *     post-coalesce truth — the adopt path returns the account's avatar even when this
 *     device's ingest failed.
 *   • `user_id` PK conflict      → same device id already linked to a different account
 *     (deterministic, see `isUserIdPkConflict`) → retry ONCE with a fresh id. A repeat
 *     sign-in with a live session conflicts on BOTH constraints against the SAME row, which
 *     SQLite resolves through the conflict target — verified, no PK error on that path.
 *
 * Transient D1 failures retry via `withRetry` (critical write); a final failure throws and
 * the callback fails closed (no session cookie, no partial state — the upsert is idempotent,
 * the next attempt converges).
 */
export class UsersRpc extends WorkerEntrypoint<UsersEnv['Bindings']> implements UsersRpcSurface {
  async linkAccount(
    currentUserId: UserId,
    googleSub: string,
    profile: { email: string; name: string; avatarHash: string | null },
  ): Promise<{ userId: UserId; avatarHash: string | null; bookmark: string }> {
    return traceRpc(
      this.env,
      'users.linkAccount',
      () => this.#linkAccount(currentUserId, googleSub, profile),
      (r) => (r.avatarHash ? 'ok+avatar' : 'ok'),
    );
  }

  async #linkAccount(
    currentUserId: UserId,
    googleSub: string,
    profile: { email: string; name: string; avatarHash: string | null },
  ): Promise<{ userId: UserId; avatarHash: string | null; bookmark: string }> {
    const { email, name, avatarHash } = profile;
    const { db, session } = getSessionDB(this.env.DB, 'first-primary', devDrizzleLogger(this.env, '[d1]'));

    const upsert = (uid: UserId) =>
      withRetry(() =>
        db
          .insert(users)
          .values({ userId: uid, googleSub, email, name, avatarHash, createdAt: Date.now() })
          .onConflictDoUpdate({
            target: users.googleSub,
            set: { email, name, avatarHash: sql`coalesce(excluded.avatar_hash, ${users.avatarHash})` },
          })
          .returning({ userId: users.userId, avatarHash: users.avatarHash }),
      );

    let rows: Awaited<ReturnType<typeof upsert>>;
    try {
      rows = await upsert(currentUserId);
    } catch (err) {
      if (!isUserIdPkConflict(err)) throw err;
      rows = await upsert(generateUserId());
    }
    return { userId: rows[0].userId, avatarHash: rows[0].avatarHash, bookmark: session.getBookmark() ?? '' };
  }

  /**
   * OAuth ADOPT migration orchestrator (§ second-device) — called only by auth's callback.
   * NEVER throws: every branch is caught and returns counts, so sign-in can never fail on
   * migration. Re-owns the device's anon-owned rooms (`from`) into the adopted account (`to`),
   * a bounded synchronous slice + a durable queue tail. See `UsersRpcSurface.migrateOwnedRooms`.
   */
  async migrateOwnedRooms(
    from: UserId,
    to: UserId,
    priorityRoomId?: RoomId,
  ): Promise<{ bookmark: string; migrated: number; queued: number }> {
    return traceRpc(
      this.env,
      'users.migrateOwnedRooms',
      () => this.#migrateOwnedRooms(from, to, priorityRoomId),
      (r) => `m=${r.migrated} q=${r.queued}`,
    );
  }

  async #migrateOwnedRooms(
    from: UserId,
    to: UserId,
    priorityRoomId?: RoomId,
  ): Promise<{ bookmark: string; migrated: number; queued: number }> {
    const empty = { bookmark: '', migrated: 0, queued: 0 };
    if (from === to) return empty; // promote — rooms already owned by `to`, nothing to migrate

    // 2. Enumerate ALL live owned rooms (cheap text PKs via the partial idx_rooms_owner).
    let owned: { roomId: RoomId; permission: Permission }[];
    try {
      const { db } = getSessionDB(this.env.DB, 'first-primary', devDrizzleLogger(this.env, '[d1]'));
      owned = await withRetry(() =>
        db
          .select({ roomId: rooms.roomId, permission: rooms.permission })
          .from(rooms)
          .where(and(eq(rooms.ownerId, from), isNull(rooms.deletedAt)))
          .all(),
      );
    } catch (err) {
      console.error('owner migration enumerate failed', err);
      return empty; // sign-in proceeds; rooms converge on next sign-in / reopen
    }
    if (owned.length === 0) return empty;

    // 3. Order priority → private → public; sync slice = [0, CAP), the rest overflows to the
    //    queue. A migrated PRIVATE room that overflowed would 4403 the account on reconnect and
    //    the 4403 handler prunes+deletes the local board — so private (and the room signed in
    //    from) MUST migrate synchronously. Public never 4403s, so it overflows safely.
    const rank = (r: { roomId: RoomId; permission: Permission }): number =>
      r.roomId === priorityRoomId ? 0 : r.permission === 'private' ? 1 : 2;
    const ordered = [...owned].sort((a, b) => rank(a) - rank(b));
    const syncSlice = ordered.slice(0, MIGRATE_SYNC_CAP);
    const overflow = ordered.slice(MIGRATE_SYNC_CAP);

    // 4. Sync slice — bounded-concurrency migrateOwner; partition into snapshots / transient-failed.
    //    `forbidden` (room owned by a third party C) is a TERMINAL skip — drop, never enqueue.
    const snapshots: MetaEvent[] = [];
    const failed: RoomId[] = [];
    await mapPool(syncSlice, MIGRATE_CONCURRENCY, async (r) => {
      try {
        snapshots.push(await withRetry(() => this.env.rooms.getByName(r.roomId).migrateOwner(from, to)));
      } catch (err) {
        if (err instanceof Error && err.message === 'forbidden') return; // terminal skip
        failed.push(r.roomId); // transient → re-queue
      }
    });

    // 5. RYW batch — direct rev-guarded upsert of the snapshots + visit-copy, capture the
    //    bookmark. The DO's own ROOM_META enqueue carries the SAME rev, so whichever lands
    //    second fails `excluded.rev >` and no-ops (double-write idempotent in either order).
    let bookmark = '';
    const batchFailed: RoomId[] = []; // sync-slice rooms whose RYW direct write (incl. visit-copy) failed
    if (snapshots.length) {
      try {
        const { db, session } = getSessionDB(this.env.DB, 'first-primary', devDrizzleLogger(this.env, '[d1]'));
        const ids = snapshots.map((s) => s.roomId);
        const stmts = [
          ...chunk(snapshots, META_ROWS_MAX).map((rowsChunk) => upsertRoomsFromMeta(db, rowsChunk)),
          ...chunk(ids, VISIT_COPY_IDS_MAX).map((idsChunk) => visitCopyStmt(db, from, to, idsChunk)),
        ];
        await db.batch(stmts as [(typeof stmts)[number], ...(typeof stmts)[number][]]);
        bookmark = session.getBookmark() ?? '';
      } catch (err) {
        console.error('owner migration RYW batch failed', err);
        bookmark = '';
        // Ownership still converges via the DO's ROOM_META enqueue, but the meta consumer never
        // writes room_visits — so re-queue this slice to recover the visit-copy (migrateOwner
        // no-ops, visitCopyStmt re-runs). Otherwise a 2nd device's dashboard misses these rooms
        // until reopen, breaking the cross-device visit guarantee.
        batchFailed.push(...snapshots.map((s) => s.roomId));
      }
    }

    // 6. Overflow + transient-failed (inline migrateOwner AND RYW-batch) → the migrate queue,
    //    chunked under the Queues sendBatch cap.
    const toQueue = [...overflow.map((r) => r.roomId), ...failed, ...batchFailed];
    if (toQueue.length) {
      try {
        for (const idsChunk of chunk(toQueue, MIGRATE_SEND_MAX)) {
          await this.env.ROOM_MIGRATE.sendBatch(
            idsChunk.map((roomId) => ({ body: { roomId, from, to } satisfies z.input<typeof MigrateEvent> })),
          );
        }
      } catch (err) {
        console.error('owner migration queue enqueue failed', err); // best-effort
      }
    }

    return { bookmark, migrated: snapshots.length, queued: toQueue.length };
  }
}
