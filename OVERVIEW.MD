# avlo.md

# 1. Executive Summary & Project Definition
**Purpose.** Build Avlo, a link-based, account-less, offline-first, real-time collaborative whiteboard with an integrated code executor (JS + Python via Pyodide). The MVP targets ≤125 ms p95 end-to-end collaboration latency with ~50 concurrent users and ≤25 active drawers, works offline (IndexedDB + CRDT), and persists rooms to Redis with `ROOM_TTL_DAYS` (default: 14) TTL. Hard data cap is 10 MB compressed per room; at the cap the room becomes read-only. Mobile is view-only for MVP.

**Success SLOs and Monitors:**
- `collab_e2e_p95_ms ≤ 125` with **50 users / 25 drawers** in room, measured as **stroke-commit → remote snapshot applied**
- **Authoritative persistence lag** SLO: `p95 ≤ 3000 ms`, hard cap `≤ 5000 ms`
- **Awareness fan-in**: ≤ 300 msgs/s at 60 peers under RTC; ≤ 180 msgs/s WS-only
- **Room size**: **10 MB compressed** read-only gate; **8 MB** warning pill (derived from Redis sizeByte)

**Production Flags:**
- `ROOM_TTL_DAYS` default 14 (authoritative, Redis TTL)
- `AWARENESS_HZ_BASE = 20-30` RTC; `~13-17` WS-only (derived rules below)

**Problem & solution.** Synchronous sketching + quick code execution for demos, teaching, and brainstorming—without accounts, installs, or SSO friction. Link sharing grants edit access; persistence is simple but time-limited; scale is single-node MVP.

**Tech Stack (MVP).**
Frontend: React 18.3.1 (Vite 5.4.11), TypeScript 5.9.2, Tailwind CSS 3.4.17, HTML Canvas renderer with RBush 4.0.1 indexing, Monaco editor 0.52.2. Realtime & Offline: Yjs 13.6.27, y-websocket 3.x (authoritative persistence path), y-indexeddb 9.x, and y-webrtc 10.3.0 for optional P2P sync (used primarily for awareness and low-latency fan-out in small rooms). Execution: in-browser JS + Pyodide 0.26.4 (per-run workers). Persistence (authoritative): Redis 7.x stable, storing compressed Yjs doc with AOF; `ROOM_TTL_DAYS` (default: 14) TTL extended only on accepted writes. Metadata DB (non-authoritative): PostgreSQL via Prisma 5.22.0 (room title/createdAt/lastWriteAt/size_bytes only). PWA: offline-first app shell with cache-first HTML navigations and versioned static assets. Pre-cache Monaco at install; warm Pyodide on desktop post-activate; do not cache `/api/**`, `/yjs/**`, or any `wss:` traffic; show an **Update available** prompt on new versions. Deploy & Infra: single container on Railway; no NGINX.

— "RTC config: **one** y-webrtc config: maxConns: 12–15 to match our small-room cap; peerOpts: { config: { iceServers: [TURN 443 tcp+tls, STUN (dev only)] } }; signaling: ['wss://signaling.yjs.dev', '<our self-hosted URL>']; password: <room-scoped HMAC> to encrypt signaling. (WS provider always stays connected as fallback & persistence path.) 

— "UI: **Collaboration Mode** segmented control ("Server (default)" / "Peer Mode (P2P)") with header badge; tiny on-screen network indicator (Server vs P2P)."

**Observability.** Sentry plus custom counters for limits, Redis failures, export attempts, executor cache states, text commits, advanced slider usage, and toolbar interactions.

**Versioning & scripts.** Monorepo with `client` and `server` workspaces; asset bundling copies Vite build into `server/public` for Express to serve.

**Success criteria & KPIs.** Publish p50/p95 latency under scripted loads (50 users / 15 drawers); enforce 10 MB read-only at cap with 8 MB warning; ≤5 s worst-case write-to-persistence lag.

**Scope (in/out).** In: pen/highlighter/stamps, whole-stroke eraser, "Clear board (for everyone)", cursor trails, users list, copy-link, minimap, PNG export, per-run code execution, installable PWA. Out: auth/permissions, admin tools, recovery of expired rooms, cold storage, partial eraser, shape editing/selection, CDN, multi-node scaling, image uploads.

**AI Assistance (Mode A only).** Chat-only assistant that proposes diffs/tests; never writes to Yjs autonomously; Apply executes within a single `yjs.transact(...)` guarded by a hashed-span precondition; offline swaps to deterministic Quick Tools.

**Note:** mobile is **view-only**; write UI **MUST** be blocked with a visual gate.

---
# 2. System Architecture Overview

**High-level.** Client (React/TS, Canvas, Monaco, Pyodide, `y-indexeddb`) ⇄ `y-websocket` server (official)(OPTIONAL webrtc) ⇄ Redis (AOF) with configurable TTL (`ROOM_TTL_DAYS`, default: 14). WebSocket carries Yjs doc updates + awareness; HTTP serves room creation and metadata (Prisma/PostgreSQL). Single-container deployment (Railway).

**Data Paths:**
- **Authoritative path**: Client `WriteQueue` → `yjs.transact` → y-js struct update → `y-websocket` → server adapter → Redis compressed doc (AOF) → metadata sizing
- **Awareness path**: Client → WS awareness channel (or RTC DataChannel for awareness only) → other clients → snapshot injection **only** (never persisted)

**Integration Points:**
- **Redis adapter**: compression = gzip level 4; key `room:<id>`; TTL extension triggered **only** by accepted `WriteQueue` commits (not by awareness/reads)
- **Postgres (Prisma)**: non-authoritative metadata rows; 404 if Redis key missing
- **Service Worker**: cache policy rules (never cache `/api/**`, `/yjs/**`, or any `wss:`)

**Transport**. Client uses `y-websocket@3.x` (browser) and the backend runs the official `@y/websocket-server@0.1.x` (server-only). Client uses y-websocket@3.x and y-webrtc@10.3.0 (browser). The backend runs @y/websocket-server@0.1.x for authoritative persistence. y-webrtc uses separate signaling servers (public or self-hosted) and our TURN on 443; we keep WS connected at all times for durability and as the source-of-record. We wrap the server with an origin allowlist, per-IP and per-room capacity caps, and a 2 MB inbound frame cap, and bind it to Redis for persistence. Note: y-leveldb is installed only to satisfy a static import in the server package; Redis is the sole production store. y-websocket already separates Yjs doc updates from awareness; the server preserves that separation and only adds gateway error envelopes. URL contract: client builds wsBase + '/' + roomId, server expects /ws/<roomId>; with wsBase="/ws" the paths align.

**Storage authority.** Redis stores compressed Yjs docs with TTL; PostgreSQL stores non-authoritative metadata (id, title, createdAt, lastWriteAt, size_bytes); Redis presence defines existence.

**Transport (normative additions).**

— **Authority & transport.** Authority & transport. WebSocket remains the authoritative persistence path. y-webrtc may propagate updates P2P to reduce latency in small rooms; the WS provider persists whatever lands in the local Y.Doc. (WS stays connected even when P2P is active.)
y-websocket URL mapping (client builds baseUrl + '/' + roomId, server expects /ws/<roomId>; set baseUrl to ws://host/ws
— **Probe & keep.** On join (or toggle), run a ~2.5 s RTT probe using `currentRoundTripTime` for RTC and measured WS RTT. Keep RTC only if `rtcMedianRtt ≤ wsRtt − 20 ms` or (`wsRtt ≥ 70 ms` and `rtcMedianRtt < wsRtt`); else **tear down Y-WEBRTC** and stay WS-only. Use hysteresis to avoid flapping.

— **Peer cap & health.** **Do not** start y-webrtc when peers > 15 (default). If peers grow past the cap or CPU overheats, **drop y-webrtc**. If ICE transitions to `failed`/`disconnected` (> 5 s), **drop y-webrtc** and continue on WS.

— **Backpressure.** If `dataChannel.bufferedAmount` grows, **skip** the current awareness frame (freshness over reliability).

— **ICE.** Add `turns:<host>:443?transport=tcp` with long-term creds rotated server-side; keep a public STUN for dev; `bundlePolicy:'max-bundle'`; `iceCandidatePoolSize: 1-2`; **trickle ICE on**.
— **Direct pairing (optional).** Expose a P2P "Direct (Peer Mode)" flow: generate a **5-digit code** → map to `{roomId, rtcCredentials}` server-side (short TTL) → both peers enter code → use WS to exchange offer/answer/ICE for the same room. (No public signaling dependency.) 
-**Signaling** - y-webrtc signaling servers (public + self-hosted)

**Provider initialization races:** see **Initialization & Gates** for canonical order and gates.
---

# 3. **The RoomDocManager Model (Unified)**
**Principle.** Components must not receive `Y.Doc`, providers, or awareness. A single **RoomDocManager** per room owns them. Rendering reads immutable **Snapshots** published at most once per `requestAnimationFrame` or per batched Yjs update; no component reads live Y structures. Writes are coarse-grained: pointer-up commits whole stroke; eraser deletes a set in one transaction. Awareness is ephemeral, throttled, and injected into snapshots.

```typescript
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
  /** Single entry to mutate authoritative state. Runs in one yjs.transact. */
  write(cmd: Command): void;
  /** Force a TTL extension (tiny no-op write); client-rate-limited. */
  extendTTL(): void;
  /** Lifecycle */
  destroy(): void;
}
```
**Ownership**
- `RoomDocManager` **owns**: `Y.Doc`, `y-indexeddb` provider, `y-websocket` provider, y-webrtc optional RTC awareness channel, `WriteQueue`, `CommandBus`, `RBush` index, and publish loop.
- **UI code MAY NOT import `yjs`, providers, or mutate Y types**. ESLint rule enforced (`no-restricted-imports`).

**Publishing discipline**
- All renders read only from **frozen** `Snapshot` objects, never from live Y types.
- Publishing cadence addressed in **RAF & Publishing**.

**Construction.**
* `new Y.Doc({ guid: roomId })` exactly once; `guid` never mutated.
* Attach providers inside the manager:

  * **Persistence provider:** `y-indexeddb` for per-room offline storage.
  * **Realtime provider:** `y-websocket` bound to `/ws/<roomId>` with origin checks.
* Initialize a validated **WriteQueue** that batches logical operations and enforces backpressure, frame size (< 2 MB), and read-only/mobile guards.

**Public surface (React).**
* `useRoomSnapshot(roomId): Snapshot` — subscribes to the manager's published immutable snapshots (max 60 FPS).
* `usePresence(roomId): PresenceView` — derived, throttled presence view included in the snapshot.
* `useRoomStats(roomId): { bytes: number; cap: number } | null` — advisory header pill ≥ 80% cap; authoritative read-only banner at cap.
* `room.write(fn: (y: YDocFacade) => void): void` — enqueues a validated write; executes in a single `yjs.transact(...)`.
* `room.extendTTL(): void` — minimal Yjs write to extend TTL by `ROOM_TTL_DAYS` (rate-limited client-side).
**Snapshot publishing.** Manager batches doc changes and presence into a frozen `Snapshot` published ≤ 60 FPS via `rAF`. Renderers, hit-testing, minimap, and export read **only** from the current snapshot. Typed-array discipline: store `number[]` in Yjs; construct `Float32Array` at render time.
**Awareness.** Central subscription with ~30 Hz throttling; presence ticks 75-100 ms; awareness is never persisted and is injected into published snapshots only. Start WS awareness immediately. If small-room probe passes, instantiate WebrtcProvider with the same Y.Doc and shared awareness instance; otherwise destroy/disconnect it and run WS-only. G_AWARENESS_READY opens when either provider is live.

**Awareness (normative additions).**
— **Cadence & throttling.** Awareness send interval per client:
`interval = clamp(50ms * (1 + max(0,(N-10)/20)), 50ms, 150ms)`, permitting up to **200 ms** only when `N ≥ 60` or device is in battery saver; recompute only on **≥15%** change; apply **±10 ms** jitter; trailing-edge coalescing. Target ≤ ~300 inbound msgs/s at large N.
— **RTC optimization.** When RTC is active, cap awareness to **20-30 Hz** base; if `dataChannel.bufferedAmount > 128KB`, temporarily reduce to ~15 Hz; **drop** instead of queueing under pressure.
— **Receiver smoothing.** Interpolate cursor state (lerp) for 1-2 frames; on a missing frame, dead-reckon using last velocity for one frame. Awareness is never persisted and remains snapshot-injected only.
**ESLint enforcement.** UI components ban imports of `yjs`, `y-websocket`, and `y-indexeddb` and 'y-webrtc' via `no-restricted-imports`; access goes exclusively through hooks and `room.write(...)`.
**P2P assist (small rooms):** Client y-webrtc DataChannel → other clients apply updates locally; WS remains connected and persists whatever lands in the local Y.Doc (RTC never persists).When awareness uses RTC, the client still maintains WS awareness subscription for seamless fallback.

**Lifecycle.**

* **Create (offline-first):** generate `local-<ulid>`, construct `Y.Doc`, attach `y-indexeddb`, list in **My Rooms** with `provisional: true`.
* **Publish:** POST `/api/rooms`; join canonical room over WS; merge local state; alias `local-*` → server id.
* **Join:** resolve aliases; connect WS; load metadata; show expiry; enforce capacity/read-only.
* **Teardown:** abort executions → dispose Monaco → destroy providers → `ydoc.destroy()`; keep per-room IndexedDB for offline continuity.

**Limits & caps (normative).** Hard room size 10 MB → read-only; soft warn 8 MB. Hard capacity 105 clients; inbound WS frame cap 2 MB; flush cadence 2-3 s (≤ 5 s worst) to Redis; per-IP: 10 rooms/hour and up to 8 concurrent WS connections. y-webrtc uses a peer mesh and isn’t ideal for large rooms
---

# 4. Data Models & Schema Definitions
### 4.1 Yjs Document Logical Structure (authoritative)

```typescript
type StrokeId = string;     // ULID
type TextId   = string;     // ULID
type SceneIdx = number;     // 0-based

interface StrokePoint { x: number; y: number; p?: number } // p=pressure 0..1

interface Stroke {
  id: StrokeId;
  tool: 'pen' | 'highlighter';
  color: string;            // #RRGGBB
  size: number;             // world units (px at scale=1)
  opacity: number;          // 0..1; highlighter default 0.25
  points: number[];         // flattened [x0,y0,(p0?), x1,y1,(p1?), ...]; NEVER Float32Array
  bbox: [number, number, number, number]; // [minX, minY, maxX, maxY] world units
  scene: SceneIdx;          // assigned at commit
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
  scene: SceneIdx;
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
**Document root** (authoritative, Y.Map → JSON):
- `meta: Meta`
- `strokes: Stroke[]` (append-only; deletes are tombstones recorded in `deleted: Set<StrokeId>` if needed for later features)
- `texts: TextBlock[]` (immutable once committed)
- `code: CodeCell`
- `outputs: Output[]` (keep last 10; total ≤ 128 KB)
**Constraints**
- `MAX_POINTS_PER_STROKE = 10_000`
- `MAX_TOTAL_STROKES = 5_000`
- **Stroke simplification at pointer-up** (Douglas–Peucker in world units):
  - Base tol: pen `0.8 px`, highlighter `0.5 px`
  - Ensure encoded update ≤ `128 KB`; if not, `tol *= 1.4` once; else hard downsample
  - Highlighter tol bump capped at `1.5×`

**Awareness payload** (ephemeral; never persisted):
```typescript
interface Awareness {
  userId: string; name: string; color: string;
  cursor?: { x: number; y: number };            // world coordinates (always)
  activity: 'idle' | 'drawing' | 'typing';
  seq: number;                                   // monotonic per-sender
  ts: number;                                    // send time ms epoch
  aw_v?: number;                                 // awareness version for evolution
}
```
### 4.2 Timestamp Policy (Global)

**Canonical timestamp formats**:
- **HTTP/WebSocket JSON**: ISO-8601 UTC strings (e.g., `"2025-08-19T12:34:56Z"`)
- **CRDT/Document fields**: `number` type (milliseconds since epoch)
- **Examples**:
  - REST response: `{ "expires_at": "2025-08-19T12:34:56Z" }`
  - Yjs document: `{ createdAt: 1724070000123 }`
  - WS control frame: `{ "ts": "2025-08-19T12:34:56Z" }`
**WebSocket is hybrid: Yjs updates = binary; control = JSON**

### 4.3 Device-local UI State (non-authoritative)

Stored in `localStorage:key=avlo:v1:ui`

```typescript
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
}
```
**Versioned & migratable**. On schema change bump `:vN` and provide migrator.

**Authoritative model.** Yjs document persisted as compressed binary in Redis (`room:<roomId>`), AOF enabled; awareness is ephemeral. IndexedDB stores the full per-room `Y.Doc`, **My Rooms** list, and alias map.

**Yjs document (logical view).**
`meta.scene_ticks[]` (append-only, excluded from global Undo), `strokes[]` with max 10 000 points, `texts[]` (committed once, immutable), `code` (language ∈ {javascript, python}, max 200 KB), `outputs[]` (text ≤ 10 KB, keep last 10; total 128 KB). Current scene = `meta.scene_ticks.length`; rendering/export only include elements for the current scene.

**Constraints.** `MAX_POINTS_PER_STROKE = 10000`; `MAX_TOTAL_STROKES = 5000`; highlighter opacity 0.25; cursor preview 0.35; size captured at stroke start; text max length 500 chars.

**Awareness payload.** `{ name, color, cursor{x,y}, activity∈{idle,drawing,typing} }`; cadence 75-100 ms; send throttle ≈30 Hz.

**Redis storage.** Key `room:<roomId>` → compressed buffer; TTL = last accepted write; `ROOM_TTL_DAYS` (14) controllable via env and mirrored in UI; sizeBytes equals last persisted compressed payload size.

**My Rooms & aliases (IndexedDB).** Device-local metadata (title, last_opened, expires_at, provisional, aliasOf); server metadata refreshes when online; views/presence do not extend TTL; explicit **Extend** performs a tiny doc write and shows "Room extended to ...".

**Constraints (normative additions).**

— **Stroke simplification (pre-commit).** Always run Douglas–Peucker in **world units** at pointer-up. **Budgets:** encoded update ≤ **128 KB**; points ≤ **10,000**. **Base tolerance:** pen **0.8 px**, highlighter **0.5 px**. If over budget → `tol *= 1.4` and retry once; if still over → hard downsample to max points. Do **not** simplify text/stamps; cap highlighter tolerance bumps at **1.5×**.

---

# 5. API Contracts & Interfaces

**REST** 
- `POST /api/rooms` → create/publish room; returns `{ roomId, shareLink }` (`200` idempotent); `429` if per-IP 10 rooms/hour exceeded.
- `GET /api/rooms/{id}/metadata` → public non-sensitive metadata (`title`, `size_bytes`, `expires_at`, `created_at`); return `404` if Redis key missing even if DB row exists.
- `PUT /api/rooms/{id}` → rename `title`; `429` if more than 5/min.

**WebSocket** (`/ws/<roomId>`, Origin required) - **Hybrid Transport (Binary + JSON)**
- **Binary frames**: Yjs document deltas and awareness updates (via y-websocket protocol)
- **JSON control frames**: Server-to-client control messages with discriminator
- Inbound frame cap `2 MB`; close with code `1009` if exceeded.
- **Control frame schema**:
  ```typescript
  interface WSControlFrame {
    type: 'persist_ack' | 'error' | 'welcome' | 'roster' | 'stats';
    v: number;  // protocol version
    ts: string; // ISO-8601 UTC
    [key: string]: any;
  }
  ```
- **Error envelope schema**:
  ```typescript
  interface WSErrorFrame extends WSControlFrame {
    type: 'error';
    code: 'room_full' | 'room_full_readonly' | 'offline_delta_too_large';
    message: string;        // human-readable
    retryable: boolean;
    retry_in_ms?: number;   // if retryable
  }
  ```
- Reconnect policy: exponential backoff with jitter (see **Failure Modes & Backoffs**).

**AI Assistance (Mode A).** `POST /api/ai/complete` streams message + optional unified diff/tests; Apply guarded by hashed span; friendly error mapping for timeout/429/provider errors; large responses clamp with **Continue**.

**Direct pairing (optional):**
- `POST /api/direct/start` → returns `{ code: string }` (5 digits), `roomId: string`, `iceCreds: ICECredentials`
- `PUT /api/direct/claim` with `{ code: string }` → returns `{ roomId: string, iceCreds: ICECredentials }`
- **ICE Credentials schema**:
  ```typescript
  interface ICECredentials {
    urls: string[];         // e.g., ["turns:turn.example.com:443?transport=tcp"]
    username: string;
    credential: string;
    ttl_sec: number;        // seconds until expiry
  }
  ```
- **Notes:** Use the existing WS channel to exchange offer/answer/ICE for the same room; follows the same auth model (none). TURN credentials TTL: 90s, code expiry: 90s.

---

# 6. Functional Requirements

**Roles & permissions.** Single role (Editor) for all link holders; mobile is **view-only**: `WriteQueue.validate()` rejects writes on mobile with `reason='view_only'`; show banner. Banners/toasts clarify read-only, capacity full, and oversize updates.

**Whiteboard tools:**
- Pointer-down: preview only; **no write** until pointer-up commit.
- Pointer-up: build command (`DrawStrokeCommit`) → WriteQueue.
- Whole-object eraser: hit-test via RBush; batched delete command via `EraseObjects`.

Docked toolbar (left/pinned/expanded by default) with optional auto-hide; device-local toolbar state; keyboard navigable; tools: Pen/Highlighter/Stamps/Text; whole-object eraser; cursor trails with badges; minimal minimap; Undo/Redo scoped to user origin.

**Micro-UI.** Advanced size & hue, text overlay commit once, eraser preview & single-op delete, tooltips with shortcuts, zoom controls, cursor preview.

**Page management.** **Clear board (for everyone)** appends a scene tick; 10 s local Undo window; server rate-limit (1/15 s); no page history. **Scene tick** excluded from undo/redo.

**Export.** PNG export for viewport/entire board (visible elements only), max long edge 8192 px, 24 px padding, white background; ≥ 2 s falls back to viewport with toast; clipboard export when supported. Hard timeout and fallback rules; add explicit **render budget** (max 16 ms per frame chunk; yield when exceeded).

**Code execution.** Per-run fresh workers for JS/Pyodide; 5 s hard timeout; 10 KB per-run output cap; keep last 10 outputs (128 KB total). No network/FS in workers.

**Service Worker & PWA.** Cache-first HTML navigations; pre-cache Monaco; silently warm Pyodide on desktop; no caching for `/api/**`, `/yjs/**`, or WS; show update prompt; installable manifest with icons. Precache fonts/icons (self-hosted WOFF2, SVG, maskable icon).  Runtime LRU cache for avatars & thumbnails (hashed → Cache-First; otherwise Stale-While-Revalidate), with size/age caps.  Runtime embedded media caching (stable CDN URLs only) with caps/eviction. 
Precache/warm heavy dynamic-import bundles (workers/exporters/pickers/etc.).  Precache localization/static JSON; keep dynamic flags out of SW. 
Guardrails: version cache names + cleanupOutdatedCaches(), keep separate buckets (app-shell, media-cache, avatars-thumbs, offline-pack).
**Room lifecycle.** Local-first creation with provisional ids; online publish merges to server doc; join/size/capacity/expiry enforcement; Extend performs minimal write and shows confirmation toast; PUT rename (rate-limited).

**My Rooms.** Device-local list with provisional/published; delete only removes local entry; per-room `Y.Doc` persists until explicit **Delete local copy**.

**UI requirements (non-visual).** 70/30 split, resizer, toggable IDE, copy-link toast, central toasts, dark mode (whiteboard and exports white), accessibility on ranges/popovers, connection indicator (Online/Reconnecting/Offline/Read-only), stats pill ≥ 80% cap and banner at cap.

**AI Assistance (Mode A).** Docked panel, first-run open only, two slots with resizer, composer with 10 s clamp, Apply guarded by hashed span and conflict UX, offline swap to Quick Tools, telemetry.

**Collaboration Mode & Indicators (additions).**
Provide a control labeled **Collaboration Mode** with **Server (default)** and **Peer Mode (P2P)**. Remember per-device. Show a header badge (**Server** or **Peer Mode On **). If y-webRTC health degrades, silently fall back to Server (WS) and update the badge.

**Push-to-Talk (optional, additions).**
**Single active speaker** with a floor/token protocol over the awareness y-webrtc DataChannel (`ptt:req`, `ptt:grant`, `ptt:rel`, `ptt:nack` + optional heartbeat). Join with an **audio recv-only** transceiver; on first grant, request mic, add **send-only** transceiver, perform **one** renegotiation, and cap Opus **≈32 kbps**. Subsequent presses use `sender.replaceTrack(...)`. Auto-release at **60 s** or on heartbeat loss. Minimal UI: hold-to-talk button + Spacebar; disable drawing while pressed; show "🎙️ speaking".

**Undo/Redo**: per-user scoped; define `origin=userId` for transactions; **scene_tick** excluded.
## Global Conventions
- **Timestamps:** ISO-8601 UTC strings for HTTP/WS JSON; **epoch ms** inside CRDT/Y structures.
- **New constants live in `config.ts`** with env overrides.
---

# 7. Non-Functional Requirements

**Performance.** Render at 60 FPS via dirty-rect redraw + culling; publish measured p50/p95; **target** (non-normative) ≤ 125 ms p95 with ~50 users and ≤ 15 drawers.

**Scalability.** Single-node MVP; multi-node later with pub/sub for Yjs. 

**Security.** CSP profile, HSTS after TLS stable; `nosniff`; `no-referrer`; WS frame cap 2 MB; no session tokens; upgrades validated with Origin + roomId; **Origin allowlist** config and 403 behavior. password in WebrtcProvider encrypts signaling and prevents MITM on public signaling servers; recommend a room-scoped HMAC.

**Availability.** "TTL janitor" every hour; final Redis flush on process SIGTERM with 3 s grace. TTL-based retention; AOF enabled; idle GC and final flush; no recovery after expiry. **Degraded mode.** Collaboration proceeds if Postgres is unavailable; metadata endpoints may 503.

**Usability & accessibility.** Clear toasts and help copy; no auto-panning due to remote actions; popovers focus-trapped; AI panel announces connectivity via ARIA; toolbar never auto-reveals while drawing. **Maintainability.** Unobserve all Yjs observers on unmount; Sentry + counters; assistant bundle is lazy-loaded. **PWA constraints.** Do not cache `/api/**` or `/yjs/**`; SW must not intercept WebSocket traffic; Pyodide warmed on desktop only; maintain asset budgets.

**Transport runtime policy (additions).**
Auto mode (default): start WS immediately; for rooms ≤ 12 peers, also bring up RTC and probe; keep only on a clear win; drop RTC if peers > 15, CPU hot, or ICE troubled. Direct mode: code pairing, hard cap 8 peers, same drop rules.

**Observability.** Add counters/histograms:
- `join_time_ms` (hist)
- `rtc_probe_ms` (hist), `rtc_kept` (counter), `rtc_dropped_reason{cap|rtt|ice|cpu}` (counter)
- `rtc_probe_delta_ms` (hist) — `wsRtt - rtcMedianRtt`
- `dc_buffered_drops` (counter)
- `cursor_render_gap_ms_p95` (gauge)
- `awareness_send_hz` (gauge), `awareness_skip_count` (counter)
- `writequeue_reject{reason}` (counter) reasons: `view_only|read_only|oversize|mobile`
- `persist_lag_ms` (hist) (doc update → Redis ack)
- `room_size_bytes` (gauge), `room_cap_ratio` (gauge)
- `ws_reconnects` (counter), `ws_backoff_ms` (hist)
- `export_fallbacks` (counter)
- PTT: `ptt_granted`, `ptt_denied_busy`, `ptt_duration_ms`, `ptt_renegotiations`
- webrtc_signaling_connect_ms, webrtc_connected_peers, and webrtc_provider_errors{ice|signaling
Treat RTC default-on for small rooms as justified **only if** median `rtc_probe_delta_ms` > **20 ms** and `cursor_render_gap_ms_p95` improves by **>25%** for rooms ≤ 12.
Async-apply contract. Any async result applied to UI must verify svKey or drop; this eliminates temporal wormholes. (ref §15) 
Probe policy (normative). Default-on RTC for small rooms is justified only if rtcMedianRtt ≤ wsRtt − 20 ms and cursor_render_gap_ms_p95 improves by > 25%; otherwise drop RTC. (ref §7 Observability additions) 
Awareness characteristics. Awareness is ephemeral, non-authoritative, lossy under backpressure; sequence-based drop rules apply. (ref §C) 
Thresholds remain normative. Inbound WS frame cap 2 MB; Warn/RO 8 MB/10 MB; WS/RTC buffer high/low water marks as defined in table E. (ref §E)
---

# 8. **Data Architecture & Flows**
**Stores.** Yjs doc (authoritative) → Redis TTL; Awareness → WS only; IndexedDB → per-room `Y.Doc`, **My Rooms**, aliases; localStorage → device-local UI state (toolbar, AI panel). PostgreSQL → non-authoritative metadata.

**Write Queue Pattern (critical).** All mutations pass `WriteQueue.validate()` (read-only, view-only, frame size) → batch → single `yjs.transact()` per logical op → DocManager notified → frozen snapshot published. Strokes/text/eraser/scene-tick/export/outputs/extend/AI-Apply all follow this pipeline with hashed-span preconditions where applicable.

**Canvas & indexing.** LOD thresholds, render order (strokes → stamps → text), RBush maintenance and rebuild heuristics, eraser hit-testing, no auto-pan on remote actions.

**Service Worker / caching.** Cache-first HTML; pre-cache Monaco; desktop-only silent Pyodide warm; immutable `/pyodide/<version>/**`; never cache API/Yjs/WS; update prompt on new app version. **Data transforms.** gzip level 4 before Redis; `size_bytes` equals last persisted compressed payload size. **Privacy/retention.** TTL extends only on accepted writes; awareness/views do not extend; expiry deletes permanently.

### 8.1 Draw Stroke (authoritative)
1. **UI** captures pointer stream → local preview (no writes).
2. On **pointer-up**:
   - Derive world points from screen coords using **Coordinate Spaces** contract.
   - Simplify per rules; compute bbox.
   - Build `DrawStrokeCommit` command (idempotencyKey = strokeId).
3. **WriteQueue.validate()**:
   - Reject if read-only (room ≥ 10 MB), mobile view-only, frame size > 2 MB.
4. **CommandBus.execute()** in one `yjs.transact()`:
   - Append `Stroke` to `strokes[]` for `scene = currentScene`.
5. **DocManager**:
   - Batches Y updates; publishes new **Snapshot** at next rAF.
6. **Transport**:
   - y-websocket sends delta; server persists; Redis TTL extended.
Include variants: **offline**, **oversize**, **capacity full**, **WS disconnected** (see backoffs).

### 8.2 Clear Board (for everyone)
- Gate with **server rate-limit** 1/15 s; local **10 s** undo window.
- Implementation: append to `meta.scene_ticks[]`; currentScene = length.
- Rendering includes only elements with `scene === currentScene`.
### 8.3 Code Run
- **Per-run worker**; hard timeouts; no network/FS.
- Append `outputs[]` with clamp to last 10 items; enforce 128 KB total.

**Flows (additions).**
— **Micro-batching.** Coalesce Yjs updates into **8-16 ms** frames, expanding to **24-32 ms** under backpressure; apply the same windowing regardless of transport.
— **IndexedDB snapshots.** Persist last-known render snapshot keyed by Yjs state vector; on load, if vectors match, render snapshot immediately while live components initialize; otherwise skip snapshot.
— **IDB write/read strategy.** Batch writes once per frame or when queue ≥ **1,000** strokes; perform chunked reads via `getAll/getAllKeys` in **1k-5k** record chunks, yielding to the event loop between chunks.

## **Additional Essential Data Flows**

1. **Persist‑ack → UI stats refresh (authoritative read path)**
   After a write is durably flushed, the server emits a `persist_ack` (including doc size, new TTL, and current state vector key). The client treats this as the source of truth for pills/banners and re‑computes the header stats from the ack, not from local estimates.
2. **TTL extension semantics (and no‑ops)**
   Only accepted *writes* extend TTL; passive views, awareness pings, or failed writes do **not**. The client updates the “expires in …” indicator on ack and shows a distinct affordance if the TTL is within the warning window.
3. **Redis flush window → Postgres backfill**
   Writes land in Redis first (room existence + content) and are flushed in a window. Postgres is updated with metadata (`sizeBytes`, `lastWriteAt`) for list/read APIs. If Postgres is temporarily unavailable, Redis still governs room truth; on recovery, a backfill corrects metadata.
4. **Oversize & backpressure (pre‑write guardrail)**
   The client estimates payload size before sending. If above soft limit, warn; if above hard limit, block and offer guidance. When backpressure is active, awareness signals are coalesced/dropped so foreground edits keep bandwidth.
5. **Large offline delta (resume guardrail)**
   On reconnect, if the pending local delta exceeds a safe threshold, the client surfaces a clear error and proposes actions (refresh, rejoin, or manual export) instead of attempting a risky merge.
6. **Awareness authority & dedupe across WS/RTC**
   Awareness is rate‑limited and digested on send; the server applies drop rules and forwards a deduped stream. Receivers interpolate cursors/avatars smoothly. The WS roster is the peer count source of truth even when RTC is active, preventing double‑counting.
7. **ICE/TURN credential delivery + refresh**
   Clients fetch time‑boxed TURN credentials from the server. Before expiry, they refresh; on failure, they fall back to server‑mediated transport (WS) without breaking the editing session.

8. **Offline‑first publish & alias resolution**
   Local creation yields a room with a provisional alias. On first sync: server allocates the canonical room key, merges content, and resolves the alias mapping. Clients store both (for backlinks and history) but render only the canonical alias going forward.
9. **Expiry → local cleanup UX**
   When a room expires (Redis TTL), metadata reads 404. The client removes server mappings, keeps the local Y.Doc (with a banner explaining the state), and offers a one‑click “create new room from local copy.”
10. **Schema/versioning & migrations**
    Docs carry a schema/state‑vector key. On open, the client migrates older schemas, writes the migrated shape, and re‑keys snapshots/IDB entries. Hard mismatches trigger a soft‑fail with export instructions rather than corrupting content.
11. **Code‑cell concurrency & conflicts**
    Code cell submissions include a version token. Server accepts if current; otherwise, it rejects with “stale version,” prompting the client to refresh cell input or switch that lane to CRDT if configured.
12. **Observability routing (metrics & logs)**
    Client and server emit counters/histograms with bounded cardinality (room IDs hashed; no content or PII). Errors go to the logging sink; flow‑level timings (persist, ack, export) power SLO dashboards.
13. **Security envelope for link access**
    Enforce origin allowlist, per‑room capacity/size gates, and rate limits. No bearer tokens in links; mitigate abuse via transport limits (frame caps, bandwidth ceilings) and server‑side validation on write paths.
14. **Export pipeline & graceful fallbacks**
    Export requests stream results in chunks to avoid UI stalls. If a full export exceeds budget, the client offers a viewport‑only export with a note explaining the trade‑off and emits telemetry
15. **Shutdown flush & startup replay expectations**
    On SIGTERM, the service drains in‑flight writes and flushes. On startup, rooms exist iff their Redis keys exist; there’s no replay beyond the durable store, so operators should not expect reconstruction from logs.
---
### Notes for Readers
* The exact limits (payload sizes, TTL warning window, flush intervals) live with the **Limits & Thresholds** section; this page only states the flows.
* Error banners/tooltips quote friendly user guidance; structured error codes go to telemetry for diagnostics.

---
# 9. Dependencies & Integrations
**Hard MVP.** Yjs, `y-websocket`, `y-indexeddb`, 'y-webrtc', Monaco, Pyodide, Redis, Prisma, PostgreSQL; vendored static assets for Monaco & Pyodide; Playwright for E2E; ESLint/Prettier/Husky/lint-staged in dev; plus internal canvas/minimap/toast/PWA assets.
**Exact versions:**
- `y-websocket@3.x` browser + `@y/websocket-server@0.1.x` server (no y-leveldb at runtime)
- Redis 5.8.1 AOF enabled; gzip level 4; `size_bytes` = compressed length
- **TURN**: tcp+tls on 443; long-term creds rotated; **STUN** dev only
**AuthN/AuthZ.** None; link-based open access by design. **Monitoring.** Sentry + counters (no content logging).

**Operational (additions).**
**Connection pooling.** Postgres: `pg.Pool` size **10-20**, set idle/acquire timeouts, and log slow queries. Redis: one client for commands and one for pub/sub per process; health checks and reconnect backoff.
Add y-webrtc@10.3.0.
Env: Y_SIGNALING_URLS, Y_RTC_MAX_CONNS, Y_TURN_URL, Y_TURN_USER, Y_TURN_PASS, Y_RTC_PASSWORD_SALT.
Self-hosted signaling (optional): include bin/server.js from y-webrtc or an equivalent deployment; keep public wss://signaling.yjs.dev as a backup
---
# 10. Validation & Testing
**Acceptance (major).**
* Size enforcement: ≥ 8 MB header pill; at 10 MB switch to read-only with persistent banner; updates rejected.
* TTL expiry → 404 metadata if Redis key missing even with DB row.
* Capacity limit → `room_full`.
* Cold-start offline: app shell + Monaco available; Python becomes available offline after silent warm; early runs queue.
* Export correctness and fallbacks.
* Scene/visibility correctness for current scene only.
* PWA installability; offline app-shell on first run; update prompt on new builds.
* Local-first rooms publish/merge/alias; share link minted.
* Undo/Redo scope and grouping; scene-tick/keep-alive excluded.
* Shortcuts, connection indicator states, clipboard export fallbacks.
* AI preconditions, conflict UX, offline Quick Tools, timeout/429 mapping, large-response clamp with **Continue**.

Add exhaustive acceptance tests for:
- **Init & Gates**: force timeouts to verify fallbacks (IDB, WS, Awareness).
- **WriteQueue** validation: size cap, mobile view-only, oversized delta rejection.
- **Command idempotency**: repeat `DrawStrokeCommit`, `ClearBoard` rapid press.
- **Awareness**: seq monotonic drop; buffer pressure rate-reduction.
- **RTC probe & hysteresis**: synthetic RTTs cause correct keep/drop.
- **Snapshot invariants**: never null; `svKey` changes only on Y update.
- **Temporal wormholes**: async task dropped when `svKey` mismatches.
- **Coordinate transforms**: canvas→world correctness under zoom/pan; export boundaries.
- **Backoffs**: WS reconnect schedule; RTC drop on `failed`.
- **Read-only gate**: at 10 MB blocked writes, banners correct; at 8 MB pill appears.
- **Metadata 404 on TTL expiry**: room vanishes despite DB row.

**E2E harness.** Root Playwright config; `e2e/*` specs (create room, clear board, read-only cap, offline Quick Tools, AI precondition banner); prefer role-based selectors and normative strings. Provide **named tests** matching acceptance bullets; include synthetic network shapers (RTT/packet-loss) and CPU throttling to trigger RTC drop rules. Add **golden snapshots** for coordinate transforms at zoom 0.5/1/2 with known inputs/outputs.
---

# 11. Initialization & Gates
Define explicit **init order**, **gates**, **timeouts**, and **what they unblock**.
### 11.1 Init Order (single tab, one room)
1. **Construct RoomDocManager**
   - Create `Y.Doc({ guid: roomId })` **exactly once**.
2. **Attach y-indexeddb provider**
   - Gate `G_IDB_READY` when initial load applies; timeout **2 s** (fallback to empty doc).
3. **Attach y-websocket provider**
   - Connect immediately (do not wait for IDB).
   - Gate `G_WS_CONNECTED` on open; `G_WS_SYNCED` after first `syncStep2`/state-vector exchange completes.
4. **Awareness**
   - Start WS awareness immediately.
   - If **RTC small-room probe** eligible (peers ≤ 12), start RTC and run probe (2.5 s).
   - Gate `G_AWARENESS_READY` when at least **one** channel (WS or RTC) is healthy.
5. **Snapshot**
   - Build **non-null EmptySnapshot** synchronously (prevents null access).
   - Gate `G_FIRST_SNAPSHOT` when first doc-derived snapshot is published (≤ 1 rAF after any Y update or after init).
6. **Render Loop**
   - Start rAF publisher on manager creation; publish **idle snapshots** (awareness + empty doc) until Y updates arrive.

### 11.2 Gates Table
| Gate | Opens When | Unblocks | Timeout | On Timeout |
|:-----|:-----------|:---------|:--------|:-----------|
| `G_IDB_READY` | y-indexeddb loaded or 2 s elapsed | initial snapshot hydration; "Recent Rooms" badge | 2 s | proceed with empty doc; schedule background re-hydration |
| `G_WS_CONNECTED` | WS open | WS awareness, doc sync | 5 s | show "Reconnecting…"; proceed offline if IDB ready |
| `G_WS_SYNCED` | first Y sync completes | authoritative render | 10 s | keep rendering from IDB; continue syncing |
| `G_AWARENESS_READY` | WS or RTC awareness live | cursors/presence | 5 s | show "Presence degraded" indicator |
| `G_FIRST_SNAPSHOT` | first publish | UI enables hit-testing, export | 1 rAF | N/A |

**Where to gate writes**:
- Before `G_WS_CONNECTED`: **ALLOW** writes (offline-first) to Y doc via IDB; queue persists; WS sync later.
- When **room read-only** (≥ 10 MB) or **mobile**: **BLOCK** in `WriteQueue.validate()` with UX banner.
- Before `G_FIRST_SNAPSHOT`: **BLOCK exports** and **minimap**; allow drawing.
---
# 12. State Synchronization & Derivation
**Sources:**
- **Authoritative**: Yjs doc (Redis mirror).
- **Ephemeral**: Awareness (WS/RTC).
- **Local**: Device UI state (localStorage).
- **Metadata**: `/api/rooms/{id}/metadata` (size, expiry).
**Derived State** (computed inside manager on publish):
- `currentScene = meta.scene_ticks.length`
- `docStats = { bytes, cap: 10MB }` (from metadata poll every 10 s or on successful persist ack)
- `presenceView` throttled & interpolated
**Consistency rules:**
- **Never** write derived values into Yjs (e.g., `bbox` MAY be stored to avoid recompute; all other derivations remain ephemeral).
- Snapshot MUST reflect a **single state vector** at the moment of capture; include `sv: Uint8Array` to key **IDB render snapshot**.
---
# 13. Command Bus & Write Queue
### 13.1 Commands
List and define **all** commands with inputs, idempotency, preconditions:
```typescript
type Command =
  | { type: 'DrawStrokeCommit'; id: StrokeId; tool:'pen'|'highlighter'; color:string; size:number; opacity:number; points:number[]; bbox:[number,number,number,number]; startedAt:number; finishedAt:number; scene?: SceneIdx }
  | { type: 'EraseObjects'; ids: StrokeId[] | TextId[] }
  | { type: 'AddText'; id: TextId; x:number; y:number; w:number; h:number; content:string; color:string; size:number }
  | { type: 'ClearBoard' }
  | { type: 'ExtendTTL' }
  | { type: 'CodeUpdate'; lang:'javascript'|'python'; body:string; version:number }
  | { type: 'CodeRun' }
```
**Idempotency:**
- `DrawStrokeCommit`, `AddText` keyed by `id`.
- `ClearBoard` keyed by `(sceneIdxBefore, tsBucket)` to avoid repeat in rapid clicks; server rate-limit also applies.
- `ExtendTTL` client-rate-limited **≥ 10 min** between calls.

**WriteQueue.validate(cmd)**:
- Reject when `docStats.bytes ≥ 10MB` (read-only), or mobile.
- Estimate encoded delta size; reject if > 2 MB.
- Enforce `MAX_POINTS_PER_STROKE` and body ≤ 200 KB.
**Execution**: `CommandBus.execute()` wraps **exactly one** `yjs.transact(...)` per logical command.
### 13.2 Backpressure
- **Queue**: max pending commands = 100; if exceeded, drop newest `awareness` emissions; throttle pointer-up commits by **50 ms**.
- **Flush**: drain at micro-batch windows (8-16 ms), expandable to 24-32 ms under pressure.
---
# 14. Snapshot Contract
Define **precisely** what is in `Snapshot` and **never null**:
```typescript
interface Snapshot {
  svKey: string; // base64 of Yjs state vector; keys IDB render snapshot
  scene: SceneIdx;
  strokes: ReadonlyArray<StrokeView>;
  texts: ReadonlyArray<TextView>;
  presence: PresenceView;         // derived + smoothed
  spatialIndex: RBushIndexView;   // read-only index for hit-testing
  view: ViewTransform;            // world->canvas transform
  meta: { bytes?: number; cap: number; readOnly: boolean; expiresAt?: number };
  createdAt: number;              // ms epoch when snapshot frozen
}
interface StrokeView {
  id: string;
  polyline: Float32Array; // built at render from number[]
  style: { color:string; size:number; opacity:number; tool:'pen'|'highlighter' };
  bbox: [number,number,number,number];
}
```
- **Typed arrays** are **constructed at render only**; stored doc remains plain arrays.
- **Preventing null snapshot**: On manager creation, publish `EmptySnapshot` with `scene=0`, empty arrays, identity transform, `meta.readOnly=false`.
---
# 15. Avoiding Temporal Wormholes & Stable Refs
- **Rule**: UI MUST NOT hold references to live Y objects or rely on their identity across frames.
- **Stable identity**: Use `id` strings; Snapshot arrays are **new immutable** arrays per publish; do not mutate.
- **Correlation across frames**: Use `id` map lookups; never retain object references.
- **Timers/async**: Any async task must capture `svKey` and **verify** it matches `currentSnapshot.svKey` on apply; otherwise **discard** to avoid applying stale work.
---
# 16. Where to Gate
Provide a table specifying **feature → gate**:
| Feature | Gate(s) | Behavior when closed |
|:--------|:--------|:---------------------|
| Drawing | none (offline-first) | Writes go to local Y+IDB; WS sync later |
| Export PNG | `G_FIRST_SNAPSHOT` | Disable button; tooltip "Preparing board…" |
| Minimap | `G_FIRST_SNAPSHOT` | Hide |
| Presence cursors | `G_AWARENESS_READY` | Show "Presence degraded" |
| Extend TTL | `G_WS_CONNECTED` | Disable; show tooltip |
| Clear Board | server rate-limit + local debounce | Toast if dropped |
---
# 17. Event Isolation & Canvas
- **UI events** (pointer/mouse/keyboard) MUST NOT mutate Y state directly.
- All mutations pass through **commands** at **pointer-up** or explicit actions.
- **Canvas renderer**:
  - Renders at **60 FPS** with dirty-rect culling.
  - **No auto-pan** due to remote actions.
  - **Hit-testing** via RBush built from Snapshot; never touches Y live data.
**Draw order for Canvas**:
1. Background (export uses white background). 
2. World layers: strokes → stamps/shapes → text. 
3. Authoring overlays: selection boxes/handles, text caret/selection.
4. Presence overlays: remote cursors/trails (renders only when G_AWARENESS_READY + G_FIRST_SNAPSHOT). 
5. HUD/UI overlays: minimap, update prompts, toasts (never included in export).
Export rule: include (1)–(2); exclude (3)–(5). Render loop remains ≤60 FPS with dirty-rect culling.
- **Isolation**: While "Push-to-talk" active, drawing is disabled; awareness still emitted.
---
# 18. Coordinate Spaces & Transforms
Specify the **contract** between **screen**, **canvas**, and **document/world** spaces:
- **Document/world**: stable units in which strokes/text positions are stored.
- **Canvas**: backing `<canvas>` device pixels; size derived from **element** but world size may be **doc-level `meta.canvas`** reference.
- **Screen**: CSS pixels.
- **Transform contract**:
  ```typescript
  interface ViewTransform {
    worldToCanvas: (x:number,y:number)=>[number,number];
    canvasToWorld: (x:number,y:number)=>[number,number];
    scale: number;  // world px → canvas px
    pan: { x:number; y:number }; // world offset
  }
  ```
- **Canvas dimensions**
  - If `meta.canvas` present: treat `(baseW, baseH)` as world reference; maintain aspect-fit in element rect.
  - Else: derive world size from initial element box once; store in memory (not persisted) until user **exports**—export uses current world bounds.
- **Pointer conversion**: Always via `canvasToWorld`, never ad-hoc arithmetic.
---
# 19. Transport Ordering & Flow Control
- **Yjs doc updates**: rely on CRDT causality; `y-websocket` ordering is sufficient.
- **Awareness channel**:
  - If **y-webrtc** used: `ordered:false, maxRetransmits:0` (lossy). Add **per-sender `seq`**; drop frames with `seq ≤ lastSeq` (mod 2^31 wrap).
  - If **WS** used: treat awareness as best-effort; do not queue on backpressure; **skip** frames.
- **Flow control**:
  - If `dataChannel.bufferedAmount > 128 KB` → reduce send rate to **15 Hz**; drop instead of queue.
  - If WS send buffer exceeds **64 KB** (browser API permitting checks) → coalesce and skip up to next tick.
- **Message ordering**:
  - Awareness processed **before** snapshot publish if received in same tick; otherwise makes next frame.
---
# 20. Offline/Online Orchestration
- **Offline-first**:
  - Writes accepted at all times (desktop); persisted to IDB; when WS reconnects, CRDT merges.
- **Connectivity transitions**:
  - On `online` event: trigger metadata refresh; run small "keep-alive write" only if ≤ once per 10 min to extend TTL.
  - On `offline`: pause metadata polling; keep awareness cursors locally only.
- **Large offline delta**:
  - If server responds `offline_delta_too_large`: show blocking banner with **two choices**: "Export & Reset" (keeps local export, clears local doc) or "Discard Local Changes & Rejoin Server".
  - Exact thresholds defined in server; client copies reason text.
---
# 21. Ownership & Observation Model
- **Single ownership**:
  - `RoomDocManager` owns providers and **solely** observes Y types.
  - UI relies on **subscriptions** only; no direct observers of Y types anywhere else.
- **Centralized subscription**:
  - Awareness subscription is centralized; presence derivation happens inside manager with smoothing (lerp 1-2 frames; one-frame dead-reckon on miss).
---
# 22. Failure Modes & Backoffs
- **WS reconnect**:
  - Backoff = `min(20 s, base*(2^retries))` with `base=300 ms`, jitter ±20%.
  - Reset retry counter after 30 s steady connection.
- **RTC health**:
  - Drop RTC on `failed|disconnected` > 5 s; fall back to WS.
- **Redis size/read-only**:
  - If write rejected due to size cap: set `readOnly=true` in Snapshot meta; banner persists until room shrinks (not supported) or TTL expiry.
- **Capacity (`room_full`)**:
  - Show blocking modal; allow **view-only** join if capacity gate provides read-only seat (server-driven).
- **IDB errors**:
  - Surface "Local storage degraded" toast; proceed WS-only.
---
# 23. WS Chaos Avoidance
- **Capacity caps** (server):
  - Hard room size 10 MB; total clients 105; inbound frame 2 MB.
- **Peer cap** (client):
  - RTC not started when peers > 15; drop RTC if peers cross 15 or CPU hot.
- **Skips vs Queues**:
  - Awareness prefers **skip** (freshness); never attempt reliability on RTC channel.
**Code stub for Webrtc**:
Code stub to drop in
import { WebrtcProvider } from 'y-webrtc'
import * as awarenessProtocol from 'y-protocols/awareness'
const awareness = new awarenessProtocol.Awareness(ydoc)
const provider = new WebrtcProvider(roomId, ydoc, {
  signaling: [ 'wss://signaling.yjs.dev', process.env.Y_SIGNALING_URL! ].filter(Boolean),
  maxConns: 15,
  password: hmacRoomScopedSecret(roomId),
  awareness,
  peerOpts: {
    config: { iceServers: [
      { urls: 'stun:stun.l.google.com:19302' }, // dev only
      { urls: 'turns:turn.example.com:443?transport=tcp', username: TURN_USER, credential: TURN_PASS }
    ]}
  }
})
(Provider stays connected only when the probe says it’s a win; otherwise call provider.destroy() and rely on WS.)
---
# 24. RAF & Publishing
**Publisher** runs a single rAF loop per room tab:
- **Input windows**: coalesce Y updates for **8-16 ms**; expand to **24-32 ms** under pressure (when publish work > 8 ms).
- **FPS policy**: cap at 60 FPS; if hidden tab, switch to `setTimeout(1000/8)` (8 FPS).
- **Work budgeting**: rendering prep (RBush rebuild, path building) soft budget **6 ms**; if exceeded, split across frames.
**Export path**:
- If export prep exceeds **2 s**, fall back to viewport export with toast; never block UI thread longer than **16 ms** bursts.
---
# UI Contracts
**Collaboration Mode** segmented control:
- When "Peer Mode (P2P)" selected: attempt RTC **only** if peers ≤ 12; otherwise show tooltip "P2P not available in large rooms"; auto-fallback to Server with badge update.
**Network indicator**:
- States: `Server` (WS-only), `Peer Mode On (Small Room)`, `Degraded` (awareness only via WS and RTC disabled), `Offline`.
**Stats pill & read-only banner**:
- Pill shown at `bytes ≥ 8 MB` (from metadata poll or persist ack).
- Banner locks writes at `bytes ≥ 10 MB`.
---
# Appendix A: Exact Algorithms
1. **y-webrtc vs WS Probe**:
   - Measure WS RTT (ping–pong 5 samples, median).
   - Establish y-webrtc DataChannel; measure `currentRoundTripTime` for 2.5 s; compute median.
   - **Keep RTC** iff `(rtcMedian ≤ wsRtt − 20 ms)` OR `(wsRtt ≥ 70 ms AND rtcMedian < wsRtt)`.
   - Apply **hysteresis**: once kept, only drop due to cap/CPU/ICE issues, not minor RTT regressions.
2. **Awareness Send Interval**:
   ```
   N = peers
   base = 50ms * (1 + max(0, (N-10)/20))
   interval = clamp(base, 50ms, 150ms)   // WS
   RTC base target 33-50ms (20-30 Hz)
   jitter ±10ms, recompute on ≥15% change, trailing-edge coalesce
   ```
   - Under pressure: if `bufferedAmount > 128KB` → interval ≈ 66ms (15 Hz).
3. **Micro-batching**:
   - Window `8-16 ms` for Y updates; if publish time last frame > 8 ms, expand to `24-32 ms` until budget recovers.
4. **RBush Maintenance**:
   - Rebuild when `(added+removed) > 256` or `(deltaBBoxArea / totalArea) > 0.15`.
   - Otherwise incremental updates per commit.
5. **Douglas–Peucker Simplification**:
   - Operate in **world units**; ensure `points.length/2 ≤ 10_000` and encoded diff ≤ 128 KB.
   - One retry with `tol *= 1.4`; otherwise uniform downsample.
---
# Appendix B: Invariants & Assertions (keep in code as dev-only)
- `Snapshot` is **never null**.
- All Snapshot arrays are **frozen**; mutating them throws in dev.
- Yjs writes occur **only** inside `CommandBus.execute()` transactions.
- `Awareness.seq` is strictly increasing per sender.
- `svKey` only changes after a Yjs update apply.
---
# Appendix C: Backoff Parameters (centralized constants)
```typescript
export const BACKOFF = {
  wsBaseMs: 300,
  wsMaxMs: 20000,
  wsJitter: 0.2,
  rtcIceFailGraceMs: 5000,
  ttlExtendCooldownMs: 10*60*1000,
  awarenessRtcBufferHigh: 128*1024,
  awarenessWsBufferHigh: 64*1024,
};
```
---
# Appendix D: Test Plan Addendum (Playwright/E2E)
- Provide **named tests** matching acceptance bullets; include synthetic network shapers (RTT/packet-loss) and CPU throttling to trigger RTC drop rules.
- Add **golden snapshots** for coordinate transforms at zoom 0.5/1/2 with known inputs/outputs.
---

# Appendix E: Awareness De-Dup (WS + RTC)
**Goal.** When both WS and RTC awareness are live, ensure a single, monotonic ordering per sender and avoid double-processing.
1. **Per-sender monotonic `seq` (cross-channel).**
   * Each sender maintains a single `seq` across both WS and RTC awareness pipelines.
   * Receiver keeps `lastSeqBySender[clientId]`. **Drop** any frame with `seq ≤ lastSeqBySender[clientId]`.
2. **Channel preference & muting.**
   * When the **RTC probe keeps RTC** (per “Probe & keep”), **prefer RTC** for both send & receive. WS awareness **send** is muted; WS awareness **receive** remains enabled but frames are dropped if `seq ≤ lastSeq`.&#x20;
3. **Short window de-bounce.**
   * If an RTC frame with seq `s` applied within the last **100 ms**, drop any WS frame with `seq < s + 1` (configurable).
4. **Lossy by design.**
   * Under backpressure, **skip** current frame rather than queue; freshness > reliability (consistent with transport rules).&#x20;
5. **Edge cases.**
   * On `clientId` change (reload), reset receiver state for that `clientId`. See Appendix K for handshake & wrap rules.

---
# Appendix F: Provider Lifecycle (Init, Teardown, Reconnect)
**Teardown order (room leave, toggle to WS-only, tab close):**
1. **Stop awareness publisher** → 2) **Destroy RTC provider** (if any) → 3) **Unsubscribe awareness listeners** →
2. **Leave/close WS** (doc provider remains authoritative path) → 5) **Flush WriteQueue** → 6) **Close IDB (optional)**.
   Guarantee all public calls after `destroy()` are no-ops. (Integrates with §11 Gates and your authority path.) &#x20;
**RTC flap handling & debounce:**
* If RTC drops due to `ice_failed|disconnected (>5s)`, **stay WS-only** and schedule reconnect attempts (below).&#x20;
* Debounce **re-create** for **10 s** to avoid thrash when network is unstable.
**Reconnect policy (RTC only):**
* Exponential backoff with jitter: `base=1s`, `jitter=±20%`, `cap=30s`, **max 5 tries**. Abort attempts if peer count > cap or CPU hot (same trigger you use to drop RTC).&#x20;
---
# Appendix G: Multi-Tab Coordination (Same Room)
**Primary/secondary election (per room):**
* Use `BroadcastChannel('room:<id>')`. The tab with the **lowest `openedAt`** wins **primary**.
* **Primary**: may start RTC (after probe), **sends** awareness, extends TTL.
* **Secondary**: **receive-only** awareness; **must not** start RTC or extend TTL; WS remains authoritative for doc sync.&#x20;
**Promotion:** On primary unload (visibilitychange/unload), secondary promotes within ≤ **1 s**.
---
# Appendix H: Command-Level Conflict Rules
**Beyond CRDT merge—UX semantics that must be consistent:**
1. **ClearBoard epoch.**
   * `ClearBoard` increments a room-local **epoch**; any draw/commit **begun before** the epoch is **discarded** on commit.
2. **Read-only transition mid-gesture.**
   * When the server marks the room read-only (size ≥ 10 MB), **reject** queued writes with `ERR_READONLY` and surface banner. No auto-retry after banner clears.&#x20;
3. **Idempotency.**

   * Duplicate `ClearBoard` or “select all → delete all” sequences are idempotent; second application is a no-op.
---
# Appendix I: Presence vs Snapshot Gating
**Rendering contracts aligned to §11 Gates:**
* **Cursors/presence** draw only when **both** `G_AWARENESS_READY` **and** `G_FIRST_SNAPSHOT` are open.
* If awareness is ready but first snapshot not yet published, show **“Presence degraded”** pill **without** cursors.
* Export/minimap remain gated per `G_FIRST_SNAPSHOT`.&#x20;
---
# Appendix J: WriteQueue Contract (Reentrancy & Budgeting)
1. **Single consumer.** Only one active `yjs.transact` at a time; concurrent commands are **queued**.
2. **Coalescing.** During an open transact, coalesce same-stroke updates and drop superseded deltas.
3. **Max transact time.** If a transact exceeds **8 ms**, yield and resume next tick (prevents UI jank; aligns with your rAF budgeting and micro-batch windows). &#x20;
4. **Backpressure.** If queue length > **Q\_HIGH** (tune empirically), start coarser simplification (Appendix A §5) and widen micro-batch window to **24–32 ms** until recovered. &#x20;

---
# Appendix K: Awareness Sequencing & Identity
1. **Sequence domain.** `uint32` with modulo wrap at `2^32`. Compare using unsigned modular arithmetic.
2. **HELLO handshake.** On (re)join, sender transmits a `HELLO{ clientId, seq }`. Receivers set `lastSeqBySender[clientId]=seq`.
3. **Identity reset.** On **clientId change** (new tab/reload), sender resets local `seq=0`; receivers treat it as a new sender and reset state for that `clientId`.
4. **Loss handling.** Missing seqs are **not** retransmitted; receivers rely on **freshness** and de-dup policy (Appendix E).
---
# Appendix L: Observability & Telemetry
Track metrics (labels: `{roomId, clientId, channel={ws,rtc}}`):
* `rtc_probe_ms`, `rtc_connected_peers`, `webrtc_signaling_connect_ms`, `webrtc_provider_errors{ice,signaling}`
* `awareness_rx_dropped{reason=seq,stale,buffer}`, `awareness_tx_skipped{reason=backpressure}`
* `ws_sync_ms{step=connect|stateVector|sync2}`, `ws_retries_total`
* `write_transact_ms`, `writequeue_len`, `snapshot_fps`
* `extendTTL_calls_blocked{reason}`

**Logs:** include drop reasons (`ice_failed`, `signaling_timeout`, `probe_failed`) and backoff attempt index.
---
# Appendix M: Direct Pairing vs Provider Signaling
* **Mutually exclusive with provider-managed signaling.** If using `y-webrtc` provider for RTC, the “Direct (Peer Mode)” WS-mediated offer/answer flow is **not** started.
* If **Direct (Peer Mode)** is explicitly chosen, do **not** instantiate the `WebrtcProvider`; use the WS code exchange path only for that session. UI must reflect the state (“Peer Mode On (Small Room)” vs “Server”).&#x20;

---
# Appendix C — Additions to Backoff Parameters
> Extend your centralized constants with RTC reconnect/backoff and awareness timing guards (keeps everything in one place like your current `BACKOFF`).&#x20;
```typescript
export const BACKOFF = {
  // existing …
  wsBaseMs: 300,
  wsMaxMs: 20000,
  wsJitter: 0.2,
  rtcIceFailGraceMs: 5000,
  ttlExtendCooldownMs: 10*60*1000,
  awarenessRtcBufferHigh: 128*1024,
  awarenessWsBufferHigh: 64*1024,

  // NEW: RTC reconnect
  rtcBaseMs: 1000,      // 1 s
  rtcMaxMs: 30000,      // 30 s cap
  rtcJitter: 0.2,       // ±20%
  rtcMaxTries: 5,       // give up after 5 attempts
  rtcFlapDebounceMs: 10000, // hold-off before re-create

  // NEW: awareness de-bounce
  awarenessWsDropWindowMs: 100, // prefer RTC within this window
};

```
# More appendix :Appendix: Contracts & Gaps (Clean Format)

## Service Worker & PWA — Quick Wins (Addendum)

> **Placement:** under the existing **Service Worker & PWA** section, after baseline policy.
These items complement the existing SW rules (no caching for `/api/**`, `/yjs/**`, or any WS endpoints). They’re intentionally conservative and bucketed for predictable storage and eviction.
### Precache
* **Fonts & Icons**: Precache self‑hosted WOFF2 font files and app icons (including 192/512 and **maskable**). Use hashed filenames for revving.
* **Heavy dynamic‑import bundles**: Precache/warm large lazies used across canvases (e.g., workers, exporters, pickers). Queue them with `requestIdleCallback` and fall back to post‑`load` prefetch.
* **Static JSON**: Precache localization packs and other immutable JSON. Keep A/B flags or any server‑driven configs **out** of the SW cache.
### Runtime caches
* **Avatars & Thumbnails** *(cache: `avatars-thumbs-vN`)*:

  * If URL contains a **content hash** or immutable cache headers → **Cache First**.
  * Otherwise → **Stale‑While‑Revalidate (SWR)**.
  * Caps: `maxEntries: 400`, `maxAgeSeconds: 7 * 24 * 3600` (7 days).
* **Embedded media from stable CDNs** *(cache: `media-cache-vN`)*:
  * Allowlist domains: e.g., `images.example-cdn.com`, `static.example.com`.
  * Strategy: **SWR** with `maxEntries: 300`, `maxAgeSeconds: 14 * 24 * 3600`.
  * Reject opaque/unknown large responses and anything not on the allowlist.
### Guardrails
* **Versioned cache names** and `cleanupOutdatedCaches()` on `activate`.
* **Separate buckets**: `app-shell-vN`, `offline-pack-vN`, `avatars-thumbs-vN`, `media-cache-vN`.
* **Quota awareness**: on `QuotaExceededError`, delete LRU from `media-cache` and retry; expose a “Clear offline data” affordance in settings.
* **Respect user/storage constraints**: skip heavy warmups when storage estimate < 200 MB free or `navigator.connection.saveData === true`.

### Install/Warmup flow
1. `install` → pre‑cache app shell + fonts/icons.
2. `activate` → `cleanupOutdatedCaches()`.
3. `idle` → warm heavy lazies (if allowed) and offline pack.
### Acceptance checks
* Cold install works offline for the app shell.
* Revisions to fonts/icons ship instantly on next navigation.
* Media/avatars stay within caps; eviction doesn’t touch app shell/offline packs.
---
## Awareness — Cursor Trail (Implementation Notes)
> **Placement:** append within **§ Awareness** (near cursors/receiver smoothing), or within **Canvas** if you group rendering details there.
**Goal:** Lightweight, non‑authoritative visual feedback of remote pointers that scales gracefully with peer count.

### Data model
Per remote user keep a rolling buffer of **12–24** points `{x, y, t}` in **canvas pixels**, newest at the end. Trim points older than **600 ms** or exceeding the buffer size. Optionally store velocity `v` computed from deltas for thickness/alpha cues.

### Ingest
* On each awareness update, quantize to **0.5 px** and push.
* If gaps > **60 ms**, linearly interpolate **1–2** points to avoid segments snapping.
* Merge with existing **receiver smoothing** (do not double‑smooth): if a predicted point exists for the current frame, prefer it.

### Render loop (overlay canvas)
* Single overlay `<canvas>` above the stage; render at `requestAnimationFrame`.
* For each trail, draw a polyline through the buffer; alpha = `exp(-(now - t)/τ)` with τ≈**240–320 ms**.
* Cap stroke width between **1–3 px**. Use **butt** caps to reduce halos; join style **round**.
* Clear using `ctx.clearRect()` once per frame; no per‑point clears.

### Degrade rules
* If `peerCount > 10`, shrink buffer to **≤12** points.
* If `peerCount > 25` or `fps < 30`, **disable trails** (show dot‑only cursors).
* Honor **prefers‑reduced‑motion**: default to dot‑only.

### Telemetry
* Emit `cursorTrail.enabled`, `cursorTrail.points`, `cursorTrail.dropReason` (high peers / low fps / reduced‑motion) for tuning.

### Pseudocode
```ts
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
---
## Awareness — Sender‑Side No‑Op Suppression & Server Ignore‑Repeats

> **Placement:** within **§ Awareness → Transport/Send** and **Server** subsections.

### Sender (client)

* Maintain `lastSentDigest` of the payload after **quantization**:

  * Position rounded to **0.5 px**; tool/state reduced to a small tuple (toolId, pageId, modifiers).
* Before enqueueing an awareness frame:

  1. Build `payload` and **digest** (e.g., `murmur3` or a tiny ad‑hoc hash of the tuple).
  2. If `digest === lastSentDigest` → **skip send**.
  3. Else send with `seq++` and set `lastSentDigest = digest`.
* Interplay with batching/backpressure: apply this **before** micro‑batching so the batch drops fully redundant frames.
* **Force‑send** on tool change, pointer‑down/up, page switch, or after **250 ms** of silence (heart‑beat for liveness).

### Server
* Per‑sender, keep `{lastDigest, lastAt}` in memory (LRU by sender).
* If a new frame arrives where `digest === lastDigest` within **150 ms**, **drop** it (no fan‑out). Update `lastAt` regardless.
* Always respect `seq` monotonicity for ordering; ignore repeats even if transported via different channels.

### Edge cases
* On reconnect (new RTC/WS), reset `lastSentDigest` and send a full state snapshot.
* If we ever increase precision or payload shape, bump the **awareness version** so digests don’t collide.

### Acceptance checks
* With stationary cursors, sender emits ≤ **4 fps** heart‑beats only.
* Under rapid motion, transport volume falls vs. naive stream; no visible stall due to missed state changes.
* No duplicate frames delivered across WS/RTC channel races.

## A.  More Data Flows to Specify

1. **Persist Ack (server→client)** — After durable write + TTL update; updates client `docStats`. Envelope: `{"type":"persist_ack","docId":"<id>","svKey":"<ver>","size_bytes":123456,"expires_at":"2025-08-19T12:34:56Z","flush_seq":42}`.
2. **TTL Extension** — Extend TTL on ingest of accepted update; emit `persist_ack` only after durable write.
3. **Redis Write & Batching** — Batch window: 1–3 s (pick one). Atomicity: durable at flush completion. Crash window: accepted updates in-flight may be lost before flush; tie to SLO.
4. **Room Metadata (DB)** — `size_bytes` & `lastWriteAt` sourced from post-flush compressed length. After successful Redis write → update Postgres. `GET /metadata` reads from Postgres.
5. **ICE/TURN Delivery (Auto-RTC)** — `GET /api/ice` or WS `welcome`; TTL \~10 min; refresh when <2 min remaining.
6. **Awareness Coordinates** — Send world-space; receivers project to view. Optional: include `{viewId, world, ts}`; prefer world when present.
7. **Peer Count Source** — `N` derived from WS roster even when RTC active; define fallback if WS down.
8. **WS Backpressure** — Use `bufferedAmount` when available; fallback to timed drain/errors. Above high-water: coalesce presence per user and skip; resume under low-water.
9. **Oversize Preflight** — Client keeps rolling compression ratio `ĉ`; estimate `est_total = current_compressed + ĉ * uncompressed_delta`; locally gate/warn if >8 MB (warn) / >10 MB (block).
10. **Code-Cell Concurrency** — Reject writes with `version < currentVersion` (return conflict); or migrate `code.body` to CRDT text. `outputs[]` eviction: atomic transaction; stable-sort by `ts`,`runId`.
11. **Large Offline Delta** — Reject when any: state-vector gap >2 MB (compressed), time since last sync >15 min, op count >10k. Error includes thresholds.
12. **Multi-Tab Identity** — `userId = deviceULID:tabULID`; persist device ULID in IDB; tab ULID per tab; rotate device ULID on hard reset only.

## B. Initialization & State Sync

1. **Boot Gating** — Hold outbound doc sync until `G_IDB_READY` or 2 s timeout; then open WS, hydrate Y, and allow publish.
2. **Scene Capture** — Stamp `sceneId` at pointer-down; in-flight strokes commit to that scene even if "Clear Board" happens.
3. **Persist-Lag Metric** — Requires `persist_ack`; `persist_lag_ms = ack.ts - first_update_received.ts`.
4. **Awareness Readiness** — WS: ≥1 remote frame in last 2 s; RTC: `ice ∈ {connected,completed}` & RTT <400 ms.
5. **Frame Size vs Micro-Batch** — Inbound frames ≤2 MB; server never coalesces beyond cap; client micro-batching is local only.
6. **Crash Window & TTL** — On ingest: extend TTL. SIGTERM: flush+extend TTL then close. Ack only after durable write.

## C. Races & Ordering

1. **Concurrent Clear Board** — Server: idempotency key + ≥150 ms rate-limit. Client: debounce \~300 ms and show pending state.
2. **Awareness Reordering/Loss** — Frames carry `seq` (u32); drop if `seq ≤ lastSeq` modulo 2^31; smooth interpolation with 150–250 ms window.
3. **Undo Scope Across Tabs** — Use per-tab `userId` to isolate histories.
4. **outputs\[] Eviction** — Completion + eviction in single CRDT transaction so second finisher observes first delete.

## D. Protocol Envelopes (Normative, Compact)

* **welcome**: `{"type":"welcome","v":1,"ts":"2025-08-19T12:34:56Z","docId":"<id>","userId":"<device:tab>","ice":{"ttl_sec":600,"servers":[...]},"limits":{"max_frame_bytes":2000000,"warn_size_bytes":8000000,"read_only_size_bytes":10000000,"offline_threshold":{"bytes":2000000,"minutes":15,"ops":10000}},"peer_count":12}`.
* **persist\_ack**: `{"type":"persist_ack","v":1,"ts":"2025-08-19T12:34:56Z","docId":"<id>","svKey":"<ver>","size_bytes":123456,"expires_at":"2025-08-19T13:34:56Z","flush_seq":42}`.
* **metadata\_poll (HTTP)**: `{"docId":"<id>","size_bytes":123456,"lastWriteAt":"2025-08-19T12:34:56Z","expires_at":"2025-08-19T13:34:56Z"}`.
* **errors**:

  * `offline_delta_too_large`: `{"type":"error","code":"offline_delta_too_large","threshold":{"bytes":2000000,"minutes":15,"ops":10000},"server_size_bytes":9200000}`.
  * `read_only_over_cap`: `{"type":"error","code":"read_only_over_cap","size_bytes":10300000}`.
  * `conflict_on_version`: `{"type":"error","code":"conflict_on_version","expected":12,"received":10,"entity":"code_cell","id":"<cellId>"}`.
* **awareness (WS/RTC)**: `{"type":"awareness","seq":12345,"ts":1724070000123,"userId":"<device:tab>","presence":{"cursor":{"x":123.4,"y":567.8,"space":"world"},"tool":"pen","color":"#AABBCC","viewId":"<opt>"}}`.

## E. Thresholds & Constants

| Item                    |                   Default | Notes                                  |
| ----------------------- | ------------------------: | -------------------------------------- |
| Inbound frame cap       |                      2 MB | hard cap for server/client             |
| Doc size warn / RO      |              8 MB / 10 MB | warn vs block                          |
| Persist poll            |                      10 s | or on `persist_ack`                    |
| WS high/low water       |            256 KB / 64 KB | coalesce above high, resume below low  |
| WS send buffer thresh   |                     64 KB | skip awareness frames above this        |
| WS roster update rate   |                      1 Hz | max rate for peer count updates         |
| RTC pkt buffer high/low |              64 / 16 pkts | for awareness data channel             |
| Awareness send rate     |       12 Hz → 6 Hz → 2 Hz | degrade when backpressured or `N ≥ 20` |
| Offline thresholds      | 2 MB or 15 min or 10k ops | any triggers                           |
| Shutdown drain          |                       2 s | flush before force close               |

## F. Observability & SLOs

**Metrics**: `persist_lag_ms` (p50/p95), `flush_duration_ms`, `flush_batch_bytes`, `ttl_extend_failures`, `doc_size_bytes` (warn/RO counters), `rejected_deltas_count` by reason, `awareness_drop_rate` (WS/RTC), `ws_backpressure_drops`, `rtc_buffer_overflows`.
**Logs**: include `docId`,`svKey`,`flush_seq`,`size_bytes`, threshold context in errors. **Alerts**: `doc_size_bytes > 8.5 MB` ≥5 min; `persist_lag_ms p95 > 1500` for 10 min; TTL within 2× batch window without recent ack.

## G. Test Matrix (Minimal)

Offline→online >2 MB (expect `offline_delta_too_large`); concurrent clears (single scene tick per debounce window); awareness out-of-order (seq-drop + smooth); batch crash (TTL extended on ingest, no phantom ack); WS backpressure (coalescing, recover under low-water); version conflict (stale code-cell write → conflict).

## H. Open Decisions

Batch window; backpressure thresholds; compression level/codec; metadata source of truth (PG vs Redis) + caching; max IDB-gate timeout (2 s suggested); method for rolling `ĉ` (EWMA vs windowed).

---
# Final Editorial Notes

- Replace any "maybe/likely" with **explicit behavior**.
- Every new constant is declared in a `config.ts` with defaults and environment overrides.
- Every table/algorithm includes **edge cases** and **timeouts**.
- Ensure **no written Float32Array** into Yjs; build at render.
- Toolbar state is **device-local** and versioned.
- **Prevent null snapshot** via immediate `EmptySnapshot`.
- Clarify **mutable vs immutable**: live Y state mutable only via commands; published `Snapshot` immutable.
- **Direct observation vs centralized subscription**: centralized only.
- **Ownership** lines explicit for each subsystem.
- **WebSocket processing & backoffs** codified.
- **Init order** and **where gates fire** documented and testable.