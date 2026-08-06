import { createMessageBatch, env } from 'cloudflare:test';
import { roomVisits } from '@avlo/db';
import type { RoomId, UserId } from '@avlo/shared';
import { MetaEvent, MigrateEvent, RPC_FORBIDDEN, VisitEvent } from '@avlo/worker-shared';
import { describe, expect, it } from 'vitest';
import {
  consumeBatch,
  db,
  deadRoomsNamespace,
  hybridRoomsNamespace,
  mintRoom,
  msg,
  newRoomId,
  newUserId,
  roomRow,
  roomsNs,
  visitRow,
} from './harness';

const visit = (userId: UserId, roomId: RoomId, visitedAt: number) => VisitEvent.parse({ userId, roomId, visitedAt });
const meta = (roomId: RoomId, ownerId: UserId, rev: number, extra: Partial<MetaEvent> = {}) =>
  MetaEvent.parse({ roomId, ownerId, permission: 'public', createdAt: 111, title: 'Untitled', rev, deletedAt: null, ...extra });

describe('queue consumer', () => {
  it('visits: poison ack-dropped (never DLQ), in-batch coalesce by max visitedAt, batch ackAll', async () => {
    const u = newUserId();
    const u2 = newUserId();
    const [r, r2] = [newRoomId(), newRoomId()];
    const poison = msg({ nonsense: true });
    const batch = createMessageBatch('avlo-room-visits', [
      poison,
      msg(visit(u, r, 1000)),
      msg(visit(u, r, 2000)), // same user+room — coalesces to the max
      msg(visit(u2, r2, 500)),
    ]);
    const result = await consumeBatch(batch);
    expect(result.explicitAcks).toContain(poison.id); // discarded, not retried toward a DLQ
    expect(result.ackAll).toBe(true);
    expect(result.retryMessages).toEqual([]);

    expect((await visitRow(u, r))?.lastVisitedAt).toBe(2000);
    expect((await visitRow(u2, r2))?.lastVisitedAt).toBe(500);
  });

  it('visits: LWW is strictly greater-than — stale and equal deliveries never move the row', async () => {
    const u = newUserId();
    const r = newRoomId();
    await db().insert(roomVisits).values({ userId: u, roomId: r, lastVisitedAt: 5000 });

    await consumeBatch(createMessageBatch('avlo-room-visits', [msg(visit(u, r, 4000)), msg(visit(u, r, 5000))]));
    expect((await visitRow(u, r))?.lastVisitedAt).toBe(5000);
  });

  it('meta: coalesces by max rev in-batch; later batches supersede by rev with createdAt first-write-wins', async () => {
    const owner = newUserId();
    const r = newRoomId();
    // Out-of-order in one batch: only rev 3 survives coalescing.
    await consumeBatch(
      createMessageBatch('avlo-room-meta', [
        msg(meta(r, owner, 1, { title: 'One', createdAt: 111 })),
        msg(meta(r, owner, 3, { title: 'Three', createdAt: 333 })),
        msg(meta(r, owner, 2, { title: 'Two', createdAt: 222 })),
      ]),
    );
    expect(await roomRow(r)).toMatchObject({ title: 'Three', rev: 3, createdAt: 333 });

    // A later, higher-rev delivery updates everything EXCEPT createdAt (FWW).
    await consumeBatch(
      createMessageBatch('avlo-room-meta', [msg(meta(r, owner, 4, { title: 'Four', createdAt: 999, permission: 'readonly' }))]),
    );
    expect(await roomRow(r)).toMatchObject({ title: 'Four', rev: 4, permission: 'readonly', createdAt: 333 });

    // A stale redelivery after that supersedes nothing.
    await consumeBatch(createMessageBatch('avlo-room-meta', [msg(meta(r, owner, 2, { title: 'Stale' }))]));
    expect(await roomRow(r)).toMatchObject({ title: 'Four', rev: 4 });
  });

  it('migrate: per-message verdicts — success acked, forbidden terminal-acked (simulated verdict), poison acked; never batch-level', async () => {
    const from = newUserId();
    const to = newUserId();
    const mine = newRoomId();
    const theirs = newRoomId();
    await mintRoom(mine, from);
    // NB: `theirs` deliberately has NO real DO meta — a second mint in this test re-arms
    // the teardown wedge this file's hybrid exists to dodge (empirically re-confirmed).
    // The real third-party-owned forbidden contract is pinned in sync/permissions; the
    // queue-path-against-a-real-DO version lives in workers/integration
    // (ownership.test.ts — real broker delivery, no pool teardown in play).
    await db().insert(roomVisits).values({ userId: from, roomId: mine, lastVisitedAt: 42 });
    await db().insert(roomVisits).values({ userId: from, roomId: theirs, lastVisitedAt: 43 });

    // Hybrid namespace: the good room hits the REAL AvloDO; the forbidden verdict is
    // simulated (a real one re-arms the teardown wedge — see harness). What THIS test
    // owns is consume's per-message ack-vs-retry ledger.
    const hybridRooms = hybridRoomsNamespace(roomsNs, { [theirs]: new Error(RPC_FORBIDDEN) });

    const good = msg(MigrateEvent.parse({ roomId: mine, from, to }));
    const skipped = msg(MigrateEvent.parse({ roomId: theirs, from, to }));
    const poison = msg({ junk: 1 });
    const result = await consumeBatch(createMessageBatch('avlo-room-migrate', [good, skipped, poison]), { ...env, rooms: hybridRooms });

    expect(result.explicitAcks.sort()).toEqual([good.id, skipped.id, poison.id].sort());
    expect(result.ackAll).toBe(false); // migrate never uses batch-level acks
    expect(result.retryMessages).toEqual([]);

    // The good room re-owned at the authority + its visit copied to the account id. The
    // ownership read leans on migrateOwner's idempotent already-owned no-op branch — the
    // DO is the only authority here (consumers stripped ⇒ no D1 mirror) and its RPC
    // surface has no read-only meta getter.
    const snap = await roomsNs.getByName(mine).migrateOwner(from, to);
    expect(snap.ownerId).toBe(to);
    expect((await visitRow(to, mine))?.lastVisitedAt).toBe(42);

    // The terminal skip did no per-room work: the forbidden verdict acks BEFORE the
    // visit-copy, so `from`'s seeded visit on `theirs` was never copied to the account.
    expect(await visitRow(to, theirs)).toBeUndefined();
  });

  it('migrate: the visit-copy runs even when migrateOwner no-ops (idempotent redelivery recovers the visit row)', async () => {
    const from = newUserId();
    const to = newUserId();
    const roomId = newRoomId();
    await mintRoom(roomId, from);
    await roomsNs.getByName(roomId).migrateOwner(from, to); // already migrated — the redelivery scenario
    await db().insert(roomVisits).values({ userId: from, roomId, lastVisitedAt: 77 });

    await consumeBatch(createMessageBatch('avlo-room-migrate', [msg(MigrateEvent.parse({ roomId, from, to }))]));
    expect((await visitRow(to, roomId))?.lastVisitedAt).toBe(77); // recovered despite the ownership no-op
  });

  it('migrate: a transient DO failure retries THAT message only', async () => {
    const from = newUserId();
    const to = newUserId();
    const deadRooms = deadRoomsNamespace(new Error('do transport lost'));

    const m = msg(MigrateEvent.parse({ roomId: newRoomId(), from, to }));
    const result = await consumeBatch(createMessageBatch('avlo-room-migrate', [m]), { ...env, rooms: deadRooms });
    expect(result.retryMessages.map((r) => r.msgId)).toEqual([m.id]);
    expect(result.explicitAcks).toEqual([]);
  });

  it('acks-and-drops an entire batch from an unexpected queue (misbound consumer guard)', async () => {
    const result = await consumeBatch(createMessageBatch('avlo-mystery-queue', [msg({ any: 'thing' })]));
    expect(result.ackAll).toBe(true);
  });

  it('retries the WHOLE batch when D1 itself is down (poison never blocks, but infrastructure does)', async () => {
    const deadDB = {
      withSession: () => {
        throw new Error('d1 down');
      },
    } as unknown as typeof env.DB;
    const result = await consumeBatch(createMessageBatch('avlo-room-visits', [msg(visit(newUserId(), newRoomId(), 1))]), {
      ...env,
      DB: deadDB,
    });
    expect(result.retryBatch.retry).toBe(true);
  });
});
