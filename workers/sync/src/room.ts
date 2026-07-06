import * as schemaDo from '@avlo/db/schema-do';
import {
  asRoomId,
  asUserId,
  decodeLockSetBody,
  encodeLockPeerSet,
  LOCK_STALE_MS,
  MSG_LOCK,
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

/** Per-connection identity — the trust boundary (server-set), written once in onConnect (§19/H19).
 *  `lockKey` is the small int (≥2) peers see as this connection's ephemeral-lock owner key;
 *  it lives in the attachment (survives hibernation) so post-wake allocations never collide. */
interface ConnState {
  userId: UserId;
  lockKey: number;
}

/** The room DO's authoritative meta — the one `room_meta` row, shape-identical to the
 *  `MetaEvent` projection it emits. `roomId` is the PK; self-identity is `asRoomId(this.name)`
 *  and meta loads in the constructor (see the class note). `rev` is the per-room monotonic
 *  counter, bumped + persisted on every meta mutation (create / permission / title / migrate),
 *  so the D1 consumer orders with a plain `excluded.rev >` guard and at-least-once redelivery
 *  no-ops; `rooms.rev` moves only when ownership/permission/title does, keeping owner rev-LWW
 *  clean. `deletedAt` is the nullable persistent tombstone (no delete flow yet — column + type
 *  prep only). */
type RoomMeta = MetaEvent;

// --- Tier-3 WS message limiter (§10/H25) — generous abuse backstop, not an editing throttle.
const SYNC_BUDGET = 200;
const AWARE_BUDGET = 400;
const LOCK_BUDGET = 40;
const WINDOW_MS = 1000;
const OK = 0;
const DROP = 1;
const CLOSE = 2;
/** One fixed hidden class, all SMI — no stored timestamp (the window is an integer id). */
class RateState {
  sync = 0;
  aware = 0;
  lock = 0;
  win = 0;
}

/** Ephemeral lock record per holding connection — in-memory only (hibernation wipes the
 *  tables; each holder's ≤15s lease re-announce rebuilds them). Invariant (trusted,
 *  unchecked): `id ∈ rec.ids ⇔ #lockOwner.get(id) === rec.key` — only #applyLockSet and
 *  the release paths write either side. */
interface LockRec {
  key: number;
  ids: Set<string>;
  last: number;
}

const EMPTY_IDS: ReadonlySet<string> = new Set();

// YServer lifecycle: awaits onStart(), then onLoad(), installs debounced onSave(), then
// accepts sockets — so hydration always completes before the first sync step. (Meta loads
// in the constructor, not onLoad — see the constructor.)
//
// Identity is uniform: `asRoomId(this.name)`. partyserver resolves `this.name` from
// `ctx.id.name`, which the runtime populates for any stub addressed via getByName/idFromName
// on EVERY entry path — the cold raw-RPC wake and the constructor included (workerd ≥
// 2026-03). So the meta RPCs need no room-id argument and no identity proof: the
// `getByName(validatedId)` addressing already binds this object to that id. (Dev parity: the
// single-Miniflare orchestrator populates `this.name` exactly as prod does.)
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

  // Ephemeral object locks — authoritative while this instance lives. In-memory only:
  // per-connection sets in the 2KB attachment would cap out (a marquee lock is up to
  // 4096 × 26-char ids), so hibernation amnesia is accepted and healed by client leases.
  #lockOwner = new Map<string, number>(); // objectId → ownerKey
  #locks = new Map<Connection<ConnState>, LockRec>(); // only conns holding ≥1 lock

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.db = drizzle(ctx.storage, { schema: schemaDo, logger: devDrizzleLogger(env, '[room-do]') });
    // Hibernation observability (dev-only): retained hibernatable sockets ⇒ woke with live
    // connections, zero ⇒ a cold start (first touch / cross-script RPC).
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
    // wipe y-partyserver's __ypsAwarenessIds, §19/H19). No await between alloc and stamp —
    // two racing connects can't mint the same lockKey (DO events interleave only at awaits).
    conn.setState({ userId, lockKey: this.#allocLockKey() });
    await super.onConnect(conn, ctx); // YServer: syncStep1 + awareness merge

    // 4. PUSH EFFECTIVE MODE + ROOM META — out-of-band __YPS: strings (never parsed by the
    // Yjs decoder). `title`/`perm` are room-wide (re-pushed on rename / permission flip);
    // `owner` is per-connection.
    this.sendCustomMessage(conn, `mode:${this.isReadOnly(conn) ? 'viewer' : 'editor'}`);
    this.sendCustomMessage(conn, `title:${this.meta.title}`);
    this.sendCustomMessage(conn, `owner:${this.meta.ownerId === userId ? '1' : '0'}`);
    this.sendCustomMessage(conn, `perm:${this.meta.permission}`);

    // 4b. EPHEMERAL LOCK SNAPSHOT — editors only (viewers can't mutate, so lock state is
    // noise to them). Sweep first so stale holders aren't snapshotted. This lands on the
    // client after syncStep1 but before its `synced` flips — the client buffers until sync.
    this.#sweepLocks();
    if (!this.isReadOnly(conn)) this.#sendLockSnapshot(conn);

    // 5. PROJECT THE VISIT — fire-and-forget send, error-handled (waitUntil is a no-op in a
    // DO, §6). NO rev bump: visits resolve ordering by `visitedAt`, so rev stays
    // meta-mutation-only (which keeps owner rev-LWW clean) and a connect pays no DO-SQLite write.
    this.env.ROOM_VISITS.send({ userId, roomId: this.meta.roomId, visitedAt: Date.now() } satisfies z.input<typeof VisitEvent>).catch(
      (err) => console.error('visit projection failed', err),
    );
  }

  /** Live read-only recompute from in-memory meta — reflects permission flips on the very next message (§8/H17). */
  override isReadOnly(conn: Connection<ConnState>): boolean {
    return !!this.meta && this.meta.permission === 'readonly' && conn.state?.userId !== this.meta.ownerId;
  }

  /**
   * First-write mint — the authenticated first toucher owns the room (single-threaded DO).
   * Builds + persists the row and RETURNS it so the caller assigns `this.meta` inline (TS
   * narrowing survives).
   */
  #mintMeta(ownerId: UserId, title: string, permission: Permission = 'public'): RoomMeta {
    const now = Date.now();
    const meta: RoomMeta = {
      roomId: asRoomId(this.name),
      ownerId,
      permission,
      createdAt: now,
      title,
      rev: 1,
      deletedAt: null,
    };
    this.db.insert(roomMeta).values(meta).run();
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
   * safe (see the class note). Meta absent →
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
      const rev = this.meta.rev + 1;
      this.db.update(roomMeta).set({ permission: next, rev }).where(eq(roomMeta.roomId, this.meta.roomId)).run();
      this.meta = { ...this.meta, permission: next, rev };
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
        // Locks follow edit rights: a demoted editor's locks die; a promoted viewer has a
        // blind lock column — send the snapshot (idempotent full-replace for existing editors).
        if (this.isReadOnly(c)) this.#releaseConnLocks(c);
        else this.#sendLockSnapshot(c);
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
   * creator.
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
      const rev = this.meta.rev + 1;
      this.db.update(roomMeta).set({ title, rev }).where(eq(roomMeta.roomId, this.meta.roomId)).run();
      this.meta = { ...this.meta, title, rev };
    }

    for (const c of this.getConnections<ConnState>()) this.sendCustomMessage(c, `title:${title}`);

    return this.#projectMeta(this.meta);
  }

  /**
   * Owner re-assignment, reached by cross-script raw RPC from `users` during the OAuth ADOPT
   * migration (§ second-device). Mirrors `#setPermission`'s rev-bump path exactly — the
   * read-check-write of `this.meta` and the SYNC `db.update().run()` have NO `await` between
   * them, so they're atomic in the single-threaded DO (the first `await` is inside
   * `#projectMeta`). Owner becomes rev-LWW here (the only writer of `ownerId` after mint).
   *
   * Accepted benign edges (documented, not fixed): a still-open `from`-owner tab (e.g. on
   * another device) loses the owner badge live and, for a private room, is fully locked out
   * only on its NEXT reconnect — correct, that anon id no longer owns the room (the signing-in
   * device itself reconnects as the account = new owner, since its session cookie now resolves
   * `to`). A concurrent `setPermission(caller=new owner)` racing migration may transiently 403
   * then succeed on retry. `noop` trace outcome = already owned by `to` (idempotent redelivery).
   */
  async migrateOwner(from: UserId, to: UserId): Promise<MetaEvent> {
    const already = this.meta?.ownerId === to; // captured before the call → drives the trace outcome
    return traceRpc(
      this.env,
      'room.migrateOwner',
      () => this.#migrateOwner(from, to),
      () => (already ? 'noop' : 'ok'),
    );
  }

  async #migrateOwner(from: UserId, to: UserId): Promise<MetaEvent> {
    if (!this.meta) throw new Error('forbidden'); // no room to migrate
    if (this.meta.ownerId === to) return this.meta; // ★ idempotent: already migrated — NO rev bump, NO project
    if (this.meta.ownerId !== from) throw new Error('forbidden'); // owned by a third party — skip, never force
    const rev = this.meta.rev + 1;
    this.db.update(roomMeta).set({ ownerId: to, rev }).where(eq(roomMeta.roomId, this.meta.roomId)).run();
    this.meta = { ...this.meta, ownerId: to, rev };

    // Re-push the per-connection owner flag: the new owner's tabs gain the badge live; the
    // `from`-owner's tabs lose it (full lockout waits for reconnect — its anon id was rotated).
    for (const c of this.getConnections<ConnState>()) this.sendCustomMessage(c, `owner:${c.state?.userId === to ? '1' : '0'}`);

    return this.#projectMeta(this.meta); // enqueues ROOM_META + returns the SAME snapshot (double-write idempotent by rev)
  }

  /**
   * Tier-3 limiter gate (§10/H25): classify by the leading varuint (0=sync, 1=awareness,
   * MSG_LOCK=lock — all single-byte). Awareness over budget → DROP (the client smooths
   * cursors); lock over budget → DROP (the 15s lease heals), CLOSE only at 10× (a
   * deliberate flood of ~111KB frames); sync over budget → CLOSE (reconnect triggers a
   * clean Yjs resync; dropping a sync update would silently diverge since resyncInterval
   * is -1).
   */
  #gate(conn: Connection<ConnState>, type: number): number {
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
      s.lock = 0;
    }
    if (type === 1) return ++s.aware > AWARE_BUDGET ? DROP : OK;
    if (type === MSG_LOCK) return ++s.lock > LOCK_BUDGET ? (s.lock > LOCK_BUDGET * 10 ? CLOSE : DROP) : OK;
    return ++s.sync > SYNC_BUDGET ? CLOSE : OK;
  }

  override onMessage(conn: Connection<ConnState>, message: WSMessage): void {
    if (typeof message === 'string') {
      super.onMessage(conn, message); // y-partyserver __YPS: strings bypass the limiter
      return;
    }
    const u8 =
      message instanceof ArrayBuffer ? new Uint8Array(message) : new Uint8Array(message.buffer, message.byteOffset, message.byteLength);
    const verdict = this.#gate(conn, u8[0]);
    if (verdict === CLOSE) conn.close(1008, 'sync rate');
    else if (verdict === OK) {
      // Lock frames MUST be intercepted here — the base handleMessage switches only on
      // sync/awareness with no default, so an unhandled type would be silently dropped.
      if (u8[0] === MSG_LOCK) this.#onLockMessage(conn, u8);
      else super.onMessage(conn, message); // peek didn't consume — original buffer
    }
    // DROP → silently ignore
  }

  // --- Ephemeral object locks (advisory conflict-resolution grabs) -----------------------
  // Full-replace semantics both directions: a client's LOCK_SET declares "my set is now
  // exactly {ids}"; a broadcast LOCK_PEER_SET declares one peer's granted set. First-wins
  // arbitration by arrival order — a loser gets no denial message (the winner's earlier
  // broadcast, already in flight to it, IS the implicit denial; its commit guards heal).

  /** Lowest free int ≥ 2. Live connections' attachments ARE the free-list — a departed
   *  conn's key is absent from every live state; hibernation-retained conns contribute
   *  their persisted keys, so post-wake allocations never collide. */
  #allocLockKey(): number {
    const used = new Set<number>();
    for (const c of this.getConnections<ConnState>()) {
      const k = c.state?.lockKey;
      if (k !== undefined) used.add(k);
    }
    let key = 2;
    while (used.has(key)) key++;
    return key;
  }

  #onLockMessage(conn: Connection<ConnState>, u8: Uint8Array): void {
    this.#sweepLocks(); // lazy expiry — a contender's own frame frees stale locks before arbitration
    const key = conn.state?.lockKey;
    // Viewers ignored; the undefined check covers a socket raced past a 4401/4403 close in
    // onConnect (accepted but never stamped) — the one boundary-justified defensive check.
    if (key === undefined || this.isReadOnly(conn)) return;
    const ids = decodeLockSetBody(u8);
    if (ids === null) return; // malformed / over-cap — ignore the whole frame, never partially apply
    this.#applyLockSet(conn, key, ids);
  }

  #applyLockSet(conn: Connection<ConnState>, key: number, ids: readonly string[]): void {
    const next = new Set<string>();
    let changed = false;
    for (const id of ids) {
      if (next.has(id)) continue; // hostile duplicates
      const cur = this.#lockOwner.get(id);
      if (cur === undefined) {
        this.#lockOwner.set(id, key); // granted
        next.add(id);
        changed = true;
      } else if (cur === key) {
        next.add(id); // retained — not a delta
      }
      // owned by another → first-wins: silently not granted
    }
    const rec = this.#locks.get(conn);
    if (rec) {
      for (const id of rec.ids) {
        if (!next.has(id)) {
          this.#lockOwner.delete(id); // released = old \ new
          changed = true;
        }
      }
    }
    if (next.size === 0) this.#locks.delete(conn);
    else if (rec) {
      rec.ids = next;
      rec.last = Date.now(); // lease refresh — an unchanged resend broadcasts nothing
    } else {
      this.#locks.set(conn, { key, ids: next, last: Date.now() });
    }
    if (changed) this.#broadcastPeerSet(conn, key, next); // the full GRANTED set (full-replace)
  }

  /** Broadcast one peer's granted set to every OTHER editor connection. Sender never sees
   *  its own set (locked-by-me is a local 1 in its column); viewers are excluded. */
  #broadcastPeerSet(from: Connection<ConnState> | null, key: number, ids: ReadonlySet<string>): void {
    let frame: Uint8Array | undefined;
    for (const c of this.getConnections<ConnState>()) {
      if (c === from || this.isReadOnly(c)) continue;
      frame ??= encodeLockPeerSet(key, ids); // encode only if ≥1 recipient
      try {
        c.send(frame);
      } catch {
        // racing close — harmless, mirrors YServer's send()
      }
    }
  }

  /** One LOCK_PEER_SET per holding peer. Skips the target's own record — a client must
   *  never receive its own set under a peer key it can't recognize (the permission
   *  re-push path snapshots existing editors, whose records are in #locks). */
  #sendLockSnapshot(conn: Connection<ConnState>): void {
    for (const [holder, rec] of this.#locks) {
      if (holder === conn) continue;
      try {
        conn.send(encodeLockPeerSet(rec.key, rec.ids));
      } catch {
        // racing close — harmless
      }
    }
  }

  #releaseConnLocks(conn: Connection<ConnState>): void {
    const rec = this.#locks.get(conn);
    if (!rec) return;
    this.#locks.delete(conn);
    for (const id of rec.ids) this.#lockOwner.delete(id);
    this.#broadcastPeerSet(conn, rec.key, EMPTY_IDS);
  }

  /** Lazy lease expiry (>3 missed 15s re-announces), run on lock-message/connect/close.
   *  No alarm: post-hibernation the tables are empty anyway (a timed sweep would wake the
   *  DO to sweep nothing), and CF eventually closes dead hibernatable sockets → onClose.
   *  Residual: a crashed holder's grey lingers on fully-idle clients until the next room
   *  event — cosmetic for an advisory system. */
  #sweepLocks(): void {
    const now = Date.now();
    for (const [conn, rec] of this.#locks) {
      // Map delete-during-iteration is safe
      if (now - rec.last <= LOCK_STALE_MS) continue;
      this.#locks.delete(conn);
      for (const id of rec.ids) this.#lockOwner.delete(id);
      this.#broadcastPeerSet(conn, rec.key, EMPTY_IDS);
    }
  }

  /**
   * Hard flush when the last user leaves the room (complements debounced persistence,
   * prevents "lost last edits" on tab close). Drops the connection's limiter state.
   */
  override async onClose(connection: Connection<ConnState>, code: number, reason: string, wasClean: boolean): Promise<void> {
    // First let YServer prune the connection and awareness state.
    await super.onClose(connection, code, reason, wasClean);
    this.#rl.delete(connection);
    this.#releaseConnLocks(connection); // graceful close, CF-detected dead socket, 4403 eviction
    this.#sweepLocks();

    // If the room is now empty, flush the doc immediately (non-debounced). This runs on the
    // fresh instance after a hibernation wake too — onLoad re-hydrates the doc before onClose,
    // so the snapshot is whole. getConnections() yields only OPEN sockets; after super.onClose()
    // the departing socket is already excluded. We flush on ANY empty close.
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
