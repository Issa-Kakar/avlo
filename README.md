# Avlo

A real-time collaborative whiteboard with offline-first architecture, built on CRDTs. Conflict-free sync across clients — draw, type, connect, and arrange simultaneously, online or off.

Canvas rendering with dirty-rect optimization, R-tree spatial indexing, parallel Web Worker image decoding, and Service Worker asset caching. Native requestAnimationFrame — runs at your display's refresh rate (144fps on 144Hz).

## What You Can Do

**Draw freely** — Pen and highlighter with velocity-based stroke smoothing. Four sizes, full color palette, adjustable opacity. Hold to trigger shape recognition ($P point-cloud algorithm) that snaps freehand strokes into perfect rectangles, ellipses, or diamonds.

**Place shapes** — Rectangle, ellipse, diamond, and rounded rectangle. Optional fill colors, configurable stroke width. Every shape supports inline rich text labels with full formatting, font selection, and horizontal + vertical alignment.

**Write rich text** — WYSIWYG editing via Tiptap with bold, italic, multicolor highlight, four font families (Inter, Grandstander, Lora, JetBrains Mono), and left/center/right alignment. Auto-width or fixed-width wrapping. Optional background fill. All text syncs live via Y.XmlFragment.

**Stick notes** — Fixed-width sticky notes with auto-sizing font that adapts to content length. Horizontal and vertical text alignment. Uniform scale transform preserves readability at any zoom level.

**Write code** — Syntax-highlighted code blocks (JavaScript, TypeScript, Python) via CodeMirror. Optional line numbers. Font size stepper. Width reflows on side-handle drag. Full collaborative editing through Y.Text binding.

**Connect things** — Orthogonal connectors with A\* pathfinding that route around obstacles, plus straight-line connectors. Shape-anchored endpoints with 8-point snap grid. Configurable arrow caps on either end. Connectors automatically reroute when connected shapes are moved, scaled, or transformed.

**Drop images** — Drag-and-drop, paste from clipboard, or pick from file dialog (`i` key). PNG, JPEG, WebP, GIF supported. SVGs auto-rasterized at 2048–4096px. Content-addressed storage (SHA-256) deduplicates identical files. Three-level mip system with generation-based staleness — zoom triggers instant mip superseding with no flicker.

**Paste URLs** — Paste any URL to create a bookmark card. Server-side HTMLRewriter extracts OG/Twitter metadata, fetches and stores OG images and favicons to R2 (content-addressed). Two card layouts: full card with image or text-only. Offline pastes gracefully fall back to text objects.

**Select and transform** — Marquee multi-select, shift-click additive select. Per-kind transform semantics: shapes scale freely, strokes scale uniformly, text and code reflow on side-handle drag, images preserve aspect ratio, bookmarks maintain fixed dimensions. Connector topology recomputes live during transforms — anchored connectors reroute via A\* each frame.

**Erase precisely** — Geometry-aware eraser with per-kind hit testing. Stroke distance checks, ellipse normalized-space containment, diamond edge intersection. Accumulates hits across the entire drag path. Connected shape deletion auto-cleans connector anchors.

## Collaboration

Built on Yjs CRDTs — every mutation is conflict-free with no server-side merge logic. Document state syncs via WebSocket through Cloudflare Durable Objects with hibernation support.

- **Live cursors** with trajectory trails, cubic-resampled smoothing, and 140ms decay
- **Simultaneous editing** of text, code, notes, and all object properties
- **Per-user undo/redo** via Y.UndoManager — your undo history is isolated from other users' edits
- **Offline-first** — IndexedDB persistence + Service Worker caching. Draw, edit, and arrange offline; everything syncs on reconnect

## Performance

- **Dirty-rect rendering** — Float64Array buffer tracks up to 16 rects per frame, auto-promotes to full clear above 33% canvas area. Base canvas runs at 60fps with minimal overdraw.
- **Spatial indexing** — R-tree (RBush) for viewport queries, hit testing, snap targets, and connector routing obstacle detection.
- **Parallel image decode** — Two Web Worker instances, hash-routed by asset ID for consistent affinity. Generation counter prevents stale decodes from blocking fresh mip levels.
- **Viewport culling** — Only visible objects are rendered and decoded. 5.5x padded viewport pre-decodes images for smooth scrolling. Off-viewport bitmaps evicted to free memory.
- **Service Worker** — Cache-first for content-addressed assets (immutable, 1-year TTL) and app shell. Network-first for HTML navigation. Workers self-sufficient via Cache API — works without SW in development.
- **Text layout cache** — Three-tier cache (tokenize → measure → layout) with granular invalidation. OffscreenCanvas for synchronous text measurement.

## Architecture

```
Client (Canvas API + React)               Cloudflare Workers
┌────────────────────────────────┐        ┌─────────────────────────────┐
│ CanvasRuntime                  │  Yjs   │ Durable Object (per room)   │
│ ├─ Base canvas (dirty-rect)   │◄──────►│ ├─ WebSocket sync           │
│ ├─ Overlay canvas (preview)   │  sync  │ ├─ Hibernate on idle        │
│ ├─ Tool system (8 tools)      │        │ └─ R2 snapshot persistence  │
│ └─ Spatial index (R-tree)     │        │                             │
│                                │        │ Hono API                    │
│ Web Workers (×2)              │        │ ├─ PUT/GET /api/assets/:key │
│ ├─ Image decode + ingest      │        │ ├─ GET /api/unfurl?url=     │
│ ├─ SHA-256 hashing            │        │ └─ HTMLRewriter + R2 store  │
│ └─ Upload queue (IDB-backed)  │        │                             │
│                                │        │ R2 Buckets                  │
│ Service Worker                │        │ ├─ avlo-assets (images)     │
│ └─ Cache-first asset serving  │        │ └─ avlo-docs (Y.Doc V2)    │
│                                │        └─────────────────────────────┘
│ Y.Doc (CRDT)                  │
│ ├─ 8 object kinds             │
│ ├─ IndexedDB offline          │
│ └─ Y.UndoManager             │
└────────────────────────────────┘
```

## Stack

| Layer     | Technology                                                    |
| --------- | ------------------------------------------------------------- |
| Rendering | Canvas API, OffscreenCanvas, dirty-rect optimization          |
| Editing   | Tiptap (rich text), CodeMirror (code), Y.XmlFragment / Y.Text |
| Sync      | Yjs CRDT, y-partyserver, WebSocket, Y.UndoManager             |
| Offline   | Service Worker, Cache API, IndexedDB (y-indexeddb)            |
| Workers   | 2× Web Workers (image decode/ingest/upload), Lezer (syntax)   |
| Server    | Cloudflare Workers, Hono, Durable Objects, R2, HTMLRewriter   |
| Client    | React 19, TypeScript, Zustand, Vite                           |
| Geometry  | $P point-cloud recognizer, A\* pathfinding, RBush R-tree      |

## Keyboard Shortcuts

**Tools**

| Key             | Action                        |
| --------------- | ----------------------------- |
| `V`             | Select                        |
| `P`             | Pen                           |
| `E`             | Eraser                        |
| `T`             | Text                          |
| `N`             | Sticky note                   |
| `H`             | Pan                           |
| `A`             | Connector                     |
| `R` / `O` / `D` | Rectangle / Ellipse / Diamond |
| `I`             | Insert image                  |

**Actions**

| Key                              | Action                                  |
| -------------------------------- | --------------------------------------- |
| `Space` (hold)                   | Pan mode                                |
| `Arrow keys` (hold)              | Continuous pan with acceleration        |
| `Enter`                          | Edit selected text / note / shape label |
| `Escape`                         | Cancel gesture or clear selection       |
| `Delete` / `Backspace`           | Delete selected                         |
| `Shift+click`                    | Add/remove from selection               |
| `Ctrl+click`                     | Toggle individual selection             |
| `Ctrl` (while drawing connector) | Suppress shape snapping                 |

**Modifiers (Cmd/Ctrl +)**

| Key              | Action                    |
| ---------------- | ------------------------- |
| `C` / `X` / `V`  | Copy / Cut / Paste        |
| `D`              | Duplicate                 |
| `A`              | Select all                |
| `Z`              | Undo                      |
| `Shift+Z` or `Y` | Redo                      |
| `B` / `I` / `H`  | Bold / Italic / Highlight |
| `=` or `+`       | Zoom in                   |
| `-`              | Zoom out                  |
| `0`              | Zoom to fit               |

## Development

```bash
npm install
npm run dev          # Client :3000 + Worker :8787
npm run typecheck    # Type-check all workspaces
```
