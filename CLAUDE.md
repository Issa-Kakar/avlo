# CLAUDE.MD - Avlo Project Guide

## Project Overview
**Avlo** is a link-based, account-less, offline-first, real-time collaborative whiteboard with integrated code execution. The MVP targets ≤125ms p95 collaboration latency with ~50 concurrent users.

## Tech Stack (Target)
- **Frontend**: React 18.3.1, TypeScript 5.9.2, Vite 5.4.11, Tailwind CSS
- **Canvas**: HTML Canvas with RBush spatial indexing (Phase 3)
- **Editor**: Monaco 0.52.2 (Phase 7)
- **Real-time**: Yjs 13.6.27, y-websocket, y-indexeddb, y-webrtc
- **Execution**: JS + Pyodide 0.26.4 (Phase 7)
- **Backend**: Node.js, Express, @y/websocket-server
- **Persistence**: Redis 7.x (AOF), PostgreSQL via Prisma (Phase 5)
- **Deployment**: Single container on Railway

## Current Implementation Status

### ✅ Phase 1: Foundation (Complete)
- Monorepo structure with client/server/shared workspaces
- Build pipeline with Vite 5.4.11, TypeScript 5.9.2, React 18.3.1
- Testing infrastructure (Vitest, Playwright)
- ESLint rules enforcing no direct Yjs imports in UI

### ✅ Phase 2.1-2.2: Core Data Layer (Complete & Validated)
- **TypeScript types**: All data models defined in packages/shared folder
- **RoomDocManager**: Singleton pattern with Y.Doc ownership
- **Immutable snapshots**: Never null, frozen in development
- **Subscription system**: Working hooks (useRoomSnapshot, usePresence, useRoomStats)
- **Key invariants enforced**:
  - Arrays stored as `number[]` in Yjs (never Float32Array)
  - All commands have idempotencyKey
  - UI isolation from Yjs via ESLint rules

### 🚧 Phase 2.3-2.5: Next Steps
- Yjs document structure setup
- Snapshot publishing system
- WriteQueue and CommandBus

### 📋 Future Phases (3-10)
See IMPLEMENTATION.MD for detailed roadmap

## Architecture

### Data Flow
```
UI → Command → RoomDocManager → Y.Doc → Snapshot → UI
         ↓
    WriteQueue (validates: size, mobile, frame)
         ↓
    CommandBus (single yjs.transact per command)
```

### Core Components

#### RoomDocManager (`client/src/lib/room-doc-manager.ts`)
Central authority that owns Y.Doc and providers:
```typescript
interface RoomDocManager {
  readonly currentSnapshot: Snapshot;  // Never null
  subscribeSnapshot(cb: (snap: Snapshot) => void): Unsub;
  subscribePresence(cb: (p: PresenceView) => void): Unsub;
  subscribeRoomStats(cb: (s: Stats) => void): Unsub;
  write(cmd: Command): void;
  extendTTL(): void;
  destroy(): void;
}
```

#### Shared Configuration (`/packages/shared/src/config.ts`)
All constants centralized with environment overrides:
```typescript
import { ROOM_CONFIG, STROKE_CONFIG } from '@avlo/shared';

// Examples:
ROOM_CONFIG.ROOM_SIZE_WARNING_BYTES  // 8MB
ROOM_CONFIG.ROOM_SIZE_READONLY_BYTES // 10MB
STROKE_CONFIG.MAX_POINTS_PER_STROKE  // 10,000
```

Usage patterns documented in `/packages/shared/CONFIG_USAGE.md`

## Project Structure

### Monorepo Layout
```
avlo/
├── client/                    # React frontend (Vite)
│   ├── src/
│   │   ├── hooks/            # useRoomSnapshot, usePresence, etc.
│   │   ├── lib/              # RoomDocManager core
│   │   └── types/            # Client-specific types
├── server/                    # Node.js backend
│   └── src/
│       └── index.ts          # Server entry (minimal currently)
└── packages/                  # Shared packages
    └── shared/               # Shared configuration & types
        ├── src/
        │   ├── config.ts     # All constants with env overrides
        │   └── types/        # Shared type definitions
        └── CONFIG_USAGE.md   # Config usage guide

```

### Path Aliases
- `@avlo/shared` → `../packages/shared/src/*` (access shared config/types)
- `@/*` → `./src/*` (within client workspace)

## Essential Commands

### Development
```bash
# Install all dependencies (root + workspaces)
npm install

# Start both client and server concurrently
npm run dev

# Run tests
npm run test              # Unit tests with Vitest
npm run test:ui           # Vitest UI
npm run test:coverage     # Coverage report
npm run test:e2e          # Playwright E2E tests

# Type checking (all workspaces)
npm run typecheck

# Linting & formatting
npm run lint              # ESLint check
npm run lint:fix          # ESLint auto-fix
npm run format            # Prettier write
npm run format:check      # Prettier check

# Build for production
npm run build             # Builds client then server
```

### Database (Future - Phase 5)
```bash
# PostgreSQL setup
npx prisma migrate dev
npx prisma generate

# Redis
redis-server              # Start Redis with AOF
```

## Key Configuration Values

All limits and thresholds are defined in `/packages/shared/src/config.ts`:

| Config | Default | Environment Variable |
|--------|---------|---------------------|
| Room TTL | 14 days | `ROOM_TTL_DAYS` |
| Room size warning | 8MB | `ROOM_SIZE_WARNING_BYTES` |
| Room size readonly | 10MB | `ROOM_SIZE_READONLY_BYTES` |
| Max clients/room | 105 | `MAX_CLIENTS_PER_ROOM` |
| Max strokes | 5,000 | `MAX_TOTAL_STROKES` |
| Max points/stroke | 10,000 | `MAX_POINTS_PER_STROKE` |
| WS frame limit | 2MB | `MAX_INBOUND_FRAME_BYTES` |
| Code cell limit | 200KB | `MAX_CODE_BODY_BYTES` |

## Critical Architecture Rules

1. **UI Isolation from Yjs**
   - UI components **MUST NOT** import `yjs`, `y-websocket`, `y-indexeddb`, `y-webrtc`
   - ESLint rule `no-restricted-imports` enforces this
   - All Yjs access goes through RoomDocManager
   - **Y.Doc created once**: `new Y.Doc({ guid: roomId })` - guid **never mutated**

2. **Immutable Snapshots**
   - Snapshots are **never null** (EmptySnapshot on init)
   - Published snapshots are frozen in development
   - New arrays created per publish (no mutations)
   - Constructor creates EmptySnapshot synchronously
   - Prevents all null reference errors
   - Published immediatley even before Y.Doc data

3. **Data Storage Rules**
   - Store arrays as `number[]` in Yjs (never Float32Array)
   - Create Float32Array only at render time
   - All commands must have idempotencyKey

4. **Write Path**
   - All mutations: UI → Command → WriteQueue → CommandBus → yjs.transact
   - Single yjs.transact per logical command
   - WriteQueue validation order:
     1. Check read-only (≥10MB compressed)
     2. Check mobile view-only 
     3. Check frame size (<2MB)
     4. Apply command-specific limits

5. **Temporal Wormhole Prevention**
   - Async operations MUST capture `svKey` at start
   - Verify `currentSnapshot.svKey` matches before applying
   - Discard stale work on mismatch (prevents race conditions)

6. **Performance Targets**
   - Collaboration latency: ≤125ms p95 (50 users)
   - Snapshot publishing: ≤60 FPS
   - Batch window: 8-32ms adaptive

## Development Tips

### Using Shared Config
```typescript
// Import specific configs
import { ROOM_CONFIG, STROKE_CONFIG } from '@avlo/shared';

// Use utility functions
import { isRoomReadOnly, calculateAwarenessInterval } from '@avlo/shared';

// Check room status
if (isRoomReadOnly(sizeBytes)) {
  // Block writes
}
```

### Testing Commands
```bash
# Run validation script for Phase 2
npx tsx test-validation.ts

# Run specific test suites
npm run test -- room-doc-manager
npm run test -- validation
```

### Environment Overrides
```bash
# .env file for local development
ROOM_TTL_DAYS=7
DEBUG_MODE=true
MAX_CLIENTS_PER_ROOM=50
```

## Important Implementation Notes

### Mobile Support
- **Mobile is view-only for MVP**
- WriteQueue validates and rejects with `reason='view_only'`
- UI must show clear view-only banner on mobile devices

### Security Model
- **No authentication by design** - link sharing grants edit access
- Security through link obscurity + TTL expiration
- Origin allowlist must be configured for production

### Provider Initialization  
- Order matters: IndexedDB → WebSocket → WebRTC (if eligible)
- WebRTC is optional optimization - WebSocket always remains connected
- Gates control feature availability:
  - `G_IDB_READY`: 2s timeout, enables initial snapshot hydration
  - `G_WS_CONNECTED`: 5s timeout, enables doc sync
  - `G_WS_SYNCED`: 10s timeout, enables authoritative render  
  - `G_AWARENESS_READY`: 5s timeout, enables cursors/presence
  - `G_FIRST_SNAPSHOT`: 1 rAF, enables export/minimap

### Debugging Tips
- Check `G_*` gates for initialization state (G_IDB_READY, G_WS_CONNECTED, etc.)
- Monitor `svKey` changes for Y.Doc updates
- Use `persist_ack` frames for authoritative room size
- Watch `bufferedAmount` for backpressure detection
- Verify scene index for visibility issues

### Data Model Conventions
- **Timestamps**: ISO-8601 for HTTP/WS JSON, epoch ms in CRDT structures
- **Scene management**: Append-only scene_ticks, excluded from undo
- **Stroke simplification**: Douglas-Peucker at pointer-up
- **Awareness**: Ephemeral, never persisted, 75-100ms cadence
- **TTL extension**: Only on accepted writes, not on views/awareness

### WriteQueue & Backpressure
- **Validation order**: read-only check → mobile check → frame size check → command limits
- **Queue limits**: Max 100 pending commands
- **Backpressure**: Above limit drop awareness, throttle commits by 50ms
- **Flush windows**: 8-16ms base, expand to 24-32ms under pressure

### Snapshot Publishing  
- **Coalesce window**: 8-16ms for Y updates (expand to 24-32ms when publish >8ms)
- **Work budget**: 6ms soft limit for rendering prep (RBush, paths)
- **FPS cap**: 60 FPS active tab, 8 FPS hidden tab
- **Never null**: EmptySnapshot created synchronously on init

### Persist-ack Authority
- **Server `persist_ack` frames** are authoritative for room size/TTL
- **Client never trusts local size estimates** for read-only decisions
- **Format**: `{type: 'persist_ack', size_bytes: number, expires_at: string, svKey: string}`
- **Stats refresh**: Update pills/banners only from persist_ack, not local calculations

### Coordinate Transform Contract
```typescript
interface ViewTransform {
  worldToCanvas: (x: number, y: number) => [number, number];
  canvasToWorld: (x: number, y: number) => [number, number];
  scale: number;  // world px → canvas px
  pan: { x: number; y: number }; // world offset
}
```
- **Always use transform functions** for pointer conversion
- **Store positions in world coordinates** in Yjs
- **Transform to canvas coordinates** only at render time

### Room Lifecycle (Future - Phase 5)
1. **Local-first creation**: Generate `local-<ulid>` room ID
2. **Publish to server**: POST `/api/rooms` merges local → server
3. **Persistence**: Redis with AOF, compressed gzip level 4
4. **Metadata**: PostgreSQL for non-authoritative data
5. **Expiry**: TTL-based, no recovery after expiration

## Next Steps
- **Phase 2.3**: Set up Yjs document structure
- **Phase 2.4**: Implement snapshot publishing  
- **Phase 2.5**: Create WriteQueue and CommandBus

See `IMPLEMENTATION.MD` for detailed phase breakdown and `OVERVIEW.MD` for complete specifications.