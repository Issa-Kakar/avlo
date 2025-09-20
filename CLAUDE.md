# CLAUDE.MD - Avlo Project Guide

## Project Overview
**Avlo** is a link-based, account-less, offline-first, real-time collaborative whiteboard with integrated code execution. The MVP targets ≤125ms p95 collaboration latency with ~50 concurrent users. **IMPORTANT**: This is a small side project for ~15 concurrent users maximum in reality - simplicity over scale.

## Tech Stack (Target)
- **Frontend**: React 18.3.1, TypeScript 5.9.2, Vite 5.4.11, Tailwind CSS
- **Canvas**: HTML Canvas with RBush spatial indexing (Phase 8)
- **Editor**: Monaco 0.52.2 (Phase 15)
- **Real-time**: Yjs 13.6.27, y-websocket, y-indexeddb, y-webrtc
- **Execution**: JS + Pyodide 0.26.4 (Phase 15)
- **Backend**: Node.js, Express, @y/websocket-server
- **Persistence**: Redis 7.x (AOF), PostgreSQL via Prisma 
- **Deployment**: Single container on Railway

## Current Implementation Status

### COMPLETED: 
- Phase 2: Core Data Layer & Models (Types, RoomDocManager, Snapshots, Subscriptions)
- Phase 3: Basic Canvas Infrastructure (Canvas Component, Transform System, Render Loop)
- Phase 4: Stroke Data Model & Rendering (Stroke rendering pipeline, Path building, Tool-specific rendering)
- Phase 5: Drawing Input System (Pointer event handling, DrawingTool, Preview rendering, Stroke commit with simplification)
- Phase 6: Offline-First Infrastructure & Real-time Sync
  - 6A: y-indexeddb provider integration, boot gates (G_IDB_READY), local persistence
  - 6B: Server setup with y-websocket, Redis persistence, PostgreSQL/Prisma metadata
  - 6C: Client WebSocket provider, TanStack Query for metadata, Zod validation
  - 6D: UI Integration - Routing, Toolbar, Connection status, Zustand integration

## Current Status
**IN PROGRESS: Phase 7 - Awareness & Presence System**
- Infrastructure ready: subscribeGates with stable primitives, room routing, toolbar UI
- Next: Cursor trails, user list, presence indicators

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

### 📋 Phases 6-17: See IMPLEMENTATION.MD
WebSocket + IndexedDB + Persistence → Awareness → RBush → UI → Eraser → Text/Stamps → Undo/Redo → Room Lifecycle → Export/Minimap → Code Execution → PWA → WebRTC → Polish

## Data Models (Phase 2-4 Focus)

### Y.Doc Structure
```typescript
Y.Doc → root: Y.Map → {
  v: number,                    // schema version (1)
  meta: Y.Map<Meta>,           // scene_ticks: Y.Array<number>
  strokes: Y.Array<Stroke>,    // append-only stroke data
  texts: Y.Array<TextBlock>,   // immutable once committed
  code: Y.Map<CodeCell>,       // future
  outputs: Y.Array<Output>     // future
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
  points: number[];     // flat [x,y,x,y,...] NEVER Float32Array
  bbox: [number, number, number, number];
  scene: SceneIdx;      // 0-based index, assigned at commit using currentScene
  createdAt: number;    // ms epoch
  userId: string;
}

// Type alias: SceneIdx = number (0-based scene index)

interface Snapshot {
  docVersion: number; // Incremental version, replaces svKey
  scene: number;        // from meta.scene_ticks.length
  strokes: ReadonlyArray<StrokeView>;  // filtered by scene
  texts: ReadonlyArray<TextView>;       // filtered by scene
  presence: PresenceView;               // throttled to 30Hz
  spatialIndex: null;   // Phase 8: RBush
  view: ViewTransform;  // world↔canvas transforms
  meta: { bytes?: number; cap: number; readOnly: boolean };
}

interface GateStatus {
  idbReady: boolean;
  wsConnected: boolean;
  wsSynced: boolean;
  awarenessReady: boolean;
  firstSnapshot: boolean;
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
**Coordinate Spaces**: World (Y.Doc data, stable across zoom/screens) → Canvas (CSS pixels, view transform) → Device (physical pixels, DPR only). Apply DPR once at canvas setup, not in transforms. Two canvas architecture, one for preview and presence, the other base canvas(invalidated on Y.doc updates)

### Device-Local UI State (Integrated)
**Zustand Store** (`stores/device-ui-store.ts`) - Fully integrated via guarded adapter
**Canvas Integration** (`lib/tools/types.ts`) - toolbarToDeviceUI adapter:
```typescript
// Guarded adapter ensures safe tool state
export function toolbarToDeviceUI(toolbar: ToolbarState): DeviceUIState {
  // Defaults unknown tools to 'pen', clamps size 1-64, validates color
  return { tool, color, size, opacity };
}
```
- Persisted in localStorage with versioning
- Tracks toolbar state, lastSeenSceneByRoom, collaboration mode
- Tool state frozen at pointer-down for consistency

### Core Components

#### RoomDocManager (`client/src/lib/room-doc-manager.ts`)
Central authority that owns Y.Doc and providers:
```typescript
interface RoomDocManager {
  readonly currentSnapshot: Snapshot;  // Never null
  subscribeSnapshot(cb: (snap: Snapshot) => void): Unsub;
  subscribePresence(cb: (p: PresenceView) => void): Unsub;  // Needs throttling
  subscribeRoomStats(cb: (s: RoomStats | null) => void): Unsub;  // Needs persist_ack
  subscribeGates(cb: (gates: GateStatus) => void): Unsub;  // 150ms debounced
  getGateStatus(): Readonly<GateStatus>;  // For useSyncExternalStore
  mutate(fn: (ydoc: Y.Doc) => void): void;  // Single yjs.transact wrapper
  extendTTL(): void;
  destroy(): void;
}
```

#### Shared Configuration (`/packages/shared/src/config.ts`)
All constants centralized with environment overrides. Import and use:
```typescript
import { ROOM_CONFIG, STROKE_CONFIG, isRoomReadOnly } from '@avlo/shared';

// Examples:
ROOM_CONFIG.ROOM_SIZE_WARNING_BYTES  // 13MB
ROOM_CONFIG.ROOM_SIZE_READONLY_BYTES // 15MB
if (isRoomReadOnly(sizeBytes)) { /* Block writes */ }
```
    
```
Tests co-located in `__tests__/` folders within each directory. Client and server have separate vitest configs - use `npm run test:client` or `npm run test:server`.

### Path Aliases
- `@avlo/shared` → `../packages/shared/src/*` (access shared config/types)
- `@/*` → `./src/*` (within client workspace)

## Essential Commands

```bash
# Core development
npm install               # Install all dependencies
npm run dev              # Start client & server
npm run build            # Production build
npm run typecheck        # Type check all workspaces

# Testing
npm test                 # Memory-safe mode (1.3GB)
npm run test:watch       # Parallel mode (8GB+ RAM)

# Code quality
npm run lint:fix         # Fix linting issues
npm run format           # Format code
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
   - Publisher is continuous; publish when doc or awareness is dirty;

5. **Data Storage Rules**
   - Arrays stored as `number[]` in Yjs (never Float32Array)
   - Float32Array created only at render time
   - Scene assigned at commit time using currentScene
   - Points flattened as `[x0,y0,x1,y1,...]`

## Memory-Safe Testing

Tests default to single-threaded (1.3GB max) due to Y.Doc memory usage. Use `npm test` for memory-safe mode or `npm run test:watch` for parallel development (8GB+ RAM needed).

## Provider Initialization  
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
- **Scene**: Assigned at commit using currentScene (not about causal consistency)
- **Awareness**: 30Hz throttled, ephemeral, never persisted
- **persist_ack**: Server authoritative for size/TTL
- **Snapshots**: Never null, frozen, new arrays per publish
- **DrawingTool**: RAF-coalesced pointer events, Douglas-Peucker simplification in world units
- **Preview**: Rendered at 0.35 opacity, invalidates old and new bounds on move
- **Phase 6 Additions**:
  - **y-indexeddb**: Room-scoped persistence in `avlo.v1.rooms.<roomId>`
  - **y-websocket**: Authoritative sync path, immediate connection (no wait for IDB)
  - **Redis**: Compressed Yjs doc storage with TTL, AOF enabled
  - **Prisma**: Non-authoritative metadata (title, size_bytes, timestamps)
  - **TanStack Query**: Metadata fetching with 10s polling
  - **Zod**: Environment and API validation
- **Phase 6-7 Infrastructure**:
  - **React Router**: Dynamic room routing at `/room/:roomId`
  - **subscribeGates**: Stable primitive snapshots prevent re-render loops
  - **Toolbar UI**: Foundation for stamps, text, eraser tools
  - **ClearBoard**: lastSeenScene tracking for export after clear
  - **Connection UI**: Online/Offline states (no "Syncing" in offline-first)

See `IMPLEMENTATION.MD` for detailed phase breakdown and `OVERVIEW.MD` for complete specifications.