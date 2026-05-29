# AVLO Codebase Guide
**Purpose:** Offline-first collaborative whiteboard with Yjs CRDT sync.
**Stack:** React/TS/Canvas + Yjs + Cloudflare Workers/R2

## Subsystems

Each ships its own `CLAUDE.md` (file map + notes): `core/{text,code,connectors,image,bookmark,clipboard,spatial,z-order,geometry/recognizer}`, `tools/selection`, `runtime/{input,presence}`, `components/context-menu`. Reading any file in one pulls its whole doc — be deliberate. Cross-kind concerns (`RoomDocManager`, `computeBBoxFor`, render pipeline) live here.

## Commands & Aliases
```bash
npm run typecheck    # typecheck client + all three workers (must run from repo root)
npm run dev          # Vite :3000 + workers :8787/:8788/:8789 — ask before starting
npm run lint         # Biome — skip routine runs (noisy, sometimes wrong); pre-commit auto-formats
```
> In the `avlo-parallel` worktree, run `npm run dev:p` instead of `npm run dev` — it shifts every wrangler port by `PORT_OFFSET` so the two checkouts can run side-by-side without colliding.

- `@avlo/shared` → `packages/shared/src/*` (cross-runtime; client + server)
- `@avlo/worker-shared` → `packages/worker-shared/src/*` (server-only — never imported client-side)
- `@avlo/api-client` → `packages/api-client/src/*` (browser/SW typed `hc<AppType>` clients)
- `@/*` → `client/src/*`

## Best Practices

- **Pre-production, solo dev.** Don't plan migrations, compat shims, or schema-versioning seams — clear history / new room / refresh covers any Y.Doc or store pivot.
- **Reuse before invention.** Bbox/frame/handle/accessor primitives exist — grep `core/geometry/bounds.ts`, `core/accessors.ts`, `core/types/`, `utils/` first. A named 3-line helper beats inline reinvention.
- **Low-friction modules.** Cross-module data flows through module-level getters (`getHandle`, `frameOf`, `getSpatialIndex`, `getVisibleBoundsTuple`). Over-encapsulation is the enemy.
- **Fewest lines for full robustness.** No defensive checks at trusted boundaries, no backwards-compat shims, no half-finished abstractions.

## Invariants

- **Dirty-rect ↔ WYSIWYG.** Base canvas only repaints rects published via `invalidateWorld{,BBox}`. Every publish MUST cover what's painted (or will be), padded for stroke + caps. Placeholder bailouts (`[0,0,0,0]`, unpadded frame, partial union) leave stale pixels until pan/zoom — eight months of bugs say so. If unavoidable, invalidate **union of old + new bbox** and document why.
- **Zero allocation on hot paths.** Render frame / observer fire / pointer move / reroute — reuse module scratches, use the `*Mut`/`*Into(out)` variant of every geometric primitive. No per-call `Set`/`Map`/`{}`/`[]`.
- **Monomorphism on hot paths.** Stable object shapes, typed-array inner loops (`Float64Array` over `[number,number][]`), no arity-varying option bags — unless unavoidable.
- **Hot paths: performance over defensiveness.** Drop null guards, try/catch, and re-validation when the upstream contract already covers them. Defensive code belongs at boundaries, not in inner loops.

---

## File Map

All paths relative to `client/src/` unless noted.

### Runtime (`runtime/`)
| File | Responsibility |
|------|----------------|
| `CanvasRuntime.ts` | Central orchestrator — events, subscriptions, tool dispatch |
| `SurfaceManager.ts` | DOM refs (contexts, editorHost, cursorHost) + resize/DPR + deferred canvas resize |
| `InputManager.ts` | DOM event forwarder + modifier state (shift/ctrl/meta) |
| `tool-registry.ts` | Self-constructing tool singletons + lookup helpers |
| `room-runtime.ts` | Module-level room context — `connectRoom`/`disconnectRoom` + imperative getters |
| `room-doc-manager.ts` | Y.Doc lifecycle, providers, spatial index, deep observer, presence wiring |
| `ContextMenuController.ts` | Imperative singleton: floating-ui positioning, show/hide |
| `keyboard-manager.ts` | All keybindings: tool switches, Cmd modifiers, spacebar pan, zoom, arrow pan |
| `cursor-tracking.ts` | Last cursor world position (for paste placement) |
| `presence/presence.ts` | Awareness lifecycle, cursor send (throttle + backpressure), receive dispatch. Delegates peer state to the renderer. |
| `presence/presence-renderer.ts` | `PresenceCursorRenderer` — SoA peer state, slot pool, self-driven rAF, DOM `<img>` cursors (host at z:4, above editor overlay) |
| `presence/presence-pointer.ts` | Pure dispatch for the `document`-level local-cursor input path (move/out/blur/camera-sync) |
| `viewport/zoom.ts` | Smooth zoom animations (step, pinch, zoom-to-fit, reset) |
| `viewport/edge-scroll.ts` | Auto-pan near viewport edges during drags |
| `viewport/arrow-key-pan.ts` | Continuous arrow key panning with easeInQuad acceleration |

### Renderer (`renderer/`)
| File | Responsibility |
|------|----------------|
| `RenderLoop.ts` | Base canvas singleton, dirty-rect tracking (`Float64Array`), exports `invalidateWorld{,BBox,All}` |
| `OverlayRenderLoop.ts` | Overlay canvas singleton, full clear each frame, exports `invalidateOverlay` |
| `types.ts` | `FRAME_CONFIG`, Perfect Freehand options, `getSvgPathFromStroke` |
| `geometry-cache.ts` | Path2D (strokes/shapes) + ConnectorPaths cache; observer-driven eviction (bbox change, `shapeType` / `startCap` / `endCap` keychange) |
| `render-accessors.ts` | Per-kind `_map.get` readers (`readXxxRender(y)`) + per-kind module scratches. Two helpers split by Content subclass — `readPrim` (ContentAny via `arr[0]`) and `readY` (ContentType via `type`). Both check `!val.deleted` (tombstones survive `.delete(key)`). Zero alloc, monomorphic per subclass. Hot path only |
| `object-cache.ts` | Unified eviction: `removeObjectCaches(id, kind)`, `clearAllObjectCaches()` |
| `layers/objects.ts` | Object rendering dispatch, transform preview, fill-aware Z-order |
| `layers/selection-overlay.ts` | Selection highlights, bbox, circular handles (marquee owned by SelectTool) |
| `layers/tool-preview.ts` | Active-tool preview dispatcher |
| `layers/connector-preview.ts` | In-flight connector overlay |
| `layers/connector-render-atoms.ts` | Shared connector draw atoms (`paintConnector`, `drawAnchorDot`, dash guides) |
| `layers/shape-preview.ts` | In-flight shape draw (line/rect/ellipse/diamond/roundedRect) |
| `layers/stroke-preview.ts` | In-flight Perfect Freehand stroke |
| `layers/eraser-dim.ts` | Dim hovered objects under eraser via 'screen' blend |
| `layers/handle-stamp.ts` | Resize-handle bitmap stamp — pre-rendered offscreen, blitted (no per-frame `shadowBlur`) |
| `animation/AnimationController.ts` | Singleton animation job manager — push-based invalidation |
| `animation/EraserTrailAnimation.ts` | Decaying eraser-stroke trail |

### Tools (`tools/` — zero-arg singletons via `tool-registry.ts`)
| File | Notes |
|------|-------|
| `types.ts` | `PointerTool` interface + `PreviewData` union |
| `selection/SelectTool.ts` | Selection state machine, translate, scale, connector endpoints, code/text editing entry |
| `selection/transform.ts` | `TransformController` (scale/translate/endpoint drag), entry system, per-kind dispatch tables |
| `selection/types.ts` | Shared selection types (`TransformState`, entry/dispatch helpers) |
| `selection/selection-utils.ts` | Composition, bounds, declarative `foldField` over the field table |
| `selection/selection-actions.ts` | Mutation wrappers — each a 1-3 line `applyField`/`toggleField`/`adjustByPresets` |
| `selection/selection-field-table.ts` | `FieldDescriptor<V>` table + `foldField`/`applyField`/`toggleField`/`adjustByPresets` primitives |
| `selection/connector-topology.ts` | `buildTopology` — graph of attached connectors per selected shape |
| `DrawingTool.ts` | Pen, highlighter, shape drawing. `hold-detector.ts` (550ms) fires the $P recognizer on dwell |
| `EraserTool.ts` | Geometry-aware hit testing + deletion |
| `TextTool.ts` | WYSIWYG rich text + sticky notes, Tiptap DOM overlay (`core/text/`) |
| `PanTool.ts` | Viewport panning (dedicated + MMB + spacebar) |
| `ConnectorTool.ts` | Elbow + straight connectors + snapping (`core/connectors/`) |
| `CodeTool.ts` | Code blocks, CodeMirror overlay (`core/code/`) |

### Core (`core/`)
| File | Responsibility |
|------|----------------|
| `accessors.ts` | Typed Y.Map accessors (per-field + per-kind bulk `getXxxProps`) |
| `types/objects.ts` | `ObjectKind`, `ObjectHandle` (+ `createHandle`/`applyHandleBBox`), prop types, `BindableKind`/`BINDABLE_KINDS`/`isBindable*` |
| `types/geometry.ts` | `BBoxTuple`, `FrameTuple`, `WorldBounds`, `Frame` + converters |
| `types/handles.ts` | `HandleId` taxonomy (corner/side), type guards, `scaleOrigin`, `handleCursor` |
| `index.ts` | Type re-export barrel |
| `geometry/bbox.ts` | `computeBBoxFor{,Into}(id, kind, yMap[, out])` — unified per-kind dispatch (hot path uses `*Into` into a pooled scratch); `computeConnectorBBoxFromPointsInto` |
| `geometry/bounds.ts` | BBox/frame tuple helpers, WorldBounds ops, mutating offset primitives (`offset*`, `copy*`, `*Mut`) |
| `geometry/frame-of.ts` | `frameOf(handle)` — mapped dispatch to per-subsystem frame getter for any bindable kind |
| `geometry/shape-path.ts` | Build Path2D from frame tuple |
| `geometry/scale-system.ts` | Pure math atoms: `uniformFactor`, `preservePosition`, `edgePinPosition1D`, `computeReflowWidth` |
| `geometry/hit-primitives.ts` | Pure tuple-first hit math: point/segment/polyline/shape/rect/circle atoms |
| `geometry/recognizer/` | $P/$Q shape recognizer — 550ms-hold match. Entry: `recognize.ts`, `hold-detector.ts`. See CLAUDE.md |
| `spatial/` | Hit testing + region queries. Entry: `object-query.ts` (picker facade), `handle-hit.ts`, `hit-dispatch.ts` (per-kind switch dispatchers). See CLAUDE.md |
| `connectors/` | Elbow A* + straight routing, snap. Entry: `connector-router.ts`, `snap.ts`, `reroute-connector.ts`, `anchor-atoms.ts`, `connector-paths.ts`, `constants.ts`. See CLAUDE.md |
| `text/` | Layout engine + three-tier cache + sticky notes. Entry: `text-system.ts`, `line-break.ts`, `text-measure.ts`, `shape-label.ts`, `sticky-note.ts`, `font-config.ts`, `font-loader.ts`. See CLAUDE.md |
| `code/` | Two-tier tokenization + CodeMirror + canvas renderer. Entry: `code-system.ts`, `code-tokens.ts`, `lezer-worker.ts`, `code-theme.ts`. See CLAUDE.md |
| `image/` | Offline-first pipeline + 2 web workers. Entry: `image-manager.ts`, `image-cache.ts`, `image-actions.ts`, `image-worker.ts`. See CLAUDE.md |
| `bookmark/` | URL unfurl + OG metadata. Entry: `bookmark-render.ts`, `bookmark-actions.ts`, `bookmark-unfurl.ts`, `bookmark-placeholder.ts`. See CLAUDE.md |
| `clipboard/` | Nonce-based clipboard + serializer. Entry: `clipboard-actions.ts`, `clipboard-serializer.ts`. See CLAUDE.md |
| `z-order/` | `ZRankTable` (SoA Uint32 ranks + slot pool) + bring/send/forward/backward actions. Algorithm lives in `@avlo/shared/z-order` (cross-runtime). See CLAUDE.md |

### Stores
| File | Responsibility |
|------|----------------|
| `camera-store.ts` | Camera state, coordinate transforms, canvas element, pointer capture, per-room persistence |
| `device-ui-store.ts` | Toolbar state, drawing settings, user identity, cursor management (persisted) |
| `selection-store.ts` | Selection state, transform state |
| `presence-store.ts` | Peer identities + count (Zustand, for React components only) |

### Utils + Shared
| File | Responsibility |
|------|----------------|
| `utils/math.ts` | `clamp`, `clamp01`, `hypot2` — branchless inline forms |
| `utils/dispose.ts` | `dispose<T>(value, fn): null` — single-line teardown chain |
| `utils/color.ts` | `createFillFromStroke(stroke, mixRatio)` |
| `utils/generate-user-profile.ts` | Random adjective+animal name + color palette |
| `packages/shared/src/types/identifiers.ts` | `RoomId`, `UserId`, `StrokeId`, `TextId` |
| `packages/shared/src/utils/ulid.ts` | `ulid()` |
| `packages/shared/src/utils/url-utils.ts` | `normalizeUrl`, `isValidHttpUrl`, `extractDomain` |
| `packages/shared/src/utils/image-validation.ts` | `validateImage`, `isSvg`, `parseImageDimensions` |

### Server (`workers/`)

Three independently-deployed Cloudflare Workers. Full architecture, hardening invariants, and the app-type/drift-guard pattern in `workers/CLAUDE.md`.

| Worker | Folder | Prod | Bindings | Surface |
|---|---|---|---|---|
| **main** | `workers/main/` | `avlo.io` | `ASSETS` (Static Assets), `rooms` (DO), `DOCS` (R2) | SPA via Assets binding + WSS `/parties/*` via `partyserverMiddleware` + `RoomDurableObject` |
| **images** | `workers/images/` | `images.avlo.io` | `IMAGES` (R2) | `PUT/GET /:key` — Zod param, content-length bound, hash-verify, edge cache, Range, CSP |
| **unfurl** | `workers/unfurl/` | `unfurl.avlo.io` | `IMAGES` (R2, shared) | `GET /?url=` — Zod query + SSRF refine, HTMLRewriter OG extraction, image→R2, edge cache 7d |

Routes blocks land **commented out** today; deploy is gated on DNS transfer + additional pre-prod essentials. `packages/{worker-shared,api-client}/CLAUDE.md` cover the shared backend primitives and typed-RPC clients respectively.

### Routes + UI
`routes/__root.tsx`, `routes/index.tsx`, `routes/room.$roomId.tsx` (calls `connectRoom` in `beforeLoad`).
`components/Canvas.tsx` (thin React wrapper), `RoomPage.tsx`, `TopBar.tsx`, `TopBarRight.tsx`, `ZoomControls.tsx`, `UserAvatarCluster.tsx`, `icons/`, `toolbar/`, `context-menu/` (own CLAUDE.md).
Service Worker: `sw.ts` (cache-first `/api/assets/*`, app shell).

---

## Architecture Overview

```
Route beforeLoad         → connectRoom(roomId)   → room-runtime.ts
RoomPage cleanup effect  → disconnectRoom(roomId)

Canvas.tsx (thin React wrapper — mounts DOM, creates runtime)
  └── new CanvasRuntime().start({ container, baseCanvas, overlayCanvas, editorHost })

CanvasRuntime (the brain)
  ├── SurfaceManager   — DOM refs + resize/DPR + deferred canvas resize
  ├── renderLoop       — base canvas, dirty-rect optimized (native rAF)
  ├── overlayLoop      — tool preview + animation jobs, full clear each frame (peer cursors render as DOM, not here)
  ├── InputManager     — pointer + keyboard + modifier state
  ├── camera subscription → tool.onViewChange() (guarded by isEdgeScrolling)
  └── pointer dispatch → spacebar/MMB pan check → tool.begin/move/end

tool-registry.ts (self-constructing singletons)
  pen/highlighter/shape → drawingTool   text/note → textTool
  eraser, select, pan, connector, code → respective singletons
  image → one-shot file picker (no persistent tool)
```

### Data flow

```
Y.Doc (source of truth)
   ↓ observers (Y.Map.observeDeep)
RoomDocManager.applyObjectChanges()
   ├─ computeBBoxForInto(id, kind, yMap, scratch)
   ├─ upsertHandle (mutates handle.bbox in place; rbush update before mutation)
   ├─ evictGeometry(id) + per-kind layout cache evict
   └─ invalidateIfVisible(bbox, vp) → invalidateWorldBBox      [base canvas]
         ↓
   RenderLoop (dirty-rect base)
   OverlayRenderLoop (full-clear overlay)
         ↑
   camera-store (scale, pan, viewport) — self-subscribed
```

### Write path

```
Tool.begin/move/end()              → user gesture
  → tool.commit() via transact(()=> getObjects().set(...))
  → ydoc.transact(fn, userId)
  → deep observer fires applyObjectChanges()
  → handle upsert + cache evict + invalidateWorldBBox()
```

### Event flow

```
Canvas pointer event → InputManager → CanvasRuntime
  ├─ screenToWorld(clientX, clientY)
  ├─ setLastCursorWorld()  (paste-at-cursor placement)
  ├─ updateEdgeScroll() (auto-pan near edges)
  └─ getCurrentTool().begin/move/end(worldX, worldY)
       ↓
  Tool updates internal state
    ├─ invalidateOverlay()      preview changed
    └─ invalidateWorldBBox()    geometry changed

Document pointer event → InputManager → presence-pointer.ts
  └─ screenToWorldInto() → updateCursor()   (local cursor broadcast — fires
       over DOM chrome too, a separate path from the canvas chain above)
```

---

## Routing (TanStack Router)

File-based with auto code splitting. Three routes; auto-generated `routeTree.gen.ts`.
- `beforeLoad` calls `connectRoom(roomId)` — creates Y.Doc, starts providers, restores camera (not code-split — runs while component chunk downloads)
- `RoomPage` cleanup effect calls `disconnectRoom(roomId)` on unmount
- `key={roomId}` on `RoomCanvas` forces full remount on room switch
- `getRouteApi('/room/$roomId').useParams()` for `roomId` in components

---

## PointerTool Interface

All tools implement `PointerTool` (`tools/types.ts`): `canBegin`, `begin(pointerId, worldX, worldY)`, `move` (also hover), `end`, `cancel`, `isActive`, `getPointerId`, `getPreview` → overlay rendering, `onPointerLeave`, `onViewChange`, `destroy`. Zero-arg constructors — dependencies read from stores at runtime (settings frozen at `begin()`).

---

## Room Runtime (`runtime/room-runtime.ts`)

Module-level room context. `connectRoom(roomId)` from route `beforeLoad`, `disconnectRoom(roomId)` from RoomPage cleanup. Fail-fast (throws if no room).

**Key exports:** `connectRoom`/`disconnectRoom`/`hasActiveRoom`, `getHandle(id)`/`getHandleKind(id)`/`getBbox(id)`/`getObjectsById()`/`getSpatialIndex()`/`getObjects()`/`getZOrder()`, `transact<T>(fn): T | undefined`/`undo()`/`redo()`. Re-exports from `connector-router`: `getConnectorRoute(id)`, `getAttachedConnectors(shapeId)`, `detachConnectorFromShape`.

Prefer `getHandle(id)` over `getObjectsById().get(id)`. Prefer `transact(fn)` over `getActiveRoomDoc().mutate(fn)` — `transact` returns whatever `fn` returns, so callers can elide the `let foo; transact(()=>{ foo = ... })` dance.

---

## Invalidation — Singleton Render Loops

Module-level singletons, safe no-ops before `start()`. Tools and observers import directly.
- **RenderLoop:** `invalidateWorld(bounds)`, `invalidateWorldBBox(bbox)`, `invalidateWorldAll()`
- **OverlayRenderLoop:** `invalidateOverlay()`

---

## Y.Doc Structure (v2)

```ts
Y.Doc { guid: roomId }
└─ objects: Y.Map<Y.Map<unknown>>      // top-level, always exists — all objects by ULID

type ObjectKind = 'stroke' | 'shape' | 'text' | 'connector' | 'code' | 'image' | 'note' | 'bookmark';
```

### Schemas

All objects share `{ id (ULID), kind, ownerId, createdAt, z: ZKey }`. `id` is creation-ordered and immutable (used for identity + references); `z` is a mutable fractional sort key (opaque, lex-comparable — see `core/z-order/` + `@avlo/shared/z-order`). **Color semantics:** `color` = stroke color (shape/stroke/connector) or text color (text); `fillColor` = background always; shapes use `labelColor` for label text. Per-kind fields:

- **Stroke** (pen/highlighter) — `{ tool: 'pen'|'highlighter', color, width, opacity, points: [number,number][] }`
- **Shape** (rect/ellipse/diamond/roundedRect) — `{ shapeType, color, width, opacity, fillColor?, frame: [x,y,w,h], content?: Y.XmlFragment, fontSize?, fontFamily?, labelColor? }`. Label fields added on first edit, removed if empty on close.
- **Text** — `{ origin: [anchorX, baseline], fontSize, fontFamily, color, align, width: 'auto'|number, fillColor?, content: Y.XmlFragment }`. Frame derived (`getTextFrame(id)`). Delta attrs: bold, italic, highlight (`{color}` or presence → `'#ffd43b'`).
- **Code** — `{ origin: [topLeftX, topLeftY], fontSize, width: number, language, content: Y.Text, lineNumbers?, title?, headerVisible?, outputVisible?, output? }`. Origin = top-left (unlike text). Frame via `getCodeFrame(id)`.
- **Connector** — `{ connectorType: 'elbow'|'straight', start: ConnectorEndpoint, end: ConnectorEndpoint, startCap, endCap, color, width }`. **No geometry stored** — endpoints are point/anchor refs; routed polyline lives in `ConnectorRouter` cache (`getConnectorRoute(id)`). Always opacity 1.
- **Note** — `{ origin: [topLeftX, topLeftY], scale, fontFamily, align, alignV, fillColor, content: Y.XmlFragment }`. No fontSize/width (derived from content + scale). Text color hardcoded `#1a1a1a`; `fillColor` per-instance, default `#FEF3AC`.
- **Image** — `{ assetId: 64-hex, frame, naturalWidth, naturalHeight, mimeType, opacity? }`. Content-addressed (same file → same `assetId`).
- **Bookmark** — `{ url, domain, origin, height, scale?, title?, description?, ogImageAssetId?, ogImageWidth?, ogImageHeight?, faviconAssetId? }`. Frame derived (`getBookmarkFrame(id)`). State implied by which optional fields are set.

### Creating an object

One pattern for every kind: inside a single `transact()`, build a `Y.Map`, set the shared + per-kind fields, then `getObjects().set(id, m)`. The deep observer does everything downstream — handle, spatial index, caches, dirty rect — so never touch those by hand.

```ts
const id = ulid();
transact(() => {
  const m = new Y.Map();
  m.set('id', id);
  m.set('kind', 'shape'); // ObjectKind
  // …per-kind fields — see Schemas above…
  m.set('ownerId', getUserId()); // device-ui-store
  m.set('createdAt', Date.now());
  m.set('z', generateZAtTop(getZOrder().maxZ())); // newest on top
  getObjects().set(id, m);
});
```

**`z` is mandatory and never hand-authored** — a fractional sort key minted against the current stack. Generators (`generateZAtTop` etc.) are exported from `@avlo/shared`; `getZOrder()` (room-runtime) returns the client `ZRankTable`, whose `.maxZ()`/`.minZ()` give the current top/bottom `z` (`null` on an empty doc). One object on top → `generateZAtTop(getZOrder().maxZ())`. N objects in one `transact` → `generateNZAtTop(getZOrder().maxZ(), n): ZKey[]` — mint once, assign in order (see `clipboard-actions.ts`). `*AtBottom` (minZ) / `*Between` variants cover the other anchors; reorder actions live in `core/z-order/`.

### ObjectHandle (live reference, IS the rbush item)
```ts
interface ObjectHandle {
  id: string;            // ULID
  kind: ObjectKind;
  y: Y.Map<unknown>;     // LIVE reference
  bbox: BBoxTuple;       // [minX, minY, maxX, maxY] — computed locally, mutated in place by observer
  // rbush envelope mirrors — written ONLY by createHandle / applyHandleBBox.
  minX: number; minY: number; maxX: number; maxY: number;
  z: ZKey;               // mirror of y.get('z'); mutated only by the observer's z-key-edit branch
  slot: number;          // stable Uint32Array index into ZRankTable._ranks; immutable post-creation
}
```

The handle is the rbush spatial-index item — its envelope fields mirror `bbox[0..3]` and rbush reads them directly. **Invariants:** `applyHandleBBox(handle, src)` is the only legal post-creation mutator for the bbox tuple + envelope mirrors; it writes them atomically. `handle.z` is mutated only by the deep observer's `'z'` key handler (mirror of `y.get('z')`). `handle.slot` is assigned once by `ZRankTable.acquireSlot()` and never reassigned (the slot returns to the free-list on delete and is reusable, but no live handle ever changes its slot). No `handle.bbox[N] = ...` or `copyBbox(_, handle.bbox)` writes anywhere — that would desync the mirrors and corrupt the spatial tree.

Wrapper persists across observer fires; only `bbox`'s four slots + mirrors (and `z` when the user reorders) change. Consumers needing a stable snapshot across fires must clone at read time — transform / topology / image-manager already do (`[...handle.bbox]` at gesture begin).

### Stored vs derived geometry

- **Stored in Y.Map:** shape/image `frame`, stroke `points`.
- **Derived from layout/origin/scale** (subsystem-cached, accessed via getter): text/note `getTextFrame(id)` (`core/text/text-system.ts`), code `getCodeFrame(id)` (`core/code/code-system.ts`), bookmark `getBookmarkFrame(id)` (`core/bookmark/bookmark-render.ts`).
- **Connectors are a third class.** Y.Map stores endpoint refs only (`start`/`end`: point or `StoredAnchor`); the routed polyline lives in `ConnectorRouter`'s local cache, populated by the deep observer on every relevant input change. Read via `getConnectorRoute(id)`.

All frame getters return `FrameTuple | null` (null before first layout). `computeBBoxFor{,Into}` (`core/geometry/bbox.ts`) dispatches to the right subsystem — observer fires use `*Into` (writes into a pooled scratch); hydrate uses the allocating wrapper.

**Global helpers** (use before reaching into a subsystem):
- `frameOf(handle)` — `core/geometry/frame-of.ts` — single dispatch over every bindable kind.
- `getHandleShapeType(handle)` — `core/accessors.ts` — `shapeType` for shapes, `'rect'` for every other bindable.
- `BINDABLE_KINDS` / `isBindableKind` / `isBindableHandle` / `isUnbindableKind` — `core/types/objects.ts`.

---

## Types & Accessors

**Geometry types** (`core/types/geometry.ts`): `BBoxTuple = [minX,minY,maxX,maxY]`, `FrameTuple = [x,y,w,h]`, `Point = [x,y]`. Object forms: `WorldBounds`, `Frame`. Converters: `tupleToFrame`, `frameToTuple`, `frameToWorldBounds`, `bboxTupleToWorldBounds`, `worldBoundsToBBoxTuple`, `worldBoundsToFrame`, `frameTupleIntersectsBounds`.

**Bounds helpers** (`core/geometry/bounds.ts`): `expandBBox`, `expandBBoxEnvelope`, `unionBBox`, `pointsToBBox{,Mut}`, `translateBBox`, `frameToBbox{,Mut}`, `bboxToFrame{,Mut}`, `copyBbox`, `copyFrame`, `bboxCenter`, `bboxSize`, `frameCenter`, `fillFrameCenter`, `unionBounds`, `expandEnvelope`, `translateBounds`, `scaleBoundsAround`, `expandBounds`, `offsetPoint`, `offsetBBox`, `offsetFrame`, `offsetPoints`, `setBBoxXYWH`, `boundsIntersect`. Most have in-place `*Mut`/`*Into` mirrors — use them on hot paths.

**Typed Y.Map accessors** (`core/accessors.ts`): prefer over raw `.get()`.
- Common: `getColor`, `getOpacity`, `getWidth`, `getFrame`, `getOrigin`, `getPoints`
- Per-kind bulk (preferred): `getStrokeProps`, `getShapeProps`, `getTextProps`, `getCodeProps`, `getNoteProps`, `getImageProps`, `getBookmarkProps`
- Connector: `getStart`, `getEnd`, `getStartCap`, `getEndCap`, `getConnectorType`, `getConnectorProps`, `getRouteInputs`
- Text/code: `getFontSize`, `getFontFamily`, `getAlign`, `getAlignV`, `getContent`, `getCodeText`, `getTextWidth`, `getLanguage`, `getHeaderVisible`, `getOutputVisible`, `getCodeOutput`
- Shape: `getShapeType`, `getHandleShapeType`, `getFillColor`, `getLabelColor`, `hasLabel`
- Image/bookmark: `getAssetId`, `getNaturalDimensions`, `getBookmarkUrl`, `getBookmarkAssetIds`
- Key types: `TextAlign`, `TextAlignV`, `TextWidth`, `FontFamily` (4 fonts), `CodeLanguage`, `StoredAnchor` (elbow/straight variants), `ConnectorCap`, `ConnectorType`

---

## RoomDocManager

Public fields (non-null from construction): `objectsById`, `spatialIndex`, `connectorRouter`. Sync constructor + async init: IDB sync → hydrate (non-connectors first, connectors second so bindable frames exist for routing) → `observeDeep` → UndoManager → WS provider (first `'sync'` → `repackSpatialIndex`).

### Observer Pipeline

`observeDeep` on `objects` is the single CRDT-driven update path. The body is **synchronous main-thread**, non-reentrant (Y dispatches at end-of-transaction and observers don't open a new one). By the time the callback returns, every subsystem cache referenced below is consistent and visible dirty rects are published — **no awaits, no microtasks, no race between Y change and renderable state**.

Two passes per fire: **inline routing** (per-event, routes content/anchor edits to subsystem hooks so subsystem state is fresh BEFORE the bulk phase reads it) then **`applyObjectChanges`** (three phases over the accumulated `touchedIds` + `deletedIds`).

```
observeDeep(events):                                // synchronous, non-reentrant, per Y transaction
  reset touchedIds, deletedIds
  for ev in events, categorize and inline-route:
    top-level add         → touched += id; if connector → router.onConnectorAdded(id, y)
    top-level delete      → deleted += id; router.onObjectDeleted(id)
    YMap edit on object   → touched += id
        connector & (start|end|connectorType keychange) → router.onConnectorEdited(id, y, …)
        connector & (startCap|endCap keychange)         → evictGeometry(id)  // cap bakes into cached Path2D
        shape     & (shapeType keychange)               → router.onBindableChanged(id)
    nested 'content' edit → touched += id
        Y.Text         (code)            → codeSystem.handleContentChange(id, ev, lang)
        Y.XmlFragment  (text|label|note) → textLayoutCache.invalidateContent(id, content)
  if touched|deleted nonempty → applyObjectChanges()

applyObjectChanges:                                 // _newBBoxScratch reused per fire
  vp = getVisibleBoundsTuple()

  // Phase A — deletions (router maps already updated inline above)
  for id in deleted:
    spatialIndex.remove(id, handle.bbox)
    removeObjectCaches(id, kind)                    // geometry + text/code/bookmark/image
    invalidateIfVisible(handle.bbox, vp)
    objectsById.delete(id)
  selection.onObjectsDeleted(deleted)

  // Phase B — touched non-connectors + style-only connectors
  for id in touched:
    if router.isQueuedForReroute(id): continue      // → Phase C
    if connector: router.computeBBox(id, y, scratch)             // style-only (color/width/cap)
    else:         computeBBoxForInto(id, kind, y, scratch)       // ★ populates subsystem caches
    bboxChanged = upsertHandle(id, kind, y, scratch, vp)         // spatial + evict + dirty rect
    if bboxChanged & bindable(kind): router.onBindableChanged(id)

  // Phase C — drain reroute queue (router-owned)
  for id in router.drainRerouteQueue():
    router.rerouteCanonical(id, y, scratch)         // route + bbox
    upsertHandle(id, 'connector', y, scratch, vp, alwaysEvict=true)
  selection.onObjectsChanged(touched, bboxChanged)
```

**Inline-before-bulk is load-bearing.** `handleContentChange` / `invalidateContent` / router events fire BEFORE Phase B so that `compute*BBox` reads already-fresh subsystem state and routes can be drained from the queue in Phase C in the same fire. No second pass.

`upsertHandle` mutates `handle.bbox` + the rbush mirror fields in place via `spatialIndex.updateHandleBBox`; the wrapper persists for the id's lifetime. On `bboxChanged`: invalidate prev rect → `spatialIndex.updateHandleBBox(handle, newBBox)` [internally: `remove(handle)` reads old envelope → `applyHandleBBox` writes new tuple + mirrors → `insert(handle)` reads new envelope] → `evictGeometry` → invalidate new rect (order critical — `handle.bbox` must still hold the old values when `updateHandleBBox` is called, since rbush's `remove` descends to the old leaf). On no-bbox-change with `alwaysEvict`: only evict + invalidate new rect. New rect is invalidated unconditionally (content may have changed visually without bbox change).

Mutation: prefer `transact(fn)` (room-runtime) over `mutate(fn)`.

---

## Cache Architecture

The ★ in Phase B is the **cache-population hook**. `computeBBoxForInto` (`core/geometry/bbox.ts`) dispatches per-kind, and the derived-frame branches populate their subsystem caches as a side effect:

```ts
computeBBoxForInto(id, kind, y, out) {
  switch (kind) {
    case 'stroke':    out := pointsToBBox + widthPad
    case 'shape':     out := getFrame + widthPad
    case 'image':     out := getFrame; ensureImageMeta(id, y)  // populates imageCache
    case 'text':      out := computeTextBBox(id, props)      // populates textLayoutCache + frame
    case 'note':      out := computeNoteBBox(id, props)      // populates textLayoutCache + frame
    case 'code':      out := computeCodeBBox(id, y)          // populates codeSystem    + frame
    case 'bookmark':  out := computeBookmarkBBox(id, props)  // populates bookmarkCache + frame
    case 'connector': out := bboxFromCachedRoute             // route built in Phase C
  }
}
```

**Handle exists ⇒ caches populated.** Frame getters (`getTextFrame` / `getCodeFrame` / `getBookmarkFrame`) defensively return `null` via `?? null`, but the `null` is just the natural Map-miss return — it fires only when no handle exists in `objectsById` (caller is reading an id that was never observed or has been deleted, in which case the cache entry was removed alongside the handle). Within an id's lifetime, its caches stay populated.

**rbush items ARE handles.** `objectsById` and the spatial index reference the same `ObjectHandle` objects — one source of truth, two access paths. The handle's `minX/minY/maxX/maxY` mirror `bbox[0..3]` and are kept in sync by `applyHandleBBox` (the only legal post-creation mutator, wrapped by `spatialIndex.updateHandleBBox`). Spatial queries return handles directly — no `getHandle(e.id)` lookup post-query, no `IndexEntry` indirection.

**Lazy exceptions** (populated on first read, not via observer):
- `renderer/geometry-cache.ts` — Path2D (stroke/shape), ConnectorPaths (connector). Evicted on bbox change in `upsertHandle`; `alwaysEvict=true` on every connector reroute (route-changed-but-bbox-same is common). Connector cap toggles (`startCap` / `endCap` keychange) pre-evict in the observer because the arrowhead bakes into the cached Path2D and cap-only toggles don't always shift the bbox.
- **Shape label layouts.** The `shape` branch of `computeBBoxForInto` reads frame only — the label layout populates on first `drawShapeLabel`.

**Async exceptions** (cross a worker boundary; render coarser fallback meanwhile, self-publish dirty rects):
- Image bitmaps — worker decode; `getBitmap(assetId)` returns `null` until ready. Frame-driven by `manageImageViewport` per `RenderLoop.tick`.
- Code tier-2 Lezer spans — sync floor inside the observer is eager (instant color); worker upgrade arrives later via `codeSystem.applyWorkerSpans`. **Layout is already eager** — tier-2 is colors only.

| Subsystem cache | Owner | Read API |
|---|---|---|
| `textLayoutCache` (tokenized / measured / layout / frame / note-derived fontSize) | `core/text/text-system.ts` | `getTextFrame`, `getLayout`, `getMeasuredContent`, `getInlineStyles` + note bridge |
| `codeSystem` (source / spans / layout / output / frame) | `core/code/code-system.ts` | `getCodeFrame`, `getSpans`, `getSource`, `getOutputCache` |
| `bookmarkCache` (layout + frame) | `core/bookmark/bookmark-render.ts` | `getBookmarkFrame` |
| `connectorRouter.routes` (per-id pooled `Point[]` + reverse `shape→connectors`) | `core/connectors/connector-router.ts` (owned by RDM) | `getConnectorRoute`, `getAttachedConnectors` |
| `geometryCache` (Path2D, ConnectorPaths) | `renderer/geometry-cache.ts` | `getPath`, `getConnectorPaths` |
| `imageCache` (per-id assetId + natural dims digest) | `core/image/image-cache.ts` | `getImageMeta`, `forEachImageMeta` |
| image bitmaps (per-assetId) | `core/image/image-manager.ts` | `getBitmap(assetId)` |

**Eviction.** `removeObjectCaches(id, kind)` (`renderer/object-cache.ts`) routes geometry + text/code/bookmark/image on delete; `clearAllObjectCaches()` on teardown. Connector routes evict via `router.removeConnector` from `onObjectDeleted`. Tool-owned per-object DOM (TextTool, CodeTool) tears down via its own `dispose()` chain.

**Out-of-band dirty-rect publishers** (everything that isn't the deep observer): tool gestures (`tool.move/end` → `invalidate{World,Overlay,WorldBBox}`), image-manager bitmap-arrival handler, `codeSystem.applyWorkerSpans`, camera-store subscribers (pan/zoom).

---

## Rendering Pipeline

### Two-canvas architecture
- **Base canvas:** World content, dirty-rect optimized, native rAF.
- **Overlay canvas:** Full clear each invalidation — tool preview, selection UI, animation jobs (eraser trail). Peer cursors are NOT on the overlay canvas — they're rendered as DOM `<img>` elements by `PresenceCursorRenderer` so they sit above the editor overlay.
- `SelectTool` renders transformed objects on the base canvas for correct Z-order during translate/scale.

### Object dispatch (`renderer/layers/objects.ts`)
Switch on `handle.kind`: stroke/shape/connector via geometry cache (Path2D / ConnectorPaths), text/note/code via layout caches, image via `getBitmap()`, bookmark via `drawBookmark()`. During scale (`renderScaleEntry`, behavior from `getScaleBehavior`): shape rebuilds frame; image bitmap at scaled frame; stroke uses cached Path2D with `ctx.scale(factor)`; text/code reflow on E/W sides else `ctx.scale(ratio)` on cached layout; note/bookmark `ctx.scale(out.scale/frozen.scale)` around `out.origin`. Edge-pin (multi-select side handle) falls back to `renderTranslatedEntry`. Details in `tools/selection/CLAUDE.md`.

Per-frame hoisting in `drawObjects`: editing IDs (incl. `_textEditingId` threaded into `drawStickyNote`), hovered Open-button id, translate `dx/dy`, topology `connEntries` Map, viewport bounds — read once, used per-object. Module scratches (`_candidateIds`, `_previewScratch`) for zero alloc.

### Hot-path Y.Map reads (`renderer/render-accessors.ts`)
Two helpers, one per Content subclass. `readPrim` reads `val.content.arr[0]` (ContentAny — every primitive/array/object key); `readY` reads `val.content.type` (ContentType — the single `'content'` key on shape labels). Both check `!val.deleted` (Yjs tombstones an Item rather than removing it from `_map` on `.delete(key)` — fillColor=null in `selection-field-table.ts`, empty-label close in `TextTool.ts`). Both bypass `Content.getContent()` so there's no `[this.type]` allocation for ContentType to depend on EA for. ~10 ns/key (vs ~109 ns for `y.get()`). `Y.Map._map` items always have `length === 1` (merges blocked by deleted-state asymmetry — proven from Yjs source), so `arr[0]` is correct without a `length - 1` lookup. One `readXxxRender(y)` per leaf draw fn writes into a per-kind module-level scratch returned by reference. Each `draw*` consumes its scratch before the next reader fires — no cross-reader hazards.

Layout-bearing kinds (text/code/note/bookmark) read by id — `textLayoutCache.getLayoutById`, `noteCachedLayout`, `codeSystem.getLayoutById`, `bookmarkCache.getLayoutById` — bypassing Y.XmlFragment / Y.Text pulls. Populator paths (bbox compute, shape labels) keep the stale-checked `getLayout(id, content, fontSize, ...)` signature. **Handle in `objectsById` ⇒ layout cache populated** (observer guarantees; see Cache Architecture). Geometry-cache trusts entries — `shapeType` / `startCap` / `endCap` keychanges pre-evict via `evictGeometry(id)` in the observer rather than a per-draw re-check. Defensive guards stripped on the hot path: bbox-size (`scaleFrameNonUniform` clamps to `MIN_SHAPE_FRAME_DIM + 2·pad`), `n < 2` (already in `paintConnectorFromPoints`), null `assetId`/`frame` on image (observer contract).

### Coordinate spaces
World (logical) → CSS pixels (browser) → Device pixels (CSS × DPR). Transforms: `worldToCanvas: (x - pan.x) * scale`, `canvasToWorld: x / scale + pan.x`.

---

## Camera Store (`stores/camera-store.ts`)

Zustand store: `scale`, `pan`, `cssWidth`, `cssHeight`, `dpr`, `roomCameras`, `currentRoomId`. Per-room camera persistence via `setRoom(roomId)` — saves outgoing, restores incoming (localStorage, 1Hz debounce — no `persist` middleware).

**Module-level functions:** `worldToCanvas`, `canvasToWorld`, `screenToWorld`, `screenToWorldInto` (zero-alloc, writes into `out` — hot path), `screenToCanvas`, `worldToClient`, `getVisibleWorldBounds` (object form), `getVisibleBoundsTuple` (scratch readonly tuple — hot path), `setCanvasElement`, `getCanvasElement`, `capturePointer`, `releasePointer`, `isMobile`, `subscribeCamera`, `getViewTransform`, `createViewTransform`.

Imperative: `useCameraStore.getState()`. Reactive: `useCameraStore(selector)`. Constants: `MIN_ZOOM`, `MAX_ZOOM`.

---

## Device UI Store (`stores/device-ui-store.ts`)

Persisted Zustand store. `activeTool`, `drawingSettings` (size/color/opacity/fill), user identity (`userId`/`userName`/`userColor` — generated on first visit), per-tool defaults (text, note, shape, connector, code), `cursorOverride`.

Imperative getters: `getUserId()` (used for `ownerId`, undo tracking, presence self-filter), `getUserProfile()` → `{ userId, name, color }`, `setCursorOverride`, `applyCursor`. Constants: `TEXT_FONT_SIZE_PRESETS`, `TEXT_FONT_FAMILIES`, `TEXT_COLOR_PALETTE`, `HIGHLIGHT_COLORS`.

---

## Selection System

Detailed in `tools/selection/CLAUDE.md`: state machine, per-kind transform behavior, connector topology, hit testing (Z-order, handles, endpoints), text/code reflow, dirty rect optimization, commit paths.

**Key entry points:** `SelectTool` (state machine + commits, owns marquee state), `tools/selection/transform.ts` (TransformController, dispatch tables, owns built topology), `connector-topology.ts` (`buildTopology`), `selection-store.ts` (Zustand state), `core/spatial/object-query.ts` (picker facade shared with EraserTool/TextTool/CodeTool/snap), `core/spatial/handle-hit.ts` (resize handles + endpoint dots), `core/geometry/scale-system.ts` (pure scale math), `core/types/handles.ts` (handle taxonomy), `renderer/layers/objects.ts` (transform preview rendering), `renderer/layers/selection-overlay.ts` (highlights, handles, endpoint dots).

---

## Other Tools

**DrawingTool** — pen, highlighter, AND shape drawing. HoldDetector (550ms, `core/geometry/recognizer/hold-detector.ts`) fires $P recognizer (`core/geometry/recognizer/`) for shape snap. Click-to-place: 180wu fixed shape. Settings frozen at `begin()`.

**EraserTool** — geometry-aware hit testing, deletes all object kinds.

**TextTool** — WYSIWYG rich text with Tiptap DOM overlay + canvas rendering. Origin-based positioning, auto/fixed width, three-tier layout cache. Shape labels and sticky notes supported (note tool maps to TextTool). See `core/text/CLAUDE.md`.

**CodeTool** — code blocks with CodeMirror DOM overlay. Screen-space rendering (world × scale in px). Two-tier tokenization (sync regex + Lezer workers). Per-session UndoManager. See `core/code/CLAUDE.md`.

**PanTool** — viewport panning. Also used for MMB pan and spacebar ephemeral pan.

**ConnectorTool** — elbow A* + straight connectors with shape snapping. Ctrl suppresses snapping. See `core/connectors/CLAUDE.md`.

---

## Keyboard, Clipboard, Presence, Image, Bookmark

See subsystem CLAUDE.mds: `runtime/input/`, `core/clipboard/`, `runtime/presence/`, `core/image/`, `core/bookmark/`. Service Worker (`sw.ts`) is cache-first for `/api/assets/*` + app shell, network-first for HTML.
