import { getSessionDB, rooms, roomVisits } from '@avlo/db';
import { MetaEvent, VisitEvent } from '@avlo/worker-shared';
import { sql } from 'drizzle-orm';

/**
 * Queue consumer (§6/H23) — one handler binding BOTH queues, discriminating on
 * `batch.queue` (the queue name IS the discriminator; no `type` field). Each message is
 * `safeParse`d against its flat schema — a poison body is `ack`-dropped (discarded; NOT
 * routed to the DLQ, which is retry-exhaustion only) so one bad message can't crash the
 * batch. Dev-time choice — proper poison handling (quarantine + inspect + alert) is later
 * work. Coalesce within the batch, then ONE `db.batch` round trip (a single implicit
 * transaction) of param-bounded multi-row upserts.
 * No inner `withRetry`: a thrown error → `batch.retryAll()` (Queue-level redelivery with
 * backoff, exhausted → DLQ); an inner retry would just stall the batch.
 *
 * Idempotent (at-least-once, no ordering): owner/createdAt first-write-wins (untouched on
 * conflict), everything else LWW guarded by the DO's per-room monotonic `rev` — a
 * duplicate or stale delivery fails `excluded.rev >` and no-ops.
 */

// D1 caps bound parameters at 100 per statement — chunk rows so each multi-row upsert
// stays under it (visits bind 4 params/row, meta 8 → 96 params/statement).
const VISIT_ROWS_MAX = 24;
const META_ROWS_MAX = 12;

function chunk<T>(rows: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

export async function consume(batch: MessageBatch, env: Env): Promise<void> {
  const { db } = getSessionDB(env.DB); // writer session → primary
  try {
    if (batch.queue === 'avlo-room-visits') {
      const visits = new Map<string, VisitEvent>();
      for (const m of batch.messages) {
        const p = VisitEvent.safeParse(m.body);
        if (!p.success) {
          m.ack(); // discard poison (not DLQ — see header)
          continue;
        }
        const e = p.data;
        const k = `${e.userId}|${e.roomId}`;
        const prev = visits.get(k);
        if (!prev || e.rev > prev.rev) visits.set(k, e);
      }
      const v = [...visits.values()];
      if (v.length) {
        const stmts = chunk(v, VISIT_ROWS_MAX).map((rows) =>
          db
            .insert(roomVisits)
            .values(rows.map((e) => ({ userId: e.userId, roomId: e.roomId, lastVisitedAt: e.visitedAt, rev: e.rev })))
            .onConflictDoUpdate({
              target: [roomVisits.userId, roomVisits.roomId],
              set: { lastVisitedAt: sql`excluded.last_visited_at`, rev: sql`excluded.rev` },
              setWhere: sql`excluded.rev > ${roomVisits.rev}`,
            }),
        );
        await db.batch(stmts as [(typeof stmts)[number], ...(typeof stmts)[number][]]);
      }
    } else {
      // avlo-room-meta — room creation (owner/createdAt) + permission flips.
      const metas = new Map<string, MetaEvent>();
      for (const m of batch.messages) {
        const p = MetaEvent.safeParse(m.body);
        if (!p.success) {
          m.ack();
          continue;
        }
        const e = p.data;
        const prev = metas.get(e.roomId);
        if (!prev || e.rev > prev.rev) metas.set(e.roomId, e);
      }
      const ms = [...metas.values()];
      if (ms.length) {
        const stmts = chunk(ms, META_ROWS_MAX).map((rows) =>
          db
            .insert(rooms)
            .values(
              rows.map((e) => ({
                roomId: e.roomId,
                ownerId: e.ownerId,
                permission: e.permission,
                createdAt: e.createdAt,
                updatedAt: e.updatedAt,
                title: e.title,
                rev: e.rev,
                deleted: e.deleted,
              })),
            )
            .onConflictDoUpdate({
              target: rooms.roomId,
              set: {
                permission: sql`excluded.permission`,
                updatedAt: sql`excluded.updated_at`,
                title: sql`excluded.title`,
                rev: sql`excluded.rev`,
                deleted: sql`excluded.deleted`,
              },
              setWhere: sql`excluded.rev > ${rooms.rev}`, // owner/createdAt untouched → first-write-wins
            }),
        );
        await db.batch(stmts as [(typeof stmts)[number], ...(typeof stmts)[number][]]);
      }
    }
    batch.ackAll();
  } catch (err) {
    console.error('queue consume failed', err);
    batch.retryAll(); // exhausted retries → that queue's DLQ; poison never blocks the pipe
  }
}
