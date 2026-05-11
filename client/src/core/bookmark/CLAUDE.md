# Bookmark Subsystem

URL bookmarks — paste a URL, get a card with OG image, title, description, domain, and "Open" button. Offline paste creates a plain text object (never enters bookmark pipeline). Online failures also fall back to text objects. Loading state is local-only via HTML placeholder; Y.Doc receives a single atomic transaction once unfurl completes. No `unfurlStatus` field — other clients never see pending/loading states.

## Y.Doc Schema (v3 — origin+scale)

```typescript
{
  id: string;                          // ULID (pre-generated before Y.Doc write)
  kind: 'bookmark';
  url: string;                        // Normalized (http/https only, no fragment, no trailing /)
  domain: string;                     // Hostname minus www. (stored, not derived in render path)
  origin: [x, y];                    // Top-left position
  height: number;                    // Card height at base scale (data-driven)
  scale?: number;                    // Uniform scale factor (default 1)

  // Width is always BOOKMARK_WIDTH (300). Frame derived: [origin[0], origin[1], 300*scale, height*scale].
  // No stored frame — frame is computed via computeBookmarkBBox() and cached in bookmarkFrameCache.

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
- Full card: `ogImageAssetId` present (with or without `title`)
- Text card: `title` present, no OG image
- No minimal card — offline/failed unfurls create text objects instead of bookmarks

**Height is data-driven** — computed from `computeBookmarkHeight(data)` using OG image aspect ratio, title line count, and description line count.

**Rendering uses ctx.translate + ctx.scale** — same pattern as sticky notes. `drawBookmark()` translates to origin, scales by `scale`, then renders at local coordinates `(0, 0, BOOKMARK_WIDTH, height)`.

---

## File Map

| File | Purpose |
|------|---------|
| `client/src/lib/bookmark/bookmark-render.ts` | Layout cache, `drawBookmark()`, text wrapping, height computation, two card layouts (full + text), Open-button hit/hover helpers |
| `client/src/lib/bookmark/bookmark-actions.ts` | Side-effecting actions: `openBookmarkUrl(id)` — two-pass URL validation, `window.open(_blank, noopener,noreferrer)` |
| `client/src/lib/bookmark/bookmark-unfurl.ts` | Lifecycle coordinator: pending map, worker commands, atomic Y.Doc writes, placeholder management |
| `client/src/lib/bookmark/bookmark-placeholder.ts` | HTML loading elements: spinner + domain label, camera-tracked positioning |
| `worker/src/unfurl.ts` | Cloudflare Worker: Zod validation, SSRF guard, HTMLRewriter parse, image fetch/R2 store, edge cache |
| `packages/shared/src/utils/url-utils.ts` | `normalizeUrl()`, `isValidHttpUrl()`, `extractDomain()`, `prettifyDomain()` |
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
  │     ├── canCreateBookmark() false (offline) → pasteUrlAsText(url) → text object, done
  │     └── beginUnfurl(url, worldX, worldY)    [bookmark-unfurl.ts]
  │           ├── objectId = ulid()              (pre-generated, not yet in Y.Doc)
  │           ├── domain = extractDomain(url)
  │           ├── pendingBookmarks.set(objectId, { url, domain, worldX, worldY })
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
  └── unfurlDirect(objectId, url)  — single direct fetch, no IDB queue
        ├── GET /api/unfurl?url=<encoded>
        │     ↓
        │   worker/unfurl.ts:
        │     ├── Zod validation + SSRF guard (middleware via zValidator)
        │     ├── Edge cache check (SHA-256 of normalized URL)
        │     ├── Content-type branching:
        │     │   ├── image/* → direct image storage, filename as title → 200
        │     │   ├── text/html | application/xhtml+xml | application/xml → HTMLRewriter
        │     │   └── anything else → 204
        │     ├── HTMLRewriter: og:title, og:image, og:image:secure_url, twitter:*, <title>, favicon
        │     │   (meta tags checked via `property || name` — handles both attribute styles)
        │     ├── parseImageDimensions(bytes, mimeType) → { width, height } from binary headers
        │     ├── Parallel image fetch → SHA-256 → R2 put (content-addressed dedup)
        │     ├── Substance check: must have title OR ogImage → 200, else → 204
        │     └── Response codes: 200 (success, cached 7d), 204 (no metadata), 400 (bad URL), 502 (fetch failed)
        │
        ├── 200 → post({ type: 'unfurled', objectId, data })
        │     ↓
        │   image-manager.ts → handleUnfurlResult(objectId, data)
        │     ↓
        │   bookmark-unfurl.ts:
        │     Pending entry found:
        │       ├── Substance check: has title OR ogImageAssetId?
        │       │   ├── No → pasteUrlAsText(url, worldX, worldY, objectId) → text object fallback
        │       │   └── Yes → computeBookmarkHeight(data) → frame centered on worldX, worldY
        │       │         └── Y.Doc mutate: SINGLE ATOMIC TRANSACTION with ALL fields
        │       ├── removePlaceholder(objectId)
        │       └── pendingBookmarks.delete(objectId)
        │
        │     No pending entry (page refresh recovery):
        │       └── Check Y.Doc for objectId → upgrade if found, discard if not
        │
        └── Non-200 (204, 4xx, 5xx, network error) → post({ type: 'unfurl-failed' })
              ↓ handleUnfurlFailed(objectId):
                ├── pasteUrlAsText(url, worldX, worldY, objectId) → text object fallback
                ├── removePlaceholder(objectId)
                └── pendingBookmarks.delete(objectId)
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

**Key difference from images:** Bookmarks always use `ppsp = Infinity` (full-resolution, no mip level selection). OG images are ≤300wu wide (card width), favicons 18×18.

### Hydration (Room Join)

```
hydrateObjectsFromY()
  ├── Y.Map walk → ObjectHandle with kind: 'bookmark', collected into mediaHandles[]
  ├── BBox: frame-based with shadow padding (frame[2] * NOTE_SHADOW_PAD_RATIO)
  └── hydrateImages(mediaHandles): per handle → collect ogImageAssetId + faviconAssetId at level 0 using handle.bbox
```

No main-thread scan for pending bookmarks — unfurls are direct fetch (no IDB queue).

---

## Pending Bookmarks (Local-Only State)

```typescript
// bookmark-unfurl.ts
interface PendingBookmark {
  url: string;
  domain: string;
  worldX: number;          // Paste position
  worldY: number;
  objectId: string;        // Pre-generated ULID
}

const pendingBookmarks = new Map<string, PendingBookmark>();
```

This Map exists only on the creating client's main thread. Other clients never see it. Two cases in `handleUnfurlResult`:

| Scenario | Behavior |
|----------|----------|
| Online paste, unfurl succeeds with substance | Single atomic Y.Doc write with full data |
| Online paste, unfurl returns empty/fails | `pasteUrlAsText()` → text object fallback |
| Offline paste | Never enters pipeline — `canCreateBookmark()` returns false → text object immediately |
| Page refresh with stale IDB entry | No pending entry → check Y.Doc by objectId → upgrade if found |

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

**Visual:** 300×48px white card with 8px border-radius, subtle box-shadow, containing a 16px spinning circle + 12px domain text. Spinner uses CSS `@keyframes bk-spin` (injected once into `<head>`).

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

### Two Data-Driven Layouts

No pending/failed visual states — layout determined purely by which metadata fields are present. Offline/failed unfurls create text objects, not bookmarks.

**Full Card** (has `ogImageAssetId`):
```
┌──────────────────────────────┐
│          OG Image            │  ← Variable height (70–250wu, aspect-ratio-aware)
│                  [Open ↗]    │  ← 78×28 button overlaid on image bottom-right
├──────────────────────────────┤
│ Title (bold 14px)            │  ← Max 2 lines, ellipsis (if present)
│ Description (12px gray)      │  ← Max 3 lines, ellipsis (if present)
│ 🔗 Github                    │  ← Favicon 18×18 + prettified site name (13px black)
└──────────────────────────────┘
```

**Text Card** (has `title`, no OG image):
```
┌──────────────────────────────┐
│ Title (bold 14px)            │
│ Description (12px gray)      │
│ 🔗 Github         [Open ↗]   │  ← 78×28 button right-aligned in favicon row
└──────────────────────────────┘
```

Title and description sections are separated by a `SECTION_GAP` (6wu); the same gap precedes the favicon row when any text is present.

### Shadow + Body

Shared with sticky notes via `renderNoteBody(ctx, x, y, w, h, CARD_FILL)` from `core/text/sticky-note.ts`. Draws a dual-layer Gaussian shadow cached per-`(w, h)` (rendered at exact body dimensions, no slicing) + white rounded rect fill (`#FFFFFF`, corner radius `w * NOTE_CORNER_RADIUS_RATIO`). Each unique bookmark height produces one cache entry (LRU-bound). `CARD_RADIUS` (used for OG image top-corner clip) is derived from the same corner-radius ratio — keeps the OG image clip lined up with the body curve and the shared shadow silhouette at the top corners.

### OG Image Drawing

Aspect-ratio-aware display height:

```typescript
function ogDisplayHeight(ogW: number, ogH: number): number {
  if (ogW <= 0 || ogH <= 0) return MIN_OG_H;  // Defensive fallback
  const natural = BOOKMARK_WIDTH * (ogH / ogW);  // Scale to card width
  return Math.min(Math.max(natural, MIN_OG_H), MAX_OG_H);  // Clamp [70, 250]
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

78×28wu rounded rect (radius 6px). White `#FFFFFF` background (hover: `#e8e8e8`), 1px `#d1d5db` border. Left: "Open" text (600 13px Inter, `#374151`). Right: box-arrow icon (stroke `#374151`, lineWidth 1.8, round caps/joins).

- **Full card:** overlaid on OG image, `OPEN_BTN_MARGIN` (10wu) from bottom-right of image area
- **Text card:** right-aligned in domain row, vertically centered with favicon

### Favicon + Display Name

18×18wu favicon drawn via `getBitmap(props.faviconAssetId)` from `image-manager.ts`. Positioned at left edge of the favicon row, 6wu gap before the display name. The display name is the prettified site name (`prettifyDomain(domain)` → "Github", "Excalidraw", …), rendered in 13px regular Inter, black (`#1a1a1a`). It is **not** a link — no hover state, no click target. The prettified form is computed once per layout-cache fill and stored on `BookmarkLayout.displayDomain`.

### Layout Cache

```typescript
interface BookmarkLayout {
  titleLines: string[];       // Wrapped title, max 2 lines
  descLines: string[];        // Wrapped description, max 3 lines
  totalHeight: number;        // Computed total card height
  hasOgImage: boolean;        // OG image available (!!ogImageAssetId)
  ogDisplayH: number;         // Clamped display height [70, 250]
  displayDomain: string;      // Prettified site name (prettifyDomain(domain))
}
```

Module-level `Map<string, BookmarkLayout>` keyed by object ID. Computed on first render via `getLayout(id, props)`. **Text measurement uses the shared `measureTextCached()` from `core/text/text-system.ts`** — same offscreen canvas and font-state cache as text/note layout, no duplicate measurement context. `buildLayout(data)` is the single source of truth: cache wrapper (`getLayout`) and one-shot height path (`computeBookmarkHeight`) both call it.

**Text wrapping** (`wrapText`) is robust against oversized single tokens: a word wider than the card character-breaks across as many lines as needed (subject to `maxLines`), so a long URL/hash inside a title can never overflow. Truncation uses binary search on prefix width, and char-break / truncation both clamp to UTF-16 surrogate-pair boundaries.

**Invalidation:**
- `bookmarkCache.evict(id)` — on object deletion (called from `renderer/object-cache.ts`)
- `bookmarkCache.clear()` — full cache clear (called from `renderer/object-cache.ts` on room teardown)
- Layout auto-recomputes on next render when Y.Map properties change (title, description, assets arrive via unfurl)

### Height Computation

```typescript
// Height formulas (titleToDesc + textToDomain inserted iff the adjacent sections are non-empty):
Full:      ogDisplayH + CARD_PADDING + titleH + titleToDesc + descH + textToDomain + FAVICON_SIZE + CARD_PADDING
Text:      CARD_PADDING + titleH + titleToDesc + descH + textToDomain + FAVICON_SIZE + CARD_PADDING
Defensive: CARD_PADDING + FAVICON_SIZE + CARD_PADDING

// Where:
titleH       = titleLines.length * TITLE_LINE_H   (19px per line)
descH        = descLines.length * DESC_LINE_H     (16px per line)
titleToDesc  = SECTION_GAP if (titleLines && descLines) else 0
textToDomain = SECTION_GAP if (titleLines || descLines) else 0
FAVICON_SIZE = 18                                  (favicon row height)
```

`computeBookmarkHeight(data)` is called before Y.Doc write (to set frame height). Delegates to the same `buildLayout(data)` used by `getLayout` — no duplicate wrap/measure path.

### Hit-Test & Hover Helpers

Exported types and functions for SelectTool integration:

```typescript
interface LocalRect { lx: number; ly: number; lw: number; lh: number }

// Frame-local bounds of the "Open" button — card width is always BOOKMARK_WIDTH
// in local space (scale applied at draw-transform level, not here). Returns a
// module-scope MUTABLE scratch: copy fields if calling twice before consuming.
getOpenButtonLocalBounds(layout) → LocalRect

// World-space hit test against the Open button rect. Caller responsible for
// occlusion (SelectTool gates on `pickTopmostPaint` first). Reads layout +
// frame caches; both must be populated (layout/frame is null before first
// render → returns false).
hitTestOpenButton(handle, worldX, worldY) → boolean

// Paint the Open button in its hover state on top of the base canvas's already-
// painted non-hover button. Called by selection-overlay BEFORE selection
// primary visuals so bbox stroke + resize handles render above. Same
// translate+scale math as drawBookmark — pixels align exactly.
drawHoveredOpenButton(ctx, id) → void
```

`getOpenButtonLocalBounds` returns coordinates **frame-local** (relative to bookmark frame origin, pre-scale). Convert to world by `frame[0] + lx * scale`, `frame[1] + ly * scale`. The prettified display name is plain text — no hit-test bounds.

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
- Validated via `validateImage(bytes)` → PNG/JPEG/WebP/GIF/ICO
- Dimensions parsed from binary headers via `parseImageDimensions(bytes, mimeType)`:
  - PNG: IHDR bytes 16-23 (big-endian uint32)
  - JPEG: scan SOF0/SOF2 markers for width/height
  - WebP: VP8 (lossy), VP8L (lossless), VP8X (extended — alpha/EXIF/animation)
  - GIF: bytes 6-9 (little-endian uint16)
  - ICO: first image entry at bytes 6-7 (0 = 256)
- Content-addressed: `SHA-256(bytes)` → `assetId`, `R2.head()` dedup before write

### Edge Cache

Synthetic key: `https://unfurl.avlo.internal/<sha256(normalizedUrl)>`. TTL: 7 days (`Cache-Control: public, max-age=604800`). `waitUntil(cache.put(response.clone()))` — non-blocking.

### Response Codes

| Status | Meaning | When | Cache? |
|--------|---------|------|--------|
| **200** | Unfurl succeeded with useful data | Has `title` OR `ogImageAssetId` | 7 days |
| **204** | No useful metadata extracted | HTML parsed but no title/OG image, or non-HTML/non-image content | No |
| **400** | Invalid URL | Zod validation / SSRF guard | No |
| **502** | Upstream fetch failed | Network error, non-OK response, timeout | No |

Only 200 responses are edge-cached. All logging prefixed with `[unfurl]`.

---

## Image Worker Unfurl

**Direct fetch, no IDB queue.** Offline pastes never enter the bookmark pipeline (`canCreateBookmark()` guard), so there's nothing to retry. All failures are final — create a text object.

`unfurlDirect(objectId, url)` in `image-worker.ts` (primary only): single fetch to `/api/unfurl`, posts `'unfurled'` on 200 or `'unfurl-failed'` on any other status/error. Strips `url`/`domain` from server response (already known client-side).

---

## Clipboard Integration

### URL Detection (`extractLeadingUrl`)

Checks if first line of pasted text is a valid HTTP(S) URL via `normalizeUrl()`. Returns `{ url, remainder }` or `null`.

- Single URL → bookmark (online) or text object (offline)
- URL + newline + text → bookmark/text + text object (split)
- Multi-word text → standard text paste
- `ftp://`, `file://` → standard text paste
- Hostname without `.` (e.g. `http://forum`) → rejected by `normalizeUrl()`, standard text paste

Both `pasteExternalText()` and `pasteExternalHtml()` check `extractLeadingUrl()` first. `createBookmarkFromUrl()` checks `canCreateBookmark()` (offline guard) before entering the unfurl pipeline; offline pastes call `pasteUrlAsText()` directly.

### Internal Paste (Copy/Paste Between Clients)

Bookmarks serialize as plain Y.Map props (url, domain, title, description, asset IDs). All data present on paste — no re-unfurl needed. Full metadata preserved across copy/paste.

---

## Integration Points (Other Files)

### Selection (`selection-utils.ts`, `selection-store.ts`)
- `SelectionKind` includes `'bookmarksOnly'`
- `KindCounts.bookmarks` tracked in composition
- Returns `EMPTY_STYLES` (no controls — same as images)

### Hit Testing (`hit-testing.ts`)
- Marquee: `getBookmarkFrame(id)` → `rectsIntersect(frameTupleToWorldBounds(frame), rect)`
- Point: `getBookmarkFrame(id)` → simple rect containment, `isFilled: true` (always opaque)
- No special handle suppression — all handles (corner + side) active for any bookmark selection count

### Selection Overlay (`selection-overlay.ts`)
- Highlight: bbox-based `strokeRect` (includes shadow padding), not frame

### Transform (`transform.ts`, `SelectTool.ts`, `objects.ts`)
Bookmarks use uniform scaling via `scale` property — same pattern as sticky notes.

| Scenario | Corner Handles | Side Handles | Bookmark Behavior |
|----------|---------------|--------------|-------------------|
| bookmarksOnly | Visible | Visible | All handles: uniform scale |
| mixed, corner | Visible | — | Uniform scale |
| mixed, side | — | Visible | Edge-pin translate (bbox bounds) |

- Uniform scale: `roundedScale = round(scale * absScale, 3dp)`, origin from bbox-center preservation
- Edge-pin (mixed+side only): uses bbox bounds (includes shadow padding) since handles are at bbox positions
- `transformFrameForTopology()` / `transformPositionForTopology()` — bookmark cases for connector rerouting
- `drawScaledBookmarkPreview()` — ctx.scale-based preview rendering (matches `drawScaledNotePreview` pattern)

### Connector Integration (`snap.ts`, `reroute-connector.ts`, `selection-store.ts`, `ConnectorTool.ts`)
Bookmarks are connectable objects — rect frame, always treated as filled.

- **Snap:** included in `findBestSnapTarget()` connectable kind filter + always-filled check
- **Reroute:** `resolveEndpoint()` and `resolveNewEndpoint()` include bookmark in kind checks; uses `getBookmarkFrame(handle.id)` for frame lookup
- **Topology:** `computeConnectorTopology()` includes bookmarks in both passes (anchored connector discovery + original frame collection); uses `getBookmarkFrame(handle.id)`
- **ConnectorTool preview:** bookmark included in snap shape frame lookup for snap dot rendering

### Eraser (`EraserTool.ts`)
- `case 'bookmark':` — `getBookmarkFrame(id)` → `circleRectIntersect(wx, wy, radius, x, y, w, h)`

### Bounds (`bounds.ts`)
- `computeRawGeometryBounds`: bookmark in bbox-based branch (alongside notes) — handles are at bbox positions

### BBox (`bbox.ts`)
- `computeBookmarkBBox(id, props)` called from `computeBBoxFor()`. Frame derived from `origin + scale + height`, shadow padding `BOOKMARK_WIDTH * scale * NOTE_SHADOW_PAD_RATIO` (imported from sticky-note — single source of truth for shadow halo extent).

### Object Cache (`object-cache.ts`)
- No bookmark-specific case — bookmarks have no Path2D or ConnectorPaths geometry cache

### Renderer (`objects.ts`)
- `case 'bookmark': drawBookmark(ctx, handle)` in `drawObject` switch
- Scale preview: `drawScaledBookmarkPreview()` — ctx.scale-based uniform scale (matches note pattern). Mixed+side: edge-pin translate.

### Room Doc Manager (`room-doc-manager.ts`)
- Hydration: standard `computeBBoxFor()` (frame-based with shadow padding)
- Observer: bbox recomputes on any Y.Map property change
- Deletion: `bookmarkCache.evict(id)` via `removeObjectCaches`

### Canvas Runtime (`CanvasRuntime.ts`)
- `stop()` calls `cleanupOnRoomTeardown()` (clears placeholders + pending map)

### Image Manager (`image-manager.ts`)
- `handleWorkerMessage`: routes `'unfurled'` → `handleUnfurlResult()`, `'unfurl-failed'` → `handleUnfurlFailed()`
- `manageImageViewport()`: registers bookmark OG image + favicon with `ppsp = Infinity`, calls `repositionAllPlaceholders()`
- `hydrateImages(handles)`: receives pre-filtered image+bookmark handles from `hydrateObjectsFromY`; per bookmark handle, registers `ogImageAssetId` + `faviconAssetId` at level 0 using `handle.bbox`

### Service Worker
No changes needed. `/api/assets/*` cache-first handles OG images and favicons. `/api/unfurl` falls through as non-asset API.

---

## Constants

```
BOOKMARK_WIDTH     = 300       Card width (fixed)
CARD_PADDING       = 14        Inner padding
SECTION_GAP        = 6         Gap between title/description/favicon-row sections
MIN_OG_H           = 70        Minimum OG image display height
MAX_OG_H           = 250       Maximum OG image display height
TITLE_FONT_SIZE    = 14        Bold Inter, #1a1a1a
DESC_FONT_SIZE     = 12        Regular Inter, #6b7280
DISPLAY_FONT_SIZE  = 13        Regular Inter, #1a1a1a (prettified site name)
TITLE_LINE_H       = 19        Title line height
DESC_LINE_H        = 16        Description line height
TITLE_MAX_LINES    = 2
DESC_MAX_LINES     = 3
FAVICON_SIZE       = 18        18×18; also the favicon-row height
FAVICON_GAP        = 6         Gap between favicon and display name
CARD_FILL          = '#FFFFFF'
CARD_RADIUS        = getNoteCornerRadius(BOOKMARK_WIDTH)   // 18 at base width, derived from sticky-note ratio so OG image top-corner clip aligns with shared shadow-body silhouette
OPEN_BTN_W         = 78        Open button width
OPEN_BTN_H         = 28        Open button height
OPEN_BTN_RADIUS    = 6         Open button border radius
OPEN_BTN_MARGIN    = 10        Margin from card edges
PLACEHOLDER_H      = 48        HTML placeholder height (width = BOOKMARK_WIDTH)
```

---

## Edge Cases

| Scenario | Handling |
|----------|----------|
| **Online paste, unfurl succeeds** | HTML placeholder → worker fetch → atomic Y.Doc commit with all data → placeholder removed |
| **Online paste, unfurl fails/empty** | HTML placeholder → worker returns non-200 or empty data → `pasteUrlAsText()` → text object → placeholder removed |
| **Offline paste** | `canCreateBookmark()` returns false → `pasteUrlAsText()` → text object immediately, no placeholder ever |
| **Page refresh with stale IDB entries** | No pending map entry → check Y.Doc by objectId → upgrade if found, discard if not |
| **Internal paste** | All data copied as-is from Y.Doc. No re-unfurl. Full metadata preserved. |
| **Undo after online commit** | Single atomic transaction → undo removes entire bookmark cleanly |
| **Room teardown mid-unfurl** | `cleanupOnRoomTeardown()` clears placeholders + pending map. Worker result arrives → `hasActiveRoom()` false → discard |
| **Multiple rapid pastes** | Each gets unique objectId, own placeholder. Independent lifecycles. |
| **Multi-client** | Client A pastes URL → Client B sees nothing until bookmark appears fully formed (no pending state visible) |

---

## NOT Implemented

- **Double-click behavior** — no editing mode (bookmarks are not editable)
- **Context menu actions** — no bookmark-specific toolbar bar
- **Re-unfurl** — no way to retry from UI (failures are final → text object)
- **URL editing** — URL is immutable after creation
