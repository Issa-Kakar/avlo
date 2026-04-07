# Image System

> **Maintenance:** Architectural overview, not a changelog. Match surrounding detail level when updating — don't inflate coverage of one change at the expense of the big picture.

Offline-first image objects with content-addressed asset storage, Service Worker for app shell + asset caching, two web worker instances for parallel decode (hash, decode, upload), persistent upload queue, generation-based staleness for instant mip superseding, and viewport-driven memory management. Images render as `ImageBitmap` on the base canvas via `ctx.drawImage()`.

---

## Architecture Overview

```
Main Thread (image-manager.ts)
├── pending: Map<assetId, {gen, level}>    ← generation-based staleness
├── genCounter: number                      ← monotonic, global
│
├── decode(A) → hash(A) → workers[0]       ← consistent routing by assetId
├── decode(B) → hash(B) → workers[1]
├── ingest/upload → always workers[0]       ← primary only
│
├── workers[0].onmessage → bitmap/ingested/uploaded/unfurled/error
└── workers[1].onmessage → bitmap/error

Worker 0 (primary)                 Worker 1 (decoder)              Service Worker
┌─────────────────────────┐       ┌──────────────────────┐       ┌─────────────────────┐
│ latestGen: Map<id,gen>  │       │ latestGen: Map<id,gen>│       │ sw.ts               │
│ fetchPromises (dedup)   │       │ fetchPromises (dedup) │       │                     │
│ readAssetBlob (cache)   │       │ readAssetBlob (cache) │       │ Cache-first:        │
│ decodeAndSend           │       │ decodeAndSend         │       │  /api/assets/*      │
│ ─── primary only ───    │       │                      │       │ App shell:          │
│ ingest (hash+decode)    │       └──────────────────────┘       │  /assets/*.js/css   │
│ upload queue (IDB+PUT)  │                                       │  /fonts/*.woff2     │
│ unfurl (direct fetch)   │                                       │  HTML (net-first)   │
│ sha256Hex, validateImage│                                       └─────────────────────┘
└─────────────────────────┘
```

**Key principles:**
- **Two workers, one file.** Both instances of `image-worker.ts`. Primary handles ingest + upload + decode + bookmark unfurl; decoder handles decode only. Decode requests hash-routed by `assetId.charCodeAt(0) & 1` for consistent per-asset affinity and decode parallelism.
- **Generation-based staleness.** `pending` is `Map<assetId, {gen, level}>`. When mip level changes during zoom, a new decode supersedes the old one immediately — no waiting. Workers track `latestGen` per assetId with 3 check points (before fetch, after fetch, after decode) to discard stale work.
- **SW owns fetch/cache.** Intercepts all GET `/api/assets/*`. Cache-first for reads (immutable, content-addressed). Also caches app shell for offline.
- **Workers are self-sufficient.** `readAssetBlob()` checks Cache API directly first, then falls back to `fetch()` (SW intercepts in prod; direct to server in dev). Works with or without SW — critical for dev mode where SW isn't built.
- **Workers write to cache:** local ingest blobs and network fetch responses. One cache key per asset. Both workers share the `avlo-assets` Cache API store.
- **Dynamic mips via `createImageBitmap` resize.** No pre-generated mip blobs. Manager computes target dimensions from natural dims + mip level, worker decodes at that resolution in a single hardware-accelerated operation (`createImageBitmap(blob, { resizeWidth, resizeHeight, resizeQuality: 'medium' })`).

### Full Flow

```
User drops/pastes/picks file
   ↓
image-actions.ts: createImageFromBlob(blob, worldX, worldY)
   ├─ SVG? → rasterizeSvg(blob) → modify SVG dims (2048–4096px) → <img> + canvas → PNG blob
   ├─ image-manager.ts: ingest(blob) → sends blob to worker
   │   └─ Worker: validateImage(bytes) → SHA-256 → cache dedup → cache blob → decode → transfer bitmap
   ├─ Y.Doc mutation: create image object (kind:'image', assetId, frame, naturalDimensions)
   ├─ setActiveTool('select') + setSelection([objectId]) + invalidateOverlay()
   └─ image-manager.ts: enqueue(assetId) → Worker: IDB uploads store → PUT /api/assets/:key

Render path (synchronous, every frame):
   objects.ts → drawImage(ctx, handle)
   → getFrame(handle.y), getAssetId(handle.y)
   → getBitmap(assetId) → ImageBitmap | null
   → bitmap ready? → ctx.drawImage(bitmap, x, y, w, h) with imageSmoothingQuality:'high'
   → not ready? → gray placeholder rect (#f0f0f0 fill, #d1d5db stroke)

Remote peer adds image:
   Y.Doc sync → deep observer fires for new object
   → Next render tick: manageImageViewport() → if visible, sends 'decode' → Worker → bitmap

Viewport management (every frame in RenderLoop.tick()):
   manageImageViewport()
   → 1.25× padded viewport → spatial index query → filter kind === 'image'
   → per-image ppsp → mip level + target dimensions → decode if missing/wrong level, evict if off-viewport
   → implicit ref counting: spatial index IS the source of truth
```

---

## Cache Layout

**`avlo-assets`** — shared by SW (read/write for CDN responses) and worker (write for ingest blobs, network fallback responses).

| Cache key | Written by | Content |
|-----------|-----------|---------|
| `/api/assets/{assetId}` | SW (CDN fetch response) or worker (local ingest / network fallback) | Full-res blob, natural `Content-Type` |

**`avlo-shell-v1`** — owned by SW. JS bundles, CSS, fonts, cursors, HTML.

---

## Service Worker (`client/src/sw.ts`)

~100 lines. Separate tsconfig (`tsconfig.sw.json`) with `WebWorker` lib.

### Install + Activate

`skipWaiting()` + `clients.claim()` = SW active for fetch interception ASAP. No pre-caching on install — assets cached on-demand during first fetch. Old shell caches deleted on activate (version rotation via `avlo-shell-v1` naming). `avlo-assets` cache never deleted (immutable, content-addressed).

### Fetch Strategies

| Route | Strategy | Details |
|-------|----------|---------|
| `/parties/*`, non-GET | Passthrough | No `respondWith` — browser handles directly |
| `/api/assets/*` | Cache-first | Cache hit → serve. Miss → fetch CDN → cache on 200 → serve. Try-catch falls through to `fetch()` on cache errors |
| `/api/*` (non-asset) | Passthrough | No `respondWith` |
| `/assets/*` | Cache-first | Vite-hashed = immutable |
| `/fonts/*`, `/cursors/*` | Cache-first | Static resources |
| Navigation (HTML) | Network-first | Try network → cache on success → fallback to cached URL or `/` or 503 |

### Registration (`client/index.html`)

```html
<link rel="preload" href="/sw.js" as="script">
<script>
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js', { updateViaCache: 'all' }).catch(() => {});
  }
</script>
```

Preload + `updateViaCache: 'all'` = register uses HTTP-cached copy (no network check on every load). Inline script before module script = registration starts before app JS. Dev mode: `/sw.js` 404s harmlessly.

### Build (`client/vite.config.ts`)

SW is a second rollup entry → outputs to `/sw.js` (root, stable URL, no content hash). App bundles stay in `/assets/[name]-[hash].js`.

---

## Y.Doc Object Schema

```typescript
{
  id: string;              // ULID
  kind: 'image';
  assetId: string;         // SHA-256 hex of file content (64 chars, lowercase)
  frame: [x, y, w, h];    // World position and size (FrameTuple)
  naturalWidth: number;    // Original image pixel width
  naturalHeight: number;   // Original image pixel height
  mimeType: string;        // e.g. 'image/png', 'image/jpeg', 'image/webp', 'image/gif'
  opacity?: number;        // Optional, defaults to 1.0
  ownerId: string;
  createdAt: number;
}
```

Images use stored `frame` (like shapes), not derived frames (unlike text/code). Default placement: 400wu wide, aspect-ratio-preserving height, centered on drop/paste point.

**Content addressing:** `assetId = SHA-256(fileBytes)`. Same file dropped twice → same assetId → dedup in cache, dedup on R2 (server returns 200 exists), shared bitmap in memory. Two objects can reference the same assetId.

---

## File Map

| File | Responsibility |
|------|----------------|
| `image-actions.ts` | Entry points: `createImageFromBlob()`, `openImageFilePicker()`, SVG rasterization (`<img>` + canvas, 2048–4096px) |
| `image-manager.ts` | Thin main-thread coordinator: bitmap cache, viewport management, two-worker routing, generation tracking |
| `image-worker.ts` | Web Worker (2 instances): Cache API reads/writes, SHA-256 hashing, dynamic resize decode, upload queue (primary), staleness tracking |
| `../../sw.ts` | Service Worker: cache-first asset serving, app shell caching, offline support |

### Shared Package

| File | Responsibility |
|------|----------------|
| `packages/shared/src/utils/image-validation.ts` | `validateImage(bytes)` → `{ valid, mimeType }` for PNG/JPEG/WebP/GIF magic bytes. `isSvg(bytes)` for XML/SVG prefix detection. Used by both client worker and server. |

### Server Files

| File | Responsibility |
|------|----------------|
| `worker/src/assets.ts` | `handleUpload` (PUT) + `handleGetAsset` (GET) for `/api/assets/:key` |
| `worker/src/index.ts` | Hono app: CORS on `/api/*`, asset routes, `partyserverMiddleware()` for Yjs sync |

---

## Entry Points

Four ways to create an image:

| Trigger | Handler | Location |
|---------|---------|----------|
| Drag-drop files onto canvas | `CanvasRuntime.handleDrop()` | `runtime/CanvasRuntime.ts` |
| Clipboard paste (Cmd+V) | DOM `paste` event → `pasteImage()` or `pasteFromClipboard()` | `runtime/keyboard-manager.ts` |
| Keyboard shortcut `i` | `openImageFilePicker()` | `runtime/keyboard-manager.ts` |
| Toolbar Image button | `openImageFilePicker()` | `components/ToolPanel.tsx` |

All entry points converge to `createImageFromBlob(blob, worldX, worldY, opts?)`.

**Important:** Image is NOT a persistent tool (no `ImageTool` class). The `i` key and toolbar button open a file picker as a one-shot action.

**Paste architecture:** Cmd+V is NOT handled in keydown. Instead, a DOM `paste` event listener checks `clipboardData.files` for OS file copies (which `navigator.clipboard.read()` can't access), then falls back to `pasteFromClipboard()` for all other paste types (internal, external HTML/text, browser image copy).

---

## Data Pipeline

Three entry paths, all converge to viewport-gated decode:

| Entry | Observer/action | Worker message | Decodes? |
|-------|----------------|----------------|----------|
| **Local drop/paste** | `ingest(blob)` | `ingest` | Yes (user expects instant) |
| **Room join (hydrate)** | `hydrateImages(yMap)` | `hydrate` | Only viewport-visible |
| **Scroll/zoom** | `manageImageViewport()` | `decode` | Only viewport-visible |

**Never decode off-viewport images.** The only exception is local ingest (user just dropped/pasted it, it's at their cursor position, it IS in the viewport).

Remote images arriving via Y.Doc sync are NOT eagerly fetched. `manageImageViewport()` handles them on the next render tick if visible.

---

## Mip Level System

Per-image PPSP (Pixels Per Source Pixel): `ppsp = (frameWidth × cameraScale × dpr) / naturalWidth`

| ppsp range | Level | Bitmap size | Meaning |
|------------|-------|-------------|---------|
| ppsp > 0.5 | 0 (full) | naturalW × naturalH | Source pixels densely packed |
| 0.25 < ppsp ≤ 0.5 | 1 (half) | naturalW/2 × naturalH/2 | Half res sufficient |
| ppsp ≤ 0.25 | 2 (quarter) | naturalW/4 × naturalH/4 | Quarter res sufficient |

**Dynamic decode:** Manager computes target dimensions from `naturalWidth / divisor` and `naturalHeight / divisor` (divisor: 1/2/4 for levels 0/1/2). Worker decodes via `createImageBitmap(blob, { resizeWidth, resizeHeight, resizeQuality: 'high' })` — single hardware-accelerated operation, no pre-generated blobs. Level 0 decodes at full resolution (no resize options).

Multiple objects sharing an assetId: use MAX ppsp → highest quality level.

**During zoom transitions:** old mip bitmap stays visible until the new level arrives (no placeholder flash). One bitmap per assetId in memory at a time — old one closed when new one arrives.

---

## Main Thread State (image-manager.ts)

```typescript
const workers: [Worker, Worker] = [new Worker(...), new Worker(...)]
// workers[0] = primary (ingest + upload + decode), workers[1] = decoder only
// Hash-routed: workerFor(assetId) = workers[assetId.charCodeAt(0) & 1]

bitmaps: Map<assetId, { bitmap: ImageBitmap; level: number }>  // One bitmap per assetId
pending: Map<assetId, { gen: number; level: number }>          // In-flight decode with generation
genCounter: number                                              // Monotonic generation counter
errors:  Map<assetId, timestamp>   // Failed assets, 15s cooldown retry (cleared on success)
inflightIngests: Map<id, { resolve, reject }>  // Ingest promise tracking
_assetInfo: Map<assetId, { ppsp, nw, nh, bounds }>  // Reused per frame (cleared + repopulated each tick)
```

No `tracked` map, no `assetFrames` map. Spatial index IS the source of truth for visibility.
Ref counting is implicit: multiple objects sharing an assetId all appear in spatial index query.

### Generation-Based Mip Superseding

When zoom changes the needed mip level, a new decode request is sent immediately with a higher gen — no waiting for the old decode. Workers discard stale results via `latestGen` map.

```
Frame 1: Asset A needs level 0 → gen=1, send decode(A, gen=1, level=0)
Frame 5: Zoom out, needs level 2 → gen=2, send decode(A, gen=2, level=2)
Worker: gen=2 decode finishes first (quarter res, fast) → post bitmap
Worker: gen=1 decode finishes later → latestGen=2 ≠ 1 → bitmap.close(), skip
Main: bitmap(A, gen=2) → pending.gen=2 → accept. bitmap(A, gen=1) → gen mismatch → close.
```

### Exports

```typescript
getBitmap(assetId): ImageBitmap | null     // Synchronous render path
manageImageViewport(): void                // Called from RenderLoop.tick() every frame
ingest(blob): Promise<IngestResult>        // Local drop: validate → hash → decode → bitmap
hydrateImages(objects: Y.Map): void        // Room join: distribute decode across workers + prefetch
enqueue(assetId): void                     // Queue upload to R2
postToPrimary(msg): void                   // Forward message to primary worker (used by bookmark-unfurl)
clear(): void                              // Room teardown: close all bitmaps, notify workers
```

### Module-Level Init (runs once on import)
```typescript
workers[0].postMessage({ type: 'init', role: 'primary' })
workers[1].postMessage({ type: 'init', role: 'decoder' })
workers[0].postMessage({ type: 'drain-uploads' })
window.addEventListener('online', () => workers[0].postMessage({ type: 'online' }))
for (const w of workers) w.onmessage = handleWorkerMessage
```

No CanvasRuntime coupling for upload queue or invalidation — self-managed.

---

## Worker State (image-worker.ts)

```typescript
role: 'primary' | 'decoder'                         // Set by 'init' message
latestGen: Map<assetId, number>                      // Worker-side staleness tracking
fetchPromises: Map<assetId, Promise<Blob | null>>    // Fetch dedup (concurrent calls coalesce)
uploading: boolean                                    // Guard against concurrent drain loops (primary only)
resetBackoff: boolean                                 // Skip backoff delays on 'online' event (primary only)
```

`fetchPromises` is transient (cleared in `finally` after fetch completes). `latestGen` is cleared on `'clear'` message (room teardown), deleted per-asset on `'cancel'`. IDB is durable state for upload queue only (primary).

### readAssetBlob(assetId) — Core Read Path

Cache-first, then network. Works with or without Service Worker:
1. `caches.open('avlo-assets')` → `cache.match(url)` → cache hit → return blob
2. Cache miss → `fetch(url)` → SW intercepts in prod, direct to server in dev
3. Network response cached by worker for future reads (`cache.put()`)
4. Network error or non-OK status → return null

This makes the worker self-sufficient regardless of SW presence (critical for `vite dev` where SW isn't built). Per-worker fetch dedup — cross-worker dedup not needed since cache hits are instant.

### getAssetBlob(assetId) — Deduped Fetch

Wraps `readAssetBlob` with `fetchPromises` map for dedup. Concurrent calls for the same assetId coalesce on the same promise. Cleaned up in `finally`.

### decodeAndSend(assetId, level, width, height, gen) — Dynamic Resize Decode with Staleness

Three staleness checkpoints via `latestGen` — each `await` is a point where a cancel or superseding request could arrive:

1. `latestGen.set(assetId, max(gen, current))` — update + check before fetch → return if stale
2. `getAssetBlob(assetId)` → fetch full-res blob (deduped)
3. Check after fetch → return if stale
4. Level 0: `createImageBitmap(blob)` — full resolution. Level 1/2: `createImageBitmap(blob, { resizeWidth, resizeHeight, resizeQuality: 'medium' })` — hardware-accelerated downscale
5. Check after decode → `bitmap.close()` + return if stale
6. Transfer bitmap to main thread via `Transferable[]`

### IDB Schema

Database: `avlo-assets`, version 3.

| Store | Key | Value | Purpose |
|-------|-----|-------|---------|
| `uploads` | assetId (SHA-256 hex) | `{ retries, lastAttempt }` | Upload queue persistence |
| `unfurls` | — | — | Allocated but unused (unfurl is direct fetch, no IDB queue) |

Global across rooms (content-addressed dedup).

---

## Error Handling

| Scenario | Error source | Main thread behavior | Recovery |
|----------|-------------|---------------------|----------|
| CDN 404 (not yet uploaded) | Worker fetch | `errors.set(assetId, now)` if gen matches | Retry after 15s cooldown |
| CDN 5xx (server error) | Worker fetch | `errors.set(assetId, now)` if gen matches | Retry after 15s cooldown |
| Network error (offline) | Worker fetch | `errors.set(assetId, now)` if gen matches | Retry after 15s cooldown |
| Corrupt image (decode fails) | Worker createImageBitmap | `errors.set(assetId, now)` if gen matches | Retry after 15s cooldown |
| Stale bitmap (gen mismatch) | Worker decode | `bitmap.close()`, discard | Worker-side + main-side gen check |
| Stale error (gen mismatch) | Worker decode | Ignored — no cooldown set | Gen check prevents stale error pollution |
| Bitmap arrives after room teardown | Worker decode | `bitmap.close()`, discard | `hasActiveRoom()` guard |
| Upload 4xx (permanent) | Worker upload | Entry removed from queue | No retry |
| Upload 5xx / network error | Worker upload | Exponential backoff (1s-60s) | Retries forever (offline-first) |
| Stale bitmap after delete | Spatial index | Auto-evicted next tick | Implicit via viewport mgmt |
| Cache API unavailable | Worker cache ops | Error propagates | 15s cooldown retry |
| Asset scrolls out (eviction) | Main viewport mgmt | `cancel` to worker + `pending.delete` | Worker `latestGen.delete` → in-flight discarded |
| Room teardown | Main `clear()` | `clear` to both workers | `latestGen.clear()` → all in-flight discarded |

**Self-healing:** Errors cleared on successful bitmap receipt. If a peer uploads an asset that was previously 404, the next retry after cooldown succeeds and the error is cleared.

**Upload backoff:** `delay = min(1000 * 2^retries, 60000)`. No max retries. `online` event resets backoff and triggers immediate drain. 30s safety interval catches anything that fell through (primary worker only, started on `init`).

---

## Memory Management

### Viewport Management Flow (manageImageViewport)

Called every frame from `RenderLoop.tick()`. Reads camera store + snapshot internally.

1. Guard: `hasActiveRoom()` + snapshot + spatialIndex must exist
2. Query spatial index with 5.5× padded viewport (2.25× padding on each side) — aggressive pre-decode
3. Collect visible assetIds into reusable `_assetInfo` map: max ppsp + natural dimensions + union bounds per assetId. During active scale transforms, selected images get `ppsp = Infinity` (forces full-res decode for crisp preview). **Bookmarks** contribute `ogImageAssetId` + `faviconAssetId` with `ppsp = Infinity` (always full-res, no mip levels).
4. **Decode:** For each visible asset not in error cooldown: compute target dimensions from natural dims + level divisor. Send decode if no bitmap or worse quality (`cached.level > neededLevel` — never downgrades, higher-quality bitmaps stay until eviction), AND no pending request for that level. If pending exists but for different level (mip change during zoom), supersede with new gen.
5. **Evict:** Close bitmaps for assetIds not in `_assetInfo`. Send `cancel` to assigned worker for in-flight decodes. `pending.delete()` for fresh request on scroll-back.
6. **Placeholders:** `repositionAllPlaceholders()` — reposition bookmark HTML loading placeholders to follow camera.

### Hydration (hydrateImages)

Called once from `room-doc-manager.ts:hydrateObjectsFromY()` on room join.

1. Traverse Y.Map for all image and bookmark objects → collect `{ assetId, frame, nw, nh }` per asset. Bookmarks contribute `ogImageAssetId` + `faviconAssetId` at level 0.
2. Compute ppsp per asset from current camera state → mip level, deduped by assetId (min level = highest quality)
3. Manager splits visible (exact viewport, no padding) vs offscreen using `frameTupleIntersectsBounds`
4. Group items by worker via hash routing (`assetId.charCodeAt(0) & 1`)
5. Assign gen per visible item, pre-add to `pending` (prevents duplicate decode on first `manageImageViewport` tick)
6. Send `'hydrate'` message to each worker with its assigned items
7. Each worker handles:
   - **Visible (fire-and-forget):** `decodeAndSend` per item — results stream as each decode completes (no batching, no concurrency limiting)
   - **Prefetch (fire-and-forget):** `getAssetBlob` — cache-warm for scroll-in

### Bitmap Invalidation

On `'bitmap'` message from worker: O(1) lookup via `_assetInfo` pre-computed union bounds. **Gated on actual visible viewport** — off-viewport bitmaps (decoded via aggressive padding) sit silently in `bitmaps` map, no dirty rect, no render work. Only assets intersecting the visible world bounds trigger `invalidateWorld`. This prevents the padded decode window from causing stutter via unnecessary dirty rect cascades. Fallback (hydration, before first tick): iterate `objectsById` with inline bbox intersection — checks both `image` and `bookmark` kinds (bookmarks via `ogImageAssetId`/`faviconAssetId`).

On `'ingested'` message: same targeted invalidation. The ingest resolve also triggers Y.Doc mutation → observer → snapshot update → render anyway, but the invalidation ensures the bitmap renders on the same frame.

---

## Worker Message Protocol

Main → Worker:
```typescript
| { type: 'init', role: 'primary' | 'decoder' }
| { type: 'ingest', id: string, blob: Blob }                                          // primary only
| { type: 'hydrate', visible: { assetId, level, width, height, gen }[], prefetch: string[] }
| { type: 'decode', assetId: string, level: 0 | 1 | 2, width, height, gen: number }
| { type: 'enqueue-upload', assetId: string }                                          // primary only
| { type: 'unfurl', objectId: string, url: string }                                   // primary only
| { type: 'delete-asset', assetId: string }                                            // primary only
| { type: 'online' }                                                                   // primary only
| { type: 'drain-uploads' }                                                            // primary only
| { type: 'cancel', assetId: string }                 // eviction: invalidate in-flight decode
| { type: 'clear' }                                   // room teardown: invalidate all in-flight
```

Worker → Main:
```typescript
| { type: 'ingested', id, assetId, w, h, mime, bitmap: ImageBitmap, level: 0 }
| { type: 'bitmap', assetId, bitmap: ImageBitmap, level: 0 | 1 | 2, gen: number }
| { type: 'uploaded', assetId }
| { type: 'unfurled', objectId, data: { title?, description?, ogImageAssetId?, ogImageWidth?, ogImageHeight?, faviconAssetId? } }
| { type: 'unfurl-failed', objectId, permanent: boolean }
| { type: 'error', id?, assetId?, message: string, gen?: number }
```

All bitmaps transferred via `Transferable[]` (zero-copy). Bitmap is neutered in the worker after transfer. `gen` enables main thread staleness check on receipt.

**Unfurl routing:** `'unfurled'` → `handleUnfurlResult()`, `'unfurl-failed'` → `handleUnfurlFailed()` (both from `bookmark-unfurl.ts`). Worker's `unfurlDirect()` does a single direct fetch to `/api/unfurl?url=<encoded>`, strips `url`/`domain` from server response, posts result back. No IDB queue — offline pastes never enter the bookmark pipeline.

---

## Server-Side Architecture

### Hono App (`worker/src/index.ts`)

```typescript
const app = new Hono<{ Bindings: Env }>();
app.use('/api/*', cors({
  origin: (origin) => {
    if (!origin) return null;
    if (origin.startsWith('http://localhost:')) return origin;
    if (origin === 'https://avlo.io') return origin;
    return null;
  },
  allowMethods: ['GET', 'PUT', 'OPTIONS'],
  maxAge: 86400,
}));
app.put('/api/assets/:key', handleUpload);
app.get('/api/assets/:key', handleGetAsset);
app.get('/api/unfurl', zValidator('query', unfurlQuery), handleUnfurl);  // Zod-validated bookmark unfurl
app.use('*', partyserverMiddleware());  // Yjs WebSocket sync via PartyServer
```

**Env bindings:** `ASSETS: R2Bucket`, `DOCS: R2Bucket`, `rooms: DurableObjectNamespace`

### Upload Route — `PUT /api/assets/:key` (`worker/src/assets.ts`)

Validation pipeline (all checks before R2 write):
1. **Origin check** → 403 if not `localhost:*` or `avlo.io`
2. **R2 dedup** → `ASSETS.head(key)` → 200 `{ status: 'exists' }` if already stored (body not read)
3. **Size limit** → 10 MB max → 413 `Payload Too Large`
4. **Magic byte validation** → `validateImage(bytes)` → 400 if unsupported format
5. **Hash verification** → `SHA-256(body)` must equal URL `:key` → 400 `key mismatch`
6. **R2 put** → `ASSETS.put(key, buffer, { httpMetadata: { contentType } })` → 201 Created

Response codes: 201 (created), 200 (exists), 400 (bad format / hash mismatch), 403 (CORS), 413 (too large)

### Fetch Route — `GET /api/assets/:key` (`worker/src/assets.ts`)

Edge-cached R2 proxy with full HTTP semantics:
1. **Edge cache check** → `caches.default.match(cacheKey)` → return if hit
2. **R2 fetch** → `ASSETS.get(key, { range: headers, onlyIf: headers })` → R2 handles Range + conditional natively
3. **Response headers:**
   - `Cache-Control: public, max-age=31536000, immutable` (1 year, immutable — content-addressed)
   - `ETag` from R2 (`object.httpEtag`)
   - `Content-Type` from stored `httpMetadata` (set at upload)
   - `Content-Security-Policy: default-src 'none'` (security)
   - `X-Content-Type-Options: nosniff`
   - `Content-Range` for 206 partial responses
4. **Edge cache populate** → `waitUntil(cache.put())` on 200 (not on 206/304)
5. **Body streaming** → `body.tee()` for simultaneous cache write + response

Response codes: 200 (full), 206 (range), 304 (conditional / If-None-Match), 404 (not found)

### Unfurl Route — `GET /api/unfurl?url=<encoded>` (`worker/src/unfurl.ts`)

Zod middleware (`zValidator('query', unfurlQuery)`) validates + normalizes URL + SSRF guard before handler. Fetches page, extracts OG/Twitter metadata via HTMLRewriter, stores OG image + favicon to R2 (content-addressed), returns JSON. Direct image URLs stored as OG image with filename as title. Edge-cached 7 days by SHA-256 of normalized URL. Called by image worker's `unfurlDirect()`.

Response codes: 200 (success, has title or OG image), 204 (no useful metadata), 400 (invalid URL / SSRF), 502 (upstream fetch failed)

Detailed docs: `core/bookmark/CLAUDE.md`

### R2 Buckets (`wrangler.toml`)

| Binding | Bucket Name | Purpose |
|---------|-------------|---------|
| `ASSETS` | `avlo-assets` | Image blobs (content-addressed, immutable) |
| `DOCS` | `avlo-docs` | Y.Doc V2 snapshots (rooms) |

### Dev Proxy (`client/vite.config.ts`)

```
/api/*     → http://localhost:8787  (Hono routes)
/parties/* → ws://localhost:8787    (PartyServer WebSocket)
```

Client port: 3000 (`VITE_PORT`). Worker port: 8787 (`WORKER_PORT`).

**Testing SW:** `npm run -w client build && npm run -w client preview` (preview has same proxy config). Dev mode doesn't build SW — worker's `readAssetBlob()` handles this transparently.

---

## Rendering

### Base Canvas (`renderer/layers/objects.ts`)

`drawImage(ctx, handle)`:
- Reads `getFrame(handle.y)` → `[x, y, w, h]`
- Reads `getAssetId(handle.y)` → SHA-256 hex string
- `getBitmap(assetId)` → synchronous `Map.get()`
- Bitmap ready → `ctx.save()`, `ctx.globalAlpha = opacity`, `ctx.imageSmoothingEnabled = true`, `ctx.imageSmoothingQuality = 'high'`, `ctx.drawImage(bitmap, x, y, w, h)`, `ctx.restore()`
- Not ready → gray placeholder rect (`#f0f0f0` fill, `#d1d5db` stroke, 1px line width)

### Scale Transform Rendering

Images always uniform-scale (aspect ratio preserved). Mixed + side handles → edge-pin translate. Full transform behavior matrix in `tools/selection/CLAUDE.md`.

Commit updates Y.Doc `frame` — bitmap stays, ppsp recalculates next tick for mip adjustment.

### Object Cache (`renderer/object-cache.ts`)

Images return an empty `new Path2D()` — they don't use the geometry cache. Cache eviction for images is a no-op.

---

## Hit Testing & Selection

- **Point hit test:** Simple rect containment — images are always filled/opaque (no interior-transparent check)
- **Marquee:** Rect intersection against frame
- **Eraser:** Circle-rect intersection, interior hits count (same as shapes with fill)
- **Selection kind:** `'imagesOnly'` supported. `computeStyles()` returns `EMPTY_STYLES` for images (no color/width/fill controls)
- **Connector topology:** Images included — connectors can snap to image frames. `transformFrameForTopology()` has per-kind dispatch for images (always uniform, mixed+side = edge-pin).

---

## CanvasRuntime Integration

| Hook | Location | What |
|------|----------|------|
| `clearImageManager()` | `stop()` | Room teardown: close bitmaps, clear all state |
| `handleDrop(e)` | Drop event | Filter `image/*` + `.svg` files → `createImageFromBlob()` per file |

Upload queue and bitmap invalidation are self-managed:
- Upload queue: module-level `online` listener + `drain-uploads` on import
- Bitmap invalidation: `worker.onmessage` handler queries spatial index and calls `invalidateWorld()` directly

### Clipboard Integration (`clipboard-actions.ts`)

After `pasteInternal()` creates image objects via Y.Doc mutation:
- `enqueue(assetId)` — ensures pasted images are uploaded (idempotent: server returns 200 if exists)
- No eager fetch needed — `manageImageViewport()` handles decode on next render tick

---

## Accessors (`packages/shared/src/accessors/object-accessors.ts`)

```typescript
getAssetId(y: Y.Map) → string | null           // SHA-256 hex
getNaturalDimensions(y: Y.Map) → [w, h] | null // Original pixel dimensions
getImageProps(y: Y.Map) → ImageProps | null     // { assetId, frame, naturalWidth, naturalHeight, mimeType }
```

---

## Validation (`packages/shared/src/utils/image-validation.ts`)

Used by both client worker (ingest) and server (upload). Shared package ensures consistency.

```typescript
validateImage(bytes: Uint8Array): { valid: boolean; mimeType: string }
```

| Format | Magic Bytes | mimeType |
|--------|-------------|----------|
| PNG | `89 50 4E 47` | `image/png` |
| JPEG | `FF D8 FF` | `image/jpeg` |
| WebP | `52 49 46 46 .... 57 45 42 50` | `image/webp` |
| GIF | `47 49 46 38` | `image/gif` |

Minimum 12 bytes required. Returns `{ valid: false, mimeType: '' }` for unrecognized formats.

```typescript
isSvg(bytes: Uint8Array): boolean
```
Checks first 256 bytes for `<?xml` or `<svg` prefix (after optional UTF-8 BOM). Used for MIME-less file drops.

---

## Known Issues & Missing Features

### Client-Side
- No aspect-ratio-locked resize (images should maintain aspect ratio by default)
- No image-specific context menu controls (crop, replace, opacity slider)
- Multiple images dropped/picked at same position stack on top of each other (no offset)
- No loading state indicator beyond the gray placeholder rect
- No error state UI (failed decode / failed upload)

### Server-Side
- No authentication on upload endpoint (anyone can upload)
- No image dimension limits (only 10 MB file size limit)

### SelectTool Integration
- No rotation support
- No double-click behavior defined for images
