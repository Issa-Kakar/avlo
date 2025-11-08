# IMMEDIATE FIX - Run These Commands NOW

## 30-Second Summary
Your worker code is at `/src/` but wrangler expects `/worker/src/`. Plus the Durable Object has bugs. This fixes everything.

## Copy-Paste These Commands (5 minutes)

```bash
# 1. FIX DIRECTORY STRUCTURE
mkdir -p worker/src/parties
mv src/worker.ts worker/src/index.ts
mv src/parties/room.ts worker/src/parties/room.ts
mv src/tsconfig.json worker/

# 2. CREATE WORKER PACKAGE.JSON
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
    "yjs": "^13.6.27",
    "partyserver": "^0.0.75",
    "y-partyserver": "^0.0.51"
  },
  "devDependencies": {
    "@cloudflare/workers-types": "^4.20251106.1",
    "typescript": "^5.9.2"
  }
}
EOF

# 3. REMOVE OLD SRC
rm -rf src/

# 4. INSTALL DEPENDENCIES
cd worker && npm install && cd ..
npm install
```

## Now Fix These 3 Files

### File 1: `/home/issak/dev/avlo/wrangler.toml`
```toml
name = "avlo"
main = "./worker/src/index.ts"
compatibility_date = "2024-10-01"
compatibility_flags = ["nodejs_compat"]

[[durable_objects.bindings]]
name = "rooms"
class_name = "RoomDurableObject"

[[migrations]]
tag = "v2"
new_sqlite_classes = ["RoomDurableObject"]

[dev]
port = 3000
```

### File 2: `/home/issak/dev/avlo/worker/src/index.ts`
```typescript
import { routePartykitRequest } from "partyserver";

export interface Env {
  rooms: DurableObjectNamespace;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return await routePartykitRequest(request, env) ||
           new Response("Not Found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

export { RoomDurableObject } from "./parties/room";
```

### File 3: `/home/issak/dev/avlo/worker/src/parties/room.ts`
```typescript
import * as Y from 'yjs';
import { YServer } from 'y-partyserver';
import type { Env } from '../index';

export class RoomDurableObject extends YServer<Env> {
  async onLoad(): Promise<void> {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS ydoc_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        state BLOB NOT NULL,
        updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
      )
    `);

    const row = this.ctx.storage.sql.exec(
      'SELECT state FROM ydoc_state WHERE id = 1 LIMIT 1'
    ).one<{ state: ArrayBuffer }>();

    if (row?.state) {
      Y.applyUpdate(this.document, new Uint8Array(row.state));
    }
  }

  async onSave(): Promise<void> {
    const state = Y.encodeStateAsUpdate(this.document);
    this.ctx.storage.sql.exec(
      `INSERT INTO ydoc_state (id, state, updated_at)
       VALUES (1, ?, unixepoch() * 1000)
       ON CONFLICT(id) DO UPDATE SET
         state = excluded.state,
         updated_at = excluded.updated_at`,
      state
    );
  }
}
```

## One Client Change

Edit `/home/issak/dev/avlo/client/src/lib/room-doc-manager.ts` line ~1711:

Change:
```typescript
party: 'room',
```

To:
```typescript
party: 'rooms',  // Match wrangler.toml binding name
```

## Test It

```bash
npm run dev
```

Open `http://localhost:3000/room/test-room`

If you see WebSocket connect in console = SUCCESS! 🎉

## Still Broken?

Check:
1. Did worker/src/index.ts get created?
2. Is wrangler.toml using `main = "./worker/src/index.ts"`?
3. Is client using `party: 'rooms'`?
4. Run `npm ls partyserver` - should show it installed

## Full Details

See [CLOUDFLARE_MIGRATION_CRISIS_RESOLUTION.md](./CLOUDFLARE_MIGRATION_CRISIS_RESOLUTION.md) for complete explanation.