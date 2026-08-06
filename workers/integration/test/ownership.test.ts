/**
 * Ownership + permission across the users→sync seam, un-mocked: the PATCH handler's
 * cross-script DO RPC, the DO's rev-guarded authority (read back via real DO storage
 * SQL), the RYW direct D1 write, and — the previously pool-unreachable case — a REAL
 * `forbidden` wire error thrown by the DO into the queue consumer, delivered by the
 * real broker (the pool suites must simulate this verdict; here there is no pool
 * teardown to wedge).
 */
import { describe, expect, it } from 'vitest';
import { anonCookie, createAvloHarness, d1RoomRow, doMetaRow, newRoomId, newUserId, until, usersEnv, wsConnect } from './harness';

const server = createAvloHarness();

async function mintRoom(owner: string): Promise<string> {
  const roomId = newRoomId();
  const client = await wsConnect(server, roomId, await anonCookie(owner));
  await client.untilSynced();
  await client.untilCustom('owner:1');
  client.close();
  return roomId;
}

function patchPermission(roomId: string, cookie: string, permission: string) {
  return server.getWorker('avlo-users').fetch(`https://users.avlo.io/rooms/${roomId}/permission`, {
    method: 'PATCH',
    headers: { Cookie: cookie, 'Content-Type': 'application/json', Origin: 'https://avlo.io' },
    body: JSON.stringify({ permission }),
  });
}

describe('PATCH /rooms/:id/permission — the cross-script DO seam', () => {
  it('owner PATCH flows handler → DO RPC → rev bump (DO storage truth) → RYW D1 write', async () => {
    const owner = newUserId();
    const roomId = await mintRoom(owner);

    const res = await patchPermission(roomId, await anonCookie(owner), 'private');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; bookmark: string };
    expect(body.ok).toBe(true);
    expect(body.bookmark).not.toBe(''); // the RYW direct write really happened

    const meta = await doMetaRow(server, roomId); // the AUTHORITY — DO SQLite, not a projection
    expect(meta).toMatchObject({ owner_id: owner, permission: 'private', rev: 2 });
    const room = await d1RoomRow(await usersEnv(server), roomId); // the RYW projection
    expect(room).toMatchObject({ permission: 'private', rev: 2 });
  });

  it('non-owner PATCH gets the DO-thrown forbidden as a 403 and moves nothing', async () => {
    const owner = newUserId();
    const roomId = await mintRoom(owner);

    const res = await patchPermission(roomId, await anonCookie(newUserId()), 'private');
    expect(res.status).toBe(403);

    const meta = await doMetaRow(server, roomId);
    expect(meta).toMatchObject({ owner_id: owner, permission: 'public', rev: 1 });
  });
});

describe('migrate queue — a REAL forbidden verdict from the real DO', () => {
  it('a third-party-owned room is terminally skipped: acked, never retried, owner untouched', async () => {
    const thirdParty = newUserId();
    const roomId = await mintRoom(thirdParty);
    const from = newUserId(); // NOT the owner — migrateOwner must throw forbidden
    const to = newUserId();

    const env = await usersEnv(server);
    server.clearLogs();
    await env.ROOM_MIGRATE.send({ roomId, from, to });

    // Real delivery: migrate batches on a 5 s max_batch_timeout. The consumer's
    // always-on heartbeat is the delivery marker; rows=0 = nothing migrated.
    const heartbeat = await until(
      () => server.getLogs().find((l) => String(l.message).includes('[queue] avlo-room-migrate')),
      'migrate heartbeat',
      30000,
    );
    expect(String(heartbeat?.message)).toContain('rows=0');

    // State first: the DO authority and the D1 projection both untouched.
    const meta = await doMetaRow(server, roomId);
    expect(meta).toMatchObject({ owner_id: thirdParty, rev: 1 });
    const room = await until(async () => await d1RoomRow(env, roomId), 'rooms row (from the mint meta event)', 20000);
    expect(room).toMatchObject({ owner_id: thirdParty, rev: 1 });

    // Terminal-skip proof: exactly one delivery (no retry heartbeat) and no failure log.
    const logs = server.getLogs().map((l) => String(l.message));
    expect(logs.filter((m) => m.includes('[queue] avlo-room-migrate'))).toHaveLength(1);
    expect(logs.filter((m) => m.includes('migrate consume failed'))).toHaveLength(0);
  });
});
