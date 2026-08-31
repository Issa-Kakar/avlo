# AVLO Codebase Guide
**Purpose:** Offline-first collaborative whiteboard with Yjs CRDT sync.
**Stack:** React / TS / Canvas + Yjs (CRDT) + Vite. Server: Cloudflare Workers (Hono + Zod) — Durable Objects (SQLite), D1, R2, KV, Queues; Drizzle ORM. Build: pnpm workspaces + Turborepo.

## Docs — read the relevant one before you start

Cross-cutting architecture lives in `docs/`. These are **not** auto-loaded; read them deliberately.

| Doc | Read it before touching |
|---|---|
| `docs/object-lifecycle.md` | `room-doc-manager.ts`, the deep observer, `ObjectHandle` / bbox / spatial-index / z mutation, `core/geometry/bbox.ts`, or adding an `ObjectKind` |
| `docs/rendering-and-caches.md` | anything in `renderer/`, `SurfaceManager`, `Canvas.tsx`, dirty-rect behaviour, or any per-object cache (text / code / bookmark / image / geometry / connector routes) |

Subsystems ship their own `CLAUDE.md` (file map + notes): `core/{text,code,py,connectors,image,sab,bookmark,clipboard,spatial,z-order,geometry/recognizer}`, `renderer/grid`, `tools/selection`, `runtime/{input,presence,viewport}`, `query`, `routes`, `components/{context-menu,toolbar,topbar,dashboard}`, `workers/`, `packages/{shared,worker-shared,api-client,db,py-loader,py-build}`. Reading any file in one pulls its whole doc — be deliberate.

## Commands & Aliases
```bash
pnpm typecheck    # tsgo — web + every worker + every package; THE typecheck (run from repo root)
pnpm dev          # Vite :3000 + workers :8787, :8790-8794 — ask before starting
pnpm lint         # Biome — skip routine runs (noisy, sometimes wrong); pre-commit auto-formats
```
> **Typecheck is tsgo.** `pnpm typecheck` is the only check an agent runs. `pnpm typecheck:tsc` (a `tsc` parity pass) is reserved for CI and pre-prod; don't reach for tsc after backend/worker edits.
> In the `avlo-parallel` worktree, run `pnpm dev:p` instead of `pnpm dev` — it shifts every wrangler port by `PORT_OFFSET` (and Vite to :5180) so the two checkouts can run side-by-side without colliding.

> **Search tooling (optional).** `rg`, `fd`, `jq`, and `ast-grep`/`sg` are installed if you want them. `rg`/`fd` honor `.gitignore` by default (no manual `node_modules`/`dist` excludes); plain `grep -r` does not. Use whatever fits — none of this is required.

- `@avlo/shared` → `packages/shared/src/*` (cross-runtime; client + server)
- `@avlo/worker-shared` → `packages/worker-shared/src/*` (server-only — never imported client-side)
- `@avlo/db` → `packages/db/src/*` (server-only — D1 + DO-SQLite Drizzle schemas; never client-side)
- `@avlo/api-client` → `packages/api-client/src/*` (browser/SW typed `hc<AppType>` clients)
- `@avlo/py-loader` → `packages/py-loader/src/index.ts` (the committed Python build-lock + `matchesLockEntry`; also `/verify` for lock-free consumers)
- `@/*` → `web/src/*`

`packages/py-build` is the Python **toolchain** (the uv-run `avlo-build` CLI + manual docker lanes; pipeline DAG in turbo — `pnpm py:board`) — never imported, only run. It is the sole member of the repo-root **uv workspace** (root `pyproject.toml` + committed root `uv.lock`).

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

All paths relative to `web/src/` unless noted.

### Runtime (`runtime/`)
| File | Responsibility |
|------|----------------|
| `CanvasRuntime.ts` | Central orchestrator — events, subscriptions, tool dispatch |
| `SurfaceManager.ts` | DOM refs (contexts, editorHost, cursorHost) + resize/DPR + deferred canvas resize |
| `tool-registry.ts` | Self-constructing tool singletons + lookup helpers (pen/highlighter/shape→drawingTool, text/note→textTool, image→one-shot file picker, rest→own singleton) |
| `room-doc-manager.ts` | Y.Doc lifecycle, providers, spatial index, deep observer, presence + session wiring. **→ `docs/object-lifecycle.md`.** WS provider → `wss://sync.avlo.io/sync/rooms/<id>` (host = `SYNC_HOST` — `sync.<domain>` remote / null local → `window.location.host` via the Vite `/sync` proxy; prefix = `SYNC_WS_PREFIX`) — cross-origin to the SPA, gated server-side by the CSWSH Origin allowlist in sync's `on-before-connect` |
| `room-runtime.ts` | Module-level room context — `connectRoom`/`disconnectRoom` + imperative getters |
| `ContextMenuController.ts` | Imperative singleton: floating-ui positioning, show/hide |
| `input/InputManager.ts` | DOM event forwarder + modifier state (shift/ctrl/meta) |
| `input/keyboard-manager.ts` | All keybindings: tool switches, Cmd modifiers, spacebar pan, zoom, arrow pan |
| `input/toolbar-place.ts` | Drag-place entry from inspector buttons — applies the selection, `beginPlace` on the tool singleton, pointer capture to canvas + grabbing cursor; move/up then flow through the normal dispatch |
| `input/cursor-tracking.ts` | Last cursor world position (for paste placement) |
| `input/install-ui-zoom-block.ts` | Window capture-phase block of browser page-zoom (Ctrl/⌘ wheel/±/0, Safari pinch) on canvas routes only; toggles `html.canvas-room` |
| `presence/presence.ts` | Awareness lifecycle, cursor send (throttle + backpressure), receive dispatch. Delegates peer state to the renderer. Owns the WS-connected flag `RoomDocManager` reads |
| `presence/presence-renderer.ts` | `PresenceCursorRenderer` — SoA peer state, slot pool, self-driven rAF, DOM `<img>` cursors (host at z:4, above editor overlay) |
| `presence/presence-pointer.ts` | Pure dispatch for the `document`-level local-cursor input path (move/out/blur/camera-sync) |
| `viewport/zoom.ts` | Smooth zoom animations (step, pinch, zoom-to-fit, reset) |
| `viewport/edge-scroll.ts` | Auto-pan near viewport edges during drags |
| `viewport/arrow-key-pan.ts` | Continuous arrow key panning with easeInQuad acceleration |

### Renderer (`renderer/`)
File map + the whole pipeline live in **`docs/rendering-and-caches.md`**. Module-level entry points you'll import from elsewhere: `invalidateWorld{,BBox,All}` (`RenderLoop.ts`), `invalidateOverlay` (`OverlayRenderLoop.ts`), `removeObjectCaches`/`clearAllObjectCaches` (`object-cache.ts`), `evictGeometry` (`geometry-cache.ts`).

### Tools (`tools/` — zero-arg singletons via `tool-registry.ts`)
| File | Notes |
|------|-------|
| `types.ts` | `PointerTool` interface, `ShapeType`, `PreviewData` union |
| `selection/SelectTool.ts` | Selection state machine, translate, scale, connector endpoints, code/text editing entry |
| `selection/transform.ts` | `TransformController` (scale/translate/endpoint drag), entry system, per-kind dispatch tables |
| `selection/types.ts` | Shared selection types (`TransformState`, entry/dispatch helpers) |
| `selection/selection-utils.ts` | Composition, bounds, declarative `foldField` over the field table |
| `selection/selection-actions.ts` | Mutation wrappers — each a 1-3 line `applyField`/`toggleField`/`adjustByPresets` |
| `selection/selection-field-table.ts` | `FieldDescriptor<V>` table + `foldField`/`applyField`/`toggleField`/`adjustByPresets` primitives |
| `selection/connector-topology.ts` | `buildTopology` — graph of attached connectors per selected shape |
| `selection/connector-flow.ts` | Connector Flows — inline N/S/E/W connector affordances for a single bindable selection (drag = create, click = connect/duplicate). Overlay-only previews; commits flow the normal observer path |
| `selection/convert-kind.ts` | Cross-kind conversion text↔note↔shape — in place, same Y.Map/id; one `transact` over pre-read plans, downstream driven by the observer's kind-keychange branch |
| `DrawingTool.ts` | Pen, highlighter, shape drawing. `hold-detector.ts` (550ms) fires the $P recognizer on dwell. `'place'` mode (toolbar drag-place via `beginPlace`) — 180wu preview follows cursor, commits on drop |
| `EraserTool.ts` | Geometry-aware hit testing + deletion |
| `TextTool.ts` | WYSIWYG rich text + sticky notes, Tiptap DOM overlay (`core/text/`). Note drag-place mode (`beginPlace`) — `NotePreview` follows cursor, drop creates + opens editor |
| `PanTool.ts` | Viewport panning (dedicated + MMB + spacebar) |
| `ConnectorTool.ts` | Elbow + straight connectors + snapping (`core/connectors/`) |
| `CodeTool.ts` | Code blocks, CodeMirror overlay (`core/code/`), run/output affordances (`core/py/`) |

### Core (`core/`)
| File | Responsibility |
|------|----------------|
| `accessors.ts` | Typed Y.Map accessors (per-field + per-kind bulk `getXxxProps`) |
| `types/objects.ts` | `ObjectKind`, `ObjectHandle` (+ `createHandle`/`applyHandleBBox`), prop types, `BindableKind`/`BINDABLE_KINDS`/`isBindable*` |
| `types/geometry.ts` | `BBoxTuple`, `FrameTuple`, `WorldBounds`, `Frame` + converters |
| `types/handles.ts` | `HandleId` taxonomy (corner/side), type guards, `scaleOrigin`, `handleCursor` |
| `index.ts` | Type re-export barrel |
| `geometry/bbox.ts` | `computeBBoxFor{,Into}(id, kind, yMap[, out])` — unified per-kind dispatch; `computeConnectorBBoxFromPointsInto`, `bboxEquals`. **→ `docs/object-lifecycle.md`** |
| `geometry/bounds.ts` | BBox/frame tuple helpers, WorldBounds ops, mutating primitives (`offset*`, `copy*`, `*Mut`) |
| `geometry/frame-of.ts` | `frameOf(handle)` — mapped dispatch to per-subsystem frame getter for any bindable kind |
| `geometry/shape-path.ts` | Build Path2D from frame tuple |
| `geometry/scale-system.ts` | Pure math atoms: `uniformFactor`, `preservePosition`, `edgePinPosition1D`, `computeReflowWidth` |
| `geometry/hit-primitives.ts` | Pure tuple-first hit math: point/segment/polyline/shape/rect/circle atoms |
| `geometry/recognizer/` | $P/$Q shape recognizer — 550ms-hold match. Entry: `recognize.ts`, `hold-detector.ts`. See CLAUDE.md |
| `spatial/` | Hit testing + region queries. Entry: `object-query.ts` (picker facade), `handle-hit.ts`, `hit-dispatch.ts`, `object-spatial-index.ts`. See CLAUDE.md |
| `connectors/` | Elbow A* + straight routing, snap, rich-text labels. Entry: `connector-router.ts`, `snap.ts`, `reroute-connector.ts`, `anchor-atoms.ts`, `connector-paths.ts`, `connector-label.ts`, `constants.ts`. See CLAUDE.md |
| `text/` | Layout engine + three-tier cache + sticky notes. Entry: `text-system.ts`, `line-break.ts`, `text-measure.ts`, `shape-label.ts`, `sticky-note.ts`, `font-config.ts`, `font-loader.ts`. See CLAUDE.md |
| `code/` | Two-tier tokenization + CodeMirror + canvas renderer. Entry: `code-system.ts`, `code-tokens.ts`, `lezer-worker.ts`, `code-theme.ts`. See CLAUDE.md |
| `py/` | In-browser Python for code blocks — forked Pyodide in a supervisor→executor worker pair, OPFS snapshots, hardened realm. Entry: `py-manager.ts`, `py-supervisor.ts`, `py-executor.ts`, `py-protocol.ts`. See CLAUDE.md |
| `image/` | Offline-first pipeline + demand-scaled work-stealing decode pool over a SharedArrayBuffer control plane. Entry: `image-manager.ts`, `image-sab.ts`, `image-cache.ts`, `image-actions.ts`, `image-worker.ts`. See CLAUDE.md |
| `sab/` | Worker-agnostic SharedArrayBuffer control-plane toolkit (`Futex`, `SpmcRing`, `SlotTable`, `allocControlSab`/`assertCrossOriginIsolated`). First consumer: image decode. See CLAUDE.md |
| `bookmark/` | URL unfurl + OG metadata. Entry: `bookmark-render.ts`, `bookmark-actions.ts`, `bookmark-unfurl.ts`, `bookmark-placeholder.ts`. See CLAUDE.md |
| `clipboard/` | Nonce-based clipboard + serializer. Entry: `clipboard-actions.ts`, `clipboard-serializer.ts`. See CLAUDE.md |
| `z-order/` | `ZRankTable` (SoA Uint32 ranks + slot pool) + bring/send/forward/backward actions. Algorithm lives in `@avlo/shared/z-order` (cross-runtime). See CLAUDE.md |

### Stores
| File | Responsibility |
|------|----------------|
| `camera-store.ts` | Camera state, coordinate transforms, canvas element, pointer capture, per-room persistence |
| `device-ui-store.ts` | Toolbar state, drawing settings, cursor management (persisted; immer). The structural model for new stores |
| `auth-store.ts` | Server-resolved identity — synchronous persisted mirror of the `/me` query (`query/me.ts`, its only writer). Account sessions add `email`/`avatarHash` (cleared on sign-out; UI-only — `getUserProfile` excludes them so email never reaches awareness). `getUserId`/`getUserProfile` throwing getters |
| `selection-store.ts` | Selection state, transform state |
| `presence-store.ts` | Peer identities + count (Zustand, for React components only) |
| `room-list-store.ts` | Two local slices. **`rooms`** — per-room facts for interacted rooms (createdAt/lastVisitedAt + `title` fact — local-only-room display fallback, stamped by the rename mutation; born only from a real create/visit/rename, so timestamps are always real, never sentinels) PLUS persisted server-fact mirrors `permission`/`ownerName`/`isOwner` (update-only — stamped by `absorbServerRooms` in the rooms queryFn and the `perm:`/`owner:` pushes; private-not-owned entries PRUNED, ids returned for doc-DB deletion). **`starredIds`** — the star-preference id set, DECOUPLED from facts so `toggleStar` flips membership only and never fabricates a timestamp. `removeRoom` (4403 path), `clearAllRooms` (sign-out purge) clear both; `absorbServerRooms`'s prune drops the dangling star too. localStorage (persist v2 hoists legacy in-`RoomFacts` stars); merged with the D1 projection in `query/room-list.ts` (immer) |
| `room-session-store.ts` | Server-delivered room session state (immer): mode/access (`mode:` custom message; 4401/4403 close codes) + `title`/`isOwner`/`permission` (`title:`/`owner:`/`perm:` pushes, seeded from the rooms cache in the room route's beforeLoad — `title` drives the TopBar name + tab title, `isOwner` gates the rename affordance + the Share modal's permission dropdown, `permission` is that dropdown's current value) |
| `history-store.ts` | Undo/redo availability (`canUndo`/`canRedo`) for toolbar buttons + `bindUndoManagerToHistoryStore` (subscribes a `Y.UndoManager`'s stack events → the store; disposer resets to `(false,false)`; called by `room-doc-manager`) |
| `core/py/py-run-store.ts` | Ephemeral per-block Python run phase (Zustand, non-persisted). Never written to Y. See `core/py/CLAUDE.md` |

### Utils + Shared
| File | Responsibility |
|------|----------------|
| `utils/math.ts` | `clamp`, `clamp01`, `hypot2` — branchless inline forms |
| `utils/dispose.ts` | `dispose<T>(value, fn): null` — single-line teardown chain; swallows teardown throws |
| `utils/color.ts` | `createFillFromStroke(stroke, mixRatio)` |
| `utils/room-local-data.ts` | `ROOM_DOC_DB_PREFIX` (the y-indexeddb DB-name template) + `deleteRoomDocDB` (fire-and-forget; callers skip the active room — its open connection blocks the delete) + `purgeAllRoomDocDBs` (sign-out sweep; pre-mount only) |
| `packages/shared/src/types/identifiers.ts` | `RoomId`, `UserId`, `StrokeId`, `TextId` (branded) |
| `packages/shared/src/types/permission.ts` | `Permission` (`z.enum`; value + type) |
| `packages/shared/src/utils/user-id.ts` | `generateUserId` (auth `/me` only), `asUserId`, `USER_ID_RE` |
| `packages/shared/src/utils/room-id.ts` | `generateRoomId`, `normalizeRoomId`, `asRoomId`, `ROOM_ID_RE` |
| `packages/shared/src/utils/room-title.ts` | `ROOM_TITLE_MAX_LEN`, `normalizeRoomTitle` — the single rename validity rule (client input, users Zod, DO guard) |
| `packages/shared/src/utils/user-profile.ts` | `nameForUserId`, `colorForUserId`, `userProfileFor`, `PRESENCE_COLORS` |
| `packages/shared/src/utils/ulid.ts` | `ulid()` |
| `packages/shared/src/utils/url-utils.ts` | `normalizeUrl`, `isValidHttpUrl`, `extractDomain`, `prettifyDomain` |
| `packages/shared/src/utils/image-validation.ts` | `validateImage`, `isSvg`, `parseImageDimensions` |

### Server (`workers/`)

Seven independently-deployed Cloudflare Workers. Full inventory (wrangler names, dev ports, bindings), hardening invariants, and the app-type/drift-guard pattern in **`workers/CLAUDE.md`**.

| Worker | Prod | What it owns |
|---|---|---|
| **main** | `avlo.io`, `www.avlo.io` | Pure site host — SPA + `_headers` CSP via Static Assets. No worker script, no bindings, so SPA deploys never touch the DO worker |
| **sync** | `sync.avlo.io` | WSS `/sync/*` (`partyserverMiddleware`) + `on-before-connect` (CSWSH Origin guard + identity gate) + `AvloDO` (per-room meta in DO-SQLite, live permissions, owner-only meta RPCs, tier-3 WS limiter) |
| **images** | `images.avlo.io` | `PUT/GET /:key` (auth'd upload, hash-verify, edge cache, Range) + `GET /avatars/:hash` + `ImagesRpc.ingestAvatar` |
| **unfurl** | `unfurl.avlo.io` | `GET /?url=` — auth'd, Zod + SSRF refine, HTMLRewriter OG extraction, image→R2, edge cache 7d |
| **auth** | `auth.avlo.io` | `GET /me` (KV session → signed `avlo_anon` cookie), the Google OAuth flow (`/login/google` → `/callback` → promote-or-adopt + KV session; `POST /logout`), `AuthRpc.verifySession` |
| **users** | `users.avlo.io` | Sole D1 schema owner. `GET /rooms` (dashboard list) + `PATCH /rooms/:id/{permission,title}` (owner-only DO RPC → rev-guarded D1) + `UsersRpc.linkAccount` / `migrateOwnedRooms` + the visits/meta/migrate queue consumer |
| **py** | `py.avlo.io` | Anonymous immutable Python-artifact serving: `GET /:hash/:file` + `/:hash/bundles/:name`, brotli `.br` negotiation, edge cache. Keys come from the committed `@avlo/py-loader` build-lock; seeded by `pnpm py:seed` |

`@avlo/db` (server-only) owns the D1 + DO-SQLite Drizzle schemas. Identity is **server-resolved only** (`/me`) — the client never mints a userId. Routes blocks land **commented out** today; deploy is gated on DNS transfer + additional pre-prod essentials.

### Routes + UI
`routes/` (own CLAUDE.md) — `__root.tsx` (queryClient context + `QueryClientProvider`), `index.tsx` (→ `/home` redirect), `home.tsx` (dashboard — `useRoomList`), `room.$roomId.tsx` (`connectRoom` in `beforeLoad`).
`components/`: top-level `Canvas.tsx` (thin React wrapper), `RoomPage.tsx`, `ZoomControls.tsx`, `UserAvatarCluster.tsx`; subsystem dirs with own CLAUDE.md — `topbar/`, `toolbar/`, `dashboard/`, `context-menu/`.
Service Worker: `sw.ts` (cache-first images origin + app shell, network-first HTML; lock-verified py-artifact routes — `core/py/CLAUDE.md` "Serving & caching").

---

## Architecture Overview

```
Canvas.tsx (thin React wrapper — mounts DOM, creates runtime)
  └── new CanvasRuntime().start({ container, gridCanvas, baseCanvas, overlayCanvas, editorHost, cursorHost })

CanvasRuntime (the brain)
  ├── SurfaceManager   — DOM refs + resize/DPR + deferred canvas resize
  ├── gridLoop         — standalone dot-grid canvas below content (own sizing + on-demand rAF; renderer/grid/CLAUDE.md)
  ├── renderLoop       — base canvas, tile-grid dirty tracking (native rAF)
  ├── overlayLoop      — tool preview + animation jobs, full clear each frame (peer cursors render as DOM, not here)
  ├── InputManager     — pointer + keyboard + modifier state
  ├── camera subscription → tool.onViewChange() (guarded by isEdgeScrolling) + context menu + presence cursor
  └── pointer dispatch → spacebar/MMB pan check → tool.begin/move/end
```

### Data flow

```
Y.Doc (source of truth)
   ↓ observeDeep — the ONE update path (synchronous, end-of-transaction)
RoomDocManager
   ├─ computeBBoxForInto  → also populates the kind's subsystem cache
   ├─ upsertHandle        → spatial index + geometry eviction + dirty rects
   └─ connector reroute drain
         ↓
   RenderLoop (dirty-rect base) · OverlayRenderLoop (full-clear overlay)
         ↑
   camera-store (scale, pan, viewport) — self-subscribed
```

Phase-by-phase in `docs/object-lifecycle.md`; what the caches hold and how pixels land in `docs/rendering-and-caches.md`.

### Event flow

```
Canvas pointer → InputManager → CanvasRuntime:
  screenToWorld → setLastCursorWorld (paste-at-cursor) → updateEdgeScroll (edge auto-pan)
  → getCurrentTool().begin/move/end → tool state → invalidateOverlay (preview) / invalidateWorldBBox (geometry)

Document pointer → InputManager → presence-pointer.ts:
  screenToWorldInto → updateCursor (local cursor broadcast — fires over DOM chrome too, separate from the canvas chain)
```

---

## Routing (TanStack Router)

File-based, auto code-split (`routeTree.gen.ts`); `/` → `/home` (dashboard), `/room/$roomId` is the canvas. `/room/$roomId` `beforeLoad` drives `connectRoom(roomId)` (after `await ensureIdentity()`, then seeds session-store title/owner/permission + `recordVisit`); `RoomPage` cleanup calls `disconnectRoom` with `key={roomId}` forcing a full remount. `connectRoom` is destructive, so `defaultPreload: false` — never preload a room link. Components read `roomId` via `getRouteApi('/room/$roomId').useParams()`. See `routes/CLAUDE.md`; identity/cache boot ordering in `query/CLAUDE.md`.

---

## PointerTool Interface

All tools implement `PointerTool` (`tools/types.ts`): `canBegin`, `begin(pointerId, worldX, worldY)`, `move` (also hover), `end`, `cancel`, `isActive`, `getPointerId`, `getPreview` → overlay rendering, `onPointerLeave`, `onViewChange`, `destroy`. Zero-arg constructors — dependencies read from stores at runtime (settings frozen at `begin()`).

---

## Room Runtime (`runtime/room-runtime.ts`)

Module-level room context. `connectRoom(roomId)` from route `beforeLoad`, `disconnectRoom(roomId)` from RoomPage cleanup. Fail-fast (throws if no room).

**Key exports:** `connectRoom`/`disconnectRoom`/`hasActiveRoom`, `getHandle(id)`/`getHandleKind(id)`/`getBbox(id)`/`getObjectsById()`/`getSpatialIndex()`/`getObjects()`/`getZOrder()`, `transact<T>(fn): T | undefined`/`transactPyOutput<T>(fn)` (origin `PY_RUN_ORIGIN` — persists + broadcasts but stays out of the undo stack)/`undo()`/`redo()`. Re-exports from `connector-router`: `getConnectorRoute(id)`, `getAttachedConnectors(shapeId)`, `detachConnectorFromShape`, `renormalizeAttachedAnchors`.

Prefer `getHandle(id)` over `getObjectsById().get(id)`. Prefer `transact(fn)` over `getActiveRoomDoc().mutate(fn)` — `transact` returns whatever `fn` returns, so callers can elide the `let foo; transact(()=>{ foo = ... })` dance.

---

## Invalidation — Singleton Render Loops

Module-level singletons, safe no-ops before `start()`. Tools and observers import directly.
- **RenderLoop:** `invalidateWorldBBox(bbox)` (the one you want — no allocation), `invalidateWorld(bounds)` (`WorldBounds` object form), `invalidateWorldAll()`
- **OverlayRenderLoop:** `invalidateOverlay()`

Two behaviours worth knowing before you reason about ordering: once a **full clear** is latched (by `invalidateWorldAll`, a camera change, or a canvas resize) the rect publishers become complete no-ops for that frame; and **every camera change forces a full clear**, so pan/zoom are not dirty-rect events at all. Mechanism in `docs/rendering-and-caches.md`.

---

## Y.Doc Structure (v2)

```ts
Y.Doc { guid: roomId }
└─ objects: Y.Map<Y.Map<unknown>>      // top-level, always exists — all objects by ULID

type ObjectKind = 'stroke' | 'shape' | 'text' | 'connector' | 'code' | 'image' | 'note' | 'bookmark';
```

### Schemas

All objects share `{ id (ULID), kind, ownerId, createdAt, z: ZKey }`. `id` is creation-ordered and immutable (used for identity + references); `z` is a mutable fractional sort key (opaque, lex-comparable — see `core/z-order/` + `@avlo/shared/z-order`). **Color semantics:** `color` = stroke color (shape/stroke/connector) or text color (text); `fillColor` = background always; shapes and connectors use `labelColor` for label text. Per-kind fields:

- **Stroke** (pen/highlighter) — `{ tool: 'pen'|'highlighter', color, width, opacity, points: [number,number][] }`
- **Shape** (rect/ellipse/diamond/roundedRect/triangle) — `{ shapeType, color, width, opacity, fillColor?, frame: [x,y,w,h], content?: Y.XmlFragment, fontSize?, fontFamily?, labelColor? }`. Label fields added on first edit, removed if empty on close. (`'line'` is tool-layer only — previewed as a segment, committed as a 2-point stroke.)
- **Text** — `{ origin: [anchorX, baseline], fontSize, fontFamily, color, align, width: 'auto'|number, fillColor?, content: Y.XmlFragment }`. Frame derived (`getTextFrame(id)`). Delta attrs: bold, italic, highlight (`{color}` or presence → `'#ffd43b'`).
- **Code** — `{ origin: [topLeftX, topLeftY], fontSize, width: number, language, content: Y.Text, lineNumbers?, title?, headerVisible?, outputVisible?, output?, outputStatus?, figureIds? }`. Origin = top-left (unlike text). Frame via `getCodeFrame(id)`. `output`/`outputStatus` written by python runs (`core/py/`); `figureIds` tracks the run-created figure images (see `core/py/CLAUDE.md`).
- **Connector** — `{ connectorType: 'elbow'|'straight', start: ConnectorEndpoint, end: ConnectorEndpoint, startCap, endCap, color, width }` + optional rich-text label under the shape-label keys (`content: Y.XmlFragment`, `fontSize`, `fontFamily`, `labelColor` — no width, no fill; `core/connectors/connector-label.ts`). **No geometry stored** — endpoints are point/anchor refs; the routed polyline lives in `ConnectorRouter`'s cache (`getConnectorRoute(id)`). Always opacity 1.
- **Note** — `{ origin: [topLeftX, topLeftY], scale, fontFamily, align, alignV, fillColor, content: Y.XmlFragment }`. No fontSize/width (derived from content + scale). Text color contrast-derived from `fillColor` (`getStickyNoteTextColor`); `fillColor` per-instance, default `#FEF3AC`.
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
  m.set('ownerId', getUserId()); // auth-store
  m.set('createdAt', Date.now());
  m.set('z', generateZAtTop(getZOrder().maxZ())); // newest on top
  getObjects().set(id, m);
});
```

**`z` is mandatory and never hand-authored** — a fractional sort key minted against the current stack. Generators (`generateZAtTop` etc.) are exported from `@avlo/shared`; `getZOrder()` (room-runtime) returns the client `ZRankTable`, whose `.maxZ()`/`.minZ()` give the current top/bottom `z` (`null` on an empty doc). One object on top → `generateZAtTop(getZOrder().maxZ())`. N objects in one `transact` → `generateNZAtTop(getZOrder().maxZ(), n): ZKey[]` — mint once, assign in order (see `clipboard-actions.ts`). `*AtBottom` (minZ) / `*Between` variants cover the other anchors; reorder actions live in `core/z-order/`.

### ObjectHandle (live reference, IS the rbush item)
`objectsById` and the spatial index reference the **same** object — one source of truth, two access paths; spatial queries return handles directly. Full shape in `core/types/objects.ts`:
```ts
interface ObjectHandle {
  id; kind;                  // kind mirrors y.get('kind')
  y: Y.Map<unknown>;         // LIVE reference
  bbox: BBoxTuple;           // [minX,minY,maxX,maxY]
  minX; minY; maxX; maxY;    // rbush envelope — mirrors bbox[0..3]
  z: ZKey;                   // mirrors y.get('z')
  slot: number;              // immutable Uint32 index into ZRankTable._ranks
}
```
Every field has exactly one legal writer, and violating that desyncs the spatial tree silently — as does writing `objectsById`, the spatial index, `zOrder` or any per-object cache from application code, since all of them are the deep observer's alone: mutate the Y.Map and let it do the rest. **The mutation-invariant table is in `docs/object-lifecycle.md` §1 — read it before writing to a handle.** The wrapper persists for the id's lifetime, so consumers needing a snapshot across observer fires clone at read time (`[...handle.bbox]`).

### Stored vs derived geometry

Three classes — **stored** (shape/image `frame`, stroke `points`), **derived** (text/note/code/bookmark: no frame key in Y at all; a subsystem cache computes it, read via `getTextFrame`/`getCodeFrame`/`getBookmarkFrame`), and **routed** (connector: endpoint refs only, polyline in `ConnectorRouter`). Use `frameOf(handle)` (`core/geometry/frame-of.ts`) rather than hand-writing the switch. Full model, per-kind bbox dispatch and padding rules in `docs/object-lifecycle.md` §1.

**Global dispatch helpers** (reach for these before a subsystem): `frameOf(handle)`, `getHandleShapeType(handle)` (`shapeType` for shapes, `'rect'` else), and `BINDABLE_KINDS`/`isBindableKind`/`isBindableHandle`/`isUnbindableKind` (`core/types/objects.ts`).

---

## Types & Accessors

**Geometry types** (`core/types/geometry.ts`): `BBoxTuple = [minX,minY,maxX,maxY]`, `FrameTuple = [x,y,w,h]`, `Point = [x,y]`. Object forms: `WorldBounds`, `Frame`. Converters: `tupleToFrame`, `frameToTuple`, `frameToWorldBounds`, `bboxTupleToWorldBounds`, `worldBoundsToBBoxTuple`, `worldBoundsToFrame`, `frameTupleIntersectsBounds`.

**Bounds helpers** (`core/geometry/bounds.ts`): `expandBBox`, `expandBBoxEnvelope`, `unionBBox`, `scaleBBoxAround`, `pointsToBBox{,Mut}`, `translateBBox`/`translatePoint`/`translateFrame`/`translatePoints`, `frameToBbox{,Mut}`, `bboxToFrame{,Mut}`, `copyBbox`, `copyFrame`, `bboxCenter`, `bboxSize`, `frameCenter`, `fillFrameCenter`, `cornerFrame`, `unionBounds`, `expandEnvelope`, `translateBounds`, `scaleBoundsAround`, `expandBounds`, `boundsCenter`/`boundsWidth`/`boundsHeight`, `offsetPoint`, `offsetBBox`, `offsetFrame`, `offsetPoints`, `setBBoxXYWH`, `boundsIntersect`. Many have in-place `*Mut` / `fill*` / `offset*` mirrors — use them on hot paths.

**Typed Y.Map accessors** (`core/accessors.ts`): prefer over raw `.get()`.
- Per-field: `getColor`/`getColorOrNull`/`getOpacity`/`getWidth`/`getFrame`/`getFrameObject`/`getOrigin`/`getPoints`; connector `getStart`/`getEnd`/`getStartCap`/`getEndCap`/`getConnectorType`/`getRouteInputs`; text·code `getFontSize`/`getFontFamily`/`getAlign`/`getAlignV`/`getContent`/`getCodeText`/`getTextWidth`/`getLanguage`/`getLineNumbers`/`getHeaderVisible`/`getOutputVisible`/`getCodeOutput`/`getOutputStatus`; shape `getShapeType`/`getHandleShapeType`/`getFillColor`/`getLabelColor`/`hasLabel`; stroke `getStrokeTool`; image·bookmark `getAssetId`/`getNaturalDimensions`/`getBookmarkUrl`.
- Per-kind bulk (**preferred**): `getStrokeProps`/`getShapeProps`/`getTextProps`/`getCodeProps`/`getNoteProps`/`getImageProps`/`getBookmarkProps`/`getConnectorProps`. Each returns `null` when a required field is missing — that null is load-bearing upstream, don't paper over it.
- Key types: `TextAlign`, `TextAlignV`, `TextWidth`, `FontFamily` (4 fonts), `CodeLanguage`, `CodeOutputStatus`, `StoredAnchor` (elbow/straight), `ConnectorCap`, `ConnectorType`.

Renderer leaf draws do **not** use these — they use the `_map`-direct readers in `renderer/render-accessors.ts`. See `docs/rendering-and-caches.md` §5.

---

## Three-canvas architecture

- **Grid canvas (z:0):** standalone WebGPU/Canvas2D dot grid below all content — own loop + sizing, 0×0 (near-zero memory) when off. See `renderer/grid/CLAUDE.md`.
- **Base canvas (z:1):** world content, dirty-rect optimized, native rAF. Clears **transparent** so the grid shows through; the container div supplies the `#fafafa` fill. Pointer input lands here.
- **Overlay canvas (z:2):** full clear each frame — tool preview, selection UI, animation jobs (eraser trail).

Above them sit two DOM layers: the editor host (z:3, Tiptap/CodeMirror overlays) and the cursor host (z:4) — peer cursors are DOM `<img>`, not canvas, which is how they sit above the editor.

**Coordinate spaces.** World (logical) → CSS pixels (browser) → device pixels (CSS × DPR). `worldToCanvas: (x - pan.x) * scale`, `canvasToWorld: x / scale + pan.x`. Read DPR from `camera-store`, never `window.devicePixelRatio` — past the 16384 backing-store clamp they diverge.

---

## Camera Store (`stores/camera-store.ts`)

Zustand store: `scale`, `pan`, `cssWidth`, `cssHeight`, `dpr`, `roomCameras`, `currentRoomId`. Per-room camera persistence via `setRoom(roomId)` — saves outgoing, restores incoming (localStorage, 1Hz debounce — no `persist` middleware).

**Module-level functions:** `worldToCanvas`, `canvasToWorld`, `screenToWorld`, `screenToWorldInto` (zero-alloc, writes into `out` — hot path), `screenToCanvas`, `worldToClient`, `getVisibleWorldBounds` (object form), `getVisibleBoundsTuple` (shared readonly scratch tuple — hot path; don't hold it across calls), `setCanvasElement`, `getCanvasElement`, `capturePointer`, `releasePointer`, `isMobile`, `subscribeCamera` (diff-cached over the six camera fields), `getViewTransform`, `createViewTransform`.

Imperative: `useCameraStore.getState()`. Reactive: `useCameraStore(selector)`. Constants: `MIN_ZOOM`, `MAX_ZOOM`.

---

## Device UI Store (`stores/device-ui-store.ts`)

Persisted Zustand store (immer). `activeTool`, `drawingSettings` (size/color/opacity/fill), per-tool defaults (text, note, shape, connector, code), `cursorOverride`. **The structural model for new stores** — State + Actions interfaces, actions inside `create` via `immer`, stable destructured action exports, `subscribe` side-effects.

Imperative getters: `setCursorOverride`, `applyCursor`. Constants: `TEXT_FONT_SIZE_PRESETS`, `TEXT_FONT_FAMILIES`, `HIGHLIGHT_COLORS`, `NOTE_COLOR_PALETTE`.

**Identity lives in `stores/auth-store.ts`** (not here) — server-resolved via `/me`, never a client mint. `getUserId()` / `getUserProfile()` (throwing getters; used for `ownerId`, undo origin, presence self-filter) are there; the `/me` TanStack Query (`query/me.ts`) is the sole writer.

---

## Pointers to the rest

- **Query layer** — server-projection reads (`/me`, `GET /rooms`) + offline mutations, IndexedDB-persisted, `networkMode: 'offlineFirst'`. File map, boot ordering, the `?auth=` OAuth-marker flow, the `auth-store` write path → `query/CLAUDE.md`.
- **Selection system** — state machine, per-kind transform, connector topology, hit testing, text/code reflow, commit paths → `tools/selection/CLAUDE.md`. Entry points: `SelectTool`, `transform.ts`, `core/geometry/scale-system.ts`, `selection-store.ts`.
- **Other tools** — `DrawingTool` (pen/highlighter/shape), `PanTool` (also MMB + spacebar), `EraserTool` (geometry-aware, all kinds), `ConnectorTool` → `core/connectors/CLAUDE.md`, `CodeTool` → `core/code/CLAUDE.md`.
- **Keyboard, clipboard, presence, image, bookmark, python** → `runtime/input/`, `core/clipboard/`, `runtime/presence/`, `core/image/`, `core/bookmark/`, `core/py/` CLAUDE.mds.
