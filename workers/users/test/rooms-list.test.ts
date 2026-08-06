import { rooms, roomVisits, users } from '@avlo/db';
import type { RoomId, UserId } from '@avlo/shared';
import { describe, expect, it } from 'vitest';
import { db, hit, newRoomId, newUserId } from './harness';

interface Entry {
  roomId: string;
  title: string;
  permission: string;
  isOwner: boolean;
  ownerName: string | null;
  createdAt: number;
  lastVisitedAt: number;
}

const listFor = async (user: UserId, headers: Record<string, string> = {}) => {
  const res = await hit('/rooms', { headers }, { user });
  return { res, body: (await res.json()) as { rooms: Entry[]; bookmark: string } };
};

async function seedRoom(
  roomId: RoomId,
  ownerId: UserId,
  opts: { permission?: string; title?: string; deletedAt?: number; createdAt?: number } = {},
) {
  await db()
    .insert(rooms)
    .values({
      roomId,
      ownerId,
      permission: (opts.permission ?? 'public') as never,
      title: opts.title ?? 'Untitled',
      rev: 1,
      createdAt: opts.createdAt ?? 1000,
      deletedAt: opts.deletedAt ?? null,
    });
}

const seedVisit = (userId: UserId, roomId: RoomId, lastVisitedAt: number) =>
  db().insert(roomVisits).values({ userId, roomId, lastVisitedAt });

describe('GET /rooms', () => {
  it('401s without an identity', async () => {
    expect((await hit('/rooms', {}, { user: null })).status).toBe(401);
  });

  it('projects the visit-join: recency-ordered, visits-only, orphans dropped, tombstones excluded', async () => {
    const me = newUserId();
    const [a, b, c, unvisited, orphanVisit, tombstoned] = [newRoomId(), newRoomId(), newRoomId(), newRoomId(), newRoomId(), newRoomId()];
    await seedRoom(a, me);
    await seedRoom(b, me);
    await seedRoom(c, me);
    await seedRoom(unvisited, me); // no visit row → never listed
    await seedRoom(tombstoned, me, { deletedAt: 999 });
    await seedVisit(me, a, 3000);
    await seedVisit(me, b, 1000);
    await seedVisit(me, c, 2000);
    await seedVisit(me, orphanVisit, 5000); // visit without a rooms row → inner join drops it
    await seedVisit(me, tombstoned, 4000);

    const { body } = await listFor(me);
    expect(body.rooms.map((r) => r.roomId)).toEqual([a, c, b]); // desc(lastVisitedAt)
  });

  it('derives isOwner and resolves ownerName only for ACCOUNT owners (anon owners have no directory row)', async () => {
    const me = newUserId();
    const accountOwner = newUserId();
    const anonOwner = newUserId();
    await db()
      .insert(users)
      .values({ userId: accountOwner, googleSub: `sub-${accountOwner}`, email: 'o@example.com', name: 'Owner Name', createdAt: 1 });
    const [mine, theirs, anons] = [newRoomId(), newRoomId(), newRoomId()];
    await seedRoom(mine, me);
    await seedRoom(theirs, accountOwner);
    await seedRoom(anons, anonOwner);
    await seedVisit(me, mine, 3);
    await seedVisit(me, theirs, 2);
    await seedVisit(me, anons, 1);

    const { body } = await listFor(me);
    const byId = new Map(body.rooms.map((r) => [r.roomId, r]));
    expect(byId.get(mine)).toMatchObject({ isOwner: true, ownerName: null }); // anon me — no users row either
    expect(byId.get(theirs)).toMatchObject({ isOwner: false, ownerName: 'Owner Name' });
    expect(byId.get(anons)).toMatchObject({ isOwner: false, ownerName: null });
  });

  it('redacts private rooms the caller does not own — but keeps the row (the prune signal) and createdAt', async () => {
    const me = newUserId();
    const owner = newUserId();
    await db()
      .insert(users)
      .values({ userId: owner, googleSub: `sub-${owner}`, email: 'p@example.com', name: 'Private Owner', createdAt: 1 });
    const [theirPrivate, myPrivate] = [newRoomId(), newRoomId()];
    await seedRoom(theirPrivate, owner, { permission: 'private', title: 'Secret Plans', createdAt: 777 });
    await seedRoom(myPrivate, me, { permission: 'private', title: 'My Own Secret' });
    await seedVisit(me, theirPrivate, 2);
    await seedVisit(me, myPrivate, 1);

    const { body } = await listFor(me);
    const byId = new Map(body.rooms.map((r) => [r.roomId, r]));
    // Redacted: a denied past visitor can't read post-privatization titles or the owner…
    expect(byId.get(theirPrivate)).toMatchObject({ title: '', ownerName: null, permission: 'private', isOwner: false, createdAt: 777 });
    // …while the caller's OWN private room stays fully visible.
    expect(byId.get(myPrivate)).toMatchObject({ title: 'My Own Secret', isOwner: true });
  });

  it('rides the D1 session bookmark out (header + body agree) and accepts it back on the next read', async () => {
    // Monotonic-read SEMANTICS aren't observable locally — Miniflare's D1 has no replica
    // lag, so every read serves latest regardless of bookmark. What this pins is the wire
    // contract the client depends on: bookmark surfaced in both channels, and a request
    // carrying one still 200s with the same projection.
    const me = newUserId();
    const room = newRoomId();
    await seedRoom(room, me);
    await seedVisit(me, room, 1);

    const first = await listFor(me);
    expect(first.body.bookmark).not.toBe(''); // a REAL bookmark rode out — '' would make the header/body agreement vacuous
    expect(first.res.headers.get('x-d1-bookmark')).toBe(first.body.bookmark);

    const second = await listFor(me, { 'x-d1-bookmark': first.body.bookmark });
    expect(second.res.status).toBe(200);
    expect(second.body.rooms.map((r) => r.roomId)).toEqual([room]);
  });
});
