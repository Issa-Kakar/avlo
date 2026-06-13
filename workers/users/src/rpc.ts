import { WorkerEntrypoint } from 'cloudflare:workers';
import { getSessionDB, users, withRetry } from '@avlo/db';
import { generateUserId, type UserId } from '@avlo/shared';
import { assertRpcMatch, devDrizzleLogger, traceRpc, type UsersRpcSurface } from '@avlo/worker-shared';
import { sql } from 'drizzle-orm';

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
export class UsersRpc extends WorkerEntrypoint<Env> {
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
}

// Drift guard — `UsersRpcSurface` (the blind service-binding cast target in
// @avlo/worker-shared) must stay mutually assignable with the real RPC surface.
assertRpcMatch<Pick<UsersRpc, keyof UsersRpcSurface>, UsersRpcSurface>(true);
