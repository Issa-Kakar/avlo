# CLAUDE.MD - Avlo Project Guide

## Project Overview
**Avlo** is a link-based, account-less, offline-first, real-time collaborative whiteboard with integrated code execution. The MVP targets ≤125ms p95 collaboration latency with ~50 concurrent users. **IMPORTANT**: This is a small side project for ~15 concurrent users maximum in reality - simplicity over scale.

## Tech Stack (Target)
- **Frontend**: React 18.3.1, TypeScript 5.9.2, Vite 5.4.11, Tailwind CSS
- **Canvas**: HTML Canvas with RBush spatial indexing (Phase 6)
- **Editor**: Monaco 0.52.2 (Phase 7)
- **Real-time**: Yjs 13.6.27, y-websocket, y-indexeddb, y-webrtc
- **Execution**: JS + Pyodide 0.26.4 (Phase 7)
- **Backend**: Node.js, Express, @y/websocket-server
- **Persistence**: Redis 7.x (AOF), PostgreSQL via Prisma (future phases)
- **Deployment**: Single container on Railway

## Current Implementation Status

### COMPLETED: 
- Phase 2: Core Data Layer & Models (Types, RoomDocManager, Snapshots, Subscriptions)
- Phase 3: Basic Canvas Infrastructure (Canvas Component, Transform System, Render Loop)

## Current Status
**READY FOR PHASE 4: Stroke Data Model & Rendering**

## CRITICAL: Registry Architecture & Testing Strategy

### Registry Pattern (MANDATORY)
The **RoomDocManagerRegistry** is THE ONLY way to access RoomDocManager instances:
- **Production**: Use `useRoomDocRegistry()` hook from React context
- **Tests**: Use `createTestManager()` helper for isolated instances
- **Never** export or instantiate RoomDocManagerImpl directly
- Registry ensures singleton-per-room guarantee (critical for CRDT consistency)

### Test-Specific Configuration
- Test files intentionally use `any` types to access private implementation
- Test helpers (`waitForSnapshot`, `collectSnapshots`, etc.) are preserved for Phases 3-7
- ESLint configured with test-specific rules - DO NOT "fix" these warnings
- `__testonly` exports are NODE_ENV gated for safety

### React Hook Note
- `useHasRoomDocRegistry()` follows React hook naming (was `hasRoomDocRegistry`)
- Must be called unconditionally in React components/hooks

### 📋 Phases 3-18: See IMPLEMENTATION.MD
Canvas → Stroke Rendering → Input → Rbush → WebSocket + Indexeddb→ Awareness → UI → Code Execution → PWA

## Data Models (Phase 2-4 Focus)

### Y.Doc Structure
```typescript
Y.Doc → root: Y.Map → {
  v: number,                    // schema version (1)
  meta: Y.Map<Meta>,           // scene_ticks: Y.Array<number>
  strokes: Y.Array<Stroke>,    // append-only stroke data
  texts: Y.Array<TextBlock>,   // immutable once committed
  code: Y.Map<CodeCell>,       // future: Phase 7
  outputs: Y.Array<Output>     // future: Phase 7
}
```

### Core Types (Phase 2-4)
```typescript
interface Stroke {
  id: string;           // ULID
  tool: 'pen' | 'highlighter';
  color: string;        // #RRGGBB
  size: number;         // world units
  opacity: number;      // 0..1
  points: number[];     // flat [x,y,p?,x,y,p?,...] NEVER Float32Array
  bbox: [number, number, number, number];
  scene: SceneIdx;      // 0-based index, assigned at commit using currentScene
  createdAt: number;    // ms epoch
  userId: string;
}

// Type alias: SceneIdx = number (0-based scene index)

interface Snapshot {
  svKey: string;        // base64 state vector, never null
  scene: number;        // from meta.scene_ticks.length
  strokes: ReadonlyArray<StrokeView>;  // filtered by scene
  texts: ReadonlyArray<TextView>;       // filtered by scene
  presence: PresenceView;               // throttled to 30Hz
  spatialIndex: null;   // Phase 5: RBush
  view: ViewTransform;  // world↔canvas transforms
  meta: { bytes?: number; cap: number; readOnly: boolean };
}
```

## Architecture

### Data Flow
```
UI → mutate(fn) → Y.Doc → Snapshot → UI
       ↓
  Minimal guards (read-only, mobile, frame size)

Document loop (authoritative)
UI → mutate(fn) → [guards: read-only | mobile | frame size] → Y.Doc
   → rAF buildSnapshot (dirty-check, freeze) → Snapshot (immutable) → UI

Presence overlay (ephemeral; not in Y.Doc)
Pointer/inputs → Presence emitter (≤ ~30 Hz, interpolate/dead-reckon 1 frame)
   → inject into Snapshot.presence view → UI cursors/avatars

Room stats (out-of-band; not in Y.Doc)
persist_ack / metadata poll → RoomStats (bytes, cap | null initially) → UI banners/gates
```

### Device-Local UI State (Zustand + localStorage)
```typescript
interface DeviceUIState {
  toolbar: ToolbarState;  // pen/highlighter/text/eraser settings
  lastSeenSceneByRoom: Record<string, SceneIdx>;  // For ghost preview after clear
  collaborationMode: 'server' | 'peer';
  // ... other local UI preferences
}
```

### Core Components

#### RoomDocManager (`client/src/lib/room-doc-manager.ts`)
Central authority that owns Y.Doc and providers:
```typescript
interface RoomDocManager {
  readonly currentSnapshot: Snapshot;  // Never null
  subscribeSnapshot(cb: (snap: Snapshot) => void): Unsub;
  subscribePresence(cb: (p: PresenceView) => void): Unsub;  // Needs throttling
  subscribeRoomStats(cb: (s: RoomStats | null) => void): Unsub;  // Needs persist_ack
  mutate(fn: (ydoc: Y.Doc) => void): void;  // Single yjs.transact wrapper
  extendTTL(): void;
  destroy(): void;
}
```

#### Shared Configuration (`/packages/shared/src/config.ts`)
All constants centralized with environment overrides:
```typescript
import { ROOM_CONFIG, STROKE_CONFIG } from '@avlo/shared';

// Examples:
ROOM_CONFIG.ROOM_SIZE_WARNING_BYTES  // 13MB
ROOM_CONFIG.ROOM_SIZE_READONLY_BYTES // 15MB
STROKE_CONFIG.MAX_POINTS_PER_STROKE  // 10,000
```

Usage patterns documented in `/packages/shared/CONFIG_USAGE.md`

## Project Structure

### Monorepo Layout
```
avlo/
├── client/                    # React frontend (Vite)
│   ├── src/
│   │   ├── canvas/           # Canvas components (Phase 3)
│   │   │   ├── Canvas.tsx    # Main canvas component
│   │   │   ├── CanvasStage.tsx # DPR-aware canvas substrate
│   │   │   └── internal/     # Transform utilities
│   │   ├── contexts/         # React contexts
│   │   │   ├── RoomDocRegistryContext.tsx
│   │   │   └── ViewTransformContext.tsx
│   │   ├── hooks/            # useRoomSnapshot, usePresence, etc.
│   │   ├── lib/              # RoomDocManager core
│   │   │   └── tools/        # Tool implementations (future)
│   │   ├── renderer/         # Render loop (Phase 3)
│   │   │   ├── RenderLoop.ts # RAF-based render loop
│   │   │   └── DirtyRectTracker.ts # Dirty region tracking
│   │   ├── stores/           # Zustand stores for device-local UI state
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
Tests co-located in `__tests__/` folders within each directory (e.g., `lib/__tests__/`, `hooks/__tests__/`, `canvas/__tests__/`).

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

# Run tests (memory-safe by default)
npm run test              # Single-threaded memory-safe mode (1.3GB max)
npm run test:watch        # Parallel mode for active development (requires 8GB+ RAM)
npm run test:memory       # Run memory leak diagnostics
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

### Database (Future)
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
| Room size warning | 13MB | `ROOM_SIZE_WARNING_BYTES` |
| Room size readonly | 15MB | `ROOM_SIZE_READONLY_BYTES` |
| Max clients/room | 105 | `MAX_CLIENTS_PER_ROOM` |
| Max strokes | 5,000 | `MAX_TOTAL_STROKES` |
| Max points/stroke | 10,000 | `MAX_POINTS_PER_STROKE` |
| WS frame limit | 2MB | `MAX_INBOUND_FRAME_BYTES` |
| Code cell limit | 200KB | `MAX_CODE_BODY_BYTES` |

## Critical Architecture Rules

1. **Y.Doc Reference Invariants (NEVER VIOLATE)**
   ```typescript
   // ❌ WRONG - cached Y reference
   class RoomDocManager {
     private yStrokes: Y.Array<any>; // NEVER DO THIS
   }
   
   // ✅ CORRECT - helpers that traverse 'root' on demand
   class RoomDocManager {
     private getRoot(): Y.Map<any> {
       return this.ydoc.getMap('root');
     }
     private getStrokes(): Y.Array<any> {
       return this.getRoot().get('strokes') as Y.Array<any>;
     }
   }
   ```
   - **No cached Y references as class fields**
   - **Helpers return Y types only for internal use**
   - **Never expose Y types from public methods**
   - **Y.Doc created once**: `new Y.Doc({ guid: roomId })` - guid never mutated

2. **UI Isolation from Yjs**
   - UI components **MUST NOT** import `yjs`, `y-websocket`, `y-indexeddb`, `y-webrtc`
   - ESLint `no-restricted-imports` enforces this
   - All access through RoomDocManager public API
   - Public API returns immutable snapshots only

3. **Mutation Pattern**
   - Single `mutate(fn: (ydoc: Y.Doc) => void)` wrapper
   - Executes inside one `yjs.transact()` 
   - Minimal guards: read-only (≥15MB), mobile (view-only), frame size (2MB)
   - No queuing, no complex validation

4. **Immutable Snapshots**
   - **Never null** - EmptySnapshot created synchronously on init
   - Published at most once per rAF or batched Y update
   - Frozen in development, new arrays per publish
   - Include `svKey` (base64 state vector) for cache/change detection (svKey mainly cosmetic UX purposed)

5. **Data Storage Rules**
   - Arrays stored as `number[]` in Yjs (never Float32Array)
   - Float32Array created only at render time
   - Scene assigned at commit time using currentScene
   - Points flattened as `[x0,y0,p0?,x1,y1,p1?,...]`

## Memory-Safe Testing

Tests use single-threaded execution by default to prevent memory issues (was causing 6.5GB+ usage):
- `npm test` - Memory-safe mode (1.3GB max)
- `npm run test:watch` - Parallel mode for development (needs 8GB+ RAM)
- `npm run test:memory` - Verify no memory leaks

RoomDocManager properly cleans up event handlers and Y.Doc on destroy().

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
# Run specific test suites
npm run test -- room-doc-manager
npm run test -- validation

# Check implementation status
# See PHASE2_IMPLEMENTATION_AUDIT.md for current gaps
```

### Environment Overrides
```bash
# .env file for local development
ROOM_TTL_DAYS=7
DEBUG_MODE=true
MAX_CLIENTS_PER_ROOM=50
```

### Provider Initialization  
- Order matters: IndexedDB → WebSocket → WebRTC (if eligible)
- WebRTC is optional optimization - WebSocket always remains connected
- Gates control feature availability:
- `G_IDB_READY`: 2s timeout, enables initial snapshot hydration
- `G_WS_CONNECTED`: 5s timeout, enables doc sync
- `G_WS_SYNCED`: 10s timeout, enables authoritative render  
- `G_AWARENESS_READY`: 5s timeout, enables cursors/presence
- `G_FIRST_SNAPSHOT`: 1 rAF, enables export/minimap

## Key Implementation Notes

- **Mobile**: View-only, guard in mutate()
- **Scene**: Assigned at commit using currentScene(not about casual consistency)
- **Awareness**: 30Hz throttled, ephemeral, never persisted
- **persist_ack**: Server authoritative for size/TTL
- **Snapshots**: Never null, frozen, new arrays per publish

See `IMPLEMENTATION.MD` for detailed phase breakdown and `OVERVIEW.MD` for complete specifications.