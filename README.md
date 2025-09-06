# Avlo

A link-based, account-less, offline-first, real-time collaborative whiteboard with integrated code execution.

## Overview

Avlo enables synchronous sketching and quick code execution for demos, teaching, and brainstorming—without the friction of accounts, installs, or SSO. Simply share a link to grant edit access. Built with offline-first architecture using CRDTs, Avlo ensures your work is always available, syncing seamlessly when connected.

**Key Features:**

- **Instant collaboration** - Share a link, start drawing together
- **Code execution** - Run JavaScript and Python directly in the browser
- **Offline-first** - Works without internet, syncs when reconnected
- **Real-time** - ≤125ms p95 collaboration latency
- **No setup** - No accounts, no installation, just open and use

## Tech Stack

- **Frontend**: React 18.3.1, TypeScript 5.9.2, Vite 5.4.11, Tailwind CSS
- **Real-time**: Yjs 13.6.27 (CRDT), y-websocket, y-indexeddb, y-webrtc
- **Backend**: Node.js, Express, @y/websocket-server
- **Persistence**: Redis 7.x (AOF), PostgreSQL via Prisma
- **Canvas**: HTML Canvas with RBush spatial indexing
- **Code Execution**: JavaScript + Pyodide (Python in browser)
- **Testing**: Vitest (separate configs for client & server), Playwright (E2E)

## Current Status

**Phase 6 Complete**: Full offline-first infrastructure with WebSocket real-time sync, Redis persistence, and UI integration.

- ✅ **Phase 6A**: y-indexeddb provider integration, boot gates, local persistence
- ✅ **Phase 6B**: Server setup with y-websocket, Redis persistence, PostgreSQL/Prisma metadata
- ✅ **Phase 6C**: Client WebSocket provider, TanStack Query for metadata, Zod validation
- ✅ **Phase 6D**: UI Integration - React Router, Toolbar, Connection status, Zustand store

**Next: Phase 7** - Awareness & Presence System (cursor trails, user list, presence indicators)

See [IMPLEMENTATION.MD](./IMPLEMENTATION.MD) for the complete development roadmap (Phases 2-17).

## Getting Started

### Prerequisites

- Node.js 18+ and npm
- Redis server running locally (for persistence)
- PostgreSQL database (for metadata)

### Environment Setup

1. **Copy environment files:**

   ```bash
   cp client/.env.example client/.env.local
   cp server/.env.example server/.env
   ```

2. **Configure client environment** (`client/.env.local`):

   ```env
   VITE_WS_BASE=/ws
   VITE_API_BASE=/api
   VITE_ROOM_TTL_DAYS=14
   ```

3. **Configure server environment** (`server/.env`):

   ```env
   NODE_ENV=development
   PORT=3001
   REDIS_URL=redis://localhost:6379
   DATABASE_URL=postgresql://user:password@localhost:5432/avlo
   ORIGIN_ALLOWLIST=http://localhost:3000
   ROOM_TTL_DAYS=14
   ```

   Note: There's also a root `.env.example` for reference, but the client and server ones are what's actually used.

4. **Set up the database:**
   ```bash
   npm run -w server prisma:migrate
   ```

### Running the Application

```bash
# Install dependencies (monorepo with workspaces)
npm install

# Start development servers (client + server concurrently)
npm run dev

# The app will be available at http://localhost:3000
```

The `npm run dev` command starts both:

- **Client dev server** on http://localhost:3000 (Vite)
  - Serves the React app over HTTP
  - Proxies `/api` requests to the backend
  - Proxies WebSocket connections (`ws://localhost:3000/ws`) to the backend
- **Backend server** on http://localhost:3001 (Express + WebSocket server)
  - Handles API requests
  - Handles WebSocket connections for real-time sync

## Testing

The project uses separate Vitest configurations for client and server workspaces:

```bash
# Run all tests in memory-safe mode (1.3GB max)
npm test

# Watch mode for development (8GB+ RAM needed)
npm run test:watch

# Test client only
npm run test:client
npm run test:client:watch

# Test server only
npm run test:server
npm run test:server:watch

# E2E tests with Playwright
npm run test:e2e

# Coverage report
npm run test:coverage
```

Memory-safe testing is default due to Y.Doc memory usage patterns. Use watch mode during development when you have sufficient RAM.

## Development Commands

```bash
# Type checking across all workspaces
npm run typecheck

# Linting & formatting
npm run lint          # Check for issues
npm run lint:fix      # Auto-fix issues
npm run format        # Format code
npm run format:check  # Check formatting

# Build for production
npm run build
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
