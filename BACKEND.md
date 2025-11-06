# AVLO Backend & Frontend Integration Architecture

## Stack Overview

### Backend
**Runtime:** Node.js (ES Modules)
**Framework:** Express 4
**CRDT Sync:** Yjs + `@y/websocket-server` (v0.1.x)
**Persistence:** Redis (gzip-compressed Y.Doc state) + PostgreSQL (non-authoritative metadata)
**Validation:** Zod v4
**ORM:** Prisma 6
**Total Backend LOC:** ~1,027 (excluding tests, node_modules)

### Frontend
**Runtime:** React 18.3.1 + TypeScript 5.9.2
**Build Tool:** Vite 5.4.11 (dev server + bundler)
**Routing:** React Router v6
**Styling:** Tailwind CSS 3.4.17
**State:** Zustand 5.0.8 (device-local UI), Yjs (shared CRDT state)
**Queries:** TanStack Query v5
**CRDT Client:** Yjs + y-websocket + y-indexeddb + y-webrtc (dormant)
**Validation:** Zod v4

---

## Architecture

```
Client (Browser)
  ├─→ HTTP REST API (/api/*)     → Express routes → Prisma + Redis
  └─→ WebSocket (/ws/<roomId>)   → y-websocket → Yjs Y.Doc ⇄ Redis
```

**Entry Point:** [/server/src/index.ts](server/src/index.ts:1)
- Creates HTTP server with Express
- Mounts REST API routes
- Delegates WebSocket handling to `setupWebSocketServer()`
- Serves static files in production

---

## Environment Configuration

**File:** [/server/src/config/env.ts](server/src/config/env.ts:1)

**Zod Schema (`ServerEnvSchema`):**
```typescript
{
  PORT: number (default: 3001),
  ORIGIN_ALLOWLIST: string[] (parsed from CSV),
  REDIS_URL: string (required),
  DATABASE_URL: string (required),
  ROOM_TTL_DAYS: number (1-90, default: 14),
  WS_MAX_FRAME_BYTES: number (default: 2MB),
  MAX_CLIENTS_PER_ROOM: number (default: 105),
  GZIP_LEVEL: number (1-9, default: 4)
}
```

**Validation:** Runs at startup via `validateServerEnv()`. Exits with error details on failure.

**Access:** `req.app.locals.env` (middleware stores validated env in app locals)

---

## Data Flow: Write Path

1. **Client Drawing Tool** commits stroke → `roomDoc.mutate(fn)` wrapper
2. **Yjs Transaction** → `Y.Doc.transact()` generates update event
3. **WebSocket Server** observes update → debounces (100ms) → persists to Redis
4. **Redis:** Gzip-compressed `Y.encodeStateAsUpdate()` with TTL (14 days default)
5. **PostgreSQL:** Metadata upserted (`sizeBytes`, `lastWriteAt`)
6. **Broadcast:** y-websocket multicasts delta to all room clients

**Debouncing:** 100ms debounce on `doc.on('update')` to batch rapid writes
**Cleanup:** Final persist on last client disconnect

---

## PostgreSQL Layer

**File:** [/server/prisma/schema.prisma](server/prisma/schema.prisma:1)

**Single Model:**
```prisma
model RoomMetadata {
  id          String   @id      // Room ULID
  title       String   @default("")
  createdAt   DateTime @default(now())
  lastWriteAt DateTime @default(now())
  sizeBytes   Int      @default(0)  // Compressed size in Redis

  @@index([lastWriteAt(sort: Desc)])
}
```

**Role:** Non-authoritative metadata only. Redis is source of truth for room existence.

**Client:** [/server/src/lib/prisma.ts](server/src/lib/prisma.ts:1) - Singleton PrismaClient with query logging in dev

**Connection:** Pool managed by Prisma (DATABASE_URL from env)

---

## Redis Layer

**File:** [/server/src/lib/redis.ts](server/src/lib/redis.ts:1)

**Key Pattern:** `room:<roomId>` (e.g., `room:01FZQY8XABC123`)

**Operations:**
```typescript
class RedisAdapter {
  async saveRoom(roomId, docState: Uint8Array): Promise<number>
    // Gzip compress → SETEX with TTL → return compressed size

  async loadRoom(roomId): Promise<Uint8Array | null>
    // GET → gunzip → return Uint8Array or null

  async extendTTL(roomId): Promise<boolean>
    // EXPIRE with fresh TTL (room activity extends expiry)

  async exists(roomId): Promise<boolean>
    // EXISTS check (used for /metadata endpoint)
}
```

**Compression:** Node.js native `zlib.gzip()` with configurable level (default: 4)
**Type Safety:** Redis client configured with `RESP_TYPES.BLOB_STRING: Buffer` type mapping
**Singleton:** `getRedisAdapter(env)` ensures single connection per process
**Reconnection:** Exponential backoff (100ms * retries, max 3s), fails after 10 attempts

---

## WebSocket Server

**File:** [/server/src/websocket-server.ts](server/src/websocket-server.ts:1)

**Protocol:** Raw WebSocket (library: `ws` v8) with y-websocket message format

**URL Pattern:** `/ws/<roomId>` (extracted via regex)

**Connection Flow:**
1. **Path Validation:** Reject if not `/ws/<roomId>`
2. **Origin Check:** CORS via `req.headers.origin` against `ORIGIN_ALLOWLIST` (allows `*.trycloudflare.com`)
3. **Capacity Guard:** Reject if room has ≥ `MAX_CLIENTS_PER_ROOM` (sends `room_full` JSON before close)
4. **Y.Doc Retrieval:** `getYDoc(roomId)` from `@y/websocket-server` (singleton per roomId)
5. **Redis Load (First Client):** If first connection, load state via `redis.loadRoom()` → `Y.applyUpdate(doc, savedState)`
6. **y-websocket Setup:** `setupWSConnection(ws, req, { docName: roomId })`
7. **Persistence Handler (First Client):** Attach `doc.on('update')` with 100ms debounce → `redis.saveRoom()` + Prisma metadata upsert
8. **Disconnect Cleanup:** Remove from `roomConnections` map, detach update handler, final persist, y-websocket GC handles Y.Doc cleanup

**Connection Tracking:** `Map<roomId, Set<WebSocket>>` for per-room client sets

**Frame Limit:** `maxPayload: WS_MAX_FRAME_BYTES` (default 2MB) to reject oversized updates

---

## REST API Routes

**Base:** `/api/*`

### POST /api/rooms
**Handler:** [/server/src/routes/rooms.ts:19](server/src/routes/rooms.ts:19)
**Body Schema:** `CreateRoomSchema` - `{ title?: string (max 120) }`
**Logic:**
- Generate ULID via `ulid()`
- Create `RoomMetadata` in Postgres
- Return JSON: `{ id, title, createdAt, lastWriteAt, sizeBytes: 0 }`

**No Redis write** - Room created on-demand when first client connects via WebSocket

### GET /api/rooms/:id/metadata
**Handler:** [/server/src/routes/rooms.ts:48](server/src/routes/rooms.ts:48)
**Logic:**
1. Check Redis `exists(id)` (authoritative) → 404 if missing
2. Fetch `RoomMetadata` from Postgres (create minimal if missing)
3. Calculate `expiresAt = lastWriteAt + ROOM_TTL_DAYS`
4. Return JSON: `{ id, title, createdAt, lastWriteAt, sizeBytes, expiresAt }`

**Authoritative Check:** Redis existence determines room validity, not Postgres

### PUT /api/rooms/:id/rename
**Handler:** [/server/src/routes/rooms.ts:95](server/src/routes/rooms.ts:95)
**Body Schema:** `RenameRoomSchema` - `{ title: string (max 120) }`
**Logic:**
- Update `RoomMetadata.title` in Postgres
- Return `{ title }`

**No room existence check** - Allows renaming expired rooms (metadata-only operation)

### GET /api/healthz
**Handler:** [/server/src/routes/health.ts:7](server/src/routes/health.ts:7)
**Logic:**
- Ping Redis via `redis.ping()`
- Query Postgres via `prisma.$queryRaw`
- Return `{ status: 'ok', phase: 6, services: { redis: bool, postgres: bool } }`
- HTTP 503 if either service fails

---

## Middleware Stack

**File:** [/server/src/middleware/index.ts](server/src/middleware/index.ts:1)

**Order (top to bottom):**
1. **Env Storage:** `app.locals.env = env` (makes validated env accessible in routes)
2. **CORS:** Dynamic origin check against `ORIGIN_ALLOWLIST` + `*.trycloudflare.com` wildcard, credentials enabled
3. **Body Parser:** `express.json({ limit: '1mb' })`
4. **Security Headers:** `X-Content-Type-Options`, `X-Frame-Options`, `X-XSS-Protection`, `Referrer-Policy`, HSTS (production + HTTPS only)
5. **Request Logging:** Dev-only via `console.log` (quiet in production)

---

## Frontend Architecture & URL Formation

### React Router Setup

**File:** [/client/src/App.tsx](client/src/App.tsx:156)

**Route Structure:**
```tsx
<RoomDocRegistryProvider>  {/* Global singleton registry for all room managers */}
  <Routes>
    <Route path="/" element={<TestHarness />} />           {/* Dev: fixed 'dev' roomId */}
    <Route path="/test" element={<TestHarness />} />       {/* Dev test harness */}
    <Route path="/room/:roomId" element={<RoomPage />} />  {/* Production route */}
  </Routes>
</RoomDocRegistryProvider>
```

**Room ID Extraction:** [/client/src/pages/RoomPage.tsx](client/src/pages/RoomPage.tsx:159)
```tsx
const { roomId } = useParams<{ roomId: string }>();  // React Router extracts from URL
// RoomPage → useRoomDoc(roomId) → Registry.acquire(roomId) → RoomDocManager instance
```

**Registry Pattern:** [/client/src/lib/room-doc-registry-context.tsx](client/src/lib/room-doc-registry-context.tsx:23)
- Single `RoomDocManagerRegistry` created at app root via React Context
- `useRoomDoc(roomId)` hook acquires/releases manager refs (ref-counted lifecycle)
- Manager persists across re-renders, destroyed when all refs released

**Navigation Model:** No landing page - users navigate directly to `/room/<roomId>` via shared links

**Room Creation Flow (Currently Manual):**
1. External tool generates ULID or calls `POST /api/rooms` → receives `roomId`
2. User navigates to `https://example.com/room/<roomId>`
3. Frontend auto-joins via WebSocket (room created on-demand if first client)

---

### URL Formation: Development vs Production

#### Development Mode (Vite Dev Server)

**Config:** [/client/vite.config.ts](client/vite.config.ts:27)

```typescript
server: {
  port: 3000,  // Client dev server
  proxy: {
    '/api': 'http://localhost:3001',  // HTTP API proxied to backend
    '/ws': {
      target: 'ws://localhost:3001',  // WebSocket upgraded to backend
      ws: true,
      changeOrigin: true,
    },
  },
}
```

**Result:**
- Frontend at `http://localhost:3000`
- Backend at `http://localhost:3001`
- Vite transparently proxies all `/api` and `/ws` requests
- Client code uses relative paths (`/api/rooms`, `/ws/<roomId>`)

#### Production Mode (Static Build)

**Config:** [/client/vite.config.ts](client/vite.config.ts:13)

```typescript
build: {
  outDir: '../server/public',  // Build directly into server's public directory
  emptyOutDir: true,
}
```

**Deployment:** [/server/src/index.ts](server/src/index.ts:28)
```typescript
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(__dirname, '../public')));  // Serve React build
  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '../public/index.html'));  // SPA fallback
  });
}
```

**Result:**
- Single origin at `:3001`
- Express serves static assets + SPA
- No proxy needed (same origin for API/WebSocket)

---

### WebSocket URL Construction

**File:** [/client/src/lib/room-doc-manager.ts](client/src/lib/room-doc-manager.ts:1901)

**Method:** `buildWebSocketUrl(basePath: string): string`

**Algorithm:**
1. **Override Check:** If `VITE_WS_URL` env var exists (e.g., Cloudflare tunnel), use directly:
   ```typescript
   if (clientConfig.VITE_WS_URL) {
     return clientConfig.VITE_WS_URL.replace(/\/$/, '');  // Strip trailing slash
   }
   ```

2. **Absolute URL Check:** If `basePath` starts with `ws://` or `wss://`, return as-is

3. **Dynamic Construction from `window.location`:**
   ```typescript
   const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
   const host = window.location.host;  // includes port
   const cleanPath = basePath.startsWith('/') ? basePath : `/${basePath}`;
   return `${protocol}//${host}${cleanPath}`;
   // Dev:  ws://localhost:3000/ws
   // Prod: wss://example.com/ws
   ```

**y-websocket Provider Instantiation:** [/client/src/lib/room-doc-manager.ts](client/src/lib/room-doc-manager.ts:1721)
```typescript
this.websocketProvider = new WebsocketProvider(
  wsUrl,        // Base URL: ws://localhost:3000/ws (or wss://tunnel.com/ws)
  this.roomId,  // Room ID: '01FZQY8XABC123'
  this.ydoc,    // y-websocket APPENDS roomId: ws://localhost:3000/ws/01FZQY8XABC123
  { awareness: this.yAwareness }
);
```

**Environment Variables:** [/client/.env.local](client/.env.local:1)
```env
VITE_WS_BASE=/ws              # Relative path (proxied in dev, direct in prod)
VITE_API_BASE=/api            # Relative path for HTTP API
VITE_WS_URL=                  # Optional: Direct WebSocket URL (for cloudflare tunnels)
```

**Cloudflare Tunnel Example:** [/client/.env.tunnel.example](client/.env.tunnel.example:1)
```env
VITE_WS_URL=wss://tunnel-abc123.trycloudflare.com/ws  # Overrides window.location logic
```
- **Dev:** Vite proxy at `:3000` upgrades WebSocket to backend `:3001`
- **Prod:** Same origin, WebSocket connects directly to Express server
- **Tunnel:** Direct URL override bypasses proxy/origin detection

---

## Client Integration

### API Client

**File:** [/client/src/lib/api-client.ts](client/src/lib/api-client.ts:1)

**Class:** `ApiClient` (singleton export as `apiClient`)

**Methods:**
- `getRoomMetadata(roomId)` → `RoomMetadata`
- `createRoom(title?)` → `RoomMetadata`
- `renameRoom(roomId, title)` → `{ title }`

**Base URL:** `clientConfig.VITE_API_BASE` (default: `/api`, configurable via env)

**Validation:** All responses validated via Zod `RoomMetadataSchema`

**Error Handling:** 404 → `"Room not found or expired"`, others → `"API error: {status}"`

---

### TanStack Query Integration

**Setup:** [/client/src/main.tsx](client/src/main.tsx:8)
```typescript
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 10_000,      // 10s freshness window
      retry: 1,               // Single retry on failure
      refetchOnWindowFocus: false,
    },
  },
});
```

**Hook:** [/client/src/hooks/use-room-metadata.ts](client/src/hooks/use-room-metadata.ts:1)

**Query Key:** `['rooms', 'metadata', roomId]`

**Behavior:**
- `refetchInterval: 10_000` (poll every 10s for size/expiry updates)
- Side effect: Updates `room.setRoomStats()` from RoomDocManager on data change
- Detects expiry: Sets stats to `null` if error message includes `"not found"`

**Mutation Hook:** `useRenameRoom(roomId)`
- Invalidates query cache on success to trigger refetch

---
**Environment Handling:** Detects browser (`import.meta.env`) vs Node (`process.env`)

---

## Shared Schemas

**File:** [/packages/shared/src/schemas/index.ts](packages/shared/src/schemas/index.ts:1)

**Zod Schemas:**
- `CreateRoomSchema` - POST body validation
- `RoomMetadataSchema` - API response shape
- `WSControlFrameSchema` - Future WebSocket control messages (discriminated union)

**Usage:** Server validates incoming requests, client validates API responses

---

## Request Flow Examples

### Creating a Room
```
Client: POST /api/rooms { "title": "Brainstorm" }
  ↓
Express: Zod validates body
  ↓
Prisma: INSERT RoomMetadata (id=ULID, title="Brainstorm")
  ↓
Response: { id: "01FZ...", title: "Brainstorm", sizeBytes: 0, ... }
```

### Joining a Room (Complete Frontend → Backend Flow)
```
User navigates to: https://example.com/room/01FZ...
  ↓
React Router: useParams() extracts roomId="01FZ..."
  ↓
RoomPage: useRoomDoc("01FZ...") hook
  ↓
Registry: acquire("01FZ...") → creates RoomDocManager if not exists
  ↓
RoomDocManager constructor:
  1. Create Y.Doc({ guid: "01FZ..." })
  2. Attach IndexeddbPersistence (local offline cache)
  3. Attach WebsocketProvider:
     - buildWebSocketUrl("/ws") → ws://localhost:3000/ws
     - new WebsocketProvider(wsUrl, "01FZ...", ydoc)
     - y-websocket appends roomId → ws://localhost:3000/ws/01FZ...
  4. Wait for gates: idbReady AND (wsSynced OR 350ms grace)
  5. Seed Y.Doc structures if empty (first client)
  6. Start RAF publish loop for snapshot updates
  ↓
[WebSocket connection established]
  ↓
Server: Origin check → Capacity check → Pass
  ↓
y-websocket server: getYDoc("01FZ...") [creates singleton Y.Doc if new]
  ↓
Redis: loadRoom("01FZ...") → Uint8Array state (or null if new room)
  ↓
Yjs: Y.applyUpdate(doc, state) [hydrate from Redis if exists]
  ↓
y-websocket: setupWSConnection(ws, req) [sync client ↔ server Y.Docs]
  ↓
Server: Attach doc.on('update') listener (first client only) → debounce → Redis persist
  ↓
Client: wsSynced gate opens → RoomDocManager publishes first snapshot → UI renders
```

**Key Insight:** Frontend "creates" room implicitly by connecting WebSocket. Backend creates Y.Doc + loads Redis state on first connection. Metadata row created either via `POST /api/rooms` beforehand OR by first WebSocket write (upsert in persist handler).

### Drawing a Stroke
```
Client: Yjs transaction → encodes delta
  ↓
y-websocket client: Sends binary frame
  ↓
Server: y-websocket broadcasts to all clients in room
  ↓
Server: doc.on('update') fires → debounce timer starts (100ms)
  ↓
After 100ms: redis.saveRoom() + prisma.upsert(sizeBytes, lastWriteAt)

```

**Server Env:** Loaded via `dotenv/config` in [index.ts](server/src/index.ts:1), validated by Zod

**Shared Config:** [/packages/shared/src/config.ts](packages/shared/src/config.ts:1) - 514 lines of frozen constants

---

## Dependencies

**Server package.json:** [/server/package.json](server/package.json:1)

**Runtime:**
- `express` ^4.21.2
- `@y/websocket-server` ^0.1.1 (Yjs WebSocket server bindings)
- `yjs` ^13.6.27 (CRDT library, peer dependency)
- `ws` ^8.18.3 (WebSocket server implementation)
- `redis` ^5.8.2 (Redis client with type mapping)
- `@prisma/client` ^6.15.0
- `zod` ^4.1.5
- `ulid` ^3.0.1 (Room ID generation)
- `cors` ^2.8.5
- `dotenv` ^16.4.7

**Dev:**
- `prisma` ^6.15.0 (migrations + client generation)
- `tsx` (TypeScript runner for `npm run dev`)

**Client package.json:** [/client/package.json](client/package.json:1)

**Query/API:**
- `@tanstack/react-query` ^5.85.5
- `zod` ^4.1.1 (response validation)

---

**Room Access:** `http://localhost:3000/room/<roomId>` or `http://localhost:3000/` (test harness)
**API Test:** `curl http://localhost:3000/api/healthz` (proxied to `:3001`)
**WebSocket:** Client constructs `ws://localhost:3000/ws/<roomId>` → Vite upgrades to `ws://localhost:3001/ws/<roomId>

---

---
