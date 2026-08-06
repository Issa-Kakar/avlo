import { env, evictDurableObject, runInDurableObject } from 'cloudflare:test';
import type { UserId } from '@avlo/shared';
import { describe, expect, it } from 'vitest';
import type { AvloDO } from '../src/room';
import { anonCookie, connect, emptyUpdateFrame, newRoomId, newUserId, serverObjectIds, until } from './harness';

/**
 * Real hibernation coverage via `evictDurableObject`: the instance is torn down (in-memory
 * state gone) while hibernatable sockets survive in the runtime, so the next frame re-runs
 * the constructor (migrate + meta reload) and lands in `webSocketMessage` on a fresh
 * instance. This is the exact prod wake path — not a simulation.
 */
describe('hibernation', () => {
  it('hibernated sockets survive eviction: a frame wakes a fresh instance and relays; awareness ids intact', async () => {
    const ownerId = newUserId();
    const guestId = newUserId();
    const roomId = newRoomId();
    const owner = await connect(roomId, await anonCookie(ownerId));
    const guest = await connect(roomId, await anonCookie(guestId));
    await owner.untilSynced();
    await guest.untilSynced();

    // Pre-evict traffic: a doc object and an awareness state (so the connection's
    // __ypsAwarenessIds attachment is non-empty going into hibernation).
    const preEvict = owner.putObject({ kind: 'note', phase: 'before' });
    const awarenessId = owner.sendAwareness({ cursor: [1, 2] });
    await until(() => guest.objects.has(preEvict), 'pre-evict relay');

    // NB: eviction's drain politely waits out the pending 5 s save debounce the doc update
    // scheduled (the drained save IS the persistence — no manual onSave() needed), so this
    // test legitimately takes ~5 s; hence the raised timeout.
    const stub = env.rooms.getByName(roomId);
    await evictDurableObject(stub); // default: webSockets 'hibernate'

    // The wake: a client frame (no RPC first — webSocketMessage must be the re-entry).
    const postEvict = owner.putObject({ kind: 'note', phase: 'after' });
    await until(() => guest.objects.has(postEvict), 'post-wake relay');
    expect(owner.closeEvent).toBeNull();
    expect(guest.closeEvent).toBeNull();

    // The fresh instance rehydrated from R2 (pre-evict object present server-side), and
    // rehydrated connections carry y-partyserver's awareness ids (the setState-ordering
    // regression) — genuinely unobservable from a client, hence the white-box read.
    // (conn.state.userId survival is behaviorally proven by the readonly/owner test below.)
    const serverIds = await serverObjectIds(roomId);
    expect(serverIds).toContain(preEvict);
    expect(serverIds).toContain(postEvict);
    const awarenessIds = await runInDurableObject(stub, (instance: AvloDO) => {
      const ids: number[] = [];
      for (const conn of instance.getConnections<{ __ypsAwarenessIds?: number[] }>()) ids.push(...(conn.state?.__ypsAwarenessIds ?? []));
      return ids;
    });
    expect(awarenessIds).toContain(awarenessId);
    owner.close();
    guest.close();
  }, 20000);

  it('meta reloads in the constructor on wake: readonly still distinguishes owner from viewer by attachment identity', async () => {
    const ownerId = newUserId();
    const roomId = newRoomId();
    const owner = await connect(roomId, await anonCookie(ownerId));
    const viewer = await connect(roomId, await anonCookie(newUserId()));
    await owner.untilSynced();
    await viewer.untilSynced();
    const stub = env.rooms.getByName(roomId);
    await stub.setPermission(ownerId, 'readonly');
    await until(() => viewer.custom.includes('mode:viewer'), 'viewer downgraded');

    await evictDurableObject(stub);

    // First frames after eviction hit the woken instance. isReadOnly() = constructor-loaded
    // meta × attachment-restored conn.state.userId — both must have survived for the split
    // verdict below.
    const viewerObj = viewer.putObject({ kind: 'note' });
    const ownerObj = owner.putObject({ kind: 'note' });
    await until(() => viewer.objects.has(ownerObj), 'owner update relayed post-wake');
    const ids = await serverObjectIds(roomId);
    expect(ids).toContain(ownerObj);
    expect(ids).not.toContain(viewerObj);
    owner.close();
    viewer.close();
  }, 20000); // eviction drains a pending y-partyserver save debounce (~5 s) when a doc write preceded it

  it('refreshes the limiter budget on a frame-driven wake: pre-evict spend dies with the instance', async () => {
    // RateState and #boot are in-memory only — hibernation must not carry a half-spent
    // window into the woken instance (a reconnect storm after a long sleep would
    // otherwise inherit stale budgets). 150+150 with the eviction between them stays
    // open; the same 300 on one live instance would close at 201 (rate-limit suite).
    const userId = newUserId();
    const roomId = newRoomId();
    const client = await connect(roomId, await anonCookie(userId));
    const observer = await connect(roomId, await anonCookie(newUserId()));
    await client.untilSynced();
    await observer.untilSynced();
    const stub = env.rooms.getByName(roomId);

    const spend = (n: number) =>
      runInDurableObject(stub, (instance: AvloDO) => {
        const conn = [...instance.getConnections<{ userId: UserId }>()].find((c) => c.state?.userId === userId);
        if (!conn) throw new Error('connection not found in DO');
        const frame = emptyUpdateFrame();
        for (let i = 0; i < n; i++) instance.onMessage(conn, frame);
        return conn.readyState;
      });

    await spend(150);
    await evictDurableObject(stub); // hibernate sockets; in-memory limiter state dies

    // Wake via a real client frame (webSocketMessage is the re-entry, as in prod —
    // observed through the relay to the second client), THEN spend against the budget
    // the frame-woken instance minted. The wake frame itself counts 1 against it.
    const wake = client.putObject({ kind: 'note' });
    await until(() => observer.objects.has(wake), 'frame-driven wake relay');

    const readyStateAfter = await spend(150);
    expect(readyStateAfter).toBe(1); // still OPEN — the woken instance started a fresh budget
    expect(client.closeEvent).toBeNull();
    client.close();
    observer.close();
  }, 20000); // eviction drains a pending y-partyserver save debounce (~5 s) when a doc write preceded it

  it("evictDurableObject({webSockets:'close'}) closes the clients instead of hibernating them", async () => {
    const roomId = newRoomId();
    const a = await connect(roomId, await anonCookie(newUserId()));
    const b = await connect(roomId, await anonCookie(newUserId()));
    await a.untilSynced();
    await b.untilSynced();

    await evictDurableObject(env.rooms.getByName(roomId), { webSockets: 'close' });
    await a.untilClosed();
    await b.untilClosed();
    expect(a.closeEvent).not.toBeNull();
    expect(b.closeEvent).not.toBeNull();
  }, 20000); // eviction drains a pending y-partyserver save debounce (~5 s) when a doc write preceded it
});
