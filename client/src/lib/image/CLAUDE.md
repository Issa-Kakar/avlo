# Image System

> **Maintenance:** Architectural overview, not a changelog. Match surrounding detail level when updating — don't inflate coverage of one change at the expense of the big picture.

Offline-first image objects with content-addressed asset storage, Service Worker for app shell + asset caching, dedicated web worker for compute (hash, decode, mip generation, upload), persistent upload queue, and viewport-driven memory management. Images render as `ImageBitmap` on the base canvas via `ctx.drawImage()`.

---

## Architecture Overview

```
Main Thread                   Image Worker                    Service Worker
┌────────────────┐           ┌──────────────────────────┐    ┌─────────────────────┐
│ image-manager  │──msg────►│ image-worker.ts          │    │ sw.ts               │
│                │◄─bitmap──│                          │    │                     │
│ getBitmap()    │           │ Reads: cache → fetch  ──────►│ Cache-first:        │
│ manageVP()     │           │   (readAssetBlob)       │    │  /api/assets/*      │
│ ingest()       │           │                          │    │                     │
│ hydrateImages()│           │ Writes: cache.put()     │    │ Mip URLs (?mip=*):  │
│ enqueue()      │           │   full blob + mip blobs │    │  Cache-only, 404    │
│                │           │                          │    │  on miss (synthetic)│
│                │           │ Compute:                 │    │                     │
│                │           │   SHA-256, validate      │    │ App shell:          │
│                │           │   createImageBitmap      │    │  /assets/*.js/css   │
│                │           │   OffscreenCanvas (mips) │    │  /fonts/*.woff2     │
│                │           │                          │    │  HTML (net-first)   │
│                │           │ IDB: upload queue only   │    │  /cursors/*.cur     │
│                │           │   { retries, lastAttempt }│    │                     │
│                │           │                          │    │ Passthrough:        │
│                │           │                          │    │  PUT /api/assets/*  │
│                │           │                          │    │  /parties/*         │
│                │           │                          │    │  /api/* (non-asset) │
└────────────────┘           └──────────────────────────┘    └─────────────────────┘
```

**Key principles:**
- **SW owns fetch/cache.** Intercepts all GET `/api/assets/*`. Cache-first for reads (immutable, content-addressed). Mip URLs (`?mip=*`) are cache-only — never fetched from network (synthetic, written by worker). Also caches app shell for offline.
- **Worker is self-sufficient.** `readAssetBlob()` checks Cache API directly first, then falls back to `fetch()` (SW intercepts in prod; direct to server in dev). Works with or without SW — critical for dev mode where SW isn't built.
- **Worker writes to cache:** local ingest blobs, generated mip blobs, and network fetch responses. Three cache keys per asset: full blob + half mip + quarter mip.
- **Mips are pre-generated and cached.** `generateMips()` uses OffscreenCanvas to downscale (2-step: full→half→quarter), then caches the blobs. Decode reads the pre-generated mip blob from cache (fallback to full-res if unavailable).

### Full Flow

```
User drops/pastes/picks file
   ↓
image-actions.ts: createImageFromBlob(blob, worldX, worldY)
   ├─ SVG? → rasterizeSvg(blob) → PNG blob (OffscreenCanvas, max 4096px)
   ├─ image-manager.ts: ingest(blob) → sends blob to worker
   │   └─ Worker: validateImage(bytes) → SHA-256 → cache dedup → generateMips → cache all → decode → transfer bitmap
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
   → 1.5× padded viewport → spatial index query → filter kind === 'image'
   → per-image ppsp → mip level → decode if missing/wrong level, evict if off-viewport
   → implicit ref counting: spatial index IS the source of truth
```

---

## Cache Layout

**`avlo-assets`** — shared by SW (read/write for CDN responses) and worker (write for ingest blobs, mip blobs, network fallback responses).

| Cache key | Written by | Content |
|-----------|-----------|---------|
| `/api/assets/{assetId}` | SW (CDN fetch response) or worker (local ingest / network fallback) | Full-res blob, natural `Content-Type` |
| `/api/assets/{assetId}?mip=half` | Worker (`generateMips`) | Half-res blob (w/2 × h/2). Only for source ≥ 512px wide |
| `/api/assets/{assetId}?mip=quarter` | Worker (`generateMips`) | Quarter-res blob (w/4 × h/4). Only for source ≥ 1024px wide |

**`avlo-shell-v1`** — owned by SW. JS bundles, CSS, fonts, cursors, HTML.

Mip blobs are synthetic (server never sees them). SW returns 404 on mip cache miss — worker falls back through the mip chain to full-res.

---

## Service Worker (`client/src/sw.ts`)

~120 lines. Separate tsconfig (`tsconfig.sw.json`) with `WebWorker` lib.

### Install + Activate

`skipWaiting()` + `clients.claim()` = SW active for fetch interception ASAP. No pre-caching on install — assets cached on-demand during first fetch. Old shell caches deleted on activate (version rotation via `avlo-shell-v1` naming). `avlo-assets` cache never deleted (immutable, content-addressed).

### Fetch Strategies

| Route | Strategy | Details |
|-------|----------|---------|
| `/parties/*`, non-GET | Passthrough | No `respondWith` — browser handles directly |
| `/api/assets/*?mip=*` | Cache-only | Cache hit → serve. Miss → 404 (mips are synthetic, never on network) |
| `/api/assets/*` (no mip) | Cache-first | Cache hit → serve. Miss → fetch CDN → cache on 200 → serve. Try-catch falls through to `fetch()` on cache errors |
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
| `image-actions.ts` | Entry points: `createImageFromBlob()`, `openImageFilePicker()`, SVG rasterization |
| `image-manager.ts` | Thin main-thread coordinator: bitmap cache, viewport management, worker message passing |
| `image-worker.ts` | Web Worker: Cache API reads/writes, SHA-256 hashing, OffscreenCanvas mip generation, upload queue, decode |
| `../../sw.ts` | Service Worker: cache-first asset serving, mip-aware routing, app shell caching, offline support |

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
| Drag-drop files onto canvas | `CanvasRuntime.handleDrop()` | `canvas/CanvasRuntime.ts` |
| Clipboard paste (Cmd+V) | DOM `paste` event → `pasteImage()` or `pasteFromClipboard()` | `canvas/keyboard-manager.ts` |
| Keyboard shortcut `i` | `openImageFilePicker()` | `canvas/keyboard-manager.ts` |
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

**Cached mips:** `generateMips()` runs in the worker via OffscreenCanvas. Two-step downscale (full→half, half→quarter) for quality. Blobs cached at `?mip=half` and `?mip=quarter` URLs. Size thresholds: half only for source ≥ 512px wide, quarter only for ≥ 1024px. Output MIME matches input (JPEG→JPEG, PNG→PNG, WebP→WebP, GIF→PNG fallback). Non-fatal: partial mips returned on failure.

**Decode with fallback chain:** Worker reads the pre-generated mip blob from cache for the requested level. Fallback: quarter miss → try half → try full-res. This means images always render even if mip generation failed.

Multiple objects sharing an assetId: use MAX ppsp → highest quality level.

**During zoom transitions:** old mip bitmap stays visible until the new level arrives (no placeholder flash). One bitmap per assetId in memory at a time — old one closed when new one arrives.

---

## Main Thread State (image-manager.ts)

```typescript
const worker = new Worker(new URL('./image-worker.ts', import.meta.url), { type: 'module' })

bitmaps: Map<assetId, { bitmap: ImageBitmap; level: number }>  // One bitmap per assetId
pending: Set<assetId>              // In-flight decode requests (dedup)
errors:  Map<assetId, timestamp>   // Failed assets, 15s cooldown retry (cleared on success)
inflightIngests: Map<id, { resolve, reject }>  // Ingest promise tracking
```

No `tracked` map, no `assetFrames` map. Spatial index IS the source of truth for visibility.
Ref counting is implicit: multiple objects sharing an assetId all appear in spatial index query.

### Exports

```typescript
getBitmap(assetId): ImageBitmap | null     // Synchronous render path
manageImageViewport(): void                // Called from RenderLoop.tick() every frame
ingest(blob): Promise<IngestResult>        // Local drop: validate → hash → decode → bitmap
hydrateImages(objects: Y.Map): void        // Room join: batch ensure + decode visible
enqueue(assetId): void                     // Queue upload to R2
clear(): void                              // Room teardown: close all bitmaps
```

### Module-Level Init (runs once on import)
```typescript
window.addEventListener('online', () => worker.postMessage({ type: 'online' }))
worker.postMessage({ type: 'drain-uploads' })  // Resume uploads from prior sessions
```

No CanvasRuntime coupling for upload queue or invalidation — self-managed.

---

## Worker State (image-worker.ts)

```typescript
ensurePromises: Map<assetId, Promise<void>>  // Fetch dedup (concurrent calls coalesce)
mipsAttempted: Set<assetId>                   // Fast sync skip: already fetched + mips generated this session
uploading: boolean                            // Guard against concurrent drain loops
resetBackoff: boolean                         // Skip backoff delays on 'online' event
```

Per-asset fetch state is transient (cleared in `finally` after `ensureFetched` completes). `mipsAttempted` persists for worker lifetime (content-addressed = immutable). IDB is durable state for upload queue only.

### readAssetBlob(assetId) — Core Read Path

Cache-first, then network. Works with or without Service Worker:
1. `caches.open('avlo-assets')` → `cache.match(url)` → cache hit → return blob
2. Cache miss → `fetch(url)` → SW intercepts in prod, direct to server in dev
3. Network response cached by worker for future reads (`cache.put()`)
4. Network error or non-OK status → return null

This makes the worker self-sufficient regardless of SW presence (critical for `vite dev` where SW isn't built).

### ensureFetched(assetId) — Prefetch + Mip Generation

Deduped via `ensurePromises` map (concurrent calls coalesce on same promise). Session-tracked via `mipsAttempted` set.

1. If `mipsAttempted.has(assetId)` → return immediately (already done this session)
2. If another call in-flight → await existing promise (coalesce)
3. Check cache for existing mip → if present, mark done and return
4. `readAssetBlob(assetId)` → fetch full-res blob (cache-first)
5. Decode to `ImageBitmap` via `createImageBitmap(blob)`
6. `generateMips(bitmap, mime)` → OffscreenCanvas downscale → `{ half?: Blob, quarter?: Blob }`
7. Cache mip blobs at `?mip=half` and `?mip=quarter` URLs
8. Close bitmap, mark `mipsAttempted`
9. `finally`: delete from `ensurePromises` (allow fresh attempt if errored)

### IDB Schema

Database: `avlo-assets`, version 2. Single object store:

| Store | Key | Value | Purpose |
|-------|-----|-------|---------|
| `uploads` | assetId (SHA-256 hex) | `{ retries, lastAttempt }` | Upload queue persistence |

Global across rooms (content-addressed dedup).

---

## Error Handling

| Scenario | Error source | Main thread behavior | Recovery |
|----------|-------------|---------------------|----------|
| CDN 404 (not yet uploaded) | Worker fetch | `errors.set(assetId, now)` | Retry after 15s cooldown |
| CDN 5xx (server error) | Worker fetch | `errors.set(assetId, now)` | Retry after 15s cooldown |
| Network error (offline) | Worker fetch | `errors.set(assetId, now)` | Retry after 15s cooldown |
| Corrupt image (decode fails) | Worker createImageBitmap | `errors.set(assetId, now)` | Retry after 15s cooldown |
| Bitmap arrives after room teardown | Worker decode | `bitmap.close()`, discard | `hasActiveRoom()` guard |
| Upload 4xx (permanent) | Worker upload | Entry removed from queue | No retry |
| Upload 5xx / network error | Worker upload | Exponential backoff (1s-60s) | Retries forever (offline-first) |
| Stale bitmap after delete | Spatial index | Auto-evicted next tick | Implicit via viewport mgmt |
| Cache API unavailable | Worker cache ops | Error propagates | 15s cooldown retry |
| Mip generation fails | Worker OffscreenCanvas | Non-fatal, partial mips | Decode falls back through chain |

**Self-healing:** Errors cleared on successful bitmap receipt. If a peer uploads an asset that was previously 404, the next retry after cooldown succeeds and the error is cleared.

**Upload backoff:** `delay = min(1000 * 2^retries, 60000)`. No max retries. `online` event resets backoff and triggers immediate drain. 30s safety interval catches anything that fell through.

---

## Memory Management

### Viewport Management Flow (manageImageViewport)

Called every frame from `RenderLoop.tick()`. Reads camera store + snapshot internally.

1. Guard: `hasActiveRoom()` + snapshot + spatialIndex must exist
2. Query spatial index with 1.5× padded viewport (0.25× padding on each side)
3. Collect visible assetIds + compute max ppsp per assetId → needed mip level
4. **Decode:** For each visible asset not in error cooldown: request decode if no bitmap or wrong mip level. Dedup via `pending` set.
5. **Evict:** Close bitmaps for assetIds not in visible set. Also `pending.delete()` to allow fresh request on scroll-back.

### Hydration (hydrateImages)

Called once from `room-doc-manager.ts:hydrateObjectsFromY()` on room join.

1. Traverse Y.Map for all image objects → collect `{ assetId, frame }` per object
2. Compute ppsp per asset from current camera state → mip level, deduped by assetId (min level = highest quality)
3. Pre-add visible assetIds to `pending` (prevents duplicate decode on first `manageImageViewport` tick)
4. Send single `'hydrate'` message to worker with all assets + padded viewport bounds
5. Worker separates visible vs offscreen by frame-viewport intersection:
   - **Visible (6 concurrent):** `ensureFetched` + `decodeAndSend` — full decode pipeline
   - **Offscreen (4 concurrent, fire-and-forget):** `ensureFetched` only — cache-warm for scroll-in
   - Work-stealing concurrency: N workers pull items from shared index

### Bitmap Invalidation

On `'bitmap'` message from worker: query spatial index (padded viewport) for image entries, find objects with matching assetId, call `invalidateWorld(bbox)` for each. Targeted — not `invalidateAll()`.

On `'ingested'` message: same targeted invalidation. The ingest resolve also triggers Y.Doc mutation → observer → snapshot update → render anyway, but the invalidation ensures the bitmap renders on the same frame.

---

## Worker Message Protocol

Main → Worker:
```typescript
| { type: 'ingest', id: string, blob: Blob }
| { type: 'hydrate', assets: { assetId, frame, level }[], viewport: WorldBounds }
| { type: 'decode', assetId: string, level: 0 | 1 | 2 }
| { type: 'enqueue-upload', assetId: string }
| { type: 'delete-asset', assetId: string }
| { type: 'online' }
| { type: 'drain-uploads' }
```

Worker → Main:
```typescript
| { type: 'ingested', id, assetId, w, h, mime, bitmap: ImageBitmap, level: 0 }
| { type: 'bitmap', assetId, bitmap: ImageBitmap, level: 0 | 1 | 2 }
| { type: 'uploaded', assetId }
| { type: 'error', id?, assetId?, message: string }
```

All bitmaps transferred via `Transferable[]` (zero-copy). Bitmap is neutered in the worker after transfer.

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

During selection scale transforms, images use `applyTransformToFrame()` / `applyUniformScaleToFrame()` to compute the transformed frame, then draw the existing bitmap at the new frame dimensions. Scale commits update the Y.Doc frame — the bitmap stays the same (ppsp recalculates on next tick for mip adjustment).

### Object Cache (`renderer/object-cache.ts`)

Images return an empty `new Path2D()` — they don't use the geometry cache. Cache eviction for images is a no-op.

---

## Hit Testing & Selection

- **Point hit test:** Simple rect containment — images are always filled/opaque (no interior-transparent check)
- **Marquee:** Rect intersection against frame
- **Eraser:** Circle-rect intersection, interior hits count (same as shapes with fill)
- **Selection kind:** `'imagesOnly'` supported. `computeStyles()` returns `EMPTY_STYLES` for images (no color/width/fill controls)
- **Connector topology:** Images included — connectors can snap to image frames
- **Transform behavior:** Translate works. Scale renders preview via transformed frame. No rotation.

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
- Image scale commit not fully implemented (needs frame update on pointer up)
- No rotation support
- No double-click behavior defined for images

### Planned
- **Dynamic mips:** Replace cached OffscreenCanvas mip blobs with `createImageBitmap(blob, { resizeWidth, resizeHeight, resizeQuality: 'high' })`. Decode directly at target resolution in a single hardware-accelerated operation — no pre-generated blobs needed. Saves ~30% cache storage per asset with minimal decode overhead (~20ms per transition). Eliminates `generateMips()`, `ensureFetched()` mip path, and `?mip=*` cache keys/SW routing entirely.
