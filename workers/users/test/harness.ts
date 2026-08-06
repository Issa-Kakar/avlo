/**
 * Users-suite harness: direct `worker.fetch`/`worker.queue` driving with the stub-auth
 * identity cookie, drizzle helpers over the real (migrated) D1, and queue-batch builders.
 */

import { createExecutionContext, env, getQueueResult, waitOnExecutionContext } from 'cloudflare:test';
import { getSessionDB, rooms, roomVisits } from '@avlo/db';
import { asRoomId, asUserId, generateRoomId, type RoomId, type UserId, ulid } from '@avlo/shared';
import type { RoomDoRpc } from '@avlo/worker-shared';
import { and, eq } from 'drizzle-orm';
import worker from '../src/index';

/**
 * The cross-script `rooms` binding retyped to its RPC surface — `wrangler types` leaves
 * cross-script DOs untyped (`DurableObjectNamespace`), so this mirrors src/env.ts's
 * `RefineBindings` for direct meta-RPC calls from tests.
 */
export const roomsNs = env.rooms as unknown as DurableObjectNamespace<RoomDoRpc>;

export const newUserId = (): UserId => asUserId(ulid());
export const newRoomId = (): RoomId => asRoomId(generateRoomId());

/** A fresh drizzle handle over the real D1 (writer session). */
export const db = () => getSessionDB(env.DB).db;

export interface HitOpts {
  user?: string | null;
  /** Poisoned-binding variants for failure-path tests. */
  env?: typeof env;
}

/** One request against the users app (cors → csp → csrf → auth → limiter → routes). */
export async function hit(path: string, init: RequestInit = {}, opts: HitOpts = {}): Promise<Response> {
  const ctx = createExecutionContext();
  const user = opts.user === undefined ? newUserId() : opts.user;
  const headers = new Headers(init.headers);
  headers.set('host', 'users.avlo.io');
  if (user !== null) headers.set('cookie', `avlo-test-user=${user}:anon`);
  const res = await worker.fetch(new Request(`https://users.avlo.io${path}`, { ...init, headers }), opts.env ?? env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

/** PATCH with a JSON body (bypasses csrf's form-content-type engagement). */
export function patch(path: string, body: unknown, opts: HitOpts = {}, headers: Record<string, string> = {}): Promise<Response> {
  return hit(path, { method: 'PATCH', body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers } }, opts);
}

let msgSeq = 0;
/** One queue message in the `createMessageBatch` wire shape. */
export const msg = <T>(body: T) => ({ id: `msg-${++msgSeq}`, timestamp: new Date(), attempts: 1, body });

/**
 * The ack/retry ledger `getQueueResult` resolves. The generated runtime types omit
 * `FetcherQueueResult` (skipLibCheck masks the unresolved name, so it arrives as `any`);
 * this local view keeps the suite's assertions typed.
 */
export interface QueueResultLedger {
  ackAll: boolean;
  retryBatch: { retry: boolean; delaySeconds?: number };
  explicitAcks: string[];
  retryMessages: { msgId: string; delaySeconds?: number }[];
}

/** Run the consumer on a built batch (optionally with a poisoned env) and return the ack/retry ledger. */
export async function consumeBatch(batch: MessageBatch, envOverride: typeof env = env): Promise<QueueResultLedger> {
  const ctx = createExecutionContext();
  // The test env IS the runtime bindings — only the generated typing is weaker (untyped
  // `Service`/DO namespace), hence the cast to consume's refined signature.
  await worker.queue(batch, envOverride as unknown as Parameters<typeof worker.queue>[1]);
  return getQueueResult(batch, ctx);
}

/** Mint REAL AvloDO meta for a room (cross-script RPC), owned by `owner`. Returns the snapshot. */
export function mintRoom(roomId: RoomId, owner: UserId, title = 'Untitled') {
  return roomsNs.getByName(roomId).setTitle(owner, title);
}

/*
 * Fake `rooms` DO namespaces for failure-path tests. Verdicts are LOCAL stub rejections,
 * deliberately never a real wire error: a real `forbidden` thrown across the cross-script
 * DO RPC boundary from inside a queue-handler context leaves a duplicate pipelined-promise
 * rejection that wedges the pool's teardown (pool-workers 0.20.x, empirically re-confirmed).
 * The DO-side contracts themselves (forbidden, invalid-title) are pinned by the sync suite
 * and this suite's PATCH 403 path. The stub covers all three meta RPCs so a call site's
 * method choice can't silently miss.
 */
const rejectingDoStub = (err: Error) => ({
  setPermission: () => Promise.reject(err),
  setTitle: () => Promise.reject(err),
  migrateOwner: () => Promise.reject(err),
});

/** Every room's stub rejects with `err` — the transport-dead namespace. */
export const deadRoomsNamespace = (err: Error) => ({ getByName: () => rejectingDoStub(err) }) as unknown as typeof env.rooms;

/** Named rooms reject with their verdict; every other room passes through to the REAL namespace. */
export const hybridRoomsNamespace = (realNs: DurableObjectNamespace<RoomDoRpc>, verdicts: Record<string, Error>) =>
  ({
    getByName: (id: string) => {
      const verdict = verdicts[id];
      return verdict ? rejectingDoStub(verdict) : realNs.getByName(id);
    },
  }) as unknown as typeof env.rooms;

/** The D1 rooms row (or undefined). */
export async function roomRow(roomId: RoomId) {
  return (await db().select().from(rooms).where(eq(rooms.roomId, roomId)).all())[0];
}

/** The D1 room_visits row for user+room (or undefined). */
export async function visitRow(userId: UserId, roomId: RoomId) {
  return (
    await db()
      .select()
      .from(roomVisits)
      .where(and(eq(roomVisits.userId, userId), eq(roomVisits.roomId, roomId)))
      .all()
  )[0];
}
