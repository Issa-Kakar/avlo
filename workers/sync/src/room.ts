import * as schemaDo from '@avlo/db/schema-do';
import {
  asRoomId,
  asUserId,
  maxZLength,
  normalizeRoomTitle,
  type Permission,
  renormalizeZ,
  type UserId,
  Z_RENORM_MAX_KEY_LEN,
  Z_RENORM_ORIGIN,
} from '@avlo/shared';
import { devDrizzleLogger, isDevLogs, type MetaEvent, type RoomDoRpc, traceRpc, type VisitEvent } from '@avlo/worker-shared';
import { eq } from 'drizzle-orm';
import { type DrizzleSqliteDODatabase, drizzle } from 'drizzle-orm/durable-sqlite';
import { migrate } from 'drizzle-orm/durable-sqlite/migrator';
import type { Connection, ConnectionContext, WSMessage } from 'partyserver';
import { YServer } from 'y-partyserver';
import * as Y from 'yjs';
import type { z } from 'zod/v4';
import migrations from '../drizzle/migrations';

// One canonical head per room, V2-encoded at rest
const headKey = (room: string) => `rooms/${room}/head.v2.bin`;

const { roomMeta } = schemaDo;

/** Per-connection identity — the trust boundary (server-set), written once in onConnect (§19/H19). */
interface ConnState {
  userId: UserId;
}

/** The room DO's authoritative meta — the one `room_meta` row, shape-identical to the
 *  `MetaEvent` projection it emits. `roomId` is the PK; the DO's self-identity is just
 *  `asRoomId(this.name)` (= `ctx.id.name`, reliable on every entry path — see the class
 *  note). Meta still loads in the constructor so the ownership check + warm cache are
 *  present on the cold raw-RPC path (which skips onStart/onLoad). `rev` is the per-room
 *  monotonic counter: bumped + persisted BEFORE every queue send (both queues share it),
 *  so the D1 consumer resolves ordering with a plain `excluded.rev >` guard and
 *  at-least-once redelivery is a no-op. `deleted` is the persistent tombstone (no delete
 *  flow yet — column + type prep only). */
type RoomMeta = MetaEvent;

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
// constructor loads this.meta (NOT onLoad) so the ownership check + warm cache are present
// on EVERY entry point including the cold raw cross-script RPC (setPermission/setTitle),
// which bypasses onStart/onLoad (§5).
//
// Identity is uniform: `asRoomId(this.name)`. partyserver resolves `this.name` from
// `ctx.id.name`, which the runtime populates for any stub addressed via getByName/idFromName
// on EVERY entry path — the cold raw-RPC wake and the constructor included (workerd ≥
// 2026-03). So the meta RPCs need no room-id argument and no identity proof: the
// `getByName(validatedId)` addressing already binds this object to that id. (Dev parity: the
// single-Miniflare orchestrator populates `this.name` exactly as prod does, so the meta RPCs
// resolve their room id identically under `pnpm dev`.)
export class AvloDO extends YServer<Env> implements RoomDoRpc {
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

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.db = drizzle(ctx.storage, { schema: schemaDo, logger: devDrizzleLogger(env, '[room-do]') });
    // Hibernation observability: the constructor runs on EVERY entry incl. a hibernation wake —
    // retained hibernatable sockets ⇒ woke with live connections, zero ⇒ a cold start (first
    // touch / cross-script RPC). Dev-only (dormant in prod).
    if (isDevLogs(env)) {
      const retained = ctx.getWebSockets().length;
      console.warn(`[room] DO instantiated — ${retained > 0 ? `hibernation wake (${retained} ws retained)` : 'cold start'}`);
    }
    // ★ Load meta in the CONSTRUCTOR (runs on every entry point + hibernation wake), not
    // onLoad — raw cross-script RPC (setPermission/setTitle) never triggers onStart/onLoad
    // (§5). blockConcurrencyWhile gates delivery until migrate + load resolve.
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
    // Connect proceeds even if the projection enqueue fails — DO meta is already durable
    // on disk; a missed send only loses the D1 row until the next meta event (§6).
    if (!this.meta) {
      this.meta = this.#mintMeta(userId, 'Untitled');
      await this.#projectMeta(this.meta);
    }
    if (this.meta.permission === 'private' && this.meta.ownerId !== userId) {
      conn.close(4403, 'forbidden');
      return;
    }

    // 3. STAMP IDENTITY — the ONLY setState, before super (a later non-spread write would
    // wipe y-partyserver's __ypsAwarenessIds, §19/H19).
    conn.setState({ userId });
    await super.onConnect(conn, ctx); // YServer: syncStep1 + awareness merge

    // 4. PUSH EFFECTIVE MODE + ROOM META — out-of-band __YPS: strings (never parsed by the
    // Yjs decoder). `title`/`perm` are room-wide (re-pushed on rename / permission flip);
    // `owner` is per-connection.
    this.sendCustomMessage(conn, `mode:${this.isReadOnly(conn) ? 'viewer' : 'editor'}`);
    this.sendCustomMessage(conn, `title:${this.meta.title}`);
    this.sendCustomMessage(conn, `owner:${this.meta.ownerId === userId ? '1' : '0'}`);
    this.sendCustomMessage(conn, `perm:${this.meta.permission}`);

    // 5. PROJECT THE VISIT — fire-and-forget send, error-handled (waitUntil is a no-op in a
    // DO, §6). The rev bump is made durable BEFORE the send so a DO restart can never
    // reissue a lower rev — the consumer's ordering guard rides on monotonicity.
    const rev = ++this.meta.rev;
    this.db.update(roomMeta).set({ rev }).where(eq(roomMeta.roomId, this.meta.roomId)).run();
    this.env.ROOM_VISITS.send({ userId, roomId: this.meta.roomId, visitedAt: Date.now(), rev } satisfies z.input<typeof VisitEvent>).catch(
      (err) => console.error('visit projection failed', err),
    );
  }

  /** Live read-only recompute from in-memory meta — reflects permission flips on the very next message (§8/H17). */
  override isReadOnly(conn: Connection<ConnState>): boolean {
    return !!this.meta && this.meta.permission === 'readonly' && conn.state?.userId !== this.meta.ownerId;
  }

  /**
   * First-write mint — the authenticated first toucher owns the room (single-threaded DO).
   * Self-identity is `asRoomId(this.name)` (= `ctx.id.name`); builds + persists the row and
   * RETURNS it so the caller assigns `this.meta` inline (TS narrowing survives).
   */
  #mintMeta(ownerId: UserId, title: string, permission: Permission = 'public'): RoomMeta {
    const now = Date.now();
    const meta: RoomMeta = {
      roomId: asRoomId(this.name),
      ownerId,
      permission,
      createdAt: now,
      updatedAt: now,
      title,
      rev: 1,
      deleted: false,
    };
    this.db.insert(roomMeta).values(meta).run(); // authoritative SQLite
    return meta;
  }

  /**
   * Enqueue the meta projection and return the emitted snapshot (§6) — `RoomMeta` IS the
   * `MetaEvent` shape, roomId included. The enqueue is try/caught: the SQLite write
   * already committed, so a failed send must never fail the caller — the users worker's
   * direct D1 write and/or the next meta event converge the projection. Durable fix when
   * warranted: an alarm-based transactional outbox.
   */
  async #projectMeta(meta: RoomMeta): Promise<MetaEvent> {
    try {
      await this.env.ROOM_META.send(meta satisfies z.input<typeof MetaEvent>);
    } catch (err) {
      console.error('meta projection enqueue failed', err);
    }
    return meta;
  }

  /**
   * Owner-only permission flip, reached by cross-script raw RPC from `users` (§8). Cold-DO
   * safe: meta loads in the constructor and identity is `asRoomId(this.name)`. Meta absent →
   * mint exactly like setTitle (offline-created room shared from the dashboard pre-first-
   * connect; the authenticated caller IS the creator). Otherwise updates SQLite + mutates
   * this.meta in memory (★ warm-cache fix — warm DOs don't re-run onStart/onLoad, so the
   * SQLite write alone leaves isReadOnly stale on the live connections that matter), then
   * one pass over live connections (`perm:` to the caller's tabs; evict-or-re-push for
   * non-owners) + projects, returning the snapshot for the users worker's read-your-writes
   * D1 write. Thrown message is the wire contract (`RoomDoRpc`): 'forbidden'.
   */
  async setPermission(caller: UserId, next: Permission): Promise<MetaEvent> {
    return traceRpc(
      this.env,
      'room.setPermission',
      () => this.#setPermission(caller, next),
      (r) => r.permission,
    );
  }

  async #setPermission(caller: UserId, next: Permission): Promise<MetaEvent> {
    if (!this.meta) {
      // Mint-on-absent, mirroring setTitle: an offline-created room shared from the
      // dashboard before its first connect. The mint IS rev 1 — no extra bump.
      this.meta = this.#mintMeta(caller, 'Untitled', next);
    } else {
      if (this.meta.ownerId !== caller) throw new Error('forbidden');
      const now = Date.now();
      const rev = this.meta.rev + 1;
      this.db.update(roomMeta).set({ permission: next, updatedAt: now, rev }).where(eq(roomMeta.roomId, this.meta.roomId)).run();
      this.meta = { ...this.meta, permission: next, updatedAt: now, rev }; // ★ warm-cache fix
    }

    // Single pass over live connections (the mint path has zero by construction —
    // onConnect would have minted). Caller's own tabs: `perm:` only. Non-owners:
    // evicted on private (close XOR send — never message a just-closed socket),
    // otherwise the `mode:` re-push AND the new `perm:`.
    for (const c of this.getConnections<ConnState>()) {
      if (c.state?.userId === caller) {
        this.sendCustomMessage(c, `perm:${next}`);
      } else if (next === 'private') {
        c.close(4403, 'forbidden'); // evict — a viewer state can't express "gone"
      } else {
        this.sendCustomMessage(c, `mode:${this.isReadOnly(c) ? 'viewer' : 'editor'}`); // re-push, no reconnect
        this.sendCustomMessage(c, `perm:${next}`);
      }
    }

    return this.#projectMeta(this.meta);
  }

  /**
   * Owner-only rename, reached by cross-script raw RPC from `users` (§8) — same shape as
   * setPermission: normalize (authority-boundary guard) → SQLite + warm-cache → live push →
   * project + return the snapshot. The new title is broadcast to EVERY connection (the
   * renamer's own tabs included — idempotent there). If meta doesn't exist yet (offline-
   * created room renamed from the dashboard before its first connect, replayed on
   * reconnect), mint it exactly like onConnect would — the authenticated renamer IS the
   * creator, and `asRoomId(this.name)` supplies the identity.
   */
  async setTitle(caller: UserId, raw: string): Promise<MetaEvent> {
    return traceRpc(
      this.env,
      'room.setTitle',
      () => this.#setTitle(caller, raw),
      () => 'ok',
    );
  }

  async #setTitle(caller: UserId, raw: string): Promise<MetaEvent> {
    const title = normalizeRoomTitle(raw);
    if (title === null) throw new Error('invalid-title'); // authority-boundary guard (§14a)
    if (!this.meta) {
      this.meta = this.#mintMeta(caller, title);
    } else {
      if (this.meta.ownerId !== caller) throw new Error('forbidden');
      const now = Date.now();
      const rev = this.meta.rev + 1;
      this.db.update(roomMeta).set({ title, updatedAt: now, rev }).where(eq(roomMeta.roomId, this.meta.roomId)).run();
      this.meta = { ...this.meta, title, updatedAt: now, rev }; // ★ warm-cache fix
    }

    for (const c of this.getConnections<ConnState>()) this.sendCustomMessage(c, `title:${title}`);

    return this.#projectMeta(this.meta);
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

    // If the room is now empty, flush the doc immediately (non-debounced). This runs on the
    // fresh instance after a hibernation wake too — onLoad re-hydrates the doc before onClose,
    // so the snapshot is whole. getConnections() yields only OPEN sockets; after super.onClose()
    // the departing socket is already excluded. We flush on ANY empty close (the pre-permissions
    // behavior) — tracking whether an authorized editor attached, just to skip one R2 write on a
    // forbidden-only isolate, isn't worth the state to keep correct across hibernation.
    if (this.getConnections()[Symbol.iterator]().next().done) {
      // Hibernation observability: last socket gone ⇒ the DO is idle and eligible to hibernate
      // shortly. uptime = lifetime of THIS instance (since construct/wake). Dev-only.
      if (isDevLogs(this.env)) {
        console.warn(
          `[room] last connection closed — idle after ${((Date.now() - this.#boot) / 1000).toFixed(1)}s uptime (eligible for hibernation)`,
        );
      }
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
