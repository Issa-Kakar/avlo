# Changelog

All notable changes to the Avlo project will be documented in this file.

## [Unreleased] - Phase 1 Server Foundation

### Completed (Parts A-M)
- ✅ **Dependencies installed**: Express, y-websocket, Redis, Prisma, Sentry, and all supporting packages
- ✅ **Git branch created**: `feat/phase-1-server-foundation`
- ✅ **File structure created**: Organized server directory with routes/, util/, and clients/ subdirectories
- ✅ **Prisma schema configured**: Room model with PostgreSQL datasource
- ✅ **Database migrations run**: Initial migration `init_phase1` applied successfully
- ✅ **Sentry integration**: Error tracking and breadcrumb helpers implemented with privacy protections
- ✅ **Database clients**: Prisma and Redis client singletons created
- ✅ **Express bootstrap**: Core server setup with middleware, health checks, and graceful shutdown
- ✅ **Utility functions**: Origin validation and IP extraction helpers implemented
- ✅ **Part K**: Persistence layer (yjs-hooks.ts) - gzip(4) compression, Redis storage, debounced flush
- ✅ **Part L**: WebSocket gateway (ws.ts) - y-websocket integration, connection hygiene, room capacity
- ✅ **Part M**: Rooms API (routes/rooms.ts) - Create/metadata/rename endpoints with rate limiting

### Remaining (Parts N-S)
- ⏳ **Part N-P**: Constants, error shapes, and logging configuration
- ⏳ **Part Q**: Local verification and acceptance tests
- ⏳ **Part R-S**: Final validation and merge preparation

### Technical Notes
- Server configured to use TypeScript with tsx runtime
- Redis and PostgreSQL must be running locally (see .env.example)
- Client assets will be served from server/public directory
- Origin allowlist enforced for both HTTP and WebSocket connections

### Next Steps
To complete Phase 1, implement:
1. yjs-hooks.ts for Redis persistence with gzip compression
2. ws.ts for WebSocket gateway with y-websocket
3. routes/rooms.ts for Room management API
4. Run verification tests from Part Q

## [0.1.0] - Phase 0 Complete
- Initial monorepo structure with client/server workspaces
- Build pipeline and TypeScript configuration
- Testing setup with Playwright