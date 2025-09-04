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
- Implement RAF-based publishing (≤60 FPS, dirty flags, svKey optimization)
- **svKey implementation**: Create safe state vector key using first 100 bytes + length + checksum to avoid stack overflow on large state vectors. Format: `btoa(first100bytes):length:checksum`. This is sufficient for cache invalidation and change detection

### 2.4 Set Up Subscription Management
- Implement subscribeSnapshot with immediate callback on subscribe
- Add subscribePresence (throttled ≤30Hz, interpolation, dead-reckoning)
- Create subscribeRoomStats (null initially, updates on persist_ack)
- **COMPLETED BUT DEFERRAL**:  Deferral (Phase 6): Boot splash is not implemented in this release. svKey is still computed and used for publish/change detection, but no splash is read or shown on boot. The minimal render cache remains write-only for now. Add minimal render cache (cosmetic only, NOT y-indexeddb)

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
- Implement dirty rectangle tracking (full clear if transform changed)
- Define render order: Background → Strokes → Text → Overlays → Presence → HUD
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
  - Retry with tol*=1.4 if over, then hard downsample
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
2. Rely on the **existing** snapshot pipeline to compute the `svKey` (first 100 bytes + length + checksum, NOT full state vector) and publish a frozen Snapshot on the next frame; do **not** special-case IDB vs WS.
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
2. Publish when **either** Yjs changed (svKey delta) **or** presence view changed (presence will be wired in a later phase; keep the hook points in place but inert).
3. Preserve the **svKey optimization**: skip publish when the doc is unchanged (detected via svKey comparison) and only cosmetic work would occur. Note: svKey changes only when Y.Doc actually changes, making it a reliable change detector despite using a truncated format.

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

On `destroy()`:
1) stop rAF 
2) unobserve Y 
3) if (wsProvider) { try { await wsProvider.close?.() ?? wsProvider.disconnect?.() ?? wsProvider.destroy?.() } catch {} ; wsProvider = null }
4) if (idbProvider) { try { await idbProvider.destroy?.() } catch {} ; idbProvider = null }
5) try { ydoc.destroy() } catch {}
6) mark `this._destroyed = true` so subsequent calls are no-ops.


#### 6A.5.2 Concurrency assertions (dev-only)

1. Assert single manager per `roomId` in the registry.
2. Assert that no UI layer imports `yjs`/providers directly (ESLint `no-restricted-imports`).
3. Assert that provider attach happens **after** `Y.Doc` construction and before any WS attempts (to honor offline-first ordering once WS is introduced).

------

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

#### 6B.7.1 Inbound/Outbound flow control

1. Enforce the 2 MB inbound frame cap at the gateway; close misbehaving clients.
2. Monitor each connection’s `bufferedAmount`. While above a **high-water** (e.g., 256 KB), **suspend presence fan-out** to that socket and **bound** its per-socket queue to doc-update essentials; resume when below **low-water** (e.g., 64 KB).
3. Prefer freshness for awareness: if the queue builds, drop awareness frames destined for that socket first.

### 6B.8 Health
1. `GET /healthz` returns 200 + simple Redis ping.

------

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

TODO IN FUTURE PHASE 7: **`G_AWARENESS_READY`** opens when WS (or RTC later) awareness is live, so the UI knows when to show cursors. When offline:(no UI) – presence is best-effort; cursors simply hide

## Phase 7: Awareness & Presence System

### 7.1 Implement Awareness Protocol
Do not start an awareness timeout. If awareness is unavailable, keep presence features hidden with no extra UI.

#### 7.1.1 Set Up Awareness State
1. Create awareness instance from Y.Doc
2. Define local user properties
3. Generate unique user ID per tab
4. Assign random color from palette
5. Set default name or initials

#### 7.1.2 Configure Awareness Updates
1. Track cursor position in world space
2. Update on pointermove with throttling
3. Include current tool and activity
4. Add sequence number for ordering
5. Set timestamp for each update

### 7.2 Build Presence Rendering

#### 7.2.1 Create Cursor Component
1. Render cursors for remote users
2. Position using world coordinates
3. Apply user color to cursor
4. Show name label on hover
5. Fade out stale cursors

#### 7.2.2 Implement Cursor Smoothing
1. Interpolate between cursor updates
2. Use last known velocity for prediction
3. Apply easing for natural movement
4. Handle missing updates gracefully
5. Remove cursors after disconnect

### 7.3 Add User List Display

#### 7.3.1 Create User List Component
1. Subscribe to awareness updates
2. Display active users with colors
3. Show user count in header
4. Indicate drawing activity


## Phase 8: RBush Spatial Indexing

### 8.1 Integrate RBush Library

#### 8.1.1 Initialize Spatial Index
1. Import RBush library with TypeScript types
2. Create RBush instance in RoomDocManager
3. Configure with appropriate max entries per node
4. Set up index for 2D bounding boxes
5. Initialize as empty on manager creation

#### 8.1.2 Define Index Item Structure
1. Create interface for indexed stroke items
2. Include minX, minY, maxX, maxY from bbox
3. Add stroke ID for reference back to data
4. Include scene index for filtering
5. Store tool type for query optimization
(bboxes are persisted on stroke commit and never recomputed at render time)

### 8.2 Implement Index Maintenance

#### 8.2.1 Build Initial Index
1. Iterate through all strokes in snapshot
2. Convert each stroke to RBush item format
3. Bulk load items for efficiency
4. Only include strokes from current scene(either re-filter or rebuild, cheap if you cache per scene indices)
5. Store index in snapshot for queries

#### 8.2.2 Handle Incremental Updates
1. Track strokes added since last index
2. Insert new strokes individually
3. Remove deleted strokes from index
4. Rebuild if changes exceed threshold (256 items)
5. Monitor index performance metrics

### 8.3 Create Spatial Query System

#### 8.3.1 Implement Hit Testing
1. Create point-to-stroke hit test method
2. Convert point to search rectangle with tolerance
3. Query RBush for overlapping strokes
4. Perform precise hit test on candidates
5. Return closest stroke or null

#### 8.3.2 Add Area Selection Queries
1. Implement rectangle selection search
2. Query index for strokes in bounds
3. Filter results by current scene
4. Sort by z-order (array index)
5. Return array of selected stroke IDs

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
1. Use RBush for spatial queries
2. Find strokes under pointer
3. Highlight strokes on hover
4. Track strokes to delete
5. Show eraser cursor

#### 10.1.2 Execute Batch Deletion
1. Collect stroke IDs to remove
2. Call mutate with delete operation
3. Remove from strokes array in transaction
4. Update spatial index
5. Clear eraser preview

### 10.2 Build Clear Board Feature

#### 10.2.1 Implement Scene Tick Mechanism
1. Add scene tick to meta array
2. Increment current scene counter
3. Filter rendering by scene
4. Exclude from undo manager
5. Apply rate limiting

#### 10.2.2 Add Clear Board UI
1. Create clear board button
2. Show confirmation dialog
3. Display warning about permanence
4. Execute clear on confirmation
5. Show success notification

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

#### 11.2.1 Define Stamp Shapes
1. Create stamp definitions (arrows, shapes)
2. Define as point arrays
3. Store in tool configuration
4. Scale based on size setting
5. Apply rotation if needed

#### 11.2.2 Implement Stamp Placement
1. Place stamp at click position
2. Convert to stroke format
3. Apply current color settings
4. Commit as regular stroke
5. Show preview before placement

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

## Phase 14: Export & Minimap

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

### 14.2 Build Minimap Component

#### 14.2.1 Create Minimap Renderer
1. Render scaled version of board
2. Show viewport rectangle
3. Update on content changes
4. Optimize with debouncing
5. Hide when empty

#### 14.2.2 Add Navigation Features
1. Allow click to jump
2. Drag viewport rectangle
3. Show zoom level
4. Update smoothly
5. Collapse when not needed

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
