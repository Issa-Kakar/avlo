import type { RoomId, UserId } from '@avlo/shared';
import { and, eq, inArray, type Logger, sql } from 'drizzle-orm';
import { type DrizzleD1Database, drizzle } from 'drizzle-orm/d1';
import * as schema from './schema-d1';

/**
 * D1 access helpers (§5/H24). ALL D1 access goes through the Sessions API — sequential
 * consistency (monotonic reads, read-your-writes) is essentially free, and a session
 * with no bookmark is no slower than the raw binding. The bookmark is the consistency
 * token, threaded via the `x-d1-bookmark` request/response header.
 *
 * Constraint by path: dashboard read with a client bookmark → that bookmark; dashboard
 * read with none → `'first-unconstrained'` (any replica); sign-in → `'first-primary'`
 * (read-your-write); queue consumer → `'first-unconstrained'` (writes hit primary).
 */

/**
 * Session-scoped drizzle handle + the underlying session (for `session.getBookmark()`).
 *
 * `DB.withSession(...)` returns a `D1DatabaseSession` (only `prepare`/`batch`/`getBookmark`)
 * which is NOT structurally a `D1Database`, so drizzle's `drizzle(session, …)` needs a
 * cast — runtime is fine, drizzle only calls `prepare`/`batch` (handoff §9.2).
 */
export function getSessionDB(DB: D1Database, bookmark?: string | null, logger?: boolean | Logger) {
  const session = DB.withSession(bookmark ?? 'first-unconstrained');
  return { db: drizzle(session as unknown as D1Database, { schema, logger }), session };
}

/** Escape hatch only — CLI scripts with no request context. Not used on any request path. */
export const createDB = (DB: D1Database) => drizzle(DB, { schema });

/**
 * The standardized `rooms` projection write — one rev-guarded multi-row upsert shared by
 * the queue consumer (chunked statements into `db.batch`) and the users worker's direct
 * read-your-writes write after a DO meta RPC (awaited inline, then `session.getBookmark()`).
 * `ownerId` is now **rev-LWW** (the OAuth adopt migration re-owns through the DO's same
 * rev-bumping path — `#migrateOwner` — so `excluded.owner_id` rides the LWW guard like the
 * rest); `createdAt` is the ONE remaining first-write-wins field (deliberately absent from
 * `set`). Everything else is LWW resolved by the DO's per-room monotonic `rev` — a duplicate,
 * stale, or already-applied delivery fails `excluded.rev >` and no-ops, which is exactly what
 * makes the direct-write + queue double-write idempotent in either order. Safe because the DO
 * is the sole MetaEvent producer (`room.ts` `#mintMeta`/`#set*`/`#migrateOwner`), rev is
 * DO-monotonic, and `#migrateOwner`'s three-way guard never emits a wrong-owner event.
 */
export function upsertRoomsFromMeta(db: DrizzleD1Database<typeof schema>, rows: (typeof schema.rooms.$inferInsert)[]) {
  return db
    .insert(schema.rooms)
    .values(rows)
    .onConflictDoUpdate({
      target: schema.rooms.roomId,
      set: {
        ownerId: sql`excluded.owner_id`,
        permission: sql`excluded.permission`,
        title: sql`excluded.title`,
        rev: sql`excluded.rev`,
        deletedAt: sql`excluded.deleted_at`,
      },
      setWhere: sql`excluded.rev > ${schema.rooms.rev}`,
    });
}

/**
 * Copy a set of `room_visits` rows from one user id to another, collision-safe — the OAuth
 * adopt migration's visit fan-out, so a migrated room's recency follows the user onto every
 * device (the whole point of accounts). Query-builder `INSERT … SELECT … ON CONFLICT` (the
 * conflict expression is a `max()`, the source `user_id` a literal param) — a real prepared
 * statement, awaitable standalone OR batchable inside `db.batch` (a `db.run(sql…)` raw is
 * NOT: drizzle 0.45's d1 batch driver has no prepared stmt for a `SQLiteRaw` — TypeError,
 * verified by the users suite). Old `from` rows are left as harmless orphans (the anon id
 * was rotated; never queried again). Bound params = 2 (`to`/`from`) + `roomIds.length`, so
 * the caller chunks `roomIds` under D1's 100.
 */
export function visitCopyStmt(db: DrizzleD1Database<typeof schema>, from: UserId, to: UserId, roomIds: readonly RoomId[]) {
  const v = schema.roomVisits;
  return db
    .insert(v)
    .select(
      db
        .select({ userId: sql<UserId>`${to}`.as('user_id'), roomId: v.roomId, lastVisitedAt: v.lastVisitedAt })
        .from(v)
        .where(and(eq(v.userId, from), inArray(v.roomId, roomIds))),
    )
    .onConflictDoUpdate({
      target: [v.userId, v.roomId],
      set: { lastVisitedAt: sql`max(excluded.last_visited_at, ${v.lastVisitedAt})` },
    });
}

/** Param-bound chunker — split rows so each multi-row D1 statement stays under the 100-param
 *  cap. Shared by the queue consumer (visits/meta upserts) and the adopt migration orchestrator. */
export function chunk<T>(rows: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

/**
 * Transient-only retry (exp backoff + full jitter) for user-facing direct paths
 * (sign-in `linkAccount`, dashboard `getRooms`). Retries infrastructure errors
 * (`Network connection lost`, `storage operation failed`, 5xx, overloaded); constraint
 * (`UNIQUE`) and SQL errors are deterministic and surface immediately (§5). The queue
 * consumer does NOT use this — it leans on Queue-level `retryAll()` redelivery instead.
 */
export async function withRetry<T>(fn: () => Promise<T>, maxAttempts = 3): Promise<T> {
  const base = 100;
  const maxDelay = 800;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === maxAttempts || !isTransient(err)) throw err;
      lastErr = err;
      const delay = Math.floor(Math.random() * Math.min(maxDelay, base * 2 ** (attempt - 1)));
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastErr;
}

/**
 * Match `re` against an error's message AND its `cause` chain. Load-bearing: drizzle
 * wraps every D1 failure in a `DrizzleQueryError` whose own message is just
 * `Failed query: …` — the D1 marker (`UNIQUE constraint failed`, `Network connection
 * lost`, …) only appears on the nested cause. A message-only test silently never
 * matches, which turned "retry transient" into "fail immediately" and "detect PK
 * conflict" into "fail closed" until the suites caught it.
 */
export function errorChainMatches(err: unknown, re: RegExp): boolean {
  if (!(err instanceof Error)) return re.test(String(err));
  for (let e: Error | undefined = err; e; e = e.cause instanceof Error ? e.cause : undefined) {
    if (re.test(e.message)) return true;
  }
  return false;
}

function isTransient(err: unknown): boolean {
  return errorChainMatches(err, /network connection lost|storage operation failed|overloaded|reset|internal error|\b5\d\d\b/i);
}
