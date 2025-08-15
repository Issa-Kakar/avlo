# Changelog

All notable changes to the Avlo project will be documented in this file.

## [Unreleased] - Phase 1 Server Foundation with @y/websocket-server Pivot

### Completed (Parts A-P)
- ✅ **Dependencies installed**: Express, @y/websocket-server (replacing y-websocket v3 server), y-leveldb, Redis, Prisma, Sentry, and all supporting packages
- ✅ **Git branch created**: `fix/y-websocket-v3-server-pivot` (updated from `feat/phase-1-server-foundation`)
- ✅ **File structure created**: Organized server directory with routes/, util/, and clients/ subdirectories
- ✅ **Prisma schema configured**: Room model with PostgreSQL datasource
- ✅ **Database migrations run**: Initial migration `init_phase1` applied successfully
- ✅ **Sentry integration**: Error tracking and breadcrumb helpers implemented with privacy protections
- ✅ **Database clients**: Prisma and Redis client singletons created
- ✅ **Express bootstrap**: Core server setup with middleware, health checks, and graceful shutdown
- ✅ **Utility functions**: Origin validation and IP extraction helpers implemented
- ✅ **Part K**: Persistence layer (yjs-hooks.ts) - gzip(4) compression, Redis storage, debounced flush
- ✅ **Part L**: WebSocket gateway (ws.ts) - @y/websocket-server integration, connection hygiene, room capacity
- ✅ **Part M**: Rooms API (routes/rooms.ts) - Create/metadata/rename endpoints with rate limiting
- ✅ **Part N**: Normative constants implemented (2MB frame cap, 8 WS/IP, 105/room, 10MB hard cap)
- ✅ **Part O**: Consistent error shapes (400/404/429/500/503 JSON responses)
- ✅ **Part P**: Logging & breadcrumbs (Pino redaction, Sentry breadcrumbs for all required events)

### In Progress (Parts Q-S)
- 🚧 **Part Q**: Local verification and acceptance tests (2/7 tests passing)
- ⏳ **Part R-S**: Final validation and merge preparation

### Technical Changes (y-websocket v3 pivot)
- **Server package change**: Migrated from `y-websocket/bin/utils.*` to `@y/websocket-server/utils`
- **Import path difference**: Using `/utils` export instead of `/bin/utils.js` (package structure differs)
- **y-leveldb dependency**: Required even though we use Redis (due to @y/websocket-server imports)
- **Client/Server split**: Client continues using `y-websocket` provider; server uses `@y/websocket-server`

### Documentation Updated
- ✅ README.md - Added Realtime Backend section
- ✅ PHASE_1.MD - Updated imports and dependencies
- ✅ AVLO_OVERVIEW.MD - Updated server architecture references
- ✅ AVLO_IMPLEMENTATION.MD - Added implementation notes for Phase 1 pivot

### Next Steps
To complete Phase 1:
1. Complete remaining verification tests from Part Q
2. Create proper git commits
3. Final validation and merge preparation

## [0.1.0] - Phase 0 Complete
- Initial monorepo structure with client/server workspaces
- Build pipeline and TypeScript configuration
- Testing setup with Playwright