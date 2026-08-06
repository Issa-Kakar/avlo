/**
 * Sync-suite WS harness: upgrade via SELF.fetch, a minimal Yjs client over the accepted
 * socket, frame builders for the rate-limiter floods, and a poll-until helper.
 *
 * Lives HERE (not `workers/test-support/`) because it imports yjs / y-protocols / lib0 —
 * bare specifiers only resolve from a directory with a package.json under pnpm, and sync
 * is the only suite that speaks the Yjs wire protocol anyway. Dependency-free helpers
 * (cookie minting) stay in `../../test-support/`.
 */

import { env, runInDurableObject, SELF } from 'cloudflare:test';
import { asUserId, generateRoomId, type UserId, ulid } from '@avlo/shared';
import { mintAnonCookie } from '@avlo/test-support/cookies';
import { until } from '@avlo/test-support/until';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';
import type { AvloDO } from '../src/room';

export { until };

/** Objects map of the DO's live document (the authority the relay reads/writes). */
export const serverObjectIds = (roomId: string): Promise<string[]> =>
  runInDurableObject(env.rooms.getByName(roomId), (instance: AvloDO) => [...instance.document.getMap('objects').keys()]);

/**
 * White-box read of the DO's constructor-loaded meta row. `rev`, `createdAt`, and
 * `deletedAt` are never pushed on the wire — those facts have NO client observable.
 * Everything else IS: prefer boot-push assertions (`mode:`/`title:`/`owner:`/`perm:`)
 * for ownership/title/permission and reach for this only for the row-only facts.
 */
export const readMeta = (roomId: string): Promise<Record<string, unknown> | null> =>
  runInDurableObject(env.rooms.getByName(roomId), (instance: AvloDO) => {
    const meta = (instance as unknown as { meta: Record<string, unknown> | null }).meta;
    return meta ? { ...meta } : null;
  });

/** Must match the aux auth worker's ANON_SECRET binding in vitest.config.ts. */
export const TEST_ANON_SECRET = 'test-anon-secret';

export const newUserId = (): UserId => asUserId(ulid());
export const newRoomId = (): string => generateRoomId();
export const anonCookie = (userId: string): Promise<string> => mintAnonCookie(userId, TEST_ANON_SECRET);

export interface UpgradeOpts {
  /** Origin header; null omits it entirely. Default: the allowed prod SPA origin. */
  origin?: string | null;
  cookie?: string | null;
  headers?: Record<string, string>;
  /** Request base URL — controls the Host the dev-origin gate reads. */
  base?: string;
}

/** Raw WS upgrade against the worker under test. Callers assert on the Response. */
export async function upgrade(roomId: string, opts: UpgradeOpts = {}): Promise<Response> {
  const { origin = 'https://avlo.io', cookie = null, headers = {}, base = 'https://sync.avlo.io' } = opts;
  // Service-binding fetches don't synthesize a Host header; the dev-origin gate reads it.
  const h: Record<string, string> = { Upgrade: 'websocket', Host: new URL(base).host, ...headers };
  if (origin !== null) h.Origin = origin;
  if (cookie !== null) h.Cookie = cookie;
  return SELF.fetch(`${base}/sync/rooms/${roomId}`, { headers: h });
}

/**
 * Minimal y-protocols client over an accepted server socket. Mirrors the provider's
 * handshake: sends syncStep1 on attach, answers the server's syncStep1 with syncStep2,
 * applies incoming syncStep2/update frames, and forwards local doc updates. `custom`
 * collects `__YPS:`-stripped strings in arrival order; `awarenessFrames` counts type-1
 * binary frames (the rate-limit suite's drop probe).
 */
export class RoomClient {
  readonly ws: WebSocket;
  readonly doc = new Y.Doc();
  readonly custom: string[] = [];
  awarenessFrames = 0;
  closeEvent: { code: number; reason: string } | null = null;
  /** True once the server's syncStep2 (reply to our syncStep1) has been applied. */
  synced = false;

  constructor(ws: WebSocket) {
    this.ws = ws;
    ws.accept();
    // workerd's client-side sockets default to 'blob' — the decoder needs ArrayBuffer.
    ws.binaryType = 'arraybuffer';
    ws.addEventListener('message', (ev) => this.#onMessage(ev as MessageEvent));
    ws.addEventListener('close', (ev) => {
      this.closeEvent = { code: (ev as CloseEvent).code, reason: (ev as CloseEvent).reason };
    });
    this.doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin === this) return; // remote-applied — don't echo
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, 0);
      syncProtocol.writeUpdate(enc, update);
      this.ws.send(encoding.toUint8Array(enc));
    });
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, 0);
    syncProtocol.writeSyncStep1(enc, this.doc);
    ws.send(encoding.toUint8Array(enc));
  }

  #onMessage(ev: MessageEvent): void {
    if (typeof ev.data === 'string') {
      this.custom.push(ev.data.startsWith('__YPS:') ? ev.data.slice(6) : ev.data);
      return;
    }
    const dec = decoding.createDecoder(new Uint8Array(ev.data as ArrayBuffer));
    const type = decoding.readVarUint(dec);
    if (type === 0) {
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, 0);
      const messageType = syncProtocol.readSyncMessage(dec, enc, this.doc, this);
      if (messageType === syncProtocol.messageYjsSyncStep2) this.synced = true;
      if (encoding.length(enc) > 1) this.ws.send(encoding.toUint8Array(enc));
    } else if (type === 1) {
      this.awarenessFrames++;
    }
  }

  get objects(): Y.Map<Y.Map<unknown>> {
    return this.doc.getMap<Y.Map<unknown>>('objects');
  }

  /** Create a minimal object in the shared map (id + provided fields). Returns the id. */
  putObject(fields: Record<string, unknown> = {}, id: string = ulid()): string {
    this.doc.transact(() => {
      const m = new Y.Map<unknown>();
      m.set('id', id);
      for (const [k, v] of Object.entries(fields)) m.set(k, v);
      this.objects.set(id, m);
    });
    return id;
  }

  #awareness: awarenessProtocol.Awareness | null = null;

  /**
   * Publish a real awareness state tied to THIS client's doc.clientID (the id
   * y-partyserver records in the connection's `__ypsAwarenessIds` attachment).
   * Returns the clientID for later attachment assertions.
   */
  sendAwareness(state: Record<string, unknown> = { probe: true }): number {
    this.#awareness ??= new awarenessProtocol.Awareness(this.doc);
    this.#awareness.setLocalState(state);
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, 1);
    encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(this.#awareness, [this.doc.clientID]));
    this.ws.send(encoding.toUint8Array(enc));
    return this.doc.clientID;
  }

  /** Resolve the initial handshake (server state applied locally). */
  untilSynced(): Promise<boolean> {
    return until(() => this.synced, 'initial sync handshake');
  }

  untilClosed(timeoutMs = 5000): Promise<{ code: number; reason: string }> {
    return until(() => this.closeEvent, 'socket close', timeoutMs) as Promise<{ code: number; reason: string }>;
  }

  close(): void {
    this.ws.close(1000, 'test done');
  }
}

/**
 * Accept a 101 response's socket RAW (no Yjs client) — for deny-path tests that assert
 * "closed with code X and zero doc frames leaked". Counts binary frames, records the close.
 */
export function rawSocket(res: Response): { binaryFrames(): number; untilClosed(timeoutMs?: number): Promise<number> } {
  if (res.status !== 101 || !res.webSocket) throw new Error(`expected 101 upgrade, got ${res.status}`);
  const ws = res.webSocket;
  ws.accept();
  ws.binaryType = 'arraybuffer';
  let binary = 0;
  let closeCode = 0;
  ws.addEventListener('message', (ev) => {
    if (typeof (ev as MessageEvent).data !== 'string') binary++;
  });
  ws.addEventListener('close', (ev) => {
    closeCode = (ev as CloseEvent).code;
  });
  return {
    binaryFrames: () => binary,
    untilClosed: async (timeoutMs = 5000) => {
      await until(() => closeCode !== 0, 'raw-socket close', timeoutMs);
      return closeCode;
    },
  };
}

/** Upgrade + attach a client; throws unless the server accepted with 101. */
export async function connect(roomId: string, cookie: string | null, opts: UpgradeOpts = {}): Promise<RoomClient> {
  const res = await upgrade(roomId, { ...opts, cookie });
  if (res.status !== 101 || !res.webSocket) throw new Error(`expected 101 upgrade, got ${res.status}`);
  return new RoomClient(res.webSocket);
}

/** One valid, harmlessly-applicable sync frame: messageSync + messageYjsUpdate + empty update. */
export function emptyUpdateFrame(): Uint8Array {
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, 0);
  syncProtocol.writeUpdate(enc, Y.encodeStateAsUpdate(new Y.Doc()));
  return encoding.toUint8Array(enc);
}

/** One valid awareness frame from a throwaway client (state content is irrelevant to the gate). */
export function awarenessFrame(): Uint8Array {
  const doc = new Y.Doc();
  const awareness = new awarenessProtocol.Awareness(doc);
  awareness.setLocalState({ probe: true });
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, 1);
  encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(awareness, [doc.clientID]));
  awareness.destroy();
  doc.destroy();
  return encoding.toUint8Array(enc);
}
