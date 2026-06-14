# Bookmark Subsystem

URL bookmarks — paste a URL, get a card with OG image, title, description, domain, and "Open" button. Offline pastes never enter the pipeline (text fallback). Online failures also fall back to text. Loading state is local-only via HTML placeholder; Y.Doc receives **one atomic transaction** once unfurl completes. No `unfurlStatus` field — other clients never see pending state.

---

## Y.Doc Schema

```typescript
{
  id, kind: 'bookmark', ownerId, createdAt,
  url: string,                 // Normalized (http/https only, no fragment, no trailing /)
  domain: string,              // Hostname minus www. (stored, not derived in render path)
  origin: [x, y],              // Top-left at base scale
  height: number,              // Card height at base scale (data-driven via computeBookmarkHeight)
  scale?: number,              // Uniform scale (default 1)

  // Set by worker on successful unfurl (all optional):
  title?: string,
  description?: string,
  ogImageAssetId?: string,     // SHA-256 hex in R2
  ogImageWidth?: number,
  ogImageHeight?: number,
  faviconAssetId?: string,     // Raster favicons only — SVGs rasterized client-side before write
}
```

Width is fixed at `BOOKMARK_WIDTH = 300`. Frame is derived: `[origin[0], origin[1], 300*scale, height*scale]`. No stored frame — computed via `computeBookmarkBBox()` and cached in `bookmarkFrameCache`. Read via `getBookmarkFrame(id) → FrameTuple | null`.

**Card variant is determined by which fields are present:**
- Full card → `ogImageAssetId` present (with or without title)
- Text card → `title` present, no OG image
- No minimal/failed visual — offline/failed unfurls become text objects, never bookmarks

---

## File Map

| File | Purpose |
|------|---------|
| `core/bookmark/bookmark-render.ts` | Layout cache, 3-slice shadow cache, `drawBookmark()` (hover-aware), `renderBookmarkBody`, text wrapping, height computation, two card layouts, Open-button hit-test + world-bbox helpers, `computeBookmarkBBox`, `getBookmarkFrame`, `BOOKMARK_WIDTH`, `bookmarkCache` |
| `core/bookmark/bookmark-actions.ts` | `openBookmarkUrl(id)` — two-pass URL validation, `window.open(_blank, noopener,noreferrer)` |
| `core/bookmark/bookmark-unfurl.ts` | Lifecycle: pending map, `beginUnfurl`, `handleUnfurlResult`/`handleUnfurlFailed`, `canCreateBookmark`, `cleanupOnRoomTeardown`, SVG favicon rasterization |
| `core/bookmark/bookmark-placeholder.ts` | HTML loading element (spinner + domain), camera-tracked positioning |
| `workers/unfurl/src/unfurl.ts` | CF Worker route — Zod validation, SSRF guard, HTMLRewriter, image fetch/R2 store, edge cache |
| `workers/unfurl/src/app-type.ts` | Public mock app + `UnfurlResponseBody` wire contract |
| `packages/shared/src/utils/url-utils.ts` | `normalizeUrl`, `isValidHttpUrl`, `extractDomain`, `prettifyDomain` |
| `core/accessors.ts` | `getBookmarkProps`, `getBookmarkUrl` |

---

## Data Flow

### Paste → Placeholder → Unfurl → Atomic Write

```
User pastes text
  ↓ clipboard-actions.ts: extractLeadingUrl(text)  [module-private]
  ↓ first line is HTTP(S) URL? → createBookmarkFromUrl(url)  [module-private]
    ├── canCreateBookmark() false (offline) → pasteUrlAsText() → done
    └── beginUnfurl(url, wx, wy)  [bookmark-unfurl.ts]
          ├── objectId = ulid()  (pre-generated, not yet in Y.Doc)
          ├── pendingBookmarks.set(objectId, { url, domain, wx, wy, objectId })
          ├── createPlaceholder(objectId, domain, wx-150, wy-24)
          └── postToPrimary({ type: 'unfurl', objectId, url })
```

### Worker → Y.Doc

```
image-worker.ts (primary):
  unfurlDirect(objectId, url) → GET /api/unfurl?url=...
    └── 200 → post 'unfurled' with data
    └── non-200/error → post 'unfurl-failed'

image-manager.ts: routes 'unfurled' → handleUnfurlResult, 'unfurl-failed' → handleUnfurlFailed

handleUnfurlResult(objectId, data):
  pending entry found?
    ├── No substance (no title AND no ogImage) → pasteUrlAsText() → text fallback
    └── Substance:
          ├── resolveFaviconAssetId(data)  (SVG → rasterizeSvg → ingest → raster assetId)
          ├── hasActiveRoom() && still pending?  (async work may have torn down room)
          ├── height = computeBookmarkHeight(data); origin centered on paste point
          └── transact(): SINGLE atomic Y.Map write with ALL fields
          ├── removePlaceholder + pendingBookmarks.delete
          └── (optional) auto-select if no tool active
  no pending (page refresh recovery):
    └── getHandle(objectId).kind === 'bookmark'? → upgrade existing fields atomically

handleUnfurlFailed(objectId): pasteUrlAsText fallback + cleanup
```

### Image Pipeline for OG + Favicon

Bookmark asset IDs flow through the **same decode pipeline as images**, but always at level 0 (ppsp = Infinity, no mip selection). The og/favicon ids are sourced from the `BookmarkLayout` cache — no separate metadata map:

- `computeBookmarkBBox` → `getLayout` stores `ogImageAssetId` / `faviconAssetId` on the layout; `bookmarkCache.evict(id)` (via `removeObjectCaches`) clears it on delete
- `manageImageViewport()` — per frame, iterates visible bookmark `ObjectHandle`s (rbush items are handles) + reads `bookmarkCache.getLayoutById`, calls `markAsset(assetId, Infinity, 1, 1, x0,y0,x1,y1)` for both OG + favicon
- `hydrateImages()` (zero-arg) — at room join, reads `bookmarkCache.forEachLayout`; bookmark assets contribute at level 0 using the handle's bbox

OG images ≤ 300wu (card width); favicons 18×18.

---

## Pending Bookmarks (Local-Only)

```typescript
const pendingBookmarks = new Map<string, { url, domain, worldX, worldY, objectId }>();
```

Lives on the creating client only. Other clients never see it. Possible terminal states:

| Scenario | Outcome |
|----------|---------|
| Unfurl succeeds with substance | Single atomic Y.Doc write |
| Unfurl empty/204 or 4xx/5xx | `pasteUrlAsText()` text fallback |
| Offline at paste time | Bypassed entirely — `canCreateBookmark()` false → text immediately |
| Room teardown mid-unfurl | `cleanupOnRoomTeardown()` clears map; late worker reply hits `hasActiveRoom() === false` and bails |
| Page refresh with stale IDB | No pending entry → upgrade Y.Doc object if it exists, else discard |

---

## HTML Placeholder

`bookmark-placeholder.ts`. Loading card is an HTML `<div>` appended to `editorHost`, **not** canvas-rendered. Visible only to the creating client. 300×48px white card, 8px radius, subtle shadow, spinner + domain label. Spinner keyframes injected once into `<head>`.

Position each frame via `repositionAllPlaceholders()` (called from `manageImageViewport`):
```ts
el.style.transform = `translate(${(wx - pan.x) * scale}px, ${(wy - pan.y) * scale}px) scale(${scale})`;
```

Lifecycle: `createPlaceholder` (in `beginUnfurl`) → `removePlaceholder` (on result/fail) → `removeAllPlaceholders` (on room teardown).

---

## Rendering (`bookmark-render.ts`)

### Two Layouts

**Full Card** (`ogImageAssetId` present):
```
┌──────────────────────┐
│      OG Image        │  Variable height (70–250wu, aspect-ratio-aware)
│            [Open ↗]  │  78×28 button overlaid on image bottom-right
├──────────────────────┤
│ Title (bold 14px)    │  Max 2 lines, ellipsis
│ Description (12px)   │  Max 3 lines, gray, ellipsis
│ 🔗 Github            │  18×18 favicon + prettified site name (13px black)
└──────────────────────┘
```

**Text Card** (title only):
```
┌──────────────────────┐
│ Title (bold 14px)    │
│ Description (12px)   │
│ 🔗 Github  [Open ↗]  │  Open button right-aligned in favicon row
└──────────────────────┘
```

`SECTION_GAP` (6wu) inserted only between adjacent non-empty sections.

### Body + Shadow

`renderBookmarkBody(ctx, 0, 0, height, '#FFFFFF')` — `drawBookmarkShadow` + `roundRect` body fill at `BOOKMARK_CORNER_RADIUS` (10wu, fixed; `CARD_RADIUS` aliases it so the OG image top-corner clip stays aligned with the body silhouette).

**Vertical 3-slice shadow cache.** Width and corner radius are constant, so the shadow's horizontal cross-section is identical at every card height — only the vertical sides stretch. Past `R + 1.5·blur` (~28wu) from either horizontal body edge the shadow is fully translation-invariant in y. One `OffscreenCanvas` (`_bookmarkShadow`) is baked per DPR by `ensureBookmarkShadow` — top cap + 2 invariant rows + bottom cap — and `drawBookmarkShadow` blits it in three `drawImage` calls: top cap (no stretch), middle (the 2 invariant rows stretched vertically over `midDestH`), bottom cap (no stretch). No horizontal stretch (`BAKE_W → BAKE_W` is 1:1 in world units), so the baked rounded corners land on the body's exact destination pixels.

Shadow casters (drop + contact gaussian) and the `destination-out` punch all use the same body path at `BOOKMARK_CORNER_RADIUS`, so the punched silhouette matches the destination body fill 1:1 — no AA fringe, no corner wedge. Seam invariant: each cap's innermost source row and the middle's sampled rows are all fully-invariant body rows (pixel-identical), so cap→middle→cap transitions are exact regardless of `midDestH`.

`SHADOW_H_MIN_SUPPORTED` (58wu) is the 3-slice floor; below it `midDestH` clamps to 0 and `computeBookmarkBBox` pads to match. Realistic bookmark min height is ~71 (text-only, 1 title line), so the clamp is defensive-only. Memory: one canvas (~0.6 MB at DPR=2) regardless of bookmark count or distinct heights — replaced a shared 16-entry LRU that thrashed past 16 distinct heights. Pad ratios are bookmark-local (`BOOKMARK_SHADOW_{TOP,SIDE,BOTTOM}_RATIO` = 0.06 / 0.075 / 0.12, exported for the `bbox.ts` fallback).

### OG Image

Aspect-ratio-aware display height: `BOOKMARK_WIDTH * (ogH / ogW)` clamped to `[MIN_OG_H=70, MAX_OG_H=250]`. Clipped to top-rounded rect, vertically center-cropped when natural > display. `#f5f5f5` placeholder while bitmap loads.

### Open Button

Painted in the **same `drawBookmark` pass** as the rest of the card via a `hoveredOpen` boolean — exactly one Open-button emission per visible bookmark per frame. Z-order works naturally: base-canvas occluders stack above it when they should. White (hover: `#e8e8e8`), 1px `#d1d5db` border, 13px text + box-arrow icon (`Path2D` constant).

### Layout Cache

```typescript
interface BookmarkLayout {
  titleLines: string[];           // ≤ TITLE_MAX_LINES (2)
  descLines: string[];            // ≤ DESC_MAX_LINES (3)
  totalHeight: number;            // equals stored `height`
  ogImageAssetId: string | null;  // null → text card; non-null → full card
  faviconAssetId: string | null;  // sole source for the favicon decode
  ogDisplayH: number;
  displayDomain: string;          // prettifyDomain(domain), cached here
}
```

Module-level `Map<string, BookmarkLayout>` keyed by id. `buildLayout(data)` is the single source of truth — both `getLayout(id, props)` (cached) and `computeBookmarkHeight(data)` (one-shot pre-write) call it. Text measurement uses `measureTextCached()` from `core/text/text-system.ts` (same offscreen canvas as text/note).

`wrapText` is robust against oversized tokens (char-break) and clamps to UTF-16 surrogate boundaries. Truncation uses binary search on prefix width.

**Invalidation:**
- `bookmarkCache.evict(id)` — on delete (called from `renderer/object-cache.ts`)
- `bookmarkCache.clear()` — on room teardown
- Insert-only otherwise (`getLayout`); the Case-C unfurl-recovery path in `bookmark-unfurl.ts` evicts before its `transact` so the observer rebuilds a fresh layout

### Hit-Test & Hover Helpers

Exported for SelectTool integration. All return **MUTABLE module scratches** — consume synchronously or copy fields:

```typescript
getOpenButtonLocalBounds(layout): LocalRect              // frame-local (pre-scale)
hitTestOpenButton(handle, worldX, worldY): boolean        // caller gates on pickTopmostPaint first
getOpenButtonWorldBBox(id): BBoxTuple | null              // world-space, padded for 1px stroke
```

`getOpenButtonWorldBBox` returns `null` when caches are empty (pre-first-render or post-deletion) — caller must bail the invalidate.

---

## Open-Button Hover Pipeline

Hover state and paint both live on the **base canvas**. Overlay never paints it.

| Concern | Owner |
|---|---|
| State | `SelectTool.hoveredOpenBookmarkId: string \| null` |
| Per-frame hoist | `objects.ts` module-level `_hoveredOpenBookmarkId`, written once at frame top via `selectTool.getHoveredOpenBookmarkId()` (same pattern as `_textEditingId`) |
| Per-candidate dispatch | `case 'bookmark': drawBookmark(ctx, handle, _hoveredOpenBookmarkId === handle.id)` — one identity compare |
| Transition invalidation | `invalidateWorldBBox(getOpenButtonWorldBBox(id))` from `handleHoverCursor` + `clearBookmarkOpenHoverIfAny` |

**Transitions** (set in `handleHoverCursor`, cleared via `clearBookmarkOpenHoverIfAny`):

| From → To | Invalidation |
|---|---|
| `null → id` (enter) | one bbox |
| `id → null` (leave) | one bbox |
| `id1 → id2` (cross) | two bboxes (scratch reused; `invalidateWorldBBox` consumes synchronously) |
| `id → id` (wiggle) | none — diff guard short-circuits |

**Gesture handoff (openButton press → translate).** When the pointer drifts past `MOVE_THRESHOLD_PX` mid-press, phase promotes to `translate` **without clearing hover**. The renderer's translate path wraps `drawObject(ctx, handle)` in `ctx.translate(tdx, tdy)`, which re-dispatches into `case 'bookmark'` with `hoveredOpen = true` — hover rides the translate naturally. On `end()`, `rehoverFromLastCursor()` re-evaluates against the post-commit frame.

**Scale gestures clear hover** at `SelectTool.begin()` before phase classification. Scale previews route through `renderScaleEntry` → recursive `drawObject` with `hoveredOpen = false`.

**Edge cases:**
- Deletion mid-hover → `getOpenButtonWorldBBox` returns `null`, invalidate bails; the deletion's own bbox invalidation cleans up the full bookmark paint
- Remote move of hovered bookmark → observer updates frame cache + invalidates full bbox; next frame draws bookmark + hover button at new position in one pass
- `onViewChange` / pan / zoom → `rehoverFromLastCursor` → `handleHoverCursor` — same diff guard as cursor moves

---

## Cloudflare Worker — `GET /?url=<encoded>` (`workers/unfurl/`)

Prod: `unfurl.avlo.io/?url=...`. Dev: `/api/unfurl?url=...` via Vite proxy (rewrite strips the prefix, so the worker sees the bare `/`). Client URL building uses `unfurlClient.index.$get({ query: { url } })` from `@avlo/api-client` — typed against `UnfurlResponseBody` exported from `workers/unfurl/src/app-type.ts`.

Middleware: `zValidator('query', unfurlQuery)` (from `@avlo/worker-shared`) — Zod validates, `normalizeUrl()` transforms, SSRF refine rejects private hosts before handler. R2 binding is `IMAGES` (shared with `workers/images`).

### SSRF Guard

```typescript
isPrivateHost(hostname): blocks localhost, [::1], .local, .internal,
  127.x, 10.x, 172.16-31.x, 192.168.x, 169.254.x, 0.x
```

### Content-Type Branching

- `image/*` → direct image storage, filename as title → 200
- `text/html | application/xhtml+xml | application/xml` → HTMLRewriter
- Other → 204

### HTMLRewriter Extraction

Meta tags checked via `property || name` (both attribute styles). Priority order:

| Field | Sources (in order) |
|---|---|
| title | `og:title` → `twitter:title` → `<title>` |
| description | `og:description` → `twitter:description` → `<meta name="description">` |
| ogImage | `og:image:secure_url` → `og:image` → `twitter:image` |
| favicon | `apple-touch-icon` → `<link rel="icon">` / `shortcut icon` |

Body consumed via `.blob()` (not `.text()`).

### Image Processing

`fetchAndStoreImage(assets, url, maxBytes) → { assetId, width, height } | null`:
- Chunked size guard: OG 5 MB, favicon 500 KB
- `validateImage()` (PNG/JPEG/WebP/GIF/ICO) — SVG returned as `faviconSvgBase64` (rasterized client-side)
- `parseImageDimensions(bytes, mimeType)` reads dimensions from binary headers (PNG IHDR, JPEG SOF, WebP VP8/VP8L/VP8X, GIF, ICO)
- Content-addressed: `SHA-256(bytes)` → `assetId`, `R2.head()` dedup before write

### SVG Favicon Path (client-side)

Server returns `faviconSvgBase64` for SVG favicons (avoids server-side rasterization). Client (`bookmark-unfurl.ts: resolveFaviconAssetId`):

```
base64 → Blob('image/svg+xml') → rasterizeSvg() (main-thread <img>+canvas) → PNG Blob
       → ingest() (primary worker: hash + R2 upload + decode) → assetId
```

Failure is non-fatal — bookmark renders without favicon. Async work completes **before** the Y.Doc transact so the write stays atomic with only a raster `faviconAssetId`.

### Edge Cache + Response Codes

Synthetic key: `syntheticCacheUrl('unfurl', sha256(normalizedUrl))` → `https://unfurl.cache.avlo.internal/<sha>` (per-service namespacing from `@avlo/worker-shared/cache-keys`, H7). TTL 7d. `waitUntil(cache.put())`. JSON responses and empty 502/204 bodies all get `applyCsp(headers, 'api-json')` (H5).

| Status | Meaning | Cached |
|---|---|---|
| 200 | `title` OR `ogImageAssetId` present | 7d |
| 204 | No useful metadata | No |
| 400 | Zod/SSRF reject | No |
| 502 | Upstream fetch failed | No |

All worker logs prefixed `[unfurl]`.

---

## Integration Points

### Hit Testing — `core/spatial/hit-dispatch.ts`
Bookmark closes over `getBookmarkFrame(h.id)` via the shared `paddedHit*FromFrame` helpers (same precision-pass model as text and note — bbox carries shadow pad, so the rbush envelope is coarser than the frame). Paint is `'ink'` on hit. All marquee + point picking flows through the spatial pipeline; **no per-bookmark cases in `EraserTool` or `snap.ts`**.

### Selection
- `SelectionKind` value: `'bookmark'` (the type is `ObjectKind | 'none' | 'mixed'`)
- `KindCounts.bookmarks` in composition
- `computeStyles()` returns `EMPTY_STYLES` (no toolbar controls)
- Selection-overlay highlights via bbox-based `strokeRect` (includes shadow padding)
- Open-button hover is **not** painted here — see Open-Button Hover Pipeline

### Transform — `tools/selection/transform.ts`
Origin + uniform scale, same pattern as sticky notes.

| Scenario | Behavior |
|---|---|
| `'bookmark'` selection, corner or side | Uniform scale (`scaleOriginScale` + `commitOriginScale`) |
| `'mixed'`, corner | Uniform scale |
| `'mixed'`, side | Edge-pin translate (`edgePinOffset` + `commitOrigin`) |

`OutOf<'bookmark'> = HasOrigin & HasScale & HasBBox`. Scale preview routes through `renderScaleEntry` → `case 'bookmark'`: `ctx.scale(ratio)` around `out.origin` + recursive `drawObject` (no dedicated preview fn).

### Connector Topology — `tools/selection/connector-topology.ts`
`fillFrameFromBind` for bookmark bind sides: `[origin.x, origin.y, frozen.w × ratio, frozen.h × ratio]` where `ratio = out.scale / frozen.scale`. Frame caches are populated during hydrate and only become `null` post-delete — see `connector-topology.ts:382`.

### Connector Snap + Reroute — `core/connectors/`
Bookmark is in `BINDABLE_KINDS` (`core/types/objects.ts`) — snap and reroute are kind-agnostic via `isBindableKind` / `frameOf`. No per-bookmark branches.

### Frame Resolution — `core/geometry/frame-of.ts`
`frameOf(handle)` dispatch includes `bookmark: (h) => getBookmarkFrame(h.id)`.

### BBox — `core/geometry/bbox.ts`
`case 'bookmark'` → `computeBookmarkBBox(id, props)`. Populates layout + frame caches as side effects. Shadow padding via `BOOKMARK_SHADOW_*_RATIO` (local to `bookmark-render.ts`, asymmetric — extends mostly downward).

### Object Cache — `renderer/object-cache.ts`
No bookmark-specific case (no Path2D/ConnectorPaths). Eviction routes `bookmarkCache.evict(id)` via `removeObjectCaches`.

### Renderer — `renderer/layers/objects.ts`
`case 'bookmark': drawBookmark(ctx, handle, _hoveredOpenBookmarkId === handle.id)` in `drawObject`. Hoist is one identity compare.

### RoomDocManager
- Hydrate / observer: `computeBBoxFor{,Into}` → `computeBookmarkBBox` populates the layout cache (og/favicon ids included) — the documented `computeBBoxFor` cache hook, no ad-hoc registration
- Delete: `bookmarkCache.evict(id)` via `removeObjectCaches`

### CanvasRuntime
- `stop()` → `cleanupOnRoomTeardown()` (clears placeholders + pending map)

### Clipboard (`core/clipboard/clipboard-actions.ts`)
- `extractLeadingUrl(text)` and `createBookmarkFromUrl(url)` are **module-private** — only `pasteUrlAsText` is exported
- Both `pasteExternalText()` and `pasteExternalHtml()` check `extractLeadingUrl()` first
- Internal paste: bookmarks serialize as plain Y.Map props — no re-unfurl, full metadata preserved

### SelectTool — `tools/selection/SelectTool.ts`
- `DownHit` includes `{ kind: 'openButton'; handle }` — set at pointerdown when `hitTestOpenButton` matches
- Promotes to `translate` past `MOVE_THRESHOLD_PX` (hover preserved)
- At pointerup with no drift: re-verifies (`getHandle` fresh + re-tests rect) then `openBookmarkUrl(id)` — synchronous from the user-gesture handler so popup blockers don't fire

---

## Constants (`bookmark-render.ts`)

```
BOOKMARK_WIDTH     = 300
CARD_PADDING       = 14
SECTION_GAP        = 6
MIN_OG_H / MAX_OG_H = 70 / 250
TITLE_FONT_SIZE    = 14  (bold)
DESC_FONT_SIZE     = 12
DISPLAY_FONT_SIZE  = 13
TITLE_LINE_H       = 19;  DESC_LINE_H = 16
TITLE_MAX_LINES    = 2;   DESC_MAX_LINES = 3
FAVICON_SIZE       = 18;  FAVICON_GAP = 6
CARD_FILL          = '#FFFFFF'
BOOKMARK_CORNER_RADIUS = 10   // fixed corner radius; CARD_RADIUS aliases it
OPEN_BTN_W / H     = 78 / 28
OPEN_BTN_RADIUS    = 6;   OPEN_BTN_MARGIN = 10
PLACEHOLDER_H      = 48   (in bookmark-placeholder.ts)
```

---

## NOT Implemented

- Double-click behavior (bookmarks are not editable)
- Bookmark-specific context-menu toolbar
- Re-unfurl from UI (failures are final → text object)
- URL editing (immutable after creation)
