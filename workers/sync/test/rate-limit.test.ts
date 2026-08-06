import { env, runInDurableObject } from 'cloudflare:test';
import type { UserId } from '@avlo/shared';
import { describe, expect, it } from 'vitest';
import type { AvloDO } from '../src/room';
import { anonCookie, awarenessFrame, connect, emptyUpdateFrame, newRoomId, newUserId, until } from './harness';

/**
 * Tier-3 WS message limiter (SYNC_BUDGET 200/s → close 1008; AWARE_BUDGET 400/s → drop).
 * Both floods are injected synchronously at the gate (same-isolate runInDurableObject) —
 * the local WS transport processes frames slower than the budgets, so a wire flood can
 * spread across 3+ one-second windows on a loaded machine and never trip a window at
 * all (this exact test hung that way twice before the rewrite). The wire path stays
 * untested here; connect/hibernation cover delivery, this file covers the gate.
 */
/** Mirrors SYNC_BUDGET in src/room.ts (module-private there — keep in lockstep). */
const SYNC_BUDGET = 200;
/** Handshake sync frames already counted in the window (client syncStep1 + its syncStep2 reply ≤ 4). */
const HANDSHAKE_FRAMES = 4;

describe('WS rate limiter', () => {
  it('closes 1008 the moment sync frames exceed budget — never before, never later than one window straddle', async () => {
    const senderId = newUserId();
    const roomId = newRoomId();
    const client = await connect(roomId, await anonCookie(senderId));
    await client.untilSynced();

    await runInDurableObject(env.rooms.getByName(roomId), (instance: AvloDO) => {
      const conn = [...instance.getConnections<{ userId: UserId }>()].find((c) => c.state?.userId === senderId);
      if (!conn) throw new Error('sender connection not found in DO');
      const frame = emptyUpdateFrame();
      // Feed the gate until IT closes the socket (readyState leaves OPEN). The cap only
      // bounds a broken gate; the straddle assertion below carries the "never later" claim.
      let sent = 0;
      while (conn.readyState === 1 /* OPEN */ && sent < 3 * SYNC_BUDGET) {
        instance.onMessage(conn, frame);
        sent++;
      }
      // Close lands at budget+1 counted frames. The connect handshake already counted
      // ≤HANDSHAKE_FRAMES against this window, so the flood's share is budget+1 minus
      // those — never materially early, never at the budget itself. The sub-ms loop can
      // straddle at most one window boundary, so one full budget plus budget+1 is the
      // hard upper bound on sends before CLOSE.
      expect(sent).toBeGreaterThan(SYNC_BUDGET - HANDSHAKE_FRAMES);
      expect(sent).toBeLessThanOrEqual(2 * SYNC_BUDGET + 1); // never later than one window straddle
      expect(conn.readyState).not.toBe(1); // the gate, not the loop cap, ended the flood
    });

    const closed = await client.untilClosed();
    expect(closed.code).toBe(1008);
    expect(closed.reason).toBe('sync rate');
  });

  it('drops over-budget awareness frames WITHOUT closing — the connection stays usable', async () => {
    const senderId = newUserId();
    const roomId = newRoomId();
    const sender = await connect(roomId, await anonCookie(senderId));
    const receiver = await connect(roomId, await anonCookie(newUserId()));
    await sender.untilSynced();
    await receiver.untilSynced();

    // The local WS transport tops out under the 400/s budget, so a wire flood can never
    // trip the window. Inject the frames synchronously at the gate instead (same-isolate
    // runInDurableObject): 1000 same-window frames ⇒ ≥200 MUST drop.
    const SENT = 1000;
    await runInDurableObject(env.rooms.getByName(roomId), (instance: AvloDO) => {
      const conn = [...instance.getConnections<{ userId: UserId }>()].find((c) => c.state?.userId === senderId);
      if (!conn) throw new Error('sender connection not found in DO');
      const frame = awarenessFrame();
      for (let i = 0; i < SENT; i++) instance.onMessage(conn, frame);
    });
    // Ordered delivery: once the sentinel sync update lands on the receiver, every
    // NON-dropped awareness broadcast sent before it has landed too.
    const sentinel = sender.putObject({ kind: 'note' });
    await until(() => receiver.objects.has(sentinel), 'sentinel after flood', 10000);

    expect(receiver.awarenessFrames).toBeLessThan(SENT);
    expect(receiver.awarenessFrames).toBeGreaterThan(0); // under-budget frames DID broadcast
    expect(sender.closeEvent).toBeNull(); // dropped, never closed
    sender.close();
    receiver.close();
  }, 15000);

  it('CHARACTERIZED: strings bypass the limiter entirely — a __YPS:/garbage string flood is uncounted', async () => {
    // The gate classifies by leading varuint on BINARY frames only; strings short-circuit
    // OK. y-partyserver warn-logs unknown strings, so a string flood is a log-noise/CPU
    // vector the limiter does not cover — pinned here as documentation. TODO: extend the
    // gate if string traffic ever matters.
    const roomId = newRoomId();
    const client = await connect(roomId, await anonCookie(newUserId()));
    const receiver = await connect(roomId, await anonCookie(newUserId()));
    await client.untilSynced();
    await receiver.untilSynced();

    for (let i = 0; i < 500; i++) client.ws.send('__YPS:not-a-real-command');
    const sentinel = client.putObject({ kind: 'note' });
    // Still connected and still syncing afterwards — the RECEIVER seeing the sentinel
    // proves the server processed the whole flood and kept relaying (ordered delivery);
    // the sender's own doc has the sentinel trivially.
    await until(() => receiver.objects.has(sentinel), 'sync after string flood', 10000);
    expect(client.closeEvent).toBeNull();
    client.close();
    receiver.close();
  }, 15000);
});
