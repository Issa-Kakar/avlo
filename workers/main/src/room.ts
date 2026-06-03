import * as schemaDo from '@avlo/db/schema-do';
import { asRoomId, asUserId, maxZLength, Permission, renormalizeZ, type UserId, Z_RENORM_MAX_KEY_LEN, Z_RENORM_ORIGIN } from '@avlo/shared';
import { eq } from 'drizzle-orm';
import { drizzle, type DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite';
import { migrate } from 'drizzle-orm/durable-sqlite/migrator';
import type { Connection, ConnectionContext, WSMessage } from 'partyserver';
import { YServer } from 'y-partyserver';
import * as Y from 'yjs';
import migrations from '../drizzle/migrations';

// One canonical head per room, V2-encoded at rest
const headKey = (room: string) => `rooms/${room}/head.v2.bin`;

const { roomMeta } = schemaDo;

/** Per-connection identity — the trust boundary (server-set), written once in onConnect (§19/H19). */
interface ConnState {
  userId: UserId;
}

/** The room DO's authoritative meta (one `room_meta` row, minus the roomId PK = this.name).
 *  `Permission` (imported from @avlo/shared) is both the Zod enum value and its inferred type. */
interface RoomMeta {
  ownerId: UserId;
  permission: Permission;
  createdAt: number;
  updatedAt: number;
}

// --- Tier-3 WS message limiter (§10/H25) — generous abuse backstop, not an editing throttle.
const SYNC_BUDGET = 200;
const AWARE_BUDGET = 400;
const WINDOW_MS = 1000;
const OK = 0;
const DROP = 1;
const CLOSE = 2;
/** One fixed hidden class, all SMI — no stored timestamp (the window is an integer id). */
class RateState {
  sync = 0;
  aware = 0;
  win = 0;
}

// YServer lifecycle: awaits onStart(), then onLoad(), installs debounced onSave(), then
// accepts sockets — so hydration always completes before the first sync step. The DO
// constructor loads this.meta (NOT onLoad) so it is present on EVERY entry point including
// raw cross-script RPC (setPermission), which bypasses onStart/onLoad (§5).
export class RoomDurableObject extends YServer<Env> {
  // R2-friendly cadence: fewer, bigger writes
  static override callbackOptions = { debounceWait: 5000, debounceMaxWait: 15000 };
  static override options = {
    hibernate: true,
  };

  private readonly db: DrizzleSqliteDODatabase<typeof schemaDo>;
  private meta: RoomMeta | null = null;

  // Per-connection message limiter (§10/H25). Object-keyed: connection identity is stable
  // within an isolate, so this is an identity-hash probe with no state/userId/string work
  // on the hot path. Hibernation clears it (the DO only hibernates after idle).
  #rl = new Map<Connection<ConnState>, RateState>();
  #boot = Date.now();
  // Guard the empty-room R2 flush: connections closed at the 4401/4403 gate never edited
  // the doc, so a flood of forbidden attempts must not trigger pointless R2 writes.
  #authorizedConnected = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.db = drizzle(ctx.storage, { schema: schemaDo });
    // ★ Load meta in the CONSTRUCTOR (runs on every entry point + hibernation wake), not
    // onLoad — raw cross-script RPC (setPermission) never triggers onStart/onLoad (§5).
    // blockConcurrencyWhile gates delivery until migrate + load resolve.
    ctx.blockConcurrencyWhile(async () => {
      await migrate(this.db, migrations);
      this.meta = this.db.select().from(roomMeta).get() ?? null;
    });
  }

  /**
   * Hydrate from R2 (V2 bytes). Brand-new rooms have no head object yet — that's fine.
   * onLoad stays R2-hydrate-only; meta loads in the constructor (§5).
   */
  override async onLoad(): Promise<void> {
    const obj = await this.env.DOCS.get(headKey(this.name));
    if (!obj) return;
    const bytes = new Uint8Array(await obj.arrayBuffer());
    if (bytes.byteLength === 0) return;
    Y.applyUpdateV2(this.document, bytes);
  }

  /**
   * Debounced persistence: write a V2 snapshot to R2 as the canonical head.
   */
  override async onSave(): Promise<void> {
    const updateV2 = Y.encodeStateAsUpdateV2(this.document);
    await this.env.DOCS.put(headKey(this.name), updateV2, {
      httpMetadata: { contentType: 'application/octet-stream' },
      customMetadata: { ts: String(Date.now()) },
    });
  }

  /**
   * Connect flow (§7): authenticate the edge-stamped id → create-or-authorize against the
   * constructor-loaded meta → close cleanly on denial (before super, so no syncStep1) →
   * stamp state exactly once → push the effective mode → project the visit.
   */
  override async onConnect(conn: Connection<ConnState>, ctx: ConnectionContext): Promise<void> {
    // 1. AUTHENTICATE — read the edge-stamped header (onBeforeConnect set it on verify
    // success, deleted it on failure). Absent ⇒ rejected / never ran.
    const raw = ctx.request.headers.get('x-avlo-user-id');
    if (!raw) {
      conn.close(4401, 'unauthenticated'); // no super.onConnect → no syncStep1 frame
      return;
    }
    const userId = asUserId(raw); // verified + format-gated at the edge — a trusted boundary

    // 2. CREATE-OR-AUTHORIZE — first authorized connect mints ownership (single-threaded).
    if (!this.meta) {
      const now = Date.now();
      this.meta = { ownerId: userId, permission: 'public', createdAt: now, updatedAt: now };
      this.db.insert(roomMeta).values({ roomId: asRoomId(this.name), ...this.meta }).run(); // authoritative SQLite
      try {
        await this.env.ROOM_META.send({ roomId: this.name, ...this.meta }); // durability-critical one-shot (§6)
      } catch (err) {
        console.error('room creation projection failed', err); // connect proceeds; heals on next meta
      }
    }
    if (this.meta.permission === 'private' && this.meta.ownerId !== userId) {
      conn.close(4403, 'forbidden');
      return;
    }

    // 3. STAMP IDENTITY — the ONLY setState, before super (a later non-spread write would
    // wipe y-partyserver's __ypsAwarenessIds, §19/H19).
    conn.setState({ userId });
    this.#authorizedConnected = true;
    await super.onConnect(conn, ctx); // YServer: syncStep1 + awareness merge

    // 4. PUSH EFFECTIVE MODE — out-of-band __YPS: string (never parsed by the Yjs decoder).
    this.sendCustomMessage(conn, `mode:${this.isReadOnly(conn) ? 'viewer' : 'editor'}`);

    // 5. PROJECT THE VISIT — fire-and-forget, error-handled (waitUntil is a no-op in a DO, §6).
    this.env.ROOM_VISITS.send({ userId, roomId: this.name, visitedAt: Date.now() }).catch((err) => console.error('visit projection failed', err));
  }

  /** Live read-only recompute from in-memory meta — reflects permission flips on the very next message (§8/H17). */
  override isReadOnly(conn: Connection<ConnState>): boolean {
    return !!this.meta && this.meta.permission === 'readonly' && conn.state?.userId !== this.meta.ownerId;
  }

  /**
   * Owner-only permission flip, reached by cross-script raw RPC from `users` (§8). Works
   * even on a cold/evicted DO because meta loads in the constructor. Updates SQLite +
   * mutates this.meta in memory (★ warm-cache fix — warm DOs don't re-run onStart/onLoad,
   * so the SQLite write alone leaves isReadOnly stale on the live connections that matter)
   * + projects + re-pushes/evicts live non-owner connections.
   */
  async setPermission(caller: UserId, next: Permission): Promise<void> {
    Permission.parse(next); // authority-boundary guard (§14a)
    if (!this.meta || this.meta.ownerId !== caller) throw new Error('forbidden');
    const now = Date.now();
    this.db.update(roomMeta).set({ permission: next, updatedAt: now }).where(eq(roomMeta.roomId, asRoomId(this.name))).run();
    this.meta = { ...this.meta, permission: next, updatedAt: now }; // ★ warm-cache fix
    await this.env.ROOM_META.send({ roomId: this.name, ownerId: this.meta.ownerId, permission: next, createdAt: this.meta.createdAt, updatedAt: now });

    for (const c of this.getConnections<ConnState>()) {
      if (c.state?.userId === caller) continue;
      if (next === 'private') c.close(4403, 'forbidden'); // evict — a viewer state can't express "gone"
      else this.sendCustomMessage(c, `mode:${this.isReadOnly(c) ? 'viewer' : 'editor'}`); // re-push, no reconnect
    }
  }

  /**
   * Tier-3 limiter gate (§10/H25): classify by peeking the leading varuint (0=sync,
   * 1=awareness) without consuming the buffer. Awareness over budget → DROP (the client
   * smooths cursors); sync over budget → CLOSE (reconnect triggers a clean Yjs resync;
   * dropping a sync update would silently diverge since resyncInterval is -1).
   */
  #gate(conn: Connection<ConnState>, message: WSMessage): number {
    if (typeof message === 'string') return OK; // y-partyserver __YPS: strings bypass
    const type = message instanceof ArrayBuffer ? new Uint8Array(message, 0, 1)[0] : (message as Uint8Array)[0];
    let s = this.#rl.get(conn);
    if (s === undefined) {
      s = new RateState();
      this.#rl.set(conn, s); // cold / post-hibernation only
    }
    const w = ((Date.now() - this.#boot) / WINDOW_MS) | 0; // lazy integer window — no stored timestamp, no alarm
    if (s.win !== w) {
      s.win = w;
      s.sync = 0;
      s.aware = 0;
    }
    if (type === 1) return ++s.aware > AWARE_BUDGET ? DROP : OK;
    return ++s.sync > SYNC_BUDGET ? CLOSE : OK;
  }

  override onMessage(conn: Connection<ConnState>, message: WSMessage): void {
    const verdict = this.#gate(conn, message);
    if (verdict === CLOSE) conn.close(1008, 'sync rate');
    else if (verdict === OK) super.onMessage(conn, message); // peek didn't consume — original buffer
    // DROP → silently ignore
  }

  /**
   * Hard flush when the last user leaves the room (complements debounced persistence,
   * prevents "lost last edits" on tab close). Drops the connection's limiter state.
   */
  override async onClose(connection: Connection<ConnState>, code: number, reason: string, wasClean: boolean): Promise<void> {
    // First let YServer prune the connection and awareness state.
    await super.onClose(connection, code, reason, wasClean);
    this.#rl.delete(connection);

    // If the room is now empty AND an authorized connection ever attached, flush the doc
    // immediately (non-debounced). getConnections() yields only OPEN sockets; after
    // super.onClose() the departing socket is already excluded.
    if (this.#authorizedConnected && this.getConnections()[Symbol.iterator]().next().done) {
      // One microturn in case a final Yjs update just landed
      await Promise.resolve();
      try {
        // Renorm z-keys if any object's key has grown past the threshold. Origin
        // 'server-renorm' is NOT in client UndoManager.trackedOrigins, so this
        // doesn't pollute undo history.
        if (maxZLength(this.document) > Z_RENORM_MAX_KEY_LEN) {
          this.document.transact(() => {
            renormalizeZ(this.document);
          }, Z_RENORM_ORIGIN);
        }
        await this.onSave();
      } catch (err) {
        console.error('flush-on-last-disconnect failed:', err);
      }
    }
  }
}
