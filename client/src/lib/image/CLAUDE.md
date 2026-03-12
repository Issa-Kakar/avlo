# Image System

Offline-first image objects with content-addressed asset storage, IndexedDB caching, off-thread decoding, and persistent upload queue. Images render as `ImageBitmap` on the base canvas via `ctx.drawImage()`.

**Status:** Initial implementation. Working locally but has known issues across the stack. See "Known Issues" at the end.

---

## Architecture Overview

```
User drops/pastes/picks file
   ↓
image-actions.ts: createImageFromBlob(blob, worldX, worldY)
   ├─ image-manager.ts: ingest(blob)
   │   ├─ SHA-256 hash → assetId (content-addressed)
   │   ├─ asset-cache.ts: putBlob(assetId, blob) → IndexedDB `blobs` store
   │   └─ image-decode-worker.ts: createImageBitmap(blob) → ImageBitmap in memory cache
   ├─ Y.Doc mutation: create image object (kind:'image', assetId, frame, naturalDimensions)
   ├─ Select + switch to select tool
   └─ upload-queue.ts: enqueue(assetId) → IDB `uploads` store → POST /api/assets/upload

Render path (synchronous):
   objects.ts → drawImage(ctx, handle) → getBitmap(assetId) → ctx.drawImage(bitmap, ...)
   Bitmap not ready? → gray placeholder rect

Remote peer joins:
   Y.Doc sync → new image object arrives
   room-doc-manager.ts observer → requestImageLoad(assetId)
   image-manager.ts: IDB check → CDN fetch → worker decode → invalidateAll()
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
| `image-actions.ts` | Entry points: `createImageFromBlob()`, `openImageFilePicker()` |
| `image-manager.ts` | Module-level singleton: memory cache, decode worker pool, load pipeline, `getBitmap()` |
| `asset-cache.ts` | Raw IndexedDB wrapper: `blobs` store (image data) + `uploads` store (queue state) |
| `image-decode-worker.ts` | Web Worker: blob → `createImageBitmap()` off main thread |
| `upload-queue.ts` | Persistent upload queue: IDB-backed, exponential backoff, idempotent |

### Worker (Server) Files

| File | Responsibility |
|------|----------------|
| `worker/src/routes/assets.ts` | Hono router: `POST /upload` (validate + R2 put) + `GET /:key` (R2 read-through) |
| `worker/src/lib/image-validation.ts` | Magic byte detection: PNG, JPEG, WebP, GIF |
| `worker/src/index.ts` | Hono app: `/api/assets` → assets router, `*` → partyserver (Yjs sync) |

---

## Entry Points

Four ways to create an image:

| Trigger | Handler | Location |
|---------|---------|----------|
| Drag-drop files onto canvas | `CanvasRuntime.handleDrop()` | `canvas/CanvasRuntime.ts` |
| Clipboard paste (Cmd+V) | `pasteFromClipboard()` → `pasteImage()` | `lib/clipboard/clipboard-actions.ts` |
| Keyboard shortcut `i` | `openImageFilePicker()` | `canvas/keyboard-manager.ts` |
| Toolbar Image button | `openImageFilePicker()` | `components/ToolPanel.tsx` |

All entry points converge to `createImageFromBlob(blob, worldX, worldY, opts?)`.

**Important:** Image is NOT a persistent tool (no `ImageTool` class). The `i` key and toolbar button open a file picker as a one-shot action. The `'image'` string in `activeTool` is only used for toolbar button state and inspector visibility gating.

---

## Asset Lifecycle

### 1. Ingest (`image-manager.ts: ingest`)

```
Blob → ArrayBuffer → SHA-256 hash → assetId (hex string)
  → Dedup check: memory cache hit? Return immediately
  → putBlob(assetId, blob) → IndexedDB (idempotent)
  → decodeBlob(blob) → Worker → ImageBitmap
  → Memory cache: { status: 'ready', bitmap, fetchPromise: null }
  → Return { assetId, naturalWidth, naturalHeight, mimeType }
```

### 2. Y.Doc Mutation (`image-actions.ts: createImageFromBlob`)

```
ingest() result → compute frame (400wu wide, preserve aspect ratio)
  → getActiveRoomDoc().mutate() → Y.Map with all fields
  → setActiveTool('select') + setSelection([objectId])
  → enqueue(assetId) → upload queue
```

### 3. Upload (`upload-queue.ts`)

```
enqueue(assetId) → putUploadEntry(assetId, { status: 'pending' })
  → processQueue() → one-at-a-time drain
  → getBlob(assetId) from IDB → FormData → POST /api/assets/upload
  → 201 Created or 409 Already Exists → removeUploadEntry()
  → On failure: exponential backoff (1s, 2s, 4s, 8s, 16s), max 5 retries
  → window.online event → processQueue() (resume after disconnect)
```

### 4. Remote Load (`image-manager.ts: requestLoad / loadPipeline`)

When a peer's image object arrives via Yjs sync:

```
room-doc-manager observer → requestImageLoad(assetId)
  → loadPipeline(assetId, entry):
      1. Check IDB → blob found? Skip fetch
      2. fetch(assetsBaseUrl/assetId) → blob → putBlob to IDB
      3. decodeBlob(blob) → Worker → ImageBitmap
      4. onBitmapReady(assetId) → CanvasRuntime.invalidateAll()
```

### 5. Room Hydration (`room-doc-manager.ts`)

On full rebuild (`hydrateObjectsFromY`), collects all `assetId`s from image objects and calls `prefetchBatch(assetIds)` — triggers parallel `requestLoad()` for each.

---

## Memory Management

### ImageBitmap Cache (`image-manager.ts`)

- `assets: Map<assetId, AssetEntry>` — in-memory bitmap cache
- `getBitmap(assetId)` — synchronous, returns `ImageBitmap | null` (render-path fast path)
- `evictDistant(visibleAssetIds: Set<string>)` — closes bitmaps not in viewport, sets status back to `'pending'` for re-decode from IDB
- `clear()` — room teardown: close all bitmaps, clear all maps

### Decode Worker Pool

- Single `Worker` instance, lazily created
- Message-based request/response with string IDs
- `createImageBitmap()` runs off main thread
- Bitmap transferred via `Transferable[]` (zero-copy to main thread)
- `pendingDecodes: Map<id, { resolve, reject }>` for promise management

### IndexedDB (`asset-cache.ts`)

Database: `avlo-assets`, version 1. Two object stores:

| Store | Key | Value | Purpose |
|-------|-----|-------|---------|
| `blobs` | assetId (SHA-256 hex) | `{ blob, mimeType, size, storedAt }` | Offline blob cache |
| `uploads` | assetId | `{ status, retries, lastAttempt }` | Upload queue persistence |

Global across rooms (content-addressed dedup). Raw IDB wrapper — no ORM.

---

## Rendering

### Base Canvas (`renderer/layers/objects.ts`)

```typescript
// In drawObject() switch:
case 'image':
  drawImage(ctx, handle);
  break;
```

`drawImage()`:
- Reads `getFrame(handle.y)` and `getAssetId(handle.y)`
- `getBitmap(assetId)` — synchronous lookup
- Bitmap ready → `ctx.drawImage(bitmap, x, y, w, h)` with `imageSmoothingQuality: 'high'`
- Bitmap not ready → gray placeholder rect (`#f0f0f0` fill, `#d1d5db` stroke)
- Respects `getOpacity(handle.y)` via `ctx.globalAlpha`

### Transform Preview

`drawImageWithTransform()` — applies scale transform to frame, draws bitmap at transformed coordinates. Used during SelectTool scale gestures.

Mixed-corner special case: uniform scale via `applyUniformScaleToFrame()` (same as shapes). Other handles: non-uniform via `drawImageWithTransform()`.

### Object Cache (`renderer/object-cache.ts`)

Images return an empty `new Path2D()` — they don't use the geometry cache. All rendering is via `ctx.drawImage()`.

---

## Hit Testing & Selection

### Point Hit Test (`lib/geometry/hit-testing.ts: testObjectHit`)

```typescript
case 'image': {
  const frame = getFrame(y);
  // Simple rect containment — images are always filled
  if (worldX >= x && worldX <= x + w && worldY >= yPos && worldY <= yPos + h) {
    return { id, kind: 'image', distance: 0, insideInterior: true, area: w * h, isFilled: true };
  }
}
```

Images are always treated as opaque/filled for hit testing (like code blocks). No edge-only hit testing.

### Marquee Intersection (`objectIntersectsRect`)

```typescript
case 'image': {
  const frame = getFrame(y);
  return rectsIntersect(frameTupleToWorldBounds(frame), rect);
}
```

### Eraser (`lib/tools/EraserTool.ts`)

Circle-rect intersection against frame. Images are always filled, so interior hits count.

### Selection Kind (`stores/selection-store.ts`)

`SelectionKind` includes `'imagesOnly'`. `selectionKind` computed in `computeSelectionComposition()` (`selection-utils.ts`).

`KindCounts` has `images: number` field. Mixed selection filter supports `'images'` kind.

### Selection Styles

`computeStyles()` returns `EMPTY_STYLES` for `imagesOnly` — no style controls in context menu. The `imagesOnly` context menu bar shows only the common actions (delete) + overflow button.

### Connector Topology

Images are included in connector topology computation (`selection-store.ts: computeConnectorTopology`). Connectors can snap to image frames just like shapes.

---

## BBox Computation (`packages/shared/src/utils/bbox.ts`)

```typescript
case 'image': {
  const frame = getFrame(yMap) ?? [0, 0, 0, 0];
  return [frame[0], frame[1], frame[0] + frame[2], frame[1] + frame[3]];
}
```

No stroke padding (images have no border stroke).

---

## Accessors (`packages/shared/src/accessors/object-accessors.ts`)

```typescript
getAssetId(y) → string | null
getNaturalDimensions(y) → [number, number] | null
getImageProps(y) → ImageProps | null    // { assetId, frame, naturalWidth, naturalHeight, mimeType }
```

Bulk accessor `getImageProps()` is the preferred read path for rendering.

---

## Worker API

### Hono + PartyServer Architecture (`worker/src/index.ts`)

```typescript
const app = new Hono<{ Bindings: Env }>();
app.route('/api/assets', assets);    // Image asset routes
app.all('*', routePartykitRequest);  // Everything else → PartyServer (Yjs sync)
```

Uses `hono-party` pattern: Hono handles HTTP routes, PartyServer handles WebSocket upgrade for Yjs. Single worker entry point.

### Upload Route (`POST /api/assets/upload`)

```
FormData { file: File } → validateImage(magic bytes)
  → SHA-256 content-addressed key
  → R2 ASSETS.head(key) dedup check → 409 if exists
  → R2 ASSETS.put(key, buffer, { contentType })
  → 201 { key, status: 'created' }
```

### Fetch Route (`GET /api/assets/:key`)

R2 read-through with `Cache-Control: public, max-age=31536000, immutable`. Development fallback — production would use CDN domain pointing at R2.

### Image Validation (`worker/src/lib/image-validation.ts`)

Magic byte detection only (no decode). Supported: PNG (89504E47), JPEG (FFD8FF), WebP (RIFF...WEBP), GIF (GIF8).

### R2 Buckets (`wrangler.toml`)

| Binding | Bucket | Purpose |
|---------|--------|---------|
| `DOCS` | `avlo-docs` | Y.Doc V2 snapshots (rooms) |
| `ASSETS` | `avlo-assets` | Image blobs (content-addressed) |

---

## Room Durable Object (`worker/src/parties/room.ts`)

`YServer<Env>` subclass with R2 persistence:

- `onLoad()` — hydrate from `rooms/{roomId}/head.v2.bin` (V2 encoded)
- `onSave()` — debounced (5s wait, 15s max) V2 snapshot to R2
- `onClose()` — hard flush when last connection leaves
- `static options = { hibernate: true }` — hibernation enabled
- `static callbackOptions = { debounceWait: 5000, debounceMaxWait: 15000 }`

---

## CanvasRuntime Integration

| Hook | Location | What |
|------|----------|------|
| `setOnBitmapReady(cb)` | `start()` | Registers `renderLoop.invalidateAll()` on bitmap decode complete |
| `clearImageManager()` | `stop()` | Room teardown: close bitmaps, clear caches |
| `handleDrop(e)` | Drop event | Filter `image/*` files → `createImageFromBlob()` per file |

### InputManager (`canvas/InputManager.ts`)

Registers `dragover` (preventDefault, `dropEffect: 'copy'`) and `drop` (delegates to `runtime.handleDrop(e)`) on the canvas element.

---

## Clipboard Integration (`lib/clipboard/clipboard-actions.ts`)

Image types are checked **first** in the paste handler, before HTML or text:

```typescript
for (const item of items) {
  const imageType = item.types.find(t => t.startsWith('image/'));
  if (imageType) {
    const blob = await item.getType(imageType);
    await pasteImage(blob);
    return;
  }
  // ... HTML / text paste
}
```

`pasteImage(blob)` creates image at `getPasteTarget()` (last cursor position or viewport center).

---

## Context Menu (`components/context-menu/ContextMenu.tsx`)

```typescript
{effectiveKind === 'imagesOnly' && (
  // No style controls — just common actions (delete) + overflow
  <></>
)}
```

Images have no style editing in the context menu yet. Only delete and overflow buttons.

---

## Known Issues & Missing Features

This initial implementation has several known problems that need fixing:

### Client-Side Issues
- No aspect-ratio-locked resize (images should maintain aspect ratio by default)
- No image-specific context menu controls (crop, replace, opacity slider)
- Multiple images dropped/picked at same position stack on top of each other (no offset)
- No loading state indicator beyond the gray placeholder rect
- No error state UI (failed decode / failed upload)
- `evictDistant()` is defined but never called — no viewport-based GPU memory management
- Upload queue `configureUploadQueue()` is never called — `getUploadToken` stays null, `uploadUrl` stays default `/api/assets/upload`
- `setAssetsBaseUrl()` is never called — CDN URL not configured for production
- No image serialization in clipboard (copy/paste internal images loses the asset)
- Image file picker `change` listener registered twice (line 67 and 83 in `image-actions.ts`)

### Worker-Side Issues
- No authentication on upload endpoint (anyone can upload)
- No file size limits (could upload arbitrarily large files)
- No image dimension limits
- Upload route doesn't set `Cache-Control` headers on the R2 put (only the GET route does)
- No CORS headers configured for the asset routes

### SelectTool Integration
- Image scale commit not fully implemented (needs frame update on pointer up)
- No rotation support
- No double-click behavior defined for images

### Architecture Notes
- Worker uses `hono-party` pattern as intended: Hono for HTTP routes, `routePartykitRequest` fallback for PartyServer WebSocket
- `partyserver` (not `partykit`) is the package — it's the Cloudflare Workers-native fork
- R2 ASSETS bucket is separate from DOCS bucket (correct separation of concerns)
- Content-addressed storage means dedup is automatic across rooms
