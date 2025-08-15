1. Executive Summary & Project Definition
   Purpose. Build Avlo, a link-based, account-less, offline-first, real-time collaborative whiteboard with an integrated code executor (JS + Python via Pyodide). The MVP targets ≤125 ms p95 end-to-end collaboration latency with ~50 concurrent users and ≤25 active drawers, works offline (IndexedDB + CRDT), and persists rooms to Redis with ROOM_TTL_DAYS (default: 14) TTL. Hard data cap is 10 MB compressed per room; at the cap the room becomes read-only. Mobile is view-only for MVP.
   Problem & solution. Synchronous sketching + quick code execution for demos, teaching, and brainstorming—without accounts, installs, or SSO friction. Link sharing grants edit access; persistence is simple but time-limited; scale is single-node MVP.
   Tech Stack (MVP).
   Frontend: React (Vite), TypeScript, Tailwind, HTML Canvas renderer with RBush indexing, Monaco editor.
   Realtime & Offline: Yjs CRDT, y-websocket (official), y-indexeddb (offline cache), cursor awareness over WS.
   Whiteboard Core: LOD-based rendering, dirty-rect redraw, viewport culling; stamps (rectangle/ellipse/arrow), and text nodes (single-commit text tool).
   Execution: In-browser JS + Pyodide (per-run workers).
   Persistence (authoritative): Redis 7 storing compressed Yjs doc with AOF; ROOM_TTL_DAYS (default: 14) TTL extended only on accepted writes.
   Metadata DB (non-authoritative): PostgreSQL 16 via Prisma 5 (room title/createdAt/lastWriteAt/size_bytes only).
   PWA: Offline-first app shell with cache-first HTML navigations and versioned static assets. Pre-cache Monaco (core + workers) at install. Pyodide pack is desktop-only and warmed silently after Service Worker activate (not in precache). Do not cache /api/**, /yjs/**, or any wss: traffic. Show an Update available prompt on new versions.
   Deploy & Infra: Single container on Railway; no NGINX.
   Railway deploy (no Docker): Use Railway’s Node service (Nixpacks). Build: npm ci && npm run db:generate && npm run build. Start: npm run db:deploy && node server/dist/index.js. (Ensure migrations are applied before the Node process starts; db:deploy may be in a wrapper script or the platform’s Start Command.) Static assets are served from server/public/ (copied from client/dist/ by bundle:assets). Env: NODE_ENV, PORT, DATABASE_URL, REDIS_URL, ORIGIN_ALLOWLIST, SENTRY_DSN (optional), APP_VERSION.
   Observability: Sentry + custom counters (limits, Redis failures, export attempts, executor cache states), plus counters for Text commits and advanced slider usage (size & hue), plus toolbar interactions (pin/unpin, side flip, collapse/expand).
   CRITICAL: PACKAGE.JSON FILES MIGHT HAVE SMALL FORMATTING ERRORS
   Versioning note: Root package.json:
   {
   " name": "avlo",
   " private": true,
   " workspaces": "client","server""client", "server",
   " scripts": {
   " dev": "concurrently "npm run dev:server" "npm run dev:client"",
   " dev:server": "npm run dev --workspace=server",
   " dev:client": "npm run dev --workspace=client",
   " build": "npm run build --workspace=client && npm run build --workspace=server && npm run bundle:assets",
   " bundle:assets": "node scripts/copy-client-dist.mjs",
   " db:generate": "npm run prisma:generate --workspace=server",
   " db:migrate": "npm run prisma:migrate --workspace=server",
   " db:deploy": "npm run prisma:deploy --workspace=server",
   " test:e2e": "playwright test",
   " test:e2e:ui": "playwright test --ui",
   " test:e2e:report": "playwright show-report",
   " e2e:install": "playwright install --with-deps", // Note: On restricted shells, use "playwright install chromium"
   " e2e:serve": "npm run build && node server/dist/index.js"
   }
   }
   Create scripts/copy-client-dist.mjs:
   // copies Vite build into server/public for Express to serve
   import { cp } from 'node:fs/promises';
   import { dirname, resolve } from 'node:path';
   import { fileURLToPath } from 'node:url';
   const **dirname = dirname(fileURLToPath(import.meta.url));
   const src = resolve(**dirname, '../client/dist');
   const dst = resolve(\_\_dirname, '../server/public');
   await cp(src, dst, { recursive: true });
   console.log(bundle:assetsbundle:assets Copied ${src} -> ${dst});
   client/package.json:
   {
   "name": "avlo-client",
   "type": "module",
   "private": true,
   "scripts": {
   "dev": "vite",
   "build": "tsc && vite build",
   "preview": "vite preview",
   "lint": "eslint . --report-unused-disable-directives --max-warnings 0"
   },
   "dependencies": {
   "react": "^18.3.1",
   "react-dom": "^18.3.1",
   "yjs": "^13.6.27",
   "y-websocket": "^3.0.0",
   "y-indexeddb": "^9.0.12",
   "@monaco-editor/react": "^4.6.0",
   "monaco-editor": "^0.52.2",
   "rbush": "^4.0.1",
   "nanoid": "^5.0.9",
   "pako": "^2.1.0",
   "pyodide": "^0.26.4",
   "lodash": "^4.17.21"
   },
   "devDependencies": {
   "@types/react": "^18.3.18",
   "@types/react-dom": "^18.3.5",
   "@types/rbush": "^4.0.0",
   "@types/pako": "^2.0.3",
   "@types/lodash": "^4.17.13",
   "@types/papaparse": "^5.3.15",
   "@types/d3": "^7.4.3",
   "@vitejs/plugin-react": "^4.3.4",
   "@typescript-eslint/eslint-plugin": "^8.18.0",
   "@typescript-eslint/parser": "^8.18.0",
   "eslint": "^9.17.0",
   "eslint-plugin-react-hooks": "^5.1.0",
   "eslint-plugin-react-refresh": "^0.4.20",
   "typescript": "^5.7.2",
   "vite": "^5.4.11",
   "vite-plugin-pwa": "^0.21.1",
   "workbox-window": "^7.3.0",
   "tailwindcss": "^3.4.17",
   "autoprefixer": "^10.4.20",
   "postcss": "^8.4.49"
   }
   }
   server/package.json:
   {
   "name": "avlo-server",
   "type": "module",
   "private": true,
   "scripts": {
   "dev": "tsx watch src/index.ts",
   "build": "tsc",
   "start": "node dist/index.js"
   },
   "dependencies": {
   "yjs": "^13.6.27",
   "y-websocket": "^3.0.0",
   "@y/websocket-server": "^0.1.1",
   "y-leveldb": "^0.1.2",
   "@prisma/client": "^5.22.0",
   "redis": "^5.8.0",
   "express": "^4.21.2",
   "ws": "^8.18.0",
   "nanoid": "^5.0.9",
   "cors": "^2.8.5",
   "express-rate-limit": "^7.5.0",
   "helmet": "^8.0.0",
   "pino": "^9.0.0",
   "pino-http": "^10.0.0",
   "zod": "^3.23.8",
   },
   "devDependencies": {
   "prisma": "^5.22.0",
   "@types/express": "^4.17.22",
   "@types/ws": "^8.5.13",
   "@types/cors": "^2.8.17",
   "@types/pako": "^2.0.3",
   "tsx": "^4.19.2",
   "typescript": "^5.7.2",
   "@sentry/node": "^8.45.0",
   "@sentry/profiling-node": "^8.45.0"
   }
   }
   Success criteria & KPIs.
   Published p50/p95 latency under scripted loads (50 users / 25 drawers).

Export reliability within defined caps; read-only enforcement at 10 MB; warning at 8 MB.

Error budget: ≤5 s worst-case write-to-persistence lag; track limit events/Redis failures.

Scope (in). Pen, highlighter, minimal shape stamps (rectangle/ellipse/arrow), whole-stroke eraser, “Clear board (for everyone)” via scene ticks (append-only), cursor trails with mini names, users list, copy-link, basic minimap, PNG export (viewport / entire board), code execution in per-run workers (JS + Pyodide), installable PWA (manifest + minimal Service Worker app-shell caching; no push/background sync).
Scope (out). Auth, permissions, admin tools, recovery of expired rooms, cold storage, partial eraser, shape editing/selection, CDN usage, multi-node scaling, Image upload/attachments.
AI Assistance (Mode A only) overview (MVP add-on).
Chat-only assistant that proposes diffs/tests; never writes to Yjs autonomously. Edits apply only on user-initiated “Apply”.

Docked panel inside the editor with a persistent bottom-bar toggle labeled “AI Assistance”. On first app load only, the panel opens by default; after that, the open/closed and layout state persist device-locally; no automatic pop-ups later.

Offline UX provides deterministic Offline Tools in place of the chat composer: Explain Selection, Minimal Refactor, Generate Tests, Practice Problem (from a bundled, versioned JSON bank with progressive hints). On reconnect, restore the chat composer and keep transcript visible.

2. System Architecture Overview
   High-level (text diagram).
   Client (React/TS, Canvas, Monaco, Pyodide, y-indexeddb) ⇄ y-websocket server (official) ⇄ Redis (AOF) with configurable TTL (ROOM_TTL_DAYS (default: 14)). Only accepted writes extend TTL. WebSocket carries Yjs doc updates + awareness (already separated by y-websocket). HTTP for room creation + metadata (via Prisma/PostgreSQL). Single container deployment (Railway) in MVP. NO NGINX.
   Core components & relationships.
   Client: Canvas renderer, input tools (including Text tool with local preview, committed in one Yjs transaction), docked toolbar with local UI state (side, pinned, collapsed) persisted in localStorage; no Yjs involvement, cursor trails, Monaco editor, per-run workers, y-indexeddb for per-room doc persistence. Service Worker: cache-first HTML; pre-cache Monaco; desktop-only silent warm of the versioned Pyodide pack (static, self-hosted); no caching of API/WS/yjs.

Collab core: Yjs CRDT as single source of truth; awareness (presence) is ephemeral.

Transport: The server uses the official @y/websocket-server@0.1.x backend with minimal wrappers (origin allowlist, per-IP caps, frame cap, room capacity) and custom Redis persistence. Import via @y/websocket-server/utils (ESM). We install y-leveldb only to satisfy the package's static import; Redis is the only persistence used in production.

Storage: Redis stores compressed Yjs doc with TTL; no snapshots/cold store. PostgreSQL stores non-authoritative room metadata (id, title, createdAt, lastWriteAt, size_bytes); Redis presence defines room existence.

AI Assistance (Mode A) component & flow.
UI location: Panel docked inside the editor region (above Monaco output), not a free-floating window. Respects existing 70/30 split; does not change global layout.

Panel state: Device-local (localStorage) only, not synced via Yjs.

Online path: Panel → /api/ai/\* → streamed message + optional unified diff + optional tests. Apply executes inside a single yjs.transact(...) with a hashed span precondition. If mismatch: fail fast and show actions Re-run / Open 3-way merge / Copy patch.

3-way merge: Minimal preview UI requiring explicit user resolution; assistant never guesses.

Offline path: When network is absent or drops mid-stream, the chat composer is replaced with Offline Tools (deterministic, no LLM). On reconnect, composer is restored and transcript remains.

Platform & infra (hard MVP requirements). React (Vite), TypeScript, Tailwind, Yjs + y-websocket + y-indexeddb, Monaco, Pyodide; back end uses the official @y/websocket-server backend with custom Redis bind/write hooks; Redis AOF enabled; hosted as a single container (Railway). Prisma + PostgreSQL (metadata only).
External integrations. Sentry for errors/metrics only. No OAuth/SSO, no third-party CDNs. Pyodide and Monaco are self-hosted immutable assets; no external CDNs.
Developer tooling. Pre-commit hooks via Husky + lint-staged for automatic ESLint fixing and Prettier formatting on staged files. Fast, lightweight setup (<5s) with TypeScript checking kept in CI only for optimal agent workflows.
Compatibility. Node 18+, randomUUID() available; project standardizes on node:crypto import. Server uses TypeScript module: NodeNext. Relative imports include .js in source (Node ESM rule).

3. Data Models & Schema Definitions
   Note: The system's authoritative model is the Yjs document (Redis persists compressed binary; awareness is ephemeral). IndexedDB stores (a) the full per-room Y.Doc via y-indexeddb so rooms reopen and continue offline, and (b) the device-local “My Rooms” list and a small alias map for local→server ids. Hard numeric constraints are normative.
   3.1 Yjs document (logical JSON view; stored as Yjs types → compressed buffer)
   {
   "meta": {
   "scene_ticks": { "type": "array", "items": { "type": "string" } }, // append-only; changes excluded from global Undo
   "createdAt": { "type": "string", "format": "date-time" }
   },
   "strokes": { "id": { "type": "string" }, "scene": { "type": "integer" }, "tool": { "type": "string", "enum": "pen","highlighter","stamp" }, "style": { "type": "object", "properties": { "color": { "type": "string" }, // hex/HSL "size": { "type": "number" }, "opacity": { "type": "number", "minimum": 0, "maximum": 1 } }, "required": "color","size" }, "points": { "type": "array", "maxItems": 10000 }, // Float32 polyline "createdAt": { "type": "string", "format": "date-time" } } ,
   "texts": { "id": "string","scene": "integer","content": { "type": "string", "maxLength": 500 },"x": "number","y": "number","style": { "color": "string", "size": "number", "font": { "type": "string", "default": "system-ui" }, "align": { "type": "string", "enum": "left","center","right", "default": "left" } }, "createdAt": { "type": "string", "format": "date-time" } },
   "code": {
   "language": { "type": "string", "enum": "javascript","python" },
   "content": { "type": "string", "maxLength": 200000 }
   },
   "outputs": { "id": { "type": "string" }, "text": { "type": "string", "maxLength": 10240 }, "ts": { "type": "string", "format": "date-time" } }
   }
   Current scene = meta.scene_ticks.length. Rendering/export only include elements where stroke.scene === currentScene. Keep strokes[].scene as an integer (unchanged). Do not introduce page history UI.
   Initialization & scope (normative):
   Identifier: doc_guid = roomId; construct with new Y.Doc({ guid: roomId }). Never mutate guid after construction. Redis keys: room:<roomId>.

Viewport clarification: Viewport logic only optimizes rendering/presence. Full document sync always occurs (no selective sync).

Constraints (normative): MAX_POINTS_PER_STROKE = 10000; MAX_TOTAL_STROKES = 5000; visible operations must only include stroke.scene === currentScene. Highlighter opacity = 0.25; cursor preview opacity = 0.35.
Additional constraints: Text nodes are committed in a single transaction; post-commit text is immutable (erasable as one object). Size for strokes is captured at stroke start; changes apply to subsequent strokes only. Text max length 500 chars (guardrail).
3.2 Awareness (ephemeral; not persisted in Yjs doc)
{
"name": { "type": "string" }, // adjective+animal; non-unique; session-local
"color": { "type": "string" },
"cursor": { "type": "object", "properties": { "x": {"type":"number"}, "y": {"type":"number"} }, "required": "x","y" },
"activity": { "type": "string", "enum": "idle","drawing","typing" }
}
Cadence: presence tick 75–100 ms; send throttle ≈30 Hz.
3.3 Redis storage model (authoritative)
Key: room:<roomId> → binary compressed Yjs doc; TTL ROOM_TTL_DAYS (default: 14) from last accepted write. No base64; AOF enabled. Size = bytes of last persisted compressed buffer.
Configuration: ROOM_TTL_DAYS environment variable controls the default TTL (14 days if unset); the UI uses the same value when computing expires_at.
3.4 "My Rooms" & local aliases (IndexedDB; device-only)
Logical records:
• rooms: { roomId: string, title: string, last_opened: date-time, expires_at: date-time, provisional?: boolean, aliasOf?: string }
• aliases: { provisionalId: string → serverId: string }
Notes:
Per-room Y.Doc state is persisted separately by y-indexeddb (see §3.8).

A room created offline uses a provisional id (e.g., local-) with provisional: true. After publish, set aliasOf = <serverId> and keep a redirect map so /rooms/local-… routes to /rooms/<serverId> when online.

Clearing storage removes lists/aliases; server metadata refreshes when online; viewing/presence does not extend TTL.

Show expiry: Display “Expires in X days” using expires_at from metadata.

Extend room: Provide a button that performs a tiny Yjs write (e.g., increment meta.keepAliveCounter or update meta.lastExtended) to extend TTL by ROOM_TTL_DAYS. Throttle client-side (e.g., once per 24 h) and show a toast \*\*“Room extended to .” (Views/presence still do not extend TTL—see above.)

3.5 Tool/type enums
tool ∈ {pen, highlighter, stamp, text}; stamps ∈ {rectangle, ellipse, arrow}; no editing post-insert (one stroke), and no post-commit editing for text.
3.6 Limits & caps (normative)
Hard room size: 10 MB → read-only; soft warn: 8 MB.

Hard capacity: 105 live clients; inbound WS frame cap: 2 MB.

Flush cadence: 2–3 s (≤5 s worst) to Redis.

Rate limits: 10 rooms/hour/IP.

Per-IP concurrent WS connections: 8.

3.7 PostgreSQL metadata (non-authoritative)
Purpose. Store public, non-sensitive room metadata only; does not contain any Yjs content. Room existence is defined by the Redis key.
Logical fields (Prisma model):
id (string, @id) — roomId (nanoid)

title (string, ≤120)

createdAt (DateTime, default now)

lastWriteAt (DateTime, updated on accepted Redis flush)

sizeBytes (int, last compressed payload size)

Derived (not stored): expires_at = lastWriteAt + ROOM_TTL_DAYS (default: 14)

Write path. After a successful Redis writeState (compressed buffer accepted), upsert { id, lastWriteAt=now(), sizeBytes }. Creation also upserts { id, title, createdAt=now(), lastWriteAt=now(), sizeBytes=0 }. If Postgres is unavailable, collaboration continues; metadata endpoints may 503.
3.8 Local document persistence (IndexedDB via y-indexeddb)
Purpose. Persist the full Y.Doc per room locally so users can open /rooms/:id offline and continue editing; Yjs syncs on reconnect.
Initialization. Construct with new Y.Doc({ guid: roomId }); attach y-indexeddb to store the doc under room scope. Never mutate guid; to remap, create a new doc and apply updates.
Cleanup. Do not delete per-room IndexedDB data on leave; provide an explicit “Delete local copy” affordance if needed.
3.9 Telemetry events (counters only; no content logging)
Event name
When fired
Purpose
ai_panel_opened_first_run
First app load when panel auto-opens
Track first-run exposure
ai_panel_toggled
User toggles AI Assistance
Measure engagement
ai_ttfb_ms
First token received for a request
Latency monitoring
ai_patch_rendered
A diff/tests card is rendered
Funnel denominator
ai_patch_apply_clicked
User clicks Apply
Apply funnel
ai_patch_apply_failed_precondition
Hashed span mismatch on Apply
Conflict rate
ai_patch_apply_conflict_opened
User opens 3-way merge
Conflict handling usage
`offline_tool_used:{explain
refactor
tests
`practice_problem_difficulty:{easy
medium
hard}`
practice_hint_revealed_count
Each hint reveal
UX calibration
provider_error_count
Provider error mapped to friendly text
Reliability
timeout_count
10s timeout happened
Reliability

3.10 Practice Problem pack (bundled; versioned static JSON)
Schema (canonical field names):
{
"id": "string",
"title": "string",
"difficulty": "easy" | "medium" | "hard",
"languages": "string", // e.g., "js","py"
"prompt": "string",
"starterCode?": "string",
"hints": "string", // ordered; reveal progressively
"referenceSolution": "string",
"sampleTests": "string" // inline or minimal harness
}
Pack is small to fit existing PWA budgets and is pre-cached alongside Monaco and Pyodide will be silently warmed post-activate desktop-only.

4. API Contracts & Interface Definitions
   4.1 REST (OpenAPI 3.0 excerpt)
   openapi: 3.0.0
   info: { title: Avlo API, version: "1.0" }
   paths:
   /api/rooms:
   post:
   summary: Create a new room
   requestBody:
   content:
   application/json:
   schema:
   type: object
   properties:
   id:
   type: string
   pattern: "^A−Za−z0−9*−A-Za-z0-9\_\\-+$"
   title: { type: string, maxLength: 120 }
   responses:
   "201":
   description: Created
   content:
   application/json:
   schema:
   type: object
   required: roomId, shareLink
   properties:
   roomId: { type: string }
   shareLink:
   type: string
   pattern: "^/rooms/A−Za−z0−9*−A-Za-z0-9\_\\-+$"
   "200": { description: "Exists (idempotent). Returned when the supplied id already exists; response still includes roomId + shareLink." }
   "429": { description: Rate limit exceeded }
   /api/rooms/{id}/metadata:
   get:
   summary: Public non-sensitive room metadata
   parameters:
   in: path
   name: id
   required: true
   schema: { type: string }
   responses:
   "200":
   content:
   application/json:
   schema:
   type: object
   properties:
   title: { type: string }
   size_bytes: { type: integer, minimum: 0 }
   expires_at: { type: string, format: date-time }
   created_at: { type: string, format: date-time }
   "404": { description: Not found }
   description: >
   Redis presence defines existence; if the Redis room key is missing (expired), return 404 even if a PostgreSQL metadata row exists.
   expires_at is computed as lastWriteAt + ROOM_TTL_DAYS (default: 14) (not read from Redis TTL).

/api/rooms/{id}:
put:
summary: Update room metadata
parameters:
in: path
name: id
required: true
schema: { type: string }
requestBody:
content:
application/json:
schema:
type: object
required: title
properties:
title: { type: string, maxLength: 120 }
responses:
"200": { description: Updated }
"400": { description: Invalid input }
"404": { description: Not found }
"429": { description: Rate limit exceeded }
description: >
Renames the room title in PostgreSQL. No auth in MVP; rate-limited. Room must still exist in Redis.

Local-first publish. Clients may create a provisional local room offline (see §5.6) and later call POST /api/rooms with an optional id to publish. After creation, the client joins the canonical room over WS and merges local state.
4.2 WebSocket interface (gateway-level contracts)
Endpoint: WS /ws (Origin required). Client identifies { roomId } on connect.

Errors (out-of-band, JSON):

room_full → joining rejected when 105 reached.

room_full_readonly → doc updates rejected after 10 MB; awareness still relays.

offline_delta_too_large → inbound frame > 2 MB; client must refresh.

Hygiene & lifecycle (non-message contracts):
Per-IP concurrent connection cap (see §3.6).

Client reconnection uses exponential backoff with jitter.

Client teardown: abort executions → dispose Monaco → destroy providers → ydoc.destroy() → keep per-room IndexedDB data to preserve offline continuity → remove listeners. An explicit “Delete local copy” flow may clear local data.

Notes: y-websocket message formats for Yjs updates/awareness are library-defined; the server keeps their separation; this spec only adds the gateway error envelopes above. Text editing is local-only until commit; commit sends one Yjs update. Undo/Redo is origin-scoped per user (users undo their own operations only).
4.3 AI Assistance Completion API (Mode A)
POST /api/ai/complete (or equivalent)
Request (JSON):

selection (text + line range), viewportContext, fileMeta

history: last 3 pairs (user/assistant) for continuity

limits: { maxTokens, hardTimeoutMs: 10000 }

Response (streamed):

message: streamed text tokens

Optional diff: unified diff blocks (--- a / +++ b hunks)

Optional tests: minimal tests block

Errors (mapped to friendly UI): timeout, 429, provider errors (see §4.4). Service Worker does not cache /api/\*\* and does not intercept WS.

4.4 Error mapping (Mode A + Offline)
Condition
User-visible message
UI affordances
Notes
Network lost mid-stream
Offline — switched to Quick Tools
Copy last message; Offline Tools tray shown
Composer disabled; transcript retained
Precondition failed (Apply)
Can’t apply: the file changed.
Re-run · Open 3-way merge · Copy patch
Verify hashed span or snapshot hash
Timeout (10s)
Request timed out
Retry
Show partial output if any
429 / rate-limit
Too many requests — try again shortly
Retry (with backoff hint)
No stack traces
Provider error
Something went wrong — please try again
Retry
Map vendor codes to friendly text
Large output clamp
Output truncated
Continue
Sends follow-up with same context

5. Functional Requirements Specification
   5.1 Roles & permissions
   Single role (Editor) for all link holders; no auth; mobile clients are view-only (UX gate) in MVP.
   Banner: "Room is read-only (10 MB limit reached). Create a new room to continue."
   Join-cap toast: "Room is full — create a new room."
   Oversize update: "Change too large. Refresh to rejoin."
   Read-only mode blocks text creation (same as strokes).
   5.2 Whiteboard & presence
   Toolbar
   Docked & pinned by default. Dock left by default; user can flip side (left/right) and collapse/expand (icon-only) with tooltips preserved.

Optional auto-hide (Unpin). When unpinned, the toolbar hides off-edge and reveals on edge-hover after a short dwell; does not auto-reveal during pointer-down drawing; stays visible while a popover is open or the toolbar is focused.

Persistence. side, pinned, and collapsed are device-local (localStorage), not synced via Yjs.

Accessibility. Toolbar is keyboard focusable; arrow keys navigate; Esc closes popovers.

MVP constraints. No resizing and no free dragging of the toolbar.

Tools: Pen (S/M/L presets + advanced size slider; color swatches + advanced Hue slider), Highlighter (same size/color inputs; opacity 0.25), Stamps (rectangle/ellipse/arrow at preset size; single-stroke commit), Text tool (place → type in local overlay → Enter/click-outside commits; Esc cancels), whole-stroke eraser.

Cursor trails (ring buffer length 24) with name badges; cap 20 remote rendered; disabled on mobile.

Active users indicator = count of awareness entries.

Minimap (minimal): shows board bounds of visible strokes + local viewport; ≤10 FPS; no remote viewports; may omit text glyphs initially (optionally render text bounds later—non-blocking).

Undo/Redo (per-user origin-scoped) using Y.UndoManager scoped to whiteboard operations; toolbar buttons with labels "Undo", "Redo"; keybindings Ctrl/Cmd+Z and Ctrl/Cmd+Y. Scene tick operations (meta.scene_ticks) are excluded from global Undo; the keep-alive write used by Extend is also excluded. Text node creation and deletion participate in Undo/Redo alongside strokes.

Color palette: 10 preset swatches shared by Pen and Highlighter plus an Advanced popover with a Hue slider. Highlighter uses the same color at opacity 0.25. S/L remain tasteful defaults for MVP.

Zoom controls UI: "+", "−", numeric % readout, and "Reset" button; uses existing zoom model/LOD rules; no changes to rendering logic.

Cursor preview: Keep preview opacity; cursor ring scales live with the size slider.

Micro-UI details:

Size slider popover: Opens from a chevron on the size preset; shows a native range input with tick marks and numeric readout; value is captured at stroke start and applies to subsequent strokes only.

Color advanced popover: Opens from a chevron on the swatches; shows a native Hue range input; S/L remain fixed; selected hue applies to next stroke/text.

Text overlay: A positioned lightweight overlay (textarea or contentEditable) that is local-only until commit; Enter (or clicking outside) commits once; Esc cancels. On commit, create one texts[] entry (immutable post-commit).

Eraser preview. While pressed/dragging, targeted strokes or a text node preview at reduced opacity; on release, the previewed set is deleted in one operation; a single Undo restores them.

Tooltips with shortcuts. Show ‘Text (T)’, ‘Undo (Ctrl/Cmd+Z)’, etc.

Eraser: Whole-object eraser. Deletes entire strokes or a text node when its bounds are hit; no partial erasing.

5.3 Page management
“Clear board (for everyone).” Appends a scene tick (append-only); everyone moves to a blank board (previous elements remain in the doc but are hidden/export-excluded). Undo window: 10 s local toast; afterward, global Undo cannot revert scene changes. Rate-limit: 1 clear / 15 s (server-enforced when online, e.g., via a Redis lock). No page history UI. Visibility rules continue to apply to visible elements in the current scene. Offline: Clear works locally and the scene tick applies to everyone on reconnect (no page history).
5.4 Export
PNG export: Viewport or Entire board (of visible elements (strokes + stamps + text)). Max output long edge 8192 px, 24 px padding, white background; 2 s render budget → fall back to Viewport with toast. Allowed even in read-only.
Toast (fallback): "Large board—exported visible area."
Also provide "Copy as PNG to clipboard" using the Clipboard API; if unsupported, fall back to the existing download flow.
5.5 Code execution
Per-run fresh worker for JS and for Pyodide; 5 s hard timeout; output 10 KB cap per run; retain last 10 outputs per room; 128 KB total cap (older pruned). No network/FS in workers.
Service Worker (offline-first PWA): • HTML navigations (/, /rooms/:id) are cache-first, with an “Update available” prompt (on confirm: skipWaiting+ reload). • Pre-cache immutable, versioned static assets for the Monaco core + workers. • Pyodide pack (desktop-only): After activate, the client seeds silent fetches for /pyodide/<version>/** only on desktop; the SW intercepts them with a CacheFirst route and stores them. No user-visible status text; acquisition is invisible. • Do not cache /api/**, /yjs/\*\*, or any WebSocket traffic. • Use a dedicated offline-pack-v{APP_VERSION} in addition to app-shell-v{APP_VERSION}.
Web App Manifest & installability: Ship manifest.webmanifest with name, short_name, start_url: "/?source=pwa", display: "standalone", theme_color, and background_color. Link it in index.html via <link rel="manifest" href="/manifest.webmanifest">. Include icons: 192×192, 512×512, and a maskable 512×512 for Android. This is installability only; it does not alter runtime behavior.
5.6 Room lifecycle
Creation (local-first):

Offline: generate roomId = local-<ulid>; create new Y.Doc({ guid: roomId }); attach y-indexeddb; add a rooms entry { provisional: true }; route to /rooms/local-<ulid>.

Online publish (auto on reconnect or manual “Make shareable”): call POST /api/rooms (optionally with a client-supplied id). On success, join /rooms/:serverId over WS, merge local state, update IndexedDB aliases (local-… → serverId), and mint the share link.

Python execution gating (desktop-only warm): If a user runs Python before the pack is present, the request is queued and executes once the worker is ready—no modal or banner; at most a subtle inline spinner on the Run control (no text).
Join: /rooms/:roomId (resolve local-… via aliases when online).

Capacity: 105 → reject joins.

Size cap: 10 MB → read-only; 8 MB warning.

Expiry: ROOM_TTL_DAYS (default: 14) since last accepted write, no recovery.

Extend room: client button performs a minimal Yjs write (e.g., increment meta.keepAliveCounter), extending TTL by ROOM_TTL_DAYS; show toast “Room extended to \*\*\*\*.”; throttle to ~24 h; has no other side-effects.

Title rename: Inline → PUT /api/rooms/:id; rate-limited; no auth in MVP.

5.7 "My Rooms"
Device-local list (IndexedDB) including provisional rooms and published rooms; fields: title/last opened/expires-in, plus provisional and optional aliasOf. Deleting from the list removes only the local entry; per-room Y.Doc remains until “Delete local copy.”
5.8 UI requirements (non-visual)
Split view default 70/30 with draggable resizer + editor toggle; copy-link with toast; central toast for limit/undo/export messages; dark mode affects UI but exports stay white.
Normative UI strings:
"Link copied" / "Cleared for everyone. Undo (10s).".
\*\*“Room extended to .”
“Expires in X days.”
“Text committed.”
Menu label: “Clear board (for everyone)”
Tooltip/help (Clear): “Starts a blank board for everyone. The current board won’t be visible anymore. Applies when you reconnect. No page history.”
AI Assistance toggle label: “AI Assistance”
Status chip (offline swap): “Offline — switched to Quick Tools”
Apply precondition banner: “Can’t apply: the file changed.”
Buttons: “Apply”, “Re-run”, “Open 3-way merge”, “Copy patch”, “Retry”, “Continue”
Keyboard shortcuts: 1/2/3 switch Pen/Highlighter/Eraser; T selects Text tool; Enter commits; Esc cancels text; Space = pan; Ctrl/Cmd+E = export; Ctrl/Cmd+K = Clear board (for everyone); Esc cancels streaming in AI panel; Cmd/Ctrl+Enter sends. Shortcuts are disabled while focus is inside Monaco.

Accessibility: Range inputs have labels (“Brush size”, “Hue”) and ARIA outputs for numeric value; popovers are focus-trapped and dismiss on Esc. AI panel announces online/offline transitions via ARIA live region; bottom-bar toggle is focusable with appropriate ARIA label.

Connection indicator: shows Online / Reconnecting / Offline / Read-only. States derive from y-websocket provider + room size cap.

Room stats (size/cap): Show nothing by default. At ≥80% of cap, render a subtle header pill: X.Y / 10 MB. At cap, show a single inline banner: “Board is read-only — size limit reached.” No warning toasts for size.

Stats source: Server publishes { bytes, cap } at most every 5 s or after ≥100 KB change (piggyback on room state updates). Clients may fallback to a local estimate if missing (advisory only). (This complements the existing Flush hook that updates sizeBytes after accepted Redis writes.)

Loading skeletons: visible during room join, Monaco load, and initial Pyodide fetch; align with prescribed offline copy.

Optional (non-blocking polish): Basic landing page with "Create Room" and a device-local "My Recent Rooms" list (from IndexedDB). No server-side list, no auth.

Read-only clarity. Disable write tools in read-only; show a short inline caption near the banner (‘Board is read-only’).

Edge-hover dwell. Reveal dwell ≈150–250 ms; hide after ≈300–500 ms idle (values are indicative, non-normative).

Touch behavior. On touch devices, tap to reveal the unpinned toolbar; auto-hide on outside tap or idle.

5.9 AI Assistance (Mode A only)
Visibility & first-run. A small, persistent bottom-bar toggle labeled “AI Assistance” is always visible. On first app load only, the panel opens by default. Thereafter, persist open/closed state device-locally (localStorage); no automatic pop-ups.
Placement & resizing. The assistant is docked within the editor pane (above Monaco output). It offers two slots (top/bottom) with a drag handle to switch slots and a vertical resizer to expand/shrink. Not a free-floating window. Panel layout is device-local (localStorage) and does not change the global 70/30 split.
Composer & streaming. Composer sends: selection, viewport context, file meta, and the last 3 pairs of chat history. Enforce token + time clamps (10s hard timeout). Esc cancels; Cmd/Ctrl+Enter sends.
Outputs & Apply. Responses may include unified diffs and tests alongside text. Apply performs a single yjs.transact(...). Precondition: patches are anchored to a hashed span (or snapshot hash). On mismatch, fail fast with an inline banner and actions: Re-run, Open 3-way merge, Copy patch. 3-way merge is a minimal preview; user must resolve; assistant never guesses.
Offline transition. If offline (or network drops mid-stream), show status chip “Offline — switched to Quick Tools”, disable composer, and present an Offline Tools tray exposing four deterministic on-device tools (no LLM): Explain Selection, Minimal Refactor, Generate Tests, Practice Problem (Easy/Medium/Hard with pre-written progressive hints from a bundled pack). On reconnection, automatically restore the chat composer and keep the transcript.
Explicit scope. There is no Mode B/C and no autonomous writes. The agent never writes to Yjs—only user-initiated Apply makes changes.
Hashed span precondition (apply check).
Compute a stable hash (e.g., SHA-256) of filePath + startLine + endLine + normalizedSpanText. Store alongside the patch. On Apply, re-hash the current span (or verify snapshot id). Proceed only if they match; otherwise raise the precondition failed banner.
Large responses. Enforce output clamps; show a Continue chip to request the next chunk.
Errors & edge cases. Map to friendly UI per §4.4 (timeout, 429, provider errors, large response clamp).
Telemetry. Emit events listed in §3.9. KPIs in §12.

6. Non-Functional Requirements
   Performance.
   Render: 60 FPS via dirty-rect redraw + culling; do not render thousands per frame. Text render occurs in a dedicated pass after strokes.

Sync: send throttle ≈30 Hz; presence 75–100 ms; flush to Redis every 2–3 s (≤5 s worst). Publish measured p50/p95.

Goal (non-normative): ≤125 ms p95 with ~50 users and ≤25 drawers.

Scalability. Single-node MVP; future multi-node requires pub/sub for Yjs.
Security. Origin check required; CSP Profile A default; HSTS after TLS stable; nosniff; no-referrer; inbound WS frame cap 2 MB; no session tokens; upgrades validated with Origin + roomId.
Availability & reliability.
TTL-based retention (ROOM_TTL_DAYS (default: 14)); AOF enabled; doc GC of in-memory Y.Doc after idle with final flush; no recovery for expired rooms.

Hourly TTL janitor deletes expired rooms and reconciles TTL drift; log counts/durations.

Metadata DB degraded mode: If PostgreSQL is unavailable, collaboration (WS + Redis) continues; metadata endpoints may 503; UI tolerates missing title/size.

Usability & accessibility. Clear toasts; copy text specified; cursor previews per tool; no auto-panning due to remote actions. Slider labels and Esc-to-close for popovers are required. Toolbar: keyboard navigable; focus trap in popovers; no auto-hide while a popover is open; no auto-reveal while pointer-down drawing. AI panel announces connectivity changes via ARIA live region.
Maintainability & supportability.
Instrument size/limit/Redis failures/exports/Executor cache state; Sentry across app + workers; track Extend-Room clicks and rooms-extended counts; add counters for Text commits and advanced slider usage (size & hue) and toolbar behaviors. Emit AI events in §3.9.

All Yjs observers must be unobserved on component unmount (useEffect return).

PWA constraints (affirmed).
Do not modify SW routes; do not cache /api/** or /yjs/**.

Lazy-load the assistant bundle; first-run open loads UI only; the model/API is called only when the user sends a message.

Maintain existing asset budgets.

7. Data Architecture & Flows
   Entities & stores.
   Yjs doc (authoritative) → persisted as compressed binary in Redis (room:<roomId>, TTL ROOM_TTL_DAYS (default: 14)). Includes strokes[] and texts[].

Awareness (ephemeral over WS).

IndexedDB → per-room Y.Doc persistence via y-indexeddb (offline reopen + editing), “My Rooms” device list, and an aliases map (provisional→server id). (No server truth.) Local UI state (toolbar side/pinned/collapsed, AI panel layout) is stored in localStorage (device-local), not in IndexedDB/Yjs.

PostgreSQL → non-authoritative metadata (id, title, createdAt, lastWriteAt, size_bytes).

Flows.
Stroke creation → local Yjs transact → y-websocket delta → remote apply → Redis flush (debounced).

Text commit → local overlay finalize → single Yjs transact → broadcast → Redis flush (debounced).

Eraser preview → delete on release → mark touched IDs as ‘preview’ during press/drag (rendered with reduced opacity), then delete that set on release in one transaction; clear preview.

Clear board (for everyone) → append a tick to meta.scene_ticks (append-only) → current scene becomes scene_ticks.length → all visibility filters use the current scene.

Export → client-side render over visible elements (strokes + stamps + text); capped output and time budget.

Flush hook metadata update → upon successful Redis writeState, upsert { lastWriteAt=now(), sizeBytes } in PostgreSQL. If unavailable, skip without affecting collaboration.

Code execution → per-run worker, output appended to Yjs metadata subject to limits.

Extend room → client performs minimal Yjs write → accepted write extends Redis TTL; no effect from views/presence.

AI Apply (Mode A) → diff card Apply → yjs.transact(...) with hashed span precondition → on mismatch, fail fast with inline banner and actions Re-run / Open 3-way merge / Copy patch; 3-way merge requires explicit user resolution.

Offline transition → network drop during streaming → disable composer; show status chip “Offline — switched to Quick Tools”; expose Offline Tools; on reconnect, restore composer and preserve transcript.

Canvas rendering & indexing (normative):
LOD: at zoom < 0.5 render simplified strokes; ≥ 1.0 render full geometry.

Render pass order: strokes → stamps → text.

RBush maintenance: batch dirty updates; rebuild when ≥100 dirty elements; index text bounding boxes for hit-testing (eraser).

Collision sanity: never auto-pan/snap the viewport due to remote actions.

Service Worker / caching. Cache-first HTML and versioned static assets. Monaco is pre-cached. Pyodide is desktop-only and warmed silently post-activate via client-seeded requests and a CacheFirst route; files are immutable under /pyodide/<version>/. Do not cache API endpoints, yjs traffic, or WS. Show an update prompt when a new app version is available.
Data transformations. gzip level 4 compression before Redis; size_bytes equals last persisted compressed payload size.
Privacy & retention. TTL refreshes only on accepted document writes; viewing/awareness traffic does not extend TTL. Expiry deletes data permanently.

8. Dependencies & Integrations
   Third-party (hard MVP). Yjs, y-websocket, y-indexeddb, Monaco, Pyodide, Redis, Prisma, PostgreSQL. Vendored static assets for Monaco & Pyodide are self-hosted under / and are included in the SW pre-cache.
   Test (dev-only): Playwright (@playwright/test) for E2E browser tests.
   Dev tooling (dev-only): ESLint 9 with TypeScript parser, Prettier for code formatting, Husky for git hooks, lint-staged for pre-commit automation. Pre-commit runs ESLint auto-fix and Prettier formatting on staged files only. Type checking intentionally kept in CI to maintain sub-5s pre-commit performance.
   Internal dependencies. Canvas renderer (pan/zoom), RBush index, toast system, minimap, PWA assets (manifest.webmanifest; icons 192/512/maskable-512).
   AI diffing & merge helpers. Tiny unified-diff renderer and optional small diff3 helper (or local impl) for the 3-way merge preview.
   Offline tooling helpers. Light AST/template utilities used by Offline Tools.
   AuthN/AuthZ. None; link-based open access by design.
   Monitoring & logging. Sentry + custom counters listed in §3.9 (no content logging).

9. Technical Constraints & Assumptions
   Hard constraints. All numeric limits/caps are authoritative in §3.6. Do not restate numbers elsewhere; reference §3.6 where needed.
   PWA offline pack (normative): Pre-cache Monaco (core + workers) at install. Pyodide is not in the precache; it is desktop-only and acquired silently after activate (immutable versioned path). The Service Worker must not intercept WebSocket traffic and must not cache /api/** or /yjs/**. No background sync or push in MVP.
   Assumptions.
   Typical boards stay far below the hard size limit, but enforcement must be exact.

Mobile editing is intentionally disabled to reduce complexity & latency.

Users may expect editable text post-commit; MVP intentionally keeps text immutable (edits via erase-and-reinsert).

Users may expect draggable/resizable toolbars; MVP intentionally provides docking (left/right), collapse, and optional auto-hide only.

Mode A only. The AI agent never writes to Yjs autonomously; only Apply writes, guarded by hashed span precondition. No Mode B/C now or later.

AI panel layout state is device-local only (localStorage), not synchronized.

Risks & mitigations.
Single-node SPOF → accepted for MVP; measure and publish SLOs; plan pub/sub later.

Open link model (no auth) → sensitive content risk; mitigate with Origin checks and rate limits.

No recovery after TTL → clearly communicate in UI (metadata and toasts); covered in acceptance tests.

10. Validation & Testing Schemas
    Acceptance criteria (major features).
    Size enforcement: At 8 MB, show the inline header pill only (no toast). At 10 MB, room switches to read-only; doc updates are rejected; awareness continues; persistent banner is shown.

TTL expiry: After ROOM_TTL_DAYS (default: 14) of no writes, Redis record deleted; joining shows empty/new room.

Capacity limit: At 105 clients, further joins fail with room_full.

Cold-start offline (fresh install): App shell and Monaco editor are available on first run with no visible status copy. Python becomes available offline on desktop once the silent warm completes; invoking Python earlier queues the run with no modal/banner.

Export: Entire board respects scene filtering and white background; ≥2 s render falls back to viewport with toast; exported images include committed text.

Scene/visibility: All compute paths (render, eraser, minimap, export) operate only on visible elements for current currentScene = meta.scene_ticks.length.

PWA installability: Lighthouse reports "Installable: yes"; manifest and icons valid (including maskable).

Offline app-shell + editors: Available from first run (pre-cached Monaco); no “preparing Python” copy anywhere.

Update flow: When a new build is deployed, the app shows an Update available prompt; on confirm, the new version activates after reload.

Local-first rooms: Offline “Create Room” produces a provisional id, persists the doc, and allows editing; on reconnect, the client publishes the room, merges state to the server doc, updates aliases, and surfaces a shareable link.

Undo/Redo: Whiteboard operations undo/redo correctly; scene tick operations (meta.scene_ticks) are excluded from global Undo; only the 10 s local ‘Clear’ Undo toast may revert the last tick if still within the window. Text node create/delete are undoable.

Shortcuts: Keybindings trigger the correct actions and are suppressed while typing in Monaco; T selects Text; Enter commits; Esc cancels text overlay; Ctrl/Cmd+K = Clear board (for everyone).

Connection indicator: Transitions through Online/Reconnecting/Offline/Read-only accurately reflect provider + caps.

Clipboard export: Uses clipboard when supported; clean fallback to download otherwise.

Metadata semantics: /api/rooms/:id/metadata returns 404 when Redis key is missing even if a DB row exists; ROOM_TTL_DAYS (default: 14).

Rename: PUT /api/rooms/:id updates title; rate-limits enforced.

Flush hook: Postgres lastWriteAt and sizeBytes update only after successful Redis write.

Extend button: pressing Extend performs a minimal Yjs write; TTL is extended by ROOM_TTL_DAYS; shows \*\*“Room extended to .”

Views don’t extend TTL: Viewing/presence alone does not change TTL.

Undo exclusion: the Extend write (meta.keepAliveCounter or meta.lastExtended) is excluded from Undo history (like scene ticks).

Text tool: Local overlay is not visible to others; Enter commits once; Esc cancels; Undo removes the newly committed text; Redo restores it; Eraser removes a text node in one action.

Size slider: Value changes reflect cursor ring and apply to next stroke only; changing mid-stroke doesn’t alter the in-progress stroke.

Color slider (Hue): Advanced hue selection applies to the next stroke/text; highlighter respects opacity 0.25 with selected hue.

Toolbar docking & persistence: Defaults to left/pinned/expanded; side flip, collapse/expand, and pin/unpin work; state persists across reloads; toolbar never auto-reveals during pointer-down drawing; stays visible while a popover is open.

Toolbar auto-hide timings: Edge-hover reveal/hide roughly match dwell targets; touch tap-to-reveal works; read-only disables write tools.

Undo scope: A user’s Undo/Redo only affects their own operations; remote users’ commits are not undone; Eraser deletes restore with a single Undo.

Eraser preview: Items under the eraser preview at reduced opacity during press/drag and are deleted on release in one operation (strokes or an entire text node).

AI Assistance (Mode A):

First-run open: Panel auto-opens only on the very first app load; later reloads respect persisted state.

Panel docking: Panel remains within the editor region; two slots (top/bottom); drag handle + vertical resizer work and persist device-locally.

Composer behavior: Sends selection/context/history; Esc cancels streaming; Cmd/Ctrl+Enter sends.

Diff rendering & Apply: Unified diff/tests cards render; Apply performs single yjs.transact(...) and succeeds only when hashed span matches.

Precondition failure: Shows inline banner with Re-run / Open 3-way merge / Copy patch; 3-way merge opens and requires explicit user choice.

Offline transition: Mid-stream network loss swaps to Offline Tools tray; status chip shown; transcript preserved; on reconnect, composer is restored.

Timeout & 429: 10s timeout surfaces Retry; 429 maps to friendly message with backoff hint.

Large response clamp: Truncation shows Continue chip; follow-up resumes with same context.

Telemetry: Events emitted per §3.9 for panel toggle, TTFB, patch rendered/applied, precondition failures, conflict openings, offline tool usage, practice difficulty/hints, provider/timeout counts.

10.2 End-to-End Testing (Playwright) — Concise Guide`**Purpose.** Run realistic browser checks that exercise the MVP acceptance criteria and normative UI strings in §10 (e.g., read-only at 10 MB, TTL expiry, “Clear board (for everyone)”, offline quick-tools swap, AI precondition banner).
**Install (dev-only).** Add`@playwright/test`as a **root** devDependency and run`npm run e2e:install`once on CI or new machines. Note: On restricted shells, use`playwright install chromium`instead of`--with-deps`.
**Scripts (root `package.json`).\*\*

- `"test:e2e": "playwright test"`
- `"test:e2e:ui": "playwright test --ui"`
- `"test:e2e:report": "playwright show-report"`
- `"e2e:install": "playwright install --with-deps"` (Note: On restricted shells, use `"playwright install chromium")
- `"e2e:serve": "npm run build && node server/dist/index.js"`
  **Config (`playwright.config.ts`, at repo root).**

```ts
import { defineConfig } from '@playwright/test';
export default defineConfig({
testDir: 'e2e',
use: { baseURL: process.env.BASE_URL ?? 'http://localhost:3000', headless: true },
webServer: {
`command: 'npm run e2e:serve',`

`url: process.env.BASE_URL ?? 'http://localhost:3000',`

`reuseExistingServer: !process.env.CI,`

`timeout: 120_000`

},
reporter: [['list'], ['html', { open: 'never' }]],
projects: [{ name: 'chromium' }]
});
Structure.
e2e/create-room.spec.ts


e2e/clear-board.spec.ts


e2e/read-only-cap.spec.ts


e2e/offline-quick-tools.spec.ts


e2e/ai-precondition-banner.spec.ts


Selector strategy. Prefer role-based queries and the normative strings already specified in the Overview:
Toasts: “Link copied”, “Cleared for everyone. Undo (10s).”, “Board is read-only — size limit reached.”


Toggle/labels: “AI Assistance”


Status chip: “Offline — switched to Quick Tools”


Banner: “Can’t apply: the file changed.”


Example tests (minimal).
e2e/create-room.spec.ts
import { test, expect } from '@playwright/test';
test('copy link shows toast', async ({ page }) => {
await page.goto('/rooms/e2e-playwright');
await page.getByRole('button', { name: /copy link/i }).click();
await expect(page.getByText('Link copied')).toBeVisible();
});
e2e/clear-board.spec.ts
import { test, expect } from '@playwright/test';
test('clear board shows undo toast', async ({ page }) => {
await page.goto('/rooms/e2e-clear');
await page.getByRole('button', { name: /clear board \(for everyone\)/i }).click();
await expect(page.getByText('Cleared for everyone. Undo (10s).')).toBeVisible();
});
e2e/offline-quick-tools.spec.ts
import { test, expect } from '@playwright/test';
test('offline swap shows status chip', async ({ page, context }) => {
await page.goto('/rooms/e2e-offline');
await context.setOffline(true);
// Trigger something that would hit the AI endpoint, then ensure swap status appears
await expect(page.getByText('Offline — switched to Quick Tools')).toBeVisible();
await context.setOffline(false);
});
(Keep each spec concise; expand scenarios as features stabilize.)

11. Release & Ops
Ship AI Assistance enabled by default with first-run open. Thereafter, respect locally persisted state.


No feature flags for Mode B/C; remove any mention of future autonomous modes.


Continue single-container Railway deployment; no infra changes required beyond /api/ai/* route.


CI: Run E2E on PRs — npm run e2e:install && npm run test:e2e with the Playwright webServer starting npm run e2e:serve. Upload the HTML report as an artifact. (In no-sudo environments, use `playwright install chromium`.)



12. Telemetry & KPIs
Events: See §3.9 (counters only; no content logging).


KPIs:


apply_success_rate = ai_patch_apply_clicked / ai_patch_rendered


precondition_failure_rate = ai_patch_apply_failed_precondition / ai_patch_apply_clicked


Dashboards: Track TTFB distribution, timeout/429 rates, offline tool usage mix, and hint reveal counts.



13. File/Module Layout (reference)
Components:


AiToggle — bottom-bar “AI Assistance” toggle (focusable, ARIA-labeled).


AiPanel — docked panel with two slots + vertical resizer + drag handle.


DiffPreview — unified-diff/tests card with Apply + conflict banner.


ThreeWayMergeModal — minimal 3-way merge preview + explicit resolution actions.


OfflineToolsTray — deterministic tools UI (Explain Selection, Minimal Refactor, Generate Tests, Practice Problem).


PracticeProblemView — difficulty selection (Easy/Medium/Hard), progressive hints, sample tests.


TelemetryClient — emits counters listed in §3.9.


Client services:


aiClient.postComplete() → POST /api/ai/complete (streamed).


localLayoutStore → persists AI panel slot/size/open state (localStorage).


Helpers:


diffRenderer (small), diff3 (optional tiny helper or local impl).


Offline AST/template utilities.


Tests:


e2e/ — Playwright tests (*.spec.ts), config at repo root (playwright.config.ts).



Appendix A: SW precache pointers (indicative; adjust to your build output)
Precache list (indicative):
 • /monaco/**/editor.main.* , editor.worker.* , ts.worker.*
 • (do NOT include /pyodide/** in precache)


Runtime warm (desktop-only):
 Client seeds fetch for:
 • /pyodide/<version>/pyodide.js
 • /pyodide/<version>/pyodide*.wasm
 • /pyodide/<version>/python_stdlib.zip
 • /pyodide/<version>/packages.json
 SW has a CacheFirst route for /pyodide/<version>/**.


Gating & cleanup:
 Only seed on desktop (UA hints); purge old pyodide-pack-* caches on activate when version changes.



Appendix B: Hashed span precondition (apply check)
Compute stable hash of: filePath + startLine + endLine + normalizedSpanText.


Store in patch metadata with targeted line range (or snapshot id).


On Apply, re-extract span and re-hash; proceed only if hashes match (or snapshot id matches). Otherwise, raise precondition failed with actions Re-run / Open 3-way merge / Copy patch.

```
