import { createExecutionContext, env } from 'cloudflare:test';
import { rooms as roomsTable, roomVisits, upsertRoomsFromMeta, users } from '@avlo/db';
import type { RoomId, UserId } from '@avlo/shared';
import { type MetaEvent, RPC_FORBIDDEN } from '@avlo/worker-shared';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { UsersRpc } from '../src/rpc';
import { db, deadRoomsNamespace, hybridRoomsNamespace, mintRoom, newRoomId, newUserId, roomRow, roomsNs, visitRow } from './harness';

/** Direct construction — the RPC surface without a service-binding round trip. */
const rpc = (envOverride: Partial<typeof env> = {}) =>
  new UsersRpc(createExecutionContext() as ExecutionContext, { ...env, ...envOverride } as never);

const userRowBySub = async (sub: string) => (await db().select().from(users).where(eq(users.googleSub, sub)).all())[0];

/** Mint DO meta AND mirror it into D1 (the enumeration source) deterministically. */
async function seedOwnedRoom(owner: UserId, opts: { permission?: 'public' | 'private' | 'readonly' } = {}): Promise<RoomId> {
  const roomId = newRoomId();
  const snap = await mintRoom(roomId, owner);
  const projected: MetaEvent = { ...snap, permission: (opts.permission ?? 'public') as MetaEvent['permission'] };
  if (opts.permission && opts.permission !== 'public') {
    await roomsNs.getByName(roomId).setPermission(owner, opts.permission);
    projected.rev = 2;
  }
  await upsertRoomsFromMeta(db(), [projected]);
  return roomId;
}

describe('UsersRpc.linkAccount', () => {
  it('PROMOTE: a new googleSub keeps the device id; a repeat sign-in resolves to the same row', async () => {
    const uid = newUserId();
    const sub = `sub-${uid}`;
    const first = await rpc().linkAccount(uid, sub, { email: 'a@example.com', name: 'A', avatarHash: null });
    expect(first.userId).toBe(uid);
    expect(await userRowBySub(sub)).toMatchObject({ userId: uid, email: 'a@example.com', name: 'A' });

    // Repeat sign-in from the same device with a live session: dual-conflicts on the SAME
    // row and resolves through the conflict target — the pinned regression.
    const again = await rpc().linkAccount(uid, sub, { email: 'a2@example.com', name: 'A2', avatarHash: null });
    expect(again.userId).toBe(uid);
    expect(await userRowBySub(sub)).toMatchObject({ email: 'a2@example.com', name: 'A2' });
  });

  it('ADOPT: an existing googleSub returns the ACCOUNT id, never the new device id', async () => {
    const accountId = newUserId();
    const sub = `sub-${accountId}`;
    await rpc().linkAccount(accountId, sub, { email: 'acct@example.com', name: 'Acct', avatarHash: null });

    const secondDevice = newUserId();
    const adopted = await rpc().linkAccount(secondDevice, sub, { email: 'acct@example.com', name: 'Acct', avatarHash: null });
    expect(adopted.userId).toBe(accountId);
  });

  it('coalesces avatarHash: a null ingest never clobbers a stored avatar; a fresh hash updates it', async () => {
    const uid = newUserId();
    const sub = `sub-${uid}`;
    const stored = 'ab'.repeat(16);
    await rpc().linkAccount(uid, sub, { email: 'e@example.com', name: 'E', avatarHash: stored });

    const nullIngest = await rpc().linkAccount(newUserId(), sub, { email: 'e@example.com', name: 'E', avatarHash: null });
    expect(nullIngest.avatarHash).toBe(stored); // post-coalesce truth returned

    const fresh = 'cd'.repeat(16);
    const updated = await rpc().linkAccount(newUserId(), sub, { email: 'e@example.com', name: 'E', avatarHash: fresh });
    expect(updated.avatarHash).toBe(fresh);
  });

  it('retries ONCE with a fresh id when the device id is already linked to a DIFFERENT account', async () => {
    const uid = newUserId();
    await rpc().linkAccount(uid, `sub-first-${uid}`, { email: 'one@example.com', name: 'One', avatarHash: null });

    // Same device id, different Google account → users.user_id PK conflict → fresh id.
    const second = await rpc().linkAccount(uid, `sub-second-${uid}`, { email: 'two@example.com', name: 'Two', avatarHash: null });
    expect(second.userId).not.toBe(uid);
    expect((await userRowBySub(`sub-second-${uid}`))?.userId).toBe(second.userId);
    expect((await userRowBySub(`sub-first-${uid}`))?.userId).toBe(uid); // first link untouched
  });
});

describe('UsersRpc.migrateOwnedRooms', () => {
  it('no-ops promote (from === to) and the zero-rooms case', async () => {
    const uid = newUserId();
    expect(await rpc().migrateOwnedRooms(uid, uid)).toEqual({ bookmark: '', migrated: 0, queued: 0 });
    expect(await rpc().migrateOwnedRooms(uid, newUserId())).toEqual({ bookmark: '', migrated: 0, queued: 0 });
  });

  it('re-owns the sync slice at the DO + mirrors D1 + copies visits, with a RYW bookmark', async () => {
    const from = newUserId();
    const to = newUserId();
    const owned = [await seedOwnedRoom(from), await seedOwnedRoom(from), await seedOwnedRoom(from)];
    for (const roomId of owned) await db().insert(roomVisits).values({ userId: from, roomId, lastVisitedAt: 42 });

    const result = await rpc().migrateOwnedRooms(from, to);
    expect(result.migrated).toBe(3);
    expect(result.queued).toBe(0);
    expect(result.bookmark).not.toBe('');

    for (const roomId of owned) {
      expect(await roomRow(roomId)).toMatchObject({ ownerId: to, rev: 2 }); // RYW direct write
      expect((await visitRow(to, roomId))?.lastVisitedAt).toBe(42); // visit follows the account
      // Authority agrees (DO persistence, not just the snapshot D1 mirrored) — this read
      // leans on migrateOwner's idempotent already-owned no-op; no read-only meta getter exists.
      expect((await roomsNs.getByName(roomId).migrateOwner(from, to)).ownerId).toBe(to);
    }
  });

  it('drops third-party-owned rooms terminally — never queued, never forced (simulated verdict)', async () => {
    // D1 claims `from` owns it, the DO verdict is forbidden — the D1 projection is stale
    // by construction. Forbidden is simulated (see the harness note on the teardown
    // wedge); the DO-side contract itself is the sync suite's coverage.
    const from = newUserId();
    const roomId = newRoomId();
    await db()
      .insert(roomsTable)
      .values({ roomId, ownerId: from, permission: 'public', title: 'Stale Claim', rev: 1, createdAt: 1, deletedAt: null });
    const forbiddenRooms = deadRoomsNamespace(new Error(RPC_FORBIDDEN));

    const result = await rpc({ rooms: forbiddenRooms }).migrateOwnedRooms(from, newUserId());
    expect(result).toMatchObject({ migrated: 0, queued: 0 });
  });

  it('orders priority + private into the 50-room sync slice; only public overflow queues', async () => {
    const from = newUserId();
    const to = newUserId();
    // 53 public + 1 private + 1 priority(public) = 55 owned; slice = 50. The private and
    // priority rooms are seeded LAST (ULID room ids enumerate in creation order), so both
    // sit past the 50-cap in raw enumeration — landing them in the sync slice can only be
    // the reorder (priority/private/public) doing its job, never accidental position.
    const publics: RoomId[] = [];
    for (let i = 0; i < 53; i++) publics.push(await seedOwnedRoom(from));
    const privateRoom = await seedOwnedRoom(from, { permission: 'private' });
    const priorityRoom = await seedOwnedRoom(from);

    const result = await rpc().migrateOwnedRooms(from, to, priorityRoom);
    expect(result.migrated).toBe(50);
    expect(result.queued).toBe(5); // 5 publics overflowed to the migrate queue

    // The rooms that MUST be in the sync slice (an overflowed private would 4403-prune
    // the local board on reconnect) are re-owned immediately.
    expect(await roomRow(priorityRoom)).toMatchObject({ ownerId: to });
    expect(await roomRow(privateRoom)).toMatchObject({ ownerId: to });
  }, 60000);

  it('queues a room whose DO migrateOwner fails transiently', async () => {
    const from = newUserId();
    const to = newUserId();
    const good = await seedOwnedRoom(from);
    const flaky = await seedOwnedRoom(from);
    const hybrid = hybridRoomsNamespace(roomsNs, { [flaky]: new Error('do transport lost') });

    const result = await rpc({ rooms: hybrid }).migrateOwnedRooms(from, to);
    expect(result.migrated).toBe(1);
    expect(result.queued).toBe(1);
    expect(await roomRow(good)).toMatchObject({ ownerId: to });
  });

  it('re-queues the sync slice when the RYW batch fails — still counted in migrated (overlap by design)', async () => {
    const from = newUserId();
    const to = newUserId();
    await seedOwnedRoom(from);
    await seedOwnedRoom(from);
    // Real session with ONLY `batch` (the RYW write) overridden to die — everything else
    // stays live, so a new session-method use in the code under test can't fail confusingly.
    // (Proxy, not spread: the session's methods are prototype-hosted — a spread silently
    // drops them, verified by running it.)
    const batchlessDB = {
      withSession: (bm?: string) => {
        const s = env.DB.withSession(bm);
        return new Proxy(s, {
          get: (target, prop) => {
            if (prop === 'batch') return () => Promise.reject(new Error('d1 batch down'));
            const v = Reflect.get(target, prop);
            return typeof v === 'function' ? v.bind(target) : v;
          },
        });
      },
    } as unknown as typeof env.DB;

    const result = await rpc({ DB: batchlessDB }).migrateOwnedRooms(from, to);
    // The DO writes committed (migrated counts them) AND the rooms re-queued so the
    // visit-copy recovers via the migrate consumer — deliberate double-accounting.
    expect(result.migrated).toBe(2);
    expect(result.queued).toBe(2);
    expect(result.bookmark).toBe('');
  });

  it('swallows a sendBatch failure — sign-in must never fail on the queue tail', async () => {
    const from = newUserId();
    const to = newUserId();
    const flaky = await seedOwnedRoom(from);
    const deadEverything = {
      rooms: deadRoomsNamespace(new Error('transient')),
      ROOM_MIGRATE: { sendBatch: () => Promise.reject(new Error('queue down')) } as unknown as typeof env.ROOM_MIGRATE,
    };

    const result = await rpc(deadEverything).migrateOwnedRooms(from, to);
    expect(result.migrated).toBe(0);
    expect(result.queued).toBe(1); // counted even though the enqueue itself failed
    expect(await roomRow(flaky)).toMatchObject({ ownerId: from }); // converges on next sign-in/reopen
  });
});
