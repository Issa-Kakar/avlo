import { chunk, getSessionDB, roomVisits, upsertRoomsFromMeta, visitCopyStmt } from '@avlo/db';
import { MetaEvent, MigrateEvent, VisitEvent } from '@avlo/worker-shared';
import { sql } from 'drizzle-orm';
import type { UsersEnv } from './env';

/**
 * Queue consumer (§6/H23) — one handler binding ALL THREE queues, discriminating on
 * `batch.queue` (the queue name IS the discriminator; no `type` field). Each message is
 * `safeParse`d against its flat schema — a poison body is `ack`-dropped (discarded; NOT
 * routed to the DLQ, which is retry-exhaustion only) so one bad message can't crash the
 * batch. Dev-time choice — proper poison handling (quarantine + inspect + alert) is later
 * work.
 *
 * visits/meta coalesce within the batch, then ONE `db.batch` round trip (a single implicit
 * transaction) of param-bounded multi-row upserts, then `batch.ackAll()`; a thrown error →
 * `batch.retryAll()` (Queue-level redelivery, exhausted → DLQ). The migrate queue is the
 * exception — its rooms are INDEPENDENT, so it uses PER-MESSAGE `ack`/`retry` (one bad room
 * must not retry the whole batch) and never reaches the shared `ackAll`.
 *
 * Idempotent (at-least-once, no ordering): visits LWW by `last_visited_at`; meta `createdAt`
 * first-write-wins, everything else (incl. `ownerId`) LWW by the DO's per-room monotonic
 * `rev` — a duplicate or stale delivery fails `excluded.rev >` and no-ops. migrate leans on
 * `migrateOwner`'s own idempotency (owner-already-`to` no-ops; `forbidden` = terminal skip).
 */

// D1 caps bound parameters at 100 per statement — chunk rows so each multi-row upsert stays
// under it: visits bind 3 params/row (33×3=99), meta 7 (12×7=84; headroom to 14 if needed).
const VISIT_ROWS_MAX = 33;
const META_ROWS_MAX = 12;

// D1 exposes rows-actually-written as `meta.changes`; drizzle's batch passes the underlying
// D1Result through for inserts. Read it defensively (the shape isn't in drizzle's types) →
// null if unavailable, so the projection summary never prints a misleading "0 applied".
function readChanges(results: unknown): number | null {
  if (!Array.isArray(results)) return null;
  let n = 0;
  let sawNumeric = false;
  for (const r of results) {
    const c = (r as { meta?: { changes?: number } } | null)?.meta?.changes;
    if (typeof c === 'number') {
      n += c;
      sawNumeric = true;
    }
  }
  return sawNumeric ? n : null;
}

export async function consume(batch: MessageBatch, env: UsersEnv['Bindings']): Promise<void> {
  const { db } = getSessionDB(env.DB); // writer session → primary
  const t0 = Date.now();
  let coalesced = 0; // unique rows after in-batch coalescing (migrate: rooms successfully processed)
  let dropped = 0; // poison messages ack-discarded
  let applied: number | null = null; // rows D1 actually wrote (the rest superseded by the rev guard)
  try {
    switch (batch.queue) {
      case 'avlo-room-visits': {
        const visits = new Map<string, VisitEvent>();
        for (const m of batch.messages) {
          const p = VisitEvent.safeParse(m.body);
          if (!p.success) {
            m.ack(); // discard poison (not DLQ — see header)
            dropped++;
            continue;
          }
          const e = p.data;
          const k = `${e.userId}|${e.roomId}`;
          const prev = visits.get(k);
          if (!prev || e.visitedAt > prev.visitedAt) visits.set(k, e); // coalesce by recency (no rev on visits)
        }
        const v = [...visits.values()];
        coalesced = v.length;
        if (v.length) {
          const stmts = chunk(v, VISIT_ROWS_MAX).map((rows) =>
            db
              .insert(roomVisits)
              .values(rows.map((e) => ({ userId: e.userId, roomId: e.roomId, lastVisitedAt: e.visitedAt })))
              .onConflictDoUpdate({
                target: [roomVisits.userId, roomVisits.roomId],
                set: { lastVisitedAt: sql`excluded.last_visited_at` },
                setWhere: sql`excluded.last_visited_at > ${roomVisits.lastVisitedAt}`,
              }),
          );
          applied = readChanges(await db.batch(stmts as [(typeof stmts)[number], ...(typeof stmts)[number][]]));
        }
        batch.ackAll();
        break;
      }
      case 'avlo-room-meta': {
        // room creation (createdAt) + permission/title/owner mutations.
        const metas = new Map<string, MetaEvent>();
        for (const m of batch.messages) {
          const p = MetaEvent.safeParse(m.body);
          if (!p.success) {
            m.ack();
            dropped++;
            continue;
          }
          const e = p.data;
          const prev = metas.get(e.roomId);
          if (!prev || e.rev > prev.rev) metas.set(e.roomId, e);
        }
        const ms = [...metas.values()];
        coalesced = ms.length;
        if (ms.length) {
          // Shared rev-guarded upsert (@avlo/db) — same statement the §8 PATCH handlers use
          // for their direct read-your-writes write; createdAt first-write-wins, ownerId rev-LWW.
          const stmts = chunk(ms, META_ROWS_MAX).map((rows) => upsertRoomsFromMeta(db, rows));
          applied = readChanges(await db.batch(stmts as [(typeof stmts)[number], ...(typeof stmts)[number][]]));
        }
        batch.ackAll();
        break;
      }
      case 'avlo-room-migrate': {
        // OAuth adopt overflow/retry. INDEPENDENT rooms → PER-MESSAGE ack/retry (never
        // ackAll/retryAll). `migrateOwner` is idempotent (owner-already-`to` no-ops) and
        // enqueues a ROOM_META the meta consumer projects, so redelivery converges; the
        // visit-copy for the room rides the same handling. `forbidden` (room owned by a
        // third party) is a TERMINAL skip — ack so it can't loop to the DLQ.
        let processed = 0;
        for (const m of batch.messages) {
          const p = MigrateEvent.safeParse(m.body);
          if (!p.success) {
            m.ack();
            dropped++;
            continue;
          }
          const { roomId, from, to } = p.data;
          try {
            await env.rooms.getByName(roomId).migrateOwner(from, to);
            await visitCopyStmt(db, from, to, [roomId]);
            m.ack();
            processed++;
          } catch (err) {
            if (err instanceof Error && err.message === 'forbidden') {
              m.ack(); // terminal skip — never our migration's room
              continue;
            }
            console.error('migrate consume failed', err);
            m.retry(); // transient → redeliver → DLQ after max_retries
          }
        }
        coalesced = processed;
        break;
      }
      default:
        // Unhandled queue — a new consumer bound without a case here. Drop with a clearly
        // labeled log so it never masquerades as a migrate failure or reaches a real DLQ.
        console.error(`[queue] unexpected queue ${batch.queue} — dropping ${batch.messages.length} msg(s)`);
        batch.ackAll();
        return;
    }
    // Always-on projection heartbeat (H10-safe — counts + timing, no ids/bodies). `rows < msgs`
    // is in-batch coalescing (or migrate retries/skips); `superseded` is rows the D1 rev guard
    // rejected as stale/duplicate (at-least-once redelivery + the direct-write/queue double-write).
    const lww = applied != null ? ` applied=${applied} superseded=${coalesced - applied}` : '';
    console.warn(`[queue] ${batch.queue} msgs=${batch.messages.length} rows=${coalesced} dropped=${dropped}${lww} (${Date.now() - t0}ms)`);
  } catch (err) {
    console.error('queue consume failed', err);
    batch.retryAll(); // exhausted retries → that queue's DLQ; poison never blocks the pipe
  }
}
