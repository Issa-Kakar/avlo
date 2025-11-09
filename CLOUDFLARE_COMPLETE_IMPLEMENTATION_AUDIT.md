# AVLO Cloudflare Implementation - Complete Audit
**Date:** 2025-11-07
**Status:** Production-Ready Separated Architecture

---

## Executive Summary

This document provides a comprehensive audit of the **actual working Cloudflare implementation** for AVLO, detailing every aspect of the architecture, dependencies, configuration, and operational behavior. This implementation differs significantly from the original migration guide due to architectural decisions made during development.

### Key Architectural Decision

**Critical Difference:** Instead of using the Cloudflare Vite plugin to run everything together, we use a **separated two-server architecture**:
- **Wrangler Dev Server** (port 8787): Runs Cloudflare Worker with proper Durable Object bindings
- **Vite Dev Server** (port 3000): Runs client app and proxies `/parties/*` requests to Wrangler

**Reason:** The Cloudflare Vite plugin does not properly inject Durable Object namespace bindings in development mode, causing `env.rooms` to be undefined when `routePartykitRequest` tries to access `env.rooms.idFromName()`.

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Project Structure](#2-project-structure)
3. [Dependencies Analysis](#3-dependencies-analysis)
4. [Configuration Files](#4-configuration-files)
5. [Worker Implementation](#5-worker-implementation)
6. [Client Implementation](#6-client-implementation)
7. [Development Workflow](#7-development-workflow)
8. [URL Routing & WebSocket Flow](#8-url-routing--websocket-flow)
9. [Environment Variables](#9-environment-variables)
10. [Build & Deploy](#10-build--deploy)
11. [TypeScript Configuration](#11-typescript-configuration)
12. [Critical Implementation Details](#12-critical-implementation-details)

---

## 1. Architecture Overview

### 1.1 High-Level Stack

```
┌─────────────────────────────────────────────────────────┐
│                    Browser Client                        │
│  ┌──────────────────────────────────────────────────┐   │
│  │         React App (port 3000)                    │   │
│  │  - YProvider connects to /parties/rooms/{id}     │   │
│  │  - VITE_PARTY_HOST: localhost:3000               │   │
│  └──────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
                         │
                         │ WebSocket: /parties/rooms/{roomId}
                         ↓
┌─────────────────────────────────────────────────────────┐
│         Vite Dev Server (localhost:3000)                │
│  ┌──────────────────────────────────────────────────┐   │
│  │  Proxy Configuration:                            │   │
│  │  - /parties → ws://localhost:8787 (WebSocket)    │   │
│  │  - /parties/* → http://localhost:8787 (HTTP)     │   │
│  └──────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
                         │
                         │ Proxied Request
                         ↓
┌─────────────────────────────────────────────────────────┐
│      Wrangler Dev Server (localhost:8787)               │
│  ┌──────────────────────────────────────────────────┐   │
│  │  Worker (worker/src/index.ts)                    │   │
│  │  - routePartykitRequest(request, env)            │   │
│  │  - env.rooms: DurableObjectNamespace             │   │
│  └──────────────────────────────────────────────────┘   │
│  ┌──────────────────────────────────────────────────┐   │
│  │  Durable Object: RoomDurableObject               │   │
│  │  - Extends YServer from y-partyserver            │   │
│  │  - SQLite storage per room                       │   │
│  │  - onLoad(), onSave() lifecycle                  │   │
│  └──────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
```

### 1.2 Data Flow

**Client → Server Connection:**
1. Client creates `YProvider(host, roomId, ydoc, { party: 'rooms' })`
2. YProvider constructs URL: `ws://localhost:3000/parties/rooms/{roomId}`
3. Vite proxy forwards to: `ws://localhost:8787/parties/rooms/{roomId}`
4. Worker receives request, calls `routePartykitRequest(request, env)`
5. PartyServer routes to appropriate Durable Object by room ID
6. Durable Object handles WebSocket upgrade and Y.js sync

**Why This Works:**
- Wrangler properly binds `env.rooms` as a `DurableObjectNamespace`
- `routePartykitRequest` can call `env.rooms.idFromName(roomId)`
- Each room gets a dedicated Durable Object instance
- SQLite storage is private to each DO instance

---

## 2. Project Structure

```
avlo/
├── worker/                          # Cloudflare Worker workspace
│   ├── src/
│   │   ├── index.ts                # Worker entry point
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
    └── state/v3/do/avlo-RoomDurableObject/*.sqlite
```

---

## 3. Dependencies Analysis

### 3.1 Root Workspace (`package.json`)

**Key Dependencies:**
```json
{
  "dependencies": {
    "partyserver": "^0.0.75",        // PartyServer core
    "y-partyserver": "^0.0.51",      // Y.js integration for PartyServer
    "react-router-dom": "^7.8.2",    // Client routing (hoisted)
    "y-leveldb": "^0.2.0",           // Not used (legacy)
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

**Critical:** Worker does NOT install `partyserver` or `y-partyserver` directly. These are hoisted from root workspace due to npm workspaces behavior.

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

### 3.5 Critical Version Requirements

| Package | Constraint | Reason |
|---------|-----------|--------|
| `vite` | `≥7.0.0` | Required by `@cloudflare/vite-plugin` (even though we don't use it) |
| `vitest` | `≥4.0.0` | Must match Vite major version for compatibility |
| `partyserver` | `0.0.75` | Provides `routePartykitRequest` function |
| `y-partyserver` | `0.0.51` | Provides `YServer` base class and `YProvider` client |
| `yjs` | `^13.6.27` | Consistent across all workspaces |

---

## 4. Configuration Files

### 4.1 `wrangler.toml` (Root)

```toml
name = "avlo"
main = "./worker/src/index.ts"
compatibility_date = "2024-10-01"
compatibility_flags = ["nodejs_compat"]

# Durable Object binding
[[durable_objects.bindings]]
name = "rooms"                    # MUST match client party: 'rooms'
class_name = "RoomDurableObject"  # MUST match exported class name

# Enable SQLite storage
[[migrations]]
tag = "v2"
new_sqlite_classes = ["RoomDurableObject"]

# Development settings
[dev]
port = 8787                       # CRITICAL: Must NOT be 3000 (Vite uses 3000)
```

**Critical Notes:**
- `name = "rooms"` in binding MUST match `party: 'rooms'` in client YProvider config
- `port = 8787` separates Wrangler from Vite (different from guide's single-port approach)
- `main` points to worker entry point (not client)
- `compatibility_flags = ["nodejs_compat"]` enables Node.js APIs

### 4.2 `client/vite.config.ts`

```typescript
import { defineConfig } from 'vite';
import path from 'path';

export default defineConfig({
  plugins: [
    // CRITICAL: NO @cloudflare/vite-plugin
    // CRITICAL: NO @vitejs/plugin-react (might be auto-detected by Vite 7)
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

**Critical Differences from Migration Guide:**
1. ❌ NO `cloudflare()` plugin
2. ❌ NO `configPath: '../wrangler.toml'`
3. ❌ NO `persistTo` option
4. ✅ ADDS proxy configuration for `/parties` routes
5. ❌ NO React plugin (installed but not configured - may be auto-detected)

---

## 5. Worker Implementation

### 5.1 Entry Point (`worker/src/index.ts`)

```typescript
/// <reference types="@cloudflare/workers-types" />

import { routePartykitRequest } from "partyserver";

export interface Env {
  rooms: DurableObjectNamespace;  // Required binding from wrangler.toml
  [key: string]: unknown;         // Allow additional properties
}

export default {
  async fetch(
    request: Request,
    env: Env,
    _ctx: ExecutionContext
  ): Promise<Response> {
    // Validate required bindings
    if (!env.rooms) {
      console.error("Missing 'rooms' DurableObject binding");
      return new Response("Server configuration error", { status: 500 });
    }

    try {
      // Route to Durable Object via PartyServer
      const response = await routePartykitRequest(request, env);

      if (response) {
        return response;  // PartyServer handled the request
      }

      // Fallback for non-WebSocket requests
      return new Response("Not Found", { status: 404 });
    } catch (error) {
      console.error("Worker error:", error);
      return new Response("Internal Server Error", { status: 500 });
    }
  },
} satisfies ExportedHandler<Env>;

// Export Durable Object class
export { RoomDurableObject } from "./parties/room";
```

**Key Points:**
- `routePartykitRequest(request, env)` handles routing to Durable Objects
- `env.rooms` binding MUST exist (validated at runtime)
- Export of `RoomDurableObject` MUST match `class_name` in wrangler.toml
- No manual URL parsing needed - PartyServer handles routing

### 5.2 Durable Object (`worker/src/parties/room.ts`)

```typescript
import * as Y from 'yjs';
import { YServer } from 'y-partyserver';
import type { Env } from '../index';

export class RoomDurableObject extends YServer<Env> {
  // Persistence tuning
  static callbackOptions = {
    debounceWait: 1000,    // Save after 1s of inactivity
    debounceMaxWait: 5000  // Force save after 5s
  };

  // Load Y.Doc state from SQLite on DO boot
  async onLoad(): Promise<void> {
    // Create table (idempotent)
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS ydoc_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        state BLOB NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);

    // Load existing state (safe for zero rows)
    const cur = this.ctx.storage.sql.exec(
      'SELECT state FROM ydoc_state WHERE id = 1 LIMIT 1'
    );
    const row = cur.toArray()[0] as { state?: ArrayBuffer | Uint8Array } | undefined;

    if (row?.state) {
      const buf = row.state instanceof Uint8Array
        ? row.state
        : new Uint8Array(row.state);
      Y.applyUpdate(this.document, buf);  // this.document from YServer
    }
  }

  // Save Y.Doc state to SQLite (called by YServer after debounce)
  async onSave(): Promise<void> {
    const state = Y.encodeStateAsUpdate(this.document);
    const now = Date.now();

    this.ctx.storage.sql.exec(
      `INSERT INTO ydoc_state (id, state, updated_at)
       VALUES (1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         state = excluded.state,
         updated_at = excluded.updated_at`,
      state, now
    );
  }
}
```

**Key Points:**
- Extends `YServer<Env>` from `y-partyserver`
- `callbackOptions` controls persistence frequency
- `onLoad()`: Called when DO initializes (first request or after eviction)
- `onSave()`: Called by YServer after debounced changes
- `this.document`: Y.Doc instance managed by YServer
- `this.ctx.storage.sql`: SQLite API (enabled by `new_sqlite_classes`)
- Single row design (`id = 1`) stores full document state

**Storage Model:**
- Each room ID → deterministic DO ID via `env.rooms.idFromName(roomId)`
- Each DO has private SQLite database
- State survives DO restarts (persistent)
- No shared state between DOs

---

## 6. Client Implementation

### 6.1 YProvider Setup (`client/src/lib/room-doc-manager.ts`)

**Relevant Excerpt (lines 1701-1717):**

```typescript
private initializeWebSocketProvider(): void {
  try {
    // Determine host (defaults to window.location.host)
    const host = clientConfig.VITE_PARTY_HOST || window.location.host;

    // Create YProvider (replaces WebsocketProvider)
    this.websocketProvider = new YProvider(
      host,              // 'localhost:3000' in dev
      this.roomId,       // Room name (NOT appended to URL by YProvider)
      this.ydoc,
      {
        party: 'rooms',  // MUST match wrangler.toml binding name
        awareness: this.yAwareness,
        maxBackoffTime: 10_000,
        resyncInterval: 5_000,
      }
    );

    // ... event listeners ...
  } catch (err) {
    console.error('[RoomDocManager] WebSocket initialization failed:', err);
  }
}
```

**Critical Details:**
- `host: 'localhost:3000'` → Client connects to Vite server
- `party: 'rooms'` → MUST match `wrangler.toml` binding name
- YProvider constructs URL: `/parties/rooms/{roomId}`
- Vite proxy forwards to Wrangler at port 8787
- No manual URL construction needed (YProvider handles it)

### 6.2 Config Schema (`client/src/lib/config-schema.ts`)

```typescript
import { z } from 'zod';

export const ClientConfigSchema = z.object({
  VITE_API_BASE: z.string().optional(),
  VITE_ROOM_TTL_DAYS: z.coerce.number().min(1).max(90).default(14),
  VITE_PARTY_HOST: z.string().optional(),  // Defaults to window.location.host
});

export type ClientConfig = z.infer<typeof ClientConfigSchema>;

export function loadClientConfig(): ClientConfig {
  try {
    const config = {
      VITE_API_BASE: import.meta.env.VITE_API_BASE,
      VITE_ROOM_TTL_DAYS: Number(import.meta.env.VITE_ROOM_TTL_DAYS ?? 14),
      VITE_PARTY_HOST: import.meta.env.VITE_PARTY_HOST,
    };
    return ClientConfigSchema.parse(config);
  } catch (error) {
    if (error instanceof z.ZodError) {
      console.error('[Config] Validation failed:', error.issues);
      throw new Error(`Configuration error: ${error.issues[0].message}`);
    }
    throw error;
  }
}

export const clientConfig = loadClientConfig();
```

**Usage Pattern:**
- Validates environment variables at startup
- Provides type-safe access to config
- Falls back to sensible defaults
- Used in `room-doc-manager.ts` for host determination

---

## 7. Development Workflow

### 7.1 Starting Development Servers

**Command:** `npm run dev`

**Execution Flow:**
```bash
concurrently "npm run dev:worker" "npm run dev:client"
```

**Terminal Output:**
```
[0] > wrangler dev --port 8787
[1] > npm run dev -w client

[0] ⎔ Starting local server...
[0] ⎔ Ready on http://localhost:8787
[1]
[1] VITE v7.2.1  ready in 423 ms
[1]
[1] ➜  Local:   http://localhost:3000/
[1] ➜  Network: use --host to expose
```

**Process Lifecycle:**
1. Wrangler starts first (builds worker, binds DOs)
2. Vite starts second (builds client, sets up proxy)
3. Both run concurrently in same terminal
4. Ctrl+C kills both processes

### 7.2 Request Flow in Development

**Client Request:**
```
Browser → http://localhost:3000/room/test-room
          ↓
Vite serves index.html
          ↓
React app loads, creates YProvider
          ↓
YProvider connects to ws://localhost:3000/parties/rooms/test-room
```

**WebSocket Upgrade:**
```
Vite proxy receives /parties/rooms/test-room
          ↓
Proxies to ws://localhost:8787/parties/rooms/test-room
          ↓
Wrangler worker receives request
          ↓
routePartykitRequest(request, env)
          ↓
env.rooms.idFromName('test-room')  // Deterministic DO ID
          ↓
stub.fetch(request)  // Route to DO
          ↓
RoomDurableObject handles WebSocket
          ↓
YServer syncs Y.Doc
```

### 7.3 Local State Persistence

**Durable Object SQLite:**
```
.wrangler/state/v3/do/avlo-RoomDurableObject/
├── {DO_ID_1}.sqlite
├── {DO_ID_1}.sqlite-shm
├── {DO_ID_1}.sqlite-wal
├── {DO_ID_2}.sqlite
└── ...
```

**Client IndexedDB:**
```
IndexedDB → avlo.v1.rooms.{roomId}
  └── Y.Doc state (offline persistence)
```

---

## 8. URL Routing & WebSocket Flow

### 8.1 URL Construction

**Client-Side:**
```typescript
// YProvider auto-constructs URL from parameters
new YProvider(
  'localhost:3000',   // host
  'test-room',        // room
  ydoc,
  { party: 'rooms' }  // party name
)

// Resulting WebSocket URL:
// ws://localhost:3000/parties/rooms/test-room
```

**URL Pattern:**
```
{protocol}://{host}/parties/{party}/{room}

Examples:
- Dev:  ws://localhost:3000/parties/rooms/abc123
- Prod: wss://avlo.com/parties/rooms/abc123
```

### 8.2 Proxy Routing (Vite)

**Configuration:**
```typescript
proxy: {
  '/parties': {
    target: 'ws://localhost:8787',
    ws: true,              // Enable WebSocket proxying
    changeOrigin: true     // Change Host header to target
  },
  '/parties/*': {
    target: 'http://localhost:8787',
    changeOrigin: true
  }
}
```

**Behavior:**
- WebSocket requests: `ws://localhost:3000/parties/*` → `ws://localhost:8787/parties/*`
- HTTP requests: `http://localhost:3000/parties/*` → `http://localhost:8787/parties/*`
- Host header rewritten to `localhost:8787`

### 8.3 Worker Routing (PartyServer)

**Automatic Routing:**
```typescript
// PartyServer inspects URL: /parties/rooms/test-room
// Extracts:
//   - party: 'rooms'
//   - room: 'test-room'

const id = env.rooms.idFromName('test-room');  // Deterministic ID
const stub = env.rooms.get(id);
return stub.fetch(request);
```

**Room ID → DO ID Mapping:**
- Same room ID always maps to same DO ID (deterministic)
- Different room IDs map to different DO instances
- Globally unique per Cloudflare account

---

## 9. Environment Variables

### 9.1 Client Environment (`.env.local`)

```bash
# Optional - defaults to window.location.host if not set
VITE_PARTY_HOST=localhost:3000
```

**Accessed Via:**
```typescript
import.meta.env.VITE_PARTY_HOST
```

**Default Behavior:**
```typescript
const host = import.meta.env.VITE_PARTY_HOST || window.location.host;
```

### 9.2 Worker Environment

**No `.env` file used.** Wrangler bindings configured in `wrangler.toml`.

**Runtime Bindings:**
```typescript
interface Env {
  rooms: DurableObjectNamespace;  // Injected by Wrangler
}
```

### 9.3 Production Environment

**Client:**
- `VITE_PARTY_HOST` should be set to production domain (e.g., `avlo.com`)
- Or omitted to use `window.location.host`

**Worker:**
- Same `wrangler.toml` used
- Deploy with `wrangler deploy`
- Bindings automatically configured in production

---

## 10. Build & Deploy

### 10.1 Build Process

**Client Build:**
```bash
npm run build
# → cd client && tsc && vite build
# → Output: client/dist/
```

**Worker Build:**
```bash
wrangler deploy
# → Builds worker/src/index.ts
# → Deploys to Cloudflare Workers
```

**TypeScript Check:**
```bash
npm run typecheck
# → Checks packages/shared, client, worker
```

### 10.2 Deployment

**Command:**
```bash
npm run deploy
# → wrangler deploy
```

**What Happens:**
1. Wrangler builds worker TypeScript
2. Uploads worker to Cloudflare
3. Registers Durable Object class
4. Applies migrations (SQLite enablement)
5. Returns deployment URL

**Production URLs:**
```
Worker:  https://avlo.{account}.workers.dev
         or custom domain via wrangler.toml

Client:  Deployed separately (Vercel, Netlify, etc.)
         or served from Worker (add asset handling)
```

### 10.3 Static Asset Serving

**Current State:** Worker returns 404 for non-WebSocket requests.

**To Serve Client from Worker:**
```typescript
// In worker/src/index.ts
import { getAssetFromKV } from '@cloudflare/kv-asset-handler';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Route WebSocket requests
    if (url.pathname.startsWith('/parties/')) {
      return routePartykitRequest(request, env);
    }

    // Serve static assets
    try {
      return await getAssetFromKV({ request, waitUntil: ctx.waitUntil });
    } catch {
      return new Response('Not Found', { status: 404 });
    }
  }
}
```

---

## 11. TypeScript Configuration

### 11.1 Base Config (`tsconfig.base.json`)

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

### 11.2 Worker Config (`worker/tsconfig.json`)

```json
{
  "extends": "../tsconfig.base.json",
  "compilerOptions": {
    "lib": ["ES2022"],
    "types": ["@cloudflare/workers-types"],
    "moduleResolution": "bundler",
    "noEmit": true,
    "paths": {
      "@avlo/shared/*": ["../packages/shared/src/*"]
    }
  },
  "include": ["src/**/*.ts"]
}
```

**Key Points:**
- Uses Cloudflare Workers types
- No DOM types (server-side only)
- Path alias for shared package

### 11.3 Client Config (`client/tsconfig.json`)

```json
{
  "extends": "../tsconfig.base.json",
  "compilerOptions": {
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx",
    "baseUrl": ".",
    "paths": {
      "@/*": ["./src/*"],
      "@avlo/shared": ["../packages/shared/src/index.ts"],
      "@avlo/shared/*": ["../packages/shared/src/*"]
    },
    "types": ["vite/client", "node"],
    "noEmit": true
  },
  "include": ["src/**/*", "vite.config.ts"]
}
```

**Key Points:**
- Includes DOM types (browser environment)
- Path aliases for `@/` and `@avlo/shared`
- Vite client types for `import.meta.env`

---

## 12. Critical Implementation Details

### 12.1 Why Separated Architecture?

**Problem with Cloudflare Vite Plugin:**
```typescript
// With @cloudflare/vite-plugin in vite.config.ts:
const response = await routePartykitRequest(request, env);
// ❌ Error: Cannot read property 'idFromName' of undefined
// ❌ env.rooms is undefined in development mode
```

**Root Cause:**
- Cloudflare Vite plugin doesn't properly inject Durable Object bindings
- `env.rooms` exists in production but not in dev with the plugin
- PartyServer's `routePartykitRequest` requires `env.rooms` to route requests

**Solution:**
- Run Wrangler separately on port 8787
- Wrangler properly provides `env.rooms` binding
- Vite proxies requests to Wrangler
- Development behavior matches production

### 12.2 Port Configuration

| Server | Port | Purpose |
|--------|------|---------|
| Vite | 3000 | Client dev server, proxy |
| Wrangler | 8787 | Worker + Durable Objects |

**Why 8787?**
- Default Wrangler port
- Avoids conflict with Vite (3000)
- Clearly separates concerns

**Client Config:**
```typescript
VITE_PARTY_HOST=localhost:3000  // Client connects to Vite
```

**Proxy Config:**
```typescript
'/parties': {
  target: 'ws://localhost:8787',  // Vite forwards to Wrangler
  ws: true
}
```

### 12.3 Party Name Binding

**MUST MATCH ACROSS:**

1. **wrangler.toml:**
```toml
[[durable_objects.bindings]]
name = "rooms"  # ← This name
```

2. **Client YProvider:**
```typescript
new YProvider(host, roomId, ydoc, {
  party: 'rooms'  // ← MUST match wrangler.toml
})
```

3. **Worker Interface:**
```typescript
interface Env {
  rooms: DurableObjectNamespace;  // ← Same name
}
```

**Why?**
- PartyServer uses `env[partyName]` to get DO namespace
- `env.rooms` must exist for routing to work
- Mismatch causes "binding not found" error

### 12.4 Room ID to Durable Object Mapping

```typescript
// Same room ID always maps to same DO
const id1 = env.rooms.idFromName('test-room');
const id2 = env.rooms.idFromName('test-room');
// id1 === id2  ✅ Guaranteed

// Different rooms map to different DOs
const id3 = env.rooms.idFromName('other-room');
// id3 !== id1  ✅ Different DO instance
```

**Properties:**
- **Deterministic:** Same input → same output
- **Global:** Unique across all Cloudflare edge locations
- **Persistent:** DO instance persists until evicted
- **Isolated:** Each DO has private SQLite storage

### 12.5 SQLite Storage Model

**Per-DO Database:**
```sql
-- Created in onLoad()
CREATE TABLE IF NOT EXISTS ydoc_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  state BLOB NOT NULL,
  updated_at INTEGER NOT NULL
);
```

**Single Row Design:**
- Only one row (`id = 1`) per DO
- Full Y.Doc state stored as BLOB
- `updated_at` tracks last save time
- `ON CONFLICT` ensures upsert behavior

**Advantages:**
- Simple schema (no complex queries)
- Fast load/save (single row read/write)
- Full document state in one place
- No incremental update complexity

**Trade-offs:**
- Entire doc written on each save
- No partial updates (acceptable for CRDT)
- Size limit: ~1MB per DO (Cloudflare limit)

### 12.6 YServer Lifecycle

**onLoad() Timing:**
- Called on first request to DO
- Called after DO eviction (cold start)
- NOT called on every request

**onSave() Timing:**
- Debounced by `callbackOptions`
- `debounceWait: 1000ms` → save after 1s idle
- `debounceMaxWait: 5000ms` → force save after 5s
- Triggered by Y.Doc changes

**Example Timeline:**
```
t=0ms:   Client connects, DO boots, onLoad() called
t=100ms: Client sends update
t=150ms: Another update
t=200ms: Another update
t=1200ms: onSave() called (1s idle)

t=2000ms: Client sends update
t=2500ms: Another update
t=7000ms: onSave() called (5s max exceeded)
```

### 12.7 Offline Behavior

**Client-Side:**
1. IndexedDB persists Y.Doc locally
2. YProvider connects when online
3. If offline, works from IndexedDB
4. On reconnect, syncs with DO

**Server-Side:**
1. DO persists to SQLite
2. SQLite survives DO restart
3. If DO evicted, next request reloads from SQLite

**Race Condition Handling:**
```typescript
// In room-doc-manager.ts
this.whenGateOpen('idbReady').then(async () => {
  await Promise.race([
    this.whenGateOpen('wsSynced'),
    this.delay(350),  // 350ms grace period
  ]);

  const root = this.ydoc.getMap('root');
  if (!root.has('meta')) {
    this.initializeYjsStructures();  // Fresh room
  }
});
```

**Why 350ms?**
- Prevents race between IDB and WebSocket
- If WebSocket syncs first (has data), use it
- If timeout, assume fresh room, seed structures
- Avoids overwriting remote state with empty doc

### 12.10 Concurrency Model

**Development:**
```bash
concurrently "npm run dev:worker" "npm run dev:client"
```

---

## Appendix A: Key Differences from Migration Guide

| Aspect | Migration Guide | Actual Implementation |
|--------|----------------|----------------------|
| **Vite Plugin** | Use `@cloudflare/vite-plugin` | NOT used (proxy instead) |
| **Port Setup** | Single port (3000) | Two ports (3000 Vite, 8787 Wrangler) |
| **Development** | Vite + Worker integrated | Separate processes via `concurrently` |
| **Proxy Config** | None (plugin handles) | Explicit `/parties` proxy |
| **React Plugin** | Assumed present | Installed but not configured |
| **Party Name** | 'room' | 'rooms' (plural) |
| **Debounce** | 1200ms / 8000ms | 1000ms / 5000ms |
| **R2 Backups** | Implemented in guide | NOT implemented |
| **Alarm API** | Used for R2 backups | NOT used |

---

## Appendix B: File Checklist

**Root:**
- ✅ `wrangler.toml` - Worker configuration
- ✅ `package.json` - Root workspace config
- ✅ `tsconfig.json` - Root TypeScript config
- ✅ `tsconfig.base.json` - Base TypeScript config

**Worker:**
- ✅ `worker/src/index.ts` - Worker entry point
- ✅ `worker/src/parties/room.ts` - Durable Object class
- ✅ `worker/package.json` - Worker dependencies
- ✅ `worker/tsconfig.json` - Worker TypeScript config

**Client:**
- ✅ `client/vite.config.ts` - Vite configuration (with proxy)
- ✅ `client/src/lib/room-doc-manager.ts` - YProvider setup
- ✅ `client/src/lib/config-schema.ts` - Config validation
- ✅ `client/package.json` - Client dependencies
- ✅ `client/tsconfig.json` - Client TypeScript config
- ✅ `client/.env.local` - Environment variables

**Shared:**
- ✅ `packages/shared/package.json` - Shared dependencies
- ✅ `packages/shared/tsconfig.json` - Shared TypeScript config

---
```
Investigation: How /room/customurlroom Creates a Room
Step 1: Browser URL (Client-Side Routing)
User types in browser: http://localhost:3000/room/customurlroom
// App.tsx line 166
<Route path="/room/:roomId" element={<RoomPage />} />
Step 2: RoomPage Extracts roomId
// RoomPage.tsx line 159
const { roomId } = useParams<{ roomId: string }>();
// roomId = 'customurlroom' (extracted from URL path)

// Line 185
<RoomCanvas roomId={roomId} />  
// Passes 'customurlroom' down
Step 3: Canvas Uses roomId
// Canvas.tsx (imports useRoomDoc)
const room = useRoomDoc(roomId);  // roomId = 'customurlroom'
Step 4: Registry Creates RoomDocManager
// use-room-doc.ts line 28
managerRef.current = registry.acquire(roomId);  
// Creates RoomDocManager with roomId='customurlroom'
Step 5: RoomDocManager Constructor
// room-doc-manager.ts line 262-274
constructor(roomId: RoomId, options?: RoomDocManagerOptions) {
  this.roomId = roomId;  // Stores 'customurlroom'
  
  // Y.Doc guid MUST match roomId
  this.ydoc = new Y.Doc({ guid: roomId });  // guid='customurlroom'
  
  // ...initialization
}
Step 6: WebSocket Provider Initialization
// room-doc-manager.ts line 1701-1717
private initializeWebSocketProvider(): void {
  const host = clientConfig.VITE_PARTY_HOST || window.location.host;
  // host = 'localhost:3000' (from .env.local)

  this.websocketProvider = new YProvider(
    host,           // 'localhost:3000'
    this.roomId,    // 'customurlroom'
    this.ydoc,      // Y.Doc with guid='customurlroom'
    {
      party: 'rooms',  // MUST match wrangler.toml binding
      ...
    }
  );
}
Step 7: YProvider Constructs WebSocket URL
Key Question: What URL does YProvider actually construct? Based on PartyKit URL pattern: /parties/{party}/{room} Constructed WebSocket URL:
ws://localhost:3000/parties/rooms/customurlroom
Critical Distinction:
Browser URL (what user types): /room/customurlroom ← CLIENT-SIDE React route
WebSocket URL (YProvider connects to): /parties/rooms/customurlroom ← SERVER connection
These are TWO DIFFERENT URLs!
Step 8: Vite Proxy
// vite.config.ts
proxy: {
  '/parties': {
    target: 'ws://localhost:8787',
    ws: true
  }
}
Forwards:
ws://localhost:3000/parties/rooms/customurlroom
→ ws://localhost:8787/parties/rooms/customurlroom
Step 9: Worker Receives Request
// worker/src/index.ts
const response = await routeParty kitRequest(request, env);
Request URL: /parties/rooms/customurlroom routePartykitRequest parses:
party = 'rooms'
room = 'customurlroom'
Step 10: Durable Object Routing
const id = env.rooms.idFromName('customurlroom');
const stub = env.rooms.get(id);
return stub.fetch(request);
Is this deterministic? YES - idFromName('customurlroom') ALWAYS returns the same DO ID for the same input string.