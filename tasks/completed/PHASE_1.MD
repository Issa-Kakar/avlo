# Phase 1 — **AGENT TASKFILE** (Server + Sentry)

---

## A. Objective → What you are building

Stand up the **server foundation**: Express app, official **y‑websocket** gateway, **Redis authoritative** persistence with **gzip(4)**, **Prisma/PostgreSQL** for non‑authoritative metadata, **strict origin allowlist** (HTTP + WS), **rate‑limited** Room API, **health** endpoints, **WS hygiene** (≤8 per‑IP, 2 MB inbound frame cap), **room\_stats** advisories, and **Sentry** (errors + breadcrumbs only; no content logging).

---

## B. Stop conditions (when to stop coding)

Stop when **all checks in Section Q** pass locally. Do not implement UI, PWA, strict CSP/HSTS, export features, executors, or any AI endpoints.

---

## C. Tooling & prerequisites (no guessing)

* **Node.js ≥ 18.16** (LTS). Verify: `node -v`.
* **Package manager:** npm (OK) or pnpm/yarn if already set. Use the repo's default.
* **TypeScript runtime:** tsx available in dev (if not: `npm -w server i -D tsx typescript`).
* **Process env:** Root `.env` contains: `NODE_ENV`, `PORT`, `DATABASE_URL`, `REDIS_URL`, `ORIGIN_ALLOWLIST`, `SENTRY_DSN` (optional), `APP_VERSION`, `ROOM_TTL_DAYS` (default 14).
* **Required deps:** `express ws yjs y-websocket redis @prisma/client prisma zod helmet cors express-rate-limit pino pino-http dotenv @sentry/node`.

**Install all deps (run this first):**
```bash
npm -w server i express ws yjs y-websocket @y/websocket-server redis @prisma/client zod helmet cors express-rate-limit pino pino-http dotenv @sentry/node
npm -w server i -D prisma tsx typescript @types/express @types/ws @types/cors
```

---

## D. Git hygiene (run)

```bash
git checkout -b feat/phase-1-server-foundation
```

---

## E. Create file layout (exactly)

```
server/
  prisma/
    schema.prisma
  src/
    index.ts                 # Express bootstrap + HTTP routes + bind WS
    sentry.ts                # Sentry init + request/error handlers
    obs.ts                   # Breadcrumb helpers (no content)
    ws.ts                    # WS gateway (y-websocket + hygiene + identify + query fallback)
    yjs-hooks.ts             # gzip(4) persistence + Redis + Prisma upsert + stats events + debounced flush
    routes/
      rooms.ts               # POST /api/rooms; GET metadata; PUT rename
    util/
      origin.ts              # isAllowedOrigin(csv)
      ip.ts                  # getClientIp(req)
    clients/
      prisma.ts              # Prisma singleton
      redis.ts               # Redis singleton
```

Create the files below **verbatim**.

---

## F. Prisma schema (authoritative Redis; DB is metadata)

**File:** `server/prisma/schema.prisma`

```prisma
datasource db { provider = "postgresql"; url = env("DATABASE_URL") }

generator client { provider = "prisma-client-js" }

model Room {
  id          String   @id
  title       String   @db.VarChar(120)
  createdAt   DateTime @default(now())
  lastWriteAt DateTime
  sizeBytes   Int
}
```

**Run:**

```bash
npx prisma generate
npx prisma migrate dev --name init_phase1
```

---

## G. Sentry (minimal, safe, early)

**File:** `server/src/sentry.ts`

```ts
import * as Sentry from '@sentry/node';

Sentry.init({
  dsn: process.env.SENTRY_DSN || undefined,
  environment: process.env.NODE_ENV || 'development',
  release: process.env.APP_VERSION,
  tracesSampleRate: 0.02,
  sendDefaultPii: false,
  beforeSend(event) {
    if (event.request) {
      delete (event.request as any).data;
      delete (event.request as any).headers;
    }
    return event;
  },
});

export const sentry = Sentry;
export const sentryHandlers = {
  request: Sentry.Handlers.requestHandler(),
  error: Sentry.Handlers.errorHandler(),
};
```

**File:** `server/src/obs.ts`

```ts
import { sentry } from './sentry';
export const crumb = (message: string, category = 'gateway', level: 'info' as const) =>
  sentry.addBreadcrumb({ message, category, level });
export const capture = (err: unknown, hint?: string) => {
  if (hint) crumb(hint, 'error', 'error');
  sentry.captureException(err);
};
```

---

## H. Clients (singletons; no per‑request connects)

**File:** `server/src/clients/prisma.ts`

```ts
import { PrismaClient } from '@prisma/client';
export const prisma = new PrismaClient();
```

**File:** `server/src/clients/redis.ts`

```ts
import { createClient } from 'redis';
export const redis = createClient({ url: process.env.REDIS_URL });
await redis.connect();
```

---

## I. Express bootstrap (middleware order is mandatory)

**File:** `server/src/index.ts`

```ts
import 'dotenv/config';
import './sentry';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import pinoHttp from 'pino-http';
import { sentryHandlers } from './sentry';
import { isAllowedOrigin } from './util/origin';
import { registerWsGateway } from './ws';
import roomsRouter from './routes/rooms';
import { prisma } from './clients/prisma';
import { redis } from './clients/redis';

const app = express();
app.set('trust proxy', 1);
app.use(sentryHandlers.request); // FIRST
app.use(pinoHttp({ redact: { paths: ['req.headers','req.body','res.headers'], remove: true } }));
app.use(express.json({ limit: '1mb' }));

const allowlistCsv = process.env.ORIGIN_ALLOWLIST || '';
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, false); // disallow non-browser by default
    cb(null, isAllowedOrigin(origin, allowlistCsv));
  },
  credentials: false,
}));
app.use(helmet());

// Serve static files from server/public (client build output)
app.use(express.static('public'));

app.get('/healthz', (_req, res) => res.json({ ok: true }));
app.get('/readyz', async (_req, res) => {
  try { 
    await redis.ping(); 
    await prisma.$queryRaw`SELECT 1`;
    return res.json({ ok: true, degraded: { db: false } });
  } catch (e) {
    // Check which service is down
    let redisOk = true, dbOk = true;
    try { await redis.ping(); } catch { redisOk = false; }
    try { await prisma.$queryRaw`SELECT 1`; } catch { dbOk = false; }
    
    if (!redisOk) {
      return res.status(503).json({ ok: false, degraded: { redis: true, db: !dbOk } });
    }
    return res.json({ ok: true, degraded: { db: true } });
  }
});

app.use('/api/rooms', roomsRouter);
app.use(sentryHandlers.error); // LAST

const server = app.listen(process.env.PORT || 3000, () => console.log('server listening'));
registerWsGateway(server, allowlistCsv);

// Graceful shutdown: flush, then close
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
async function shutdown() {
  try { await prisma.$disconnect(); } catch {}
  try { await redis.quit(); } catch {}
  server.close(()=>process.exit(0));
}
```

---

## J. Utilities

**File:** `server/src/util/origin.ts`

```ts
export function isAllowedOrigin(origin: string | undefined, csv: string) {
  if (!origin) return false;
  const list = csv.split(',').map(s => s.trim()).filter(Boolean);
  try { const u = new URL(origin); return list.includes(`${u.protocol}//${u.host}`); } catch { return false; }
}
```

**File:** `server/src/util/ip.ts`

```ts
import type { IncomingMessage } from 'http';
export function getClientIp(req: IncomingMessage) {
  const fwd = (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim();
  return fwd || (req.socket as any).remoteAddress || '';
}
```

---

## K. Persistence (gzip(4) + Redis authoritative + Prisma upsert + stats + debounced flush)

**Goals:**

* Write **binary gzip(4)** into Redis key `room:<roomId>`.
* Compute `sizeBytes` from **compressed** length.
* Extend TTL **only on accepted writes** (not in read‑only state).
* Debounce flushes: **\~2 s** cadence, **≤5 s** worst‑case.
* Publish `room_stats` ≤5 s or ≥100 KB growth.

**File:** `server/src/yjs-hooks.ts`

```ts
import { gzip, gunzip } from 'node:zlib';
import { promisify } from 'node:util';
import { EventEmitter } from 'node:events';
import { prisma } from './clients/prisma';
import { redis } from './clients/redis';
import { crumb, capture } from './obs';

export const yjsEvents = new EventEmitter();
const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

const TTL_SECONDS = (parseInt(process.env.ROOM_TTL_DAYS || '14', 10)) * 24 * 60 * 60;
const HARD_CAP = 10 * 1024 * 1024; // 10MB
const STATS_DELTA = 100 * 1024; // 100KB

const timers = new Map<string, NodeJS.Timeout>();
const lastFlushAt = new Map<string, number>();
const lastBytes = new Map<string, number>();

export function scheduleWrite(roomId: string, producer: () => Uint8Array) {
  const now = Date.now();
  const prev = lastFlushAt.get(roomId) || 0;
  const dueIn = Math.max(0, 2000 - (now - prev)); // ~2s debounce
  clearTimeout(timers.get(roomId) as any);
  const t = setTimeout(() => flush(roomId, producer), Math.min(dueIn, 5000)); // ≤5s worst
  timers.set(roomId, t);
}

async function flush(roomId: string, producer: () => Uint8Array) {
  try {
    const binary = Buffer.from(producer());
    const compressed = await gzipAsync(binary, { level: 4 });
    const bytes = (compressed as Buffer).length;

    const isReadOnly = bytes >= HARD_CAP;
    if (!isReadOnly) {
      await redis.set(`room:${roomId}`, compressed as Buffer, { EX: TTL_SECONDS });
      await prisma.room.upsert({
        where: { id: roomId },
        update: { sizeBytes: bytes, lastWriteAt: new Date() },
        create: { id: roomId, title: roomId, createdAt: new Date(), lastWriteAt: new Date(), sizeBytes: bytes },
      });
      crumb('redis_write_accept');
    } else {
      crumb('redis_write_skip_readonly', 'gateway', 'warning');
    }

    // room_stats cadence
    const prevBytes = lastBytes.get(roomId) || 0;
    const prevAt = lastFlushAt.get(roomId) || 0;
    const now = Date.now();
    if (now - prevAt >= 5000 || Math.abs(bytes - prevBytes) >= STATS_DELTA) {
      yjsEvents.emit('room_stats', { roomId, bytes, cap: HARD_CAP });
      crumb('room_stats_publish');
      lastBytes.set(roomId, bytes);
      lastFlushAt.set(roomId, now);
    } else {
      lastFlushAt.set(roomId, now);
    }

    if (isReadOnly) yjsEvents.emit('readonly', { roomId });
  } catch (e) { capture(e, 'prisma_upsert_fail'); }
}

export async function loadState(roomId: string): Promise<Uint8Array | null> {
  try {
    const compressed = await redis.getBuffer(`room:${roomId}`);
    if (!compressed) return null;
    const decompressed = await gunzipAsync(compressed);
    return new Uint8Array(decompressed);
  } catch (e) {
    capture(e, 'redis_load_fail');
    return null;
  }
}
```

---

## L. WebSocket gateway (y‑websocket + hygiene + identify + URL fallback)

**Behavior to enforce:**

* **Origin allowlist** on upgrade (absolute origins only; no wildcards).
* **Per‑IP concurrent WS ≤ 8** (reject 9th).
* **Inbound frame cap = 2 MB** (close with `offline_delta_too_large`).
* **Room capacity = 105** (send `room_full`).
* **Hard cap 10 MB** (doc becomes read‑only; awareness still relays) → send `room_full_readonly`.
* **Identify:** accept initial JSON `{ roomId }` **or** `{ type:'identify', roomId }`. For **back‑compat**, also accept `?room=<id>` in URL if the message is not sent within 5s.

**File:** `server/src/ws.ts`

```ts
import { WebSocketServer, WebSocket } from 'ws';
import type { Server, IncomingMessage } from 'http';
import { isAllowedOrigin } from './util/origin';
import { getClientIp } from './util/ip';
import { crumb } from './obs';
import { yjsEvents, scheduleWrite, loadState } from './yjs-hooks';
import * as Y from 'yjs';

// Import from @y/websocket-server (official server for y-websocket v3)
import { setupWSConnection, setPersistence } from '@y/websocket-server/utils';

const MAX_FRAME = 2 * 1024 * 1024; // 2MB
const MAX_IP_CONNS = 8;
const MAX_ROOM_CONNS = 105;
const HARD_CAP = 10 * 1024 * 1024; // 10MB

const ipCounts = new Map<string, number>();
const roomConns = new Map<string, Set<WebSocket>>();

setPersistence({
  bindState: async (docName: string, ydoc: Y.Doc) => {
    // Load existing state from Redis
    const state = await loadState(docName);
    if (state) Y.applyUpdate(ydoc, state);
    
    // Schedule writes on updates
    ydoc.on('update', () => scheduleWrite(docName, () => Y.encodeStateAsUpdate(ydoc)));
  },
  writeState: async (docName: string, ydoc: Y.Doc) => {
    scheduleWrite(docName, () => Y.encodeStateAsUpdate(ydoc));
  }
});

export function registerWsGateway(server: Server, allowlistCsv: string) {
  const wss = new WebSocketServer({ noServer: true });

  // Broadcast advisories
  yjsEvents.on('room_stats', ({ roomId, bytes, cap }) => {
    const conns = roomConns.get(roomId);
    if (!conns) return;
    const msg = JSON.stringify({ type: 'room_stats', bytes, cap });
    for (const ws of conns) { if (ws.readyState === WebSocket.OPEN) try { ws.send(msg); } catch {} }
  });
  yjsEvents.on('readonly', ({ roomId }) => {
    const conns = roomConns.get(roomId);
    if (!conns) return;
    const msg = JSON.stringify({ type: 'room_full_readonly', message: 'Board is read-only — size limit reached.' });
    for (const ws of conns) { if (ws.readyState === WebSocket.OPEN) try { ws.send(msg); } catch {} }
  });

  server.on('upgrade', (req, socket, head) => {
    const origin = req.headers.origin as string | undefined;
    if (!isAllowedOrigin(origin, allowlistCsv)) {
      crumb('origin_reject', 'gateway', 'warning');
      socket.destroy();
      return;
    }
    const ip = getClientIp(req);
    const count = (ipCounts.get(ip) || 0) + 1;
    if (count > MAX_IP_CONNS) {
      crumb('per_ip_ws_cap', 'gateway', 'warning');
      socket.destroy();
      return;
    }
    ipCounts.set(ip, count);

    wss.handleUpgrade(req as any, socket as any, head, (ws) => {
      let roomId: string | null = null;

      // Back‑compat URL query fallback
      const url = new URL((req as any).url, 'http://local');
      const roomFromQuery = url.searchParams.get('room');
      if (roomFromQuery && /^[A-Za-z0-9_\-]+$/.test(roomFromQuery)) roomId = roomFromQuery;

      const identifyTimer = setTimeout(() => { if (!roomId) try { ws.close(1008, 'Identify required'); } catch {} }, 5000);

      const onMessage = (data: Buffer) => {
        if (data.length > MAX_FRAME) {
          crumb('frame_too_large', 'gateway', 'warning');
          try { ws.send(JSON.stringify({ type: 'offline_delta_too_large', message: 'Change too large. Refresh to rejoin.' })); } catch {}
          ws.close(1009, 'Frame too large');
          return;
        }
        if (!roomId) {
          try {
            const j = JSON.parse(data.toString('utf8'));
            const candidate = j?.roomId || (j?.type === 'identify' ? j?.roomId : undefined);
            if (typeof candidate === 'string' && /^[A-Za-z0-9_\-]+$/.test(candidate)) roomId = candidate;
            if (!roomId) return; // keep waiting
          } catch { return; }
        }
        // After identified, let y-websocket handle messages
      };

      ws.on('message', onMessage);

      const afterIdentify = () => {
        if (!roomId) return; // still waiting
        clearTimeout(identifyTimer);
        ws.off('message', onMessage);

        // Room capacity check
        const set = roomConns.get(roomId) || new Set<WebSocket>();
        if (set.size >= MAX_ROOM_CONNS) {
          try { ws.send(JSON.stringify({ type: 'room_full', message: 'Room is full — create a new room.' })); } catch {}
          ws.close(1008, 'Room full');
          return;
        }
        set.add(ws); roomConns.set(roomId, set);

        // Make y-websocket believe the docname is /ws/<roomId>
        (req as any).url = `/ws/${encodeURIComponent(roomId)}`;
        setupWSConnection(ws as any, req as any);
      };

      // Check periodically until identified or closed
      const poll = setInterval(() => {
        if (ws.readyState !== WebSocket.OPEN) return clearInterval(poll);
        if (roomId) { clearInterval(poll); afterIdentify(); }
      }, 50);

      ws.on('close', () => {
        clearTimeout(identifyTimer); clearInterval(poll);
        const ip = getClientIp(req as IncomingMessage);
        ipCounts.set(ip, Math.max(0, (ipCounts.get(ip) || 1) - 1));
        if (roomId) {
          const set = roomConns.get(roomId);
          if (set) { set.delete(ws); if (set.size === 0) roomConns.delete(roomId); }
        }
      });
    });
  });
}
```

---

## M. Rooms API (idempotent create; metadata 404 without Redis; rename ≤120; rate limits)

**Rules:**

* `POST /api/rooms` → **10/hour/IP** cap, **201** on new, **200** if exists (idempotent).
* `GET /api/rooms/:id/metadata` → **404** if Redis key missing (even if DB row exists).
* `PUT /api/rooms/:id` (rename) → **10/hour/IP** cap, title ≤120, requires Redis presence.

**File:** `server/src/routes/rooms.ts`

```ts
import { Router, Request, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { prisma } from '../clients/prisma';
import { redis } from '../clients/redis';
import { capture } from '../obs';

const limiter10h = rateLimit({ windowMs: 60 * 60 * 1000, max: 10 });

const idRe = /^[A-Za-z0-9_\-]+$/;
const createSchema = z.object({ id: z.string().regex(idRe).optional(), title: z.string().max(120).optional() }).strict();
const titleSchema = z.object({ title: z.string().max(120) }).strict();

// Async error wrapper to ensure all errors are caught
const asyncHandler = (fn: Function) => (req: Request, res: Response, next: NextFunction) => {
  Promise.resolve(fn(req, res, next)).catch((err) => {
    capture(err, 'route_error');
    next(err);
  });
};

const router = Router();

router.post('/', limiter10h, asyncHandler(async (req: Request, res: Response) => {
  const parse = createSchema.safeParse(req.body || {});
  if (!parse.success) return res.status(400).json({ error: 'invalid_input' });
  const id = (parse.data.id || crypto.randomUUID()).replace(/-/g, '');
  
  try {
    const existing = await prisma.room.findUnique({ where: { id } });
    if (existing) return res.status(200).json({ roomId: id, shareLink: `/rooms/${id}` });
    await prisma.room.create({ data: { id, title: parse.data.title || id, createdAt: new Date(), lastWriteAt: new Date(), sizeBytes: 0 } });
    return res.status(201).json({ roomId: id, shareLink: `/rooms/${id}` });
  } catch (e) {
    capture(e, 'room_create_error');
    return res.status(500).json({ error: 'internal_error' });
  }
}));

router.get('/:id/metadata', asyncHandler(async (req: Request, res: Response) => {
  const id = req.params.id;
  
  try {
    const buf = await redis.getBuffer(`room:${id}`);
    if (!buf) return res.status(404).json({ error: 'not_found' });
    const r = await prisma.room.findUnique({ where: { id } });
    if (!r) return res.status(404).json({ error: 'not_found' });
    const expiresAt = new Date(r.lastWriteAt.getTime() + (parseInt(process.env.ROOM_TTL_DAYS || '14', 10) * 24 * 60 * 60 * 1000));
    res.json({ title: r.title, size_bytes: r.sizeBytes, created_at: r.createdAt.toISOString(), expires_at: expiresAt.toISOString() });
  } catch (e) {
    capture(e, 'room_metadata_error');
    // If Redis is down but room exists in DB, return degraded response
    if (e && typeof e === 'object' && 'code' in e && e.code === 'ECONNREFUSED') {
      return res.status(503).json({ error: 'service_unavailable' });
    }
    return res.status(500).json({ error: 'internal_error' });
  }
}));

router.put('/:id', limiter10h, asyncHandler(async (req: Request, res: Response) => {
  const id = req.params.id;
  const parse = titleSchema.safeParse(req.body || {});
  if (!parse.success) return res.status(400).json({ error: 'invalid_input' });
  
  try {
    const exists = await redis.exists(`room:${id}`);
    if (!exists) return res.status(404).json({ error: 'not_found' });
    await prisma.room.update({ where: { id }, data: { title: parse.data.title } });
    res.json({ ok: true });
  } catch (e) {
    capture(e, 'room_rename_error');
    return res.status(500).json({ error: 'internal_error' });
  }
}));

export default router;
```

---

## N. Normative constants (baked into the code above)

* WS frame cap = **2 MB** → close with `offline_delta_too_large`.
* Per‑IP concurrent WS ≤ **8**.
* Room capacity = **105** → `room_full` on join.
* Hard size cap = **10 MB** → `room_full_readonly` (updates rejected; awareness relays).
* Soft advisory = **8 MB** (header pill; no toasts below hard cap).
* Flush cadence ≈ **2–3 s** (≤5 s worst); TTL extends **only on accepted writes**.
* `room_stats` published ≤ every **5 s** or on ≥ **100 KB** growth.

---

## O. Error shapes (consistent JSON)

* `400 { "error": "invalid_input" }`
* `404 { "error": "not_found" }`
* `429 { "error": "rate_limited" }` (from limiter)
* `500 { "error": "internal_error" }` (unexpected errors)
* `503 { "error": "service_unavailable" }` (Redis/DB connectivity issues)
* `503 { "ok": false, "degraded": { "redis": true, "db": true } }` (from `/readyz`)

---

## P. Logging & breadcrumbs (do this, and only this)

* **Pino** redacts `req.headers`, `req.body`, `res.headers`.
* **No payloads** (doc contents, bodies) in logs or Sentry.
* Add Sentry **breadcrumbs** when:

  * origin rejected (`origin_reject`)
  * per‑IP cap exceeded (`per_ip_ws_cap`)
  * frame > 2 MB (`frame_too_large`)
  * room\_stats published (`room_stats_publish`)
  * write accepted / skipped (`redis_write_accept` / `redis_write_skip_readonly`)

---

## Q. Run & verify (local)

**Run dev server:**

```bash
npm run dev --workspace=server
```

**Acceptance checklist (must all pass):**

1. **Origin allowlist (HTTP)**

```bash
ORIGIN_ALLOWLIST=http://localhost:5173 node -e "console.log('use .env normally; this is just a demo')"
# In another shell:
curl -i -H "Origin: http://evil.example" http://localhost:3000/healthz | grep -i access-control-allow-origin && echo "SHOULD BE EMPTY"
```

2. **WS frame cap = 2 MB** (script sends 2.1 MB)

```bash
node - <<'NODE'
const WebSocket = require('ws');
const ws = new WebSocket('ws://localhost:3000/ws?room=captest', { headers: { Origin: 'http://localhost:5173' } });
ws.on('open', ()=> ws.send(Buffer.alloc(2.1 * 1024 * 1024)));
ws.on('message', m=>console.log(m.toString()));
ws.on('close', (c,r)=>console.log('closed',c,r?.toString()));
NODE
```

3. **Per‑IP ≤ 8** — open 9 sockets; 9th is rejected/closed.

```bash
node - <<'NODE'
const WebSocket = require('ws');
const conns=[]; let opened=0; let failed=0;
function openOne(i){
  const ws = new WebSocket('ws://localhost:3000/ws?room=captest', { headers: { Origin: 'http://localhost:5173' } });
  ws.on('open', ()=>{ opened++; if(opened<9) openOne(i+1); else console.log('opened',opened,'(expect 8)'); });
  ws.on('error', ()=>{ failed++; });
  conns.push(ws);
}
openOne(0);
NODE
```

4. **Rooms API**

```bash
curl -s -X POST http://localhost:3000/api/rooms -H 'content-type: application/json' -d '{}' | tee /tmp/room.json
RID=$(jq -r .roomId /tmp/room.json)
curl -s http://localhost:3000/api/rooms/$RID/metadata # may be 404 until first accepted write
curl -s -X POST http://localhost:3000/api/rooms -H 'content-type: application/json' -d "{\"id\":\"$RID\"}" # 200 idempotent
curl -s -X PUT http://localhost:3000/api/rooms/$RID -H 'content-type: application/json' -d '{"title":"New Title"}'
```

5. **Metadata 404 when Redis missing** — `DEL room:<id>` then `GET /api/rooms/<id>/metadata` → 404.

6. **room\_stats cadence** — under sustained edits, see `{ type:"room_stats" }` ≤5 s or after ≥100 KB growth.

7. **Sentry** — add a temporary `/boom` route throwing an Error and verify captured without request bodies/headers; remove after.

---

## R. Done = merge‑ready

* All acceptance checks green.
* No content logged (Sentry scrub + pino redaction).
* Code structure and constants match this taskfile.
* Commit and push branch.

---

## S. Critical implementation notes (MUST READ)

**Environment setup:** Copy `.env.example` to `.env` in the root directory before starting. Ensure Redis and PostgreSQL are running locally.

**Dependencies:** The code imports `dotenv`, `pino-http`, and `yjs` - these MUST be installed via the command in Section C before starting.

**y-websocket utils:** Import from @y/websocket-server/utils. Note: y-leveldb is required as a dependency even though we use Redis for persistence.

**Redis state loading:** The `loadState` function is essential for rooms to persist across server restarts. Without it, rooms would start empty on reconnect.

**Async safety:** All route handlers use the `asyncHandler` wrapper to ensure database/Redis errors don't crash the server. Errors are captured to Sentry with appropriate breadcrumbs.

**Static files:** The server serves client assets from `server/public/`. Ensure `npm run bundle:assets` has copied files there after building the client.

---

**End of AGENT TASKFILE.**
