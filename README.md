# Avlo

An offline-first, real-time collaborative whiteboard. State is a [Yjs](https://github.com/yjs/yjs) CRDT — every edit is conflict-free across clients, online or off. The canvas is rendered by hand on the 2D Canvas API (no scene-graph library) and is highly performant: dirty-rect repainting, an R-tree spatial index, and zero-allocation hot paths.

Pre-production. The code is being opened up as a reference for the architecture, not (yet) as a turnkey product.

## Features

Eight object kinds, each with its own subsystem:

- **Freehand strokes** — pen + highlighter via [perfect-freehand](https://github.com/steveruizok/perfect-freehand); velocity-based smoothing. Hold 550ms to fire a `$P` point-cloud recognizer that snaps a freehand stroke into a clean shape.
- **Shapes** — rectangle, ellipse, diamond, triangle, rounded-rect. Optional fill, configurable stroke; each carries an inline rich-text label.
- **Connectors (arrow binding)** — elbow connectors routed with A\* around obstacles, plus straight lines. Endpoints bind to shapes via an 8-point snap grid and **reroute live** as bound shapes move, scale, or transform. Configurable end caps. No geometry is stored — only endpoint refs; the routed polyline is recomputed and cached.
- **Rich text & sticky notes** — WYSIWYG [Tiptap](https://tiptap.dev) editing bound to `Y.XmlFragment`. Bold / italic / multicolor highlight, four fonts, alignment, auto- or fixed-width wrap. Sticky notes auto-size their font to content and scale uniformly.
- **Code blocks** — WYSIWYG [CodeMirror](https://codemirror.net) editing bound to `Y.Text`. Two-tier highlighting: a synchronous regex floor for instant color, upgraded by a [Lezer](https://lezer.codemirror.net) worker. JS / TS / Python.
- **Images** — drag-drop, clipboard paste, or file picker (`I`). Content-addressed by SHA-256 (identical files dedupe). Decoded in parallel Web Workers; mip levels swap on zoom without flicker; uploads queue through IndexedDB and flush on reconnect.
- **Link cards** — paste a URL and the server unfurls it: HTMLRewriter extracts OpenGraph/Twitter metadata and mirrors the preview image + favicon into R2. Offline pastes fall back to a plain text object.
- **Select, transform & erase** — marquee + additive select; per-kind transform semantics (shapes scale freely, strokes scale uniformly, text/code reflow on side handles, images lock aspect, link cards stay fixed). Geometry-aware eraser with per-kind hit testing.

**Collaboration & offline**

- Yjs CRDT over WebSocket; a per-room Cloudflare **Durable Object** (in the `sync` worker) relays sync and hibernates when idle, snapshotting the doc to R2.
- Per-user **undo/redo** isolated via `Y.UndoManager`.
- **Offline-first**: `y-indexeddb` persistence + a Service Worker (cache-first for content-addressed assets, network-first for HTML). Draw offline; everything reconciles on reconnect.
- **Accounts & rooms** — identity is server-resolved: anonymous by default (a signed cookie), with optional Google sign-in. A rooms dashboard lists your boards, each with shareable, owner-controlled permissions; room metadata and account state project to Cloudflare D1.
- **Installable PWA** — web manifest + favicon/touch-icon set and theme color (icon set is provisional).
- Live peer cursors with smoothed trajectory trails (rendered as DOM, above the canvas).

## Quick start

Requires **Node 24+** and **pnpm 11+** (enable via `corepack enable`). [Turborepo](https://turbo.build) orchestrates the workspace.

```bash
pnpm install

# Auth worker dev secrets — copy the template, then fill in the blanks.
# Without workers/auth/.dev.vars, /me and Google sign-in return 500.
cp workers/auth/.dev.vars.example workers/auth/.dev.vars

pnpm dev          # Vite (web) :3000 + workers via Miniflare (sync :8787, images/unfurl/auth/users :8790–8793)
pnpm typecheck    # tsgo — web app + workers (run from repo root)
pnpm build        # turbo run build — production web bundle + worker builds
pnpm lint         # Biome lint
pnpm check        # Biome lint + format check
```

`pnpm dev` runs the full stack concurrently — Vite plus a single Miniflare instance hosting every worker. The `main` worker is static-assets-only, so it has no dev process.

Deploy is per-worker (Cloudflare), or all at once:

```bash
pnpm deploy:main   # or deploy:sync / deploy:images / deploy:unfurl / deploy:auth / deploy:users
pnpm deploy        # all six, in order
```

## Architecture

A [pnpm](https://pnpm.io) + [Turborepo](https://turbo.build) monorepo — one web app, four shared packages, six independently deployed Cloudflare Workers:

```
avlo/
├── web/                  @avlo/web — React 19 + Canvas SPA (Vite, TanStack Router + Query, Zustand)
├── packages/
│   ├── shared/           @avlo/shared        — cross-runtime: z-order (fractional indexing), ULID,
│   │                                           branded id types, URL/image validation, room/user identity helpers
│   ├── worker-shared/    @avlo/worker-shared — server-only Hono/Zod primitives: CORS/CSP, the auth gate +
│   │                                           anon-cookie/session helpers, rate limiting, SSRF, RPC contracts
│   ├── api-client/       @avlo/api-client    — typed `hc<AppType>` RPC clients, origin + SW matchers
│   └── db/               @avlo/db            — server-only Drizzle schemas: D1 (rooms, users, visits)
│                                               + Durable-Object SQLite (per-room metadata)
└── workers/
    ├── main/             avlo.io        — SPA static assets + `_headers` CSP (assets-only, no worker script)
    ├── sync/             sync.avlo.io   — WebSocket room sync: a per-room `AvloDO` Durable Object + R2 snapshots
    ├── images/           images.avlo.io — content-addressed image store on R2 (+ account avatars)
    ├── unfurl/           unfurl.avlo.io — URL → OpenGraph-metadata extraction → R2
    ├── auth/             auth.avlo.io   — identity: anonymous cookies + Google OAuth (PKCE), KV sessions
    └── users/            users.avlo.io  — accounts + rooms dashboard/permissions on D1 (Drizzle), queue consumer
```

**Client.** A single `CanvasRuntime` orchestrates everything: a dirty-rect **base canvas** (only the rects published via `invalidateWorld*` repaint), a full-clear **overlay canvas** for tool previews and selection UI, an `InputManager`, and a tool registry of zero-arg singletons (select, draw, eraser, text/note, pan, connector, code). The Yjs document is the single source of truth — a deep observer turns CRDT changes into spatial-index updates, cache eviction, and dirty rects in one synchronous pass. An [RBush](https://github.com/mourner/rbush) R-tree backs viewport queries, hit testing, snap targets, and connector obstacle detection. Hot paths (render frame, observer fire, pointer move, reroute) are zero-allocation and monomorphic, using typed-array scratch buffers.

**Backend.** Workers, each on its own subdomain and deploy:

- **main** — the site host: serves the SPA (and the `_headers` CSP) via Cloudflare's Static Assets layer. Assets-only (no worker script), so SPA deploys never touch the realtime worker.
- **sync** (`sync.avlo.io`) — the realtime layer. `y-partyserver` routes `/sync/*` WebSocket connections to a per-room `AvloDO` Durable Object that relays Yjs updates, hibernates on idle, and persists Y.Doc snapshots to the `avlo-docs` R2 bucket. An edge Origin guard + cookie-based identity gate the upgrade, and per-room metadata (owner, permission, title) lives in the DO's SQLite.
- **images** — `PUT`/`GET /:key` against the `avlo-assets` R2 bucket. Zod-validated keys, content-length bounds, server-side hash verification, HTTP Range, and long-lived edge caching (assets are immutable + content-addressed). Also serves account avatars.
- **unfurl** — `GET /?url=` fetches a page, runs HTMLRewriter to pull OG/Twitter tags, mirrors the preview image + favicon into R2 (content-addressed), and edge-caches for 7 days. SSRF-guarded.
- **auth** (`auth.avlo.io`) — identity. `GET /me` mints and slides a signed anonymous cookie (KV-backed sessions); Google OAuth (PKCE + state/nonce) promotes an anonymous user into an account. Exposes a `verifySession` RPC that every other worker uses to gate requests.
- **users** (`users.avlo.io`) — accounts + rooms. Sole owner of the D1 schema (`@avlo/db`): the rooms dashboard list, owner-only room permission/title edits, and a queue consumer projecting room visits + metadata into D1.

`@avlo/api-client` exposes each Worker's Hono `AppType` as a typed client, so the browser and Service Worker call the backend with end-to-end type safety and no hand-written fetch wrappers.

## Stack

| Layer      | Technology                                                                |
| ---------- | ------------------------------------------------------------------------- |
| Rendering  | Canvas 2D + OffscreenCanvas, dirty-rect repaint, native `rAF`             |
| Editing    | Tiptap (rich text), CodeMirror + Lezer (code), `Y.XmlFragment` / `Y.Text` |
| Sync       | Yjs CRDT, `y-partyserver`, WebSocket, `Y.UndoManager`                     |
| Offline    | Service Worker + Cache API, IndexedDB (`y-indexeddb`), installable PWA     |
| Identity   | Anonymous signed cookies + Google OAuth (PKCE), Workers KV sessions        |
| Validation | Zod — request schemas + SSRF refinement, shared across web and workers     |
| Web Workers| Image decode/ingest/upload pool (SharedArrayBuffer control plane), Lezer syntax worker |
| Server     | Cloudflare Workers, Hono, Durable Objects, R2, D1 + Drizzle, KV, Queues, HTMLRewriter |
| Client     | React 19, TypeScript, Zustand, Immer, Vite, TanStack Router + Query        |
| Geometry   | `$P` point-cloud recognizer, A\* routing, RBush R-tree                    |
| Tooling    | pnpm + Turborepo, Biome (lint + format), `tsgo` (type-check), Wrangler + Miniflare |

## Keyboard shortcuts

**Tools** — `V` select · `P` pen · `E` eraser · `T` text · `N` sticky note · `A` connector · `H` pan · `R`/`O`/`D`/`3` rectangle/ellipse/diamond/triangle · `I` insert image

**Canvas** — `Space` (hold) pan · arrow keys pan (accelerating) · `Enter` edit selection · `Esc` cancel / clear · `Delete` remove · `]`/`[` bring forward / send backward · `Shift`+click additive select · `Ctrl` (while drawing a connector) suppress snapping

**Cmd/Ctrl +** — `C`/`X`/`V` copy/cut/paste · `D` duplicate · `A` select all · `Z` undo · `Shift+Z` / `Y` redo · `B`/`I`/`H` bold/italic/highlight · `=` zoom in · `-` zoom out · `0` zoom to fit

## License

Not yet finalized — an open-source license will be added before release.
