import { WorkerEntrypoint } from 'cloudflare:workers';
import { chunk, getSessionDB, META_ROWS_MAX, rooms, upsertRoomsFromMeta, users, withRetry } from '@avlo/db';
import { generateUserId, type UserId } from '@avlo/shared';
import { devDrizzleLogger, mapWithConcurrency, type RoomMigrateEvent, traceRpc, type UsersRpcSurface } from '@avlo/worker-shared';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { z } from 'zod/v4';
import type { UsersEnv } from './env';

// Second-device adopt fan-out budget (§9). A typical second-device adopter has a handful
// of anon-created rooms; CAP covers virtually everyone synchronously (bookmarked) while
// bounding the blocking window — at concurrency 6, 50 cross-script DO RPCs settle well
// under the ~2 s sign-in budget. Beyond CAP (or any per-room failure) hands off to the
// durable `avlo-room-migrate` sweep.
const MIGRATE_CAP = 50;
const MIGRATE_CONCURRENCY = 6;

// `withRetry`'s transient regex deliberately does NOT match UNIQUE errors — they are
// deterministic, surface on attempt 1, and only this one is expected: the device's id is
// already a row linked to a DIFFERENT Google account (second account on one browser), so
// the retry promotes a fresh id instead. Everything else rethrows → the callback fails closed.
function isUserIdPkConflict(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /UNIQUE constraint failed:.*users\.user_id/i.test(msg);
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
   * Second-device ownership migration (§9) — the auth callback calls this AFTER minting the
   * session, so a partial fan-out can never fail-close sign-in (migration is eventual by
   * design). No-op for PROMOTE (`prevOwner === nextOwner`). For ADOPT: enumerate live rooms
   * owned by the device's old anon id, migrate up to `MIGRATE_CAP` synchronously (bounded
   * concurrency; each `migrateOwner` retried for transient transport) and direct-write the
   * returned snapshots to D1 on a `first-primary` session, then return that session's
   * bookmark (covers exactly the synchronously-migrated rooms — the dashboard threads it for
   * read-your-writes ownership). Overflow beyond CAP, or any room that still failed after
   * retries, hands off to the durable `avlo-room-migrate` sweep (consumer re-enumerates).
   * The DO's `ownerId === prevOwner` guard makes the whole thing idempotent under redelivery.
   */
  async migrateOwnership(prevOwner: UserId, nextOwner: UserId): Promise<{ bookmark: string }> {
    return traceRpc(
      this.env,
      'users.migrateOwnership',
      () => this.#migrateOwnership(prevOwner, nextOwner),
      () => 'ok',
    );
  }

  async #migrateOwnership(prevOwner: UserId, nextOwner: UserId): Promise<{ bookmark: string }> {
    if (prevOwner === nextOwner) return { bookmark: '' }; // PROMOTE — device id already became the account id
    const { db, session } = getSessionDB(this.env.DB, 'first-primary', devDrizzleLogger(this.env, '[d1]'));

    // Enumerate owned-LIVE rooms. The `deletedAt IS NULL` predicate is REPEATED so SQLite
    // matches the partial `rooms_by_owner` index; `limit(CAP + 1)` cheaply detects overflow.
    const owned = await withRetry(() =>
      db
        .select({ roomId: rooms.roomId })
        .from(rooms)
        .where(and(eq(rooms.ownerId, prevOwner), isNull(rooms.deletedAt)))
        .limit(MIGRATE_CAP + 1)
        .all(),
    );
    if (owned.length === 0) return { bookmark: '' };

    const overflow = owned.length > MIGRATE_CAP;
    const batch = overflow ? owned.slice(0, MIGRATE_CAP) : owned;

    // Bounded-concurrency fan-out. Each DO RPC is retried for transient transport; a room
    // that still throws is collected (failed=true) and swept via the queue. `migrateOwner`
    // returns null for an already-migrated/absent room — filtered out, nothing to write.
    let failed = false;
    const snapshots = await mapWithConcurrency(batch, MIGRATE_CONCURRENCY, async ({ roomId }) => {
      try {
        return await withRetry(() => this.env.rooms.getByName(roomId).migrateOwner(prevOwner, nextOwner));
      } catch {
        console.warn('[users] migrateOwner failed — deferring to sweep');
        failed = true;
        return null;
      }
    });

    const metas = snapshots.filter((m): m is NonNullable<typeof m> => m !== null);
    if (metas.length) {
      const stmts = chunk(metas, META_ROWS_MAX).map((c) => upsertRoomsFromMeta(db, c));
      await withRetry(() => db.batch(stmts as [(typeof stmts)[number], ...(typeof stmts)[number][]]));
    }

    // Overflow OR a per-room failure → one durable sweep instruction (the consumer
    // re-enumerates and re-fans-out; idempotent via the DO guard). Fire-and-forget.
    if (overflow || failed) {
      this.env.ROOM_MIGRATE.send({ prevOwner, nextOwner } satisfies z.input<typeof RoomMigrateEvent>).catch((err) =>
        console.error('migrate sweep enqueue failed', err),
      );
    }
    return { bookmark: session.getBookmark() ?? '' };
  }
}
