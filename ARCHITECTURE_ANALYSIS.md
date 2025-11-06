# AVLO Architecture Deep Dive - Current State Analysis
**Date:** 2025-11-06
**Purpose:** Complete understanding of current architecture before Cloudflare Durable Objects migration

---

## Executive Summary

AVLO is an offline-first collaborative whiteboard built on:
- **Frontend:** React + Vite + TypeScript + Tailwind CSS
- **Realtime:** Yjs CRDT with y-websocket provider (client) + @y/websocket-server (server)
- **Persistence:** Redis (authoritative Y.Doc state) + PostgreSQL (non-authoritative metadata)
- **Infrastructure:** Express HTTP server + WebSocket server (separate from HTTP)
- **Architecture:** Monorepo with workspaces (client, server, packages/shared)

**Migration Goal:** Replace Express + Redis + y-websocket stack with Cloudflare Durable Objects + SQLite + y-partyserver for serverless, edge-based realtime collaboration.

---

## 1. Current Server Implementation

### 1.1 WebSocket Server Architecture

**File:** `/server/src/websocket-server.ts`

**Key Components:**

```typescript
// Server stack
import { WebSocketServer } from 'ws';           // WebSocket server
import { setupWSConnection, getYDoc } from '@y/websocket-server/utils';
import * as Y from 'yjs';
import { getRedisAdapter } from './lib/redis.js';
import { prisma } from './lib/prisma.js';
```

**Connection Flow:**

1. **Path Validation:** `/ws/<roomId>` format required
2. **Origin Checking:** Validates against `ORIGIN_ALLOWLIST` + allows `*.trycloudflare.com`
3. **Capacity Enforcement:** Max `MAX_CLIENTS_PER_ROOM` (default: 105)
4. **Document Management:**
   - Uses `getYDoc(roomId)` from @y/websocket-server (singleton per room)
   - First connection loads from Redis (`Y.applyUpdate(doc, savedState)`)
   - Subsequent connections reuse in-memory Y.Doc
5. **Persistence:**
   - 100ms debounced writes to Redis on `doc.on('update')`
   - Gzip compression (level 4)
   - Redis key: `room:<roomId>` with 14-day TTL (default)
   - Updates PostgreSQL metadata (sizeBytes, lastWriteAt)
6. **Cleanup:**
   - Last client disconnect triggers final persist
   - Observers removed
   - Y.Doc GC handled by @y/websocket-server internally

**Critical Patterns:**
- Per-room connection tracking: `Map<roomId, Set<WebSocket>>`
- Single update handler per room (first connection only)
- Room-full protocol: JSON message before close

### 1.2 Redis Persistence Layer

**File:** `/server/src/lib/redis.ts`

**RedisAdapter Design:**

```typescript
class RedisAdapter {
  private client: ReturnType<typeof createClient>;

  // Methods
  async saveRoom(roomId: string, docState: Uint8Array): Promise<number>
  async loadRoom(roomId: string): Promise<Uint8Array | null>
  async extendTTL(roomId: string): Promise<boolean>
  async exists(roomId: string): Promise<boolean>
}
```

**Key Features:**
- Gzip compression (configurable level, default 4)
- 14-day TTL refresh on writes (configurable `ROOM_TTL_DAYS`)
- Type-safe Buffer handling (`withTypeMapping`)
- Singleton pattern with reconnect strategy (max 10 retries, exponential backoff)
- Compressed size returned for metadata updates

**Storage Model:**
- Key: `room:<roomId>`
- Value: Gzipped Y.Doc state vector (Uint8Array)
- TTL: Refreshed on every write (extend-on-activity pattern)

### 1.3 PostgreSQL Metadata

**File:** `/server/prisma/schema.prisma`

```prisma
model RoomMetadata {
  id          String   @id        // ULID
  title       String   @default("")
  createdAt   DateTime @default(now())
  lastWriteAt DateTime @default(now())
  sizeBytes   Int      @default(0)

  @@index([lastWriteAt(sort: Desc)])
}
```

**Usage:**
- Non-authoritative metadata only (title, size, timestamps)
- Created on demand if missing (GET /api/rooms/:id/metadata)
- Updated on every Redis persist (debounced)
- Used for TTL expiry calculations (lastWriteAt + ROOM_TTL_DAYS)

### 1.4 REST API Surface

**File:** `/server/src/routes/rooms.ts`

**Endpoints:**

1. **POST /api/rooms** - Create room
   - Generates ULID
   - Creates Prisma record with optional title
   - Returns metadata (id, title, createdAt, sizeBytes=0)

2. **GET /api/rooms/:id/metadata** - Get metadata
   - Checks Redis exists (authoritative)
   - Returns 404 if expired/missing
   - Creates minimal Prisma record if missing
   - Calculates expiresAt (lastWriteAt + TTL)

3. **PUT /api/rooms/:id/rename** - Rename room
   - Updates Prisma title only

**Guard Pattern:**
- Redis existence check before serving metadata (authoritative check)

### 1.5 Environment Configuration

**File:** `/server/src/config/env.ts`

```typescript
const ServerEnvSchema = z.object({
  PORT: z.coerce.number().default(3001),
  ORIGIN_ALLOWLIST: z.string().transform(s => s.split(',')),
  REDIS_URL: z.string().min(1),
  DATABASE_URL: z.string().min(1),
  ROOM_TTL_DAYS: z.coerce.number().min(1).max(90).default(14),
  WS_MAX_FRAME_BYTES: z.coerce.number().default(2_000_000),
  MAX_CLIENTS_PER_ROOM: z.coerce.number().default(105),
  GZIP_LEVEL: z.coerce.number().min(1).max(9).default(4),
});
```

**Validation:** Zod-validated on startup, exits on error

---

## 2. Client WebSocket Integration

### 2.1 RoomDocManager Architecture

**File:** `/client/src/lib/room-doc-manager.ts` (2337 lines)

**Core Responsibilities:**
1. **Y.Doc Ownership:** Single source of truth per room
2. **Provider Orchestration:** IndexedDB + WebSocket (+ WebRTC future)
3. **Snapshot Publishing:** RAF-based dirty tracking (60 FPS base, 30 FPS mobile/battery)
4. **Spatial Indexing:** RBush R-tree for viewport culling
5. **Cursor Interpolation:** Smooth remote cursors (66ms window, 0.5px quantization)
6. **Undo/Redo:** Per-user Yjs UndoManager (origin-tracked by userId)
7. **Gate System:** Async initialization coordination (IDB, WS, awareness)

**Critical Design Patterns:**

```typescript
interface IRoomDocManager {
  readonly currentSnapshot: Snapshot;
  subscribeSnapshot(cb: (snap: Snapshot) => void): Unsub;
  subscribePresence(cb: (p: PresenceView) => void): Unsub;
  subscribeGates(cb: (gates: GateStatus) => void): Unsub;
  mutate(fn: (ydoc: Y.Doc) => void): void;
  undo(): void;
  redo(): void;
  updateCursor(worldX?: number, worldY?: number): void;
}
```

**State Machine:**
- **EmptySnapshot** created synchronously on construct
- **First Snapshot** published after first Y.Doc update (gate: `G_FIRST_SNAPSHOT`)
- **Presence-only updates** clone previous snapshot (docVersion unchanged)
- **Document updates** trigger full rebuild from Y.Doc (docVersion++)

### 2.2 WebSocket Provider Setup

**Method:** `initializeWebSocketProvider()` (lines 1701-1890)

**Connection Flow:**

```typescript
// 1. Build WebSocket URL
const wsUrl = this.buildWebSocketUrl(wsBase); // /ws or VITE_WS_URL override

// 2. Create provider
this.websocketProvider = new WebsocketProvider(
  wsUrl,
  this.roomId,
  this.ydoc,
  {
    awareness: this.yAwareness,
    maxBackoffTime: 10000,
    resyncInterval: 5000,
  }
);

// 3. Wire gates
this.websocketProvider.on('status', this._onWebSocketStatus);
this.websocketProvider.on('sync', (isSynced: boolean) => {
  if (isSynced) this.openGate('wsSynced');
});

// 4. Wire awareness
this.yAwareness.on('update', this._onAwarenessUpdate);
```

**URL Builder Logic:**

```typescript
private buildWebSocketUrl(basePath: string): string {
  // 1. Check for explicit override (tunneling)
  if (clientConfig.VITE_WS_URL) {
    return clientConfig.VITE_WS_URL.replace(/\/$/, '');
  }

  // 2. Handle absolute URLs
  if (basePath.startsWith('ws://') || basePath.startsWith('wss://')) {
    return basePath;
  }

  // 3. Build from location
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const host = window.location.host;
  const cleanPath = basePath.startsWith('/') ? basePath : `/${basePath}`;
  return `${protocol}//${host}${cleanPath}`;
}
```

**Key Behaviors:**
- `VITE_WS_URL` override for Cloudflare tunnels (full WebSocket URL)
- `VITE_WS_BASE` for relative paths (default: `/ws`)
- Auto-protocol selection (ws/wss based on page protocol)

### 2.3 Gate System

**Five Gates:**

1. **G_IDB_READY** - IndexedDB synced or 2s timeout
2. **G_WS_CONNECTED** - WebSocket open
3. **G_WS_SYNCED** - First sync exchange complete
4. **G_AWARENESS_READY** - Awareness channel open
5. **G_FIRST_SNAPSHOT** - First doc-derived snapshot published

**Initialization Dependencies:**

```
Constructor
  ├─ Create Y.Doc (guid: roomId)
  ├─ Attach IDB provider (parallel, 2s timeout)
  ├─ Attach WS provider (parallel, 5s connect timeout, 10s sync timeout)
  └─ whenGateOpen('idbReady') + race(whenGateOpen('wsSynced'), delay(350ms))
       └─ Seed structures if !root.has('meta')
       └─ setupArrayObservers()
       └─ attachUndoManager()
```

**Seeding Guard (WS-aware):**
- Wait for IDB ready AND (WS synced OR 350ms grace)
- Prevents fresh-room race conditions across tabs
- Only seed once if `root.has('meta')` is false

### 2.4 Awareness & Cursor Smoothing

**Local Cursor Updates:**

```typescript
updateCursor(worldX?: number, worldY?: number): void {
  const quantize = (v: number) => Math.round(v / 0.5) * 0.5;
  const newCursor = worldX !== undefined && worldY !== undefined
    ? { x: quantize(worldX), y: quantize(worldY) }
    : undefined;

  if (cursorChanged) {
    this.localCursor = newCursor;
    this.awarenessIsDirty = true;
    if (this.gates.awarenessReady) {
      this.scheduleAwarenessSend();
    }
  }
}
```

**Awareness Sending (Backpressure):**
- Base rate: 13.33 Hz (75ms interval)
- Degraded rate: 8 Hz (125ms) if buffer > 16KB
- Jitter: ±10ms
- No-ping policy: Only send on state change
- Mobile: Always `cursor: undefined`, `activity: 'idle'`

**Cursor Interpolation (Remote):**
- 66ms lerp window between samples
- Keyed by `clientId` (not userId) for proper cleanup
- Seq-based ordering (drops stale/duplicate)
- Gap detection skips lerp (instant snap)

### 2.5 Stable User Identity

**File:** `/client/src/lib/user-profile-manager.ts`

**UserProfileManager (Singleton):**
- Persists to localStorage: `avlo:user:v1`
- Graceful fallback for private browsing (ephemeral ULID)
- Plain ULID format (no prefix)
- Used as transaction origin: `ydoc.transact(fn, this.userId)`

**Integration:**
```typescript
const identity = userProfileManager.getIdentity();
this.userId = identity.userId;
this.userProfile = { name: identity.name, color: identity.color };
```

### 2.6 Spatial Index (Two-Epoch Model)

**Rebuild Epoch:**
- Triggered by: First attach, scene change, sanity failures
- Flow: `hydrateViewsFromY()` → `rebuildSpatialIndexFromViews()` → reset flag

**Steady-State Epoch:**
- Array observers update maps + RBush directly on Y.Array deltas
- Insert: Build view → add to Map → `spatialIndex.insertStroke()`
- Delete: Extract IDs from `event.changes.deleted.getContent()` → remove

**Authoritative State:**
```typescript
// Maps = single source of truth
private strokesById = new Map<string, StrokeView>();
private textsById = new Map<string, TextView>();

// RBush = derived acceleration structure
private spatialIndex: RBushSpatialIndex | null = null;
private needsSpatialRebuild = true;
```

**Snapshot Composition:**
- Arrays derived from Maps: `Array.from(strokesById.values())`
- Scene filtering at snapshot time: `filter(s => s.scene === currentScene)`
- Spatial index shared live (read-only facade)

---

## 3. Monorepo Structure

### 3.1 Workspace Layout

```
avlo/
├── client/              # React SPA
│   ├── src/
│   │   ├── lib/         # RoomDocManager, config, tools
│   │   ├── canvas/      # Canvas orchestration
│   │   ├── renderer/    # RenderLoop, stroke caching
│   │   ├── hooks/       # useRoomDoc, useRoomSnapshot
│   │   └── pages/       # RoomPage
│   ├── vite.config.ts   # Vite config with proxy
│   └── package.json
├── server/              # Express + WS server
│   ├── src/
│   │   ├── lib/         # Redis, Prisma
│   │   ├── routes/      # REST API
│   │   └── websocket-server.ts
│   ├── prisma/
│   │   └── schema.prisma
│   └── package.json
├── packages/
│   └── shared/          # Shared types, config
│       ├── src/
│       │   ├── types/   # Snapshot, Stroke, etc.
│       │   ├── config/  # ROOM_CONFIG, etc.
│       │   └── spatial/ # RBush wrapper
│       └── package.json
└── package.json         # Root workspace
```

### 3.2 Package Dependencies

**Root:**
- `concurrently` - Parallel dev servers
- `react-router-dom` - SPA routing
- `vitest` - Testing

**Client:**
- `react` 18.3.1
- `yjs` 13.6.27
- `y-websocket` 3.0.0
- `y-indexeddb` 9.0.12
- `y-webrtc` 10.3.0 (unused currently)
- `perfect-freehand` 1.2.2
- `@tanstack/react-query` 5.85.5
- `zustand` 5.0.8
- `monaco-editor` 0.52.2

**Server:**
- `express` 4.21.2
- `ws` 8.18.3
- `@y/websocket-server` 0.1.1
- `redis` 5.8.2
- `@prisma/client` 6.15.0
- `ulid` 3.0.1
- `zod` 4.1.5

**Shared:**
- `rbush` 4.0.1 (R-tree spatial index)
- `ulid` 3.0.1
- `zod` 4.1.1

### 3.3 Build & Dev Setup

**Root Scripts:**
```json
{
  "dev": "concurrently -n client,server -c cyan,magenta \"npm run dev -w client\" \"npm run dev -w server\"",
  "build": "npm run build -w client && npm run build -w server",
  "typecheck": "npm run -w packages/shared build:types && npm run -w client typecheck && npm run -w server typecheck"
}
```

**Current Dev Flow:**
1. **Server:** `tsx watch src/index.ts` (port 3001)
2. **Client:** `vite` (port 3000)
3. **Proxy:** Vite proxies `/api` and `/ws` to `localhost:3001`

**Vite Config (client/vite.config.ts):**
```typescript
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@avlo/shared': path.resolve(__dirname, '../packages/shared/src'),
    },
  },
  build: {
    outDir: '../server/public',  // Client build to server/public
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks: {
          monaco: ['monaco-editor'],
          yjs: ['yjs', 'y-websocket', 'y-indexeddb', 'y-webrtc'],
        },
      },
    },
  },
  server: {
    port: 3000,
    proxy: {
      '/api': 'http://localhost:3001',
      '/ws': {
        target: 'ws://localhost:3001',
        ws: true,
        changeOrigin: true,
      },
    },
  },
});
```

**Production Build:**
1. Client builds to `server/public/`
2. Server serves static files from `public/`
3. SPA fallback for all non-API routes

---

## 4. Gate System & Initialization Flow

### 4.1 Complete Initialization Timeline

```
t=0ms    Constructor starts
         ├─ Create Y.Doc({ guid: roomId })
         ├─ Create YAwareness(ydoc)
         ├─ Mark awarenessIsDirty (don't send until gate opens)
         ├─ Initialize timing abstractions
         ├─ Create EmptySnapshot (synchronous, non-null)
         ├─ setupObservers() (Y.Doc update listener)
         └─ Start RAF publish loop (immediately)

t=0ms    initializeIndexedDBProvider() (parallel)
         ├─ Create IndexeddbPersistence(dbName, ydoc)
         ├─ Set 2s timeout for G_IDB_READY
         └─ whenSynced.then() → handleIDBReady()

t=0ms    initializeWebSocketProvider() (parallel)
         ├─ Build WebSocket URL (VITE_WS_URL override or computed)
         ├─ Create WebsocketProvider(wsUrl, roomId, ydoc, { awareness })
         ├─ Wire 'status' event → G_WS_CONNECTED
         ├─ Wire 'sync' event → G_WS_SYNCED
         ├─ Wire awareness 'update' → ingestAwareness()
         ├─ Set 5s timeout for G_WS_CONNECTED
         └─ Set 10s timeout for G_WS_SYNCED

t=?ms    G_IDB_READY opens
         └─ Trigger: IndexedDB synced OR 2s timeout

t=?ms    G_WS_CONNECTED opens
         ├─ Trigger: WebSocket 'connected' event
         └─ Open G_AWARENESS_READY immediately
            ├─ Mark awarenessIsDirty
            ├─ scheduleAwarenessSend()
            └─ Mark presenceDirty (force publish)

t=?ms    G_WS_SYNCED opens
         ├─ Trigger: WebSocket 'sync' event (isSynced=true)
         └─ Log container identities

t=?ms    whenGateOpen('idbReady') + race(whenGateOpen('wsSynced'), delay(350ms)) resolves
         ├─ Check if root.has('meta')
         │  ├─ false → initializeYjsStructures() (seed once)
         │  └─ true → already loaded from IDB/WS
         ├─ setupArrayObservers() (safe now, structures exist)
         └─ attachUndoManager()

t=?ms    G_FIRST_SNAPSHOT opens
         └─ Trigger: First buildSnapshot() with sawAnyDocUpdate=true
```

### 4.2 Gate Transition Events

**G_AWARENESS_READY Lifecycle:**

**Open (connected):**
```typescript
if (event.status === 'connected') {
  this.openGate('awarenessReady');
  this.awarenessIsDirty = true;
  this.scheduleAwarenessSend();
  this.publishState.presenceDirty = true;
}
```

**Close (disconnected):**
```typescript
if (event.status === 'disconnected') {
  this.closeGate('awarenessReady');
  clearCursorTrails();
  this.publishState.presenceDirty = true;
  this.localCursor = undefined;
  this.yAwareness.setLocalState(null); // Signal departure
}
```

**Invariant:** Cursors render only when `G_AWARENESS_READY && G_FIRST_SNAPSHOT`

### 4.3 Offline Resilience

**IndexedDB (Offline-First):**
- Loads immediately on manager creation
- 2s timeout → proceed with empty doc
- Writes automatically on Y.Doc updates (y-indexeddb handles)

**WebSocket (Optional):**
- 5s connect timeout → log warning, continue offline
- 10s sync timeout → keep rendering from IDB
- Reconnect strategy: exponential backoff (max 10s)

**Mutate Guard (Pre-Init):**
```typescript
mutate(fn: (ydoc: Y.Doc) => void): void {
  const root = this.ydoc.getMap('root');
  if (!root.has('meta')) {
    // Defer until structures initialized
    this.whenGateOpen('idbReady').then(async () => {
      await Promise.race([this.whenGateOpen('wsSynced'), this.delay(350)]);
      // Retry mutate after structures ready
    });
    return;
  }
  // Proceed with mutation...
}
```

---

## 5. Client Configuration

**File:** `/client/src/lib/config-schema.ts`

```typescript
const ClientConfigSchema = z.object({
  VITE_WS_BASE: z.string().min(1).default('/ws'),
  VITE_API_BASE: z.string().min(1).default('/api'),
  VITE_ROOM_TTL_DAYS: z.coerce.number().min(1).max(90).default(14),
  VITE_WS_URL: z.string().optional(), // Full override for tunneling
});

export const clientConfig = loadClientConfig();
```

**Environment Variables (Development):**
- `VITE_WS_BASE="/ws"` (default, proxied by Vite)
- `VITE_API_BASE="/api"` (default, proxied by Vite)
- `VITE_WS_URL` (optional, for Cloudflare tunnel bypass)

**Tunnel Support:**
- Allows direct WebSocket URL (e.g., `wss://tunnel.trycloudflare.com/ws`)
- Bypasses Vite proxy for testing with cloudflared tunnels

---

## 6. Data Flow Summary

### 6.1 Write Path (Draw Stroke Example)

```
UI (pointer-up)
  ├─ Build stroke object (id: ULID, points, bbox, scene, userId)
  └─ Call room.mutate()
       ├─ Check guards (room size, mobile, frame size)
       ├─ ydoc.transact(() => { yStrokes.push([stroke]) }, this.userId)
       └─ Mark publishState.isDirty = true

Y.Doc 'update' event fires
  ├─ handleYDocUpdate (increment docVersion, mark dirty)
  ├─ Store update in ring buffer
  └─ Update size estimator

Y.Array observer (strokesObserver) fires
  ├─ Build StrokeView from delta
  ├─ Update strokesById map
  └─ Update spatialIndex.insertStroke()

RAF publish loop (next tick)
  ├─ buildSnapshot()
  │  ├─ Compose from strokesById/textsById maps
  │  ├─ Filter by currentScene
  │  └─ Attach spatialIndex (live)
  ├─ publishSnapshot()
  └─ Notify subscribers

y-websocket provider
  ├─ Sends delta to server (WebSocket binary frame)
  └─ Receives deltas from other clients

Server (websocket-server.ts)
  ├─ @y/websocket-server applies update to shared Y.Doc
  ├─ Debounced 'update' handler (100ms)
  │  ├─ Y.encodeStateAsUpdate(doc)
  │  ├─ Gzip compress
  │  ├─ Redis.setEx(key, ttl, compressed)
  │  └─ Prisma.upsert({ sizeBytes, lastWriteAt })
  └─ Broadcast to all connected clients
```

### 6.2 Read Path (Room Load)

```
Browser navigates to /room/abc123

React Router → RoomPage
  ├─ useRoomDoc('abc123')
  │  ├─ RoomDocRegistry.acquire('abc123')
  │  └─ Create RoomDocManager (if not exists)
  │       ├─ Y.Doc({ guid: 'abc123' })
  │       ├─ IndexedDB loads persisted state (2s timeout)
  │       ├─ WebSocket connects to ws://host/ws/abc123
  │       │  ├─ Server: getYDoc('abc123') (singleton)
  │       │  ├─ First connection: Load from Redis
  │       │  └─ Sync to client
  │       ├─ Wait for IDB + (WS OR 350ms)
  │       ├─ Seed structures if fresh
  │       ├─ Attach observers & UndoManager
  │       └─ Publish first snapshot
  └─ useRoomSnapshot('abc123')
       ├─ Subscribe to snapshot updates
       └─ Render canvas with snapshot data

TanStack Query: useRoomMetadata('abc123')
  ├─ GET /api/rooms/abc123/metadata
  ├─ Server checks Redis.exists('abc123')
  │  ├─ false → 404
  │  └─ true → Return Prisma metadata + calculated expiresAt
  └─ Update roomDoc.setRoomStats({ bytes, expiresAt })
```

---

## 7. Key Migration Concerns

### 7.1 What Can Be Preserved

**Client-Side (Mostly Unchanged):**
- ✅ RoomDocManager core architecture
- ✅ IndexedDB offline-first pattern
- ✅ Gate system (just swap WS provider)
- ✅ Snapshot publishing & RAF loop
- ✅ Spatial indexing & cursor smoothing
- ✅ Undo/Redo (per-user, origin-tracked)
- ✅ Canvas rendering & tools
- ✅ React Router `/room/:id` pattern

**Client Changes Needed:**
- 🔄 Replace `y-websocket` provider → `y-partyserver/provider`
- 🔄 Update `initializeWebSocketProvider()` method
- 🔄 Remove `buildWebSocketUrl()` logic (Party provider handles)
- 🔄 Update config: `VITE_WS_BASE` → `VITE_PARTY_HOST` (optional)

### 7.2 What Must Be Replaced

**Server-Side (Complete Replacement):**
- ❌ Express HTTP server
- ❌ ws WebSocket server
- ❌ @y/websocket-server utilities
- ❌ Redis persistence layer
- ❌ Prisma/PostgreSQL metadata (optional to keep for other uses)
- ❌ TTL management, persist-ack, size limits (removed by design)

**New Server-Side:**
- ✅ Cloudflare Worker (routing)
- ✅ Durable Object per room (extends YServer)
- ✅ DO SQLite storage (authoritative)
- ✅ R2 backups (10s throttled alarm)
- ✅ y-partyserver hooks (onLoad/onSave)

### 7.3 Build System Changes

**Current:**
- Two dev servers (Vite port 3000, Express port 3001)
- Vite proxy config for `/api` and `/ws`
- Client builds to `server/public/`

**Future:**
- Single dev server (Vite + Worker via @cloudflare/vite-plugin)
- No proxy needed (same origin)
- Wrangler for deployment (`npx wrangler deploy`)

---

## 8. Dependency Analysis

### 8.1 Dependencies to Remove (Server)

```json
{
  "express": "^4.21.2",
  "ws": "^8.18.3",
  "@y/websocket-server": "^0.1.1",
  "redis": "^5.8.2",
  "@prisma/client": "^6.15.0",
  "prisma": "^6.15.0",
  "dotenv": "^16.4.7",
  "cors": "^2.8.5"
}
```

### 8.2 Dependencies to Add

```json
{
  "yjs": "^13.6.27",           // Already in client
  "partyserver": "latest",     // Cloudflare Party abstraction
  "y-partyserver": "latest",   // Yjs + PartyServer integration
  "wrangler": "latest",        // Cloudflare CLI
  "@cloudflare/vite-plugin": "latest"  // Dev integration
}
```

**Note:** `partyserver` and `y-partyserver` are published from Cloudflare's GitHub monorepo.

### 8.3 Dependencies to Keep

**Client (Unchanged):**
- `yjs` 13.6.27
- `y-indexeddb` 9.0.12 (offline-first)
- `react-router-dom` 7.8.2
- `@tanstack/react-query` 5.85.5
- `perfect-freehand` 1.2.2
- `zustand` 5.0.8

**Client (Remove):**
- `y-websocket` 3.0.0 (replaced by y-partyserver/provider)
- `y-webrtc` 10.3.0 (unused, future consideration)

---

## 9. Current Pain Points (Addressed by Migration)

### 9.1 Development Complexity
- **Current:** Two servers, two ports, proxy config, separate logs
- **Future:** One server (Vite + Worker), one port, unified HMR

### 9.2 Deployment Complexity
- **Current:** Railway or VPS, Redis instance, PostgreSQL, environment secrets
- **Future:** `wrangler deploy`, R2 bucket, no DB provisioning

### 9.3 Scalability Limits
- **Current:** Single Redis instance, vertical scaling only, manual sharding
- **Future:** Horizontal scaling per-room, edge computing, auto-scaling

### 9.4 Latency
- **Current:** Round-trip to Redis on every write (100ms debounce)
- **Future:** SQLite writes in-memory to DO (microseconds), R2 backups async

### 9.5 Cost Model
- **Current:** Always-on server + Redis + PostgreSQL (fixed costs)
- **Future:** Pay-per-use (Worker invocations, DO active time, R2 storage)

---

## 10. Critical Files for Migration

### 10.1 Client Files to Modify

**High Priority:**
1. `/client/src/lib/room-doc-manager.ts`
   - `initializeWebSocketProvider()` (lines 1701-1890)
   - `buildWebSocketUrl()` (lines 1892-1915) - remove or stub
   - Import: `y-websocket` → `y-partyserver/provider`

2. `/client/src/lib/config-schema.ts`
   - Add `VITE_PARTY_HOST`, `VITE_PARTY_NAME`
   - Remove `VITE_WS_BASE`, `VITE_WS_URL`

3. `/client/vite.config.ts`
   - Add `@cloudflare/vite-plugin`
   - Remove proxy config (handled by plugin)

**No Changes Needed:**
- Canvas rendering (`/client/src/canvas/*`)
- Tools (`/client/src/lib/tools/*`)
- Hooks (`/client/src/hooks/*`)
- Pages (`/client/src/pages/*`)

### 10.2 Server Files to Delete

**Complete Removal:**
1. `/server/src/websocket-server.ts` (154 lines)
2. `/server/src/lib/redis.ts` (135 lines)
3. `/server/src/lib/prisma.ts` (if metadata not needed)
4. `/server/src/routes/rooms.ts` (if metadata not needed)
5. `/server/src/middleware/index.ts`
6. `/server/src/index.ts` (Express entry)

### 10.3 New Files to Create

**Root Level:**
1. `/wrangler.toml` - Cloudflare config
   - DO binding (`WHITEBOARD_PARTY`)
   - SQLite migration (`new_sqlite_classes`)
   - R2 binding (`R2_BACKUPS`)

**Worker Code:**
2. `/src/worker.ts` - Worker entry (routing)
3. `/src/parties/whiteboard.ts` - DO class (extends YServer)

---

## 11. Testing Considerations

### 11.1 Current Test Surface

**Client Tests:**
- RoomDocManager unit tests (gate system, snapshot publishing)
- Spatial index tests (RBush operations)
- Tool tests (drawing, eraser, text)

**Server Tests:**
- Redis adapter tests
- WebSocket connection tests
- Metadata API tests

### 11.2 Migration Test Plan

**Phase 1: Local Development**
- Test with `wrangler dev` (local DO + SQLite emulation)
- Verify IndexedDB + Party provider coexistence
- Test gate system with new provider
- Verify cursor smoothing & awareness

**Phase 2: Multi-Client Testing**
- Multiple browser tabs (same DO instance)
- Cross-tab CRDT convergence
- Offline → online reconnect
- R2 backup verification

**Phase 3: Production Preview**
- Deploy to Cloudflare preview (`wrangler deploy --dry-run`)
- Load testing (connections per DO)
- Verify SQLite persistence across DO restarts

---

## 12. Migration Risks & Mitigations

### 12.1 Risk: Provider API Incompatibility

**Risk:** `y-partyserver/provider` may have different event signatures than `y-websocket`

**Mitigation:**
- Keep gate system logic (abstract from provider specifics)
- Map Party provider events to existing gate handlers
- Extensive local testing before production

### 12.2 Risk: SQLite Persistence Reliability

**Risk:** DO SQLite is newer technology, potential edge cases

**Mitigation:**
- R2 backups every 10s (safety net)
- Test DO restart scenarios extensively
- Implement version snapshots in SQLite for time-travel

### 12.3 Risk: Awareness Backpressure

**Risk:** Party provider may handle backpressure differently

**Mitigation:**
- Keep existing `scheduleAwarenessSend()` logic
- Monitor `bufferedAmount` if accessible
- Test with high-frequency cursor updates

### 12.4 Risk: Development Experience Regression

**Risk:** Cloudflare Vite plugin may have HMR issues or debugging limitations

**Mitigation:**
- Test plugin thoroughly in local dev
- Keep fallback to separate servers if needed
- Document any plugin quirks

---

## 13. Post-Migration Opportunities

### 13.1 Features Enabled by DO + SQLite

**Time-Travel (Version History):**
```sql
CREATE TABLE snapshots (
  timestamp INTEGER PRIMARY KEY,
  state BLOB NOT NULL
);
```

**Per-Room Analytics:**
```sql
CREATE TABLE metrics (
  event_type TEXT,
  timestamp INTEGER,
  data JSON
);
```

**Custom Persistence Hooks:**
- Broadcast persist-ack to clients (update UI badge)
- Custom `__YPS:` control messages (Party provider supports)

### 13.2 Infrastructure Improvements

**Edge Computing:**
- Rooms created near users (Cloudflare's 300+ data centers)
- Lower latency for global collaboration

**Horizontal Scaling:**
- No single-server bottleneck
- Automatic scaling per room demand

**Cost Optimization:**
- Pay only for active rooms
- No always-on server costs

### 13.3 Future Enhancements

**Image/Asset Support:**
- R2 storage for uploaded images
- DO SQLite stores references only
- Same bucket, different prefix (`rooms/<id>/images/...`)

**Persistent Code Execution:**
- Workers AI integration
- Run user code in DO context
- Store outputs in SQLite

**Advanced Backups:**
- Scheduled full backups (cron trigger)
- Point-in-time recovery
- Export to external storage (S3, GCS)

---

## 14. Summary & Next Steps

### 14.1 Current State Strengths

✅ **Solid Client Architecture**
- Offline-first Y.Doc + IndexedDB
- Gate system for async initialization
- Robust spatial indexing & rendering
- Per-user undo/redo

✅ **Well-Structured Codebase**
- Clear separation (client/server/shared)
- Type-safe with TypeScript + Zod
- Comprehensive testing setup

✅ **Production-Ready Patterns**
- Cursor smoothing & backpressure
- Debounced persistence
- Mobile detection & view-only

### 14.2 Current State Weaknesses

❌ **Dev Complexity**
- Two servers, two ports, proxy config
- Separate logs & debugging

❌ **Deployment Overhead**
- Manual Redis + PostgreSQL provisioning
- Environment secret management
- Single-server bottleneck

❌ **Scalability Limits**
- Vertical scaling only (larger Redis instance)
- No edge computing
- Fixed infrastructure costs

### 14.3 Migration Readiness

**Ready to Migrate:**
- ✅ Client architecture stable & well-tested
- ✅ Clear boundaries between transport & business logic
- ✅ Gate system abstracts provider specifics
- ✅ IndexedDB path independent of server

**Migration Prerequisites:**
- 📋 Study `y-partyserver` provider API (uploaded files)
- 📋 Test Cloudflare Vite plugin locally
- 📋 Set up Cloudflare account + R2 bucket
- 📋 Plan metadata migration (if keeping Prisma)

### 14.4 Recommended Migration Path

**Phase 1: Local Setup (1-2 days)**
1. Install dependencies (`wrangler`, `partyserver`, `y-partyserver`, `@cloudflare/vite-plugin`)
2. Create `wrangler.toml` with DO + R2 bindings
3. Implement `src/worker.ts` (routing)
4. Implement `src/parties/whiteboard.ts` (YServer + SQLite)
5. Test with `wrangler dev` (local DO emulation)

**Phase 2: Client Integration (1 day)**
1. Update `vite.config.ts` (add Cloudflare plugin)
2. Modify `RoomDocManager.initializeWebSocketProvider()`
3. Test gate system with new provider
4. Verify IndexedDB + Party provider coexistence

**Phase 3: Multi-Client Testing (1 day)**
1. Multiple tabs, same room
2. Cross-tab CRDT convergence
3. Offline → online scenarios
4. R2 backup verification

**Phase 4: Production Deploy (1 day)**
1. `wrangler deploy` to Cloudflare
2. DNS updates (if custom domain)
3. Monitor DO metrics
4. Gradual traffic migration

**Total Estimated Time:** 4-5 days for full migration + testing

---

## 15. Key Takeaways for AI Assistant

### 15.1 Critical Architecture Patterns

**Y.Doc Lifecycle:**
```typescript
// ONE Y.Doc per room, GUID = roomId
this.ydoc = new Y.Doc({ guid: roomId });

// NEVER mutate GUID after creation
// ALWAYS use userId as transaction origin for undo/redo
this.ydoc.transact(fn, this.userId);
```

**Gate System:**
```typescript
// Five gates, specific open conditions
G_IDB_READY       // IDB synced or 2s timeout
G_WS_CONNECTED    // WebSocket open
G_WS_SYNCED       // First sync complete
G_AWARENESS_READY // Awareness channel open
G_FIRST_SNAPSHOT  // First doc update published

// Cursors render ONLY when: G_AWARENESS_READY && G_FIRST_SNAPSHOT
```

**Seeding Guard:**
```typescript
// Wait for IDB + (WS OR 350ms grace)
await this.whenGateOpen('idbReady');
await Promise.race([
  this.whenGateOpen('wsSynced'),
  this.delay(350),
]);

// Only seed if truly fresh
if (!root.has('meta')) {
  this.initializeYjsStructures();
}
```

### 15.2 Migration Don'ts

❌ **Don't touch:**
- Canvas rendering logic
- Snapshot publishing RAF loop
- Spatial index (RBush) implementation
- Cursor interpolation
- Tool implementations

❌ **Don't change:**
- Y.Doc GUID (always roomId)
- Transaction origins (userId for undo/redo)
- Gate system logic (just wire new provider)

❌ **Don't add:**
- TTL management (removed by design)
- Frame size limits (Cloudflare handles)
- Persist-ack (removed by design)

### 15.3 Migration Do's

✅ **Do:**
- Replace `y-websocket` provider only
- Keep IndexedDB offline-first
- Wire Party provider events to existing gates
- Test extensively with multiple tabs
- Monitor DO SQLite persistence
- Verify R2 backups

✅ **Do leverage:**
- Cloudflare Vite plugin (one port dev)
- DO SQLite (fast, private per-room)
- R2 for backups (cheap, durable)
- Party provider's URL handling

---

**End of Analysis**

This document provides a complete understanding of AVLO's current architecture, ready for the Cloudflare Durable Objects migration. All critical patterns, dependencies, and migration concerns are documented for reference.
