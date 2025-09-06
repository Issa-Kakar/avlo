1\. Executive Summary & Project Definition
==========================================

**Purpose.** Build Avlo, a link-based, account-less, offline-first, real-time collaborative whiteboard with an integrated code executor (JS + Python via Pyodide). CRITICAL: THIS IS A SMALL SIDE PROJECT, EXCESS COMPLEXITY IS NOT NEEDED FOR LARGE SCALE. REGULAR REAL WORLD USAGE WILL BE LOW, WITH 50+ USERS AND LIKELY NO MORE THAN 15 CONCURRENT USERS EVER. THIS IS FOR SWE RESUME KEYWORD AND PROJECT OPTIMIZATION ONLY. The MVP targets ≤125 ms p95 end-to-end collaboration latency with ~100 concurrent users and ≤15 active drawers, works offline (IndexedDB + CRDT), and persists rooms to Redis with (default: 14) TTL.  Mobile is view-only for MVP. 

**Production Flags:**

-   `ROOM_TTL_DAYS` default 14 (authoritative, Redis TTL)
-   `AWARENESS_HZ_BASE = 20-30` RTC; `~13-17` WS-only (derived rules below)

**Problem & solution.** Synchronous sketching + quick code execution for demos, teaching, and brainstorming---without accounts, installs, or SSO friction. Link sharing grants edit access; persistence is simple but time-limited; scale is single-node MVP.

**Tech Stack (MVP).** Frontend: React 18.3.1 (Vite 5.4.11), TypeScript 5.9.2, Tailwind CSS 3.4.17, HTML Canvas renderer with RBush 4.0.1 indexing, Monaco editor 0.52.2, Zod (for boundary validation at env/WS control/REST payloads), TanStack Query v5 (server-sourced state only - metadata/rename/lists/polling), Zustand (device-local UI slices/migrations). Realtime & Offline: Yjs 13.6.27, y-websocket 3.x (authoritative persistence path), y-indexeddb 9.x, and y-webrtc 10.3.0 for optional P2P sync (used primarily for awareness and low-latency fan-out in small rooms). Execution: in-browser JS + Pyodide 0.26.4 (per-run workers). Persistence (authoritative): Redis 7.x stable, storing compressed Yjs doc with AOF; `ROOM_TTL_DAYS` (default: 14) TTL extended only on accepted writes. Metadata DB (non-authoritative): PostgreSQL via Prisma 5.22.0 (room title/createdAt/lastWriteAt/size_bytes only). PWA: offline-first app shell with cache-first HTML navigations and versioned static assets. Pre-cache Monaco at install; warm Pyodide on desktop post-activate; do not cache `/api/**`, `/yjs/**`, or any `wss:` traffic; show an **Update available** prompt on new versions. Deploy & Infra: single container on Railway; no NGINX.
zustand@^5.0.8, @tanstack/react-query@^5 (latest: 5.85.5) zod@^4 (e.g., ^4.1.0)

--- "RTC config: **one** y-webrtc config: maxConns: 12--15 to match our small-room cap; peerOpts: { config: { iceServers: [TURN 443 tcp+tls, STUN (dev only)] } }; signaling: ['wss://signaling.yjs.dev', '<our self-hosted URL>']; password: <room-scoped HMAC> to encrypt signaling. (WS provider always stays connected as fallback & persistence path.)

--- "UI: **Collaboration Mode** segmented control ("Server (default)" / "Peer Mode (P2P)") with header badge; tiny on-screen network indicator (Server vs P2P)."

**Versioning & scripts.** Monorepo with `client` and `server` workspaces; asset bundling copies Vite build into `server/public` for Express to serve.

**Scope (in/out).** In: pen/highlighter/stamps, whole-stroke eraser, "Clear board (for everyone)", cursor trails, users list, copy-link, minimap, PNG export, per-run code execution, installable PWA. Out: auth/permissions, admin tools, recovery of expired rooms, cold storage, partial eraser, shape editing/selection, CDN, multi-node scaling, image uploads.

**Write Path.** Writes use a mutate(fn) wrapper over yjs.transact; minimal client guards; Undo/Redo via Yjs UndoManager with origin=userId.

**Note:** mobile is **view-only**; write UI **MUST** be blocked with a visual gate.

* * * * *

2\. System Architecture Overview
================================

**High-level.** Client (React/TS, Canvas, Monaco, Pyodide, `y-indexeddb`) ⇄ `y-websocket` server (official)(OPTIONAL webrtc) ⇄ Redis (AOF) with configurable TTL (`ROOM_TTL_DAYS`, default: 14). WebSocket carries Yjs doc updates + awareness; HTTP serves room creation and metadata (Prisma/PostgreSQL). Single-container deployment (Railway).

**Data Paths:**

-   **Authoritative path**: Client `mutate(fn)` → `yjs.transact` → y-js struct update → `y-websocket` (or y-webrtc)→ server adapter → Redis compressed doc (AOF) → metadata sizing
-   **Awareness path**: Client → WS awareness channel (or muted WS but still active with y-webrtc transport) → other clients → snapshot injection **only** (never persisted)

**Integration Points:**

-   **Redis adapter**: compression = gzip level 4; key `room:<id>`; TTL extension triggered **only** by accepted writes (not by awareness/reads)
-   **Postgres (Prisma)**: non-authoritative metadata rows; 404 if Redis key missing
-   **Service Worker**: cache policy rules (never cache `/api/**`, `/yjs/**`, or any `wss:`)

**Transport**. Client uses `y-websocket@3.x` (browser) and the backend runs the official `@y/websocket-server@0.1.x` (server-only). Client uses y-websocket@3.x and y-webrtc@10.3.0 (browser). The backend runs @y/websocket-server@0.1.x for authoritative persistence. y-webrtc uses separate signaling servers (public or self-hosted) and our TURN on 443; we keep WS connected at all times for durability and as the source-of-record. We wrap the server with an origin allowlist, per-IP and per-room capacity caps, and a 2 MB inbound frame cap, and bind it to Redis for persistence. Note: y-leveldb is installed only to satisfy a static import in the server package; Redis is the sole production store. y-websocket already separates Yjs doc updates from awareness; the server preserves that separation and only adds gateway error envelopes. URL contract: client builds wsBase + '/' + roomId, server expects /ws/<roomId>; with wsBase="/ws" the paths align.

**Storage authority.** Redis stores compressed Yjs docs with TTL; PostgreSQL stores non-authoritative metadata (id, title, createdAt, lastWriteAt, size_bytes); Redis presence defines existence.

**Transport (normative additions).**

--- **Authority & transport.** Authority & transport. y-websocket URL mapping (client builds baseUrl + '/' + roomId, server expects /ws/<roomId>; set baseUrl to ws://host/ws ---“WS is the authoritative path. Try WebRTC in small rooms; keep it only if it’s clearly faster. Always keep WS connected; fall back automatically.

--- **Backpressure.** Skip frames / coalesce pointer-move to rAF. If `dataChannel.bufferedAmount` grows, **skip** the current awareness frame (freshness over reliability).

**Provider initialization races:** see **Initialization & Gates** for canonical order and gates.
------------------------------------------------------------------------------------------------

3\. **The RoomDocManager Model (Unified)**
==========================================

**Principle.** Components must not receive `Y.Doc`, providers, or awareness. A single **RoomDocManager** per room owns them. Rendering reads immutable **Snapshots** published at most once per `requestAnimationFrame` or per batched Yjs update; no component reads live Y structures. Writes are coarse-grained: pointer-up commits whole stroke; eraser deletes a set in one transaction. Awareness is ephemeral, throttled, and injected into snapshots.

**Registry Pattern (Implementation).** RoomDocManager instances are accessed exclusively through **RoomDocManagerRegistry** to ensure singleton-per-room guarantee:
- Production code uses `useRoomDocRegistry()` hook or registry.acquire(roomId)  
- Tests use `createTestManager()` helper for isolated instances
- Registry supports reference counting with acquire/release for lifecycle management
- Interface-based access only (IRoomDocManager); implementation never exposed

```
// Authority: exactly one RoomDocManager per roomId, per-tab.
export interface RoomDocManager {
  /** Immutable view published at most once per rAF (or batch). */
  readonly currentSnapshot: Snapshot;
  /** Subscribe to immutable Snapshots (≤ 60 FPS). */
  subscribeSnapshot(cb: (snap: Snapshot) => void): Unsub;
  /** Throttled presence view; also injected into Snapshot. */
  subscribePresence(cb: (p: PresenceView) => void): Unsub;
  /** Advisory size/cap readings (bytes = last persisted compressed size). */
  subscribeRoomStats(cb: (s: { bytes: number; cap: number } | null) => void): Unsub;
  /** Subscribe to connection gates with stable primitive snapshots (Phase 6D). */
  subscribeGates(cb: (gates: Readonly<GateStatus>) => void): Unsub;
  /** Get current gate status. */
  getGateStatus(): Readonly<GateStatus>;
  /** Single entry to mutate authoritative state. Runs in one yjs.transact. */
  mutate(fn: (ydoc: Y.Doc) => void): void;
  /** Force a TTL extension (tiny no-op write); client-rate-limited. */
  extendTTL(): void;
  /** Lifecycle */
  destroy(): void;
}

```

**Ownership & Y.Doc Reference Rules (CRITICAL)**

-   `RoomDocManager` **owns**: `Y.Doc`, `y-indexeddb` provider (Phase 5.3+), `y-websocket` provider, y-webrtc optional RTC awareness channel, `UndoManager` (Yjs) scoped per-user origin, `mutate(fn)` wrapper, `RBush` index, and publish loop.

**Y.Doc Reference Invariants (NEVER VIOLATE)**:

1. **No cached Y references as class fields**:

   ```
   // ❌ WRONG - cached reference
   class RoomDocManager {
     private yStrokes: Y.Array<any>; // NEVER DO THIS
   }
   
   // ✅ CORRECT - helpers that traverse 'root' on demand
   class RoomDocManager {
     private getRoot(): Y.Map<any> {
       return this.ydoc.getMap('root');
     }
     private getStrokes(): Y.Array<any> {
       return this.getRoot().get('strokes') as Y.Array<any>;
     }
     private getMeta(): Y.Map<any> {
       return this.getRoot().get('meta') as Y.Map<any>;
     }
   }
   ```

2. **Helpers return Y types only for internal use**:

   -   Private helper methods MAY return Y types
   -   These are ONLY for use within RoomDocManager
   -   NEVER expose Y types from public methods

3. **UI components MUST NOT import Yjs**:

   -   ESLint `no-restricted-imports` enforces this
   -   All access through RoomDocManager public API
   -   Public API returns immutable snapshots only

**Publishing discipline**

-   All renders read only from **frozen** `Snapshot` objects, never from live Y types.
-   Event-driven rAF: set a dirty flag when Yjs updates or local edits occur; schedule one rAF; default 60 FPS, switch to 30 FPS only on mobile/battery saver/very heavy scenes.

**Construction.**

- `new Y.Doc({ guid: roomId })` exactly once; `guid` never mutated.

  // Ensure 'root' exists exactly once and seed empty containers
  this.mutate((ydoc) => {
    const root = ydoc.getMap(‘root’)

  root.get(‘…’) 
    if (!root.has('v')) {
      root.set('v', 1);
    }
    if (!root.has('meta'))    root.set('meta', new Y.Map());
    if (!root.has('strokes')) root.set('strokes', new Y.Array());
    if (!root.has('texts'))   root.set('texts', new Y.Array());
    if (!root.has('code'))    root.set('code', new Y.Map());
    if (!root.has('outputs')) root.set('outputs', new Y.Array());
  });

- Attach providers inside the manager:

  -   **Persistence provider:** `y-indexeddb` for per-room offline storage. In Phase 2.4, only a minimal render-snapshot IDB cache is used.
  -   **Realtime provider:** `y-websocket` bound to `/ws/<roomId>` with origin checks.

- Initialize a validated **mutate(fn)** wrapper that executes inside a single `yjs.transact`, applies tiny local guards (read-only, mobile, 2 MB frame cap) immediately before the transact.

**Public surface (React).**

-   `useRoomSnapshot(roomId): Snapshot` -- subscribes to the manager's published immutable snapshots (max 60 FPS).
-   `usePresence(roomId): PresenceView` -- derived, throttled presence view included in the snapshot.
-   `useRoomStats(roomId): { bytes: number; cap: number } | null` -- advisory header pill ≥ 13 MB cap; authoritative read-only banner at 15 MB cap.
-   `room.mutate(fn: (ydoc: Y.Doc) => void): void` -- executes inside a single yjs.transact, applies tiny local guards (read-only, mobile, 2 MB frame cap) immediately before the transact.
-   `room.extendTTL(): void` -- minimal Yjs write to extend TTL by `ROOM_TTL_DAYS` (rate-limited client-side). **Snapshot publishing.** Manager batches doc changes and presence into a frozen `Snapshot` published ≤ 60 FPS via `rAF`. Renderers, hit-testing, minimap, and export read **only** from the current snapshot. Typed-array discipline: store `number[]` in Yjs; construct `Float32Array` at render time. **svKey implementation.** To avoid stack overflow on large state vectors, compute `svKey` from the first 100 bytes + length + checksum. **Purpose (Phase 6): diagnostics/telemetry only.** We **do not** use `svKey` to decide whether to publish; the publisher always emits a new snapshot whenever the manager is dirty. `svKey` is still included in snapshots and tooling, and it is **never** used to gate boot visuals. **Awareness.** Central subscription with ~30 Hz throttling; presence ticks 75-100 ms; awareness is never persisted and is injected into published snapshots only. Start WS awareness immediately. If small-room probe passes, instantiate WebrtcProvider with the same Y.Doc and shared awareness instance; otherwise destroy/disconnect it and run WS-only. G_AWARENESS_READY opens when either provider is live.

**Awareness (normative additions).** --- **Cadence & throttling.** Awareness send interval per client: `interval = clamp(50ms * (1 + max(0,(N-10)/20)), 50ms, 150ms)`, permitting up to **200 ms** only when `N ≥ 60` or device is in battery saver; recompute only on **≥15%** change; apply **±10 ms** jitter; trailing-edge coalescing. Target ≤ ~300 inbound msgs/s at large N. --- **Receiver smoothing.** Interpolate cursor state (lerp) for 1-2 frames; on a missing frame, dead-reckon using last velocity for one frame. Awareness is never persisted and remains snapshot-injected only. **ESLint enforcement.** UI components ban imports of `yjs`, `y-websocket`, and `y-indexeddb` and 'y-webrtc' via `no-restricted-imports`; access goes exclusively through hooks and `room.mutate(...)`. 

**Lifecycle.**

-   **Create (offline-first):** generate `local-<ulid>`, construct `Y.Doc`, attach `y-indexeddb`, list in **My Rooms** with `provisional: true`.
-   **Publish:** POST `/api/rooms`; join canonical room over WS; merge local state; alias `local-*` → server id.
-   **Join:** resolve aliases; connect WS; load metadata; show expiry; enforce capacity/read-only.
-   **Teardown:** abort executions → dispose Monaco → destroy providers → `ydoc.destroy()`; keep per-room IndexedDB for offline continuity.



4\. Data Models & Schema Definitions
====================================

### 4.1 Yjs Document Logical Structure (authoritative)

```
type StrokeId = string;     // ULID
type TextId   = string;     // ULID
type SceneIdx = number;     // 0-based

interface StrokePoint { x: number; y: number } // world coordinates

interface Stroke {
  id: StrokeId;
  tool: 'pen' | 'highlighter';
  color: string;            // #RRGGBB
  size: number;             // world units (px at scale=1)
  opacity: number;          // 0..1; highlighter default 0.25
  points: number[];         // flattened [x0,y0, x1,y1, ...]; NEVER Float32Array
  bbox: [number, number, number, number]; // [minX, minY, maxX, maxY] world units
  scene: SceneIdx;          // assigned at commit time from currentScene
  createdAt: number;        // ms epoch
  userId: string;           // awareness id at commit
}

interface TextBlock {
  id: TextId;
  x: number; y: number;     // world units (anchor)
  w: number; h: number;     // layout box
  content: string;          // committed once, immutable
  color: string;
  size: number;             // font px at scale=1
  scene: SceneIdx;          // assigned at commit time (on text commit) using currentScene
  createdAt: number;
  userId: string;
}

interface CodeCell {
  lang: 'javascript' | 'python';
  body: string;             // ≤ 200 KB
  version: number;          // increments per commit
}

interface Output {
  ts: number;               // ms epoch
  text: string;             // ≤ 10 KB
}

interface Meta {
  scene_ticks: number[];    // append-only scene ticks (excluded from global undo)
  canvas?: { baseW: number; baseH: number } // doc-level reference size (optional)
}

```

- **Document container** (authoritative): the Y.Doc holds a single top-level map named `'root'`.

  Y.Doc → `root: Y.Map` → {
    v: number,                       // schema version (start at 1);
    meta: Y.Map<Meta>,
    strokes: Y.Array<Stroke>,		//append only;
    texts: Y.Array<TextBlock>,		//immutable once committed;
    code: Y.Map<CodeCell>,
    outputs: Y.Array<Output>		//keep last 10;
  }

  **Notes**

  - Initialization detection: check `ydoc.getMap('root').has('meta')` (no false positives from auto-created types).
  - Future-proofing: bump `root.v` and migrate in-place when schemas evolve.
  - Namespacing: app data lives under `root`; any system metadata can live alongside at doc level if ever needed.

  **Examples of typical writes:**

  - **Add stroke:**

    ```ts
    room.mutate((ydoc) => {
      const root = ydoc.getMap('root');
      (root.get('strokes') as Y.Array<any>).push([strokeJson]);
    });
    ```

  - **Clear board (scene++):**

    ```ts
    room.mutate((ydoc) => {
      const ticks = (ydoc.getMap('root').get('meta') as Y.Map<any>).get('scene_ticks') as Y.Array<number>;
      ticks.push([Date.now()]);
    });
    ```

  - **Append output:** same pattern via `root.get('outputs')`.

- **Constraints**

- `MAX_POINTS_PER_STROKE = 10_000`

- `MAX_TOTAL_STROKES = 5_000`

- **Stroke simplification at pointer-up** (Douglas--Peucker in world units):

  -   Base tol: pen `0.8 px`, highlighter `0.5 px`
  -   Ensure encoded update ≤ `128 KB`; if not, `tol *= 1.4` once; else hard downsample
  -   Highlighter tol bump capped at `1.5×`

**Awareness payload** (ephemeral; never persisted):

```
interface Awareness {
  userId: string; name: string; color: string;
  cursor?: { x: number; y: number };            // world coordinates (always)
  activity: 'idle' | 'drawing' | 'typing';
  seq: number;                                   // monotonic per-sender
  ts: number;                                    // send time ms epoch
  aw_v?: number;                                 // awareness version for evolution
}

**CRITICAL**: do not cache any doc-level Y references

```

### 4.2 Timestamp Policy (Global)

**Canonical timestamp formats**:

-   **HTTP/WebSocket JSON**: ISO-8601 UTC strings (e.g., `"2025-08-19T12:34:56Z"`)
-   **CRDT/Document fields**: `number` type (milliseconds since epoch)
-   **Examples**:
    -   REST response: `{ "expires_at": "2025-08-19T12:34:56Z" }`
    -   Yjs document: `{ createdAt: 1724070000123 }`
    -   WS control frame: `{ "ts": "2025-08-19T12:34:56Z" }` **WebSocket is hybrid: Yjs updates = binary; control = JSON**

### 4.3 Device-local UI State (non-authoritative)

Stored in `localStorage:key=avlo:v1:ui`

```
interface ToolbarState {
  tool: 'pen'|'highlighter'|'text'|'eraser'|'stamp';
  size: number; color: string; opacity: number;
  advancedOpen: boolean;
}

interface DeviceUIState {
  toolbar: ToolbarState;
  collaborationMode: 'server' | 'peer';
  aiPanelOpen: boolean;
  lastVersionSeen: string; // for update prompt
  lastSeenSceneByRoom: Record<string, number>; // for tracking last scene local to user, ghost preview after clear
}

```

**Versioned & migratable**. On schema change bump `:vN` and provide migrator. 

```
**EXPORT FOR LAST SCENE STORED IN LOCAL STORAGE**
* Keep a device-local integer lastSeenScene per room, in localstorage/indexeddb, updated whenever a published snapshot or user inactivity  
  * On reconnect, compute meta scene ticks length, see which scene the last user scene was.   
  * We can’t do scene \-1 in case multiple clears occurred, so we find a way to make the lastSeenScene able to be exported  
  * Add a method to materialize a snapshot for sceneOverride(for preview/export only). This can be implemented by filtering the same arrays with scene \=== sceneOverride before rasterizing, consistent with the visibility isolation rule. We already filter by current board, so we just render that preview.   
  * Last seen scene can advance locally, on reconnect you may still be \<server’s current scene; offer export of their last board  
   This lastSeenScene is non authoritative UI state, we already persist local UI state exactly this way
```

### Zustand (policy)

- **Scope:** small, **device-local** UI state only (e.g., toolbar, lastSeenScene). **Never** mirror Yjs doc.
- **Persistence:** `localStorage` key `avlo:vN:ui`; bump `vN` on shape changes; include a `migrate` fn.
- **Usage:** use selectors to avoid re-renders; keep slices tiny.

**Authoritative model.** Yjs document persisted as compressed binary in Redis (`room:<roomId>`), AOF enabled; awareness is ephemeral. IndexedDB stores the full per-room `Y.Doc`, **My Rooms** list, and alias map.

**Yjs document (logical view).** `root.meta.scene_ticks[]` (append-only, excluded from global Undo), root.Strokes[]` with max 10 000 points, `texts[]` (committed once, immutable), `root.code` (language ∈ {javascript, python}, max 200 KB), `root.outputs[]` (text ≤ 10 KB, keep last 10; total 128 KB). Current scene = `meta.scene_ticks.length`; rendering/export only include elements for the current scene.

**Constraints.** `MAX_POINTS_PER_STROKE = 10000`; `MAX_TOTAL_STROKES = 5000`; highlighter opacity 0.25; cursor preview 0.35; size captured at stroke start; text max length 500 chars.

**Awareness payload.** `{ name, color, cursor{x,y}, activity∈{idle,drawing,typing} }`; cadence 75-100 ms; send throttle ≈30 Hz.

**Redis storage.** Key `room:<roomId>` → compressed buffer; TTL = last accepted write; `ROOM_TTL_DAYS` (14) controllable via env and mirrored in UI; sizeBytes equals last persisted compressed payload size.

**My Rooms & aliases (IndexedDB).** Device-local metadata (title, last_opened, expires_at, provisional, aliasOf); server metadata refreshes when online; views/presence do not extend TTL; explicit **Extend** performs a tiny doc write and shows "Room extended to ...".

**Constraints (normative additions).**

--- **Stroke simplification (pre-commit).** Always run Douglas--Peucker in **world units** at pointer-up. **Budgets:** encoded update ≤ **128 KB**; points ≤ **10,000**. **Base tolerance:** pen **0.8 px**, highlighter **0.5 px**. If over budget → `tol *= 1.4` and retry once; if still over → hard downsample to max points. Do **not** simplify text/stamps; cap highlighter tolerance bumps at **1.5×**.

**WebSocket** (`/ws/<roomId>`, Origin required) - **Hybrid Transport (Binary + JSON)**

**Basic subscription methods**: emit snapshots via `subscribeSnapshot(...)`, `subscribePresence(...)`, `subscribeRoomStats(...)`; no fine-grained per-object publishers.

**Zod boundary validation**: WS control frames, small HTTP payloads, and env at boot are validated with Zod. Keep validation at boundaries only; do not pervade the codebase. **Types:** derive TS types via `z.infer<typeof Schema>`; keep schemas in `/schemas/{env|http|ws}.ts`.

* * * * *

6\. Functional Requirements
===========================

**Roles & permissions.** Single role (Editor) for all link holders; mobile is **view-only**: minimal guards reject writes on mobile with `reason='view_only'`; show banner. Banners/toasts clarify read-only, capacity full, and oversize updates.

**Whiteboard tools:**

-   Pointer-down: preview only; **no write** until pointer-up commit.
-   Pointer-up: build stroke, assign scene at commit using currentScene, commit inside one transact.
-   Whole-object eraser: hit-test via RBush; batched delete in one transaction.

Docked toolbar (left/pinned/expanded by default) with optional auto-hide; device-local toolbar state; keyboard navigable; tools: Pen/Highlighter/Stamps/Text; whole-object eraser; cursor trails with badges; minimal minimap; Undo/Redo via Yjs UndoManager with per-user origin.

**Micro-UI.** Advanced size & hue, text overlay commit once, eraser preview & single-op delete, tooltips with shortcuts, zoom controls, cursor preview.

**Page management.** **Clear board (for everyone)** appends a scene tick; on ClearBoard we append a tick; the renderer always filters by currentScene. 10 s local Undo window; server rate-limit (1/15 s); no page history. **Scene tick** excluded from undo/redo.

**Export.** PNG export for viewport/entire board (visible elements only), max long edge 8192 px, 24 px padding, white background; ≥ 2 s falls back to viewport with toast; clipboard export when supported. Hard timeout and fallback rules; add explicit **render budget** (max 16 ms per frame chunk; yield when exceeded). After a clear (and subsequent reconnect), show a read-only ghost preview of the user's last seen scene with an **Export PNG** action.

**Code execution.** Per-run fresh workers for JS/Pyodide; 5 s hard timeout; 10 KB per-run output cap; keep last 10 outputs (128 KB total). No network/FS in workers.

**Service Worker & PWA.** Cache-first HTML navigations; pre-cache Monaco; silently warm Pyodide on desktop; no caching for `/api/**`, `/yjs/**`, or WS; show update prompt; installable manifest with icons. Precache fonts/icons (self-hosted WOFF2, SVG, maskable icon). Runtime LRU cache for avatars & thumbnails (hashed → Cache-First; otherwise Stale-While-Revalidate), with size/age caps. Runtime embedded media caching (stable CDN URLs only) with caps/eviction. Precache/warm heavy dynamic-import bundles (workers/exporters/pickers/etc.). Precache localization/static JSON; keep dynamic flags out of SW. Guardrails: version cache names + cleanupOutdatedCaches(), keep separate buckets (app-shell, media-cache, avatars-thumbs, offline-pack). **Room lifecycle.** Local-first creation with provisional ids; online publish merges to server doc; join/size/capacity/expiry enforcement; Extend performs minimal write and shows confirmation toast; PUT rename (rate-limited).

**My Rooms.** Device-local list with provisional/published; delete only removes local entry; per-room `Y.Doc` persists until explicit **Delete local copy**.

**UI requirements (non-visual).** 70/30 split, resizer, toggable IDE, copy-link toast, central toasts, dark mode (whiteboard and exports white), accessibility on ranges/popovers, connection indicator (Online/Offline/Read-only), stats pill at 13 MB and banner at 15 MB cap.

**Collaboration Mode & Indicators (additions).** Provide a control labeled **Collaboration Mode** with **Server (default)** and **Peer Mode (P2P)**. Remember per-device. Show a header badge (**Server** or **Peer Mode On **). 

**Undo/Redo**: Yjs UndoManager with per-user origin via origin = userId; **scene_tick** excluded.

Global Conventions
------------------

-   **Timestamps:** ISO-8601 UTC strings for HTTP/WS JSON; **epoch ms** inside CRDT/Y structures.
-   **New constants live in `config.ts`** with env overrides.

* * * * *

7\. Non-Functional Requirements
===============================

**Performance.** Render at 60 FPS via dirty-rect redraw + culling; publish measured p50/p95; **target** (non-normative) ≤ 125 ms p95 with ~50 users and ≤ 15 drawers.

**Scalability.** Single-node MVP; multi-node later with pub/sub for Yjs.

**Security.** CSP profile, HSTS after TLS stable; `nosniff`; `no-referrer`; WS frame cap 2 MB; no session tokens; upgrades validated with Origin + roomId; **Origin allowlist** config and 403 behavior. password in WebrtcProvider encrypts signaling and prevents MITM on public signaling servers; recommend a room-scoped HMAC.

**Availability.** TTL-based retention; AOF enabled; idle GC and final flush on process SIGTERM with 3 s grace; no recovery after expiry. **Degraded mode.** Collaboration proceeds if Postgres is unavailable; metadata endpoints may 503.

**Usability & accessibility.** Clear toasts and help copy; no auto-panning due to remote actions; popovers focus-trapped; toolbar never auto-reveals while drawing. **Maintainability.** Unobserve all Yjs observers on unmount; Sentry; assistant bundle is lazy-loaded. **PWA constraints.** Do not cache `/api/**` or `/yjs/**`; SW must not intercept WebSocket traffic; Pyodide warmed on desktop only; maintain asset budgets.

**Transport runtime policy (additions).** Auto mode (default): start WS immediately; for rooms ≤ 12 peers, also bring up RTC and probe; keep only on a clear win; drop RTC if peers > 15, CPU hot, or ICE troubled. Direct mode: code pairing, hard cap 8 peers, same drop rules.

**Observability.** Sentry (errors only)

 **Async-apply contract (MVP pivot).** We **do not** use any svKey "two-line" recheck in the MVP. Cosmetic async (exports, hydrate) proceeds without an svKey guard; if the board changes mid-task, we accept that the result may be slightly stale. Awareness characteristics. Awareness is ephemeral, non-authoritative, lossy under backpressure; sequence-based drop rules apply. 

8\. **Data Architecture & Flows**
=================================

**Stores.** Yjs doc (authoritative) → Redis TTL; Awareness → WS only; IndexedDB → per-room `Y.Doc`, **My Rooms**, aliases; localStorage → device-local UI state (toolbar, etc.). PostgreSQL → non-authoritative metadata.

**Mutation Model.** All edits call mutate(fn) which performs a single yjs.transact. Minimal guards only (≥15 MB read-only, mobile view-only, 2 MB inbound frame cap). Let Yjs handle consistency and ordering.

**Canvas & indexing.** LOD thresholds, render order (strokes → stamps → text), RBush maintenance and rebuild heuristics, eraser hit-testing, no auto-pan on remote actions.

**Service Worker / caching.** Cache-first HTML; pre-cache Monaco; desktop-only silent Pyodide warm; immutable `/pyodide/<version>/**`; never cache API/Yjs/WS; update prompt on new app version. **Data transforms.** gzip level 4 before Redis; `size_bytes` equals last persisted compressed payload size. **Privacy/retention.** TTL extends only on accepted writes; awareness/views do not extend; expiry deletes permanently.

### 8.1 Draw Stroke (authoritative)

1.  **UI** captures pointer stream → local preview (no writes).
2.  On **pointer-up**:
    -   Derive world points from screen coords using **Coordinate Spaces** contract.
    -   Simplify per rules; compute bbox.
    -   Assign scene at commit using currentScene.
3.  **mutate(fn)** with minimal guards:
    -   Reject if read-only (room ≥ 15 MB), mobile view-only, frame size > 2 MB.
4.  **Execute in one `yjs.transact()`**:
    -   Append `Stroke` to root.strokes[]` with currentScene.
5.  **DocManager**:
    -   Batches Y updates; publishes new **Snapshot** at next rAF.
6.  **Transport**:
    -   y-websocket sends delta; server persists; Redis TTL extended. Include variants: **offline**, **oversize**, **capacity full**

### 8.2 Clear Board (for everyone)

-   Gate with **server rate-limit** 1/15 s; local **10 s** undo window.
-   Implementation: append to `root.meta.scene_ticks[]`; currentScene = length.
-   Rendering includes only elements with `scene === currentScene`.

### 8.3 Code Run

-   **Per-run worker**; hard timeouts; no network/FS.
-   Append `root.outputs[]` with clamp to last 10 items; enforce 128 KB total.

**Render snapshot cache (dormant in MVP).** The small render cache from Phase 2.4 **remains in the codebase** but is **not used** by Phase 6. **Do not** display any boot image from this cache; **do not** read or write it during boot. Keep it only as a future utility; no server/CDN persistence.

**Flows (additions).** --- **IndexedDB snapshots (MVP).** **Do not** attempt any boot-time render snapshot display. IndexedDB persists the **Y.Doc** and device-local UI only; first paint is the **EmptySnapshot** followed by live frames. 

### TanStack Query (policy)

- **Scope:** server-sourced state only (lists, metadata, renames). **Never** Yjs doc data.
- **Keys:** `["rooms","list"]`, `["rooms","metadata", roomId]`.
- **Refreshing:** invalidate on `persist_ack` for that room; otherwise poll ~10s; `refetchOnWindowFocus=false`, `retry=1`.

**Additional Essential Data Flows**

1.  **Offline­first publish & alias resolution** Local creation yields a room with a provisional alias. On first sync: server allocates the canonical room key, merges content, and resolves the alias mapping. Clients store both (for backlinks and history) but render only the canonical alias going forward.
2.  **Expiry → local cleanup UX** When a room expires (Redis TTL), metadata reads 404. The client removes server mappings, keeps the local Y.Doc (with a banner explaining the state), and offers a one­click "create new room from local copy."

9\. Dependencies & Integrations
===============================

**Hard MVP.** Yjs, `y-websocket`, `y-indexeddb`, 'y-webrtc', Monaco, Pyodide, Redis, Prisma, PostgreSQL, Zod (env + WS/HTTP boundary validation only), TanStack Query v5 (server-sourced state only - room metadata, lists, renames, light TTL polling/retries/cross-tab dedupe - never for Yjs document data), Zustand (small, device-local UI stores - toolbar state, lastSeenSceneByRoom, etc. - helps with UX schema migrations); vendored static assets for Monaco & Pyodide; Playwright for E2E; ESLint/Prettier/Husky/lint-staged in dev; plus internal canvas/minimap/toast/PWA assets. **Exact versions:**

- `y-websocket@3.x` browser + `@y/websocket-server@0.1.x` server (no y-leveldb at runtime)

- Redis 7.x stable AOF enabled; gzip level 4; `size_bytes` = compressed length

- **TURN**: tcp+tls on 443; long-term creds rotated; **STUN** dev only **AuthN/AuthZ.** None; link-based open access by design. **Monitoring.** Sentry (no content logging). _Optional when WebRTC is enabled:_ counters `rtc.upgrade.count`, `rtc.ws_fallback.count`, `rtc.relay.ratio`, `turn.alloc.failures`, `turn.bytes.relayed`.

- **Operational (additions).** **Connection pooling.** Postgres: `pg.Pool` size **10-20**, set idle/acquire timeouts, and log slow queries. Redis: one client for commands and one for pub/sub per process; health checks and reconnect backoff. Add y-webrtc@10.3.0. Env: Y_SIGNALING_URLS, Y_RTC_MAX_CONNS, Y_TURN_URL, Y_TURN_USER, Y_TURN_PASS, Y_RTC_PASSWORD_SALT. Self-hosted signaling (optional): include bin/server.js from y-webrtc or an equivalent deployment; keep public wss://signaling.yjs.dev as a backup

11\. Initialization & Gates
===========================

Define explicit **init order**, **gates**, **timeouts**, and **what they unblock**.

### 11.1 Init Order (single tab, one room)

1. **Construct RoomDocManager**

   -   Create `Y.Doc({ guid: roomId })` **exactly once**.

2. **Attach y-indexeddb provider**

   -   Gate `G_IDB_READY` when initial load applies; timeout **2 s** (fallback to empty doc).

3. **Attach y-websocket provider**

   -   Connect immediately (do not wait for IDB).
   -   Gate `G_WS_CONNECTED` on open; `G_WS_SYNCED` after first `syncStep2`/state-vector exchange completes.

4. **Awareness**

   -   Start WS awareness immediately
       -   **Note (MVP boot behavior).** We attach `y-indexeddb` first and connect **WebSocket immediately** (do **not** wait for IDB). First paint is always non-null via the EmptySnapshot, so showing **awareness before content** is intentional and safe; the first doc-derived frame arrives ≤ 1 rAF after the first IDB apply or WS sync. At this scale, server-vs-IDB hydration order is not user-visible. Outgoing local edits during early hydrate are allowed; Yjs merges them when WS sync completes.
   -   If **RTC small-room probe** eligible (peers ≤ 12), start RTC and run probe (2.5 s).
   -   Gate `G_AWARENESS_READY` when at least **one** channel (WS or RTC) is healthy.

5. **Snapshot**

   -   Build **non-null EmptySnapshot** synchronously (prevents null access).
   -   Gate `G_FIRST_SNAPSHOT` when first doc-derived snapshot is published (≤ 1 rAF after any Y update or after init).

   Initialization detection uses `ydoc.getMap('root').has('meta')` (Yjs may auto-create container types; the presence of `meta` is the canonical signal).

6. **Render Loop**

   -   Start rAF publisher on manager creation; publish **idle snapshots** (awareness + empty doc) until Y updates arrive.

### 11.2 Gates Table

| Gate                | Opens When                             | Unblocks                                           | Timeout | On Timeout                                             |
| :------------------ | :------------------------------------- | :------------------------------------------------- | :------ | :----------------------------------------------------- |
| `G_IDB_READY`       | y-indexeddb loaded or 2 s elapsed      | initial snapshot hydration; "Recent Rooms" badge   | 2 s     | Render `EmptySnapshot`; continue background re-hydrate |
| `G_WS_CONNECTED`    | WS open                                | WS awareness, doc sync                             | 5 s     | proceed offline if IDB ready   
| `G_WS_SYNCED`       | first Y sync completes                 | authoritative render (server merged state)         | 10 s    | keep rendering from IDB; continue syncing             
| `G_AWARENESS_READY` | WS or RTC awareness live               | Prescence cursors/names/pings                      | none    | N/A
| `G_FIRST_SNAPSHOT`  | first publish to UI occurs (IDB or WS) | Enables features that require a populated snapshot | 1 rAF   | N/A                                   

**Where to gate writes**:

-   Before `G_WS_CONNECTED`: **ALLOW** writes (offline-first) to Y doc via IDB; queue persists; WS sync later.
-   When **room read-only** (≥ 15 MB) or **mobile**: **BLOCK** in minimal guards with UX banner.
-   Before `G_FIRST_SNAPSHOT`: **BLOCK exports** and **minimap**; allow drawing.

**Feature → Gate**

| Feature              | Gate(s)                      | Behavior when closed                                         |
| -------------------- | ---------------------------- | ------------------------------------------------------------ |
| Drawing (writes)     | none (offline-first)         | Writes go to local Y + IDB; syncs to server when `G_WS_CONNECTED` later opens |
| Read-only / mobile   | room policy                  | Block writes; show banner explaining restriction             |
| Export PNG           | `G_FIRST_SNAPSHOT`           | Disable button; tooltip “Preparing board…”                   |
| Minimap              | `G_FIRST_SNAPSHOT`           | Hide                                                         |
| Presence cursors     | `G_AWARENESS_READY`          | Hide cursors; no additional indicator                        |
| Extend TTL           | `G_WS_CONNECTED`             | Disable; tooltip “Requires connection”                       |
| Clear Board          | server rate-limit + debounce | If dropped: toast user; do not retry aggressively            |
| Recent Rooms badge   | `G_IDB_READY`                | Hide                                                         |
| Authoritative render | `G_WS_SYNCED`                | Continue rendering from IDB snapshot until sync completes    |

12\. State Synchronization & Derivation
=======================================

**Sources:**

-   **Authoritative**: Yjs doc (Redis mirror).
-   **Ephemeral**: Awareness (WS/RTC).
-   **Local**: Device UI state (localStorage).
-   **Metadata**: `/api/rooms/{id}/metadata` (size, expiry). **Derived State** (computed inside manager on publish):
-   `root.currentScene = meta.scene_ticks.length`
-   `docStats = { bytes, cap: 15MB }` (from metadata poll every 10 s or on successful persist ack)
-   `presenceView` throttled & interpolated **Consistency rules:**
-   **Never** write derived values into Yjs (e.g., `bbox` MAY be stored to avoid recompute; all other derivations remain ephemeral).
-   Snapshot MUST reflect a **single state vector** at the moment of capture; include `svKey: string` (first 100 bytes + length + checksum to avoid stack overflow) **for diagnostics and tooling only.** In Phase 6, `svKey` is **not** consulted for publish/change detection and is **not** used to guard long-running tasks.

13\. Mutations & Undo
=====================

**Mutations**: mutate(fn) → yjs.transact with minimal guards (≥15 MB read-only, mobile view-only, 2 MB frame cap). **Undo/Redo**: Yjs UndoManager with origin = userId (per-user history). **Scenes**: commit-time assignment; strokes/text commit to current scene at time of commit. **Backpressure**: coalesce pointer-move on rAF, drop stale events if the queue backs up; no client timers/windows.

14\. Snapshot Contract
======================

Define **precisely** what is in `Snapshot` and **never null**:

```
interface Snapshot {
  svKey: string; // first 100 bytes + length + checksum of state vector; included for diagnostics; NOT used to gate publishing in Phase 6
  scene: SceneIdx;	//derived from root.meta.scene_ticks.length at capture time
  strokes: ReadonlyArray<StrokeView>;  // MUST filter: only scene === currentScene
  texts: ReadonlyArray<TextView>;       // MUST filter: only scene === currentScene
  presence: PresenceView;         // derived + smoothed
  spatialIndex: RBushIndexView;   // populated when RBush is implemented (now Phase 8)
  view: ViewTransform;            // world->canvas transform
  meta: { bytes?: number; cap: number; readOnly: boolean; expiresAt?: number };
  createdAt: number;              // ms epoch when snapshot frozen
}

interface StrokeView {
  id: string;
  points: ReadonlyArray<number>;  // flat [x0,y0,x1,y1,...]; renderer builds typed arrays at render
  polyline: Float32Array | null;  // built at render from points, null in snapshot
  style: { color: string; size: number; opacity: number; tool: 'pen' | 'highlighter' };
  bbox: [number, number, number, number];
}

```
-   **Typed arrays** are **constructed at render only**; stored doc remains plain arrays.
-   **Preventing null snapshot**: On manager creation, publish `EmptySnapshot` with `scene=0`, empty arrays, identity transform, `meta.readOnly=false`, `meta.cap=15_000_000`.

* * * * *


17\. Event Isolation & Canvas
=============================

-   **UI events** (pointer/mouse/keyboard) MUST NOT mutate Y state directly.
-   All mutations pass through **mutate(fn)** at **pointer-up** or explicit actions.
-   **Canvas renderer**:
    -   Renders at **60 FPS** with dirty-rect culling. Use dirty-rect culling only when transform is unchanged; on transform change, fall back to full clear (or tile cache).
    -   **Scene tick (Clear Board)**: perform a full canvas clear before drawing the new scene. Dirty-rects may leave stale pixels after refresh; treat scene change as a full-clear boundary.
    -   **No auto-pan** due to remote actions.
    -   **Hit-testing** via RBush built from Snapshot; never touches Y live data. **Draw order for Canvas**:

1.  Background (export uses white background).
2.  World layers: strokes → stamps/shapes → text.
3.  Authoring overlays: selection boxes/handles, text caret/selection.
4.  Presence overlays: remote cursors/trails (renders only when G_AWARENESS_READY + G_FIRST_SNAPSHOT).
5.  HUD/UI overlays: minimap, update prompts, toasts (never included in export). Export rule: include (1)--(2); exclude (3)--(5). Render loop remains ≤60 FPS with dirty-rect culling.
Render order must match the architectural contract: background → strokes → stamps/shapes → text → authoring overlays → presence overlays → HUD.

-   **Isolation**: While "Push-to-talk" active, drawing is disabled; awareness still emitted.(In later webrtc)

18\. Coordinate Spaces & Transforms
===================================

Specify the **contract** between **screen**, **canvas**, and **document/world** spaces:

- **Document/world**: stable units in which strokes/text positions are stored.

- **Canvas**: backing `<canvas>` device pixels; size derived from **element** but world size may be **doc-level `meta.canvas`** reference.

- **Screen**: CSS pixels.

- **Transform contract**:

  -interface ViewTransform {  worldToCanvas: (x:number,y:number)=>[number,number];  canvasToWorld: (x:number,y:number)=>[number,number];  scale: number;  // world px → canvas px  pan: { x:number; y:number }; // world offset}
  
  ```

- **Canvas dimensions**

  -   If `meta.canvas` present: treat `(baseW, baseH)` as world reference; maintain aspect-fit in element rect.
  -   Else: derive world size from initial element box once; store in memory (not persisted) until user **exports**---export uses current world bounds.

- **Pointer conversion**: Always via `canvasToWorld`, never ad-hoc arithmetic.

- **Ghost preview/export**: uses the existing visibility isolation (sceneOverride to filter).

19\. Transport Ordering & Flow Control
======================================

-   **Yjs doc updates**: rely on CRDT causality; `y-websocket` ordering is sufficient.
    -   If WS send buffer exceeds **64 KB** (browser API permitting checks) → coalesce and skip up to next tick.
-   **Message ordering**:
    -   Awareness processed **before** snapshot publish if received in same tick; otherwise makes next frame.
-   **Coalesce pointer-move on rAF, drop stale motion under load.**
-   **WS backpressure rules (authoritative).**
     • **High/low water:** 256 KB / 64 KB from `WebSocket.bufferedAmount`. Above high: coalesce doc sends and **skip awareness** frames; resume when below low.
     • **Presence skip threshold:** if `bufferedAmount > 64 KB`, drop the current awareness frame (freshness over reliability).
     • **Awareness cadence degrade:** **12 → 6 → 2 Hz** when backpressured or when **N ≥ 20**.
     • **Roster rate:** cap WS roster/buddy-list updates to **≤ 1 Hz**.
     These are stricter than the generic “lossy under backpressure” guidance and make behavior predictable at small-room scale. 
-   **Server slow-socket policy.** On each connection, watch `bufferedAmount`. While a socket is above the high-water, **suspend presence fan-out** to that socket and **bound its per-socket queue** (doc updates remain prioritized). Resume presence when it drains below low-water. This prevents a single slow client from causing memory growth or stalling broadcast. 

* * * * *

20\. Offline/Online Orchestration
=================================

-   **Offline-first**:
    -   Writes accepted at all times (desktop); persisted to IDB; when WS reconnects, CRDT merges.
-   **Connectivity transitions**:
    -   On `online` event: trigger metadata refresh; run small "keep-alive write" only if ≤ once per 10 min to extend TTL.
    -   On `offline`: pause metadata polling; keep awareness cursors locally only.

* * * * *

21\. Ownership & Observation Model
==================================

- **Single ownership**:
  -   `RoomDocManager` owns providers and **solely** observes Y types.
  -   UI relies on **subscriptions** only; no direct observers of Y types anywhere else.

- **Centralized subscription**:
  -   Awareness subscription is centralized; presence derivation happens inside manager with smoothing (lerp 1-2 frames; one-frame dead-reckon on miss).

- **Capacity (`room_full`)**:

-   Show blocking modal; allow **view-only** join if capacity gate provides read-only seat (server-driven).
  - **Provider-agnostic observers.** Register all Y.Doc observers **exactly once** inside `RoomDocManager`. Providers (`y-indexeddb`, `y-websocket`, optional `y-webrtc`) **must not** bind their own doc listeners; they are transport only. They may attach their own internal doc listeners to function, but they do not register any app/UI observers or publish UI state. Provider lifecycle events (connect/disconnect, first-sync, IDB hydrated, awareness live) are consumed centrally by RoomDocManager and translated into gates.

* * * * *

24\. RAF & Publishing
=====================

**Publisher** runs a continuous rAF loop (one per room tab):

-   **On every frame**, publish a new frozen Snapshot if either document or awareness is dirty. We never suppress a publish using `svKey` in Phase 6.
-   **If nothing changed**, we publish an identical Snapshot anyway, performance difference is negligible
-   **FPS policy**: default 60 FPS; 30 FPS on heavy/mobile; hidden tabs drop to ~8 FPS.
-   **Work budgeting**: keep prep ≤ ~6 ms; split work across frames.
-   **Awareness changes** mark the manager dirty the same way as doc changes (IDB/WS).
-   **Export path**:
-   If export prep exceeds **2 s**, fall back to viewport export with toast; never block UI thread longer than **16 ms** bursts.

* * * * *

Appendix A: Exact Algorithms
============================

1.  **RBush Maintenance**:
    -   Rebuild when `(added+removed) > 256` or `(deltaBBoxArea / totalArea) > 0.15`.
    -   Otherwise incremental updates per commit.
2.  **Douglas--Peucker Simplification**:
    -   Operate in **world units**; ensure `points.length/2 ≤ 10_000` and encoded diff ≤ 128 KB.
    -   One retry with `tol *= 1.4`; otherwise uniform downsample.

* * * * *

Appendix B: Invariants & Assertions (keep in code as dev-only)
==============================================================

-   `Snapshot` is **never null**.
-   All Snapshot arrays are **frozen**; mutating them throws in dev.
-   Yjs writes occur **only** inside `mutate(fn) → yjs.transact` transactions.
-   `Awareness.seq` is strictly increasing per sender.
-   `svKey` only changes after a Yjs update apply.

* * * * *

Appendix C: Provider Lifecycle (Init, Teardown, Reconnect)
==========================================================

**Teardown order (room leave, toggle to WS-only, tab close):**

1.  **Stop awareness publisher** → 2) **Destroy RTC provider** (if any) → 3) **Unsubscribe awareness listeners** →
2.  **Leave/close WS** (doc provider remains authoritative path) → 5) **Flush pending mutations** → 6) **Close IDB (optional)**. Guarantee all public calls after `destroy()` are no-ops (guard every public method with `if (this._destroyed) return;`).
**RTC flap handling & debounce:**

* * * * *

Appendix D: Command-Level Conflict Rules
========================================

**Beyond CRDT merge---UX semantics that must be consistent:**

1.  **ClearBoard scene preservation.**
    -   `ClearBoard` increments scene by appending to `scene_ticks[]`; strokes commit to the current scene at commit time, ensuring they land in the new scene if ClearBoard happens during gesture.
2.  **Idempotency.**
    -   Duplicate `ClearBoard` or "select all → delete all" sequences are idempotent; second application is a no-op.

* * * * *

Appendix E: Presence vs Snapshot Gating
=======================================

**Rendering contracts aligned to §11 Gates:**

-   **Cursors/presence** draw only when **both** `G_AWARENESS_READY` **and** `G_FIRST_SNAPSHOT` are open.
-   If awareness is ready but the first snapshot is not yet published, (no UI) — cursors remain hidden.
-   Export/minimap remain gated per `G_FIRST_SNAPSHOT`.

* * * * *

Appendix F: Mutations & Undo
============================

**Mutation Model:**

-   All edits call `mutate(fn)` which performs a single `yjs.transact`.
-   Minimal guards only (≥15 MB read-only, mobile view-only, 2 MB inbound frame cap).
-   Let Yjs handle consistency and ordering.

**Undo/Redo:**

-   Yjs UndoManager with `origin = userId` (per-user history).
-   Scene ticks excluded from undo scope.

**Backpressure:**

-   Coalesce pointer-moves to rAF.
-   Drop stale motion events if queue backs up.
-   No client timers/windows; event loop + Yjs batching suffice.

* * * * *

Appendix G: Testing Requirements
================================

**Registry Pattern for Tests:**

All tests involving RoomDocManager MUST use the registry pattern to ensure proper isolation and cleanup:

```typescript
// ✅ CORRECT - Use createTestManager helper
const { manager, cleanup } = createTestManager(roomId);
// ... test code ...
cleanup();

// ❌ WRONG - Never instantiate directly
const manager = new RoomDocManagerImpl(roomId); // NEVER DO THIS
```

This pattern ensures:
- Complete isolation between tests (each gets its own registry)
- Proper Y.Doc cleanup (prevents memory leaks)
- Test-specific timing control (TestClock/TestFrameScheduler)
- Consistent test behavior across phases

* * * * *

Appendix H: Phase 6D - UI Integration Patterns
==============================================

**Stable Primitive Snapshots for Gate Subscription:**

To prevent infinite re-render loops with `useSyncExternalStore`, the `subscribeGates` method uses encoded string primitives:

```typescript
// Encode gates as stable string primitive: "0|1|0|1|1"
type GateSnapshot = `${0|1}|${0|1}|${0|1}|${0|1}|${0|1}`;

// Use queueMicrotask to defer callback execution
const subscribe = (onStoreChange: () => void) => {
  return room.subscribeGates(() => queueMicrotask(onStoreChange));
};  // 150ms debounce prevents UI flicker during rapid gate changes
```

**Routing Structure (Post-Phase 6):**

- `/` → Test harness with hardcoded 'test-room-001'
- `/room/:roomId` → Dynamic room pages with full UI
- `/test` → Alternative test harness path

```

* * * * *

Awareness -- Cursor Trail (Implementation Notes)
-----------------------------------------------

### Data model

Per remote user keep a rolling buffer of **12--24** points `{x, y, t}` in **canvas pixels**, newest at the end. Trim points older than **600 ms** or exceeding the buffer size. Optionally store velocity `v` computed from deltas for thickness/alpha cues.

### Ingest

-   On each awareness update, quantize to **0.5 px** and push.
-   If gaps > **60 ms**, linearly interpolate **1--2** points to avoid segments snapping.
-   Merge with existing **receiver smoothing** (do not double‑smooth): if a predicted point exists for the current frame, prefer it.

### Render loop (overlay canvas)

-   Single overlay `<canvas>` above the stage; render at `requestAnimationFrame`.
-   For each trail, draw a polyline through the buffer; alpha = `exp(-(now - t)/τ)` with τ≈**240--320 ms**.
-   Cap stroke width between **1--3 px**. Use **butt** caps to reduce halos; join style **round**.
-   Clear using `ctx.clearRect()` once per frame; no per‑point clears.

### Degrade rules

-   If `peerCount > 10`, shrink buffer to **≤12** points.
-   If `peerCount > 25` or `fps < 30`, **disable trails** (show dot‑only cursors).
-   Honor **prefers‑reduced‑motion**: default to dot‑only.

### Telemetry

-   Emit `cursorTrail.enabled`, `cursorTrail.points`, `cursorTrail.dropReason` (high peers / low fps / reduced‑motion) for tuning.

### Pseudocode

```
interface TrailPoint { x: number; y: number; t: number }
const trails = new Map<UserId, TrailPoint[]>();
const MAX_POINTS = 24, MAX_AGE_MS = 600;
function pushPoint(id: UserId, p: {x:number,y:number,t:number}) {
  const buf = trails.get(id) ?? [];
  buf.push(p);
  while (buf.length > MAX_POINTS || (performance.now() - buf[0].t) > MAX_AGE_MS) buf.shift();
  trails.set(id, buf);
}

```

1.  **Awareness Coordinates** -- Send world-space; receivers project to view. Optional: include `{viewId, world, ts}`; prefer world when present.

**B. Initialization & State Sync**
1.  **Boot Gating** -- Attach y-indexeddb first and open y-websocket immediately; do not wait for G_IDB_READY (the 2 s timeout gates IDB hydrate only); gate UI with G_WS_CONNECTED/G_WS_SYNCED and G_FIRST_SNAPSHOT.
2.  **Scene Capture** -- Scene is assigned at commit time using currentScene; no capturing at gesture start.
3.  **Frame Size vs Micro-Batch** -- Inbound frames ≤2 MB; server never coalesces beyond cap; client uses rAF coalescing only.

C. Races & Ordering
1.  **Concurrent Clear Board** -- Server: idempotency key + ≥150 ms rate-limit. Client: debounce ~300 ms and show pending state.
2.  **outputs[] Eviction** -- Completion + eviction in single CRDT transaction so second finisher observes first delete.
