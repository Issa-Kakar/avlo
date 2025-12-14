# AVLO Cloudflare Migration: From Express/Redis to Durable Objects and R2

## Executive Summary

This document provides a comprehensive guide for migrating AVLO from its current Express/Redis/PostgreSQL architecture to a serverless Cloudflare Durable Objects architecture with y-partyserver. This migration will provide horizontal scalability, edge computing benefits, and significant cost reductions while maintaining all current functionality.

**Migration Scope:**
- Replace Express WebSocket server with Cloudflare Worker + Durable Objects
- Replace Redis persistence with R2 buckets for persistence, plus allowing future assets storage
- Horizontally Scaled Architecture with a new server for every Durable Object (one per room)
- Replace y-websocket with y-partyserver (minimal client changes)
- Replace StateVector encoding from V1 to V2
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

### Patterns We Must Preserve

1. **Gate System:** 5 gates controlling initialization flow
2. **WS-Aware Seeding:** Race between WS sync and 350ms timeout
3. **Per-User Undo/Redo:** Transaction origins tracked by userId
4. **Cursor Smoothing:** Keyed by clientId for proper cleanup
5. **Offline-First:** IndexedDB provider loads before WebSocket

---
### New Stack Overview

```
Target Stack:
├── Cloudflare Worker (Edge)
│   └── Routes /parties/rooms/* to Durable Object
├── Durable Object (Per Room)
│   ├── SQLite Storage (not actively using due to 2MB limits. However by deafult its reccomended to specify this. We can use it in the future)
│   ├── YServer (y-partyserver)
│   └── R2 Bucket (authoritative persistence)
└── Client
    ├── YProvider (y-partyserver/provider)
    └── Same Y.Doc + IndexedDB setup
```

**Key Differences:**
- **Horizontal Scaling:** Each room = separate DO instance
- **Edge Computing:** Runs closest to users
- **Authoritative Storage:** R2 bucket in DO (no Redis)

---

### Wrangler Configuration

**File: `wrangler.toml` at root:**
```toml
name = "avlo"
main = "./worker/src/index.ts"
compatibility_date = "2024-10-01"
compatibility_flags = ["nodejs_compat"]

# Durable Object binding
[[durable_objects.bindings]]
name = "rooms"
class_name = "RoomDurableObject"

# R2 bucket for document persistence
[[r2_buckets]]
binding = "DOCS"
bucket_name = "avlo-docs"

# Enable SQLite storage for Durable Objects
[[migrations]]
tag = "v1"
new_sqlite_classes = ["RoomDurableObject"]

# Development settings
[dev]
port = 3000 #overriden explicitly 
```

### Worker Entry

**File: `worker/src/index.ts`**
```typescript
import { routePartykitRequest } from "partyserver";
import type { R2Bucket } from "@cloudflare/workers-types";

// Keep Env precise — no index signature
export interface Env {
  rooms: DurableObjectNamespace;
  DOCS: R2Bucket;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // partyserver type expects a looser env; cast *only* at the callsite
    const res = await routePartykitRequest(request, env as unknown as Record<string, unknown>);
    if (res) return res;
    return new Response("Not Found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

// MUST match [[durable_objects]].class_name in wrangler.toml
export { RoomDurableObject } from "./parties/room";
```

- `routePartykitRequest(request, env)` handles routing to Durable Objects
- `env.rooms` binding MUST exist (validated at runtime)
- Export of `RoomDurableObject` MUST match `class_name` in wrangler.toml
- No manual URL parsing needed - PartyServer handles routing


### Tiny worker module (this resolved annoying bugs)
**File: `worker/src/types.d.ts`**
```typescript
/// <reference types="@cloudflare/workers-types" />

declare module "cloudflare:workers" {
  // Minimal ambient types for Workerd's virtual module so TypeScript is happy.
  // partyserver.Server extends this class at type level.
  export class DurableObject<Env = unknown> {
    constructor(ctx: DurableObjectState, env: Env);

    fetch?(request: Request): Response | Promise<Response>;
    alarm?(): void | Promise<void>;
    webSocketMessage?(
      ws: WebSocket,
      message: ArrayBuffer | ArrayBufferView | string
    ): void | Promise<void>;
    webSocketClose?(
      ws: WebSocket,
      code: number,
      reason: string,
      wasClean: boolean
    ): void | Promise<void>;
    webSocketError?(ws: WebSocket, error: unknown): void | Promise<void>;
  }
}

```
### Durable Object with YServer and R2 Persitence and V2

**File: `worker/src/parties/room.ts`**
```typescript
import * as Y from "yjs";
import { YServer } from "y-partyserver";
import type { Env } from "../index";
import type { Connection } from "partyserver";

// One canonical head per room, V2-encoded at rest
const headKey = (room: string) => `rooms/${room}/head.v2.bin`;

export class RoomDurableObject extends YServer<Env> {
  // R2-friendly cadence: fewer, bigger writes
  static callbackOptions = { debounceWait: 5000, debounceMaxWait: 15000 };

  /**
   * Ensure hydration completes before the first sync step.
   * YServer awaits onStart(), then onLoad(), installs debounced onSave(), then accepts sockets.
   */
  async onStart(): Promise<void> {
    return super.onStart();
  }

  /**
   * Hydrate from R2 (V2 bytes).
   * Brand-new rooms have no head object yet — that's fine.
   */
  async onLoad(): Promise<void> {
    const obj = await this.env.DOCS.get(headKey(this.name));
    if (!obj) return;
    const bytes = new Uint8Array(await obj.arrayBuffer());
    if (bytes.byteLength === 0) return;
    Y.applyUpdateV2(this.document, bytes);
  }

  /**
   * Debounced persistence: write a V2 snapshot to R2 as the canonical head.
   */
  async onSave(): Promise<void> {
    const updateV2 = Y.encodeStateAsUpdateV2(this.document);
    await this.env.DOCS.put(headKey(this.name), updateV2, {
      httpMetadata: { contentType: "application/octet-stream" },
      customMetadata: { ts: String(Date.now()) },
    });
  }

  /**
   * Hard flush when the last user leaves the room.
   * This complements the debounced persistence and prevents "lost last edits"
   * when users close their tabs right after a change.
   */
  async onClose(
    connection: Connection<unknown>,
    code: number,
    reason: string,
    wasClean: boolean
  ): Promise<void> {
    // First let YServer prune the connection and awareness state.
    await super.onClose(connection, code, reason, wasClean);

    // If the room is now empty, flush the doc immediately (non-debounced).
    if (this.document.conns.size === 0) {
      // One microturn in case a final Yjs update just landed
      await Promise.resolve();
      try {
        await this.onSave();
      } catch (err) {
        console.error("flush-on-last-disconnect failed:", err);
      }
    }
  }
}
```
**Storage Model:**
- Each room ID → deterministic DO ID via `env.rooms.idFromName(roomId)`
- Each DO also maps to a private R2 bucket
- R2 storage survives DO restarts (persistent)
- No shared state between DOs (server)

### Client Provider

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
      this.roomId,  
      this.ydoc,
      {
        party: 'rooms',  // MUST match wrangler.toml binding name
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

### Vite Configuration

**File `/client/vite.config.ts`**
```typescript
import { defineConfig } from 'vite';
import path from 'path';

export default defineConfig({
  plugins: [

  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@avlo/shared': path.resolve(__dirname, '../packages/shared/src')
    }
  },
  server: {
    port: 3000,
    proxy: {
      // Proxy WebSocket connections to wrangler dev server
      '/parties': {
        target: 'ws://localhost:8787',
        ws: true,
        changeOrigin: true
      },
      // Also proxy regular HTTP requests to /parties
      '/parties/*': {
        target: 'http://localhost:8787',
        changeOrigin: true
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

---

## Project Structure

avlo/
├── worker/                          # Cloudflare Worker workspace
│   ├── src/
│   │   ├── index.ts                # Worker entry point
│   │   └── types.d.ts              # Module declaration
│   │   └── parties/
│   │       └── room.ts             # RoomDurableObject class
│   ├── package.json                # Worker dependencies
│   └── tsconfig.json               # Worker TypeScript config
│
├── client/                          # React client workspace
│   ├── src/
│   │   ├── lib/
│   │   │   ├── room-doc-manager.ts # Y.js manager with YProvider
│   │   │   └── config-schema.ts    # Client config validation
│   │   └── ...                     # Canvas, tools, components
│   ├── vite.config.ts              # Vite with proxy config (NO Cloudflare plugin)
│   ├── package.json                # Client dependencies
│   └── tsconfig.json               # Client TypeScript config
│
├── packages/
│   └── shared/                      # Shared types and utilities
│       ├── src/
│       │   ├── spatial/            # RBush spatial index
│       │   ├── types/              # Shared TypeScript types
│       │   └── config/             # Constants (ROOM_CONFIG, etc.)
│       ├── package.json
│       └── tsconfig.json
│
├── wrangler.toml                    # Cloudflare Worker config
├── package.json                     # Root workspace config
├── tsconfig.json                    # Root TypeScript config
├── tsconfig.base.json               # Base TypeScript config
└── .wrangler/                       # Local Durable Object state (gitignored)
    └── state/v3/...
---

### 2.3 package.json Scripts
```json
{
  "dev": "concurrently \"npm run dev:worker\" \"npm run dev:client\"",
  "dev:worker": "wrangler dev --port 8787",  // Overrides wrangler.toml port
  "dev:client": "npm run dev -w client"
}
```


## URL Routing & Data Flow
### Two Distinct URL Patterns

1. **Browser URL (React Router):** `/room/:roomId`
2. **WebSocket URL (PartyKit):** `/parties/rooms/:roomId`

Vite plugin was too buggy, so two ports was the fix.

1. User navigates to: http://localhost:3000/room/my-room
   ↓
2. React Router renders RoomPage component
   ↓
3. RoomPage extracts roomId: "my-room"
   ↓
4. Canvas component uses roomId to get RoomDocManager
   ↓
5. RoomDocManager creates YProvider with:
   - host: "localhost:3000"
   - room: "my-room"
   - party: "rooms"
   ↓
6. YProvider constructs WebSocket URL:
   ws://localhost:3000/parties/rooms/my-room
   ↓
7. Vite proxy intercepts /parties/* and forwards to:
   ws://localhost:8787/parties/rooms/my-room
   ↓
8. Wrangler Worker receives request
   ↓
9. routePartykitRequest() parses URL:
   - party: "rooms"
   - room: "my-room"
   ↓
10. Worker routes to Durable Object:
    env.rooms.idFromName("my-room")
   ↓
11. RoomDurableObject handles WebSocket connection

### 11.1 NPM Workspace Structure

**Root package.json:**
```json
{
  "name": "avlo",
  "type": "module",
  "workspaces": [
    "client",        // Frontend React application
    "worker",        // Cloudflare Worker + Durable Objects
    "packages/*"     // Shared code (currently only 'shared')
  ]
}
```

### 11.2 Dependency Resolution & Hoisting

**NPM Workspace Hoisting Behavior:**

1. **Common dependencies hoisted to root:**
   - `yjs@13.6.27` - Used by client, worker, and transitive deps
   - `typescript@5.9.2` - Shared dev dependency
   - `vitest@4.0.7` - Test runner (root + client)
   - `@cloudflare/workers-types@4.20251106.1` - Shared types

2. **Workspace-specific deps stay local:**

### 11.3 Package Dependencies Breakdown

### 3.1 Root Workspace (`package.json`)

**Key Dependencies:**
```json
{
  "dependencies": {
    "partyserver": "^0.0.75",        // PartyServer core
    "y-partyserver": "^0.0.51",      // Y.js integration for PartyServer
    "react-router-dom": "^7.8.2",    // Client routing (hoisted)
    "y-leveldb": "^0.2.0",           // satisfies a requirement, not used
    "chalk": "^5.6.0"                // CLI utilities
  },
  "devDependencies": {
    "wrangler": "^4.46.0",           // Cloudflare Workers CLI
    "concurrently": "^8.2.2",        // Run dev servers in parallel
    "vitest": "^4.0.0",              // Testing framework (Vite 7 compatible)
    "@vitest/ui": "^4.0.0",
    "typescript": "^5.9.2",
    "@cloudflare/workers-types": "^4.20251106.1"
  }
}
```

**Scripts:**
```json
{
  "dev": "concurrently \"npm run dev:worker\" \"npm run dev:client\"",
  "dev:worker": "wrangler dev --port 8787",
  "dev:client": "npm run dev -w client",
  "build": "npm run build -w client",
  "deploy": "wrangler deploy",
  "typecheck": "npm run -w packages/shared build:types && npm run -w client typecheck && npm run -w worker typecheck"
}
```

### 3.2 Worker Workspace (`worker/package.json`)

```json
{
  "name": "@avlo/worker",
  "dependencies": {
    "yjs": "^13.6.27"                // Y.js CRDT library
  },
  "devDependencies": {
    "@cloudflare/workers-types": "^4.20251106.1",
    "typescript": "^5.9.2"
  }
}
```

### 3.3 Client Workspace (`client/package.json`)

```json
{
  "name": "@avlo/client",
  "dependencies": {
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "yjs": "^13.6.27",
    "y-indexeddb": "^9.0.12",       // IndexedDB persistence
    "y-partyserver": "^0.0.51",     // YProvider for PartyServer
    "y-webrtc": "^10.3.0",          // Future WebRTC support
    "zustand": "^5.0.8",            // Device UI state
    "@tanstack/react-query": "^5.85.5",
    "monaco-editor": "^0.52.2",
    "perfect-freehand": "^1.2.2",
    "zod": "^4.1.1"
  },
  "devDependencies": {
    "vite": "^7.2.1",               // UPGRADED from 5.4.11 for compatibility
    "@vitejs/plugin-react": "^4.3.4", // React plugin (NOT in vite.config.ts)
    "@cloudflare/vite-plugin": "^1.14.0", // Installed but NOT used
    "vitest": "^4.0.7",             // UPGRADED from 2.1.8
    "@vitest/ui": "^4.0.7",
    "tailwindcss": "^3.4.17",
    "autoprefixer": "^10.4.20",
    "postcss": "^8.4.49"
  }
}
```

**Critical Finding:** `@vitejs/plugin-react` is installed but **NOT used in vite.config.ts**. This might be an oversight or intentional (Vite 7 may auto-detect React).

### 3.4 Shared Workspace (`packages/shared/package.json`)

```json
{
  "name": "@avlo/shared",
  "dependencies": {
    "rbush": "^4.0.1",              // Spatial index (R-tree)
    "ulid": "^3.0.1",               // ID generation
    "zod": "^4.1.1"                 // Schema validation
  },
  "devDependencies": {
    "@types/rbush": "^4.0.0"
  }
}
```

### TypeScript Configuration Architecture

#### Base Configuration (tsconfig.base.json)
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "lib": ["ES2022"],
    "jsx": "react-jsx",
    "moduleResolution": "bundler",
    "strict": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "esModuleInterop": true,
    "resolveJsonModule": true
  }
}
```

#### Client TypeScript Config
```json
{
  "extends": "../tsconfig.base.json",
  "compilerOptions": {
    "lib": ["ES2022", "DOM", "DOM.Iterable"],  // Browser APIs
    "paths": {
      "@/*": ["./src/*"],                       // Internal alias
      "@avlo/shared": ["../packages/shared/src/index.ts"],
      "@avlo/shared/*": ["../packages/shared/src/*"]
    },
    "types": ["vite/client", "node"],
    "noEmit": true  // Vite handles compilation
  },
  "references": [{ "path": "../packages/shared" }]  // Project reference
}
```

#### Worker TypeScript Config
```json
{
  "extends": "../tsconfig.base.json",
  "compilerOptions": {
    "types": ["@cloudflare/workers-types"],  // Workers runtime types
    "isolatedModules": true,                  // Required for bundler
    "paths": {
      "@avlo/shared/*": ["../packages/shared/src/*"]
    }
  }
}
```
