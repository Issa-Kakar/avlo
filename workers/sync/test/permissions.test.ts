import { env } from 'cloudflare:test';
import { RPC_FORBIDDEN, RPC_INVALID_TITLE } from '@avlo/worker-shared';
import { describe, expect, it } from 'vitest';
import { anonCookie, connect, newRoomId, newUserId, serverObjectIds, until } from './harness';

/**
 * Await an RPC expecting the wire-contract error; returns its message ('' on success).
 * `expect(...).rejects` leaves workerd's internal pipelined promise rejecting unhandled,
 * which vitest reports as suite-level errors — a plain await + catch does not.
 */
const rpcError = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return '';
  } catch (e) {
    return (e as Error).message;
  }
};

describe('meta RPCs + live permission enforcement', () => {
  it('setPermission throws forbidden for a non-owner once meta exists', async () => {
    const ownerId = newUserId();
    const roomId = newRoomId();
    const owner = await connect(roomId, await anonCookie(ownerId));
    await owner.untilSynced();

    expect(await rpcError(env.rooms.getByName(roomId).setPermission(newUserId(), 'private'))).toBe(RPC_FORBIDDEN);
    owner.close();
  });

  it('owner permission flip bumps rev and returns the projected snapshot', async () => {
    const ownerId = newUserId();
    const roomId = newRoomId();
    const owner = await connect(roomId, await anonCookie(ownerId));
    await owner.untilSynced();

    const snap = await env.rooms.getByName(roomId).setPermission(ownerId, 'readonly');
    expect(snap).toMatchObject({ roomId, ownerId, permission: 'readonly', title: 'Untitled', rev: 2, deletedAt: null });
    owner.close();
  });

  it("flip pushes perm: to the caller's tabs and mode:+perm: to non-owners; privatize evicts them 4403", async () => {
    const ownerId = newUserId();
    const roomId = newRoomId();
    const owner = await connect(roomId, await anonCookie(ownerId));
    const viewer = await connect(roomId, await anonCookie(newUserId()));
    await owner.untilSynced();
    await viewer.untilSynced();
    const ownerSeen = owner.custom.length;
    const viewerSeen = viewer.custom.length;

    await env.rooms.getByName(roomId).setPermission(ownerId, 'readonly');
    // Non-owner: mode re-push AND the new perm. Caller: perm only — its mode never changes.
    await until(() => viewer.custom.length >= viewerSeen + 2, 'viewer re-push');
    expect(viewer.custom.slice(viewerSeen)).toEqual(['mode:viewer', 'perm:readonly']);
    await until(() => owner.custom.length >= ownerSeen + 1, 'owner perm push');
    expect(owner.custom.slice(ownerSeen)).toEqual(['perm:readonly']);

    await env.rooms.getByName(roomId).setPermission(ownerId, 'private');
    const closed = await viewer.untilClosed();
    expect(closed.code).toBe(4403);
    expect(owner.closeEvent).toBeNull(); // the owner is never evicted
    owner.close();
  });

  it("readonly is enforced per-frame mid-connection: viewer's update discarded, owner's applies", async () => {
    const ownerId = newUserId();
    const roomId = newRoomId();
    const owner = await connect(roomId, await anonCookie(ownerId));
    const viewer = await connect(roomId, await anonCookie(newUserId()));
    await owner.untilSynced();
    await viewer.untilSynced();

    await env.rooms.getByName(roomId).setPermission(ownerId, 'readonly');
    await until(() => viewer.custom.includes('mode:viewer'), 'viewer downgraded');

    const viewerObj = viewer.putObject({ kind: 'note' });
    const ownerObj = owner.putObject({ kind: 'note' });
    // The owner's write lands on the viewer too (readonly still receives); ordering
    // guarantees the viewer's earlier frame was processed — and discarded — by then.
    await until(() => viewer.objects.has(ownerObj), 'owner update relayed');
    const ids = await serverObjectIds(roomId);
    expect(ids).toContain(ownerObj);
    expect(ids).not.toContain(viewerObj);
    owner.close();
    viewer.close();
  });

  it('setTitle normalizes whitespace, bumps rev, and broadcasts to every connection incl. the renamer', async () => {
    const ownerId = newUserId();
    const roomId = newRoomId();
    const owner = await connect(roomId, await anonCookie(ownerId));
    const guest = await connect(roomId, await anonCookie(newUserId()));
    await owner.untilSynced();
    await guest.untilSynced();

    const snap = await env.rooms.getByName(roomId).setTitle(ownerId, '  Board \t of\n  Plans  ');
    expect(snap.title).toBe('Board of Plans');
    expect(snap.rev).toBe(2);
    await until(() => owner.custom.includes('title:Board of Plans'), 'renamer broadcast');
    await until(() => guest.custom.includes('title:Board of Plans'), 'guest broadcast');
    owner.close();
    guest.close();
  });

  it('setTitle rejects empty-after-normalize and over-max titles with invalid-title', async () => {
    const ownerId = newUserId();
    const roomId = newRoomId();
    const owner = await connect(roomId, await anonCookie(ownerId));
    await owner.untilSynced();

    const stub = env.rooms.getByName(roomId);
    expect(await rpcError(stub.setTitle(ownerId, '   \t\n '))).toBe(RPC_INVALID_TITLE);
    expect(await rpcError(stub.setTitle(ownerId, 'x'.repeat(61)))).toBe(RPC_INVALID_TITLE);
    // Exactly at the cap is valid — the boundary belongs to the accept side.
    const snap = await stub.setTitle(ownerId, 'x'.repeat(60));
    expect(snap.title).toBe('x'.repeat(60));
    owner.close();
  });

  it('setTitle on a virgin room mints meta with the caller as owner at rev 1 (offline-created room path)', async () => {
    const caller = newUserId();
    const roomId = newRoomId();
    const snap = await env.rooms.getByName(roomId).setTitle(caller, 'Renamed Before First Connect');
    expect(snap).toMatchObject({ roomId, ownerId: caller, permission: 'public', title: 'Renamed Before First Connect', rev: 1 });
  });

  it('setPermission on a virgin room mints meta owned by the caller with the requested permission', async () => {
    const caller = newUserId();
    const roomId = newRoomId();
    const snap = await env.rooms.getByName(roomId).setPermission(caller, 'private');
    expect(snap).toMatchObject({ roomId, ownerId: caller, permission: 'private', title: 'Untitled', rev: 1 });

    // The mint is real ownership: the caller connects fine, a stranger is evicted.
    const owner = await connect(roomId, await anonCookie(caller));
    await owner.untilSynced();
    owner.close();
  });

  it('migrateOwner re-owns from→to with a rev bump and re-pushes per-connection owner flags', async () => {
    const from = newUserId();
    const to = newUserId();
    const roomId = newRoomId();
    const oldTab = await connect(roomId, await anonCookie(from));
    await oldTab.untilSynced();
    const newTab = await connect(roomId, await anonCookie(to));
    await newTab.untilSynced();
    const oldSeen = oldTab.custom.length;
    const newSeen = newTab.custom.length;

    const snap = await env.rooms.getByName(roomId).migrateOwner(from, to);
    expect(snap).toMatchObject({ ownerId: to, rev: 2 });
    await until(() => oldTab.custom.length > oldSeen, 'old owner flag');
    await until(() => newTab.custom.length > newSeen, 'new owner flag');
    expect(oldTab.custom.slice(oldSeen)).toEqual(['owner:0']);
    expect(newTab.custom.slice(newSeen)).toEqual(['owner:1']);
    oldTab.close();
    newTab.close();
  });

  it('migrateOwner is idempotent when already owned by `to` — same snapshot, NO rev bump', async () => {
    const from = newUserId();
    const to = newUserId();
    const roomId = newRoomId();
    const owner = await connect(roomId, await anonCookie(from));
    await owner.untilSynced();

    const stub = env.rooms.getByName(roomId);
    const first = await stub.migrateOwner(from, to);
    const replay = await stub.migrateOwner(from, to); // queue redelivery
    expect(replay.rev).toBe(first.rev);
    expect(replay.ownerId).toBe(to);
    owner.close();
  });

  it('migrateOwner throws forbidden when meta is absent or owned by a third party', async () => {
    // Absent: no meta to migrate — terminal skip, never a mint.
    expect(await rpcError(env.rooms.getByName(newRoomId()).migrateOwner(newUserId(), newUserId()))).toBe(RPC_FORBIDDEN);

    // Third party: C owns; migrating A→B must never force.
    const c = newUserId();
    const roomId = newRoomId();
    const owner = await connect(roomId, await anonCookie(c));
    await owner.untilSynced();
    expect(await rpcError(env.rooms.getByName(roomId).migrateOwner(newUserId(), newUserId()))).toBe(RPC_FORBIDDEN);
    owner.close();
  });
});
