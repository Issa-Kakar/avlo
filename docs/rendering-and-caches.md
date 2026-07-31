# Rendering Pipeline & Cache Architecture

**Read this before touching:** anything in `renderer/`, `runtime/SurfaceManager.ts`,
`components/Canvas.tsx`, or any per-object cache (`textLayoutCache`, `codeSystem`,
`bookmarkCache`, `imageCache`, `geometryCache`, the connector route cache).

**Companion doc:** `docs/object-lifecycle.md` — how the Y.Doc becomes handles and who publishes
the dirty rects this pipeline consumes. Subsystem internals (text layout algorithm, code
tokenization, connector routing, grid shader, image decode pool) live in their own
`CLAUDE.md`s; this doc owns the pipeline and the **cache boundary** — who populates, who
reads, who evicts, and when a read can be null.

---

## File map — `web/src/renderer/`

| File | Responsibility |
|------|----------------|
| `RenderLoop.ts` | Base-canvas singleton. Tile-grid dirty tracking, clear + clip + draw passes, rAF/hidden scheduling. Exports `invalidateWorld{,BBox,All}` |
| `OverlayRenderLoop.ts` | Overlay-canvas singleton. Full clear per frame, tool preview + animation jobs. Exports `invalidateOverlay` |
| `grid/` | Third canvas — standalone WebGPU/Canvas2D dot grid below content ('G' toggles). Own loop + sizing. See `renderer/grid/CLAUDE.md` |
| `types.ts` | `FRAME_CONFIG`, `PF_OPTIONS_BASE` (Perfect Freehand), `getSvgPathFromStroke` |
| `geometry-cache.ts` | Lazy Path2D (stroke/shape) + `ConnectorPaths` (connector) cache; `evictGeometry` / `clearGeometry` |
| `render-accessors.ts` | Per-kind `readXxxRender(y)` fast Y.Map readers into module scratches. Hot path only |
| `object-cache.ts` | Unified eviction fan-out: `removeObjectCaches(id, kind)`, `clearAllObjectCaches()` |
| `layers/objects.ts` | The base-canvas object pass — `drawObjects`, per-kind leaf draws, transform re-injection |
| `layers/selection-overlay.ts` | Selection highlights, bounds rect, handles, marquee |
| `layers/tool-preview.ts` | Active-tool preview dispatcher (the overlay's only world-space entry) |
| `layers/connector-preview.ts` | In-flight connector overlay |
| `layers/connector-render-atoms.ts` | Shared connector draw atoms (`paintConnector`, `paintConnectorFromPoints`, `drawAnchorDot`, dash guides) |
| `layers/connector-flow.ts` | Connector-flow overlay: N/S/E/W buttons, hover preview, live flow-drag connector |
| `layers/shape-preview.ts` | In-flight shape draw + `paintShapeFrame` (reused by scale preview) |
| `layers/stroke-preview.ts` | In-flight Perfect Freehand stroke |
| `layers/eraser-dim.ts` | Dim hovered objects under the eraser via `'screen'` blend |
| `layers/handle-stamp.ts` | Resize-handle bitmap stamp — pre-rendered offscreen, blitted (no per-frame `shadowBlur`) |
| `animation/AnimationController.ts` | Singleton animation-job manager; push-based invalidation |
| `animation/EraserTrailAnimation.ts` | Decaying eraser-stroke trail |

---

## 1. Five layers, three canvases

`components/Canvas.tsx` mounts a `position: relative` container (`backgroundColor: #fafafa`)
with five absolutely-positioned children:

| z | Element | Notes |
|---|---|---|
| 0 | **grid canvas** | `pointerEvents: none`. Backing store is 0×0 when the grid is off — near-zero memory. Owns its own context, sizing, and on-demand rAF (`renderer/grid/CLAUDE.md`) |
| 1 | **base canvas** | `touchAction: none`, **no** `pointerEvents: none` — all pointer input lands here |
| 2 | **overlay canvas** | `pointerEvents: none` |
| 3 | **editor host** (`.dom-overlay-root`) | `pointerEvents: none`; Tiptap / CodeMirror overlays mount here |
| 4 | **cursor host** (`.cursor-host`) | `pointerEvents: none`, `contain: layout style`. Peer cursors are DOM `<img>`, **not** canvas — that is how they sit above the editor overlay |

The base canvas **clears to transparent** (`clearRect`, never `fillRect`), so the grid canvas
and the container's `#fafafa` show through between objects. Any change that fills the base
canvas opaquely breaks the grid.

### Surfaces, DPR, and the deferred resize (`runtime/SurfaceManager.ts`)

`SurfaceManager` owns module-level refs for `baseCtx` / `overlayCtx` / `editorHost` /
`cursorHost` (both contexts created with `{ willReadFrequently: false }`; it throws if either
is unavailable). It registers the **base** canvas with the camera store for coordinate
transforms, installs a `ResizeObserver` on the container, and a self-rearming
`matchMedia('(resolution: Ndppx)')` listener for DPR changes.

`updateCanvasSize` **never touches the canvases.** It computes
`pixelW/H = min(round(cssW/H * dpr), 16384)`, derives
`effectiveDpr = min(pixelW/cssW, pixelH/cssH)`, stashes the pending size, and pushes
`setViewport(cssW, cssH, effectiveDpr)` into the camera store.

> **`useCameraStore.dpr` is the *achieved* device ratio, not `window.devicePixelRatio`.** Past
> the 16384 clamp they diverge. Read DPR from the store, never from `window`.

`applyPendingResize()` is the only writer of canvas backing stores, and resizes **base and
overlay together to identical dimensions**. It is a global one-shot consumed by whichever loop
ticks first, and it early-returns `false` when the dims already match — so its return value is
**not** a reliable "something changed" signal. That is why both loops keep their own
`lastCanvasW/H` and force a repaint on mismatch.

---

## 2. Base canvas — the dirty-rect engine (`RenderLoop.ts`)

The base canvas repaints **only the regions published through `invalidateWorld*`**. This is
the single most bug-prone contract in the codebase; the root `CLAUDE.md` invariant
("Dirty-rect ↔ WYSIWYG") is the rule, this section is the mechanism.

### There is no rect coalescing — it is a tile bitset

| Constant | Value | Role |
|---|---|---|
| `TILE_SHIFT` / `TILE_SIZE` | `3` / `8` | 8 device-px tiles, grid anchored at (0,0) |
| `AA_MARGIN` | `2` | device px added on every side of every published rect |
| `AREA_RATIO` | `0.85` | promotion threshold → `fullClear` |
| `CLIP_CAP` | `32` | max emitted rects; beyond it, collapse to the active bbox |
| `MAX_RECTS` | `256` | `dirtyBuf` / `clipWorldBuf` capacity (headroom over `CLIP_CAP`) |
| `NATIVE_RAF` | `true` | vsync; the 60 fps throttle branch is dead code as shipped |

State: `grid: Uint32Array` — a row-major occupancy bitset, `wordsPerRow` words per tile row —
plus an inclusive active sub-rect in tile coords (`minTX/minTY/maxTX/maxTY`), and two
`Int32Array` run buffers for extraction. Insertion is a **word-parallel OR splat**: idempotent,
so overlap elimination is free and there is no O(n²) merge tail. Cost is a function of tile
resolution, not damage pattern.

### World → device

```
s = camScale * camDpr
deviceMinX = floor((worldMinX - camPanX) * s - AA_MARGIN)
deviceMaxX = ceil ((worldMaxX - camPanX) * s + AA_MARGIN)
```

Then `mark()` clamps to the canvas (off-canvas rects clamp away to a no-op — transform and
topology publishers do not viewport-gate), promotes to `fullClear` if the single rect exceeds
85 % of the canvas, else splats.

**Every published rect therefore gets padded twice:** `AA_MARGIN` 2 device px, then snapped
outward to the 8-device-px tile grid. This absorbs sub-pixel AA bleed — it does **not** excuse
an under-sized bbox at world scale, where a stroke half-width can be hundreds of device px.

The camera used for the conversion is a per-window cache (`camScale/camPanX/camPanY/camDpr`),
valid because **any camera change forces `fullClear`** (see below).

### Per-frame resolution

At `tick()`: if `!fullClear && hasGridDamage`, popcount the active sub-rect; if more than 85 %
of *all* grid tiles are set → `fullClear`. Otherwise extract: per tile row, RLE the set-bit
runs, then vertically run-merge against the previous row into ≤ `CLIP_CAP` device-px
rectangles. Exceeding the cap returns **one** rect covering the whole active sub-rect
(`collapseActive`) — a bounded fallback, *not* a full clear.

### Frame order

1. `applyPendingResize()`; independent dim-change check → `fullClear`, plus a **150 ms
   native-rAF window** (`nativeRafUntil`) of continuous full redraws so the GPU warms its font
   cache after a context reset.
2. One camera `getState()`; bail on non-positive css size or non-finite scale/pan.
3. Cache camera, `ensureGrid(pixelW, pixelH)` (a grid resize itself forces `fullClear`).
4. **`manageImageViewport()`** — decode-visible / evict-off-viewport / mip selection runs here,
   every frame. It is a real pipeline stage, not a side effect.
5. Resolve dirty region (above). If nothing to do, reset the grid and return.
6. **Clear pass** under identity transform: `clearRect` full-canvas, or per dirty rect.
7. **Draw pass** under `setTransform(s, 0, 0, s, -pan.x * s, -pan.y * s)` where `s = dpr * scale`.
   When clipped, each device rect is converted back to world (`px * invS + pan`), written into
   `clipWorldBuf`, and added to one `ctx.rect()` path → a single `ctx.clip()`.
8. `drawObjects(ctx, hasClip ? clipWorldBuf : null, clipCount)`.

`clipWorldBuf` does **double duty**: the canvas clip region *and* the per-object AABB cull
array that `drawObjects` scans.

### The three invalidation entry points

| Export | Argument | Behaviour |
|---|---|---|
| `invalidateWorldBBox(bbox)` | `BBoxTuple` | The one you want. No allocation |
| `invalidateWorld(bounds)` | `WorldBounds` object | Identical math on the object form. **Currently zero call sites** — kept for the object-form API |
| `invalidateWorldAll()` | — | `fullClear = true`, drop pending rects, schedule |

Two behaviours that surprise people:

- **Once `fullClear` is latched, `invalidateWorld{,BBox}` are total no-ops** — they don't even
  schedule a frame. Safe, because whatever set `fullClear` already scheduled one.
- **Every camera change forces a full clear**, via `RenderLoop`'s own `subscribeCamera`. Pan,
  zoom, resize and DPR changes are not dirty-rect events at all.

### Scheduling

One in-flight rAF at a time (`rafId` gate). The callback ticks, then re-schedules if
`needsFrame` is still set. When the tab is hidden the rAF is cancelled and a `setInterval` at
`FRAME_CONFIG.HIDDEN_FPS` (8 fps) drives `tick()` directly; unhiding cancels it and resumes
rAF. `FRAME_CONFIG.TARGET_FPS` / `MOBILE_FPS` are read only inside the dead throttle branch;
`TARGET_MS` is unread.

`DEBUG_DIRTY` (compile-time `false`) publishes `globalThis.__dirtyStats` with rect count, true
vs emitted area, overdraw ratio and extract ms. Flip it when tuning damage patterns.

---

## 3. Overlay canvas (`OverlayRenderLoop.ts`)

No dirty rects at all — **full transparent clear every frame**. Scheduling is a single `rafId`
flag: `invalidateOverlay()` no-ops when a frame is already pending or the loop hasn't started
(pre-mount awareness/Y updates from another tab would otherwise pollute state).

Frame body, in order:

1. `applyPendingResize()`, context fetch, own dim-change check → re-invalidate.
2. Camera read (guard is `cssWidth <= 1`, one off from the base loop's `<= 0`).
3. Full `clearRect(0, 0, cssWidth * dpr, cssHeight * dpr)` under identity transform.
   *(Note: the extent comes from css×dpr, not `ctx.canvas.width` — they diverge past the 16384
   clamp.)*
4. **World transform applied once** → `drawToolPreview(ctx)` → restore.
5. **Screen space** → `getAnimationController().run(ctx, now)`; each job owns its own DPR
   transform.

Three things invalidate it automatically: any camera change, an active-tool switch (evicts a
live preview), and animation jobs. `AnimationJob.frame(ctx, now, dt) => boolean` returning
`true` re-invalidates — that is the whole animation drive loop. The controller's invalidator is
wired in `start()`; the only registered job is `EraserTrailAnimation`.

**All selection chrome renders through `drawToolPreview`'s `'selection'` case**, which is
reachable only when `SelectTool` is the active tool and its `getPreview()` returns the
`{ kind: 'selection' }` sentinel (non-null when there is a selection, a live marquee, or a
connector-flow drag). `drawSelectionOverlay` runs inside world-transform scope and scales every
stroke width by `1 / scale` so chrome stays screen-constant.

---

## 4. The object pass (`layers/objects.ts`)

One export: `drawObjects(ctx, clipBuf: Float64Array | null, clipCount: number)`. Sole caller is
`RenderLoop.tick()`.

**Per-frame hoisting.** Everything the leaf draws need is resolved once at frame top and never
re-read per object: one `useSelectionStore.getState()`, the text/code editing ids, the hovered
bookmark id, the transform topology map + attached-connector set, the endpoint-drag entry, the
translate delta as two scalars, and the viewport tuple. Leaf `draw*` functions read the module
`let`s, not the store.

**Flow:**

1. `spatialIndex.queryBBox(viewport)` → `ObjectHandle[]` **directly** (the handle *is* the rbush
   item, so there is no entry→handle indirection).
2. **Cull loop.** During a transform, skip selected and topology-attached ids — they are
   re-injected below by preview bbox. When clipped, keep a handle only if its envelope overlaps
   at least one clip rect.
3. **Inject cull** (`cullInjected`) — a pre-dispatched outer `switch` on `transform.kind` so the
   inner loop stays monomorphic. Translate writes the shifted bbox into a module scratch (no
   alloc); scale reads `entry.out.bbox`; endpoint-drag skips the loop entirely and reads the
   single synthetic entry.
4. **Z sort.** `zOrder.ensureRanksValid(objectsById.values())` (dirty-flag guarded — clean
   frames early-out on one boolean), then `sort(zOrder.handleAscCmp)`: a branchless
   `ranks[a.slot] - ranks[b.slot]` over the SoA `Uint32Array`. Ranks are rebuilt by sorting on
   the fractional `z` key with an id tie-break. **Sorting is by z-rank only — there is no
   fill-aware ordering in the renderer** (fill-awareness is a hit-testing concept; see
   `core/spatial/CLAUDE.md`).
5. **Draw loop**, bottom → top:
   - **connector** → one `Map.get` (topology) *or* one string compare (endpoint drag) to resolve
     a `ConnectorEntry`, then `drawConnectorEntry` switching on `ce.mode`:
     `'static'` → `drawConnector`; `'translate'` → `translate(tdx,tdy)` + `drawConnector`;
     `'reroute'` → `drawConnectorFromPoints(ce.pointsBuf, ce.validCount)`. Endpoint drag exposes
     a synthetic `mode: 'reroute'` entry so it shares this path exactly.
   - **non-connector, not selected / not transforming** → `drawObject(ctx, handle)`.
   - **translate** → `save / translate(tdx, tdy) / drawObject / restore`, **inline** — it never
     goes through `renderScaleEntry`.
   - **scale** → `renderScaleEntry(ctx, handle)`.

`drawObject` dispatches on `handle.kind` to eight leaves: `drawStroke` and `drawShape` (via the
geometry cache), `drawText` and `drawCode` (via layout caches), `drawImage` (`getImageMeta` +
`getBitmap`), `drawConnector` (`ConnectorPaths`), and out to `drawStickyNote` /
`drawBookmark`, which own their own layout lookups.

**Editing ids are skipped, not dimmed** — `drawText`, `drawCode`, `drawShapeLabel` and the
connector label all bail when the id matches the hoisted editing id, because a DOM overlay is
painting them. The connector case still runs its clip-out first, so the route stays cut behind
the editor.

**Cold-miss guards.** `drawText` / `drawCode` / `drawImage` / `drawStickyNote` return early on
a missing layout or bitmap. These are genuine races against async producers, not defensive
padding — see §6.

**Scale preview.** `renderScaleEntry` resolves `getScaleEntry(kind, id)` and, for most kinds,
`getScaleBehavior(kind)` → reflow / uniform / else `renderTranslatedEntry`. `shape` and `image`
skip the behaviour check entirely (always frame/bbox-driven). There is **no connector arm** —
connectors take the `drawConnectorEntry` path. The per-kind behaviour matrix lives in
`tools/selection/CLAUDE.md`; do not duplicate it here.

---

## 5. Hot-path Y.Map reads (`render-accessors.ts`)

Each leaf draw calls exactly one `readXxxRender(y)` that pulls **only the keys it paints**
straight off Yjs's internal `_map` (~10 ns/key) instead of the public `y.get()` (~109 ns/key),
into a per-kind module scratch which it returns by reference.

Two helpers, split by Content subclass, so every call site stays monomorphic:

- **`readPrim<T>`** — `ContentAny` (every primitive / array / object value). Reads `content.arr[0]`
  directly, skipping `getContent()`. Valid because `Y.Map._map` items always have length 1.
- **`readY<T>`** — `ContentType` (nested Y types). Reads `content.type` directly, skipping the
  `[this.type]` allocation `getContent()` would make. Used for exactly one key: `'content'`, in
  the two shape-label readers.

Both check **`!val.deleted`**: Yjs *tombstones* an item on `.delete(key)` rather than removing
it from `_map`, so without the guard a cleared `fillColor` would keep reading its old value.

**Scratch contract:** each reader returns the same object every call. Safe only because each
`draw*` consumes its scratch fully before any other reader runs. If you add a reader call into
the middle of a draw function, verify no earlier scratch is still live.

Readers deliberately **omit** keys already baked into a cached layout: `readTextRender` doesn't
read `fontSize`/`fontFamily`/`width`/`content`; `readCodeRender` doesn't read
`content`/`width`/`language`/`lineNumbers`; `readImageOpacity` reads only `opacity` (frame comes
from `handle.bbox`, assetId from `imageCache`). Layout-bearing kinds are read by id —
`textLayoutCache.getLayoutById` / `codeSystem.getLayoutById` — bypassing `Y.XmlFragment` /
`Y.Text` pulls entirely.

`readNoteRender` / `readBookmarkRender` are consumed by `core/text/sticky-note.ts` and
`core/bookmark/bookmark-render.ts`, not by `objects.ts`.

---

## 6. Cache architecture

### The population hook

Phase B of the deep observer calls `computeBBoxForInto(id, kind, y, out)` for every touched
non-connector, and the derived-frame branches **populate their subsystem cache as a side
effect** (`docs/object-lifecycle.md` §1). That single call is why "handle exists ⇒ caches
populated" holds.

```
computeBBoxForInto(id, kind, y, out)
  stroke    → points min/max + width pad
  shape     → frame + width pad                (does NOT touch the label cache)
  image     → frame;  ensureImageMeta(id, y)   → imageCache
  text      → computeTextBBox(id, props)       → textLayoutCache + frame
  note      → computeNoteBBox(id, props)       → textLayoutCache + frame
  code      → computeCodeBBoxInto(id, y, out)  → codeSystem      + frame
  bookmark  → computeBookmarkBBox(id, props)   → bookmarkCache   + frame
  connector → route min/max + label union      (dead arm: connectors go via the router)
```

### The caches

| Cache | Module | Keyed by | Owner | Populated by | Read API |
|---|---|---|---|---|---|
| `textLayoutCache` | `core/text/text-system.ts` | object id | module singleton | bbox path (text/note) · lazy first paint (shape labels) · bbox path (connector labels) | `getTextFrame`, `getLayout` (populating), `getLayoutById`, `getMeasuredContent`, `getInlineStyles`, `noteCached*` |
| `codeSystem` | `core/code/code-system.ts` | object id | module singleton | bbox path + observer `handleContentChange`; **async** span upgrade from the Lezer worker | `getCodeFrame`, `getLayoutById`, `getSpans`, `getSource`, `getOutputCache` |
| `bookmarkCache` | `core/bookmark/bookmark-render.ts` | object id | two module Maps (layout + frame) | bbox path only | `getBookmarkFrame`, `getLayoutById`, `forEachLayout` |
| `imageCache` | `core/image/image-cache.ts` | object id | module Map | bbox path (`ensureImageMeta`, insert-only) | `getImageMeta`, `forEachImageMeta` |
| image **bitmaps** | `core/image/image-manager.ts` | **assetId** | module state | **async** worker decode over the SAB control plane | `getBitmap(assetId)` |
| `connectorRouter.routes` | `core/connectors/connector-router.ts` | connector id | **`RoomDocManager` instance** — the only room-scoped one | `rerouteCanonical` (observer Phase C + hydrate pass 2) | `getConnectorRoute`, `getAttachedConnectors` |
| `geometryCache` | `renderer/geometry-cache.ts` | object id | module Map | **lazy on first read** | `getPath`, `getConnectorPaths` |

Notable shapes:

- **`textLayoutCache` serves four object classes** — text objects, sticky notes, shape labels
  (keyed by *shape* id) and connector labels (keyed by *connector* id). That is why
  `removeObjectCaches` evicts it for `text | shape | note | connector`.
- **`bookmarkCache`'s layout map is insert-only, first-write-wins** — bookmark layouts are
  immutable post-unfurl. Its frame map is overwritten normally. The one explicit external evict
  in the whole codebase is `bookmark-unfurl.ts`, which drops the stale layout *before* the
  transaction that upgrades title/og/favicon, so the transaction's own observer fire rebuilds it.
- **`imageCache` stores only `{ assetId, nw, nh }`** — immutable per object, hence insert-only
  with a `Map.has` bail. It is not the bitmap cache; bitmaps are keyed by assetId and evicted by
  a viewport mark/sweep in `manageImageViewport()`, cleared from `CanvasRuntime.stop()`, **not**
  from `clearAllObjectCaches()`.
- **`geometryCache` reads never return null** — `getOrBuild` always produces a value (an empty
  `Path2D` for degenerate input). Its failure mode is a wrong-type cast, not a null; `getPath`
  and `getConnectorPaths` are unchecked casts over one shared map.

### Staleness models — all different, all deliberate

| Cache | Model |
|---|---|
| `textLayoutCache` | Null-sentinel + inline key compare. `fontSize` / `fontFamily` / `width` self-detect inside `getLayout`; only **content** changes need an external signal (`invalidateContent`, driven by the observer). Every relayout branch nulls `frame` |
| `codeSystem` | Global monotonic `version` (global, not per-entry, so a stale worker doorbell can't match a re-created entry) + a seqlock-style acquire over the spans SAB + boolean layout keys + a ≤1-parse-in-flight gate |
| `bookmarkCache` | None. Insert-only + one explicit evict at the single mutation site |
| `imageCache` | None. Fields are immutable for the object's lifetime |
| `connectorRouter.routes` | None. Structural self-healing: every event that could stale a route enqueues a reroute, drained before the fire ends. Stale `anchorIds` pointing at a deleted shape self-clean |
| `geometryCache` | None. Correctness rests entirely on external eviction (below) |

### Eviction — who calls what

`removeObjectCaches(id, kind)` (`renderer/object-cache.ts`) is the fan-out: unconditional
`evictGeometry(id)`, then per kind → `textLayoutCache.evict` (text/shape/note/connector),
`codeSystem.evict`, `bookmarkCache.evict`, `imageCache.evict`. `clearAllObjectCaches()` clears
all five.

**Both are called from exactly one file: `runtime/room-doc-manager.ts`.**

| Call | Where | Why |
|---|---|---|
| `removeObjectCaches(id, OLD kind)` | observer, kind-conversion branch | must precede Phase B, which repopulates under the *new* kind |
| `removeObjectCaches(id, handle.kind)` | `applyObjectChanges` Phase A | object deleted |
| `clearAllObjectCaches()` | `hydrateObjectsFromY()` | full rebuild |
| `clearAllObjectCaches()` | `destroy()` | room teardown |
| `evictGeometry(id)` | observer, connector `startCap`/`endCap` | caps bake into the cached `Path2D` |
| `evictGeometry(id)` | observer, shape `shapeType` | pre-evict so the renderer never re-checks per draw |
| `evictGeometry(id)` | `upsertHandle`, first insert | fresh id may reuse a stale entry |
| `evictGeometry(id)` | `upsertHandle`, `bboxChanged \|\| alwaysEvict` | `alwaysEvict` is passed only by Phase C — a connector's route can change while its bbox does not |

Two things are deliberately **outside** `clearAllObjectCaches()`, because it also runs on
hydrate: `terminateCodeWorkers()` (would kill the Lezer pool) and the connector route cache
(cleared via `connectorRouter.clear()`, which `destroy()` calls before the cache teardown).
`clearImageManager()` is likewise outside — it is called from `CanvasRuntime.stop()`.

### Exceptions to "handle exists ⇒ caches populated"

The invariant is a **synchronous ordering discipline** in `room-doc-manager` (populate, then
publish the handle — and on delete, evict, then drop the handle), not a guarantee inside the
getters. No reader running on a later tick can observe a handle with unpopulated caches. Four
carve-outs an agent needs to know:

1. **Lazy: `geometryCache`.** Nothing pre-populates it; the observer only evicts. Built on first
   `getPath` / `getConnectorPaths`.
2. **Lazy: shape labels.** The `shape` branch of `computeBBoxForInto` reads frame + width only.
   A labeled shape's `textLayoutCache` entry appears on first `drawShapeLabel` (or eagerly via
   the kind-conversion branch). So `getInlineStyles(shapeId)` returning null is a real,
   reachable state — that's why the conversion branch pre-warms it for the context menu.
3. **Async: image bitmaps and Lezer spans.** Both cross a worker boundary and self-publish
   their own dirty rect on arrival — a gray placeholder / sync-floor highlight paints meanwhile.
   See `core/image/CLAUDE.md` and `core/code/CLAUDE.md`.
4. **Transient nulls within one fire.** `getTextFrame` / `getCodeFrame` read a *nullable* `frame`
   field, nulled by `invalidateContent` / `handleContentChange` / any relayout branch and
   repaired later in the same observer fire. `getBookmarkFrame` is map-miss-only.

Because of (4), treat a null layout/frame in a draw path as a benign cold miss and return —
which is exactly what every leaf draw does. Don't add retry logic; the next fire publishes the
rect.

---

## 7. Who publishes dirty rects

Everything that changes visible pixels must publish. The full set of publishers:

| Publisher | Path |
|---|---|
| The deep observer | `upsertHandle` → `invalidateIfVisible` → `invalidateWorldBBox` (prev + new rect) |
| Tool gestures | `tool.move/end` → `invalidateOverlay` (preview) / `invalidateWorldBBox` (committed geometry) |
| Image bitmap arrival | `image-manager`'s worker message handler queries the spatial index and invalidates directly |
| Lezer span arrival | `codeSystem.applyWorkerSpans` — viewport-culled `invalidateWorldBBox` |
| Python run status | the `py-run-store` ticker + phase changes → `invalidateWorldBBox(block bbox)` |
| Camera | `RenderLoop`'s own `subscribeCamera` → **full clear**, not a rect |
| Canvas resize / DPR | dim-change detection inside each loop → full clear + a 150 ms native-rAF window |
| Animation jobs | `AnimationJob.frame()` returning `true` → `invalidateOverlay` |

**The rule:** every publish must cover what will be painted, padded for stroke width and caps.
A placeholder (`[0,0,0,0]`, an unpadded frame, a partial union) leaves stale pixels on screen
until the next pan or zoom. When the new area genuinely can't be computed, publish the **union
of old and new bbox** and write down why.
