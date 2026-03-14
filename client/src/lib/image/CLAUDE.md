# Image System

Offline-first image objects with content-addressed asset storage, IndexedDB caching, off-thread decoding, persistent upload queue, and viewport-driven memory management. Images render as `ImageBitmap` on the base canvas via `ctx.drawImage()`.

---

## Architecture Overview

```
User drops/pastes/picks file
   ↓
image-actions.ts: createImageFromBlob(blob, worldX, worldY)
   ├─ SVG? → rasterizeSvg(blob) → PNG blob
   ├─ image-manager.ts: ingest(blob)
   │   ├─ validateImage(bytes) → fail-fast on unsupported format
   │   ├─ SHA-256 hash → assetId (content-addressed)
   │   ├─ putBlob(assetId, blob) → IndexedDB `blobs` store
   │   └─ image-decode-worker.ts: createImageBitmap(blob) → ImageBitmap in memory cache
   ├─ Y.Doc mutation: create image object (kind:'image', assetId, frame, naturalDimensions)
   ├─ Select + switch to select tool
   └─ image-manager.ts: enqueue(assetId) → IDB `uploads` store → PUT /api/assets/:key

Render path (synchronous):
   objects.ts → drawImage(ctx, handle) → getBitmap(assetId) → ctx.drawImage(bitmap, ...)
   Bitmap not ready? → gray placeholder rect

Remote peer joins:
   Y.Doc sync → new image object arrives
   room-doc-manager.ts observer → requestImageLoad(assetId)
   image-manager.ts: IDB check → CDN fetch → worker decode → invalidateAll()

Viewport eviction (~every 30 frames, in RenderLoop.tick()):
   padded viewport (3×3 = 9 viewports) → query spatial index → collect assetIds
   evictDistant(visibleAssetIds) → close off-viewport bitmaps (GPU memory freed)
   ensureLoaded(visibleAssetIds) → re-decode from IDB for evicted images scrolled back into view
```

---

## Y.Doc Object Schema

```typescript
{
  id: string;              // ULID
  kind: 'image';
  assetId: string;         // SHA-256 hex of file content (64 chars)
  frame: [x, y, w, h];    // World position and size (FrameTuple)
  naturalWidth: number;    // Original image pixel width
  naturalHeight: number;   // Original image pixel height
  mimeType: string;        // e.g. 'image/png', 'image/jpeg'
  opacity?: number;        // Optional, defaults to 1.0
  ownerId: string;
  createdAt: number;
}
```

Images use stored `frame` (like shapes), not derived frames (unlike text/code). Default placement: 400wu wide, aspect-ratio-preserving height, centered on drop/paste point.

---

## File Map

| File | Responsibility |
|------|----------------|
| `image-actions.ts` | Entry points: `createImageFromBlob()`, `openImageFilePicker()`, SVG rasterization |
| `image-manager.ts` | Consolidated singleton: IDB layer, decode worker, bitmap cache, upload queue, `getBitmap()` |
| `image-decode-worker.ts` | Web Worker: blob → `createImageBitmap()` off main thread |

### Shared Package

| File | Responsibility |
|------|----------------|
| `packages/shared/src/utils/image-validation.ts` | `validateImage()` (magic bytes: PNG/JPEG/WebP/GIF), `isSvg()` (XML/SVG prefix detection) |

### Worker (Server) Files

| File | Responsibility |
|------|----------------|
| `worker/src/assets.ts` | `PUT /api/assets/:key` (raw binary upload, hash verification, R2 put) + `GET /api/assets/:key` (edge-cached R2 proxy) |
| `worker/src/index.ts` | Hono app: CORS middleware on `/api/*`, asset routes, `partyserverMiddleware()` (Yjs sync) |

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

## Asset Lifecycle

### 1. Ingest (`image-manager.ts: ingest`)

```
Blob → ArrayBuffer → validateImage(bytes) → fail-fast if unsupported
  → SHA-256 hash → assetId (hex string)
  → Dedup check: memory cache hit? Return immediately
  → putBlob(assetId, blob) → IndexedDB (idempotent)
  → decodeBlob(blob) → Worker → ImageBitmap
  → Memory cache: { status: 'ready', bitmap, fetchPromise: null }
  → Return { assetId, naturalWidth, naturalHeight, mimeType }
```

### 2. Y.Doc Mutation (`image-actions.ts: createImageFromBlob`)

```
SVG? → rasterizeSvg(blob) → PNG blob (parse viewBox/dimensions, draw to canvas, export PNG)
ingest() result → compute frame (400wu wide, preserve aspect ratio)
  → getActiveRoomDoc().mutate() → Y.Map with all fields
  → setActiveTool('select') + setSelection([objectId])
  → enqueue(assetId) → upload queue
```

### 3. Upload (`image-manager.ts: upload queue`)

```
enqueue(assetId) → putUploadEntry(assetId, { status: 'pending' })
  → processQueue() → one-at-a-time drain
  → getBlob(assetId) from IDB → PUT /api/assets/<assetId> (raw binary body)
  → 200 Already Exists or 201 Created → removeUploadEntry()
  → On failure: exponential backoff (1s base, 60s cap), no max retries (offline-first)
  → On reconnect (online event): resetBackoff flag → immediate retry of failed uploads
  → startUploadQueue(): registers window.online listener + 30s safety interval + immediate drain
  → Cleanup function returned for CanvasRuntime.stop() teardown
```

### 4. Remote Load (`image-manager.ts: requestLoad / loadPipeline`)

```
room-doc-manager observer → requestImageLoad(assetId)
  → loadPipeline(assetId, entry):
      1. Check IDB → blob found? Skip fetch
      2. fetch(assetsBaseUrl/assetId) → blob → putBlob to IDB
      3. decodeBlob(blob) → Worker → ImageBitmap
      4. onBitmapReady(assetId) → CanvasRuntime.invalidateAll()
```

### 5. Room Hydration (`room-doc-manager.ts`)

On full rebuild (`hydrateObjectsFromY`), collects all `assetId`s from image objects and calls `prefetchBatch(assetIds)`.

### 6. Internal Copy/Paste (`clipboard-actions.ts`)

After `pasteInternal()` Y.Doc mutation, image objects trigger `requestLoad()` + `enqueue()` to ensure bitmap is loaded and asset is uploaded (both idempotent).

---

## Memory Management

### Bitmap Cache (`image-manager.ts`)

- `assets: Map<assetId, AssetEntry>` — in-memory bitmap cache
- `getBitmap(assetId)` — synchronous, returns `ImageBitmap | null` (render-path fast path)
- `evictDistant(visibleAssetIds)` — closes bitmaps outside padded viewport, sets status to `'pending'`
- `ensureLoaded(assetIds)` — triggers IDB→decode for `'pending'` entries re-entering viewport
- `clear()` — room teardown: close all bitmaps, clear all maps

### Viewport-Driven Eviction (`RenderLoop.ts`)

Runs every ~30 frames (~0.5s at 60fps) in `tick()` after the translucency check:
1. Expand visible bounds by 1× viewport on each side (3×3 = 9 viewports padded region)
2. Query spatial index → collect `assetId` set for nearby images
3. `evictDistant(visibleAssetIds)` — close bitmaps more than 1 screen away
4. `ensureLoaded(visibleAssetIds)` — re-decode evicted images that scrolled back in

### Decode Worker

- Single `Worker` instance, lazily created, never terminated (stays warm)
- Message-based request/response with string IDs
- `createImageBitmap()` runs off main thread
- Bitmap transferred via `Transferable[]` (zero-copy to main thread)

### IndexedDB (`image-manager.ts` — internal)

Database: `avlo-assets`, version 1. Two object stores:

| Store | Key | Value | Purpose |
|-------|-----|-------|---------|
| `blobs` | assetId (SHA-256 hex) | `{ blob, mimeType, size, storedAt }` | Offline blob cache |
| `uploads` | assetId | `{ status, retries, lastAttempt }` | Upload queue persistence |

Global across rooms (content-addressed dedup).

---

## Rendering

### Base Canvas (`renderer/layers/objects.ts`)

`drawImage()`:
- Reads `getFrame(handle.y)` and `getAssetId(handle.y)`
- `getBitmap(assetId)` — synchronous lookup
- Bitmap ready → `ctx.drawImage(bitmap, x, y, w, h)` with `imageSmoothingQuality: 'high'`
- Bitmap not ready → gray placeholder rect (`#f0f0f0` fill, `#d1d5db` stroke)
- Respects `getOpacity(handle.y)` via `ctx.globalAlpha`

### Object Cache (`renderer/object-cache.ts`)

Images return an empty `new Path2D()` — they don't use the geometry cache.

---

## Hit Testing & Selection

- **Point hit test:** Simple rect containment — images are always filled/opaque
- **Marquee:** Rect intersection against frame
- **Eraser:** Circle-rect intersection, interior hits count
- **Selection kind:** `'imagesOnly'` supported. `computeStyles()` returns `EMPTY_STYLES` for images
- **Connector topology:** Images included — connectors can snap to image frames

---

## Worker API

### Hono + PartyServer Architecture (`worker/src/index.ts`)

```typescript
const app = new Hono<{ Bindings: Env }>();
app.use('/api/*', cors({ origin: ..., allowMethods: ['GET', 'PUT', 'OPTIONS'] }));
app.put('/api/assets/:key', handleUpload);
app.get('/api/assets/:key', handleGetAsset);
app.use('*', partyserverMiddleware());
```

CORS middleware on `/api/*` allows `localhost:*` and `avlo.io`. Uses `hono-party` `partyserverMiddleware()` for Yjs WebSocket sync.

### Upload Route (`PUT /api/assets/:key`)

- Raw binary body (no FormData) — key in URL path
- Origin validation (403 if missing/mismatch)
- R2 dedup check (HEAD) → 200 if exists (avoids reading body)
- 10 MB size limit
- Magic byte validation via shared `validateImage()` (PNG, JPEG, WebP, GIF)
- SHA-256 hash verification: recomputes hash from body, must match URL key
- R2.put with `httpMetadata.contentType` from magic bytes
- Returns 201 on success

### Fetch Route (`GET /api/assets/:key`)

Edge-cached R2 proxy:
1. `caches.default.match()` → return cached if hit
2. `R2.get(key, { range: headers, onlyIf: headers })` — R2 parses Range/If-None-Match internally
3. `object.writeHttpMetadata(headers)` — Content-Type from stored metadata
4. Response headers: `Cache-Control: immutable`, CSP, `X-Content-Type-Options`, `ETag`
5. Body tee + `waitUntil(cache.put())` for edge cache population on 200
6. 206 for range, 304 for conditional, 404 for missing

### R2 Buckets (`wrangler.toml`)

| Binding | Bucket | Purpose |
|---------|--------|---------|
| `DOCS` | `avlo-docs` | Y.Doc V2 snapshots (rooms) |
| `ASSETS` | `avlo-assets` | Image blobs (content-addressed) |

---

## CanvasRuntime Integration

| Hook | Location | What |
|------|----------|------|
| `setOnBitmapReady(cb)` | `start()` | Registers `renderLoop.invalidateAll()` on bitmap decode complete |
| `startUploadQueue()` | `start()` | Returns cleanup fn, drains prior-session uploads, registers online listener |
| `clearImageManager()` | `stop()` | Room teardown: close bitmaps, clear caches |
| `handleDrop(e)` | Drop event | Filter `image/*` + `.svg` files → `createImageFromBlob()` per file |

---

## Accessors (`packages/shared/src/accessors/object-accessors.ts`)

```typescript
getAssetId(y) → string | null
getNaturalDimensions(y) → [number, number] | null
getImageProps(y) → ImageProps | null    // { assetId, frame, naturalWidth, naturalHeight, mimeType }
```

---

## Known Issues & Missing Features

### Client-Side
- No aspect-ratio-locked resize (images should maintain aspect ratio by default)
- No image-specific context menu controls (crop, replace, opacity slider)
- Multiple images dropped/picked at same position stack on top of each other (no offset)
- No loading state indicator beyond the gray placeholder rect
- No error state UI (failed decode / failed upload)
- `setAssetsBaseUrl()` is never called — CDN URL not configured for production

### Worker-Side
- No authentication on upload endpoint (anyone can upload)
- No image dimension limits

### SelectTool Integration
- Image scale commit not fully implemented (needs frame update on pointer up)
- No rotation support
- No double-click behavior defined for images
