# Phase 6 Implementation Guide: Complete Persistence Infrastructure

## Overview

Phase 6 implements the complete persistence infrastructure for Avlo, including offline-first IndexedDB storage, WebSocket real-time sync, Redis persistence, PostgreSQL metadata, and all associated gates and failure modes. This is a critical phase that establishes the foundation for all future collaboration features.

## Architecture Context

- **RoomDocManager** (`client/src/lib/room-doc-manager.ts`) is the central authority owning Y.Doc and providers
- **Registry Pattern** ensures singleton-per-room guarantee via `RoomDocManagerRegistry`
- **Provider Order**: y-indexeddb → y-websocket (WebRTC comes in Phase 17)
- **Gates** control feature availability with explicit timeouts and fallbacks
- **Boot visuals (MVP pivot):** No boot splash. RoomDocManager **never** touches the DOM. First paint is **`EmptySnapshot`**, followed by the first doc-derived snapshot via RAF. Render cache is **not** used by Phase 6.
- **Zod** validates boundaries at environment, HTTP, and WebSocket control layers

**CRITICAL**: > **⚠️ CRITICAL IMPLEMENTATION NOTE**:
> The svKey deduplication optimization that was originally in Phase 6 had to be removed.
> The svKey truncation (using only first 100 bytes of state vector) causes a critical bug where local client updates
> are not detected when state vectors exceed 100 bytes (common after IndexedDB loads historical data).
> This results in strokes not rendering until page refresh.
> **Solution**: Always publish when dirty, regardless of svKey comparison.

## Phase 6A: Offline-First Doc Persistence & Boot Gates

### 6A.1: Attach y-indexeddb Provider

#### 6A.1.1: Wire Provider Inside RoomDocManager

**File**: `client/src/lib/room-doc-manager.ts`

1. **Import y-indexeddb and types**:

```typescript
import { IndexeddbPersistence } from 'y-indexeddb';
```

2. **Replace unknown type with proper provider type**:

```typescript
// Line 89: Change from
private indexeddbProvider: unknown = null;
// To
private indexeddbProvider: IndexeddbPersistence | null = null;
```

3. **Add gate state tracking**:

```typescript
// After line 136 (destroyed flag), add:
// Gate tracking
private gates = {
  idbReady: false,
  wsConnected: false,
  wsSynced: false,
  awarenessReady: false,
  firstSnapshot: false,
};
private gateTimeouts: Map<string, ReturnType<typeof setTimeout>> = new Map();
private gateCallbacks: Map<string, Set<() => void>> = new Map();
```

4. **Initialize providers in constructor** (after line 185):

```typescript
// Initialize IndexedDB provider (Phase 6A)
this.initializeIndexedDBProvider();
```

5. **Implement provider initialization method** (add after setupObservers method):

```typescript
private initializeIndexedDBProvider(): void {
  try {
    // Create room-scoped IDB provider
    const dbName = `avlo.v1.rooms.${this.roomId}`;
    this.indexeddbProvider = new IndexeddbPersistence(dbName, this.ydoc);

    // Set up IDB gate with 2s timeout
    const timeoutId = setTimeout(() => {
      this.openGate('idbReady');
      console.debug('[RoomDocManager] IDB timeout reached, continuing with empty doc');
    }, 2000);
    this.gateTimeouts.set('idbReady', timeoutId);

    // Listen for IDB sync completion for gate control
    this.indexeddbProvider.whenSynced.then(() => {
      const timeout = this.gateTimeouts.get('idbReady');
      if (timeout) {
        clearTimeout(timeout);
        this.gateTimeouts.delete('idbReady');
      }
      this.openGate('idbReady');
      console.debug('[RoomDocManager] IDB synced successfully');
    }).catch((err) => {
      console.warn('[RoomDocManager] IDB sync error (non-critical):', err);
      // Still open gate on error - fallback to empty doc
      this.openGate('idbReady');
    });

    // Note: No need to listen for 'synced' event to mark dirty
    // Y.Doc updates from IDB will trigger the existing doc update handler

  } catch (err) {
    console.warn('[RoomDocManager] IDB initialization failed (non-critical):', err);
    // Mark as failed but continue
    this.openGate('idbReady');
  }
}
```

#### 6A.1.2: Implement Gate System

**File**: `client/src/lib/room-doc-manager.ts`

Add gate management methods (after initializeIndexedDBProvider):

```typescript
// Gate management
private openGate(gateName: keyof typeof this.gates): void {
  if (this.gates[gateName]) return; // Already open

  this.gates[gateName] = true;

  // Notify subscribers
  const callbacks = this.gateCallbacks.get(gateName);
  if (callbacks) {
    callbacks.forEach(cb => cb());
    callbacks.clear();
  }

  // Note: G_FIRST_SNAPSHOT opens in buildSnapshot() when first doc-derived snapshot publishes
  // Do NOT open it here based on other gates
}

private whenGateOpen(gateName: keyof typeof this.gates): Promise<void> {
  if (this.gates[gateName]) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    if (!this.gateCallbacks.has(gateName)) {
      this.gateCallbacks.set(gateName, new Set());
    }
    this.gateCallbacks.get(gateName)!.add(resolve);
  });
}

public getGateStatus(): Readonly<typeof this.gates> {
  return { ...this.gates };
}
```

#### 6A.1.3: Update Teardown Logic

**File**: `client/src/lib/room-doc-manager.ts`

Update the destroy method (around line 576):

```typescript
destroy(): void {
  if (this.destroyed) return;
  this.destroyed = true;

  // Stop RAF loop
  if (this.publishState.rafId !== -1) {
    this.frames.cancel(this.publishState.rafId);
  }

  // Clear gate timeouts
  this.gateTimeouts.forEach(timeout => clearTimeout(timeout));
  this.gateTimeouts.clear();

  // Cleanup providers (Phase 6A additions)
  if (this.indexeddbProvider) {
    this.indexeddbProvider.destroy();
    this.indexeddbProvider = null;
  }

  if (this.websocketProvider) {
    // Phase 6C: will add proper WS cleanup (disconnect + destroy)
    // For now, just null the reference - actual cleanup added in 6C
    this.websocketProvider = null;
  }

  // ... rest of existing cleanup
}
```

### 6A.2: Boot Discipline & First-Paint Guarantees

#### 6A.2.1: Ensure EmptySnapshot is Available

This is already implemented in the constructor (line 164):

```typescript
this._currentSnapshot = createEmptySnapshot();
```

**IMPORTANT**: The RAF publisher loop should already be running from manager creation (implemented in Phase 2). This ensures the first doc-derived snapshot appears ≤ 1 rAF after any Y update (from IDB or WS). Do NOT wait for any gates to start the RAF loop.

#### 6A.2.2: Fix svKey Publishing Bug — Always publish when dirty

**File**: `client/src/lib/room-doc-manager.ts`
**CRITICAL FIX**: Remove the svKey deduplication optimization from the RAF loop. The svKey truncation (first 100 bytes) misses local client updates when state vectors are large (>100 bytes), causing strokes not to render until page refresh.

**Update the RAF loop to always publish when dirty** (in `startPublishLoop` method, around line 710):

```typescript
private startPublishLoop(): void {
  const rafLoop = () => {
    // Publish if Y.Doc changed OR presence changed
    if (this.publishState.isDirty || this.publishState.presenceDirty) {
      const startTime = this.clock.now();

      // Build snapshot
      const newSnapshot = this.buildSnapshot();

      // CRITICAL FIX: Always publish when dirty, don't use svKey as a gate
      // The svKey truncation (first 100 bytes) was missing local client updates
      // when state vectors were large (>100 bytes), causing strokes to not render
      // until refresh. See PHASE_6A_DEBUG_REPORT.md for full details.
      this.publishSnapshot(newSnapshot);

      // Clear both dirty flags
      this.publishState.isDirty = false;
      this.publishState.presenceDirty = false;

      // Track timing for metrics
      this.publishState.lastPublishTime = this.clock.now();
      this.publishState.publishCostMs = this.clock.now() - startTime;
    }

    // Continue loop if not destroyed
    if (!this.destroyed) {
      this.publishState.rafId = this.frames.request(rafLoop);
    }
  };

  // Start the loop
  this.publishState.rafId = this.frames.request(rafLoop);
}
```

**What was removed**: The `svKeyChanged` comparison that was previously gating the `publishSnapshot` call. Now it always publishes when dirty, ensuring strokes render immediately.

Update buildSnapshot method to track svKey changes (around line 800):

```typescript
private buildSnapshot(): Snapshot {
  // ... existing implementation that builds `snapshot` ...
  // snapshot.svKey computed as truncated state-vector signature

  // After building snapshot, check if svKey changed
  // CRITICAL: In Phase 6, svKey is not consulted to dedupe publishing; it’s used here only to detect the first doc-derived snapshot for gate purposes
  if (snapshot.svKey !== this.publishState.lastSvKey) {
    this.publishState.lastSvKey = snapshot.svKey;

    // CRITICAL: This is the ONLY place where G_FIRST_SNAPSHOT opens
    // Opens when first doc-derived snapshot publishes (≤ 1 rAF after any Y update)
    if (!this.gates.firstSnapshot && snapshot.svKey !== '') {
      this.openGate('firstSnapshot');
      console.debug('[RoomDocManager] First doc-derived snapshot published');
    }
  }

  return snapshot;
}
```

### 6A.3: Client Config Validation with Zod

#### 6A.3.1: Create Config Schema

**File**: `client/src/lib/config-schema.ts` **(NEW FILE - Create this file)**

```typescript
import { z } from 'zod';

// Client configuration schema
export const ClientConfigSchema = z.object({
  VITE_WS_BASE: z.string().min(1, 'WebSocket base URL is required'),
  VITE_API_BASE: z.string().min(1, 'API base URL is required'),
  VITE_ROOM_TTL_DAYS: z.coerce.number().min(1).max(90).default(14),
  // Add other client-side configs as needed
});

export type ClientConfig = z.infer<typeof ClientConfigSchema>;

// Validation function with error handling
export function loadClientConfig(): ClientConfig {
  try {
    const config = {
      VITE_WS_BASE: import.meta.env.VITE_WS_BASE || '/ws',
      VITE_API_BASE: import.meta.env.VITE_API_BASE || '/api',
      VITE_ROOM_TTL_DAYS: Number(import.meta.env.VITE_ROOM_TTL_DAYS ?? 14),
    };

    return ClientConfigSchema.parse(config);
  } catch (error) {
    if (error instanceof z.ZodError) {
      console.error('[Config] Validation failed:', error.errors);
      // Show user-friendly error (this would be rendered in UI)
      throw new Error(`Configuration error: ${error.errors[0].message}`);
    }
    throw error;
  }
}

// Export validated config instance
export const clientConfig = loadClientConfig();
```

### 6A.4: Minimal "Recent Rooms" Readiness

**File**: `client/src/lib/room-doc-manager.ts`

Add a public method to check IDB readiness:

```typescript
public isIndexedDBReady(): boolean {
  return this.gates.idbReady;
}
```

## Phase 6B: Server - WebSocket + Redis + PostgreSQL

### 6B.0: Install Dependencies and Create Structure

#### 6B.0.1: Install Server Dependencies

```bash
cd server
npm install redis @prisma/client zod ulid ws @y/websocket-server
npm install -D prisma
```

#### 6B.0.2: Create Server Directory Structure

```bash
# Create necessary directories
mkdir -p server/src/{config,lib,routes,middleware}
mkdir -p server/prisma
```

### 6B.1: Server Foundation

#### 6B.1.1: Update Express Server

**File**: `server/src/index.ts`

```typescript
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer } from 'http';
import { setupWebSocketServer } from './websocket-server.js';
import { validateServerEnv } from './config/env.js';
import { setupMiddleware } from './middleware/index.js';
import { roomRoutes } from './routes/rooms.js';
import { healthRoutes } from './routes/health.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Validate environment on startup
const env = validateServerEnv();

const app = express();
const httpServer = createServer(app);

// Setup middleware
setupMiddleware(app, env);

// API routes
app.use('/api/rooms', roomRoutes);
app.use('/api', healthRoutes);

// Serve static files in production
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(__dirname, '../public')));

  // SPA fallback
  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '../public/index.html'));
  });
}

// Setup WebSocket server
setupWebSocketServer(httpServer, env);

// Start server
httpServer.listen(env.PORT, () => {
  console.log(`Server running on port ${env.PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});
```

### 6B.2: Zod-Validated Environment

**File**: `server/src/config/env.ts` **(NEW FILE - Create this file)**

```typescript
import { z } from 'zod';

const ServerEnvSchema = z.object({
  PORT: z.coerce.number().default(3001),
  ORIGIN_ALLOWLIST: z
    .string()
    .transform((s) => s.split(',').map((o) => o.trim()))
    .default('http://localhost:5173,http://localhost:3000'),
  REDIS_URL: z.string().min(1, 'Redis URL is required'),
  DATABASE_URL: z.string().min(1, 'Database URL is required'),
  ROOM_TTL_DAYS: z.coerce.number().min(1).max(90).default(14),
  WS_MAX_FRAME_BYTES: z.coerce.number().default(2_000_000),
  MAX_CLIENTS_PER_ROOM: z.coerce.number().default(105),
  GZIP_LEVEL: z.coerce.number().min(1).max(9).default(4),
});

export type ServerEnv = z.infer<typeof ServerEnvSchema>;

export function validateServerEnv(): ServerEnv {
  try {
    return ServerEnvSchema.parse(process.env);
  } catch (error) {
    if (error instanceof z.ZodError) {
      console.error('Environment validation failed:');
      error.errors.forEach((err) => {
        console.error(`  ${err.path.join('.')}: ${err.message}`);
      });
      process.exit(1);
    }
    throw error;
  }
}
```

### 6B.3: Redis Binding

**File**: `server/src/lib/redis.ts` **(NEW FILE - Create this file)**

```typescript
import { createClient } from 'redis';
import { ServerEnv } from '../config/env.js';
import { gzip, gunzip } from 'node:zlib';
import { promisify } from 'node:util';

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

export class RedisAdapter {
  private client: ReturnType<typeof createClient>;
  private env: ServerEnv;

  constructor(env: ServerEnv) {
    this.env = env;
    this.client = createClient({
      url: env.REDIS_URL,
      socket: {
        reconnectStrategy: (retries) => {
          if (retries > 10) return new Error('Max reconnection attempts reached');
          return Math.min(retries * 100, 3000);
        },
      },
    });

    this.client.on('error', (err) => {
      console.error('[Redis] Client error:', err);
    });

    this.client.on('connect', () => {
      console.log('[Redis] Connected successfully');
    });
  }

  async connect(): Promise<void> {
    await this.client.connect();
  }

  async disconnect(): Promise<void> {
    await this.client.disconnect();
  }

  async saveRoom(roomId: string, docState: Uint8Array): Promise<number> {
    // Compress the document
    const compressed = await gzipAsync(docState, { level: this.env.GZIP_LEVEL });

    // Save with TTL
    const ttlSeconds = this.env.ROOM_TTL_DAYS * 24 * 60 * 60;
    const key = `room:${roomId}`;

    await this.client.setEx(key, ttlSeconds, compressed);

    return compressed.length; // Return compressed size
  }

  async loadRoom(roomId: string): Promise<Uint8Array | null> {
    const key = `room:${roomId}`;
    const compressed = await this.client.getBuffer(key);

    if (!compressed) return null;

    // Decompress
    const decompressed = await gunzipAsync(compressed);
    return new Uint8Array(decompressed);
  }

  async extendTTL(roomId: string): Promise<boolean> {
    const key = `room:${roomId}`;
    const ttlSeconds = this.env.ROOM_TTL_DAYS * 24 * 60 * 60;
    return await this.client.expire(key, ttlSeconds);
  }

  async exists(roomId: string): Promise<boolean> {
    const key = `room:${roomId}`;
    return (await this.client.exists(key)) === 1;
  }

  async ping(): Promise<boolean> {
    try {
      await this.client.ping();
      return true;
    } catch {
      return false;
    }
  }
}

// Singleton instance
let redisAdapter: RedisAdapter | null = null;

export async function getRedisAdapter(env: ServerEnv): Promise<RedisAdapter> {
  if (!redisAdapter) {
    redisAdapter = new RedisAdapter(env);
    await redisAdapter.connect();
  }
  return redisAdapter;
}
```

### 6B.4: Prisma/PostgreSQL Setup

**File**: `server/prisma/schema.prisma` **(NEW FILE - Create this file)**

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model RoomMetadata {
  id          String   @id // Room ID (ULID)
  title       String   @default("")
  createdAt   DateTime @default(now())
  lastWriteAt DateTime @default(now())
  sizeBytes   Int      @default(0)

  @@index([lastWriteAt(sort: Desc)])
}
```

**File**: `server/src/lib/prisma.ts` **(NEW FILE - Create this file)**

```typescript
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient({
  log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
});

export { prisma };

// Graceful shutdown
process.on('beforeExit', async () => {
  await prisma.$disconnect();
});
```

### 6B.5: Y-WebSocket Server Integration

**WebSocket URL Flow Summary**:

1. Client creates provider: `new WebsocketProvider('/ws', 'room123', ydoc)`
2. y-websocket constructs URL: `ws://host/ws/room123`
3. Server receives connection to `/ws/room123`
4. Server extracts room ID: `room123`
5. Server validates path and handles the connection

**File**: `server/src/websocket-server.ts` **(NEW FILE - Create this file)**

**IMPORTANT API Notes**:

1. **y-websocket URL Contract**: The client y-websocket provider expects `new WebsocketProvider(baseUrl, roomId, ydoc)` where it will automatically append `/<roomId>` to the baseUrl. Never pass a full URL with room ID already included.
2. **Server API (v0.1.x)**: Import from `@y/websocket-server/utils` and use:
   - `setupWSConnection(ws, req, { docName })` - handles the Yjs sync protocol
   - `getYDoc(roomId)` - single argument, returns singleton doc for the room
3. **Persistence Strategy**: The server persists on ALL document updates with debouncing (100ms). Alternative: Use global `setPersistence({ bindState, writeState })` to avoid per-connection handlers. 
Client-side publish cadence (RAF snapshots) is a UI concern and does not affect server persistence, which listens to Y.Doc updates only.

**CRITICAL WebSocket Path Handling**:

- The WebSocketServer must NOT have a `path` option set, as it would restrict connections to exactly that path
- Since we need to accept `/ws/<roomId>` patterns, we handle path validation in the connection handler
- The server expects paths like `/ws/abc123` where `abc123` is the room ID
- The y-websocket client will construct this by combining baseUrl (`/ws`) with roomId (`abc123`)

```typescript
import { WebSocketServer } from 'ws';
import { Server as HTTPServer } from 'http';
import { setupWSConnection, getYDoc } from '@y/websocket-server/utils';
import * as Y from 'yjs';
import { ServerEnv } from './config/env.js';
import { getRedisAdapter } from './lib/redis.js';
import { prisma } from './lib/prisma.js';

// Track room connections (docs are managed by @y/websocket-server internally)
const roomConnections = new Map<string, Set<any>>();

export function setupWebSocketServer(server: HTTPServer, env: ServerEnv) {
  const wss = new WebSocketServer({
    server,
    // No path restriction - accept all WebSocket connections and validate path in handler
    maxPayload: env.WS_MAX_FRAME_BYTES,
  });

  wss.on('connection', async (ws, req) => {
    // Extract room ID from URL path: /ws/<roomId>
    const url = new URL(req.url!, `http://${req.headers.host}`);
    const pathMatch = url.pathname.match(/^\/ws\/(.+)$/);

    if (!pathMatch) {
      ws.close(1008, 'Invalid room path - expected /ws/<roomId>');
      return;
    }

    const roomId = pathMatch[1];

    // Origin check
    const origin = req.headers.origin;
    if (origin && !env.ORIGIN_ALLOWLIST.includes(origin)) {
      ws.close(1008, 'Origin not allowed');
      return;
    }

    // Capacity check
    const connections = roomConnections.get(roomId) || new Set();
    if (connections.size >= env.MAX_CLIENTS_PER_ROOM) {
      // Send capacity message before closing
      ws.send(
        JSON.stringify({
          type: 'room_full',
          readOnly: true,
          message: 'Room at capacity',
        }),
      );
      ws.close(1008, 'Room at capacity');
      return;
    }

    // Track connection
    connections.add(ws);
    roomConnections.set(roomId, connections);

    // Get Y.Doc managed by websocket-server (will be created if doesn't exist)
    // The getYDoc function returns the singleton doc for this roomId
    const doc = getYDoc(roomId); // Single argument in v0.1.x

    // Load from Redis if this is the first connection to the room
    if (connections.size === 1) {
      const redis = await getRedisAdapter(env);
      const savedState = await redis.loadRoom(roomId);
      if (savedState) {
        Y.applyUpdate(doc, savedState);
      }
    }

    // Setup y-websocket server for this connection (v0.1.x API)
    setupWSConnection(ws, req, { docName: roomId });

    // Set up persistence with debouncing
    let persistTimeout: NodeJS.Timeout | null = null;
    const persistRoom = async () => {
      try {
        const redis = await getRedisAdapter(env);
        const fullState = Y.encodeStateAsUpdate(doc!);
        const sizeBytes = await redis.saveRoom(roomId, fullState);

        // Update metadata
        await prisma.roomMetadata.upsert({
          where: { id: roomId },
          create: {
            id: roomId,
            title: '',
            sizeBytes,
            lastWriteAt: new Date(),
          },
          update: {
            sizeBytes,
            lastWriteAt: new Date(),
          },
        });
      } catch (err) {
        console.error(`[WebSocket] Failed to persist room ${roomId}:`, err);
      }
    };

    // Listen for ALL updates to persist (not just from specific origin)
    // Only set up persistence handler if this is the first connection
    // Alternative: Use global setPersistence({ bindState, writeState }) to avoid per-connection handlers
    let updateHandler: ((update: Uint8Array, origin: any) => void) | null = null;

    if (connections.size === 1) {
      updateHandler = async (update: Uint8Array, origin: any) => {
        // Debounce persistence to avoid excessive writes
        // Clear existing timeout
        if (persistTimeout) {
          clearTimeout(persistTimeout);
        }

        // Set new timeout for persistence (100ms debounce)
        persistTimeout = setTimeout(persistRoom, 100);
      };

      doc.on('update', updateHandler);
    }

    // Cleanup on disconnect
    ws.on('close', () => {
      connections.delete(ws);
      if (connections.size === 0) {
        // Last client left, cleanup room
        roomConnections.delete(roomId);

        // Remove update handler if we set one
        if (updateHandler) {
          doc.off('update', updateHandler);
        }

        // Clear any pending persistence
        if (persistTimeout) {
          clearTimeout(persistTimeout);
          // Do final persist before cleanup
          persistRoom();
        }

        // Note: The Y.Doc cleanup is handled by @y/websocket-server internally
        // It has its own garbage collection after all connections close
      }
    });
  });

  console.log('[WebSocket] Server initialized');
}
```

### 6B.6: HTTP API Routes

**File**: `server/src/routes/rooms.ts` **(NEW FILE - Create this file)**

```typescript
import { Router } from 'express';
import { z } from 'zod';
import { ulid } from 'ulid';
import { prisma } from '../lib/prisma.js';
import { getRedisAdapter } from '../lib/redis.js';

const router = Router();

// Schemas
const CreateRoomSchema = z.object({
  title: z.string().max(120).optional(),
});

const RenameRoomSchema = z.object({
  title: z.string().max(120),
});

// POST /api/rooms - Create new room
router.post('/', async (req, res) => {
  try {
    const body = CreateRoomSchema.parse(req.body);
    const roomId = ulid();

    const room = await prisma.roomMetadata.create({
      data: {
        id: roomId,
        title: body.title || '',
      },
    });

    res.json({
      id: room.id,
      title: room.title,
      createdAt: room.createdAt.toISOString(),
      lastWriteAt: room.lastWriteAt.toISOString(),
      sizeBytes: 0,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Invalid request', details: error.errors });
    }
    console.error('[API] Create room error:', error);
    res.status(500).json({ error: 'Failed to create room' });
  }
});

// GET /api/rooms/:id/metadata - Get room metadata
router.get('/:id/metadata', async (req, res) => {
  try {
    const { id } = req.params;

    // Check if room exists in Redis (authoritative)
    const redis = await getRedisAdapter(req.app.locals.env);
    const exists = await redis.exists(id);

    if (!exists) {
      return res.status(404).json({ error: 'Room not found or expired' });
    }

    // Get metadata from Postgres
    let metadata = await prisma.roomMetadata.findUnique({
      where: { id },
    });

    // Create minimal metadata if missing
    if (!metadata) {
      metadata = await prisma.roomMetadata.create({
        data: {
          id,
          title: '',
        },
      });
    }

    // Calculate expiry
    const ttlDays = req.app.locals.env.ROOM_TTL_DAYS;
    const expiresAt = new Date(metadata.lastWriteAt);
    expiresAt.setDate(expiresAt.getDate() + ttlDays);

    res.json({
      id: metadata.id,
      title: metadata.title,
      createdAt: metadata.createdAt.toISOString(),
      lastWriteAt: metadata.lastWriteAt.toISOString(),
      sizeBytes: metadata.sizeBytes,
      expiresAt: expiresAt.toISOString(),
    });
  } catch (error) {
    console.error('[API] Get metadata error:', error);
    res.status(500).json({ error: 'Failed to get room metadata' });
  }
});

// PUT /api/rooms/:id/rename - Rename room
router.put('/:id/rename', async (req, res) => {
  try {
    const { id } = req.params;
    const body = RenameRoomSchema.parse(req.body);

    const room = await prisma.roomMetadata.update({
      where: { id },
      data: { title: body.title },
    });

    res.json({ title: room.title });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Invalid request', details: error.errors });
    }
    console.error('[API] Rename room error:', error);
    res.status(500).json({ error: 'Failed to rename room' });
  }
});

export { router as roomRoutes };
```

**File**: `server/src/routes/health.ts` **(NEW FILE - Create this file)**

```typescript
import { Router } from 'express';
import { getRedisAdapter } from '../lib/redis.js';
import { prisma } from '../lib/prisma.js';

const router = Router();

router.get('/healthz', async (req, res) => {
  const health = {
    status: 'ok',
    phase: 6,
    services: {
      redis: false,
      postgres: false,
    },
  };

  try {
    // Check Redis
    const redis = await getRedisAdapter(req.app.locals.env);
    health.services.redis = await redis.ping();

    // Check Postgres
    await prisma.$queryRaw`SELECT 1`;
    health.services.postgres = true;
  } catch (error) {
    console.error('[Health] Check failed:', error);
  }

  const httpStatus = health.services.redis && health.services.postgres ? 200 : 503;
  res.status(httpStatus).json(health);
});

export { router as healthRoutes };
```

### 6B.7: Middleware Setup

**File**: `server/src/middleware/index.ts` **(NEW FILE - Create this file)**

```typescript
import express, { Application } from 'express';
import cors from 'cors';
import { ServerEnv } from '../config/env.js';

export function setupMiddleware(app: Application, env: ServerEnv) {
  // Store env in app locals for route access
  app.locals.env = env;

  // CORS with origin allowlist
  app.use(
    cors({
      origin: (origin, callback) => {
        // Allow requests with no origin (mobile apps, Postman, etc)
        if (!origin) return callback(null, true);

        if (env.ORIGIN_ALLOWLIST.includes(origin)) {
          callback(null, true);
        } else {
          callback(new Error('Not allowed by CORS'));
        }
      },
      credentials: true,
    }),
  );

  // Body parsing with size limits
  app.use(express.json({ limit: '1mb' }));

  // Security headers
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Referrer-Policy', 'no-referrer');

    // HSTS (only in production with HTTPS)
    if (process.env.NODE_ENV === 'production' && req.secure) {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }

    next();
  });

  // Request logging in development
  if (process.env.NODE_ENV === 'development') {
    app.use((req, res, next) => {
      console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
      next();
    });
  }
}
```

## Phase 6C: Client - WebSocket Provider & Metadata

### 6C.1: Attach y-websocket Provider

#### 6C.1.1: Provider Construction

**File**: `client/src/lib/room-doc-manager.ts`

1. **Import WebSocket provider and config**:

```typescript
import { WebsocketProvider } from 'y-websocket';
import { clientConfig } from './config-schema';
```

2. **Update provider type**:

```typescript
// Line 90: Change from
private websocketProvider: unknown = null;
// To
private websocketProvider: WebsocketProvider | null = null;
```

3. **Add WebSocket initialization** (in constructor, after IDB init):

**Note**: publisher cadence is independent of WS state; WS only feeds Y.Doc updates which mark the manager dirty.

```typescript
// Initialize WebSocket provider (Phase 6C)
this.initializeWebSocketProvider();
```

4. **Implement WebSocket provider method**:

```typescript
private initializeWebSocketProvider(): void {
  try {
    // Get config (validated) - typically '/ws'
    const wsBase = clientConfig.VITE_WS_BASE;

    // Convert to WebSocket URL base (without room ID)
    const wsUrl = this.buildWebSocketUrl(wsBase);

    // Create WebSocket provider with standard signature
    // y-websocket will append /<roomId> to the base URL automatically
    // Result: ws://host/ws/<roomId>
    this.websocketProvider = new WebsocketProvider(
      wsUrl,
      this.roomId, // Pass room ID separately (standard y-websocket contract)
      this.ydoc,
      {
        // Disable awareness for now (Phase 7)
        awareness: undefined,
        // Reconnect settings
        maxBackoffTime: 10000,
        resyncInterval: 5000,
      }
    );

    // Set up G_WS_CONNECTED gate with 5s timeout
    const wsConnectedTimeout = setTimeout(() => {
      if (!this.gates.wsConnected && this.gates.idbReady) {
        // Proceed offline if IDB ready
        console.debug('[RoomDocManager] WS connection timeout, proceeding offline');
      }
    }, 5000);
    this.gateTimeouts.set('wsConnected', wsConnectedTimeout);

    // Set up G_WS_SYNCED gate with 10s timeout
    const wsSyncedTimeout = setTimeout(() => {
      if (!this.gates.wsSynced) {
        // Keep rendering from IDB, continue trying to sync
        console.debug('[RoomDocManager] WS sync timeout, continuing with local state');
      }
    }, 10000);
    this.gateTimeouts.set('wsSynced', wsSyncedTimeout);

    // Set up connection gates
    this.websocketProvider.on('status', (event: { status: string }) => {
      if (event.status === 'connected') {
        // Clear connection timeout
        const timeout = this.gateTimeouts.get('wsConnected');
        if (timeout) {
          clearTimeout(timeout);
          this.gateTimeouts.delete('wsConnected');
        }
        this.openGate('wsConnected');
        console.debug('[RoomDocManager] WebSocket connected');
      } else if (event.status === 'disconnected') {
        this.gates.wsConnected = false;
        this.gates.wsSynced = false;
        console.debug('[RoomDocManager] WebSocket disconnected');
      }
    });

    // Listen for sync status (v3 uses 'sync' event, not 'synced')
    this.websocketProvider.on('sync', (isSynced: boolean) => {
      if (isSynced) {
        // Clear sync timeout
        const timeout = this.gateTimeouts.get('wsSynced');
        if (timeout) {
          clearTimeout(timeout);
          this.gateTimeouts.delete('wsSynced');
        }
        this.openGate('wsSynced');
        console.debug('[RoomDocManager] WebSocket synced');
      } else {
        this.gates.wsSynced = false;
      }
    });

    // Note: Document updates are already handled by the existing Y.Doc update observer
    // The y-websocket provider triggers Y.Doc updates which are handled by setupObservers()
    // No need for additional provider-specific update listeners

  } catch (err) {
    console.error('[RoomDocManager] WebSocket initialization failed:', err);
    // Keep offline mode functional
  }
}

private buildWebSocketUrl(basePath: string): string {
  // Handle both relative and absolute URLs
  if (basePath.startsWith('ws://') || basePath.startsWith('wss://')) {
    return basePath;
  }

  // Build from current location
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const host = window.location.host;

  // Ensure path starts with /
  const cleanPath = basePath.startsWith('/') ? basePath : `/${basePath}`;

  // Return base WebSocket URL (y-websocket will append room ID)
  return `${protocol}//${host}${cleanPath}`;
}
```

#### 6C.1.2: Update Teardown for WebSocket

Update destroy method to include proper WebSocket cleanup:

```typescript
// In destroy() method, after IDB cleanup:
if (this.websocketProvider) {
  // Proper cleanup: disconnect first, then destroy
  this.websocketProvider.disconnect();
  this.websocketProvider.destroy();
  this.websocketProvider = null;
}
```

### 6C.2: Room Stats & Metadata (TanStack Query)

#### 6C.2.1: Create API Client

**File**: `client/src/lib/api-client.ts` **(NEW FILE - Create this file)**

```typescript
import { z } from 'zod';
import { clientConfig } from './config-schema';

// Response schemas
export const RoomMetadataSchema = z.object({
  id: z.string(),
  title: z.string(),
  createdAt: z.string(),
  lastWriteAt: z.string(),
  sizeBytes: z.number(),
  expiresAt: z.string(),
});

export type RoomMetadata = z.infer<typeof RoomMetadataSchema>;

// API client
class ApiClient {
  private baseUrl: string;

  constructor() {
    this.baseUrl = clientConfig.VITE_API_BASE;
  }

  private async fetchJson<T>(
    path: string,
    options?: RequestInit,
    schema?: z.ZodSchema<T>,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const response = await fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...options?.headers,
      },
    });

    if (!response.ok) {
      if (response.status === 404) {
        throw new Error('Room not found or expired');
      }
      throw new Error(`API error: ${response.status}`);
    }

    const data = await response.json();

    if (schema) {
      return schema.parse(data);
    }

    return data as T;
  }

  async getRoomMetadata(roomId: string): Promise<RoomMetadata> {
    return this.fetchJson(`/rooms/${roomId}/metadata`, undefined, RoomMetadataSchema);
  }

  async createRoom(title?: string): Promise<RoomMetadata> {
    return this.fetchJson(
      '/rooms',
      {
        method: 'POST',
        body: JSON.stringify({ title }),
      },
      RoomMetadataSchema,
    );
  }

  async renameRoom(roomId: string, title: string): Promise<{ title: string }> {
    return this.fetchJson(`/rooms/${roomId}/rename`, {
      method: 'PUT',
      body: JSON.stringify({ title }),
    });
  }
}

export const apiClient = new ApiClient();
```

#### 6C.2.2: Create Query Hooks

**File**: `client/src/hooks/use-room-metadata.ts` **(NEW FILE - Create this file)**

```typescript
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient, RoomMetadata } from '../lib/api-client';
import { useEffect } from 'react';
import { useRoomDoc } from './use-room-doc';
import { ROOM_CONFIG, type RoomStats } from '@avlo/shared';

export function useRoomMetadata(roomId: string) {
  const room = useRoomDoc(roomId);

  const query = useQuery({
    queryKey: ['rooms', 'metadata', roomId],
    queryFn: () => apiClient.getRoomMetadata(roomId),
    staleTime: 10_000, // 10 seconds
    retry: 1,
    refetchOnWindowFocus: false,
    refetchInterval: 10_000, // Poll every 10s
  });

  // Update room stats when metadata changes
  useEffect(() => {
    if (query.data) {
      // Use public API to set room stats
      room.setRoomStats({
        bytes: query.data.sizeBytes,
        cap: ROOM_CONFIG.ROOM_SIZE_READONLY_BYTES,
        expiresAt: new Date(query.data.expiresAt).getTime(),
      });
    } else if (query.error?.message?.includes('not found')) {
      // Room expired
      room.setRoomStats(null);
    }
  }, [query.data, query.error, room]);

  return query;
}

export function useRenameRoom(roomId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (title: string) => apiClient.renameRoom(roomId, title),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['rooms', 'metadata', roomId] });
    },
  });
}
```

#### 6C.2.3: Update RoomDocManager for Stats

**File**: `client/src/lib/room-doc-manager.ts`

Add room stats support with both internal and public methods:

```typescript
// Add to imports at top of file:
import { ROOM_CONFIG, type RoomStats } from '@avlo/shared';

// Add to the RoomDocManager interface (public API)
export interface RoomDocManager {
  // ... existing methods ...

  /**
   * Update room stats from external sources (e.g., metadata polling)
   * This is used by TanStack Query hooks to update stats from HTTP metadata
   */
  setRoomStats(stats: RoomStats | null): void;
}

// Add these methods to RoomDocManagerImpl class

// Private method for internal updates
private updateRoomStats(stats: RoomStats | null): void {
  this.roomStats = stats;

  // Notify subscribers
  this.statsSubscribers.forEach(cb => cb(stats));

  // Update read-only state if needed
  if (stats && stats.bytes >= ROOM_CONFIG.ROOM_SIZE_READONLY_BYTES) {
    // Room is read-only due to size
    console.warn('[RoomDocManager] Room is read-only due to size limit');
  }
}

// Public method for external updates (e.g., from TanStack Query)
public setRoomStats(stats: RoomStats | null): void {
  if (this.destroyed) return;
  this.updateRoomStats(stats);
}
```

### 6C.3: Create/Join Flow

#### 6C.3.1: Setup Query Client

**File**: `client/src/main.tsx`

```typescript
import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RoomDocRegistryProvider } from './lib/room-doc-registry-context';
import App from './App';
import './index.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 10_000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <RoomDocRegistryProvider>
        <App />
      </RoomDocRegistryProvider>
    </QueryClientProvider>
  </React.StrictMode>
);
```

### 6C.4: Connection Status UI

**File**: `client/src/components/ConnectionStatus.tsx` **(NEW FILE - Create this file)**

```typescript
import React from 'react';
import { useRoomDoc } from '../hooks/use-room-doc';
import { useRoomStats } from '../hooks/use-room-stats';
import { ROOM_CONFIG } from '@avlo/shared';

interface ConnectionStatusProps {
  roomId: string;
}

export function ConnectionStatus({ roomId }: ConnectionStatusProps) {
  const room = useRoomDoc(roomId);
  const gates = room.getGateStatus();
  const stats = useRoomStats(roomId);

  let status = 'Offline';
  let className = 'text-gray-500';

  if (gates.wsSynced) {
    status = 'Online';
    className = 'text-green-500';
  } else if (gates.wsConnected) {
    status = 'Syncing...';
    className = 'text-yellow-500';
  }

  // Check if room is read-only
  if (stats && stats.bytes >= ROOM_CONFIG.ROOM_SIZE_READONLY_BYTES) {
    status = 'Read-only';
    className = 'text-red-500';
  }

  return (
    <div className={`flex items-center gap-2 text-sm ${className}`}>
      <div className={`w-2 h-2 rounded-full ${className.replace('text', 'bg')}`} />
      <span>{status}</span>
    </div>
  );
}
```

## Implementation Checklist

### Prerequisites

- [ ] Install server dependencies: `cd server && npm install redis @prisma/client zod ulid ws @y/websocket-server && npm install -D prisma`
- [ ] Install client dependencies: `cd client && npm install @tanstack/react-query zod`
- [ ] Create server directory structure: `mkdir -p server/src/{config,lib,routes,middleware} server/prisma`

## Gate Summary (Per OVERVIEW.MD §11.2)

| Gate                | Opens When                             | Unblocks                                           | Timeout | On Timeout                                             |
| :------------------ | :------------------------------------- | :------------------------------------------------- | :------ | :----------------------------------------------------- |
| `G_IDB_READY`       | y-indexeddb loaded or 2 s elapsed      | initial snapshot hydration; "Recent Rooms" badge   | 2 s     | Render `EmptySnapshot`; continue background re-hydrate |
| `G_WS_CONNECTED`    | WS open                                | WS awareness, doc sync                             | 5 s     | proceed offline if IDB ready                           |
| `G_WS_SYNCED`       | first Y sync completes                 | authoritative render (server merged state)         | 10 s    | keep rendering from IDB; continue syncing              |
| `G_AWARENESS_READY` | WS or RTC awareness live (Phase 7)     | Presence cursors/names/pings                       | none    | N/A                                                    |
| `G_FIRST_SNAPSHOT`  | first publish to UI occurs (IDB or WS) | Enables features that require a populated snapshot | 1 rAF   | N/A                                                    |

**Note**: `G_AWARENESS_READY` will be implemented in Phase 7 when awareness is added.

**NOTE** `G_FIRST_SNAPSHOT` Opens on first doc-derived snapshot; independent of any svKey deduplication (none in Phase 6).
## Provider Event Patterns (Critical)

### Correct Event Usage

#### y-indexeddb Provider

- **`whenSynced` Promise**: Use ONLY for gate control (G_IDB_READY)
- **No 'synced' event listener needed**: Document updates from IDB automatically trigger the Y.Doc 'update' event
- **Pattern**:
  ```typescript
  // Gate control only
  provider.whenSynced.then(() => openGate('idbReady'));
  // Document updates handled by Y.Doc 'update' observer
  ```

#### y-websocket Provider (v3)

- **`'status'` event**: Connection state changes ('connected', 'disconnected')
- **`'sync'` event**: Sync state changes for gate control (G_WS_SYNCED) - passes boolean parameter
- **No 'synced' event**: v3 uses 'sync' not 'synced' - using 'synced' will never fire
- **Pattern**:
  ```typescript
  provider.on('status', (e) => {
    /* gate control */
  });
  provider.on('sync', (isSynced: boolean) => {
    /* gate control */
  });
  // Document updates handled by Y.Doc 'update' observer
  ```

#### Y.Doc Updates (Universal)

- **ALL document updates** should be handled via the Y.Doc 'update' event
- **This is already implemented** in `setupObservers()` method
- **Pattern**:
  ```typescript
  ydoc.on('update', () => {
    this.publishState.isDirty = true;
    this.schedulePublish();
  });
  ```

### Key Principle

Provider events are for **connection/sync gates only**. Document content changes always flow through the Y.Doc 'update' event, regardless of which provider triggered them. This ensures a single, consistent update path for all document mutations.

## Critical Integration Points

1. **Y.Doc Singleton**: One Y.Doc per room, shared between all providers
2. **Provider Order**: IDB first, then WS immediately (don't wait)
3. **WebSocket URL Contract**:
   - Client: `new WebsocketProvider(wsBase, roomId, ydoc)` where wsBase is typically `/ws`
   - Server: Accepts all WebSocket connections, validates path matches `/ws/<roomId>` pattern
   - Result: Client connects to `ws://host/ws/roomId`
4. **Gate Independence**: Features degrade gracefully when gates are closed
   - Gates open based on their specific conditions, NOT other gates
   - G_FIRST_SNAPSHOT opens ONLY when first doc-derived snapshot publishes in buildSnapshot()
   - RAF loop runs from creation to ensure timing (≤ 1 rAF after Y update)
5. **Render cache (Phase 6 scope):** Present in repo from Phase 2.4 but **not referenced** by any Phase 6 logic. No boot display, no reads/writes during Phase 6.
6. **Offline-First**: All writes go to IDB first, sync later
7. **Redis Authority**: Redis presence defines room existence, not PostgreSQL
8. **Compression**: Always gzip with level 4 before Redis storage
9. **TTL Extension**: Only on accepted writes, not on reads/awareness
10. **Phase 6 invariant**: The publisher never consults svKey to gate or dedupe. If isDirty or presenceDirty is set, a snapshot is published on the next rAF. svKey is computed in buildSnapshot() for diagnostics and for opening G_FIRST_SNAPSHOT only.

### Critical Integration Notes

#### y-websocket URL Contract (IMPORTANT)

The standard y-websocket provider signature is:

```typescript
new WebsocketProvider(baseUrl, roomId, ydoc, options);
```

- **baseUrl**: The WebSocket server base URL (e.g., `ws://host/ws` or `wss://host/ws`)
- **roomId**: The room identifier passed separately
- **Result**: The provider will connect to `baseUrl/roomId` (e.g., `ws://host/ws/roomId`)

**Never** construct the full URL yourself and pass an empty room name - this breaks the standard contract.

#### Server WebSocket API (v0.1.x)

- The `@y/websocket-server/utils` module exports `setupWSConnection(ws, req, { docName })` to handle the Yjs sync protocol
- Also exports `getYDoc(roomId)` with single argument to get/create singleton doc for a room
- This function manages the complete sync handshake and document update exchange
- Note: The two-arg signature `(ws, doc)` is from older bundled server code and won't work with v0.1.x
