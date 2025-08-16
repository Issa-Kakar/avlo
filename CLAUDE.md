# CLAUDE.md - Avlo Technical Reference

## Project Overview

Avlo is a link-based, account-less, offline-first, real-time collaborative whiteboard with integrated code execution (JS + Python via Pyodide). MVP targets ≤125 ms p95 collaboration latency with ~50 concurrent users and ≤25 active drawers.

**Core References:**

- **Full Specification**: AVLO_OVERVIEW.MD
- **Implementation Guide**: AVLO_IMPLEMENTATION.MD

## Current Implementation Status

### ✅ Phase 0: Complete - Repository Setup

- Monorepo with client/server workspaces
- Build pipeline with asset bundling (`scripts/copy-client-dist.mjs`)
- TypeScript, ESLint, Prettier configuration
- Husky pre-commit hooks (<5s execution)
- Playwright E2E test infrastructure

### ✅ Phase 1: Complete - Server Foundation

- Express + @y/websocket-server (0.1.1) + Redis (5.8.1)
- WebSocket gateway with Origin validation
- Redis persistence with gzip(4) compression (authoritative storage)
- Room metadata API endpoints with rate limiting
- Capacity enforcement (105 clients/room, 8 WS/IP, 2MB frame cap)
- Sentry integration (8.55.0) with privacy protections
- Health check endpoints (/healthz, /readyz)

### ✅ Phase 2: Complete - Client Foundation

- React Router DOM (7.8.0) for SPA routing
- Yjs providers: y-websocket (3.0.0) + y-indexeddb (9.0.12)
- Split view UI shell with resizable panes
- Connection status indicator (Online/Reconnecting/Offline/Read-only)
- Presence system with cursor tracking
- Mobile view-only gating (capability-based)
- Copy link functionality with toast notifications
- Users avatar stack and modal

### ✅ Phase 7: Complete - PWA & Offline Support

- Installable PWA with manifest and icons (192×192, 512×512, maskable)
- Service worker with cache-first HTML navigation
- Strategic bypass rules (never cache /api/**, /yjs/**, wss:)
- Pre-cached Monaco editor and practice problems JSON
- "Update available" prompt with skipWaiting
- Desktop-only Pyodide warm cache (silent, post-activate)

### ✅ Phase 9: Complete - My Rooms (Device-Local)

- IndexedDB-based room management (`avlo-myrooms` database)
- Device-local room list with metadata tracking
- Offline room creation with provisional IDs (`local-<ulid>`)
- Alias mapping for provisional→server ID resolution
- Room TTL extension via minimal Yjs writes
- "Delete local copy" functionality
- Landing page with recent rooms panel

### ✅ Phase 10: Complete - Security & Observability

- Helmet-based security headers (CSP Profile A)
- HSTS (production-only), X-Content-Type-Options, Referrer-Policy
- Origin allowlist validation for HTTP and WebSocket
- Comprehensive observability counters (non-content)
- Database degraded mode (Redis-only when Postgres unavailable)

### ✅ Phase 8: Complete - Limits, Banners & UX Guards

- Size warning pill at 8MB (X.Y / 10 MB display)
- Read-only mode enforcement at 10MB hard cap
- Gateway error mapping with normative toast messages
- Room capacity enforcement (105 clients max)
- Connection state includes Read-only indicator
- Feature flag system for limits UI

### ⏳ Future Phases (Not Yet Implemented)

- Phase 3: Canvas rendering and drawing tools
- Phase 4: Scene management ("Clear board for everyone")
- Phase 5: PNG export (viewport/entire board)
- Phase 6: Code execution (JS + Pyodide)
- Phase 11: Deployment (Railway)
- Phase 12: AI Assistance (Mode A)

## Technology Stack

**Client:** React, TypeScript, Vite, React Router DOM, Tailwind CSS, Yjs/y-websocket/y-indexeddb, Monaco Editor, PWA (vite-plugin-pwa), RBush, Pyodide

**Server:** Node.js (ESM), Express, TypeScript, Prisma/PostgreSQL, Redis, @y/websocket-server (0.1.1), WebSocket (ws), Sentry, Pino, Helmet

**Tools:** Playwright, ESLint, Prettier, Husky, Concurrently

## Project Structure

```
avlo/
├── client/                    # React SPA frontend
│   ├── src/
│   │   ├── app/              # Components, hooks, pages, providers
│   │   ├── pwa/              # PWA & service worker
│   │   ├── ui/limits/        # Size pill, readonly banner
│   │   └── state/            # Room stats, write operations
│   └── public/               # Icons, manifest, problems.json
├── server/                    # Express + WebSocket backend
│   ├── src/
│   │   ├── ws.ts            # WebSocket gateway
│   │   ├── yjs-hooks.ts     # Redis persistence
│   │   └── routes/rooms.ts  # Room API endpoints
│   └── prisma/schema.prisma # Database schema
├── e2e/                      # Playwright tests
└── scripts/                  # Build utilities
```

## Essential Commands

```bash
npm run dev                # Start both client and server
npm run build              # Build both + bundle assets
npm run test:e2e           # Run Playwright tests
npm run db:migrate         # Apply migrations (dev)
npm run typecheck          # TypeScript checking
```

## Environment Variables

```bash
DATABASE_URL=postgresql://user:pass@localhost:5432/avlo
REDIS_URL=redis://localhost:6379
ORIGIN_ALLOWLIST=http://localhost:5173,http://localhost:3000
ROOM_TTL_DAYS=14
SENTRY_DSN=                # Optional
```

## Coding Standards

- **Naming**: Components (PascalCase), hooks (use\*), constants (UPPER_SNAKE)
- **Style**: TypeScript strict, functional components, async/await, NO COMMENTS
- **Formatting**: 2 spaces, single quotes, semicolons (Prettier enforced)

## Critical Implementation Rules

When implementing features, remember:

1. **Yjs Document**: Always construct with `new Y.Doc({ guid: roomId })` - NEVER mutate guid
2. **Redis Persistence**: Use gzip level 4 compression; sizeBytes = compressed buffer length
3. **TTL Management**: Extends only on accepted writes, NOT on views/presence
4. **Room Size**: Hard cap at 10 MB (read-only), warning at 8 MB
5. **Capacity**: 105 concurrent clients max, 8 WebSocket connections per IP
6. **Rate Limits**: 10 rooms/hour/IP
7. **Origin Validation**: Required for both HTTP and WebSocket
8. **Frame Size**: 2 MB max for WebSocket frames
9. **Flush Cadence**: 2-3s to Redis (5s worst case)

## Key Implementation Details

### WebSocket Connection

- Endpoint: `/ws` (requires Origin header)
- Client identifies with `{ roomId }` on connect
- Gateway errors: `room_full`, `room_full_readonly`, `offline_delta_too_large`
- Reconnection: Exponential backoff with full jitter, ceiling 30s

### REST API Endpoints

- `POST /api/rooms` - Create room (optional id, title)
- `GET /api/rooms/:id/metadata` - Get room metadata
- `PUT /api/rooms/:id` - Update room title
- `GET /healthz` - Health check
- `GET /readyz` - Readiness check

### Presence System

- Update cadence: 75-100ms tick, ~30Hz send throttle
- Cursor trails: Ring buffer of 24 points, max 20 remote cursors rendered
- Activity states: idle, drawing, typing
- Awareness data is ephemeral (not persisted)

### Mobile Support

- View-only in MVP (capability-based detection)
- Detection: `(pointer: coarse)` or width ≤ 820px
- No UA sniffing
- Cursor trails disabled on mobile

### IndexedDB Storage

- Database: `avlo-myrooms` (version 1)
- Stores: `rooms` (room metadata) and `aliases` (provisional→server mapping)
- Per-room Y.Doc persistence via y-indexeddb
- Never deleted on room leave (explicit "Delete local copy" required)

## TypeScript Configuration (Server)

**CRITICAL:** Server uses NodeNext module resolution:

- All relative imports need `.js` extension: `import { foo } from './foo.js'`
- pino-http requires createRequire workaround
- @y/websocket-server is version 0.1.x (import from `@y/websocket-server/utils`)
- Redis v5 types may need casting: `as unknown as Buffer`

## Common Gotchas

**Server:** Relative imports need `.js`, pino-http needs createRequire, @y/websocket-server is 0.1.x
**Client:** Never mutate Yjs guid, don't auto-delete IndexedDB, use capability detection for mobile
**Dev:** Pre-commit <5s, test PWA with build+preview, use exact UI strings

## Database Schema

```prisma
model Room {
  id          String   @id        // roomId
  title       String   @db.VarChar(120)
  createdAt   DateTime @default(now())
  lastWriteAt DateTime @updatedAt
  sizeBytes   Int      @default(0)
}
```

Redis stores authoritative Yjs doc (gzip-4); PostgreSQL stores metadata only.

## Next Implementation Steps

1. **Phase 3** (Canvas & Drawing):
   - Implement canvas renderer with RBush indexing
   - Add drawing tools (Pen, Highlighter, Stamps)
   - Create text tool with local preview
   - Add minimap and zoom controls
   - Implement LOD (Level of Detail) rendering
   - Add undo/redo with Y.UndoManager

2. **Phase 4** (Scene Management):
   - Implement "Clear board for everyone" functionality
   - Add scene tick system for soft-clear
   - Implement 10-second undo window for scene changes

3. **Phase 5** (PNG Export):
   - Export viewport or entire board
   - 8192px max edge, 24px padding, white background
   - 2-second render budget with fallback

## References

- **Specification**: AVLO_OVERVIEW.MD
- **Implementation**: AVLO_IMPLEMENTATION.MD
- **Phase Docs**: tasks/completed/

## Normative UI Strings

These exact strings MUST be used for consistency:

### Toast Messages

- Copy link: **"Link copied."**
- Room full: **"Room is full — create a new room."**
- Oversize frame: **"Change too large. Refresh to rejoin."**
- Rate limit: **"Too many requests — try again shortly."**
- Clear board: **"Cleared for everyone. Undo (10s)."**
- Room extended: **"Room extended to [date]."**
- Text committed: **"Text committed."**
- Export fallback: **"Large board—exported visible area."**

### Banners

- Read-only: **"Room is read-only (10 MB limit reached). Create a new room to continue."**
- Size warning pill: **"X.Y / 10 MB"** (appears at 80% capacity)

### Connection States

- **"Online"** / **"Reconnecting"** / **"Offline"** / **"Read-only"**

## Important Notes

- This is an MVP single-node implementation
- No authentication system - link sharing grants edit access
- Mobile is view-only in MVP
- Rooms expire after ROOM_TTL_DAYS (default: 14) with no recovery
- No stack traces in UI - always show friendly messages
- Undo/Redo is per-user origin-scoped (users undo their own operations only)
