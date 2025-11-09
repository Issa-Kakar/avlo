# AVLO Cloudflare Implementation - Actual Current State

**Status:** Development Architecture (NOT Production)
## Executive Summary

This document describes the **new current implementation** of AVLO's Cloudflare Worker architecture based on direct code inspection. 

- We  switched to a serverless Cloudflare Durable Objects architecture with y-partyserver. This migration will provide horizontal scalability, edge computing benefits, and significant cost reductions while maintaining all current functionality.
The implementation uses a two-server development architecture with Wrangler (port 8787) handling Worker/Durable Objects and Vite (port 3000) serving the client and proxying WebSocket connections.

---

## 1. New Backend Architecture Overview

### 1.1 Development Architecture 

```
┌─────────────────────────────────────────────────┐
│              Browser (Client)                    │
│  React App connects to localhost:3000            │
│  URL: /room/:roomId (React Router)               │
│  WebSocket: ws://localhost:3000/parties/rooms/*  │
└─────────────────────────────────────────────────┘
                      │
                      ↓ Port 3000
┌─────────────────────────────────────────────────┐
│         Vite Dev Server (Port 3000)              │
│  - Serves client application                     │
│  - NO Cloudflare plugin used                     │
│  - NO React plugin configured                    │
│  - Proxies /parties/* → localhost:8787           │
└─────────────────────────────────────────────────┘
                      │
                      ↓ Proxy to 8787
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
---

## 2. Project Structure


avlo/
├── worker/                          # Cloudflare Worker workspace
│   ├── src/
│   │   ├── index.ts                # Worker entry point
│   │   └── parties/
│   │       └── room.ts             # RoomDurableObject class

also worker/src contains types(look below)

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
---

## 2. Configuration Files (ACTUAL)

### 2.1 wrangler.toml
```toml
name = "avlo"
main = "./worker/src/index.ts"
compatibility_date = "2024-10-01"
compatibility_flags = ["nodejs_compat"]

[[durable_objects.bindings]]
name = "rooms"                    # MUST match client party name
class_name = "RoomDurableObject"

[[migrations]]
tag = "v2"
new_sqlite_classes = ["RoomDurableObject"]

[dev]
port = 3000  # IGNORED - overridden by CLI flag
```

### 2.2 client/vite.config.ts
```typescript
import { defineConfig } from 'vite';
import path from 'path';

export default defineConfig({
  plugins: [
    // EMPTY - No plugins configured
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
      '/parties': {
        target: 'ws://localhost:8787',
        ws: true,
        changeOrigin: true
      },
      '/parties/*': {
        target: 'http://localhost:8787',
        changeOrigin: true
      }
    }
  }
});
```

### 2.3 package.json Scripts
```json
{
  "dev": "concurrently \"npm run dev:worker\" \"npm run dev:client\"",
  "dev:worker": "wrangler dev --port 8787",  // Overrides wrangler.toml port
  "dev:client": "npm run dev -w client"
}
```

---

## 3. Worker Implementation

### 3.1 Worker Entry Point (worker/src/index.ts)

```typescript
/// <reference types="@cloudflare/workers-types" />

import { routePartykitRequest } from "partyserver";

/**
 * Environment bindings for this worker
 */
export interface Env {
  // Required: Durable Object namespace binding
  rooms: DurableObjectNamespace;
  // Allow additional properties for PartyKit compatibility
  [key: string]: unknown;
}

/**
 * Main Cloudflare Worker handler
 */
export default {
  async fetch(
    request: Request,
    env: Env,
    _ctx: ExecutionContext // Prefix with _ to indicate intentionally unused
  ): Promise<Response> {
    // Validate that required bindings are present
    if (!env.rooms) {
      console.error("Missing 'rooms' DurableObject binding in wrangler.toml");
      return new Response("Server configuration error", { status: 500 });
    }

    try {
      // Route WebSocket/PartyKit requests to the appropriate Durable Object
      const response = await routePartykitRequest(request, env);

      // If PartyKit handled the request, return its response
      if (response) {
        return response;
      }

      // Handle non-WebSocket requests
      // In production: Serve static assets from here
      // In development: This shouldn't be reached as Vite handles these
      return new Response("Not Found", { status: 404 });
    } catch (error) {
      console.error("Worker error:", error);
      return new Response("Internal Server Error", { status: 500 });
    }
  },
} satisfies ExportedHandler<Env>;

// Export the Durable Object class
// MUST match the class_name in wrangler.toml
export { RoomDurableObject } from "./parties/room";
```
- `routePartykitRequest(request, env)` handles routing to Durable Objects
- `env.rooms` binding MUST exist (validated at runtime)
- Export of `RoomDurableObject` MUST match `class_name` in wrangler.toml
- No manual URL parsing needed - PartyServer handles routing

**CRITICAL: WORKER MODULE DECLARATION**
### 3.2 Worker module declaration (worker/src/types.d.ts)
```typescript
/// <reference types="@cloudflare/workers-types" />

/**
 * Module declaration for the cloudflare:workers virtual module
 * This module only exists at runtime in the Cloudflare Workers environment
 * PartyServer imports DurableObject from this module
 */
declare module "cloudflare:workers" {
  // DurableObject class that PartyServer's Server extends
  export class DurableObject {
    constructor(ctx: DurableObjectState, env: any);

    // Optional handler methods
    fetch?(request: Request): Response | Promise<Response>;
    alarm?(): void | Promise<void>;
    webSocketMessage?(ws: WebSocket, message: string | ArrayBuffer): void | Promise<void>;
    webSocketClose?(ws: WebSocket, code: number, reason: string, wasClean: boolean): void | Promise<void>;
    webSocketError?(ws: WebSocket, error: unknown): void | Promise<void>;
  }
}
```

### 3.2 Durable Object (worker/src/parties/room.ts)

```typescript
import * as Y from 'yjs';
import { YServer } from 'y-partyserver';
import type { Env } from '../index';

export class RoomDurableObject extends YServer<Env> {
  static callbackOptions = { debounceWait: 1000, debounceMaxWait: 5000 };

  async onLoad(): Promise<void> {
    // SQLite table creation and Y.Doc loading
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS ydoc_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        state BLOB NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);

    // Load existing state if present
    const cur = this.ctx.storage.sql.exec(
      'SELECT state FROM ydoc_state WHERE id = 1 LIMIT 1'
    );
    const row = cur.toArray()[0];
    if (row?.state) {
      const buf = row.state instanceof Uint8Array ? row.state : new Uint8Array(row.state);
      Y.applyUpdate(this.document, buf);
    }
  }

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

## 4. Client Implementation

### 4.1 YProvider Connection (client/src/lib/room-doc-manager.ts)

```typescript
import YProvider from 'y-partyserver/provider';

private initializeWebSocketProvider(): void {
  const host = clientConfig.VITE_PARTY_HOST || window.location.host;

  this.websocketProvider = new YProvider(
    host,          // 'localhost:3000' from .env.local
    this.roomId,   // Room ID from React Router param
    this.ydoc,
    {
      party: 'rooms',  // MUST match wrangler.toml binding name
      awareness: this.yAwareness,
      maxBackoffTime: 10_000,
      resyncInterval: 5_000,
    }
  );
}
```

### 4.2 Environment Configuration (client/.env.local)
```
VITE_PARTY_HOST=localhost:3000  # Optional, defaults to window.location.host
```

---

## 5. URL Routing & Data Flow

### 5.1 Two Distinct URL Patterns

1. **Browser URL (React Router):** `/room/:roomId`
2. **WebSocket URL (PartyKit):** `/parties/rooms/:roomId`


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

---

## 9. Critical Implementation Details

### 9.1 Why Two Servers?

The separated architecture exists because:
1. Wrangler properly provides Durable Object bindings (`env.rooms`)
2. Vite serves the client application with HMR
3. Proxy allows WebSocket passthrough while maintaining client dev experience

### 9.2 Party Name Binding Chain

Must match across three locations:
1. `wrangler.toml`: `name = "rooms"`
2. Worker interface: `rooms: DurableObjectNamespace`
3. Client YProvider: `party: 'rooms'`

Mismatch causes "binding not found" errors.

### 9.3 Room ID Determinism

- `env.rooms.idFromName(roomId)` always returns same DO ID for same input
- Ensures consistent routing across connections
- DO persists until evicted (with SQLite storage surviving eviction)

---

## 10. Development Workflow

### 10.1 Starting Development

```bash
npm run dev
# Runs: concurrently "npm run dev:worker" "npm run dev:client"
```

Result:
- Wrangler starts on port 8787 with Worker + Durable Objects
- Vite starts on port 3000 with client + proxy
- Both run in same terminal with colored output

---

## 11. Comprehensive Dependency Architecture

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

### 3.5 Critical Version Requirements

| Package | Constraint | Reason |
|---------|-----------|--------|
| `vite` | `≥7.0.0` | Required by `@cloudflare/vite-plugin` (even though we don't use it) |
| `vitest` | `≥4.0.0` | Must match Vite major version for compatibility |
| `partyserver` | `0.0.75` | Provides `routePartykitRequest` function |
| `y-partyserver` | `0.0.51` | Provides `YServer` base class and `YProvider` client |
| `yjs` | `^13.6.27` | Consistent across all workspaces |
```

### 11.4 TypeScript Configuration Architecture

**Inheritance Chain:**

tsconfig.base.json (root configuration)
    ├── tsconfig.json (root workspace reference)
    ├── client/tsconfig.json
    ├── worker/tsconfig.json
    ├── packages/shared/tsconfig.json
    └── server/tsconfig.json (UNUSED)
```

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
---
## Appendix: Worker Files File Checklist
**Worker:**
- ✅ `worker/src/index.ts` - Worker entry point
- ✅ `worker/src/parties/room.ts` - Durable Object class
- ✅ `worker/package.json` - Worker dependencies
- ✅ `worker/tsconfig.json` - Worker TypeScript config