# Bookmark Subsystem

URL bookmarks — paste a URL, get a card with OG image, title, description, domain, and "Open" button. Fully offline-first: loading state is local-only via HTML placeholder; Y.Doc receives a single atomic transaction once unfurl completes (or a minimal fallback on failure). No `unfurlStatus` field — other clients never see pending/loading states.

## Y.Doc Schema (v2)

```typescript
{
  id: string;                          // ULID (pre-generated before Y.Doc write)
  kind: 'bookmark';
  url: string;                        // Normalized (http/https only, no fragment, no trailing /)
  domain: string;                     // Hostname minus www. (stored, not derived in render path)
  frame: [x, y, w, h];               // Fixed width 360wu, variable height

  // Set by worker on successful unfurl (all optional — absent on minimal/failed bookmarks):
  title?: string;
  description?: string;
  ogImageAssetId?: string;            // SHA-256 hex of OG image in R2
  ogImageWidth?: number;              // Original image width (from binary header parsing)
  ogImageHeight?: number;             // Original image height (from binary header parsing)
  faviconAssetId?: string;            // SHA-256 hex of favicon in R2

  ownerId: string;
  createdAt: number;
}
```

**No `unfurlStatus` field.** Bookmark state is determined by which optional fields are present:
- Full card: `ogImageAssetId` + `ogImageWidth > 0` + `title`
- Text card: `title` present, no OG image
- Minimal card: only `url` + `domain` (unfurl failed or offline commit)

**Height is data-driven** — computed from `computeBookmarkHeight(data)` using OG image aspect ratio, title line count, and description line count.

---

## File Map

| File | Purpose |
|------|---------|
| `client/src/lib/bookmark/bookmark-render.ts` | Layout cache, `drawBookmark()`, text wrapping, height computation, three card layouts |
| `client/src/lib/bookmark/bookmark-unfurl.ts` | Lifecycle coordinator: pending map, worker commands, atomic Y.Doc writes, placeholder management |
| `client/src/lib/bookmark/bookmark-placeholder.ts` | HTML loading elements: spinner + domain label, camera-tracked positioning |
| `worker/src/unfurl.ts` | Cloudflare Worker: Zod validation, SSRF guard, HTMLRewriter parse, image fetch/R2 store, edge cache |
| `packages/shared/src/utils/url-utils.ts` | `normalizeUrl()`, `isValidHttpUrl()`, `extractDomain()` |
| `packages/shared/src/accessors/object-accessors.ts` | `getBookmarkProps()`, `getBookmarkUrl()` — typed Y.Map accessors |
| `packages/shared/src/utils/image-validation.ts` | `validateImage()`, `parseImageDimensions()` — binary header parsing for width/height |

---

## Data Flow

### Paste → Placeholder → Unfurl → Atomic Y.Doc Write

```
User pastes URL
  ↓
clipboard-actions.ts: extractLeadingUrl(text)
  ├── First line is valid HTTP(S) URL → createBookmarkFromUrl(url)
  │     └── beginUnfurl(url, worldX, worldY)    [bookmark-unfurl.ts]
  │           ├── objectId = ulid()              (pre-generated, not yet in Y.Doc)
  │           ├── domain = extractDomain(url)
  │           ├── pendingBookmarks.set(objectId, { url, domain, worldX, worldY, committed:false })
  │           ├── createPlaceholder(objectId, domain, wx, wy)   [bookmark-placeholder.ts]
  │           │     └── HTML div: spinner + domain label, appended to editorHost
  │           ├── postToPrimary({ type: 'unfurl', objectId, url })
  │           ├── setActiveTool('select'), setSelection([objectId])
  │           └── return objectId
  │
  └── Remainder after URL → pasteExternalText(remainder) as separate text object
```

### Worker Fetch Pipeline

```
image-worker.ts (primary only):
  ├── IDB enqueue (UNFURLS_STORE, idempotent by objectId)
  └── drainUnfurls() → unfurlOne()
        ├── GET /api/unfurl?url=<encoded>
        │     ↓
        │   worker/unfurl.ts:
        │     ├── Zod validation + SSRF guard (middleware via zValidator)
        │     ├── Edge cache check (SHA-256 of normalized URL)
        │     ├── Content-type branching:
        │     │   ├── image/* → direct image storage, filename as title
        │     │   ├── text/html | application/xhtml+xml | application/xml → HTMLRewriter
        │     │   └── anything else → minimal { url, domain }
        │     ├── HTMLRewriter: og:title, og:image, og:image:secure_url, twitter:*, <title>, favicon
        │     ├── parseImageDimensions(bytes, mimeType) → { width, height } from binary headers
        │     ├── Parallel image fetch → SHA-256 → R2 put (content-addressed dedup)
        │     └── Return JSON { url, domain, title?, description?, ogImageAssetId?, ogImageWidth?, ogImageHeight?, faviconAssetId? }
        │
        ├── Success → post({ type: 'unfurled', objectId, data })
        │     ↓
        │   image-manager.ts → handleUnfurlResult(objectId, data)
        │     ↓
        │   bookmark-unfurl.ts:
        │     Case A (pending, not committed — online happy path):
        │       ├── computeBookmarkHeight(data) → frame centered on worldX, worldY
        │       ├── Y.Doc mutate: SINGLE ATOMIC TRANSACTION with ALL fields
        │       │   (id, kind, url, domain, frame, title, description,
        │       │    ogImageAssetId, ogImageWidth, ogImageHeight, faviconAssetId,
        │       │    ownerId, createdAt)
        │       ├── removePlaceholder(objectId)
        │       └── pendingBookmarks.delete(objectId)
        │
        │     Case B (pending, committed — offline→online recovery):
        │       ├── Y.Doc mutate: UPDATE existing bookmark — patch title, desc, assets, recompute height
        │       └── pendingBookmarks.delete(objectId)
        │
        │     Case C (no pending entry — page refresh recovery):
        │       └── Check Y.Doc for objectId → upgrade if found, discard if not
        │
        ├── 4xx → post({ type: 'unfurl-failed', objectId, permanent: true })
        │     ↓ handleUnfurlFailed(objectId, true) → pendingBookmarks.delete()
        │
        └── 5xx/network (first failure, retries === 0):
              ├── post({ type: 'unfurl-failed', objectId, permanent: false })
              │     ↓ handleUnfurlFailed(objectId, false):
              │       ├── Y.Doc mutate: minimal bookmark (url + domain + frame)
              │       ├── removePlaceholder(objectId)
              │       └── pending.committed = true  (kept in map for Case B recovery)
              └── IDB entry retries++ (worker retries with exponential backoff)
```

### Image Pipeline for Bookmark Assets

Bookmark OG images and favicons flow through the **same decode pipeline** as regular images:

```
Bookmark written to Y.Doc (asset IDs now in Y.Map)
  ↓
Observer fires → snapshot published
  ↓
manageImageViewport() (per render tick):
  ├── Spatial index query for visible bookmarks
  ├── Extract ogImageAssetId + faviconAssetId from Y.Map
  └── registerAssetInfo(assetId, ppsp=Infinity, ...)
        ↓ (forces level 0, no mip levels)
      Standard decode pipeline → worker decode → ImageBitmap
        ↓
      getBitmap(assetId) available for drawBookmark()
```

**Key difference from images:** Bookmarks always use `ppsp = Infinity` (full-resolution, no mip level selection). OG images are ≤360wu wide, favicons 20×20.

### Hydration (Room Join)

```
hydrateObjectsFromY()
  ├── Y.Map walk → ObjectHandle with kind: 'bookmark'
  ├── BBox: frame-based with shadow padding (frame[2] * 0.15)
  └── hydrateImages(): collect ogImageAssetId + faviconAssetId at level 0
```

No main-thread scan for pending bookmarks — image worker IDB queue drains on init.

---

## Pending Bookmarks (Local-Only State)

```typescript
// bookmark-unfurl.ts
interface PendingBookmark {
  url: string;
  domain: string;
  worldX: number;          // Paste position
  worldY: number;
  committed: boolean;      // true after minimal offline commit to Y.Doc
  objectId: string;        // Pre-generated ULID
}

const pendingBookmarks = new Map<string, PendingBookmark>();
```

This Map exists only on the creating client's main thread. Other clients never see it. The three cases in `handleUnfurlResult` cover all lifecycle scenarios:

| Scenario | Case | Behavior |
|----------|------|----------|
| Online paste, unfurl succeeds | A | Single atomic Y.Doc write with full data |
| Offline paste, later comes online | B | Minimal bookmark already committed → upgrade with metadata |
| Page refresh while worker retrying | C | No pending entry → check Y.Doc by objectId → upgrade if found |

---

## HTML Placeholder (bookmark-placeholder.ts)

Loading placeholders are HTML elements appended to the editor host div, NOT canvas-rendered. They're visible only to the creating client.

```typescript
interface PlaceholderEntry {
  el: HTMLDivElement;     // DOM element
  wx: number;             // World X position
  wy: number;             // World Y position
}

const placeholders = new Map<string, PlaceholderEntry>();
```

**Visual:** 360×56px white card with 8px border-radius, subtle box-shadow, containing a 16px spinning circle + 12px domain text. Spinner uses CSS `@keyframes bk-spin` (injected once into `<head>`).

**Positioning:** Each frame, `repositionAllPlaceholders()` (called from `manageImageViewport()`) applies camera transforms:

```typescript
const { scale, pan } = useCameraStore.getState();
el.style.transform = `translate(${(wx - pan.x) * scale}px, ${(wy - pan.y) * scale}px) scale(${scale})`;
```

**Lifecycle:**
- Created by `beginUnfurl()` → `createPlaceholder(objectId, domain, wx, wy)`
- Removed by `handleUnfurlResult()` or `handleUnfurlFailed()` → `removePlaceholder(objectId)`
- All removed on room teardown → `removeAllPlaceholders()`

---

## Rendering (bookmark-render.ts)

### Three Data-Driven Layouts

No pending/failed visual states — layout determined purely by which metadata fields are present.

**Full Card** (has `ogImageAssetId` + `ogImageWidth > 0` + `title`):
```
┌──────────────────────────────┐
│          OG Image            │  ← Variable height (80–300wu, aspect-ratio-aware)
│                    [Open →]  │  ← Button overlaid on image bottom-right
├──────────────────────────────┤
│ Title (bold 15px)            │  ← Max 2 lines, ellipsis
│ Description (13px gray)      │  ← Max 3 lines, ellipsis (if present)
│ 🔗 domain.com               │  ← Favicon 20×20 + domain text
└──────────────────────────────┘
```

**Text Card** (has `title`, no OG image):
```
┌──────────────────────────────┐
│ Title (bold 15px)            │
│ Description (13px gray)      │
│ 🔗 domain.com      [Open →] │  ← Button right-aligned in domain row
└──────────────────────────────┘
```

**Minimal Card** (only `url` + `domain`):
```
┌──────────────────────────────┐
│ https://example.com/path     │  ← URL wrapped, max 2 lines
│ 🔗 domain.com      [Open →] │  ← Button right-aligned in domain row
└──────────────────────────────┘
```

### Shadow + Body

Shared with sticky notes via `renderNoteBody(ctx, x, y, w, h, CARD_FILL)` from `text-system.ts`. Draws 9-slice cached dual-layer Gaussian shadow + white rounded rect fill (`#FFFFFF`, corner radius via `getNoteCornerRadius(w)`).

### OG Image Drawing

Aspect-ratio-aware display height:

```typescript
function ogDisplayHeight(ogW: number, ogH: number): number {
  if (ogW <= 0 || ogH <= 0) return 0;
  const natural = BOOKMARK_WIDTH * (ogH / ogW);  // Scale to card width
  return Math.min(Math.max(natural, MIN_OG_H), MAX_OG_H);  // Clamp [80, 300]
}
```

Clipped to top-rounded rectangle (`ctx.roundRect(x, y, w, displayH, [8, 8, 0, 0])`). Center-cropped vertically when natural height exceeds display height:

```typescript
if (naturalH > displayH) {
  const scale = w / bitmap.width;
  const srcH = displayH / scale;
  const srcY = (bitmap.height - srcH) / 2;    // Vertical center of source
  ctx.drawImage(bitmap, 0, srcY, bitmap.width, srcH, x, y, w, displayH);
}
```

Placeholder `#f5f5f5` rect while bitmap loading.

### "Open" Button

28×28wu rounded rect (radius 6px). Semi-transparent white background (`rgba(255,255,255,0.85)`) with 1px `#e5e7eb` border. 10×10 arrow icon centered: stroke `#374151`, lineWidth 2, round caps/joins, path `M2 1h7v7 M9 1L1 9`.

- **Full card:** overlaid on OG image, `OPEN_BTN_MARGIN` (10wu) from bottom-right of image area
- **Text/Minimal card:** right-aligned in domain row, vertically centered with favicon

### Favicon

20×20wu (was 16 in v1). Drawn via `getBitmap(props.faviconAssetId)` from `image-manager.ts`. Positioned at left edge of domain row, 6px spacing before domain text.

### Layout Cache

```typescript
interface BookmarkLayout {
  titleLines: string[];       // Wrapped title, max 2 lines
  descLines: string[];        // Wrapped description, max 3 lines
  urlLines: string[];         // Wrapped URL (minimal card), max 2 lines
  totalHeight: number;        // Computed total card height
  hasOgImage: boolean;        // OG image available
  ogDisplayH: number;         // Clamped display height [80, 300]
}
```

Module-level `Map<string, BookmarkLayout>` keyed by object ID. Computed on first render via `getLayout(id, props)` using a singleton `OffscreenCanvas` context for `measureText()`.

**Invalidation:**
- `invalidateBookmarkLayout(id)` — on object deletion (called from `room-doc-manager.ts`)
- `clearBookmarkLayouts()` — full cache clear
- Layout auto-recomputes on next render when Y.Map properties change (title, description, assets arrive via unfurl)

### Height Computation

```typescript
// Height formulas:
Full:    ogDisplayH + CARD_PADDING + titleH + descH + domainLineH + CARD_PADDING
Text:    CARD_PADDING + titleH + descH + domainLineH + CARD_PADDING
Minimal: CARD_PADDING + urlLinesH + domainLineH + CARD_PADDING

// Where:
titleH      = titleLines.length * TITLE_LINE_H   (20px per line)
descH       = descLines.length * DESC_LINE_H     (17px per line)
domainLineH = DOMAIN_FONT_SIZE + 12              (24px)
```

`computeBookmarkHeight(data)` is called before Y.Doc write (to set frame height). Does NOT use the layout cache — computes independently.

---

## Cloudflare Worker Endpoint

**Route:** `GET /api/unfurl?url=<encoded_url>`

**Middleware:** `zValidator('query', unfurlQuery)` — Zod v4 schema validates, normalizes URL via `normalizeUrl()`, and runs SSRF guard before handler.

### SSRF Guard (server-only, colocated in unfurl.ts)

```typescript
function isPrivateHost(hostname: string): boolean
// Blocks: localhost, [::1], .local, .internal
// IPv4 private: 127.x, 10.x, 172.16-31.x, 192.168.x, 169.254.x, 0.x
```

### Content-Type Branching

After fetching the URL:
- `image/*` → store as OG image via `fetchAndStoreImage()`, use URL filename as title
- `text/html` | `application/xhtml+xml` | `application/xml` → HTMLRewriter parse
- Anything else → minimal response `{ url, domain }`

### HTMLRewriter Extraction

| Priority | Source | Field |
|----------|--------|-------|
| 1st | `og:title` | title |
| 2nd | `twitter:title` | title |
| 3rd | `<title>` text | title |
| 1st | `og:description` | description |
| 2nd | `twitter:description` | description |
| 3rd | `<meta name="description">` | description |
| 1st | `og:image:secure_url` | ogImage URL |
| 2nd | `og:image` | ogImage URL |
| 3rd | `twitter:image` | ogImage URL |
| 1st | `apple-touch-icon` | favicon URL |
| 2nd | `<link rel="icon">` / `shortcut icon` | favicon URL |

Stream consumed with `.blob()` (not `.text()`).

### Image Processing

`fetchAndStoreImage(assets, imageUrl, maxBytes)` → `{ assetId, width, height } | null`

- Streamed with chunked size guard (OG: 5MB, favicon: 500KB)
- Validated via `validateImage(bytes)` → PNG/JPEG/WebP/GIF only
- Dimensions parsed from binary headers via `parseImageDimensions(bytes, mimeType)`:
  - PNG: IHDR bytes 16-23 (big-endian uint32)
  - JPEG: scan SOF0/SOF2 markers for width/height
  - WebP: VP8/VP8L header parsing
  - GIF: bytes 6-9 (little-endian uint16)
- Content-addressed: `SHA-256(bytes)` → `assetId`, `R2.head()` dedup before write

### Edge Cache

Synthetic key: `https://unfurl.avlo.internal/<sha256(normalizedUrl)>`. TTL: 7 days (`Cache-Control: public, max-age=604800`). `waitUntil(cache.put(response.clone()))` — non-blocking.

### Error Strategy

- Invalid/private URL → Zod validation rejects (400)
- Network error / timeout / non-HTML → 200 with minimal `{ url, domain }`
- Image fetch failure → silently skip, return text metadata only
- Never fails loudly for fetch issues

---

## Image Worker Queue

Mirrors the upload queue pattern exactly:

| Aspect | Upload Queue | Unfurl Queue |
|--------|-------------|--------------|
| IDB Store | `uploads` | `unfurls` |
| Entry | `{ retries, lastAttempt }` | `{ url, retries, lastAttempt }` |
| Key | assetId | objectId |
| Process | `uploadOne()` | `unfurlOne()` |
| Drain | `drainUploads()` | `drainUnfurls()` |
| Guard | `uploading` boolean | `unfurling` boolean |
| Safety interval | 30s | 30s |
| Backoff | `1000 * 2^retries`, max 60s | Same |
| Permanent fail | 4xx → remove entry | 4xx → remove + notify main (`permanent: true`) |
| Transient fail | 5xx/network → increment retries | Same + first-failure notify (`permanent: false`) |
| Online reset | `resetBackoff` flag | Same (shared flag) |

**Primary worker only.** Non-primary workers ignore unfurl messages.

**First-failure notify (v2):** On first transient failure (`entry.retries === 0`), worker posts `{ type: 'unfurl-failed', objectId, permanent: false }` to main thread before incrementing retries. This triggers minimal bookmark commit + placeholder removal — user sees a card immediately instead of an indefinite spinner. Subsequent retries are silent; if one succeeds, `handleUnfurlResult` Case B upgrades the minimal bookmark.

**Data stripping:** Worker strips `unfurlStatus`, `url`, `domain` from server response before posting to main thread (server may include them, but they're already known client-side or obsolete).

---

## Clipboard Integration

### URL Detection (`extractLeadingUrl`)

Checks if first line of pasted text is a valid HTTP(S) URL via `normalizeUrl()`. Returns `{ url, remainder }` or `null`.

- Single URL → bookmark only
- URL + newline + text → bookmark + text object (split)
- Multi-word text → standard text paste
- `ftp://`, `file://` → standard text paste

Both `pasteExternalText()` and `pasteExternalHtml()` check `extractLeadingUrl()` first.

### Internal Paste (Copy/Paste Between Clients)

Bookmarks serialize as plain Y.Map props (url, domain, title, description, asset IDs). All data present on paste — no re-unfurl needed. Full metadata preserved across copy/paste.

---

## Integration Points (Other Files)

### Selection (`selection-utils.ts`, `selection-store.ts`)
- `SelectionKind` includes `'bookmarksOnly'`
- `KindCounts.bookmarks` tracked in composition
- Returns `EMPTY_STYLES` (no controls — same as images)

### Hit Testing (`hit-testing.ts`)
- Marquee: frame-based `rectsIntersect(frameTupleToWorldBounds(frame), rect)`
- Point: simple rect containment, `isFilled: true` (always opaque)

### Eraser (`EraserTool.ts`)
- `case 'bookmark':` alongside `case 'image':` — `circleRectIntersect(wx, wy, radius, x, y, w, h)`

### Bounds (`bounds.ts`)
- `computeRawGeometryBounds`: bookmark included in frame-based branch

### BBox (`bbox.ts` in shared)
- Separate `case 'bookmark':` with shadow padding `frame[2] * 0.15` on all sides

### Object Cache (`object-cache.ts`)
- No bookmark-specific case — bookmarks have no Path2D or ConnectorPaths geometry cache

### Renderer (`objects.ts`)
- `case 'bookmark': drawBookmark(ctx, handle)` in `drawObject` switch
- Transform preview: draws normally (no scale transform support yet)

### Room Doc Manager (`room-doc-manager.ts`)
- Hydration: standard `computeBBoxFor()` (frame-based with shadow padding)
- Observer: bbox recomputes on any Y.Map property change
- Deletion: `invalidateBookmarkLayout(id)`

### Canvas Runtime (`CanvasRuntime.ts`)
- `stop()` calls `cleanupOnRoomTeardown()` (clears placeholders + pending map)

### Image Manager (`image-manager.ts`)
- `handleWorkerMessage`: routes `'unfurled'` → `handleUnfurlResult()`, `'unfurl-failed'` → `handleUnfurlFailed()`
- `manageImageViewport()`: registers bookmark OG image + favicon with `ppsp = Infinity`, calls `repositionAllPlaceholders()`
- `hydrateImages()`: collects bookmark asset IDs at level 0

### Service Worker
No changes needed. `/api/assets/*` cache-first handles OG images and favicons. `/api/unfurl` falls through as non-asset API.

---

## Constants

```
BOOKMARK_WIDTH    = 360       Card width (fixed)
CARD_PADDING      = 16        Inner padding
MIN_OG_H          = 80        Minimum OG image display height
MAX_OG_H          = 300       Maximum OG image display height
TITLE_FONT_SIZE   = 15        Bold Inter
DESC_FONT_SIZE    = 13        Regular Inter
DOMAIN_FONT_SIZE  = 12        Regular Inter, color #9ca3af
TITLE_LINE_H      = 20        Title line height
DESC_LINE_H       = 17        Description line height
TITLE_MAX_LINES   = 2
DESC_MAX_LINES    = 3
FAVICON_SIZE      = 20        20x20 (was 16 in v1)
CARD_FILL         = '#FFFFFF'
CARD_RADIUS       = 8
OPEN_BTN_SIZE     = 28        Open button dimensions
OPEN_BTN_RADIUS   = 6         Open button border radius
OPEN_BTN_MARGIN   = 10        Margin from card edges
PLACEHOLDER_W     = 360       HTML placeholder width
PLACEHOLDER_H     = 56        HTML placeholder height
```

---

## Edge Cases

| Scenario | Handling |
|----------|----------|
| **Online paste** | HTML placeholder → worker fetch → atomic Y.Doc commit with all data → placeholder removed |
| **Offline paste** | HTML placeholder → worker fails (first transient) → minimal Y.Doc commit (url+domain) → placeholder removed. IDB retries later. |
| **Offline → online** | Worker retries from IDB → succeeds → `handleUnfurlResult` Case B: upgrade existing minimal bookmark with metadata |
| **Page refresh with IDB entries** | Worker drains IDB on init → `handleUnfurlResult` Case C: no pending map entry, check Y.Doc, upgrade if found |
| **Internal paste** | All data copied as-is from Y.Doc. No re-unfurl. Full metadata preserved. |
| **Undo after online commit** | Single atomic transaction → undo removes entire bookmark cleanly |
| **Undo after offline commit** | Undo removes minimal bookmark. If worker retry succeeds later, Case C finds no Y.Doc entry → discard |
| **Room teardown mid-unfurl** | `cleanupOnRoomTeardown()` clears placeholders + pending map. Worker result arrives → `hasActiveRoom()` false → discard |
| **Multiple rapid pastes** | Each gets unique objectId, own placeholder, own IDB entry. Independent lifecycles. |
| **Multi-client** | Client A pastes URL → Client B sees nothing until bookmark appears fully formed (no pending state visible) |

---

## NOT Implemented

- **SelectTool transforms** — bookmarks draw normally during scale (no resize/reflow)
- **Double-click behavior** — no editing mode (bookmarks are not editable)
- **Link open on click** — "Open" button is visual-only, no navigation
- **Context menu actions** — no bookmark-specific toolbar bar
- **Re-unfurl** — no way to retry from UI (worker auto-retries via IDB queue)
- **URL editing** — URL is immutable after creation
