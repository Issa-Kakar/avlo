import { env, evictDurableObject } from 'cloudflare:test';
import { maxZLength, Z_RENORM_MAX_KEY_LEN } from '@avlo/shared';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { anonCookie, connect, newRoomId, newUserId, until } from './harness';

const headKey = (roomId: string) => `rooms/${roomId}/head.v2.bin`;

/** Poll R2 for the flushed head and decode it into a fresh doc. */
async function readFlushedDoc(roomId: string): Promise<Y.Doc> {
  const bytes = await until(async () => {
    const obj = await env.DOCS.get(headKey(roomId));
    return obj ? new Uint8Array(await obj.arrayBuffer()) : null;
  }, 'R2 head flush');
  const doc = new Y.Doc();
  Y.applyUpdateV2(doc, bytes!); // until() resolves truthy only — never null here
  return doc;
}

describe('persistence', () => {
  it('hard-flushes a V2 head to R2 when the last connection closes', async () => {
    const roomId = newRoomId();
    const client = await connect(roomId, await anonCookie(newUserId()));
    await client.untilSynced();
    const id = client.putObject({ kind: 'note', text: 'survives' });
    client.close();

    const doc = await readFlushedDoc(roomId);
    const objects = doc.getMap<Y.Map<unknown>>('objects');
    expect(objects.has(id)).toBe(true);
    expect(objects.get(id)?.get('text')).toBe('survives');
  });

  it('rehydrates the doc from R2 on a cold start — a reconnecting client gets the full state back', async () => {
    const roomId = newRoomId();
    const a = await connect(roomId, await anonCookie(newUserId()));
    await a.untilSynced();
    const id = a.putObject({ kind: 'shape', frame: [1, 2, 3, 4] });
    a.close();
    await until(async () => (await env.DOCS.get(headKey(roomId))) !== null, 'flush before cold start');

    // Evict THIS room's instance (storage intact) — the next connect is a true cold
    // start: constructor → onStart → onLoad → R2 hydrate. Targeted (never a
    // Miniflare-global abort): parallel test files' live sockets stay untouched.
    await evictDurableObject(env.rooms.getByName(roomId));

    const b = await connect(roomId, await anonCookie(newUserId()));
    await b.untilSynced();
    await until(() => b.objects.has(id), 'rehydrated state');
    expect(b.objects.get(id)?.get('kind')).toBe('shape'); // content, not just key presence
    expect(b.objects.get(id)?.get('frame')).toEqual([1, 2, 3, 4]);
    b.close();
  }, 20000); // eviction drains a pending y-partyserver save debounce (~5 s) when a doc write preceded it

  it('renormalizes over-long z keys during the empty-room flush (server-side renorm origin)', async () => {
    const roomId = newRoomId();
    const client = await connect(roomId, await anonCookie(newUserId()));
    await client.untilSynced();
    // Two objects whose relative z order must survive the rewrite; the long key trips
    // the > Z_RENORM_MAX_KEY_LEN flush check.
    const longZ = `a0${'V'.repeat(Z_RENORM_MAX_KEY_LEN + 10)}`;
    const low = client.putObject({ kind: 'note', z: 'Zx' });
    const high = client.putObject({ kind: 'note', z: longZ });
    expect('Zx' < longZ).toBe(true); // sanity: `low` sorts below `high` lexically ('Z' < 'a')
    client.close();

    const doc = await readFlushedDoc(roomId);
    expect(maxZLength(doc)).toBeLessThanOrEqual(Z_RENORM_MAX_KEY_LEN);
    const objects = doc.getMap<Y.Map<unknown>>('objects');
    const zLow = objects.get(low)?.get('z') as string;
    const zHigh = objects.get(high)?.get('z') as string;
    expect(zLow < zHigh).toBe(true); // relative order preserved through the rewrite
  });

  it('tolerates a missing R2 head — a brand-new room connects and syncs empty', async () => {
    const roomId = newRoomId();
    expect(await env.DOCS.get(headKey(roomId))).toBeNull();
    const client = await connect(roomId, await anonCookie(newUserId()));
    await client.untilSynced();
    expect(client.objects.size).toBe(0);
    client.close();
  });
});
