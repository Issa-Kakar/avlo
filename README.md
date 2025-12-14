# Avlo

Offline-first real-time collaborative whiteboard with built-in code execution.

## Tech Stack

- **Frontend:** React, TypeScript, Canvas API
- **Sync:** Yjs CRDT for real-time collaboration
- **Backend:** Cloudflare Workers + R2
- **Persistence:** IndexedDB (offline-first)

## Features

- Freehand drawing (pen, highlighter)
- Shapes (rectangle, ellipse, diamond)
- Selection with translate/scale transforms
- Real-time presence cursors
- Offline-first with automatic sync

## Development

```bash
npm run dev          # Start client (:3000) + worker (:8787)
npm run typecheck    # Type check all workspaces
```

## Architecture

See [CLAUDE.md](./CLAUDE.md) for detailed architecture documentation.
