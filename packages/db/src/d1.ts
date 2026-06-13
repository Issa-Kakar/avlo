import { type Logger, sql } from 'drizzle-orm';
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
 * `ownerId`/`createdAt` are deliberately absent from `set` (first-write-wins); the rest is
 * LWW resolved by the DO's per-room monotonic `rev` — a duplicate, stale, or already-applied
 * delivery fails `excluded.rev >` and no-ops, which is exactly what makes the direct-write +
 * queue double-write idempotent in either order.
 */
export function upsertRoomsFromMeta(db: DrizzleD1Database<typeof schema>, rows: (typeof schema.rooms.$inferInsert)[]) {
  return db
    .insert(schema.rooms)
    .values(rows)
    .onConflictDoUpdate({
      target: schema.rooms.roomId,
      set: {
        permission: sql`excluded.permission`,
        updatedAt: sql`excluded.updated_at`,
        title: sql`excluded.title`,
        rev: sql`excluded.rev`,
        deleted: sql`excluded.deleted`,
      },
      setWhere: sql`excluded.rev > ${schema.rooms.rev}`,
    });
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

function isTransient(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /network connection lost|storage operation failed|overloaded|reset|internal error|\b5\d\d\b/i.test(msg);
}
