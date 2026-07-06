# AVLO Codebase Guide
**Purpose:** Offline-first collaborative whiteboard with Yjs CRDT sync.
**Stack:** React / TS / Canvas + Yjs (CRDT) + Vite. Server: Cloudflare Workers (Hono + Zod) — Durable Objects (SQLite), D1, R2, KV, Queues; Drizzle ORM. Build: pnpm workspaces + Turborepo.

## Subsystems

Each ships its own `CLAUDE.md` (file map + notes): `core/{text,code,connectors,image,sab,bookmark,clipboard,spatial,z-order,locks,geometry/recognizer}`, `renderer/grid`, `tools/selection`, `runtime/{input,presence,viewport}`, `query`, `routes`, `components/{context-menu,toolbar,topbar,dashboard}`. Reading any file in one pulls its whole doc — be deliberate. Cross-kind concerns (`RoomDocManager`, `computeBBoxFor`, render pipeline) live here.

## Commands & Aliases
```bash
pnpm typecheck    # tsgo — client + all 5 workers; THE typecheck (run from repo root)
pnpm dev          # Vite :3000 + workers :8787, :8790-8793 — ask before starting
pnpm lint         # Biome — skip routine runs (noisy, sometimes wrong); pre-commit auto-formats
```
> **Typecheck is tsgo** for client and workers alike — `pnpm typecheck` is the only check an agent runs. `pnpm typecheck:tsc` (a `tsc` parity pass) is reserved for CI and pre-prod; don't reach for tsc after backend/worker edits.
> In the `avlo-parallel` worktree, run `pnpm dev:p` instead of `pnpm dev` — it shifts every wrangler port by `PORT_OFFSET` so the two checkouts can run side-by-side without colliding.

> **Search tooling (optional).** `rg`, `fd`, `jq`, and `ast-grep`/`sg` are installed if you want them. `rg`/`fd` honor `.gitignore` by default (no manual `node_modules`/`dist` excludes); plain `grep -r` does not. Use whatever fits — none of this is required.

- `@avlo/shared` → `packages/shared/src/*` (cross-runtime; client + server)
- `@avlo/worker-shared` → `packages/worker-shared/src/*` (server-only — never imported client-side)
- `@avlo/db` → `packages/db/src/*` (server-only — D1 + DO-SQLite Drizzle schemas; never client-side)
- `@avlo/api-client` → `packages/api-client/src/*` (browser/SW typed `hc<AppType>` clients)
- `@/*` → `web/src/*`

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
| `room-runtime.ts` | Module-level room context — `connectRoom`/`disconnectRoom` + imperative getters |
| `room-doc-manager.ts` | Y.Doc lifecycle, providers, spatial index, deep observer, presence wiring. WS provider → `wss://sync.avlo.io/sync/rooms/<id>` (prod; host = `SYNC_HOST_PROD`, prefix = `SYNC_WS_PREFIX`) — cross-origin to the SPA, gated server-side by the CSWSH Origin allowlist in sync's `on-before-connect` |
| `ContextMenuController.ts` | Imperative singleton: floating-ui positioning, show/hide |
| `input/InputManager.ts` | DOM event forwarder + modifier state (shift/ctrl/meta) |
| `input/keyboard-manager.ts` | All keybindings: tool switches, Cmd modifiers, spacebar pan, zoom, arrow pan |
| `input/toolbar-place.ts` | Drag-place entry from inspector buttons — applies the selection, `beginPlace` on the tool singleton, pointer capture to canvas + grabbing cursor; move/up then flow through the normal dispatch |
| `input/cursor-tracking.ts` | Last cursor world position (for paste placement) |
| `input/install-ui-zoom-block.ts` | Window capture-phase block of browser page-zoom (Ctrl/⌘ wheel/±/0, Safari pinch) on canvas routes only; toggles `html.canvas-room` |
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
| `grid/` | Third canvas — standalone WebGPU/Canvas2D dot grid below content ('G' toggles). See CLAUDE.md |
| `types.ts` | `FRAME_CONFIG`, Perfect Freehand options, `getSvgPathFromStroke` |
| `geometry-cache.ts` | Path2D (strokes/shapes) + ConnectorPaths cache; observer-driven eviction (bbox change, `shapeType` / `startCap` / `endCap` keychange) |
| `render-accessors.ts` | Per-kind `_map.get` readers (`readXxxRender(y)`) + per-kind module scratches. Two helpers split by Content subclass — `readPrim` (ContentAny via `arr[0]`) and `readY` (ContentType via `type`). Both check `!val.deleted` (tombstones survive `.delete(key)`). Zero alloc, monomorphic per subclass. Hot path only |
| `object-cache.ts` | Unified eviction: `removeObjectCaches(id, kind)`, `clearAllObjectCaches()` |
| `layers/objects.ts` | Object rendering dispatch, transform preview, fill-aware Z-order |
| `layers/selection-overlay.ts` | Selection highlights, bbox, circular handles (marquee owned by SelectTool) |
| `layers/tool-preview.ts` | Active-tool preview dispatcher |
| `layers/connector-preview.ts` | In-flight connector overlay |
| `layers/connector-render-atoms.ts` | Shared connector draw atoms (`paintConnector`, `drawAnchorDot`, dash guides) |
| `layers/connector-flow.ts` | Connector-flow overlay: N/S/E/W flow buttons + hover preview (offscreen faded layer) + live flow-drag connector |
| `layers/shape-preview.ts` | In-flight shape draw (line/rect/ellipse/diamond/roundedRect) |
| `layers/stroke-preview.ts` | In-flight Perfect Freehand stroke |
| `layers/eraser-dim.ts` | Dim hovered objects under eraser via 'screen' blend |
| `lock-veil/` | Remote-lock veil — worker-owned canvas layer (`transferControlToOffscreen`) between base and overlay painting a grey filter rect per locked bbox; main thread ships camera scalars + one transferred bbox Float64Array, worker culls + single-path fills, 0×0 when idle (see `core/locks/CLAUDE.md`) |
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
| `selection/connector-flow.ts` | Connector Flows — inline N/S/E/W connector affordances for a single bindable selection (drag = create, click = connect/duplicate). Overlay-only previews; commits flow the normal observer path |
| `selection/convert-kind.ts` | Cross-kind conversion text↔note↔shape — in place, same Y.Map/id; one `transact` over pre-read plans, downstream driven by the observer's kind-keychange branch |
| `DrawingTool.ts` | Pen, highlighter, shape drawing. `hold-detector.ts` (550ms) fires the $P recognizer on dwell. `'place'` mode (toolbar drag-place via `beginPlace`) — 180wu preview follows cursor, commits on drop |
| `EraserTool.ts` | Geometry-aware hit testing + deletion |
| `TextTool.ts` | WYSIWYG rich text + sticky notes, Tiptap DOM overlay (`core/text/`). Note drag-place mode (`beginPlace`) — `NotePreview` follows cursor, drop creates + opens editor |
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
| `image/` | Offline-first pipeline + demand-scaled work-stealing decode pool (1 baseline, grows under backlog, idle extras self-retire) over a SharedArrayBuffer control plane. Entry: `image-manager.ts`, `image-sab.ts`, `image-cache.ts`, `image-actions.ts`, `image-worker.ts`. See CLAUDE.md |
| `sab/` | Worker-agnostic SharedArrayBuffer control-plane toolkit (`Futex`, `SpmcRing`, `SlotTable`, `allocControlSab`/`assertCrossOriginIsolated`). First consumer: image decode (`image-sab.ts`). See CLAUDE.md |
| `bookmark/` | URL unfurl + OG metadata. Entry: `bookmark-render.ts`, `bookmark-actions.ts`, `bookmark-unfurl.ts`, `bookmark-placeholder.ts`. See CLAUDE.md |
| `clipboard/` | Nonce-based clipboard + serializer. Entry: `clipboard-actions.ts`, `clipboard-serializer.ts`. See CLAUDE.md |
| `z-order/` | `ZRankTable` (SoA Uint32 ranks + slot pool) + bring/send/forward/backward actions. Algorithm lives in `@avlo/shared/z-order` (cross-runtime). See CLAUDE.md |
| `locks/` | Ephemeral conflict-resolution grabs — `lockOwner: Uint32Array` keyed by `handle.slot` (0=unlocked, 1=mine, ≥2=peer key; every guard is ONE `lo[slot] > 1` compare), binary `MSG_LOCK` frames on the Yjs WS (never awareness), DO-arbitrated first-wins, worker-rendered grey veil. Entry: `lock-table.ts`, `lock-protocol.ts` (+ `@avlo/shared/lock-protocol`, `workers/sync/src/room.ts`, `renderer/lock-veil/`). See CLAUDE.md |

### Stores
| File | Responsibility |
|------|----------------|
| `camera-store.ts` | Camera state, coordinate transforms, canvas element, pointer capture, per-room persistence |
| `device-ui-store.ts` | Toolbar state, drawing settings, cursor management (persisted; immer). The structural model for new stores |
| `auth-store.ts` | Server-resolved identity — synchronous persisted mirror of the `/me` query (`query/me.ts`, its only writer). Account sessions add `email`/`avatarHash` (cleared on sign-out; UI-only — `getUserProfile` excludes them so email never reaches awareness). `getUserId`/`getUserProfile` throwing getters |
| `selection-store.ts` | Selection state, transform state |
| `presence-store.ts` | Peer identities + count (Zustand, for React components only) |
| `room-list-store.ts` | Two local slices. **`rooms`** — per-room facts for interacted rooms (createdAt/lastVisitedAt + `title` fact — local-only-room display fallback, stamped by the rename mutation; born only from a real create/visit/rename, so timestamps are always real, never sentinels) PLUS persisted server-fact mirrors `permission`/`ownerName`/`isOwner` (update-only — stamped by `absorbServerRooms` in the rooms queryFn and the `perm:`/`owner:` pushes; private-not-owned entries PRUNED, ids returned for doc-DB deletion). **`starredIds`** — the star-preference id set, DECOUPLED from facts so `toggleStar` flips membership only and never fabricates a timestamp (the merge reads it as an independent overlay). `removeRoom` (4403 path), `clearAllRooms` (sign-out purge) clear both; `absorbServerRooms`'s prune drops the dangling star too. localStorage (persist v2 hoists legacy in-`RoomFacts` stars); merged with the D1 projection in `query/room-list.ts` (immer) |
| `room-session-store.ts` | Server-delivered room session state (immer): mode/access (`mode:` custom message; 4401/4403 close codes) + `title`/`isOwner`/`permission` (`title:`/`owner:`/`perm:` pushes, seeded from the rooms cache in the room route's beforeLoad — `title` drives the TopBar name + tab title, `isOwner` gates the rename affordance + the Share modal's permission dropdown, `permission` is that dropdown's current value) |
| `history-store.ts` | Undo/redo availability (`canUndo`/`canRedo`) for toolbar buttons + `bindUndoManagerToHistoryStore` (subscribes a `Y.UndoManager`'s stack events → the store; disposer resets to `(false,false)`; called by `room-doc-manager`) |

### Utils + Shared
| File | Responsibility |
|------|----------------|
| `utils/math.ts` | `clamp`, `clamp01`, `hypot2` — branchless inline forms |
| `utils/dispose.ts` | `dispose<T>(value, fn): null` — single-line teardown chain |
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

Six independently-deployed Cloudflare Workers. Full architecture, hardening invariants, ports, and the app-type/drift-guard pattern in `workers/CLAUDE.md`.

| Worker | Folder | Prod | Bindings | Surface |
|---|---|---|---|---|
| **main** | `workers/main/` | `avlo.io`, `www.avlo.io` | Static Assets only (no worker script, no bindings) | Pure site host — serves the SPA + the `_headers` CSP via Cloudflare's Static Assets layer. Sync split out to `avlo-sync`, so SPA deploys (`deploy:main`) never touch the DO worker |
| **sync** | `workers/sync/` | `sync.avlo.io` | `rooms` (DO/SQLite, class `AvloDO`), `DOCS` (R2), `AUTH` (service), `ROOM_VISITS`/`ROOM_META` (queue producers) | WSS `/sync/*` (`partyserverMiddleware`, prefix `SYNC_WS_PREFIX` → `/sync/rooms/<id>`) + `on-before-connect` (CSWSH Origin guard + identity gate) + `AvloDO` (per-room meta in DO-SQLite, live permissions, owner-only meta RPCs `setPermission`/`setTitle`/`migrateOwner`, tier-3 WS limiter) |
| **images** | `workers/images/` | `images.avlo.io` | `IMAGES` (R2), `AUTH` (service), `RL_UPLOAD` | `PUT/GET /:key` — `requireAuth` on PUT, Zod param, content-length bound, hash-verify, edge cache, Range, CSP — + `GET /avatars/:hash` (write-once 32-hex key, immutable cache) + `ImagesRpc.ingestAvatar` (Google avatar → R2 snapshot; auth-worker-only) |
| **unfurl** | `workers/unfurl/` | `unfurl.avlo.io` | `IMAGES` (R2, shared), `AUTH` (service), `RL_UPLOAD` | `GET /?url=` — `requireAuth`, Zod query + SSRF refine, HTMLRewriter OG extraction, image→R2, edge cache 7d |
| **auth** | `workers/auth/` | `auth.avlo.io` | `SESSIONS` (KV), `RL_AUTH`, services `USERS`/`IMAGES`, secrets `ANON_SECRET`/`GOOGLE_CLIENT_SECRET`/`OAUTH_PKCE_SECRET` | `GET /me` (KV session branch first → signed `avlo_anon` cookie mint/slide) + Google OAuth (`GET /login/google` → PKCE/state/nonce flow cookie → `GET /callback` trust pipeline → promote-or-adopt + KV session + promote+adopt anon rotation; `POST /logout`) + `AuthRpc.verifySession` (session→anon fallback; signature unchanged — every consumer inherits Google sessions) |
| **users** | `workers/users/` | `users.avlo.io` | `DB` (D1, sole schema owner), `AUTH` (service), `RL_ROOMS`, cross-script `rooms` (DO), `ROOM_MIGRATE` (queue producer), queue **consumers** `avlo-room-visits`/`avlo-room-meta`/`avlo-room-migrate` (+DLQs) | `GET /rooms` (dashboard list; `ownerName` via `users` left-join — private-not-owned rows redacted to `title:''`/`ownerName:null`, kept as the client's prune signal) + `PATCH /rooms/:id/{permission,title}` (owner-only DO RPC → direct rev-guarded D1 write + RYW bookmark) + `UsersRpc.linkAccount` (atomic promote-or-adopt upsert; auth-worker-only) + `UsersRpc.migrateOwnedRooms` (OAuth adopt owner-migration orchestrator — synchronous sync slice + `ROOM_MIGRATE` overflow; never throws; auth-worker-only) + `queue` consumer projecting visits/meta + draining migrate → D1 |

`@avlo/db` (server-only) owns the D1 + DO-SQLite Drizzle schemas. Identity is **server-resolved only** (`/me`) — the client never mints a userId. Routes blocks land **commented out** today; deploy is gated on DNS transfer + additional pre-prod essentials. `packages/{worker-shared,api-client,db}/CLAUDE.md` cover the shared backend primitives, typed-RPC clients, and DB schemas.

### Routes + UI
`routes/` (own CLAUDE.md) — `__root.tsx` (queryClient context + `QueryClientProvider`), `index.tsx` (→ `/home` redirect), `home.tsx` (dashboard — `useRoomList`), `room.$roomId.tsx` (`connectRoom` in `beforeLoad`).
`components/`: top-level `Canvas.tsx` (thin React wrapper), `RoomPage.tsx`, `ZoomControls.tsx`, `UserAvatarCluster.tsx`; subsystem dirs with own CLAUDE.md — `topbar/` (TopBar, RoomTitle, ShareModal, MainMenu, HistoryButtons), `toolbar/`, `dashboard/`, `context-menu/`.
Service Worker: `sw.ts` (cache-first `/api/assets/*`, app shell).

---

## Architecture Overview

```
Canvas.tsx (thin React wrapper — mounts DOM, creates runtime)
  └── new CanvasRuntime().start({ container, baseCanvas, overlayCanvas, editorHost })

CanvasRuntime (the brain)
  ├── SurfaceManager   — DOM refs + resize/DPR + deferred canvas resize
  ├── gridLoop         — standalone dot-grid canvas below content (own sizing + on-demand rAF; see renderer/grid/CLAUDE.md)
  ├── renderLoop       — base canvas, dirty-rect optimized (native rAF)
  ├── overlayLoop      — tool preview + animation jobs, full clear each frame (peer cursors render as DOM, not here)
  ├── InputManager     — pointer + keyboard + modifier state
  ├── camera subscription → tool.onViewChange() (guarded by isEdgeScrolling)
  └── pointer dispatch → spacebar/MMB pan check → tool.begin/move/end
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

**Key exports:** `connectRoom`/`disconnectRoom`/`hasActiveRoom`, `getHandle(id)`/`getHandleKind(id)`/`getBbox(id)`/`getObjectsById()`/`getSpatialIndex()`/`getObjects()`/`getZOrder()`, `transact<T>(fn): T | undefined`/`undo()`/`redo()`. Re-exports from `connector-router`: `getConnectorRoute(id)`, `getAttachedConnectors(shapeId)`, `detachConnectorFromShape`, `renormalizeAttachedAnchors`.

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
  m.set('ownerId', getUserId()); // device-ui-store
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
**Mutation invariants** (violate → spatial tree desyncs): `applyHandleBBox(handle, src)` — wrapped by `spatialIndex.updateHandleBBox` — is the ONLY legal post-creation writer of `bbox` + the four mirrors, written atomically; never `handle.bbox[N]=…` / `copyBbox(_, handle.bbox)`. `kind` mutates only in the observer's kind-keychange branch (in-place conversion, `convert-kind.ts`; evicts OLD-kind caches first so Phase B repopulates the new kind). `z` only in the observer's `'z'` handler. `slot` assigned once (`acquireSlot`), reusable after delete but never reassigned on a live handle. The wrapper persists for the id's lifetime — consumers needing a snapshot across fires clone at read time (`[...handle.bbox]`; transform/topology/image-manager do).

### Stored vs derived geometry

- **Stored in Y.Map:** shape/image `frame`, stroke `points`.
- **Derived** (subsystem-cached, via getter; `FrameTuple | null` before first layout): text/note `getTextFrame`, code `getCodeFrame`, bookmark `getBookmarkFrame`.
- **Connectors** — a third class: Y.Map stores endpoint refs only (`start`/`end`: point or `StoredAnchor`); the routed polyline lives in `ConnectorRouter`'s cache, populated by the observer. Read via `getConnectorRoute(id)`.

`computeBBoxFor{,Into}` (`core/geometry/bbox.ts`) dispatches per-subsystem — observer fires use `*Into` (pooled scratch), hydrate the allocating wrapper. **Global dispatch helpers** (reach for these before a subsystem): `frameOf(handle)` (`frame-of.ts`), `getHandleShapeType(handle)` (`shapeType` for shapes, `'rect'` else), and `BINDABLE_KINDS`/`isBindableKind`/`isBindableHandle`/`isUnbindableKind` (`core/types/objects.ts`).

---

## Types & Accessors

**Geometry types** (`core/types/geometry.ts`): `BBoxTuple = [minX,minY,maxX,maxY]`, `FrameTuple = [x,y,w,h]`, `Point = [x,y]`. Object forms: `WorldBounds`, `Frame`. Converters: `tupleToFrame`, `frameToTuple`, `frameToWorldBounds`, `bboxTupleToWorldBounds`, `worldBoundsToBBoxTuple`, `worldBoundsToFrame`, `frameTupleIntersectsBounds`.

**Bounds helpers** (`core/geometry/bounds.ts`): `expandBBox`, `expandBBoxEnvelope`, `unionBBox`, `pointsToBBox{,Mut}`, `translateBBox`, `frameToBbox{,Mut}`, `bboxToFrame{,Mut}`, `copyBbox`, `copyFrame`, `bboxCenter`, `bboxSize`, `frameCenter`, `fillFrameCenter`, `unionBounds`, `expandEnvelope`, `translateBounds`, `scaleBoundsAround`, `expandBounds`, `offsetPoint`, `offsetBBox`, `offsetFrame`, `offsetPoints`, `setBBoxXYWH`, `boundsIntersect`. Most have in-place `*Mut`/`*Into` mirrors — use them on hot paths.

**Typed Y.Map accessors** (`core/accessors.ts`): prefer over raw `.get()`.
- Per-field: `getColor`/`getOpacity`/`getWidth`/`getFrame`/`getOrigin`/`getPoints`; connector `getStart`/`getEnd`/`getStartCap`/`getEndCap`/`getConnectorType`/`getRouteInputs`; text·code `getFontSize`/`getFontFamily`/`getAlign`/`getAlignV`/`getContent`/`getCodeText`/`getTextWidth`/`getLanguage`/`getHeaderVisible`/`getOutputVisible`/`getCodeOutput`; shape `getShapeType`/`getHandleShapeType`/`getFillColor`/`getLabelColor`/`hasLabel`; image·bookmark `getAssetId`/`getNaturalDimensions`/`getBookmarkUrl`/`getBookmarkAssetIds`.
- Per-kind bulk (**preferred**): `getStrokeProps`/`getShapeProps`/`getTextProps`/`getCodeProps`/`getNoteProps`/`getImageProps`/`getBookmarkProps`/`getConnectorProps`.
- Key types: `TextAlign`, `TextAlignV`, `TextWidth`, `FontFamily` (4 fonts), `CodeLanguage`, `StoredAnchor` (elbow/straight), `ConnectorCap`, `ConnectorType`.

---

## RoomDocManager

Public fields (non-null from construction): `objectsById`, `spatialIndex`, `connectorRouter`. Sync constructor + async init: IDB sync → hydrate (non-connectors first, connectors second so bindable frames exist for routing) → `observeDeep` → UndoManager → WS provider (first `'sync'` → `repackSpatialIndex`).

### Observer Pipeline

`observeDeep` on `objects` is the single CRDT-driven update path — **synchronous main-thread, non-reentrant** (Y dispatches at end-of-transaction). By the time the callback returns every subsystem cache is consistent and visible dirty rects are published: no awaits, no microtasks, no race between Y change and renderable state.

**Two passes per fire.** First, **inline routing** — per event, route the edit to its subsystem hook so that state is fresh BEFORE the bulk phase reads it. This ordering is **load-bearing**: `compute*BBox` then reads already-fresh caches and Phase C can drain reroutes in the same fire (no second pass).
- top-level add/delete → `router.onConnectorAdded` / `onObjectDeleted`
- `kind` keychange (in-place conversion) → `removeObjectCaches(id, OLD kind)` → set `handle.kind` → `kindChanged+=id` + `router.onBindableChanged` (→shape eager-layouts so `getInlineStyles` is warm)
- connector `start|end|connectorType` → `router.onConnectorEdited`; `startCap|endCap` → `evictGeometry` (cap bakes into Path2D); shape `shapeType` → `router.onBindableChanged`
- nested `'content'` → code `codeSystem.handleContentChange` / text·label·note `textLayoutCache.invalidateContent`

Then **`applyObjectChanges`** over accumulated `touched`/`deleted` (`_newBBoxScratch` reused):
- **A · deletions** — `spatialIndex.remove` → `removeObjectCaches(id, kind)` → invalidate rect → `objectsById.delete` → `selection.onObjectsDeleted`.
- **B · touched** — skip ids queued for reroute (→C); connectors get style-only `router.computeBBox`, else `computeBBoxForInto` (★ **populates subsystem caches**) → `upsertHandle`; a bbox-changed bindable calls `router.onBindableChanged` (queues a reroute).
- **C · drain reroute queue** — `router.rerouteCanonical` (route + bbox) → `upsertHandle(…, alwaysEvict=true)`. Then `selection.onObjectsKindChanged` (re-derive composition BEFORE refreshStyles) + `onObjectsChanged`.

`upsertHandle` is the only bbox writer. On bbox change: invalidate prev rect → `spatialIndex.updateHandleBBox(handle, newBBox)` (`remove` reads old envelope → `applyHandleBBox` writes new tuple+mirrors → `insert`) → `evictGeometry` → invalidate new rect. **Order-critical** — `handle.bbox` must still hold OLD values at `updateHandleBBox` (rbush's `remove` descends to the old leaf). New rect is always invalidated (content can change visually without a bbox change); the `alwaysEvict` no-bbox-change path only evicts + invalidates. Mutate via `transact(fn)` (room-runtime), not `mutate(fn)`.

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

**Handle exists ⇒ caches populated.** Frame getters (`getTextFrame` / `getCodeFrame` / `getBookmarkFrame`) return `null` only on a genuine Map-miss — an id never observed or already deleted (its cache entry was removed alongside the handle). Within an id's lifetime its caches stay populated.

**Lazy exceptions** (populated on first read, not via observer):
- `renderer/geometry-cache.ts` — Path2D (stroke/shape), ConnectorPaths (connector). Evicted on bbox change in `upsertHandle`; `alwaysEvict=true` on every connector reroute (route-changed-but-bbox-same is common).
- **Shape label layouts.** The `shape` branch of `computeBBoxForInto` reads frame only — the label layout populates on first `drawShapeLabel`.

**Async exceptions** (cross a worker boundary — coarser fallback meanwhile, self-publish dirty rects): image bitmap decoding and Lezer syntax parsing. See `core/image/` + `core/code/`.

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

### Three-canvas architecture
- **Grid canvas (z:0):** Standalone WebGPU/Canvas2D dot grid below all content — own loop + sizing, 0×0 (near-zero memory) when off. The base canvas clears transparent so the grid shows through; the container div supplies the `#fafafa` fill. See `renderer/grid/CLAUDE.md`.
- **Base canvas (z:1):** World content, dirty-rect optimized, native rAF.
- **Overlay canvas (z:2):** Full clear each invalidation — tool preview, selection UI, animation jobs (eraser trail). Peer cursors are NOT on the overlay canvas — they're rendered as DOM `<img>` elements by `PresenceCursorRenderer` so they sit above the editor overlay.
- `SelectTool` renders transformed objects on the base canvas for correct Z-order during translate/scale.

### Object dispatch (`renderer/layers/objects.ts`)
`drawObjects` paints viewport candidates (from the spatial index) in z-order, dispatching each leaf `draw*` on `handle.kind`: stroke/shape/connector via geometry cache (Path2D / ConnectorPaths), text/note/code via layout caches, image via `getBitmap()`, bookmark via `drawBookmark()`. Under transform, selected/attached handles are re-injected by their preview bbox and scaled per-kind in `renderScaleEntry` (`getScaleBehavior` → reflow / uniform / else translated) — the scale-behavior model lives in `tools/selection/CLAUDE.md`. Per-frame state (editing ids, topology entries, translate delta, viewport) is hoisted once and leaf draws use module scratches for zero alloc; the file is self-contained on the specifics.

### Hot-path Y.Map reads (`renderer/render-accessors.ts`)
Each leaf `draw*` calls one `readXxxRender(y)` that reads only the keys it paints straight off Yjs's `_map` (~10 ns/key vs ~109 for `y.get()`) into a per-kind module scratch. The mechanism — `readPrim`/`readY` split by Content subclass, the `!deleted` tombstone guard, the `arr[0]` length-1 invariant, scratch-consumed-before-the-next-reader — is documented in the file.

Layout-bearing kinds (text/code/note/bookmark) read by id — `textLayoutCache.getLayoutById` / `codeSystem.getLayoutById` / `noteCachedLayout` / `bookmarkCache.getLayoutById` — bypassing Y.XmlFragment / Y.Text pulls; populator paths (bbox compute, shape labels) keep the stale-checked `getLayout(id, content, …)` signature.

### Coordinate spaces
World (logical) → CSS pixels (browser) → Device pixels (CSS × DPR). Transforms: `worldToCanvas: (x - pan.x) * scale`, `canvasToWorld: x / scale + pan.x`.

---

## Camera Store (`stores/camera-store.ts`)

Zustand store: `scale`, `pan`, `cssWidth`, `cssHeight`, `dpr`, `roomCameras`, `currentRoomId`. Per-room camera persistence via `setRoom(roomId)` — saves outgoing, restores incoming (localStorage, 1Hz debounce — no `persist` middleware).

**Module-level functions:** `worldToCanvas`, `canvasToWorld`, `screenToWorld`, `screenToWorldInto` (zero-alloc, writes into `out` — hot path), `screenToCanvas`, `worldToClient`, `getVisibleWorldBounds` (object form), `getVisibleBoundsTuple` (scratch readonly tuple — hot path), `setCanvasElement`, `getCanvasElement`, `capturePointer`, `releasePointer`, `isMobile`, `subscribeCamera`, `getViewTransform`, `createViewTransform`.

Imperative: `useCameraStore.getState()`. Reactive: `useCameraStore(selector)`. Constants: `MIN_ZOOM`, `MAX_ZOOM`.

---

## Device UI Store (`stores/device-ui-store.ts`)

Persisted Zustand store (immer). `activeTool`, `drawingSettings` (size/color/opacity/fill), per-tool defaults (text, note, shape, connector, code), `cursorOverride`. **The structural model for new stores** — State + Actions interfaces, actions inside `create` via `immer`, stable destructured action exports, `subscribe` side-effects.

Imperative getters: `setCursorOverride`, `applyCursor`. Constants: `TEXT_FONT_SIZE_PRESETS`, `TEXT_FONT_FAMILIES`, `HIGHLIGHT_COLORS`, `NOTE_COLOR_PALETTE`.

**Identity lives in `stores/auth-store.ts`** (not here) — server-resolved via `/me`, never a client mint. `getUserId()` / `getUserProfile()` (throwing getters; used for `ownerId`, undo origin, presence self-filter) are there; the `/me` TanStack Query (`query/me.ts`) is the sole writer. See Query Layer below.

---

## Query Layer (`query/` — TanStack Query) — see `query/CLAUDE.md`

Server-projection reads (`/me` identity, `GET /rooms` dashboard) + offline mutations (`rename-room`, `set-permission` → worker `PATCH /rooms/:id/{title,permission}`), IndexedDB-persisted, `networkMode: 'offlineFirst'`. File map, boot ordering, the `?auth=` OAuth-marker flow, and the `auth-store` write path all live in `query/CLAUDE.md`.

## Selection System

Detailed in `tools/selection/CLAUDE.md` (state machine, per-kind transform, connector topology, hit testing, text/code reflow, dirty-rect, commit paths). Entry points: `SelectTool` (state machine + commits + marquee), `transform.ts` (TransformController + dispatch tables + built topology), `core/geometry/scale-system.ts`, `selection-store.ts`.

---

## Other Tools

Beyond `SelectTool` (see Selection System), all tools sit in the Tools file map. `DrawingTool` — pen, highlighter, and shape drawing; `PanTool` also serves MMB + spacebar pan; `EraserTool` deletes all kinds via geometry-aware hit testing; `ConnectorTool` → `core/connectors/CLAUDE.md`; `CodeTool` → `core/code/CLAUDE.md`.

---

## Keyboard, Clipboard, Presence, Image, Bookmark

See subsystem CLAUDE.mds: `runtime/input/`, `core/clipboard/`, `runtime/presence/`, `core/image/`, `core/bookmark/`. Service Worker (`sw.ts`) is cache-first for `/api/assets/*` + app shell, network-first for HTML.
