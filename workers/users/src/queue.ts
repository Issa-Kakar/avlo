import { chunk, getSessionDB, META_ROWS_MAX, rooms, roomVisits, upsertRoomsFromMeta } from '@avlo/db';
import { MetaEvent, mapWithConcurrency, RoomMigrateEvent, VisitEvent } from '@avlo/worker-shared';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { z } from 'zod/v4';
import type { UsersEnv } from './env';

/**
 * Queue consumer (§6/H23) — one handler binding THREE queues, discriminating on
 * `batch.queue` (the queue name IS the discriminator; no `type` field). Each message is
 * `safeParse`d against its flat schema — a poison body is `ack`-dropped (discarded; NOT
 * routed to the DLQ, which is retry-exhaustion only) so one bad message can't crash the
 * batch. Dev-time choice — proper poison handling (quarantine + inspect + alert) is later
 * work. Coalesce within the batch, then ONE `db.batch` round trip (a single implicit
 * transaction) of param-bounded multi-row upserts.
 * No inner `withRetry`: a thrown error → `batch.retryAll()` (Queue-level redelivery with
 * backoff, exhausted → DLQ); an inner retry would just stall the batch.
 *
 * Idempotent (at-least-once, no ordering): createdAt first-write-wins (untouched on
 * conflict); everything else (incl. ownerId) LWW guarded by the DO's per-room monotonic
 * `rev` — a duplicate or stale delivery fails `excluded.rev >` and no-ops. Visits resolve
 * by `last_visited_at` (recency IS the truth; visits no longer carry `rev`).
 */

// D1 caps bound parameters at 100 per statement — chunk rows so each multi-row upsert
// stays under it (visits bind 3 params/row → 32 rows = 96; meta 8 → `META_ROWS_MAX`).
const VISIT_ROWS_MAX = 32;

// Second-device ownership-migration sweep (§9): the durable fallback for the synchronous
// fan-out's cap overflow + per-room failures. Bounded concurrency over cross-script DO
// RPCs; process up to SWEEP_BATCH live rooms per invocation and re-enqueue if more remain
// (each migrated room flips owner_id, so the next enumerate excludes it — drains in waves).
const MIGRATE_CONCURRENCY = 6;
const SWEEP_BATCH = 100;

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
  const t0 = Date.now();
  let coalesced = 0; // unique rows/sweeps after in-batch coalescing
  let dropped = 0; // poison messages ack-discarded
  let applied: number | null = null; // rows D1 actually wrote (the rest superseded by the rev guard)
  try {
    if (batch.queue === 'avlo-room-visits') {
      const { db } = getSessionDB(env.DB); // writer session → primary
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
        if (!prev || e.visitedAt > prev.visitedAt) visits.set(k, e); // coalesce by recency
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
    } else if (batch.queue === 'avlo-room-meta') {
      // room creation (owner/createdAt) + permission flips + owner migrations.
      const { db } = getSessionDB(env.DB);
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
        // Shared rev-guarded upsert (@avlo/db) — same statement the §8 PATCH handlers + the
        // §9 migration fan-out direct-write with; createdAt first-write-wins, the rest LWW.
        const stmts = chunk(ms, META_ROWS_MAX).map((rows) => upsertRoomsFromMeta(db, rows));
        applied = readChanges(await db.batch(stmts as [(typeof stmts)[number], ...(typeof stmts)[number][]]));
      }
    } else {
      // avlo-room-migrate — second-device adopt sweep. Re-enumerate live rooms owned by
      // prevOwner (primary session → read-your-writes across waves) and re-fan-out to each
      // room DO's idempotent `migrateOwner`; direct-write the snapshots (the DO ALSO projects
      // them to room-meta, which converges D1 even if this write is lost). Re-enqueue if more
      // rooms remain than one wave covers. Coalesce identical sweeps within the batch.
      const { db } = getSessionDB(env.DB, 'first-primary');
      const sweeps = new Map<string, RoomMigrateEvent>();
      for (const m of batch.messages) {
        const p = RoomMigrateEvent.safeParse(m.body);
        if (!p.success) {
          m.ack();
          dropped++;
          continue;
        }
        const e = p.data;
        sweeps.set(`${e.prevOwner}|${e.nextOwner}`, e);
      }
      coalesced = sweeps.size;
      let migrated = 0;
      for (const e of sweeps.values()) {
        const owned = await db
          .select({ roomId: rooms.roomId })
          .from(rooms)
          .where(and(eq(rooms.ownerId, e.prevOwner), isNull(rooms.deletedAt)))
          .limit(SWEEP_BATCH + 1)
          .all();
        if (owned.length === 0) continue;
        const more = owned.length > SWEEP_BATCH;
        const wave = more ? owned.slice(0, SWEEP_BATCH) : owned;
        const snaps = await mapWithConcurrency(wave, MIGRATE_CONCURRENCY, ({ roomId }) =>
          env.rooms.getByName(roomId).migrateOwner(e.prevOwner, e.nextOwner),
        );
        const metas = snaps.filter((m): m is NonNullable<typeof m> => m !== null);
        if (metas.length) {
          const stmts = chunk(metas, META_ROWS_MAX).map((c) => upsertRoomsFromMeta(db, c));
          migrated += readChanges(await db.batch(stmts as [(typeof stmts)[number], ...(typeof stmts)[number][]])) ?? metas.length;
        }
        if (more)
          await env.ROOM_MIGRATE.send({ prevOwner: e.prevOwner, nextOwner: e.nextOwner } satisfies z.input<typeof RoomMigrateEvent>);
      }
      applied = migrated;
    }
    batch.ackAll();
    // Always-on projection heartbeat (H10-safe — counts + timing, no ids/bodies). `rows < msgs`
    // is in-batch coalescing; `superseded` is rows the D1 guard rejected as stale/duplicate
    // (at-least-once redelivery + the direct-write/queue double-write). Clamped ≥ 0 — the
    // migrate sweep's `applied` counts rooms (not `coalesced` events), so the diff is N/A there.
    const lww = applied != null ? ` applied=${applied} superseded=${Math.max(0, coalesced - applied)}` : '';
    console.warn(`[queue] ${batch.queue} msgs=${batch.messages.length} rows=${coalesced} dropped=${dropped}${lww} (${Date.now() - t0}ms)`);
  } catch (err) {
    console.error('queue consume failed', err);
    batch.retryAll(); // exhausted retries → that queue's DLQ; poison never blocks the pipe
  }
}
