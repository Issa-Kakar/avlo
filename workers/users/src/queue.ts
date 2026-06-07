import { getSessionDB, rooms, roomVisits } from '@avlo/db';
import { MetaEvent, VisitEvent } from '@avlo/worker-shared';
import { sql } from 'drizzle-orm';

/**
 * Queue consumer (§6/H23) — one handler binding BOTH queues, discriminating on
 * `batch.queue` (the queue name IS the discriminator; no `type` field). Each message is
 * `safeParse`d against its flat schema — a poison body is `ack`-dropped (discarded; NOT
 * routed to the DLQ, which is retry-exhaustion only) so one bad message can't crash the
 * batch. Dev-time choice — proper poison handling (quarantine + inspect + alert) is later
 * work. Coalesce within the batch, then one upsert per key.
 * No inner `withRetry`: a thrown error → `batch.retryAll()` (Queue-level redelivery with
 * backoff, exhausted → DLQ); an inner retry would just stall the batch.
 *
 * Idempotent (at-least-once, no ordering): owner/createdAt first-write-wins (untouched on
 * conflict), permission LWW guarded by `updatedAt`, `lastVisitedAt` `max()`.
 */
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
        if (!prev || e.visitedAt > prev.visitedAt) visits.set(k, e);
      }
      const v = [...visits.values()];
      if (v.length) {
        await db
          .insert(roomVisits)
          .values(v.map((e) => ({ userId: e.userId, roomId: e.roomId, lastVisitedAt: e.visitedAt })))
          .onConflictDoUpdate({
            target: [roomVisits.userId, roomVisits.roomId],
            set: { lastVisitedAt: sql`max(excluded.last_visited_at, ${roomVisits.lastVisitedAt})` },
          });
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
        if (!prev || e.updatedAt > prev.updatedAt) metas.set(e.roomId, e);
      }
      for (const e of metas.values()) {
        await db
          .insert(rooms)
          .values({ roomId: e.roomId, ownerId: e.ownerId, permission: e.permission, createdAt: e.createdAt, updatedAt: e.updatedAt })
          .onConflictDoUpdate({
            target: rooms.roomId,
            set: { permission: e.permission, updatedAt: e.updatedAt },
            setWhere: sql`excluded.updated_at > ${rooms.updatedAt}`, // owner/createdAt untouched → first-write-wins
          });
      }
    }
    batch.ackAll();
  } catch (err) {
    console.error('queue consume failed', err);
    batch.retryAll(); // exhausted retries → that queue's DLQ; poison never blocks the pipe
  }
}
