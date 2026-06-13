import { getSessionDB, roomVisits, upsertRoomsFromMeta } from '@avlo/db';
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

export async function consume(batch: MessageBatch, env: Env): Promise<void> {
  const { db } = getSessionDB(env.DB); // writer session → primary
  const t0 = Date.now();
  let coalesced = 0; // unique rows after in-batch rev-coalescing
  let dropped = 0; // poison messages ack-discarded
  let applied: number | null = null; // rows D1 actually wrote (the rest superseded by the rev guard)
  try {
    if (batch.queue === 'avlo-room-visits') {
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
        if (!prev || e.rev > prev.rev) visits.set(k, e);
      }
      const v = [...visits.values()];
      coalesced = v.length;
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
        applied = readChanges(await db.batch(stmts as [(typeof stmts)[number], ...(typeof stmts)[number][]]));
      }
    } else {
      // avlo-room-meta — room creation (owner/createdAt) + permission flips.
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
        // for their direct read-your-writes write; owner/createdAt first-write-wins.
        const stmts = chunk(ms, META_ROWS_MAX).map((rows) => upsertRoomsFromMeta(db, rows));
        applied = readChanges(await db.batch(stmts as [(typeof stmts)[number], ...(typeof stmts)[number][]]));
      }
    }
    batch.ackAll();
    // Always-on projection heartbeat (H10-safe — counts + timing, no ids/bodies). `rows < msgs`
    // is in-batch rev-coalescing; `superseded` is rows the D1 `excluded.rev >` guard rejected as
    // stale/duplicate (at-least-once redelivery + the direct-write/queue double-write).
    const lww = applied != null ? ` applied=${applied} superseded=${coalesced - applied}` : '';
    console.warn(`[queue] ${batch.queue} msgs=${batch.messages.length} rows=${coalesced} dropped=${dropped}${lww} (${Date.now() - t0}ms)`);
  } catch (err) {
    console.error('queue consume failed', err);
    batch.retryAll(); // exhausted retries → that queue's DLQ; poison never blocks the pipe
  }
}
