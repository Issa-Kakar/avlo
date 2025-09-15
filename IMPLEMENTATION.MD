# AVLO Implementation Guide - Phase 2 Onwards

## Phase 2: Core Data Layer & Models

### 2.1 Define Core TypeScript Types and Interfaces

- Create coordinate types (StrokePoint, bbox, SceneIdx, ULID aliases)
- Define document structures (Stroke, TextBlock, CodeCell, Output, Meta) per OVERVIEW.MD §4
- Create Snapshot and view types (immutable, frozen, never null)
- Add ViewTransform interface with world↔canvas conversion methods

### 2.2 Implement RoomDocManager Foundation

- Create RoomDocManager class with private Y.Doc instance (guid: roomId, never mutated)
- Initialize Y.Doc structure in single transaction (root → v, meta, strokes, texts, code, outputs)
- Set up helper methods that traverse root on demand (never cache Y references)
- Implement mutate(fn) wrapper with minimal guards (read-only ≥15MB, mobile, 2MB frame)

### 2.3 Implement Snapshot Publishing System

- Create EmptySnapshot generator (synchronous, non-null, frozen)
- Build snapshot pipeline: Y.Doc → filter by scene → convert to views → freeze
- Implement RAF-based publishing (≤60 FPS, dirty flags; **no `svKey`-based dedupe in Phase 6**)
- **Publish→clear policy (Phase 7)**: On each published Snapshot, the renderer calls `invalidateAll('snapshot')` to force a full clear. The DirtyRect infrastructure remains in place for future optimization but is bypassed here. Both presenceDirty and docDirty schedule rAF and a new Snapshot build.
- **svKey implementation**: Create safe state vector key using first 100 bytes + length + checksum to avoid stack overflow on large state vectors. Format: `btoa(first100bytes):length:checksum`. **We compute and attach it to each snapshot for diagnostics/tooling only; it is not consulted to decide whether to publish.**

### 2.4 Set Up Subscription Management

- Implement subscribeSnapshot with immediate callback on subscribe
- Add subscribePresence (throttled ≤30Hz, interpolation, dead-reckoning)
- Create subscribeRoomStats (null initially, updates on persist_ack)
- **COMPLETED BUT DEFERRAL**: Deferral (Phase 6): Boot splash is not implemented in this release. svKey is still computed but is _not_ used for publish/change detection in Phase 6; no splash is read or shown on boot. The minimal render cache remains write-only for now. Add minimal render cache (cosmetic only, NOT y-indexeddb)

## Phase 3: Basic Canvas Infrastructure

### 3.1 Set Up Canvas Element and Context

- Create Canvas React component with ref to DOM element
- Configure ResizeObserver, DPR handling, and 2D context
- Apply DPR once with setTransform(dpr,0,0,dpr,0,0) - never mix into view transforms

### 3.2 Implement Coordinate Transform System

**Note:** See OVERVIEW.MD §3.2 for authoritative transform formulas

- Define ViewTransform with scale and pan (world units)
- worldToCanvas: `(world - pan) * scale`
- canvasToWorld: `canvas / scale + pan`
- Context transform: `scale()` then `translate(-pan.x, -pan.y)`

### 3.3 Build Render Loop Foundation

- Create RAF-driven render loop subscribing to snapshots (ref, not state)
- Implement a DirtyRect tracker, but Phase 7 policy calls `invalidateAll('snapshot')` on every publish (and on presence/doc invalidations), effectively full-clearing each frame; keep DirtyRect infra for future use.
- Define render order: Background → Strokes → Stamps/Shapes → Text → Authoring overlays → Presence → HUD
- Apply 16ms frame budget with optional yielding

## Phase 4: Stroke Data Model & Rendering

### 4.1 Implement Stroke Rendering Pipeline

- Store points as flat `[x,y,x,y,...]` arrays (plain number[], never Float32Array in Y.Doc)
- Build Path2D cache per stroke.id (strokes immutable post-commit)
- Render strokes: strokeStyle=color, lineWidth=size (world units), globalAlpha=opacity
- Hairlines/HUD use `1/scale` for ~1 device pixel

### 4.2 Tool-Specific Rendering

- Pen: Standard rendering, round caps/joins
- Highlighter: opacity=0.25, normal blending (source-over)
- Respect scene order - no tool-based reordering

### 4.3 Performance Notes

- Skip strokes with bbox diagonal <2px in screen space
- Render cache (if present) is cosmetic only and unused by Phase 6

## Phase 5: Drawing Input System

### 5.1 Implement Pointer Event Handling

- Attach pointer events with setPointerCapture on down, release on up/cancel
- RAF-coalesce pointermove events with pendingPoint buffer
- Create DrawingTool class managing state, preview, and tool settings (frozen at pointerdown)
- Convert screen→canvas→world coordinates via ViewTransform
- Mobile detection: UA string + maxTouchPoints>1 for iPadOS

### 5.2 Build Preview Rendering

- Add setPreviewProvider() to RenderLoop for preview access
- Render preview at 0.35 opacity as authoring overlay (world coordinates)
- Invalidate old and new bounds on pointermove
- Mobile gets no preview (view-only enforcement)

### 5.3 Commit a Stroke

- Validate: minimum 2 points (4 values), flush pending points
- Apply Douglas-Peucker simplification in world units:
  - Base tolerance: pen 0.8, highlighter 0.5
  - Budgets: ≤128KB encoded, ≤10k points
  - Retry with tol\*=1.4 if over, then hard downsample
- Commit via mutate(): generate ULID, assign scene at commit, push to Y.Array

### Phase 6A: Offline-First Doc Persistence & Boot Gates (y-indexeddb + manager plumbing)

Local persistence policy (normative):
Persist the entire Y.Doc per room in IndexedDB under avlo.v1.rooms.<roomId>.
Initialize with new Y.Doc({ guid: roomId }) once; attach y-indexeddb immediately and do not wait to connect WS.
Never change guid. If remapping is required, create a new doc and apply updates.
Do not delete the room’s IDB data on leave; expose Delete local copy in My Rooms.

### 6A.1 Attach y-indexeddb (provider comes first)

#### 6A.1.1 Wire provider inside RoomDocManager

1. Import `y-indexeddb` and create a **room-scoped** provider using the existing `Y.Doc({ guid: roomId })`.
2. Instantiate **exactly once** per manager construction; never in UI components.
3. Use database name/keyspace derived from `roomId` (e.g., `avlo.v1.rooms.<roomId>`).
4. Register provider lifecycle handlers **inside** the manager (not UI):
   - Prefer `provider.whenSynced.then(() => mark IDB hydrate finished)`; if unavailable in your wrapper, listen **once** for `'synced'` and then mark finished.
   - Do not subscribe to a destroy event. Teardown is explicit: in the manager’s `teardown()`, call `await provider.destroy()` (best-effort), null out references, and leave `G_IDB_READY` unchanged. If your wrapper emits `'destroyed'`, you may log it in dev only; never gate behavior on it.

5. On first construction, do **not** assume any IDB content; the manager should already have created the root containers in a single transact earlier. The provider simply applies any stored ops.

#### 6A.1.2 Implement `G_IDB_READY` gate (2 s timeout)

1. Start a short timer (2,000 ms) when attaching the IDB provider.
2. 2. Open `G_IDB_READY` when `provider.whenSynced` resolves (or on the first `'synced'` event, if that’s what your wrapper exposes) **or** when the 2,000 ms timer elapses—whichever happens first.
3. On timeout, continue with an empty doc; keep the provider attached to apply late updates when the browser finishes spinning up IndexedDB.
4. Dev-only debug log; keep metric() calls as no-ops in prod.
5. Wrap provider creation in try/catch. On exception:
   Mark idb.initFailed = true, open G_IDB_READY immediately (fallback), continue with EmptySnapshot + rAF; keep drawing offline; log a dev-only debug line (no prod metric), and continue with the EmptySnapshot + rAF publisher; keep drawing offline. (If the page later gains IDB access, you can attempt a lazy attach.)

#### 6A.1.3 Dirty-flag integration for publish loop

1. When IDB applies a batch, flip the manager's **doc-dirty** flag and schedule the rAF publisher (if not already scheduled).
2. Rely on the **existing** snapshot pipeline to compute the `svKey` (first 100 bytes + length + checksum, NOT full state vector) and publish a frozen Snapshot on the next frame; do **not** special-case IDB vs WS. **In Phase 6, `svKey` is not used to suppress publishes; any doc-dirty event schedules a publish unconditionally.**
   **Why truncated svKey**: Full state vectors can be megabytes on large documents, causing stack overflow when converting to base64. The truncated format is deterministic and sufficient for cache invalidation while remaining performant.

**MVP pivot:** **Do not** read or write any render cache in Phase 6, and **do not** persist `lastKnownSvKey`. The render cache remains present in the codebase but is dormant.

### 6A.2 Boot discipline & first-paint guarantees

#### 6A.2.1 EmptySnapshot on construct (non-null from frame 0)

1. Ensure the manager constructs and stores a **non-null EmptySnapshot** synchronously at creation time(already done in Phase 2).
2. Immediately expose this snapshot to new subscribers (UI can render chrome, blank stage, and disabled buttons gated on `G_FIRST_SNAPSHOT` as needed).
3. Leave the rAF publisher **running from creation**, so the first doc-derived snapshot appears ≤ 1 frame after any Y update is applied (IDB or later WS).

**Boot behavior (MVP pivot).** Do **not** render any boot image. First paint is the **EmptySnapshot**, and the live, doc-derived snapshot follows as usual via rAF. No `lastKnownSvKey` exists in Phase 6.

#### 6A.2.2 rAF publisher discipline already in place

1. Keep the single rAF loop model (no multiple loops per provider).
2. Publish when **either** the manager is **doc-dirty** (Yjs applied updates or local edits) **or** the presence view changed (presence will be wired in a later phase; keep the hook points in place but inert).
3. **Remove the svKey-based publish optimization**: in Phase 6, if the manager is dirty, publish a new snapshot on the next rAF without comparing `svKey`. Note: svKey changes only when Y.Doc actually changes, making it a reliable change detector despite using a truncated format.

### 6A.3 Client config validation with Zod (boot-critical only)

#### 6A.3.1 Define `config.ts` schema

1. Add a `z.object({...})` schema for **boot-time** client config (env and constants actually read in Phase 6):
   - `VITE_WS_BASE` (string, required, e.g., `"/ws"` or absolute wss URL).
   - `VITE_API_BASE` (string, required, e.g., `"/api"`).
   - `ROOM_TTL_DAYS` (number, default 14, clamp to sensible bounds).
2. Export a `loadClientConfig()` that validates once at boot and returns **narrowed types**.

#### 6A.3.2 Fail-fast with friendly UI

1. If validation fails, show a small in-app error panel explaining the missing/invalid setting and disable network-dependent controls; offline editing from IDB can still proceed once Y is ready.
2. Log a single diagnostic (dev only).

### 6A.4 Minimal “Recent Rooms” readiness (unblocks UI later)

#### 6A.4.1 Gate the badge, not the feature

1. Expose a boolean “IDB ready” flag from the manager/registry so the **Recent Rooms** UI can show a badge only after `G_IDB_READY`.
2. Do **not** build the full list UX here; only ensure the signal exists so later phases can hook it without refactoring.

### 6A.5 Teardown & recovery hygiene

#### 6A.5.1 Deterministic teardown

On `destroy()` (synchronous implementation):

1. stop rAF
2. unobserve Y
3. if (wsProvider) { wsProvider.disconnect(); wsProvider.destroy(); wsProvider = null }
4. if (idbProvider) { idbProvider.destroy(); idbProvider = null }
5. try { ydoc.destroy() } catch {}
6. mark `this._destroyed = true` so subsequent calls are no-ops.

#### 6A.5.2 Concurrency assertions (dev-only)

1. Assert single manager per `roomId` in the registry.
2. Assert that no UI layer imports `yjs`/providers directly (ESLint `no-restricted-imports`).
3. Assert that provider attach happens **after** `Y.Doc` construction and before any WS attempts (to honor offline-first ordering once WS is introduced).

---

## Phase 6B: Server — y-websocket + Redis persistence + PostgreSQL/Prisma metadata

### 6B.1 Server foundation (Express)

#### 6B.1.1 App skeleton

1. Create an Express app that serves static files from `server/public` (Vite build output copied here).
2. Install middleware: JSON body parser (small limits), compression, basic security headers, and **CORS with an origin allowlist**.
3. Reserve `/ws/*` for WebSocket upgrade; reserve `/api/*` for REST; serve index.html for other GETs.

### 6B.2 Zod-validated environment

#### 6B.2.1 Define and validate `ServerEnv`

1. Create a Zod schema:
   - `PORT` (number, default 3000)
   - `ORIGIN_ALLOWLIST` (array of strings; include `localhost` dev entries)
   - `REDIS_URL` (string, required)
   - `DATABASE_URL` (string, required for Prisma)
   - `ROOM_TTL_DAYS` (number, default 14, clamp 1–90)
   - `WS_MAX_FRAME_BYTES` (number, default 2_000_000)
2. Parse at process start; **fail fast** with a readable log if invalid.

### 6B.3 Redis binding (authoritative storage)

#### 6B.3.1 Connect and harden

1. Initialize a Redis client (commands) and a separate pub/sub if needed later.
2. Configure reconnect backoff;
3. Ensure AOF is enabled at the deployment (infra) layer.
   Expiry behavior (normative): Redis TTL is the sole cleanup mechanism. The server never issues DEL/cron deletes. On missing key, treat the room as expired.

#### 6B.3.2 Persistence adapter

1. On `doc-update` from the WS server:
   1. **Yjs applies the incoming delta to the in-memory room Y.Doc** (the official y-websocket server already does this).
   2. **Serialize a fresh full snapshot** from the now-current Y.Doc using `encodeStateAsUpdate(ydoc)` (i.e., state-from-empty to current), **not** the incremental delta that just arrived.
   3. Gzip (level 4) the snapshot buffer and **SET with TTL** (`SET room:<id> <buf> EX <ttlSeconds>`) so Redis holds a single authoritative blob.
   4. Compute `size_bytes = buf.length` (compressed) and write the advisory metadata row in Postgres (`lastWriteAt`, `size_bytes`).
   5. Do **not** append logs of deltas; awareness is never persisted; TTL extends only on accepted writes.

### 6B.4 Prisma/PostgreSQL (non-authoritative metadata)

#### 6B.4.1 Schema & migration

1. Define `RoomMetadata` table with:
   - `id TEXT PRIMARY KEY` (room id)
   - `title TEXT NOT NULL DEFAULT ''`
   - `createdAt TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()`
   - `lastWriteAt TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()`
   - `size_bytes INTEGER NOT NULL DEFAULT 0`
2. Add an index on `(lastWriteAt DESC)`.
3. Run `prisma migrate dev` to generate the migration and apply locally.

#### 6B.4.2 Data contract

1. Treat this table as **advisory only**. If `room:<id>` is missing in Redis, **return 404** for metadata even if a row exists.
2. Update `size_bytes` and `lastWriteAt` **after** each successful doc persist.
3. Never store awareness or per-stroke rows.

### 6B.5 y-websocket server integration

#### 6B.5.1 Bind `@y/websocket-server` to `/ws/:roomId`

1. Mount the official server on the Express HTTP server; route by `roomId` path segment.
2. Enforce origin allowlist on upgrade; reject unknown origins early.
3. Configure inbound frame cap to **2 MB**; drop with close code if exceeded.

#### 6B.5.2 Room load & save hooks

1. On the first client join for a room, attempt `loadDoc(roomId)`; if present, apply to the in-memory Y.Doc that the WS server maintains for that room.
2. On each **doc update** event from the WS server, apply delta to in memory room Y.Doc, compute full state(i.e. from empty state),
3. `gzip(level=4)` the full state and `SETEX room:<roomId>`.
4. Update Prisma `size_bytes` with the **compressed** length and set `lastWriteAt`.
5. Extend TTL to `ROOM_TTL_DAYS` on each successful persist; do not extend on awareness/control messages. Extend TTL only on accepted writes.

#### 6B.5.3 Capacity & read-only enforcement (advisory)

1. Optionally cap peer count per room (small default). If capacity exceeded, mark the room **read-only** in a control envelope so clients can show a banner (writes are still accepted locally and merge later when a slot opens).
2. Keep enforcement simple (single process, no cluster).

### 6B.6 HTTP API (Zod-guarded)

#### 6B.6.1 Create room

1. `POST /api/rooms` → allocate canonical `roomId` (ULID), insert `RoomMetadata`, **do not** pre-create Redis key.
2. Return `{ id, title: "", createdAt, lastWriteAt, size_bytes: 0 }`.

#### 6B.6.2 Read metadata

1. `GET /api/rooms/:id/metadata` → check Redis key; if missing, respond **404** (expired).
2. If present, read Prisma row; if missing row, create a minimal one on the fly to avoid client confusion.
3. Return `{ id, size_bytes, expires_at: now + TTL, title, createdAt, lastWriteAt }`.

#### 6B.6.3 Rename room

1. `PUT /api/rooms/:id/rename` with `{ title: string ≤ 120 }`.
2. Validate with Zod; update Prisma; return the new title.

#### 6B.6.4 List rooms (optional)

1. `GET /api/rooms?limit=…` for server-side lists (useful in admin/dev).
2. This is **not** the “My Rooms” UX (that remains device-local), but it is convenient for tests and demos.

### 6B.7 Backpressure & slow-socket policies (WS-only scope)

1. Enforce the 2 MB inbound frame cap at the gateway; close misbehaving clients.

2. **Out of scope (MVP).** Do not implement server slow-socket handling. Run the official `@y/websocket-server` unchanged; rely exclusively on client-side skipping of awareness frames based on `WebSocket.bufferedAmount`.

### 6B.8 Health

1. `GET /healthz` returns 200 + simple Redis ping.

---

## Phase 6C: Client — WebSocket provider, metadata wiring (TanStack Query), gates & failure modes

### 6C.1 Attach y-websocket provider (client)

#### 6C.1.1 Provider construction & order

1. After attaching `y-indexeddb`, **connect WebSocket immediately**; do **not** wait for `G_IDB_READY`.
2. Build the WS URL from validated `config.VITE_WS_BASE` and `roomId` (exact `/ws/<roomId>` mapping).
3. Instantiate the WS provider **with the same Y.Doc** and **shared awareness instance placeholder** (awareness features remain unused until a later phase).

#### 6C.1.2 Connection gates

1. Open `G_WS_CONNECTED` when the underlying socket opens.
2. Open `G_WS_SYNCED` when the first Yjs sync (state-vector exchange / `syncStep2`) completes.
3. Keep drawing enabled regardless (offline-first). The existing write guards already block when the room is server-declared read-only.

#### 6C.1.3 Event wiring (provider-agnostic observers)

1. Register **all** Y.Doc observers only once inside the manager (already established pattern).
2. Do **not** add extra doc listeners from providers; treat them as transport only.
3. On “doc update” from WS provider, flip the **doc-dirty** flag; the rAF loop will publish the next frame.

#### 6C.1.4 Reconnect & offline handling

1. If the socket closes, continue offline with IDB; queue CRDT ops locally (Y handles this).
2. 2. Show a **connection indicator** based on `G_WS_CONNECTED` and `G_WS_SYNCED`: Online / Offline / Read-only. Do **not** show “Reconnecting”.
3. On reconnect, let Yjs merge; no special client logic needed beyond gates.

### 6C.2 Room stats & metadata (TanStack Query v5)

#### 6C.2.1 Query keys and fetchers

1. Define query keys:
   - `["rooms","metadata", roomId]`
   - `["rooms","list"]` (if a simple server list UI is later added)
2. Implement fetchers against:
   - `GET /api/rooms/:id/metadata` (returns `{ size_bytes, expires_at, ... }`).
3. Configure QueryClient defaults: `staleTime: 10_000`, `retry: 1`, `refetchOnWindowFocus: false`.

#### 6C.2.2 Bridge to RoomDocManager stats

1. On successful metadata fetch, call the manager’s internal setter to update the **RoomStats** stream (`bytes`, `cap`, optional `expiresAt`).
2. The existing `subscribeRoomStats` will propagate to the UI (header pill at 13 MB, banner at 15 MB).
3. If the endpoint returns 404 (expired), set stats to `null`, surface a banner explaining expiry, and leave the local IDB copy intact for “create new from local” later.
   Do not recreate keys from Postgres; 404 is final.

#### 6C.2.3 Invalidation policy

1. Invalidate `["rooms","metadata", roomId]` after a confirmed persist-ack (if/when the server emits one) **or** poll every ~10 s as a fallback.
2. Do **not** spam invalidations on every local write; rely on the poll or ack.

### 6C.3 Create/join glue (client side)

#### 6C.3.1 Join flow (server room)

1. Parse `roomId` from the URL.
2. Attach IDB provider, then WS provider immediately.
3. Kick off a metadata query; render content from IDB/WS as it arrives; gates handle feature availability.

#### 6C.3.2 Local-first room → publish later (hook points only)

1. Ensure the manager exposes `extendTTL()` (already present) so the UI can surface an **Extend** control when online.
2. Leave full “create local → publish” and alias mapping UX to the dedicated Room Lifecycle phase; only maintain the function signatures here so later phases don’t reshuffle the manager API.

### 6C.4 Failure modes & user feedback

#### 6C.4.1 Gate-driven UI

1. **Before `G_WS_CONNECTED`**: allow drawing (offline), disable actions that require the server (TTL extend).
2. **Before `G_WS_SYNCED`**: render from IDB snapshot; (No special UI indicator) Keep rendering from local/IDB until `G_WS_SYNCED` opens.
3. **IDB timeout**: continue with EmptySnapshot; a late IDB apply will flip the doc-dirty flag and publish.

#### 6C.4.2 Network & size errors

1. If the server enforces read-only (capacity or size), reflect that via the existing banner logic; writes remain accepted locally but won’t persist server-side until policy clears.
2. If a metadata fetch fails transiently, retry silently; do not block drawing. Optionally flip the connection indicator to Offline until the next successful fetch.

### 6C.5 Client boundary validation with Zod (HTTP & WS control)

#### 6C.5.1 HTTP schemas

1. For `/api/rooms/:id/metadata`, define a Zod response schema; parse on receipt and surface a typed object to TanStack Query.
2. For `/api/rooms/:id/rename` (wired later in the UI), define request/response schemas now to avoid future churn.

#### 6C.5.2 WS control envelopes (future-proofing)

1. Prepare a tiny Zod schema for any non-CRDT WS control envelopes you may use (e.g., server read-only notifications).
2. Parse before acting; ignore unknown fields gracefully.

**Teardown order (room leave, toggle to WS-only, tab close):**

1. **Stop awareness publisher** → 2) **Destroy RTC provider** (not in this phase) → 3) **Unsubscribe awareness listeners** →
2. **Leave/close WS** (doc provider remains authoritative path) → 5) **Flush pending mutations** → 6) **Close IDB (optional)**.Guarantee all public calls after `destroy()` are no-ops (guard every public method with `if (this._destroyed) return;`).

TODO IN FUTURE PHASE 7: **`G_AWARENESS_READY`** opens when WS connected (no timeout, no remote state requirement). Cursors/presence render only when both `G_AWARENESS_READY && G_FIRST_SNAPSHOT`. When offline: presence is best-effort; cursors simply hide

---

## Phase 6D: UI Integration & Routing

### 6D.1 Gate Subscription System

**Critical Fix**: Prevent infinite re-render loops by using stable primitive snapshots with `useSyncExternalStore`.

- Add `subscribeGates()` method to RoomDocManager with 150ms debounce
- Return string primitives (`"0|1|0|1|1"`) instead of objects for referential stability
- Use `queueMicrotask` to defer callbacks, avoiding synchronous state updates
- Call `notifyGateChange()` when gates change (IDB ready, WS connected/synced, first snapshot)

### 6D.2 React Router Integration

- Routes: `/` (test harness), `/room/:roomId` (dynamic rooms), `/test` (alt test path)
- Extract CanvasWithControls to RoomPage component
- Use `useParams()` for dynamic room ID, replace hardcoded 'test-room-001'
- Wrap with ViewTransformProvider, reset view on room change

### 6D.3 Zustand Store Integration

Create guarded `toolbarToDeviceUI` adapter:

- Default unknown tools to 'pen', clamp size 1-64, validate hex colors
- Wire Canvas.tsx to use Zustand store instead of static deviceUI
- Tool state frozen at pointer-down (existing DrawingTool mechanism)

### 6D.4 UI Components

- **Toolbar**: Pen/highlighter buttons, size slider, color picker (others disabled)

### 6D.5 Mobile Support

MobileViewOnlyBanner using UA string + maxTouchPoints detection.

## Phase 7: Awareness & Presence System (WS-only, Phase-6-style expansion)

> **Scope.** Implement end-to-end awareness over **y-websocket only** (no WebRTC in this phase), with throttled send, smoothed receive, **cursor + minimal trails**, and a **header badge roster**. Awareness is **ephemeral** (never persisted), injected into published **Snapshots**, and exposed via `subscribePresence`. Rendering follows the established gates: draw presence only when **both** `G_AWARENESS_READY` **and** `G_FIRST_SNAPSHOT` are open. WebRTC is deferred to a later phase.

---

### 7A: Transport & Manager Ownership (WS authoritative; RTC deferred)

#### 7A.1 Single-owner awareness (manager only)

1. **RoomDocManager** constructs exactly one **awareness** instance bound to its existing `Y.Doc`. UI **must not** import Yjs/providers directly. Awareness lifetime equals the manager's lifetime. Presence is also injected into every published **Snapshot** (`snapshot.presence`).
2. **Import note:** Use `import { Awareness as YAwareness } from 'y-protocols/awareness'` (don't import from y-websocket) to avoid colliding with the app's Awareness type.
3. Public surface (unchanged):
   - `subscribePresence(cb)` (throttled view emission).
   - Presence derived view is included in Snapshots published ≤ 60 FPS.&#x20;

#### 7A.2 Provider wiring & gates (WS-only in this phase)

1. **Attach y-websocket awareness immediately** after WS connect; open `G_WS_CONNECTED` on socket open and `G_WS_SYNCED` after first state-vector sync. Awareness frames may flow as soon as `G_WS_CONNECTED` is open.
2. **Awareness readiness**:
   - **Opens** `G_AWARENESS_READY` when **WS connected** (no timeout, no remote state requirement)
   - **Closes** `G_AWARENESS_READY` when **WS disconnected** (immediate, clears local state)
   - Presence UI renders only when `G_AWARENESS_READY && G_FIRST_SNAPSHOT`
   - When `G_FIRST_SNAPSHOT` flips true, force one render to flush any queued presence
   - When `G_AWARENESS_READY` flips false, presence dirty triggers to hide cursors immediately
   - **Gate transitions:** Open `G_AWARENESS_READY` on WS connected and close immediately on disconnected, then `setLocalState(null)` and clear cursor trails so cursors vanish right away. When either `G_FIRST_SNAPSHOT` or `G_AWARENESS_READY` flips true after the other, mark presence dirty to flush once (prevents cursor invisibility when awareness leads/follows the first snapshot)
3. **Teardown** on leave: stop awareness publisher → unsubscribe awareness listeners → close WS (doc provider remains authoritative path) → keep IDB. All public calls after `destroy()` are no-ops.
4. **RTC status**: Any prior “Optional RTC probe/Peer Mode” copy is **out of scope** here and moved to the future RTC phase. Keep the UI in **Server** mode.

### 7B: Local (sender) pipeline — identity, cadence, and emit rules

#### 7B.1 Per-tab identity & profile (no custom names in MVP)

1. Generate a stable **per-tab `userId`** (ULID) on manager construct; store in memory only.
2. **Profile** defaults: `{ name, color }`.
   - `name`: random from **"adjective + animal"** lists (ASCII; sanitized; ≤40 chars). Generated using `crypto.getRandomValues()` for unpredictability. This avoids PII and generates fresh labels on each tab load. **UI does not allow changing the name in Phase 7.**&#x20;
   - `color`: random from a fixed palette using `crypto.getRandomValues()`; vetted `#RRGGBB` values; optional UI to change color is allowed.

3. **Local awareness payload** (never persisted):

   ```ts
   { userId, name, color,
     cursor?: { x, y },              // world coords (desktop only)
     activity: 'idle' | 'drawing' | 'typing',
     seq: number,                    // monotonic per-sender
     ts: number,                     // ms epoch
     aw_v?: number }                 // awareness version for evolution
   ```

#### 7B.2 Activity sources

- **Cursor**: on `pointermove` over the stage, compute **world** coords via current `ViewTransform`; schedule emit. **No cursor emits on mobile** (view-only).
- **Pointer leave / off-stage**: when the local pointer leaves the drawable stage (or pointer capture ends while not over stage), set cursor to undefined in the full awareness state; do not retain the last position. This ensures remote peers stop drawing the dot/label immediately; their trails will age out naturally. (Mobile still emits no cursor.)
- **Activity**:
  - `drawing` between pointerdown…pointerup (DrawingTool).
  - `typing` while Monaco editor focused.
  - `idle` otherwise (window blur sets `idle` immediately).&#x20;

#### 7B.3 Cadence & **client backpressure**

1. **Interval** (derived by peer count):
   `interval = clamp(90ms + 3ms * max(0, N - 10), 75ms, 150ms)` with ±10 ms jitter; trailing-edge coalescing.
   This yields **~10–13 Hz** in small rooms and **~6–7 Hz** as N grows.
2. **WS backpressure (client)**:
   - If `WebSocket.bufferedAmount > 64 KB` → **skip** this awareness frame (freshness over reliability).
   - If `≥ 256 KB` → keep skipping until it drains **below 64 KB**.
3. **Hidden tab**: timers naturally drop to ~8 Hz via rAF throttling; no extra timers.
4. **Low FPS/Battery**: manager may halve sender rate when render loop reports < 30 FPS sustained.

#### 7B.4 Heartbeats

- **No app-level pings**. When state doesn’t change, we stay silent. Liveness derives from receive-side and provider disconnects.

### 7C: Receive pipeline — ordering, smoothing, **no fade staleness**

#### 7C.1 Ingest & ordering

- Keep `Map<userId, PeerPresence>` with last accepted `{seq, ts, cursor, activity, name, color}`.
- Drop frames with `seq <= last.seq` from that sender (arrival order + seq wins; `ts` advisory).&#x20;

#### 7C.2 Smoothing & prediction

- Store last two **world** points & velocities; project to canvas **per frame** using current `ViewTransform`.
- Lerp 1–2 frames between updates; **one-frame dead-reckon** on a missed tick. Avoid double-smoothing with trails.&#x20;

#### 7C.3 Staleness policy (no stale fade; hide on leave/absent cursor)

- **Dot/label visibility**: show a peer's dot + tiny name only when that peer's cursor is present in the latest accepted awareness state. If cursor is absent (sender left the stage) or the peer disconnects, hide the dot/label immediately.
- **Trails**: receivers keep a rolling world-space buffer that fades by age (α = exp(-(now - t)/τ)), and naturally disappears once points age out.
- **No "fade to invisible" due to staleness**: we never keep a frozen cursor on screen; visibility is strictly tied to cursor presence or connection state.
- **Roster presence**: show only a roster list once clicked on, and a **header badge** in the corner. **No "connected for 15 s" grace and no "away" state**; remove the peer immediately when leave/disconnect is reported.&#x20;

#### 7C.4 Deriving the `PresenceView`

- On any accepted awareness update **or** transform change, mark **awareness-dirty**.
- Next rAF, compute readonly `PresenceView`:

  ```ts
  interface PresenceView {
    users: Map<UserId, { name; color; cursor?; activity; lastSeen }>;
    localUserId: UserId;
  }
  // Note: counts (total, drawing, typing, idle) are trivially derived at render time
  // as demonstrated in UsersModal component
  ```

  Inject into the published **Snapshot** (`snapshot.presence`).

---

### 7D: Rendering & UI (single canvas + **header badge roster**)

#### 7D.1 Single-canvas renderer (NO overlay)

**CRITICAL Architecture**: All rendering on ONE canvas via two RenderLoop passes:
- **Pass 1**: World content (world transform) - strokes, shapes, text, authoring overlays
- **Pass 2**: Presence overlays (screen space, DPR-only) - cursors and trails

**File Structure**:
- `renderer/RenderLoop.ts`: Orchestrates both passes, provides `getGates()` integration point
- `renderer/layers/presence-cursors.ts`: `drawCursors()` implementation with trail management
- `renderer/layers/index.ts`: `drawPresenceOverlays()` gate check → `drawCursors()` call
- `canvas/Canvas.tsx`: Supplies gates via `getGates: () => roomDoc.getGateStatus()`

1. Render order: world → authoring overlays → **presence** → HUD. Export excludes presence.
2. **Cursor glyph (tiny pointer, not a dot)**:
   - Draw in screen space at cursorCanvas {x,y} (DPR-aware). Size fixed in CSS px (does not scale with zoom).
   - Shape: OS-style arrow pointer (tip at {x,y}). Bounding box ≈ 10–12 px tall × 7–9 px wide.
   - Path: triangular head + short tail; 1 px outline (black at 30–40% alpha) to preserve contrast over light/dark canvases; fill = user color.
   - Hotspot alignment: pointer tip = cursorCanvas. Do not rotate with view; presence is UI chrome.
   - Hidden when cursorCanvas is undefined (e.g., pointer left stage or peer absent).
3. **Name label**: **always on and tiny** (≈10–11 px, rounded pill, minimal padding) placed right and slightly below the pointer tail to avoid covering the tip; text clamped, sanitized, and ensures ≥4.5:1 contrast. (No hover requirement; avoids extra hit-testing.)&#x20;
4. **Draw condition**: Render a dot/pointer + label only for peers whose cursorCanvas is defined (derived from cursor via current ViewTransform). If undefined, skip drawing dot/label for that peer.

#### 7D.2 **Cursor trails** (kept; minimal, adaptive)

1. **Trail management**: `cursorTrails` Map in `presence-cursors.ts` stores per-peer rolling buffer of **world-space** `{x,y,t}` points; trim older than **600 ms (MAX_TRAIL_AGE)** or beyond buffer size. Quantize to **0.5 world units**; interpolate 1–2 points on gaps > 60 ms.
2. On render, transform world→canvas via current `ViewTransform`; draw a simple polyline each frame with alpha decay `exp(-(now - t)/τ)` where τ≈240–320 ms (TRAIL_DECAY_RATE); stroke 1–2 px; `butt` caps, `round` joins.
3. **Cursor absent behavior**: On receiver, stop appending to a peer's trail when their cursor is absent; the existing trail points continue to render with age-based alpha until trimmed (≤600 ms), then disappear. `clearCursorTrails()` called on disconnect/room change.
4. **Degrade rules**:
   - `peerCount > 10` → cap to **≤12** points.
   - `peerCount > 25` **or** FPS <30 → **disable trails** (pointer-only).
   - Respect `prefers-reduced-motion`: pointer-only.&#x20;

#### 7D.3 **Roster / header badges** (minimal)

1. Subscribe to `PresenceView`; render a compact **header badge** per connected peer (`{name, color}` chip). When a user leaves, **their badge disappears immediately**. No “away” or post-disconnect grace.&#x20;
2. Show **user count** and a tiny activity micro-legend (✏️ drawing N, ⌨️ typing M); **cap updates to ≤1 Hz**.&#x20;

---

### 7E: Policies — cadence, **backpressure (client-only)**, privacy

#### 7E.1 Cadence & degrade (sender + manager)

- **Sender (network):** ~75–100 ms (~10–13 Hz) in small rooms, degrading toward **~150 ms** (~6–7 Hz) as peers increase; ±10 ms jitter; trailing-edge coalescing.
- **UI publish:** `subscribePresence(cb)` is throttled to **≤ 30 Hz** to protect React. (This is **not** the network send rate.)

#### 7E.2 **Backpressure (client-only)**

- **Best-effort rule:** Before emitting, try to read `WebSocket.bufferedAmount`.
  - If you can read it and it's > 64 KB, skip this awareness frame (freshness over reliability).
  - If it's ≥ 256 KB, temporarily degrade send rate to ~6–7 Hz and keep skipping until it drains below 64 KB, then restore the base rate (~10–13 Hz).
  - If you cannot access the socket or bufferedAmount (provider internals, race, not OPEN), do not treat that as backpressure—proceed to send.
  - This keeps presence alive even if internals shift.
- **No server slow-socket policy;** no custom broadcaster; keep official `@y/websocket-server`.
- **Yjs doc updates** are not app-coalesced; rely on provider behavior.

#### 7E.3 Privacy & PII minimization

- Awareness never leaves volatile server memory; Redis/Postgres store **doc only**. Clamp name length (≤40), sanitize visible characters only; colors from vetted palette; random fallback names are ephemeral per-tab.

#### 7E.4 Mobile policy

- Mobile is **view-only** for doc writes; awareness **send** is minimal (name/color/activity=`idle` only). No cursor emits from mobile. Show roster and remote cursors normally.

---

### 7F: Failure modes & recovery

1. **WS loss**:
   - **G_AWARENESS_READY closes immediately** on disconnect
   - Cursors/labels hide immediately (gated by G_AWARENESS_READY && G_FIRST_SNAPSHOT)
   - Trails fade naturally based on age (600ms max)
   - Local awareness state cleared (setLocalState(null))
   - Clear cursor trails to prevent stale visuals/memory
   - Header shows Offline
   - On reconnect, G_AWARENESS_READY reopens, presence resumes
   - Writes continue offline via IDB (document persistence unaffected)
2. **Clock skew**: rely on `seq` ordering; treat `ts` as advisory.&#x20;
3. **Duplicate tabs**: each tab has its own `userId`; roster shows both; future enhancement may group by `name`.

---

### 7G: Manager internals & contracts

#### 7G.1 Private fields

- `_awareness`: WS provider awareness instance.
- `_presence`: `Map<userId, PeerPresence>` + **rolling trail buffers**.
- `_localProfile`: `{ userId, name, color }` (per-tab; device-local).
- `_awarenessDirty`: boolean.
- `_sendTimer`: cadence controller with jitter/skip logic.
- `_seq`: monotonically increasing per sender.
- `_cursorLocalWorld`: last world cursor (desktop only).
- `_activity`: `'idle'|'drawing'|'typing'`.&#x20;

#### 7G.2 Public API

- `setLocalProfile({ color? }: { color?: string })`: validate color, throttle, update awareness. Name is locked to the random fallback in Phase 7; attempts to set a custom name are ignored (no UI for it).
- `subscribePresence(cb)`: emits derived `PresenceView` (≤30 Hz).
- `getGateStatus()`: includes `G_AWARENESS_READY`.&#x20;

#### 7G.3 Send loop (pseudo-spec)

1. Mark dirty immediately; actually send once the awareness gate is open (prevents accidental pre-gate sends)
2. On profile/cursor/activity change: mark dirty and schedule send; if `G_AWARENESS_READY` is closed, keep dirty and retry after it opens.
3. Only when sending: bump `seq`, set `ts = now`, and call `awareness.setLocalState({...})` with the complete payload.
4. Mobile shaping: on mobile, omit cursor and fix `activity='idle'` even if local UI toggles.
5. Quantization: quantize cursor to 0.5 world units before the equality check to avoid sub-pixel churn.
6. If WS backpressured per 7E.2, **skip** and coalesce to next tick.&#x20;

#### 7G.4 Receive hooks

- Subscribe once to provider’s awareness updates; per change: validate, clamp numbers, ignore self, apply `seq` ordering, update `_presence`, refresh trail buffer, set `_awarenessDirty = true`.

### 7H: Rendering details & accessibility

- Same canvas for cursors and strokes, `<canvas>` is DPR-aware; cleared once per frame. Fonts match app typography; label contrast ≥4.5:1.
- Keyboard: no cursor when keyboard-only in UI; `U` toggles roster; do not trap focus.

### 7I: Telemetry (dev only)

- Counters: `aw.send.hz`, `aw.recv.drop.seq`, `aw.skip.backpressure`, `trail.enabled`, `trail.points`, `trail.dropReason`.
- Debug overlay (dev only): draw tiny dots for received vs predicted; show per-peer update age.
- No PII in logs; redact names to initials.&#x20;

### 7K: Non-goals (Phase 7)

- WebRTC awareness or Peer Mode UI (deferred).
- Persisting awareness to Redis/Postgres.
- images or external profile services.
- Presence-driven permissions/moderation.&#x20;

### 7L: Implementation notes & cross-phase alignment

- **Publisher discipline**: publish a new **Snapshot** on **doc-dirty or awareness-dirty** at ≤60 FPS; **never** gate on `svKey` in this MVP; publishing even identical frames is acceptable per Phase 6/Appendix 24. Awareness changes mark manager dirty same as doc changes, triggering snapshot publish on next rAF.
- **Awareness→Render Pipeline**: RoomDocManager receives awareness → `buildPresenceView()` with interpolation → inject into `snapshot.presence` → RenderLoop reads snapshot → `drawPresenceOverlays()` checks gates → `drawCursors()` renders if both gates open.
- **Gating**: Single render guard - draw cursors/presence ONLY when `G_AWARENESS_READY && G_FIRST_SNAPSHOT`. Presence intake never stops. Force one flush when `G_FIRST_SNAPSHOT` flips true. Exports/minimap remain gated by `G_FIRST_SNAPSHOT`.&#x20;
- **Backpressure policy** is client-only; no server fork and no slow-socket logic on the server.&#x20;
- **UI changes applied per prior discussion**: pointer/label are **visible only while cursor is present**; no 'fade to invisible' staleness. **Retain trails** with age-based fade, and show **header badges** only (no "away" state).&#x20;
- **RTC**: explicitly deferred; revisit in the dedicated WebRTC phase; reuse the **same** `bufferedAmount` skip semantics on RTC data channels when implemented.&#x20;

### 7M: Cursor Interpolation (Receiver-side smoothing)

Eliminates cursor jitter by doing **receiver-side interpolation** inside `RoomDocManager` (not renderer):

#### 7M.1 Architecture
- **Manager-owned**: All smoothing logic in `RoomDocManager`, renderer just draws `snapshot.presence`
- **Per-peer state**: Track `PeerSmoothing` with `lastSeq`, `prev/last` samples, animation state
- **Constants**: `INTERP_WINDOW_MS = 66` (~1-2 frames), `CURSOR_Q_STEP = 0.5` world units

#### 7M.2 Ingest algorithm (`ingestAwareness`)
- Drop stale/duplicate frames using `seq <= lastSeq` check
- Quantize to 0.5 world units at ingest (matches sender)
- **Gap detection**: If `seq > lastSeq + 1`, snap immediately (no lerp) to avoid rubber-banding
- **Sequential samples**: Start 66ms lerp window, set `presenceAnimDeadlineMs`
- Clear state when cursor absent (peer left stage)

#### 7M.3 Display computation (`getDisplayCursor`)
- During lerp window: Linear interpolation from `displayStart` to `last` sample
- Outside window: Show last accepted position
- Return `undefined` when `!hasCursor` (hide immediately)

#### 7M.4 Publishing discipline
- **RAF keep-alive**: Force `presenceDirty = true` while `now < presenceAnimDeadlineMs`
- Ensures animation frames publish even without new awareness updates
- `buildPresenceView()` calls `getDisplayCursor()` for smoothed world coords

#### 7M.5 Renderer discipline
- **No double-smoothing**: Renderer draws positions as-is from `snapshot.presence`
- Trails consume smoothed positions naturally
- `clearCursorTrails()` on disconnect (manager calls this)

#### Appendix: Random fallback names (ephemeral)

- **Generation**: `name = Adjectives[randomValues[0] % A] + ' ' + Animals[randomValues[1] % B]` using `crypto.getRandomValues()` (lists curated, ASCII only).
- **Policy**: sanitize; clamp to ≤40 chars; ephemeral per-tab; **broadcast** via awareness. **Name is not user-editable in Phase 7**. **No persistence** to localStorage or server/DB.

## Phase 8: RBush Spatial Indexing

**Deferred.** Interfaces may remain reserved (e.g., `spatialIndex`) but are not populated because of deferral; the eraser uses a linear bbox scan over the Snapshot for now.

## Phase 9: UI Components & Toolbar

## Phase 10: Eraser

- **Whole-stroke eraser**: perform hit-test by linear bbox scan across `snapshot.strokes`; on hit, delete the entire stroke in a single transaction.
- **RBush deferred**: spatial indexing will be introduced in Phase 8; keep any index-related interfaces as placeholders.

## Phase 9: UI Components & Toolbar

### 9.1 Build Toolbar Structure

#### 9.1.1 Create Toolbar Container
1. Position toolbar on left side
2. Implement expand/collapse behavior
3. Add keyboard navigation support
4. Store expanded state locally
5. Apply responsive design for mobile

#### 9.1.2 Implement Tool Buttons
1. Create buttons for pen, highlighter, eraser, text, Stamp
2. Add active state styling
3. Implement tool switching logic
4. Show keyboard shortcuts in tooltips
5. Disable tools based on permissions

### 9.2 Add Tool Controls

#### 9.2.1 Create Size Slider
1. Add range input for stroke size
2. Show current value display
3. Store per-tool size settings
4. Apply min/max constraints
5. Update preview on change

#### 9.2.2 Implement Color Picker
1. Create color palette grid
2. Add custom color input
3. Store recent colors
4. Show current selection
5. Update tool color on selection

### 9.3 Persist Toolbar State

#### 9.3.1 Set Up Local Storage
1. Define toolbar state structure
2. Create versioned storage key
3. Save state on changes
4. Load state on initialization
5. Handle migration between versions

## Phase 10: Eraser & Clear Board

### 10.1 Implement Whole-Object Eraser

#### 10.1.1 Create Eraser Hit Detection
2. Find strokes under pointer
3. Highlight strokes on hover
4. Track strokes to delete
5. Show eraser cursor

#### 10.1.2 Execute Batch Deletion
1. Collect stroke IDs to remove
2. Call mutate with delete operation
3. Remove from strokes array in transaction

5. Clear eraser preview

### 10.2 Build Clear Board Feature

#### 10.2.1 Implement Scene Tick Mechanism
1. Add scene tick to meta array
2. Increment current scene counter
3. Filter rendering by scene
4. Exclude from undo manager


## Phase 11: Text & Stamps

### 11.1 Implement Text Input System

#### 11.1.1 Create Text Tool Mode
1. Switch to text cursor on selection
2. Show text input on click
3. Position at click location
4. Apply current text settings
5. Focus input automatically

#### 11.1.2 Handle Text Commit
1. Capture text content on blur/enter
2. Enforce 500 character limit
3. Create TextBlock object
4. Assign current scene
5. Commit via mutate method

### 11.2 Add Stamp Tools

## Phase 12: Undo/Redo System

### 12.1 Configure UndoManager

#### 12.1.1 Initialize Yjs UndoManager
1. Create UndoManager in RoomDocManager
2. Configure tracked types (strokes, texts)
3. Set up per-user origin tracking
4. Exclude scene ticks from scope
5. Set maximum undo stack size

#### 12.1.2 Wire Up Keyboard Shortcuts
1. Listen for Ctrl/Cmd+Z for undo
2. Add Ctrl/Cmd+Shift+Z for redo
3. Prevent default browser behavior
4. Check if operations available
5. Update UI button states

### 12.2 Implement Undo/Redo Operations

#### 12.2.1 Execute Undo Operation
1. Check if undo stack has items
2. Call undo with user origin
3. Let Yjs handle state reversal
4. Trigger snapshot update
5. Show operation feedback

## Phase 13: Room Lifecycle Management

### 13.1 Implement Room Creation

#### 13.1.1 Create Local Room
1. Generate local-prefixed ULID
2. Initialize Y.Doc with ID
3. Mark as provisional in storage
4. Add to My Rooms list
5. Enable offline editing

#### 13.1.2 Publish to Server
1. POST to /api/rooms endpoint
2. Receive server room ID
3. Create alias mapping
4. Connect WebSocket provider
5. Merge local changes

### 13.2 Handle Room Joining

#### 13.2.1 Implement Join Flow
1. Parse room ID from URL
2. Check for local alias
3. Fetch room metadata
4. Connect WebSocket
5. Load initial state

#### 13.2.2 Enforce Capacity Limits
1. Check room size from metadata
2. Show warning pill at 13MB
3. Block writes at 15MB
4. Display read-only banner
5. Allow view-only access

### 13.3 Manage TTL Extension

#### 13.3.1 Create Extension Mechanism
1. Add extend button in UI
2. Perform minimal write operation
3. Update TTL by configured days
4. Show new expiry date
5. Rate limit extensions

## Phase 14: Export 

### 14.1 Implement PNG Export

#### 14.1.1 Create Export Pipeline
1. Calculate bounds of all content
2. Create offscreen canvas
3. Apply white background
4. Render strokes and text
5. Exclude UI overlays

#### 14.1.2 Handle Export Options
1. Offer viewport or full board
2. Apply maximum dimension limit (8192px)
3. Add padding around content
4. Fall back to viewport if too large
5. Show progress indicator

## Phase 15: Code Execution System

### 15.1 Integrate Monaco Editor

#### 15.1.1 Set Up Monaco

#### 15.1.2 Implement Editor UI

### 15.2 Build Execution Environment

#### 15.2.1 Create JavaScript Executor

#### 15.2.2 Add Python Support

## Phase 16: Service Worker & PWA

### 16.1 Implement Service Worker

#### 16.1.1 Create Service Worker Registration

#### 16.1.2 Configure Caching Strategies

### 16.2 Enable PWA Features

#### 16.2.1 Create Web App Manifest

#### 16.2.2 Implement Install Flow

## Phase 17: WebRTC & P2P (Optional Enhancement)

### 17.1 Add WebRTC Provider

#### 17.1.1 Initialize WebRTC

#### 17.1.2 Implement Probe Mechanism

### 17.2 Handle Fallback Logic

#### 17.2.1 Monitor Connection Health
