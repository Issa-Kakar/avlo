# AVLO Cloudflare Migration Guide: From Express/Redis to Durable Objects

## Executive Summary

This document provides a comprehensive guide for migrating AVLO from its current Express/Redis/PostgreSQL architecture to a serverless Cloudflare Durable Objects architecture with y-partyserver. This migration will provide horizontal scalability, edge computing benefits, and significant cost reductions while maintaining all current functionality.

## Migration Status (2025-11-06)

**Completed Steps (1-4):**
- ✅ Discovered critical version conflict: @cloudflare/vite-plugin requires Vite ≥6.1
- ✅ Upgraded Vite 5.4.11 → 7.x and Vitest 2.1.8 → 4.x for compatibility
- ✅ Installed dependencies correctly (wrangler+partyserver at root, @cloudflare/vite-plugin in client)
- ✅ Created wrangler.toml, worker.ts, and RoomDurableObject implementation
- ✅ Updated client/vite.config.ts with Cloudflare plugin

**Current State:** Untested - Steps 1-4 complete but need verification of PartyServer integration
**Next Steps:** Continue from Step 5 (Update Client Provider)

**Known Issues/Uncertainties:**
- Vite 7 upgrade may have breaking changes to investigate
- PartyServer integration with existing gate system needs testing
- TypeScript types for y-partyserver may need adjustment
- Development workflow with Cloudflare plugin needs validation

**Migration Scope:**
- Replace Express WebSocket server with Cloudflare Worker + Durable Objects
- Replace Redis persistence with SQLite-backed Durable Objects (one per room)
- Replace y-websocket with y-partyserver (minimal client changes)
- Add R2 for backups and future asset storage
- Maintain existing offline-first IndexedDB behavior

---

## Part 1: Current Architecture Deep Dive

### 1.1 Server Architecture (What We're Removing)

```
Current Stack:
├── Express Server (Port 3001)
│   ├── HTTP API (/api/*)
│   └── WebSocket Server (/ws/<roomId>)
├── Redis (Persistence)
│   ├── Key: room:<roomId>
│   ├── Value: Gzipped Y.Doc state
│   └── TTL: 14 days (refreshed on write)
├── PostgreSQL (Metadata)
│   └── RoomMetadata table (non-authoritative)
└── y-websocket-server
    ├── Singleton Y.Doc per room
    ├── setupWSConnection() for sync
    └── 100ms debounced persistence
```

**Current WebSocket Flow:**
```typescript
// Server: websocket-server.ts
1. Client connects to /ws/<roomId>
2. Origin check + capacity check (105 clients max)
3. getYDoc(roomId) - singleton from @y/websocket-server
4. First client? Load from Redis → Y.applyUpdate()
5. setupWSConnection(ws, req, { docName: roomId })
6. Attach doc.on('update') → debounce 100ms → Redis save
7. On disconnect: final persist, cleanup if last client
```

**Current Client Provider:**
```typescript
// Client: room-doc-manager.ts
this.websocketProvider = new WebsocketProvider(
  wsUrl,           // ws://localhost:3000/ws
  this.roomId,     // Appended: ws://localhost:3000/ws/<roomId>
  this.ydoc,
  { awareness: this.yAwareness }
);
```

### 1.2 Development Setup

**Two-Process Model:**
- **Client:** Vite dev server on port 3000 (proxies /ws and /api to 3001)
- **Server:** Express on port 3001 (handles WebSocket upgrade + API)

**Proxy Configuration (vite.config.ts):**
```typescript
proxy: {
  '/api': 'http://localhost:3001',
  '/ws': { target: 'ws://localhost:3001', ws: true }
}
```

### 1.3 Critical Patterns We Must Preserve

1. **Gate System:** 5 gates controlling initialization flow
2. **WS-Aware Seeding:** Race between WS sync and 350ms timeout
3. **Per-User Undo/Redo:** Transaction origins tracked by userId
4. **Cursor Smoothing:** Keyed by clientId for proper cleanup
5. **Offline-First:** IndexedDB provider loads before WebSocket

---

## Part 2: Target Architecture with Cloudflare

### 2.1 New Stack Overview

```
Target Stack:
├── Cloudflare Worker (Edge)
│   └── Routes /parties/room/* to Durable Object
├── Durable Object (Per Room)
│   ├── SQLite Storage (Private per DO)
│   ├── YServer (y-partyserver)
│   └── R2 Backups (10s throttle)
└── Client
    ├── YProvider (y-partyserver/provider)
    └── Same Y.Doc + IndexedDB setup
```

**Key Differences:**
- **Horizontal Scaling:** Each room = separate DO instance
- **Edge Computing:** Runs closest to users
- **Single Port:** Vite + Worker on same dev server (no proxy)
- **Authoritative Storage:** SQLite in DO (no Redis)

### 2.2 How Durable Objects Work

```typescript
// Each room name maps to exactly one DO instance globally
const id = env.ROOM_DO.idFromName(roomName);  // Deterministic
const stub = env.ROOM_DO.get(id);              // Get or create
return stub.fetch(request);                    // Handle WebSocket
```

**Storage Model:**
- Each DO has **private** SQLite database (`ctx.storage.sql`)
- Survives DO restarts (persistent)
- Accessed via SQL queries (not KV)
- Enabled via `new_sqlite_classes` migration

---

## Part 3: Step-by-Step Migration Guide

### Step 1: Install Dependencies

**CRITICAL: @cloudflare/vite-plugin requires Vite ≥6.1 (we had 5.4.11)**

```bash
# Root directory
npm uninstall express ws @y/websocket-server redis cors dotenv
npm install -D wrangler  # Keep at root for deployment
npm install partyserver y-partyserver  # Server dependencies

# Client workspace - MUST upgrade Vite first
cd client
npm uninstall y-websocket
npm install -D vite@^7.0.0  # Upgrade from 5.4.11
npm install -D @cloudflare/vite-plugin  # Now compatible

# Root - Upgrade Vitest for Vite 7 compatibility
npm install -D vitest@^4.0.0 @vitest/ui@^4.0.0  # Upgrade from 2.1.8
```

### Step 2: Create Wrangler Configuration

**Create `/wrangler.toml`:**
```toml
name = "avlo"
main = "./src/worker.ts"
compatibility_date = "2025-10-01"

# Durable Object binding
[[durable_objects.bindings]]
name = "ROOM_DO"
class_name = "RoomDurableObject"

# Enable SQLite storage for DO
[[migrations]]
tag = "v1"
new_sqlite_classes = ["RoomDurableObject"]

# R2 bucket for backups
[[r2_buckets]]
binding = "R2_BACKUPS"
bucket_name = "avlo-room-backups"

# Development settings
[dev]
port = 3000
```

### Step 3: Create Worker Entry Point

**Create `/src/worker.ts`:**
```typescript
export interface Env {
  ROOM_DO: DurableObjectNamespace;
  R2_BACKUPS: R2Bucket;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);

    // Route PartyServer WebSocket endpoints
    if (url.pathname.startsWith('/parties/room/')) {
      const roomId = decodeURIComponent(
        url.pathname.slice('/parties/room/'.length)
      );
      const id = env.ROOM_DO.idFromName(roomId);
      const stub = env.ROOM_DO.get(id);
      return stub.fetch(request);
    }

    // Everything else is SPA (Vite handles in dev)
    return new Response('Not Found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;

// Export the Durable Object class
export { RoomDurableObject } from './parties/room';
```

### Step 4: Implement Durable Object with YServer

**Create `/src/parties/room.ts`:**
```typescript
import * as Y from 'yjs';
import { YServer } from 'y-partyserver';

// Import Env type from worker (if not already defined there)
import type { Env } from '../worker';

export class RoomDurableObject extends YServer<Env> {
  // Tune persistence frequency
  static callbackOptions = {
    debounceWait: 1200,    // Save after 1.2s of inactivity
    debounceMaxWait: 8000  // Force save after 8s
  };

  // Load state from SQLite on DO boot
  async onLoad(): Promise<Y.Doc | void> {
    // 1. Create tables (storage.sql.exec is synchronous)
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS ydoc_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        state BLOB NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);

    // 2. Cache room ID for use in onAlarm() (where room.id is not available)
    this.ctx.storage.sql.exec(
      `INSERT INTO meta (key, value) VALUES ('room_id', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value;`,
      this.room.id
    );

    // 3. Load existing state with error handling
    let row: { state?: ArrayBuffer } | undefined;
    try {
      row = this.ctx.storage.sql.exec(
        'SELECT state FROM ydoc_state WHERE id = 1;'
      ).one<{ state?: ArrayBuffer }>();
    } catch {
      // .one() throws if zero rows or >1 row - treat as empty
      row = undefined;
    }

    if (row?.state) {
      const doc = new Y.Doc();
      Y.applyUpdate(doc, new Uint8Array(row.state));
      return doc;  // YServer applies this to its internal document
    }

    // 4. Return undefined for empty room (YServer creates new doc)
    return;
  }

  // Save state to SQLite (called by YServer after debounce)
  async onSave(): Promise<void> {
    const now = Date.now();
    const update = Y.encodeStateAsUpdate(this.document);

    // Upsert state vector
    this.ctx.storage.sql.exec(
      `INSERT INTO ydoc_state (id, state, updated_at)
       VALUES (1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         state = excluded.state,
         updated_at = excluded.updated_at;`,
      update,
      now
    );

    // Schedule an alarm for a background R2 snapshot
    await this.ctx.storage.setAlarm(now + 10_000);
  }

  // PartyServer hook for alarms (NOT alarm() - use onAlarm())
  async onAlarm(): Promise<void> {
    // Read cached room ID (room.id is NOT available in onAlarm())
    let roomId = 'unknown';
    try {
      const meta = this.ctx.storage.sql
        .exec(`SELECT value FROM meta WHERE key = 'room_id';`)
        .one<{ value: string }>();
      if (meta?.value) roomId = meta.value;
    } catch {
      // Ignore if meta lookup fails
    }

    // Load state for backup
    let row: { state?: ArrayBuffer } | undefined;
    try {
      row = this.ctx.storage.sql
        .exec('SELECT state FROM ydoc_state WHERE id = 1;')
        .one<{ state?: ArrayBuffer }>();
    } catch {
      row = undefined;
    }

    if (!row?.state) return;

    const state = new Uint8Array(row.state);
    const ts = Date.now();

    // Write versioned snapshot and latest pointer
    await Promise.all([
      this.env.R2_BACKUPS.put(`rooms/${roomId}/snapshots/${ts}.bin`, state),
      this.env.R2_BACKUPS.put(`rooms/${roomId}/latest.bin`, state)
    ]);
  }
}
```

### Step 5: Update Client Provider

**Modify `/client/src/lib/room-doc-manager.ts`:**

```typescript
// Remove old import
// import { WebsocketProvider } from 'y-websocket';

// Add new import
import YProvider from 'y-partyserver/provider';

private initializeWebSocketProvider(): void {
  try {
    // Determine host (defaults to window.location.host)
    const host = import.meta.env.VITE_PARTY_HOST || window.location.host;

    // Create YProvider (replaces WebsocketProvider)
    this.websocketProvider = new YProvider(
      host,
      this.roomId,  // Room name (not appended to URL)
      this.ydoc,
      {
        party: 'room',  // Maps to /parties/room/*
        awareness: this.yAwareness,
        maxBackoffTime: 10_000,
        resyncInterval: 5_000,
      }
    );

    // KEEP ALL EXISTING EVENT WIRING (same events)

    // Status gate
    this._onWebSocketStatus = ({ status }: { status: string }) => {
      if (status === 'connected') {
        const timeout = this.gateTimeouts.get('wsConnected');
        if (timeout) {
          clearTimeout(timeout);
          this.gateTimeouts.delete('wsConnected');
        }
        this.openGate('wsConnected');
      } else if (status === 'disconnected') {
        this.closeGate('wsConnected');
        if (this.yAwareness) {
          try {
            this.yAwareness.setLocalState(null);
          } catch {}
        }
      }
    };
    this.websocketProvider.on('status', this._onWebSocketStatus);

    // Sync gate (same as before)
    const wsSyncedTimeout = setTimeout(() => {
      console.warn('[Gate] wsSynced timeout after 10s');
      this.openGate('wsSynced');
    }, 10_000);
    this.gateTimeouts.set('wsSynced', wsSyncedTimeout);

    this.websocketProvider.on('sync', (isSynced: boolean) => {
      if (isSynced) {
        const timeout = this.gateTimeouts.get('wsSynced');
        if (timeout) {
          clearTimeout(timeout);
          this.gateTimeouts.delete('wsSynced');
        }
        this.openGate('wsSynced');
        this.logContainerIdentities('AFTER_WS_SYNC');
      } else {
        this.closeGate('wsSynced');
      }
    });

    // Awareness (unchanged)
    if (this.yAwareness && this._onAwarenessUpdate) {
      this.yAwareness.on('update', this._onAwarenessUpdate);
    }

    // Connection timeout (unchanged)
    const wsConnectedTimeout = setTimeout(() => {
      console.warn('[Gate] wsConnected timeout after 5s');
      this.openGate('wsConnected');
    }, 5_000);
    this.gateTimeouts.set('wsConnected', wsConnectedTimeout);

  } catch (err) {
    console.error('[RoomDocManager] YProvider init failed:', err);
  }
}

// DELETE the buildWebSocketUrl method (no longer needed)
```

### Step 6: Update Vite Configuration

**Modify `/client/vite.config.ts`:**
```typescript
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import cloudflare from '@cloudflare/vite-plugin';  // Note: default import
import path from 'path';

export default defineConfig({
  plugins: [
    react(),
    cloudflare({
      configPath: '../wrangler.toml',  // Point to root wrangler.toml
      persistTo: '../.wrangler/state/v3',  // Persist DO state locally
    })
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@avlo/shared': path.resolve(__dirname, '../packages/shared/src')
    }
  },
  server: {
    port: 3000
    // DELETE all proxy config (Cloudflare plugin handles)
  },
  build: {
    outDir: 'dist',  // Changed from '../server/public'
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks: {
          monaco: ['monaco-editor'],
          yjs: ['yjs', 'y-indexeddb', 'y-webrtc']  // Removed 'y-websocket'
        }
      }
    }
  }
});
```

### Step 7: Update Environment Variables

**Update `/client/.env.local`:**
```env
# Remove these
# VITE_WS_BASE=/ws
# VITE_WS_URL=

# Add these (optional)
VITE_PARTY_HOST=localhost:3000  # Optional, defaults to window.location.host
```

### Step 8: Clean Up Old Server Code

**Delete these files:**
```bash
# Remove entire server directory (after backing up if needed)
rm -rf server/

# Or selectively remove:
rm server/src/websocket-server.ts
rm server/src/lib/redis.ts
rm server/src/lib/prisma.ts
rm -rf server/prisma/
```

**Update root package.json scripts:**
```json
{
  "scripts": {
    "dev": "npm run dev -w client",
    "build": "npm run build -w client",
    "deploy": "wrangler deploy",
    "typecheck": "npm run typecheck -w client && npm run typecheck -w packages/shared"
  }
}
```

---

## Part 4: Testing & Verification

### 4.1 Local Development Testing

```bash
# Start development server (Vite + Worker on same port)
npm run dev

# Navigate to http://localhost:3000/room/test-room
# Open multiple tabs to test sync
```

**Verify:**
1. ✅ WebSocket connects to `/parties/room/<roomId>`
2. ✅ All 5 gates open correctly
3. ✅ Drawing syncs between tabs
4. ✅ IndexedDB persistence works offline
5. ✅ Per-user undo/redo works
6. ✅ Cursors track properly (keyed by clientId)

### 4.2 SQLite Verification

```bash
# Check DO SQLite locally
wrangler tail  # Stream DO logs

# In DO class, add debug logging:
console.log('[DO] Loading state, found:', row?.state ? 'existing' : 'empty');
console.log('[DO] Saving state, size:', update.byteLength);
```

### 4.3 R2 Backup Verification

```bash
# List R2 contents
wrangler r2 object list avlo-room-backups

# Download latest backup
wrangler r2 object get avlo-room-backups/rooms/<roomId>/latest.bin
```

### 4.4 Production Deployment

```bash
# Deploy to Cloudflare
wrangler deploy

# Monitor metrics
wrangler tail --format pretty

# Check DO analytics in Cloudflare dashboard
```

---

## Part 5: Migration Checklist

### Pre-Migration
- [ ] Backup current Redis data
- [ ] Note active room IDs
- [ ] Test on staging environment
- [ ] Review Cloudflare pricing/limits

### Implementation
- [ ] Install new dependencies
- [ ] Create wrangler.toml
- [ ] Implement worker.ts
- [ ] Implement RoomDurableObject
- [ ] Update RoomDocManager provider
- [ ] Update vite.config.ts
- [ ] Remove old server code

### Testing
- [ ] Local dev server works
- [ ] Multiple tabs sync
- [ ] Offline → online works
- [ ] Undo/redo per user
- [ ] Cursors smooth properly
- [ ] R2 backups created
- [ ] No console errors

### Post-Migration
- [ ] Deploy to production
- [ ] Monitor DO metrics
- [ ] Verify R2 backups
- [ ] Update documentation
- [ ] Remove old dependencies

---

## Part 6: Troubleshooting

### Common Issues

**1. "Room not found" errors:**
- Ensure party name matches: client uses 'room', DO exports same
- Check URL path: should be `/parties/room/<roomId>`

**2. Gates not opening:**
- YProvider emits same events as y-websocket
- Check browser console for WebSocket errors
- Verify Cloudflare plugin is active

**3. SQLite errors:**
- Ensure `new_sqlite_classes` in wrangler.toml
- Check DO class name matches exactly
- Verify migration tag incremented if changed

**4. Development hot reload:**
- Cloudflare plugin supports HMR
- Worker changes require page refresh
- DO class changes require `wrangler dev --local` restart

### Debug Commands

```bash
# Stream DO logs
wrangler tail --format pretty

# Check DO storage
wrangler dev --local --persist  # SQLite persists locally

# Test R2 locally
wrangler r2 object list avlo-room-backups --local

# Deploy to preview
wrangler deploy --env preview
```

---

## Part 7: Benefits After Migration

### Performance
- **Latency:** Edge computing (closest region to user)
- **Scalability:** Each room = independent DO
- **Reliability:** No single Redis bottleneck

### Cost
- **Pay-per-use:** Only active rooms incur cost
- **No idle servers:** Serverless model
- **Storage:** SQLite included, R2 very cheap

### Developer Experience
- **Single port:** No proxy complexity
- **Integrated dev:** Worker runs in Vite
- **Type safety:** Full TypeScript support

### Operations
- **No infrastructure:** Cloudflare manages servers
- **Auto-scaling:** Handles load automatically
- **Global deployment:** Single `wrangler deploy`

---

## Appendix A: Key Architecture Decisions

### Why SQLite in DO (not D1)?
- **Locality:** Data lives with compute
- **Consistency:** Single-writer guarantee
- **Performance:** No network round-trips
- **Simplicity:** Direct SQL access

### Why y-partyserver?
- **Official:** Cloudflare maintains it
- **Compatible:** Drop-in replacement for y-websocket
- **Optimized:** Built for Durable Objects

### Why keep IndexedDB?
- **Offline-first:** Works without network
- **Performance:** Instant local loads
- **Reliability:** Fallback if DO unavailable

### Why 10-second R2 backups?
- **Recovery:** Off-platform backup
- **Compliance:** Data retention options
- **Future:** Basis for time-travel features

---

## Conclusion

This migration transforms AVLO from a traditional server architecture to a modern edge-first platform. The client changes are minimal (just swapping providers), while the backend gains massive scalability and cost benefits. The careful preservation of existing patterns (gates, undo/redo, cursor smoothing) ensures a smooth transition with no user-facing disruptions.

**Estimated Migration Time:** 2-3 days for implementation, 1-2 days for thorough testing.

**Next Step:** Begin with Step 1 (dependency installation) and proceed sequentially through the guide.