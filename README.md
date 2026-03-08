# Avlo

Offline-first collaborative whiteboard built on CRDTs. Real-time sync with zero-conflict merging — every client can draw, type, and connect shapes simultaneously, online or off.

## Features

- **Freehand drawing** — Pen and highlighter with pressure-sensitive strokes
- **Shape recognition** — Hold to auto-detect rectangles, ellipses, and diamonds via $P point-cloud recognizer
- **Rich text** — WYSIWYG text objects with bold, italic, highlight, multiple fonts, and alignment
- **Shape labels** — Inline rich text editing inside shapes
- **Connectors** — Orthogonal auto-routed connectors with A\* pathfinding, shape snapping, and live rerouting on transform
- **Selection system** — Multi-object select with translate, scale, and connector-aware transforms
- **Context menu** — Selection-aware floating toolbar with style controls per object kind
- **Real-time presence** — Live cursors with interpolation and smoothing
- **Offline-first** — IndexedDB persistence, seamless reconnection and sync

## Architecture

```
Client (React + Canvas API)          Cloudflare Workers (Serverless)
┌──────────────────────────┐         ┌──────────────────────────┐
│  Canvas Runtime           │  Yjs   │  Durable Object (Room)   │
│  ├─ Base canvas (60fps)  │◄──────►│  ├─ YServer (WebSocket)  │
│  ├─ Overlay canvas       │  sync  │  ├─ Hibernate on idle    │
│  ├─ Tool system          │        │  └─ Debounced persistence │
│  └─ Dirty-rect rendering │        │                          │
│                          │        │  R2 (Object Storage)     │
│  Yjs CRDT (Y.Doc)       │        │  └─ V2-encoded snapshots │
│  ├─ Spatial index (R-tree)│        └──────────────────────────┘
│  └─ IndexedDB offline    │
└──────────────────────────┘
```

- **Sync:** Yjs CRDT — all writes are conflict-free, no server-side merge logic
- **Backend:** Cloudflare Durable Objects with hibernation for per-room state, R2 for persistent storage
- **Rendering:** Two-canvas architecture — base layer with dirty-rect optimization, overlay for previews and presence
- **Tools:** Singleton pattern with zero-arg constructors, world-coordinate unified interface

## Stack

| Layer   | Technology                               |
| ------- | ---------------------------------------- |
| Client  | React 19, TypeScript, Canvas API, Tiptap |
| Sync    | Yjs, y-partyserver, y-indexeddb          |
| Backend | Cloudflare Workers, Durable Objects, R2  |
| Build   | Vite, npm workspaces, Wrangler           |

## Development

```bash
npm install
npm run dev          # Client :3000 + Worker :8787
npm run typecheck    # Type check all workspaces
```
