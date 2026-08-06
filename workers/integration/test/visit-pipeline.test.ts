/**
 * The full visit pipeline across real seams: WS connect (real Origin guard + real
 * AuthRpc cookie verification) → DO mints meta + enqueues VisitEvent/MetaEvent → the
 * REAL queue broker delivers to the users consumer (1 s batch windows) → D1 projection
 * → GET /rooms shows ownership. Nothing in this file is mocked or driven by hand.
 */
import { describe, expect, it } from 'vitest';
import { anonCookie, createAvloHarness, d1RoomRow, d1VisitRow, newRoomId, newUserId, until, usersEnv, wsConnect } from './harness';

const server = createAvloHarness();

describe('visit pipeline (sync → queues → users → D1 → dashboard)', () => {
  it('a first connect mints the room and lands visit + meta in D1 through the real queue broker', async () => {
    const user = newUserId();
    const roomId = newRoomId();
    const client = await wsConnect(server, roomId, await anonCookie(user));
    await client.untilSynced();
    await client.untilCustom('owner:1'); // the DO saw the COOKIE identity and minted us as owner

    // Real delivery: visits + meta consumers run on 1 s max_batch_timeout.
    const env = await usersEnv(server);
    await until(async () => (await d1VisitRow(env, user, roomId)) !== null, 'visit row projected', 20000);
    const room = await until(async () => await d1RoomRow(env, roomId), 'rooms row projected', 20000);
    expect(room).toMatchObject({ owner_id: user, permission: 'public', title: 'Untitled', rev: 1 });

    // The dashboard read reflects it — cookie-authenticated through the real AUTH seam.
    const res = await server.getWorker('avlo-users').fetch('https://users.avlo.io/rooms', { headers: { Cookie: await anonCookie(user) } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rooms: Array<Record<string, unknown>> };
    const entry = body.rooms.find((r) => r.roomId === roomId);
    expect(entry).toMatchObject({ isOwner: true, title: 'Untitled', permission: 'public' });

    client.close();
  });

  it('a doc update relays between two live clients across the harness (real WS, real DO)', async () => {
    const owner = newUserId();
    const roomId = newRoomId();
    const a = await wsConnect(server, roomId, await anonCookie(owner));
    await a.untilSynced();
    const b = await wsConnect(server, roomId, await anonCookie(newUserId()));
    await b.untilSynced();

    const id = a.putObject({ kind: 'shape', frame: [0, 0, 10, 10] });
    await until(() => b.objects.has(id), 'update relayed to b');
    expect(b.objects.get(id)?.get('kind')).toBe('shape');

    a.close();
    b.close();
  });
});
