import { createMessageBatch, env } from 'cloudflare:test';
import { MetaEvent, RPC_FORBIDDEN } from '@avlo/worker-shared';
import { describe, expect, it } from 'vitest';
import { consumeBatch, deadRoomsNamespace, hit, mintRoom, msg, newRoomId, newUserId, patch, roomRow, roomsNs } from './harness';

/**
 * The cross-worker permission seam: PATCH → cross-script RPC into the REAL AvloDO (aux
 * sync worker) → rev-guarded read-your-writes D1 mirror. The DO is the authority; D1 is
 * display-only projection.
 */
describe('PATCH /rooms/:id/{permission,title}', () => {
  it('flips permission as the owner: 200, DO rev bump, RYW row in D1, bookmark out', async () => {
    const owner = newUserId();
    const roomId = newRoomId();
    await mintRoom(roomId, owner);

    const res = await patch(`/rooms/${roomId}/permission`, { permission: 'readonly' }, { user: owner });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; bookmark: string };
    expect(body.ok).toBe(true);
    expect(body.bookmark).not.toBe(''); // a real RYW bookmark, not the failed-direct-write '' fallback
    expect(res.headers.get('x-d1-bookmark')).toBe(body.bookmark);

    // The RYW direct write — visible immediately, no queue wait.
    expect(await roomRow(roomId)).toMatchObject({ ownerId: owner, permission: 'readonly', rev: 2 });
  });

  it('403s a non-owner with the DO wire-contract error — D1 stays at the authority state', async () => {
    const owner = newUserId();
    const roomId = newRoomId();
    await mintRoom(roomId, owner);

    const res = await patch(`/rooms/${roomId}/permission`, { permission: 'private' }, { user: newUserId() });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: RPC_FORBIDDEN });

    // The DO authority is untouched: the real owner's next flip lands at rev 2 (a leaked
    // write from the forbidden attempt would have bumped it past that). (No-projection
    // proof through the queue path belongs to the integration suite — consumers stripped here.)
    const ownerRes = await patch(`/rooms/${roomId}/permission`, { permission: 'readonly' }, { user: owner });
    expect(ownerRes.status).toBe(200);
    expect(await roomRow(roomId)).toMatchObject({ ownerId: owner, permission: 'readonly', rev: 2 });
  });

  it('renames as the owner: normalized title back, broadcast + D1 mirror', async () => {
    const owner = newUserId();
    const roomId = newRoomId();
    await mintRoom(roomId, owner);

    const res = await patch(`/rooms/${roomId}/title`, { title: '  Spaced \t Out  ' }, { user: owner });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { title: string }).title).toBe('Spaced Out');
    expect((await roomRow(roomId))?.title).toBe('Spaced Out');
  });

  it('400s an invalid title at the validator (whitespace-only, over-max) and an invalid room id', async () => {
    const owner = newUserId();
    const roomId = newRoomId();
    await mintRoom(roomId, owner);

    expect((await patch(`/rooms/${roomId}/title`, { title: '   ' }, { user: owner })).status).toBe(400);
    expect((await patch(`/rooms/${roomId}/title`, { title: 'x'.repeat(300) }, { user: owner })).status).toBe(400);
    expect((await patch('/rooms/not-a-room-id!/title', { title: 'ok' }, { user: owner })).status).toBe(400);
  });

  it('CHARACTERIZED: a PATCH on a virgin room id MINTS DO meta owned by the caller (DO authority, not 404)', async () => {
    const caller = newUserId();
    const roomId = newRoomId();
    const res = await patch(`/rooms/${roomId}/permission`, { permission: 'private' }, { user: caller });
    expect(res.status).toBe(200);
    expect(await roomRow(roomId)).toMatchObject({ ownerId: caller, permission: 'private', rev: 1 });

    // The mint is real DO ownership: a different caller is now forbidden.
    const other = await patch(`/rooms/${roomId}/title`, { title: 'Mine Now' }, { user: newUserId() });
    expect(other.status).toBe(403);
  });

  it('rev-guards the projection: stale and equal-rev queue replays after the direct write are no-ops', async () => {
    const owner = newUserId();
    const roomId = newRoomId();
    const mint = await mintRoom(roomId, owner);
    await patch(`/rooms/${roomId}/title`, { title: 'Current Truth' }, { user: owner }); // rev 2 via RYW

    // A late redelivery of the MINT event (rev 1) — and a double-write of rev 2 with a
    // conflicting payload — must both fail `excluded.rev >` and change nothing.
    const stale = { ...mint, title: 'Stale Mint Replay' };
    const equal = { ...mint, rev: 2, title: 'Equal Rev Fork' };
    const batch = createMessageBatch('avlo-room-meta', [msg(MetaEvent.parse(stale)), msg(MetaEvent.parse(equal))]);
    const result = await consumeBatch(batch);
    expect(result.ackAll).toBe(true);
    expect(await roomRow(roomId)).toMatchObject({ title: 'Current Truth', rev: 2 });
  });

  it('403s cross-site form PATCHes via csrf BEFORE auth ever runs (json content-type bypasses)', async () => {
    const owner = newUserId();
    const roomId = newRoomId();
    await mintRoom(roomId, owner);

    const csrfd = await hit(
      `/rooms/${roomId}/title`,
      {
        method: 'PATCH',
        body: 'title=evil',
        headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://evil.example' },
      },
      { user: owner },
    );
    expect(csrfd.status).toBe(403);
    // The DO's rev proves the blocked request never reached the authority: mint was rev 1,
    // so this legit rename lands at rev 2 — no interleaved write happened.
    const snap = await roomsNs.getByName(roomId).setTitle(owner, 'After Csrf');
    expect(snap.rev).toBe(2);
  });

  it('maps a transport-dead DO to 500 internal (client-retryable), never a fake 403/400', async () => {
    const owner = newUserId();
    const roomId = newRoomId();
    await mintRoom(roomId, owner);
    const deadRooms = deadRoomsNamespace(new Error('rpc transport lost'));

    const res = await patch(`/rooms/${roomId}/title`, { title: 'Never Lands' }, { user: owner, env: { ...env, rooms: deadRooms } });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'internal' });
  });
});
