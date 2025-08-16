# CLAUDE.md - Avlo Technical Reference

## Project Overview

Avlo is a link-based, account-less, offline-first, real-time collaborative whiteboard with integrated code execution (JS + Python via Pyodide). See AVLO_OVERVIEW.MD for full specifications.

## Current Implementation Status

### ✅ Phase 0: Complete
- Monorepo structure with client/server workspaces
- Build pipeline and asset bundling  
- TypeScript, ESLint, Prettier configuration
- Pre-commit hooks with Husky
- Playwright E2E test setup
- Basic Express server with health check
- Prisma schema for Room model

### ✅ Phase 1: Complete (Server Foundation)
- Express + @y/websocket-server + Redis integration
- WebSocket gateway with Origin validation and connection hygiene
- Redis persistence with gzip(4) compression for authoritative storage
- Room metadata API endpoints with rate limiting
- Capacity enforcement (105 clients/room, 8 WS/IP, 2MB frame cap)
- Sentry integration with privacy protections
- Health check endpoints (/healthz, /readyz)

### 🚧 Phase 2: In Progress (Client Foundation)
- React Router setup for /rooms/:id
- Yjs providers (y-websocket + y-indexeddb)
- Basic UI shell with split view
- Connection indicator and presence
- Mobile view-only gating

### ⏳ Future Phases
- Phase 3: Canvas rendering and drawing tools
- Phase 4: Scene management (Clear board)
- Phase 5: PNG export
- Phase 6: Code execution (JS + Pyodide)
- Phase 7: PWA and offline support

## Technology Stack

### Current Dependencies
**Client:**
- React 18.3.1, TypeScript 5.7.2, Vite 5.4.11
- Tailwind 3.4.17 (configured)
- Placeholder dependencies for future: yjs, y-websocket, y-indexeddb, monaco-editor, pyodide

**Server:**
- Node.js (ES2022), Express 4.21.2
- TypeScript 5.7.2, TSX 4.19.2 (dev)
- Prisma 5.22.0, PostgreSQL 16
- Redis 4.7.0 (authoritative storage)
- @y/websocket-server 1.0.2, y-leveldb 0.1.2
- WebSocket (ws 8.18.0) with hygiene enforcement
- Sentry 8.45.0, Pino 9.5.0 (logging)
- Helmet 8.0.0, CORS 2.8.5, express-rate-limit 7.4.1

**Testing & Tools:**
- Playwright 1.45.0 (E2E)
- ESLint 9.33.0, Prettier 3.6.2
- Husky + lint-staged (pre-commit)

## Project Structure

```
avlo/
├── client/                    # React SPA frontend
│   ├── src/
│   │   ├── main.tsx          # App entry (placeholder)
│   │   └── index.css         # Tailwind imports
│   ├── dist/                 # Production build
│   └── package.json
├── server/
│   ├── src/
│   │   ├── index.ts          # Express bootstrap + routes
│   │   ├── sentry.ts         # Error tracking setup
│   │   ├── obs.ts            # Observability helpers
│   │   ├── ws.ts             # WebSocket gateway
│   │   ├── yjs-hooks.ts      # Redis persistence hooks
│   │   ├── routes/
│   │   │   └── rooms.ts      # Room API endpoints
│   │   ├── util/
│   │   │   ├── origin.ts     # Origin validation
│   │   │   └── ip.ts         # IP extraction
│   │   └── clients/
│   │       ├── prisma.ts     # Prisma singleton
│   │       └── redis.ts      # Redis singleton
│   ├── prisma/
│   │   └── schema.prisma     # Room model
│   ├── dist/                 # TypeScript output
│   └── public/               # Static files (from client)
├── e2e/                      # Playwright tests
├── scripts/
│   └── copy-client-dist.mjs # Asset bundling
└── package.json              # Root monorepo config
```

## Essential Commands

### Development
```bash
npm run dev                # Start both client and server
npm run dev:client         # Start Vite dev server only
npm run dev:server         # Start Express server only
```

### Build & Deploy
```bash
npm run build              # Build both + bundle assets
npm run db:generate        # Generate Prisma client
npm run db:migrate         # Apply migrations (dev)
npm run db:deploy          # Apply migrations (prod)
npm start                  # Start production server
```

### Testing & Quality
```bash
npm run test:e2e           # Run Playwright tests
npm run test:e2e:ui        # Interactive test UI
npm run lint               # Check with ESLint
npm run lint:fix           # Auto-fix issues
npm run format             # Format with Prettier
npm run typecheck          # TypeScript checking
```

## Environment Variables

Create `.env` from `.env.example`:
```bash
NODE_ENV=development
PORT=3000
DATABASE_URL=postgresql://user:pass@localhost:5432/avlo
REDIS_URL=redis://localhost:6379
ORIGIN_ALLOWLIST=http://localhost:5173,http://localhost:3000
ROOM_TTL_DAYS=14
SENTRY_DSN=                # Optional
APP_VERSION=dev
```

## Development Workflow

### Starting Fresh
```bash
git pull origin main
npm install
npm run db:migrate
npm run dev
```

### Before Committing
```bash
npm run typecheck          # Manual type check
# Pre-commit hooks auto-run ESLint + Prettier on staged files
git add .
git commit -m "feat: description"
```

## Coding Standards

### Naming Conventions
- **Components**: PascalCase (e.g., `WhiteboardCanvas.tsx`)
- **Hooks**: camelCase with 'use' prefix (e.g., `useCanvas.ts`)
- **Services/Utils**: camelCase (e.g., `roomService.ts`)
- **Types/Interfaces**: PascalCase
- **Constants**: UPPER_SNAKE_CASE
- **Functions**: camelCase with verb prefixes

### Code Style
- TypeScript strict mode
- Functional React components
- Async/await over promises
- NO COMMENTS unless explicitly requested
- 2 spaces indentation (Prettier enforced)
- Single quotes for strings
- Semicolons required

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

## TypeScript Configuration (Server) - CRITICAL

The server uses **NodeNext** module resolution which requires:

1. **tsconfig.json MUST use**:
   ```json
   {
     "module": "NodeNext",
     "moduleResolution": "NodeNext", 
     "verbatimModuleSyntax": true
   }
   ```

2. **All relative imports MUST include .js extension** even though files are .ts:
   ```typescript
   // ✅ CORRECT
   import { foo } from './foo.js';
   
   // ❌ WRONG
   import { foo } from './foo';
   ```

3. **Type-only imports with verbatimModuleSyntax**:
   ```typescript
   import type { Request, Response } from 'express';
   ```

4. **pino-http workaround** (due to CJS/ESM incompatibility):
   ```typescript
   import { createRequire } from 'node:module';
   const require = createRequire(import.meta.url);
   const pinoHttp = require('pino-http');
   ```
   Note: This workaround is necessary even with esModuleInterop enabled.

5. **@y/websocket-server usage**:
   - Version: 0.1.x (NOT 1.0.x - doesn't exist)
   - Import: `@y/websocket-server/utils` (ESM)
   - No `provider` property needed in setPersistence
   - Ambient typing provided in server/src/types/y-websocket-server.d.ts

6. **Redis v5 type handling**:
   - getBuffer returns complex union type
   - Cast through unknown when needed: `as unknown as Buffer`

DO NOT change module to "ESNext" or moduleResolution to "node" - this breaks Node.js ESM compatibility!

## Database Schema

### Prisma Room Model (Non-Authoritative)
```prisma
model Room {
  id          String   @id        // roomId
  title       String   @db.VarChar(120)
  createdAt   DateTime @default(now())
  lastWriteAt DateTime @updatedAt
  sizeBytes   Int      @default(0)
}
```

Redis stores the authoritative Yjs document; PostgreSQL stores metadata only.

## Next Implementation Steps

1. **Begin Phase 2** (Client Foundation):
   - Set up React Router for /rooms/:id routing
   - Initialize Yjs providers (y-websocket + y-indexeddb)
   - Create basic UI shell with split view
   - Implement connection indicator
   - Add mobile view-only gating

2. **Phase 3** (Canvas & Drawing):
   - Implement canvas renderer with RBush indexing
   - Add drawing tools (Pen, Highlighter, Stamps)
   - Create text tool with local preview
   - Add minimap and zoom controls

## References

- **Full Specification**: AVLO_OVERVIEW.MD
- **Implementation Plan**: AVLO_IMPLEMENTATION.MD
- **Phase 1 Status**: PHASE1_CHANGELOG.MD
- **Next Phase Guide**: See AVLO_IMPLEMENTATION.MD Phase 2

## Important Notes

- This is an MVP single-node implementation
- No authentication system - link sharing grants edit access
- Mobile is view-only in MVP
- Rooms expire after ROOM_TTL_DAYS (default: 14) with no recovery
