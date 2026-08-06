/**
 * Integration harness — wrangler's `createTestHarness` running the four cross-wired
 * workers (sync PRIMARY, auth, users, images) from their REAL wrangler.jsonc files in
 * ONE merged Miniflare: service bindings, the cross-script `rooms` DO, and the queue
 * broker all wire up by wrangler `name`, exactly like `scripts/dev-miniflare.mjs`.
 * Tests run in plain Node — the harness hands out DispatchFetch (incl. WS upgrades),
 * `getEnv()` binding proxies, DO storage SQL, and the runtime log.
 *
 * `images` is present only because auth's `IMAGES` service binding must resolve.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { asUserId, generateRoomId, type UserId, ulid } from '@avlo/shared';
import { TEST_AUTH_BINDINGS } from '@avlo/test-support/aux-build';
import { mintAnonCookie } from '@avlo/test-support/cookies';
import { until } from '@avlo/test-support/until';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import { afterAll, beforeAll } from 'vitest';
import { createTestHarness, type TestHarness } from 'wrangler';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';

export { until };

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const { ANON_SECRET, OAUTH_PKCE_SECRET, GOOGLE_CLIENT_SECRET, ...AUTH_VARS } = TEST_AUTH_BINDINGS;

/**
 * One harness per test FILE (module scope + vitest hooks). `listen()` boots the merged
 * runtime; users' D1 gets its drizzle migrations before any test runs. No `reset()`
 * anywhere — repo convention: unique room/user ids per test.
 */
export function createAvloHarness(): TestHarness {
  const server = createTestHarness({
    root: ROOT,
    workers: [
      { configPath: 'workers/sync/wrangler.jsonc' }, // PRIMARY
      {
        configPath: 'workers/auth/wrangler.jsonc',
        secrets: { ANON_SECRET, OAUTH_PKCE_SECRET, GOOGLE_CLIENT_SECRET },
        vars: AUTH_VARS, // pins the public vars over any .dev.vars fold
      },
      { configPath: 'workers/users/wrangler.jsonc' },
      { configPath: 'workers/images/wrangler.jsonc' },
    ],
  });
  beforeAll(async () => {
    await server.listen();
    await server.getWorker('avlo-users').applyD1Migrations('DB');
  });
  afterAll(() => server.close());
  return server;
}

export const newUserId = (): UserId => asUserId(ulid());
export const newRoomId = (): string => generateRoomId();
export const anonCookie = (userId: string): Promise<string> => mintAnonCookie(userId, ANON_SECRET);

/** Minimal structural views of the bindings the tests reach through `getEnv()` —
 *  deliberately not `@cloudflare/workers-types` (this package compiles under Node types). */
export interface UsersEnvView {
  DB: {
    prepare(query: string): {
      bind(...params: unknown[]): { first<T = Record<string, unknown>>(): Promise<T | null> };
    };
  };
  ROOM_MIGRATE: { send(body: unknown): Promise<void> };
}

export const usersEnv = (server: TestHarness): Promise<UsersEnvView> => server.getWorker<UsersEnvView>('avlo-users').getEnv();

/** The DO-SQLite `room_meta` row, read through the harness's storage handle. */
export async function doMetaRow(server: TestHarness, roomId: string): Promise<Record<string, unknown> | undefined> {
  const storage = await server.getWorker('avlo-sync').getDurableObjectStorage('rooms', { name: roomId });
  const rows = (await storage.exec('SELECT * FROM room_meta WHERE room_id = ?', roomId)) as Record<string, unknown>[];
  return rows[0];
}

/** The D1 `rooms` / `room_visits` rows via the users worker's own binding. */
export async function d1RoomRow(env: UsersEnvView, roomId: string) {
  return env.DB.prepare('SELECT * FROM rooms WHERE room_id = ?').bind(roomId).first();
}
export async function d1VisitRow(env: UsersEnvView, userId: string, roomId: string) {
  return env.DB.prepare('SELECT * FROM room_visits WHERE user_id = ? AND room_id = ?').bind(userId, roomId).first();
}

/** Structural view of the workerd-style socket miniflare's DispatchFetch returns. */
interface HarnessSocket {
  accept(): void;
  send(data: ArrayBuffer | Uint8Array | string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: string, listener: (ev: { data?: unknown; code?: number; reason?: string }) => void): void;
}

/**
 * Node port of the sync suite's y-protocols RoomClient (workers/sync/test/harness.ts),
 * minus the `binaryType` line — miniflare's client socket delivers ArrayBuffer already.
 */
export class NodeRoomClient {
  readonly ws: HarnessSocket;
  readonly doc = new Y.Doc();
  readonly custom: string[] = [];
  closeEvent: { code: number; reason: string } | null = null;
  synced = false;

  constructor(ws: HarnessSocket) {
    this.ws = ws;
    ws.accept();
    ws.addEventListener('message', (ev) => this.#onMessage(ev.data));
    ws.addEventListener('close', (ev) => {
      this.closeEvent = { code: ev.code ?? 0, reason: ev.reason ?? '' };
    });
    this.doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin === this) return;
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

  #onMessage(data: unknown): void {
    if (typeof data === 'string') {
      this.custom.push(data.startsWith('__YPS:') ? data.slice(6) : data);
      return;
    }
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : (data as Uint8Array);
    const dec = decoding.createDecoder(bytes);
    const type = decoding.readVarUint(dec);
    if (type !== 0) return; // awareness — irrelevant here
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, 0);
    const messageType = syncProtocol.readSyncMessage(dec, enc, this.doc, this);
    if (messageType === syncProtocol.messageYjsSyncStep2) this.synced = true;
    if (encoding.length(enc) > 1) this.ws.send(encoding.toUint8Array(enc));
  }

  get objects(): Y.Map<Y.Map<unknown>> {
    return this.doc.getMap<Y.Map<unknown>>('objects');
  }

  putObject(fields: Record<string, unknown> = {}, id: string = ulid()): string {
    this.doc.transact(() => {
      const m = new Y.Map<unknown>();
      m.set('id', id);
      for (const [k, v] of Object.entries(fields)) m.set(k, v);
      this.objects.set(id, m);
    });
    return id;
  }

  untilSynced(): Promise<boolean> {
    return until(() => this.synced, 'initial sync handshake');
  }

  /** Resolves once the boot pushes include `flag` (e.g. 'owner:1'). */
  untilCustom(flag: string, timeoutMs = 5000): Promise<boolean> {
    return until(() => this.custom.includes(flag), `custom push ${flag}`, timeoutMs);
  }

  close(): void {
    this.ws.close(1000, 'test done');
  }
}

/** Real WS upgrade against the sync worker (Origin-guarded, cookie-authenticated). */
export async function wsConnect(server: TestHarness, roomId: string, cookie: string): Promise<NodeRoomClient> {
  const res = await server
    .getWorker('avlo-sync')
    .fetch(`https://sync.avlo.io/sync/rooms/${roomId}`, { headers: { Upgrade: 'websocket', Origin: 'https://avlo.io', Cookie: cookie } });
  const ws = (res as unknown as { webSocket?: HarnessSocket }).webSocket;
  if (res.status !== 101 || !ws) throw new Error(`expected 101 upgrade, got ${res.status}`);
  return new NodeRoomClient(ws);
}
