# **AVLO\_IMPLEMENTATION\_GUIDE.md**

> Canonical sources incorporated: new changes from the update prompt, plus the overview’s normative rules.

---

## **Phase 0 — Repo skeleton, tooling, and CI (Day 0)**

**Goal:** Establish a two-workspace monorepo (client/server) with consistent scripts, CI checks, and a simple asset publish script that copies client assets into the server’s static dir.

**Deliverables / Constraints**

* Workspaces `client`, `server`; `build` copies Vite output into `server/public`.
* Root scripts: `dev`, `build`, `bundle:assets`, Prisma `db:*`, Playwright `test:e2e*`.

**Exact root scripts & copy script (corrected + E2E convenience):**

```json
// package.json (root)
{
  "name": "avlo",
  "private": true,
  "workspaces": ["client", "server"],
  "scripts": {
    "dev": "concurrently \"npm:dev:server\" \"npm:dev:client\"",
    "dev:server": "npm run dev --workspace=server",
    "dev:client": "npm run dev --workspace=client",
    "build": "npm run build --workspace=client && npm run build --workspace=server && npm run bundle:assets",
    "bundle:assets": "node scripts/copy-client-dist.mjs",
    "db:generate": "npm run prisma:generate --workspace=server",
    "db:migrate": "npm run prisma:migrate --workspace=server",
    "db:deploy": "npm run prisma:deploy --workspace=server",
    "test:e2e": "playwright test",
    "test:e2e:ui": "playwright test --ui",
    "test:e2e:report": "playwright show-report",
    "e2e:install": "playwright install --with-deps", // Note: On restricted shells, use "playwright install chromium"
    "e2e:serve": "npm run build && node server/dist/index.js"
  },
  "devDependencies": {
    "concurrently": "^9.0.0",
    "playwright": "^1.45.0"
  }
}
```

```js
// scripts/copy-client-dist.mjs
import { cp } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const src = resolve(__dirname, "../client/dist");
const dst = resolve(__dirname, "../server/public");
await cp(src, dst, { recursive: true });
console.log(`Copied client/dist → server/public`);
```

**Substeps**

1. Create workspaces and commit the root `package.json` and `scripts/copy-client-dist.mjs`.
2. Add CI (e.g., GitHub Actions): Node setup → `npm ci` → `npm run build` → `npm run test:e2e` on PRs. Cache Playwright browsers + Node modules.
3. Ensure Playwright webServer starts `npm run e2e:serve` for E2E runs in CI.

**Acceptance checks**

* Single `npm run build` builds both workspaces and publishes assets into `server/public`.
* CI runs end-to-end tests headless; failures block merge.

---

## **Phase 1 — Server foundation (Express + y-websocket + Redis + Prisma)**

**Goal:** Boot an Express server with y-websocket gateway, Redis authoritative state, PostgreSQL metadata via Prisma, rate limits, origin allowlist, logging, health endpoints.

**Deliverables / Constraints**

* Tech/deps: `express`, `ws`, `y-websocket`, `redis`, `@prisma/client`, `prisma`, `zod`, `helmet`, `cors`, `express-rate-limit`, `pino`, `@sentry/node`.
* Env vars: `NODE_ENV`, `PORT`, `DATABASE_URL`, `REDIS_URL`, `ORIGIN_ALLOWLIST`, `SENTRY_DSN` (optional), `APP_VERSION`, ‘ROOM_TTL_DAYS’(deafult 14)
* **WebSocket endpoint:** `WS /ws` (Origin required). Client identifies `{ roomId }` on connect.
* **Compression for Y.Doc persistence & byte accounting:** use **gzip level 4** for all persisted Y.Doc buffers (Redis). All reported **`sizeBytes`** refer to the **gzip(4) buffer length** of the last **accepted** write. Target flush cadence 2–3 s (≤5 s worst).
* Redis **authoritative** storage: key `room:<roomId>` stores **binary gzip(4)-compressed** Y.Doc; TTL extends only on **accepted** writes; AOF enabled. PostgreSQL stores **non-authoritative** metadata: `id`, `title` (≤120), `createdAt`, `lastWriteAt`, `sizeBytes`. Existence is defined by Redis presence.
* **Origin allowlist:** comma-separated absolute origins (`scheme://host[:port]`). No wildcards in MVP.
* **Trust proxy:** `app.set('trust proxy', 1)` to respect real IP from left-most `X-Forwarded-For` for per-IP WS caps and rate limits.
* **Room stats publication (advisory):** publish `{ type: "room_stats", bytes, cap }` at most every 5 s or after ≥100 KB increase. Clients may fallback to local estimate until stats arrive.
GC in-memory Y.Doc after idle; final flush before dispose

**Server gzip(4) snippet (illustrative):**

```ts
// server/yjs-hooks.ts
import { gzip } from "node:zlib";
import { promisify } from "node:util";
const gzipAsync = promisify(gzip);

async function writeState(roomId: string, yDocBinary: Buffer) {
  const roomTtlSeconds = (parseInt(process.env.ROOM_TTL_DAYS ?? '14', 10)) * 24 * 60 * 60;
  const compressed = await gzipAsync(yDocBinary, { level: 4 });
  await redis.set(`room:${roomId}`, compressed, { EX: roomTtlSeconds, KEEPTTL: false });

  // persist sizeBytes from compressed.length
  await prisma.room.upsert({
    where: { id: roomId },
    update: { sizeBytes: compressed.length, lastWriteAt: new Date() },
    create: { id: roomId, title: roomId, createdAt: new Date(), lastWriteAt: new Date(), sizeBytes: compressed.length }
  });
}
```

**REST (OpenAPI excerpt)** — `/api/rooms` (POST), `/api/rooms/{id}/metadata` (GET), `/api/rooms/{id}` (PUT rename); 200 on idempotent create; 404 when Redis room missing even if DB row exists; rate-limited.

```yaml
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
                  pattern: "^[A-Za-z0-9_\\-]+$"
                title: { type: string, maxLength: 120 }
      responses:
        "201":
          description: Created
          content:
            application/json:
              schema:
                type: object
                required: [roomId, shareLink]
                properties:
                  roomId: { type: string }
                  shareLink:
                    type: string
                    pattern: "^/rooms/[A-Za-z0-9_\\-]+$"
        "200":
          description: "Exists (idempotent). Returned when the supplied id already exists; response still includes roomId + shareLink."
        "429": { description: "Rate limit exceeded" }
```

* **UI mapping (create room 429):** show toast **“Too many requests — try again shortly.”** with backoff hint; no stack traces.

**WS hygiene:** per-IP concurrent WS ≤ 8; inbound frame cap 2 MB; enforce Origin allowlist; reconnection hints (see Phase 2).

**Acceptance checks**

* Disallowed origins rejected (CORS & WS).
* WS rejects frames > 2 MB; per-IP concurrent WS limited to 8.
* `GET /api/rooms/:id/metadata` returns 404 when Redis doc is missing; `POST /api/rooms` with existing id returns 200 (idempotent).
* With sustained edits, client receives `room_stats` at least every 5 s or after ≥100 KB growth.

---

## **Phase 2 — Client foundation (Routing, providers, shell)**

**Goal:** Route `/` and `/rooms/:id`, wire Yjs providers (`y-websocket` & `y-indexeddb`), and render the app shell with mobile view-only gating.

**Deliverables / Constraints**

* Offline-first: attach `y-indexeddb` per room; do **not** delete per-room IndexedDB on leave.
* Mobile **view-only** gate; Editor role otherwise (no auth). Gate by capability (e.g., `(pointer: coarse)` or width ≤ 820 px); no UA sniff.
* Connection indicator: Online / Reconnecting / Offline / Read-only.
* Presence: name/color/cursor/activity; 75–100 ms tick; \~30 Hz send throttle.
* Split view defaults 70/30 with resizer & editor toggle; Users indicator + expandable UsersList (desktop).
* Copy link: header button with toast **“Link copied.”**
* Accessibility: focus-trapped popovers/sliders, `Esc` closes, focus returns to trigger; sliders expose numeric readout.
* **Y.Doc construction & identity:** `new Y.Doc({ guid: roomId })` on room load; **never mutate `guid`** after construction.
* **Viewport semantics:** **full document sync always occurs**; viewport affects **rendering/presence only** (no selective sync).

**Providers / WS hygiene (addition):**

* **Reconnection policy:** exponential backoff **with full jitter**:
  `sleep_ms = random(0, min(30000, base * 2^attempt))` with `base ≈ 500 ms`.

**Toolbar & Presence micro-behaviors (additions)**

* **Toolbar unpinned auto-hide:** when unpinned, hide off-edge and **reveal on edge-hover** after a short dwell; **never auto-reveal during pointer-down drawing**; remains visible while a popover is open or the toolbar has focus. `side`, `pinned`, and `collapsed` persist **device-locally**.
* **Undo/Redo controls:** toolbar buttons labeled **“Undo”** and **“Redo”**; keybindings **Ctrl/Cmd+Z** and **Ctrl/Cmd+Y**.
* **Cursor trails:** maintain a **ring buffer of 24** points per remote cursor; render at most **20** remote cursors; disable trails on mobile.
* **Cursor ring & size slider:** the live cursor ring **scales** with the brush size slider.

**Acceptance checks**

* On mobile, write tools disabled; board renders.
* Disconnect shows Reconnecting; Offline shows Offline; at hard size cap shows Read-only.
* Users indicator count equals number of rendered remote cursors (up to 20).
* Clicking Copy link shows **“Link copied.”**
* Popovers/slider a11y behaviors hold.
* Presence continues to render in **read-only** and on **mobile view-only** (write tools disabled).
* With toolbar **unpinned**, edge-hover reveal works; **no reveal during pointer-down**; `side/pinned/collapsed` persist across reloads.
* Users indicator count equals rendered remote cursors (≤20); trails show smooth motion (buffered), disabled on mobile. *(Undo/Redo keybindings verified in Phase 3.)*

---

## **Phase 3 — Yjs schema + whiteboard core**

**Goal:** Implement document schema, renderer (RBush + dirty-rect + LOD), tools, undo/redo scope, keyboard navigation.

**Deliverables / Constraints**

* **Schema (logical JSON view)** — `strokes[]`, `texts[]`, `code.splitView`, `meta.scene_ticks[]`, `meta.title`, etc. Current scene = `meta.scene_ticks.length`; render/export only `scene === currentScene`.
* Renderer: RBush spatial index; dirty-rect; LOD rules; highlighter opacity **0.25**; cursor preview opacity **0.35**.
* **Constraints (normative):** `MAX_POINTS_PER_STROKE = 10000`, `MAX_TOTAL_STROKES = 5000`.
* **Text guardrail:** `text.content.maxLength = 500` characters.
* **LOD thresholds:** at zoom `< 0.5` render simplified stroke geometry; at `≥ 1.0` render full geometry.
* **Render order (passes):** strokes → stamps → text.
* **RBush maintenance:** batch dirty updates; rebuild index when `≥ 100` elements are dirty; index text bounding boxes (for eraser hit-testing).
* **Collision sanity:** never auto-pan/snap viewport due to remote actions.
* Tools: **Pen**, **Highlighter**, **Stamps** (rectangle/ellipse/**arrow**), **Text**, **Pan** (spacebar).
*Exclude the Extend keep-alive write from global Undo*
  * *Stamps are **single-stroke** inserts and are **immutable post-insert** (erasable as whole objects; no edit/resize in MVP).*
* **Text tool (visibility rule):** renders a **local-only overlay**; **Enter** or clicking outside commits **one Yjs transaction**; **Esc** cancels. **Undo** restores the text node; **Eraser** removes a text node in one action.
* Zoom/pan: wheel+ctrl, pinch; pan with spacebar drag.
* Undo/Redo: per-user origin scope; **scene tick ops excluded**; text nodes participate.

  * *Toolbar buttons labeled **“Undo”** / **“Redo”** with keybindings **Ctrl/Cmd+Z** and **Ctrl/Cmd+Y**.*
* Minimap (minimal): bounds of **visible** strokes in current scene + local viewport; ≤10 FPS; may omit text glyphs initially.
* **Eraser preview:** While pressed/dragging, targeted strokes or a text node preview at **reduced opacity**; on release, the previewed set is deleted in **one operation**; a **single Undo** restores them.
* **Cursor preview ring:** Keep preview opacity; **cursor ring scales** live with the size slider.

**Acceptance checks**

* Text commit triggers a toast (“Text committed.”) and is a single op; Esc cancels.
* Highlighter opacity 0.25; preview \~0.35.
* Zoom reset to 100% with numeric readout; minimap updates within 100 ms; ≤10 FPS.
* Creating a single stroke with >10,000 points is rejected client-side and does not mutate the Yjs doc.
* The 5,001st stroke is rejected client-side with a friendly limit message.
* Text input clamps at 500 characters (no commit beyond 500).
* At 0.25 zoom, simplified strokes are rendered; at 1.0 zoom, full geometry is rendered.
* Render order is strokes, then stamps, then text (verify with overlapping artifacts).
* After 100+ dirty elements, RBush is rebuilt once; eraser hit-tests include text bounds.
* No viewport auto-movement occurs due to remote edits.
* Pressing/dragging eraser shows reduced-opacity preview; releasing deletes the previewed set in one op; one Undo restores them.
* Stamps cannot be edited post-insert; eraser removes a whole stamp in one op.
* “Undo”/“Redo” labels present; **Ctrl/Cmd+Z** and **Ctrl/Cmd+Y** work (scene ticks excluded; text participates).

---

## **Phase 4 — “New Page (Soft Clear)” (Scene epochs)**

**Goal:** Provide soft-clear via scene ticks; ensure Undo/Redo excludes scene changes. **“Clear board for everyone”** appends a tick (≤1 every 15 s).

**Acceptance checks**

* Pressing **“Clear board for everyone”** appends a tick and shows **“Cleared for everyone. Undo (10s).”**; Undo within 10 s locally restores prior scene.
* Prior scenes do not render or export.
Export includes committed text; text overlay is not exported until committed
---

## **Phase 5 — PNG export (viewport / entire board)**

**Goal:** Export visible content as PNG with guardrails + timeouts.

**Deliverables / Constraints**

* Export **Viewport** or **Entire board** of **visible elements (strokes + stamps + text)**.
* Long edge cap **8192 px**; **24 px** padding; **white** background.
* **2 s** render budget → **fallback to Viewport** and toast **“Large board—exported visible area.”**
* **Copy as PNG to clipboard** (Clipboard API) with fallback to download.

**Acceptance checks**

* Entire board export obeys visibility/scene/LOD; padding + white bg.
* Fallback triggers at \~2 s with correct toast; clipboard path works where supported.
* Entire-board export excludes prior scenes (respects current scene tick) and honors LOD rules.

---

## **Phase 6 — Code execution (JS + Pyodide) with split view**

**Goal:** Per-run fresh workers for JS/Python, strict time/output caps, desktop-only Pyodide warm-up.

**Deliverables / Constraints**

* **Per-run fresh worker**; **5 s** hard timeout; per-run output clamp **10 KB**; keep last **10** outputs; **128 KB** total cap; **no network/FS**.
* Split view default **70/30** with resizer & editor toggle.
* **Desktop-only warm:** after SW `activate`, seed fetches for `/pyodide/<version>/**`; CacheFirst; no blocking spinners.
* On activate, purge any old `pyodide-pack-*` caches when the version changes (silent, desktop-only).

**Acceptance checks**

* Runs > 5 s are canceled; partial output kept (≤10 KB).
* Firing Python pre-warm executes automatically once ready; at most a subtle inline spinner (no text).

---

## **Phase 7 — Minimal PWA & update flow**

**Goal:** Ship installable PWA with app-shell caching, **Update available** prompt, and explicit pre-/no-cache rules.

**Deliverables / Constraints**

* **Cache-first HTML** for `/` and `/rooms/:id`; **Update available** prompt that on confirm calls `skipWaiting` + reload.
****Do not cache /api/, /yjs/**, and any WS traffic.” Add an acceptance check that these requests miss the SW cache.
* **Pre-cache Monaco (core + workers)** at install.
* **Practice Problem pack**: bundled, versioned **static JSON**; **pre-cached** with Monaco; keep small; version alongside Monaco.
* **Pyodide pack**: not in precache; warmed silently post-activate on **desktop only** via CacheFirst; **no status text**.
* **Do not cache** `/api/**`, `/yjs/**`, or any `wss:` traffic. Use `app-shell-v{APP_VERSION}` and `offline-pack-v{APP_VERSION}`.
* On activate: purge old `pyodide-pack-*` caches when the version changes.
* Manifest: `name`, `short_name`, `start_url: "/?source=pwa"`, `display: "standalone"`, `theme_color`, `background_color`, icons 192/512/**maskable** 512.

**Addition — canonical Practice Problem pack schema:**

```json
// Practice Problem pack schema (canonical)
{
  "id": "string",
  "title": "string",
  "difficulty": "easy" | "medium" | "hard",
  "languages": "string",
  "prompt": "string",
  "starterCode?": "string",
  "hints": "string",
  "referenceSolution": "string",
  "sampleTests": "string"
}
```

**Acceptance checks**

* New SW install surfaces **“Update available”** and reloads on accept.
* Requests to `/api/**` and `/yjs/**` always bypass cache.

---

## **Phase 8 — Limits, banners, and UX guards**

**Goal:** Enforce all normative caps with clear UX.

**Deliverables / Constraints**

* **Hard room size 10 MB** ⇒ read-only; **soft warn 8 MB** (header pill only, **no warning toasts** below hard cap).
* **Capacity 105** ⇒ join rejected (`room_full`). **Inbound frame cap 2 MB** ⇒ `offline_delta_too_large`. **Per-IP WS ≤ 8**. **Flush** 2–3 s (≤5 s worst). **Rate**: 10 rooms/hour/IP.
* **Gateway error → UI mapping (explicit):**

  * `room_full` → toast **“Room is full — create a new room.”**
  * `room_full_readonly` → switch client to **Read-only**; show existing **read-only banner**; **awareness continues to relay** (remote cursors still visible).
  * `offline_delta_too_large` → toast **“Change too large. Refresh to rejoin.”**
  * `create_room_rate_limited (HTTP 429)` → toast **“Too many requests — try again shortly.”** (include backoff hint).
* **Read-only clarity:** disable write tools (including Text). Presence continues.

**Acceptance checks**

* Crossing **8 MB** shows header pill `X.Y / 10 MB` within ≤5 s of growth; no toasts.
* At **10 MB**, editing blocked; banner: **"Room is read-only (10 MB limit reached). Create a new room to continue."**
* Attempted join at **105** shows **"Room is full — create a new room."**; oversize update shows **"Change too large. Refresh to rejoin."**

---

## **Phase 9 — “My Rooms” (device-only)**

**Goal:** Maintain device-local list of rooms with titles, last-opened, expiry, and aliases for offline-created rooms. Deletion doesn’t remove per-room Y.Doc.

**Deliverables / Constraints**

* Local store maintains two maps:

  * `rooms`: `{ roomId, title, last_opened, expires_at, provisional?, aliasOf? }`
  * `aliases`: `{ provisionalId -> serverId }`
* Show **“Expires in X days”** from metadata; **Extend TTL** performs a tiny Yjs write to bump `lastWriteAt`; throttle \~24 h; toast **“Room extended to ….”**
* Creating offline mints `local-<ulid>`; after publish, merge + update aliases.
* **Delete local copy:** Provide an explicit **“Delete local copy”** action that removes the per-room **IndexedDB** data for that room (does **not** affect the server room).
* **Mint share link on publish:** When an offline room is published (auto on reconnect or manual), after joining `/rooms/:serverId` and merging, **mint the share link** and update UI affordances accordingly (copy-link button + toast).

**Acceptance checks**

* Deleting local copy clears the room’s IndexedDB data; re-opening re-syncs from server; other rooms unaffected.
* After publish/merge, **Copy link** becomes available and shows **“Link copied.”** on click.

---

## **Phase 10 — Observability, security headers, and hygiene**

**Goal:** Enforce explicit security headers, origin allowlist checks (HTTP + WS), and observability counters. Do not log content.

**Security headers (express or equivalent middleware):**

* **CSP (Profile A default):** at minimum, `default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self' https: wss:; frame-ancestors 'none'.`
* **HSTS (enable only after TLS is stable):** `Strict-Transport-Security: max-age=31536000; includeSubDomains; preload.`
* **X-Content-Type-Options:** `nosniff`.
* **Referrer-Policy:** `no-referrer`.

**Origin allowlist:**

* Validate Origin on HTTP and WS upgrade against `ORIGIN_ALLOWLIST` (comma-separated absolute origins; no wildcards).

**Observability counters (non-content):**

* Flush cadence p50/p95; limit events (hard/soft cap hits); WS rejects (frame-too-large, origin, per-IP cap); executor timeouts and clamps; AI panel open/close; toolbar pin/unpin.

**Do not add push or background sync.**

---

## **Phase 11 — Deployment (Railway buildpack, no Docker)**

**Goal:** Single container; DB down must not break WS; origin checks enforced. Build with Nixpacks; start applies migrations then launches server; serve static from `server/public`.

**Hygiene & lifecycle (ops):**

* **Hourly TTL janitor:** delete expired rooms in Redis and reconcile TTL drift; log count and durations.
* **DB-down degraded mode:** If PostgreSQL is unavailable, Yjs/WS collaboration continues (Redis authoritative); metadata endpoints may 503; UI must tolerate missing title/size.
* **Room stats cadence:** publish `room_stats` ≥ every 5s or after ≥100KB growth.

**Acceptance checks**

* Stopping PostgreSQL leaves collaboration functional; `/api/rooms/:id/metadata` returns 503; UI remains usable.
* With ongoing edits, `room_stats` events fire on time or size threshold, whichever comes first.
* A room past TTL is deleted by the janitor; subsequent metadata fetch returns 404.

---

## **Phase 12 — AI Assistance (Mode A) — NEW**

**Goal:** Add optional **chat-only assistant** that proposes diffs/tests and never writes autonomously; edits apply only on **user-initiated “Apply”**. Provide deterministic **Offline Tools** when offline.

**Deliverables / Constraints**

**UI & layout**

* Docked panel inside the editor with a bottom-bar toggle **“AI Assistance”**; respects existing **70/30 split**.
* Panel open state/size is **device-local** (localStorage); **not** synced via Yjs.
* Status changes announced via the existing **ARIA live region**.

**Client services & flow**

* `aiClient.postComplete()` → `POST /api/ai/complete` (streamed). Handle partials and finalization; **10 s** request timeout.
* Patch metadata includes a **hashed-span precondition** from `filePath + startLine + endLine + normalizedSpanText`.
* On **Apply**, re-extract span, recompute hash, and **proceed only if hashes match**; otherwise show **“Can’t apply: the file changed.”** with actions **Re-run / Open 3-way merge / Copy patch**. Provide minimal **3-way merge** UI; assistant never guesses.
* **Composer context:** include the last 3 user/assistant pairs in requests for continuity.

**Server API**

* `POST /api/ai/complete` accepts:
  selection (text + line range), viewportContext, fileMeta, history (last 3 pairs), limits: `{ maxTokens, hardTimeoutMs: 10000 }`.
* Response is streamed NDJSON chunks `{ "type": "delta" | "done" | "error", ... }`.

**Offline behavior**

* When offline or mid-stream network loss, switch panel to **Offline Tools** (Explain Selection, Minimal Refactor, Generate Tests, Practice Problem). Keep transcript; on reconnect, restore composer and allow sending again. Show status chip **“Offline — switched to Quick Tools.”**

**Telemetry**

* Emit counters already listed (e.g., `ai_apply_count`, `ai_precondition_failed_count`, `ai_timeout_count`, provider error buckets) via `TelemetryClient`. Track first-run open and toggles.

**Acceptance checks**

* Apply succeeds only with matching span hash; otherwise surfaces explicit failure banner with the three actions.
* Streaming shows incremental content; **10 s** timeout enforced; errors map to friendly copy.
* On large response clamp, UI shows a **“Continue”** chip to request the next chunk (stream resumes on tap).
* When network drops mid-stream, panel switches to Offline Tools and shows chip **“Offline — switched to Quick Tools.”**; on reconnect, the composer + transcript are restored.

---

## **Appendices**

### **Appendix — Client/server constants (normative) (UPDATE)**

* **Compression & accounting:** All persisted Y.Doc buffers use **gzip level 4**. All **`sizeBytes`** values refer to the **gzip(4) buffer length** of the last **accepted** write.
* **Reconnection:** Exponential backoff with **full jitter**; ceiling **30 s**.
  (Keep existing constants: **hard cap 10 MB**, warn **8 MB**, inbound frame **2 MB**, capacity **105**, **per-IP WS ≤ 8**, flush **2–3 s (≤ 5 s)**, **TTL default 14 days**, export limits, exec limits, normative UI copy, accessibility.)

### **Appendix — Server snippets (gates) (UPDATE)**

*Add gzip(4) persistence if not present (see Phase 1 snippet above). Keep existing rate-limit/origin examples.*

```ts
// Rate limit: 10 rooms/hour/IP (POST /api/rooms)
const createRoomLimiter = rateLimit({ windowMs: 60*60*1000, max: 10 });
app.post('/api/rooms', createRoomLimiter, createRoomHandler);

// WS inbound frame cap (2 MB) + origin allowlist
const MAX_FRAME = 2 * 1024 * 1024;
wss.on('connection', (ws, req) => {
  if (!isAllowedOrigin(req.headers.origin, process.env.ORIGIN_ALLOWLIST)) {
    ws.close();
    return;
  }
  ws.on('message', (msg) => {
    if (msg.length > MAX_FRAME) ws.close();
  });
});

// Real IP behind proxy
app.set('trust proxy', 1);
function getClientIp(req) {
  const fwd = (req.headers['x-forwarded-for'] || '').split(',')[0]?.trim();
  return fwd || req.socket.remoteAddress;
}

// Room stats publication (advisory)
function maybePublishRoomStats(roomId, bytes, cap = 10*1024*1024) {
  const now = Date.now();
  const state = roomStatsState.get(roomId) || { lastBytes: 0, lastSentAt: 0 };
  const delta = Math.abs(bytes - state.lastBytes);
  if (delta >= 100*1024 || now - state.lastSentAt >= 5000) {
    broadcast(roomId, JSON.stringify({ type: 'room_stats', bytes, cap }));
    roomStatsState.set(roomId, { lastBytes: bytes, lastSentAt: now });
  }
}
```

---

## **Final consistency sweep (applied)**

* Replaced any mentions of “zlib/deflate” with **gzip(4)** and clarified `sizeBytes` semantics.
* Added `room_full_readonly` mapping and noted **awareness continues**.
* Ensured **no warning toasts** below hard cap; header pill at 8 MB; banner at 10 MB.
* Corrected root `workspaces` to an array and added `e2e:*` scripts.
* Text tool behavior documented as **local-only overlay** until commit; Undo/Eraser rules explicit.
* Acceptance checks aligned (strings, limits, timings).
* Added explicit **OpenAPI regex patterns** for `id` and `shareLink`; clarified **201 vs 200 (idempotent)** and **429** UI mapping for `POST /api/rooms`.
* Documented **Y.Doc `{ guid: roomId }`** construction and **viewport** semantics.
* Added **toolbar unpinned auto-hide** specifics and **device-local persistence** for `side/pinned/collapsed`.
* Added **cursor trails ring buffer = 24** and **render cap = 20**.
* Stated **stamps** are **single-stroke** and **immutable post-insert**.
* Added **Undo/Redo** labels and **Ctrl/Cmd+Z, Ctrl/Cmd+Y** keybindings.
* Added **eraser preview** and **single-undo restore**.
* Added **Delete local copy** affordance and **mint share link** on publish.

— References:      &#x20;


