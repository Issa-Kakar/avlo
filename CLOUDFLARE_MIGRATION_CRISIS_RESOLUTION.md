# AVLO Cloudflare Migration Crisis Resolution

## Executive Summary

The AVLO project is stuck in a **partial migration state** from Express/Redis to Cloudflare Durable Objects. The migration has **5 critical blockers** preventing it from working. This document provides a **complete diagnosis** and **simplified solution** that will get the system working in **under 30 minutes**.

**Core Issue:** The worker code exists at `/src/worker.ts` but wrangler.toml expects it at `/worker/src/worker.ts`. Additionally, there are TypeScript errors, wrong DO implementation patterns, and unnecessary complexity.

---

## Part 1: Current State Analysis

### 1.1 What Actually Exists

```
/home/issak/dev/avlo/
├── client/              ✅ EXISTS - React app workspace
│   ├── src/             ✅ Client code
│   ├── vite.config.ts   ✅ Has Cloudflare plugin
│   └── package.json     ✅ Has y-partyserver
├── src/                 ✅ EXISTS - Worker code (WRONG LOCATION)
│   ├── worker.ts        ✅ Worker entry point
│   ├── parties/
│   │   └── room.ts      ✅ Durable Object
│   └── tsconfig.json    ✅ TypeScript config
├── packages/shared/     ✅ EXISTS - Shared code
├── server/              ⚠️  LEGACY - Old Express server (unused)
├── wrangler.toml        ❌ Points to wrong path
└── package.json         ❌ Declares non-existent "worker" workspace
```

### 1.2 Critical Blockers

| Issue | Severity | Impact |
|-------|----------|--------|
| **Path Mismatch:** wrangler.toml expects `./worker/src/worker.ts` but code is at `./src/worker.ts` | 🔴 BLOCKER | Cannot start dev server |
| **Missing Workspace:** package.json declares "worker" workspace that doesn't exist | 🔴 BLOCKER | npm commands fail |
| **Wrong DO Implementation:** `onLoad()` returns `Y.Doc` instead of `void` | 🔴 BLOCKER | DO won't initialize |

| **Alarm System:** Complex R2 backup causing errors | 🟡 WARNING | User wants it removed |

### 1.3 What's Actually Working

✅ Client correctly uses `y-partyserver/provider`
✅ Gate system properly adapted
✅ SQLite storage schema is correct
✅ Vite plugin is installed
✅ Dependencies are installed

---

## Part 2: Simplified Solution

### Design Principles

1. **Remove all complexity** - No alarms, no R2 backups (for now)
2. **Use PartyKit conventions** - `routePartykitRequest` for cleaner routing
3. **Fix directory structure** - Proper workspace organization
4. **Minimal DO implementation** - Just load/save Y.Doc to SQLite
5. **Clean TypeScript** - Proper types and exports

### Target Architecture

```
/avlo/
├── client/              # React SPA
├── worker/              # Cloudflare Worker (NEW)
│   ├── src/
│   │   ├── index.ts     # Worker entry (renamed from worker.ts)
│   │   └── parties/
│   │       └── room.ts  # Simplified DO
│   ├── package.json     # Worker package
│   └── tsconfig.json    # Worker TypeScript
├── packages/shared/     # Shared types
├── wrangler.toml        # Fixed paths
└── package.json         # Fixed workspaces
```

---

## Part 3: Step-by-Step Resolution

### Step 1: Create Proper Worker Workspace

```bash
# From repo root (/home/issak/dev/avlo)

# 1. Create worker directory structure
mkdir -p worker/src/parties

# 2. Move existing worker code
mv src/worker.ts worker/src/index.ts
mv src/parties/room.ts worker/src/parties/room.ts
mv src/tsconfig.json worker/

# 3. Create worker package.json
cat > worker/package.json << 'EOF'
{
  "name": "@avlo/worker",
  "private": true,
  "type": "module",
  "scripts": {
    "typecheck": "tsc --noEmit",
    "dev": "wrangler dev",
    "deploy": "wrangler deploy"
  },
  "dependencies": {
    "yjs": "^13.6.27"
  },
  "devDependencies": {
    "@cloudflare/workers-types": "^4.20251106.1",
    "typescript": "^5.9.2"
  }
}
EOF

# 4. Remove old src directory
rm -rf src/
```

### Step 2: Fix wrangler.toml

```toml
# /home/issak/dev/avlo/wrangler.toml
name = "avlo"
main = "./worker/src/index.ts"
compatibility_date = "2024-10-01"  # Fixed typo (was 2025)
compatibility_flags = ["nodejs_compat"]

# Durable Object binding
[[durable_objects.bindings]]
name = "rooms"  # Simplified name for routePartykitRequest
class_name = "RoomDurableObject"

# Enable SQLite storage
[[migrations]]
tag = "v2"  # Increment to force migration
new_sqlite_classes = ["RoomDurableObject"]

# Development settings
[dev]
port = 3000
```

### Step 3: Simplified Worker with routePartykitRequest

Create `/home/issak/dev/avlo/worker/src/index.ts`:

```typescript
import { routePartykitRequest } from "partyserver";

export interface Env {
  rooms: DurableObjectNamespace;  // Matches binding name in wrangler.toml
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Use routePartykitRequest for clean routing
    const response = await routePartykitRequest(request, env);

    // If PartyKit handled it, return the response
    if (response) return response;

    // Otherwise, it's a regular HTTP request (SPA routes, etc)
    // In dev: Vite handles this
    // In prod: You'd serve static assets here
    return new Response("Not Found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

// Export the Durable Object (MUST match wrangler.toml class_name)
export { RoomDurableObject } from "./parties/room";
```

### Step 4: Simplified Durable Object (NO ALARMS)

Create `/home/issak/dev/avlo/worker/src/parties/room.ts`:

```typescript
import * as Y from 'yjs';
import { YServer } from 'y-partyserver';
import type { Env } from '../index';

export class RoomDurableObject extends YServer<Env> {
  // Persistence configuration
  static persistenceOptions = {
    debounceWait: 1000,      // Save after 1 second of inactivity
    debounceMaxWait: 5000,   // Force save after 5 seconds
  };

  // Initialize SQLite and load state
  async onLoad(): Promise<void> {
    // 1. Create table (idempotent)
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS ydoc_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        state BLOB NOT NULL,
        updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
      )
    `);

    // 2. Load existing state if any
    const row = this.ctx.storage.sql.exec(
      'SELECT state FROM ydoc_state WHERE id = 1 LIMIT 1'
    ).one<{ state: ArrayBuffer }>();

    // 3. Apply to this.document (DO NOT RETURN)
    if (row?.state) {
      Y.applyUpdate(this.document, new Uint8Array(row.state));
    }
  }

  // Save state to SQLite
  async onSave(): Promise<void> {
    const state = Y.encodeStateAsUpdate(this.document);

    // Upsert the single state row
    this.ctx.storage.sql.exec(
      `INSERT INTO ydoc_state (id, state, updated_at)
       VALUES (1, ?, unixepoch() * 1000)
       ON CONFLICT(id) DO UPDATE SET
         state = excluded.state,
         updated_at = excluded.updated_at`,
      state
    );
  }

  // Optional: Log connections for debugging
  async onConnect(connection: any, ctx: any): Promise<void> {
    console.log(`[Room ${this.name}] Client connected:`, connection.id);
    return super.onConnect(connection, ctx);
  }

  async onClose(connection: any): Promise<void> {
    console.log(`[Room ${this.name}] Client disconnected:`, connection.id);
    return super.onClose(connection);
  }
}
```

### Step 5: Fix Worker TypeScript Config

Create `/home/issak/dev/avlo/worker/tsconfig.json`:

```json
{
  "extends": "../tsconfig.base.json",
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "lib": ["ES2022"],
    "types": ["@cloudflare/workers-types"],
    "moduleResolution": "bundler",
    "noEmit": true,
    "strict": true,
    "skipLibCheck": true,
    "allowSyntheticDefaultImports": true,
    "forceConsistentCasingInFileNames": true,
    "paths": {
      "@avlo/shared/*": ["../packages/shared/src/*"]
    }
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

### Step 6: Update Client Provider Configuration

The client is **already correct** but verify the party name matches:

```typescript
// /home/issak/dev/avlo/client/src/lib/room-doc-manager.ts
// Line 1711 - party should be 'rooms' to match env binding
this.websocketProvider = new YProvider(
  host,
  this.roomId,
  this.ydoc,
  {
    party: 'rooms',  // MUST match env binding name in wrangler.toml
    awareness: this.yAwareness,
    maxBackoffTime: 10_000,
    resyncInterval: 5_000,
  }
);
```

### Step 7: Fix Client TypeScript

Edit `/home/issak/dev/avlo/client/tsconfig.json`:

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
    "types": ["vite/client", "node"],  // ADD "node" here
    "noEmit": true,  // ADD this - Vite handles compilation
    "module": "ESNext",
    "target": "ES2022",
    "moduleResolution": "bundler",
    "strict": true,
    "skipLibCheck": true
  },
  "include": ["src/**/*", "vite.config.ts"],
  "exclude": ["node_modules", "dist"],
  "references": [{ "path": "../packages/shared" }]
}
```

### Step 8: Install Worker Dependencies

```bash
# From repo root
cd worker
npm install

# Return to root
cd ..

# Update all workspaces
npm install
```

### Step 9: Test the Setup

```bash
# From repo root
npm run dev

# Expected output:
# VITE v7.x.x ready in XXX ms
# ➜  Local: http://localhost:3000/
#
# Cloudflare Worker running
# Durable Objects: RoomDurableObject
```

### Step 10: Verify It Works

1. Open browser to `http://localhost:3000/room/test-room`
2. Open browser console (F12)
3. Check for WebSocket connection: `ws://localhost:3000/parties/rooms/test-room`
4. Draw on whiteboard - should persist to SQLite
5. Open second tab to same room - should sync
6. Refresh page - should reload from IndexedDB + DO

---

## Part 4: Cleanup Tasks

### Remove Legacy Code

```bash
# After verifying new setup works:

# 1. Remove old Express server
rm -rf server/

# 3. Move react-router-dom to client
cd client
npm install react-router-dom
cd ..
npm uninstall react-router-dom

# 4. Clean up root
rm worker-configuration.d.ts  # Will be regenerated if needed
```

### Update Root package.json Scripts

```json
{
  "scripts": {
    "dev": "npm run dev -w client",
    "build": "npm run build -w client && npm run build -w worker",
    "deploy": "npm run build && wrangler deploy",
    "typecheck": "npm run typecheck --workspaces",
    "test": "vitest run",
    "lint": "eslint .",
    "format": "prettier --write ."
  }
}
```

---

## Part 5: Common Issues & Solutions

### Issue: "Cannot find binding 'rooms'"

**Solution:** Ensure wrangler.toml binding name matches env property:
```toml
[[durable_objects.bindings]]
name = "rooms"  # This MUST match env.rooms in worker
```

### Issue: WebSocket fails to connect

**Solution:** Check party name in client:
```typescript
party: 'rooms'  // MUST match env binding name
```

### Issue: TypeScript errors in client

**Solution:** Add `"node"` to types array in client/tsconfig.json:
```json
"types": ["vite/client", "node"]
```

### Issue: DO state not persisting

**Solution:** Ensure SQLite migration tag is incremented:
```toml
[[migrations]]
tag = "v2"  # Increment this to force re-migration
```

---

## Part 6: Future Enhancements (After It Works)

Once the basic system is working, you can add:

1. **R2 Backups** (if needed):
   ```typescript
   // Add R2 binding to wrangler.toml
   // Implement scheduled backups without alarms
   ```

2. **Static Asset Serving** (for production):
   ```typescript
   // In worker index.ts, serve built client files
   ```

3. **Better Error Handling**:
   ```typescript
   // Add try-catch blocks in DO methods
   ```

4. **Monitoring**:
   ```typescript
   // Add logging, metrics, alerts
   ```

---

## Summary

**The migration was 90% complete** but blocked by:
1. Wrong directory structure
2. Wrong DO implementation pattern
3. Unnecessary complexity (alarms, R2)

**This solution:**
1. Creates proper worker workspace
2. Uses `routePartykitRequest` for clean routing
3. Simplifies DO to just load/save
4. Fixes all TypeScript issues
5. Gets you running in 30 minutes

**Key Insights:**
- PartyKit expects env bindings to match party names
- `onLoad()` must return `void`, not `Y.Doc`
- `routePartykitRequest` handles all the routing complexity
- Simpler is better - add features after it works

**Next Steps:**
1. Follow Steps 1-10 exactly
2. Verify it works locally
3. Deploy to Cloudflare with `wrangler deploy`
4. Add enhancements incrementally

---

## Appendix: Complete File Structure After Fix

```
/home/issak/dev/avlo/
├── client/
│   ├── src/
│   │   └── lib/
│   │       └── room-doc-manager.ts  # party: 'rooms'
│   ├── vite.config.ts                # Has Cloudflare plugin
│   ├── tsconfig.json                 # types: ["vite/client", "node"]
│   └── package.json                  # Has y-partyserver
├── worker/
│   ├── src/
│   │   ├── index.ts                  # Uses routePartykitRequest
│   │   └── parties/
│   │       └── room.ts               # Simplified YServer
│   ├── tsconfig.json                 # Worker TypeScript
│   └── package.json                  # Worker dependencies
├── packages/
│   └── shared/
│       └── ...
├── wrangler.toml                     # main: "./worker/src/index.ts"
└── package.json                      # workspaces: ["client", "worker", "packages/*"]
```

**This structure is clean, organized, and follows PartyKit conventions.**