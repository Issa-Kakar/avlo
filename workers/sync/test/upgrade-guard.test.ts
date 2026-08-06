import { env, listDurableObjectIds, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { anonCookie, connect, newRoomId, newUserId, until, upgrade } from './harness';

/**
 * Edge guard on the WS upgrade (`on-before-connect.ts`), through the REAL auth aux worker.
 *
 * A rejected upgrade surfaces as **404**, not the guard's 403/400: hono-party swallows any
 * non-WebSocket response from the party router and falls through to Hono's notFound. The
 * assertions below pin that observable contract (the browser just sees a failed connect).
 */
describe('WS upgrade guard', () => {
  it('accepts both allowed prod origins with a valid anon cookie (101)', async () => {
    for (const origin of ['https://avlo.io', 'https://www.avlo.io']) {
      const res = await upgrade(newRoomId(), { origin, cookie: await anonCookie(newUserId()) });
      expect(res.status).toBe(101);
      expect(res.webSocket).toBeTruthy();
      res.webSocket?.accept();
      res.webSocket?.close(1000);
    }
  });

  it('rejects near-miss origins — explicit :443, trailing slash, http, subdomain (404)', async () => {
    // ALLOWED_PROD is exact string equality; every serialization variant must miss.
    for (const origin of ['https://avlo.io:443', 'https://avlo.io/', 'http://avlo.io', 'https://evil.avlo.io']) {
      const res = await upgrade(newRoomId(), { origin, cookie: await anonCookie(newUserId()) });
      expect(res.status, `origin ${origin}`).toBe(404);
    }
  });

  it('rejects a missing Origin header (404) — non-browser clients are not allowlisted', async () => {
    const res = await upgrade(newRoomId(), { origin: null, cookie: await anonCookie(newUserId()) });
    expect(res.status).toBe(404);
  });

  it('gates localhost origins on the request Host: prod Host rejects, dev Host accepts', async () => {
    const cookie = await anonCookie(newUserId());
    // Same Origin, two Hosts: the allowlist reads `isDevHost(host)`, not the origin alone.
    const prodHost = await upgrade(newRoomId(), { origin: 'http://localhost:3000', cookie });
    expect(prodHost.status).toBe(404);

    const devHost = await upgrade(newRoomId(), { origin: 'http://localhost:3000', cookie, base: 'http://localhost:8787' });
    expect(devHost.status).toBe(101);
    devHost.webSocket?.accept();
    devHost.webSocket?.close(1000);
  });

  it('rejects malformed room ids — wrong length and non-base62 chars (404)', async () => {
    const cookie = await anonCookie(newUserId());
    // ROOM_ID_RE is exactly 14 base62 chars; '-'/'_' are outside the alphabet.
    for (const bad of ['a'.repeat(13), 'a'.repeat(15), 'abc-efghijklmn', 'abc_efghijklmn']) {
      const res = await upgrade(bad, { cookie });
      expect(res.status, `room id ${bad}`).toBe(404);
    }
  });

  it('neutralizes a spoofed x-avlo-user-id with no cookie — DO closes 4401, never trusts the header', async () => {
    // The hook unconditionally OWNS the header: verify failed ⇒ delete, so the DO sees
    // absent identity even though the client sent one. Upgrade still 101s (the guard
    // passes the request through); denial happens as a DO close code.
    const res = await upgrade(newRoomId(), { headers: { 'x-avlo-user-id': newUserId() } });
    expect(res.status).toBe(101);
    const ws = res.webSocket;
    if (!ws) throw new Error('no socket');
    const closed: { code: number }[] = [];
    ws.accept();
    ws.addEventListener('close', (ev) => {
      closed.push({ code: (ev as CloseEvent).code });
    });
    await until(() => closed.length > 0, '4401 close');
    expect(closed[0].code).toBe(4401);
  });

  it('overrides a spoofed x-avlo-user-id with the cookie identity — a pre-owned room boots owner:0 for the spoofing user', async () => {
    // Pre-mint: A's first authorized connect owns the room.
    const ownerId = newUserId();
    const roomId = newRoomId();
    const ownerTab = await connect(roomId, await anonCookie(ownerId));
    await ownerTab.untilSynced();
    ownerTab.close();

    // B connects with B's cookie AND the owner's id in a spoofed header. The hook
    // unconditionally re-stamps the header from the verified cookie, so the DO sees B
    // and pushes owner:0. Had the spoofed header won, the DO would see A and push owner:1.
    const b = await connect(roomId, await anonCookie(newUserId()), { headers: { 'x-avlo-user-id': ownerId } });
    await until(() => b.custom.length >= 4, 'boot pushes');
    expect(b.custom.slice(0, 4)).toEqual(['mode:editor', 'title:Untitled', 'owner:0', 'perm:public']);
    b.close();
  });

  it('serves 404 on a non-WS GET but still instantiates the DO (characterizes the HTTP surface)', async () => {
    // onBeforeConnect only runs for upgrades; a plain GET flows to the DO's default
    // onRequest ("Not implemented" 404). Characterized so a future HTTP surface on the
    // party path is a deliberate decision, not drift — note the DO gets created (and
    // runs its migration) for any well-formed path, auth or not.
    const roomId = newRoomId();
    const res = await SELF.fetch(`https://sync.avlo.io/sync/rooms/${roomId}`);
    expect(res.status).toBe(404);
    const ids = await listDurableObjectIds(env.rooms);
    const expected = env.rooms.idFromName(roomId).toString();
    expect(ids.some((id) => id.toString() === expected)).toBe(true);
  });
});
