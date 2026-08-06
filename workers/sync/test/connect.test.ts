import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { anonCookie, connect, newRoomId, newUserId, rawSocket, readMeta, until, upgrade } from './harness';

// NOT covered here, deliberately: partyserver's optional `?_pk` connection-id param.
// The AVLO provider never sends one (y-partyserver assigns ids server-side), so a
// collision characterization would pin third-party behavior no code path reaches.

describe('connect flow', () => {
  it('closes 4401 before any sync frame when no identity resolves', async () => {
    // The DO must deny BEFORE super.onConnect — an unauthenticated socket must never
    // see a syncStep1 (doc state) frame.
    const raw = rawSocket(await upgrade(newRoomId(), {}));
    expect(await raw.untilClosed()).toBe(4401);
    expect(raw.binaryFrames()).toBe(0);
  });

  it('mints the meta row on first authorized connect: rev 1, createdAt stamped, no tombstone (row facts with no wire observable)', async () => {
    // Ownership/title/permission of the mint are wire-proven by the boot-push tests
    // below (owner:1/title:Untitled/perm:public); this pins only the row-only facts.
    const owner = newUserId();
    const roomId = newRoomId();
    const client = await connect(roomId, await anonCookie(owner));
    await client.untilSynced();

    const meta = await readMeta(roomId);
    expect(meta).toMatchObject({ roomId, rev: 1, deletedAt: null });
    expect(typeof meta?.createdAt).toBe('number');
    client.close();
  });

  it('pushes mode/title/owner/perm custom messages, in that order, on boot', async () => {
    const roomId = newRoomId();
    const client = await connect(roomId, await anonCookie(newUserId()));
    await until(() => client.custom.length >= 4, 'boot pushes');
    expect(client.custom.slice(0, 4)).toEqual(['mode:editor', 'title:Untitled', 'owner:1', 'perm:public']);
    client.close();
  });

  it('tells a non-owner on a public room owner:0 and mode:editor', async () => {
    const roomId = newRoomId();
    const owner = await connect(roomId, await anonCookie(newUserId()));
    await owner.untilSynced();

    const guest = await connect(roomId, await anonCookie(newUserId()));
    await until(() => guest.custom.length >= 4, 'guest boot pushes');
    expect(guest.custom.slice(0, 4)).toEqual(['mode:editor', 'title:Untitled', 'owner:0', 'perm:public']);
    owner.close();
    guest.close();
  });

  it('closes 4403 (no sync frame) for a non-owner on a private room', async () => {
    const ownerId = newUserId();
    const roomId = newRoomId();
    const owner = await connect(roomId, await anonCookie(ownerId));
    await owner.untilSynced();
    await env.rooms.getByName(roomId).setPermission(ownerId, 'private');

    const raw = rawSocket(await upgrade(roomId, { cookie: await anonCookie(newUserId()) }));
    expect(await raw.untilClosed()).toBe(4403);
    expect(raw.binaryFrames()).toBe(0);
    owner.close();
  });

  it('relays doc updates between two live clients, both directions', async () => {
    const roomId = newRoomId();
    const a = await connect(roomId, await anonCookie(newUserId()));
    const b = await connect(roomId, await anonCookie(newUserId()));
    await a.untilSynced();
    await b.untilSynced();

    const fromA = a.putObject({ kind: 'note', from: 'a' });
    await until(() => b.objects.has(fromA), 'A→B relay');
    expect(b.objects.get(fromA)?.get('from')).toBe('a');

    const fromB = b.putObject({ kind: 'note', from: 'b' });
    await until(() => a.objects.has(fromB), 'B→A relay');
    expect(a.objects.get(fromB)?.get('from')).toBe('b');
    a.close();
    b.close();
  });

  it('hydrates a late joiner with state created before it connected', async () => {
    const roomId = newRoomId();
    const a = await connect(roomId, await anonCookie(newUserId()));
    await a.untilSynced();
    const id = a.putObject({ kind: 'shape' });

    const late = await connect(roomId, await anonCookie(newUserId()));
    await late.untilSynced();
    await until(() => late.objects.has(id), 'late-join hydration');
    expect(late.objects.get(id)?.get('kind')).toBe('shape'); // content, not just key presence
    a.close();
    late.close();
  });
});
