# Avlo

A link-based, account-less, offline-first, real-time collaborative whiteboard with integrated code execution.

## Overview

Avlo is designed for synchronous sketching and quick code execution for demos, teaching, and brainstorming—without accounts, installs, or SSO friction. Link sharing grants edit access with time-limited persistence.

**Target Scale**: ~15 concurrent users (small side project optimized for simplicity over scale)  
**Performance Target**: ≤125ms p95 collaboration latency

## Tech Stack

- **Frontend**: React 18.3.1, TypeScript 5.9.2, Vite 5.4.11, Tailwind CSS
- **Real-time**: Yjs 13.6.27 (CRDT), y-websocket, y-indexeddb, y-webrtc
- **Backend**: Node.js, Express, @y/websocket-server
- **Persistence**: Redis 7.x (AOF), PostgreSQL via Prisma
- **Canvas**: HTML Canvas with RBush spatial indexing
- **Code Execution**: JavaScript + Pyodide (Python in browser)

## Current Status

**Phase 2 Complete**: Core data layer, RoomDocManager foundation, and snapshot publishing system implemented and tested.

See [IMPLEMENTATION.MD](./IMPLEMENTATION.MD) for the complete development roadmap (Phases 2-18).

## Getting Started

```bash
# Install dependencies (monorepo with workspaces)
npm install

# Start development servers (client + server concurrently)
npm run dev

# Run tests (memory-safe mode)
npm test

# Type checking
npm run typecheck

# Linting & formatting
npm run lint
npm run format
```

## Project Structure

```
avlo/
├── client/                    # React frontend (Vite)
│   ├── src/
│   │   ├── hooks/            # React hooks for data subscriptions
│   │   ├── lib/              # RoomDocManager core
│   │   ├── stores/           # Zustand stores (device-local UI state)
│   │   └── types/            # TypeScript types
├── server/                    # Node.js backend
└── packages/
    └── shared/               # Shared configuration & types
```

## Key Architecture Decisions

### RoomDocManager Pattern

- Central authority that owns Y.Doc and providers
- Components access only immutable snapshots via subscriptions
- UI never directly touches Yjs structures
- Registry pattern ensures singleton-per-room guarantee

### Immutable Snapshots

- Published at most once per rAF
- Never null (EmptySnapshot on init)
- Frozen objects prevent accidental mutations
- Include state vector key for change detection

### Mutation Wrapper

- All edits go through `mutate(fn)` with single `yjs.transact()`
- Minimal guards: read-only (≥15MB), mobile (view-only), frame size (2MB)

## Testing

Tests use single-threaded execution by default to prevent memory issues:

```bash
npm test              # Memory-safe mode (1.3GB max)
npm run test:watch    # Parallel mode (requires 8GB+ RAM)
npm run test:memory   # Memory leak diagnostics
npm run test:coverage # Coverage report
```

## Documentation

- [OVERVIEW.MD](./OVERVIEW.MD) - Complete system specification
- [IMPLEMENTATION.MD](./IMPLEMENTATION.MD) - Phase-by-phase implementation guide
- [CLAUDE.md](./CLAUDE.md) - Development guide and current status
- [packages/shared/CONFIG_USAGE.md](./packages/shared/CONFIG_USAGE.md) - Configuration guide

## Development Guidelines

1. **Y.Doc References**: Never cache Y references as class fields
2. **UI Isolation**: Components must not import Yjs libraries directly
3. **Phase-Based Development**: Follow the implementation phases in order
4. **Testing**: Use `createTestManager()` helper for isolated test instances
5. **Configuration**: All constants in `@avlo/shared` with env overrides

## License

Private project - not for public distribution
