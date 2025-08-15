Amazing—perfect time to lock Phase 1 in. Below is an “overly explicit” runbook you can paste to your Claude code agents in your terminal. It’s broken into atomic tasks with exact files, code, commands, acceptance checks, and guardrails so the agents can work safely within scope.

Where you see “(normative)”, that step is mandated by our Avlo spec; I cite the source lines so your agents know what’s non-negotiable.

---

# Phase 1 — Server Foundation (Express + y-websocket + Redis + Prisma)

## 0) Ground rules the agent must internalize (normative)

- Tech/deps to use on the server: `express`, `ws`, `y-websocket`, `redis`, `@prisma/client`, `prisma`, `zod`, `helmet`, `cors`, `express-rate-limit`, `pino`, `@sentry/node`.&#x20;
- Required env: `NODE_ENV`, `PORT`, `DATABASE_URL`, `REDIS_URL`, `ORIGIN_ALLOWLIST`, `SENTRY_DSN` (optional), `APP_VERSION`, `ROOM_TTL_DAYS` (default 14).&#x20;
- WebSocket endpoint is `WS /ws`; clients identify `{ roomId }` and you **must** enforce Origin.&#x20;
- Persist the Y.Doc to Redis **gzip level 4** and define `sizeBytes` as the last persisted **gzip(4) buffer length**; flush cadence 2–3s (≤5s).&#x20;
- Redis is **authoritative**; Postgres is **metadata only** (`id`, `title`, `createdAt`, `lastWriteAt`, `sizeBytes`). Existence is defined by **Redis presence**.&#x20;
- Origin allowlist is a comma-separated list of absolute origins; **no wildcards**.&#x20;
- Per-IP concurrent WS connections ≤ **8**; inbound frame cap **2 MB**; enforce both.&#x20;
- Publish advisory room size stats at most every **5 s** or after **≥100 KB** growth.&#x20;
- Rate-limit room creation to **10 rooms/hour/IP**.&#x20;
- HTTP API routes and semantics (create idempotent 201/200; metadata 404 when Redis missing; rename). &#x20;

> You already added `SENTRY_DSN` to `.env`; the DSN is optional, but when present we must init Sentry early.&#x20;

---

## 1) Prepare environment

Create a root .env.example (placeholders only—no secrets), and make sure .env is gitignored:

# from repo ROOT

cat > .env.example << 'EOF'
NODE_ENV=development
PORT=3000
DATABASE_URL=postgresql://USER:PASS@localhost:5432/avlo
REDIS_URL=redis://localhost:6379
ORIGIN_ALLOWLIST=http://localhost:5173,http://localhost:3000
SENTRY_DSN= # leave blank in example
APP_VERSION=dev
ROOM_TTL_DAYS=14
EOF

# ensure the real .env stays private

grep -qxF '.env' .gitignore || echo '.env' >> .gitignore

Make the server load the root .env early, regardless of working dir. (This avoids the “I ran the workspace from /server so it looked for server/.env” problem.)

# add dotenv if you don't have it yet

npm i -w server dotenv

Create a tiny loader that searches upward for the first .env (root-first):

# server/src/loadEnv.ts

cat > server/src/loadEnv.ts << 'EOF'
import { config } from "dotenv";
import fs from "node:fs";
import path from "node:path";

// Try common locations in order (root first)
const candidates = [
path.resolve(process.cwd(), ".env"), // if you start from root
path.resolve(process.cwd(), "../.env"), // if you start from server/
path.resolve(process.cwd(), "../../.env"), // if bundled/compiled changes cwd
];

for (const p of candidates) {
if (fs.existsSync(p)) {
config({ path: p });
break;
}
}
EOF

Validate and parse env once (so agents don’t guess), keeping Sentry optional:

# server/src/env.ts

cat > server/src/env.ts << 'EOF'
import { z } from "zod";

const schema = z.object({
NODE_ENV: z.string().default("development"),
PORT: z.coerce.number().default(3000),
DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
REDIS_URL: z.string().min(1, "REDIS_URL is required"),
ORIGIN_ALLOWLIST: z.string().min(1, "ORIGIN_ALLOWLIST is required"),
SENTRY_DSN: z.string().optional(), // optional
APP_VERSION: z.string().default("dev"),
ROOM_TTL_DAYS: z.coerce.number().default(14),
});

export const ENV = schema.parse(process.env);
export const ORIGINS = new Set(
ENV.ORIGIN_ALLOWLIST.split(",").map(s => s.trim()).filter(Boolean)
);
EOF

Wire it at the very top of your server entry so everything sees the env values:

// server/src/index.ts
import "./loadEnv"; // <-- FIRST import
import { ENV } from "./env";
// ... your other imports ...

// (unchanged) create app, routes, ws, etc.
// use ENV.PORT, ENV.NODE_ENV, etc.

Sentry stays conditional (since you already put DSN in root .env, this will activate):

// server/src/sentry.ts (if you already have it, just keep it)
import \* as Sentry from "@sentry/node";
import "@sentry/profiling-node";
import type { Express } from "express";
import { ENV } from "./env";

export function initSentry(app: Express) {
if (!ENV.SENTRY_DSN) return; // optional
Sentry.init({
dsn: ENV.SENTRY_DSN,
environment: ENV.NODE_ENV,
release: ENV.APP_VERSION,
tracesSampleRate: 0.1,
profilesSampleRate: 0.1,
sendDefaultPii: true,
});
app.use(Sentry.Handlers.requestHandler());
app.use(Sentry.Handlers.tracingHandler());
}

export function sentryErrorHandler() {
return Sentry.Handlers.errorHandler();
}

And in your entry:

// server/src/index.ts
import "./loadEnv";
import { initSentry, sentryErrorHandler } from "./sentry";
// ...
const app = createHttpApp();
initSentry(app);
// mount routes...
app.use(sentryErrorHandler()); // last

## 2) Install server deps (pin per spec)

**Agent: in `server/` run**

```bash
npm i express ws y-websocket redis @prisma/client cors express-rate-limit helmet pino pino-http zod
npm i -D prisma typescript tsx @types/express @types/ws @types/cors @sentry/node @sentry/profiling-node
```

These packages/versions are the approved stack for the server.&#x20;

---

## 3) Prisma model + migration (metadata only, non-authoritative)

**Agent: initialize Prisma**

```bash
npx prisma init --datasource-provider postgresql
```

**Agent: edit `server/prisma/schema.prisma`**

```prisma
datasource db { provider = "postgresql"; url = env("DATABASE_URL") }
generator client { provider = "prisma-client-js" }

model Room {
  id          String   @id        // roomId
  title       String   @db.VarChar(120)
  createdAt   DateTime @default(now())
  lastWriteAt DateTime @updatedAt
  sizeBytes   Int
}
```

This reflects the **metadata fields**; Redis remains the source of truth for room existence and content.&#x20;

**Agent: migrate & generate**

```bash
npm run db:generate --workspace=.
npx prisma migrate dev -n init_rooms
```

---

## 4) Redis client + gzip(4) persistence helpers (normative)

**Agent: create `server/src/redis.ts`**

```ts
import { createClient } from 'redis';

export const redis = createClient({ url: process.env.REDIS_URL });
export async function connectRedis() {
  redis.on('error', (e) => console.error('Redis error', e));
  if (!redis.isOpen) await redis.connect();
}
```

**Agent: create `server/src/yjs-persistence.ts`**

```ts
import type { PrismaClient } from '@prisma/client';
import { redis } from './redis';
import { gzip } from 'node:zlib';
import { promisify } from 'node:util';
const gzipAsync = promisify(gzip);

const ROOM_TTL_DAYS = parseInt(process.env.ROOM_TTL_DAYS ?? '14', 10);
const ROOM_TTL_SECONDS = ROOM_TTL_DAYS * 24 * 60 * 60;

// Persist binary Y.Doc to Redis with gzip(4) and upsert metadata.sizeBytes
export async function persistYDoc(prisma: PrismaClient, roomId: string, ydocBinary: Buffer) {
  const compressed = await gzipAsync(ydocBinary, { level: 4 }); // gzip(4) (normative)
  await redis.set(`room:${roomId}`, compressed, { EX: ROOM_TTL_SECONDS, KEEPTTL: false });

  await prisma.room.upsert({
    where: { id: roomId },
    update: { sizeBytes: compressed.length, lastWriteAt: new Date() },
    create: {
      id: roomId,
      title: roomId,
      createdAt: new Date(),
      lastWriteAt: new Date(),
      sizeBytes: compressed.length,
    },
  });

  return compressed.length; // sizeBytes semantics: gzip(4) byte length (normative)
}
```

The gzip level and `sizeBytes` semantics are **mandated**. The upsert path is also specified.&#x20;

---

## 5) HTTP server scaffolding (Express, security, logging, health)

**Agent: create `server/src/http.ts`**

```ts
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import pino from 'pino';
import pinoHttp from 'pino-http';

const log = pino({ level: process.env.LOG_LEVEL ?? 'info' });

export function createHttpApp() {
  const app = express();

  // Required to get correct client IP for per-IP caps/rate limits
  app.set('trust proxy', 1); // normative
  // CSP + core security headers (Profile A default)
  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          defaultSrc: ["'self'"],
          imgSrc: ["'self'", 'data:'],
          styleSrc: ["'self'", "'unsafe-inline'"],
          scriptSrc: ["'self'", "'wasm-unsafe-eval'"],
          workerSrc: ["'self'"],
          connectSrc: ["'self'", 'https:', 'wss:'],
          frameAncestors: ["'none'"],
        },
      },
      referrerPolicy: { policy: 'no-referrer' },
    }),
  );

  // CORS (we'll validate Origin explicitly below, too)
  app.use(cors({ origin: originValidator }));

  app.use(express.json({ limit: '1mb' }));
  app.use(pinoHttp({ logger: log }));

  // Health/Readiness
  app.get('/healthz', (_req, res) => res.status(200).json({ ok: true }));
  app.get('/readyz', (_req, res) => res.status(200).json({ ok: true }));

  return app;
}

// Parse ORIGIN_ALLOWLIST (comma-separated absolute origins; no wildcards)
function parseAllowlist(): Set<string> {
  const list = (process.env.ORIGIN_ALLOWLIST ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return new Set(list);
}
export const originAllowlist = parseAllowlist();

export function originValidator(
  origin: unknown,
  cb?: (err: Error | null, allowed?: boolean) => void,
) {
  if (typeof origin !== 'string') return cb ? cb(null, true) : true; // same-origin/no Origin
  const allowed = originAllowlist.has(origin);
  return cb ? cb(null, allowed) : allowed;
}
```

- `trust proxy` requirement: **normative**.&#x20;
- CSP/headers profile and “no referrer”: **normative**.&#x20;
- Validate Origin against allowlist (HTTP + WS): **normative**.&#x20;

---

## 6) Sentry initialization (optional but supported)

**Agent: create `server/src/sentry.ts`**

```ts
import * as Sentry from '@sentry/node';
import '@sentry/profiling-node';

export function initSentry(app: import('express').Express) {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return; // Optional per spec

  Sentry.init({
    dsn,
    tracesSampleRate: 0.1, // adjust if needed later
    profilesSampleRate: 0.1,
    environment: process.env.NODE_ENV,
    release: process.env.APP_VERSION,
    sendDefaultPii: true,
  });

  app.use(Sentry.Handlers.requestHandler());
  app.use(Sentry.Handlers.tracingHandler());
}

export function sentryErrorHandler() {
  return Sentry.Handlers.errorHandler();
}
```

Sentry DSN is explicitly listed as optional in our env set.&#x20;

---

## 7) API contracts (create, metadata, rename) with rate limiting

**Agent: create `server/src/api.ts`**

```ts
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import type { PrismaClient } from '@prisma/client';
import type { Express } from 'express';
import { originAllowlist } from './http';

const createRoomLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 10 }); // normative

const Id = z.string().regex(/^[A-Za-z0-9_\-]+$/);
const Title = z.string().max(120);

export function mountApi(app: Express, prisma: PrismaClient) {
  // guard all HTTP by Origin allowlist (explicit, in addition to CORS)
  app.use((req, res, next) => {
    const origin = req.headers.origin as string | undefined;
    if (!origin || originAllowlist.has(origin)) return next();
    return res.status(403).json({ error: 'origin_not_allowed' });
  });

  app.post('/api/rooms', createRoomLimiter, async (req, res) => {
    const body = z.object({ id: Id.optional(), title: Title.optional() }).parse(req.body);
    const roomId = body.id ?? cryptoRandomId();

    // idempotent create: if exists in Redis later, we still return 200 with shareLink (handled by client/WS path)
    await prisma.room.upsert({
      where: { id: roomId },
      update: { title: body.title ?? roomId },
      create: { id: roomId, title: body.title ?? roomId, sizeBytes: 0 },
    });

    const payload = { roomId, shareLink: `/rooms/${roomId}` };
    // Use 201 for first-time create; 200 if already existed
    // (A real Redis existence check can drive status; keeping simple here)
    return res.status(201).json(payload);
  });

  app.get('/api/rooms/:id/metadata', async (req, res) => {
    const id = Id.parse(req.params.id);
    // Redis presence defines existence; return 404 if missing (even if DB row exists)
    // In practice you’d check Redis key room:<id> here; we stub 404 to match rule.
    return res.status(404).json({ error: 'not_found' });
  });

  app.put('/api/rooms/:id', async (req, res) => {
    const id = Id.parse(req.params.id);
    const { title } = z.object({ title: Title }).parse(req.body);
    const row = await prisma.room.update({ where: { id }, data: { title } }).catch(() => null);
    if (!row) return res.status(404).json({ error: 'not_found' });
    return res.status(200).json({ ok: true });
  });
}

function cryptoRandomId() {
  // simple nanoid-ish: use crypto if available; replace with nanoid if preferred
  return Math.random().toString(36).slice(2, 10);
}
```

- API shapes and semantics are **normative**: id regex, 201 vs 200 for idempotent create, metadata 404 when Redis key missing. &#x20;
- Rate limit “10 rooms/hour/IP” is **required**.&#x20;

> Note: In your real code, check Redis for `room:<id>` in `GET /metadata` to decide 404 vs 200; the spec requires 404 if Redis is absent even if a DB row exists.&#x20;

---

## 8) y-websocket gateway + hygiene (WS caps, Origin, stats)

**Agent: create `server/src/ws.ts`**

```ts
import { WebSocketServer } from 'ws';
import type { Server } from 'http';
import { originAllowlist } from './http';

const MAX_FRAME = 2 * 1024 * 1024; // 2 MB (normative)
const MAX_WS_PER_IP = 8; // normative

const ipCounts = new Map<string, number>();
function getIp(req: any) {
  const fwd = (req.headers['x-forwarded-for'] || '').split(',')[0]?.trim();
  return fwd || req.socket.remoteAddress;
}

export function attachWs(server: Server) {
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws, req) => {
    const origin = req.headers.origin as string | undefined;
    if (origin && !originAllowlist.has(origin)) {
      ws.close(); // origin not allowed
      return;
    }

    const ip = getIp(req);
    const count = (ipCounts.get(ip) ?? 0) + 1;
    ipCounts.set(ip, count);
    if (count > MAX_WS_PER_IP) {
      ws.close();
      ipCounts.set(ip, count - 1);
      return;
    }

    ws.on('message', (msg: Buffer) => {
      if (msg.length > MAX_FRAME) {
        ws.close();
        return;
      }
      // You will connect this to y-websocket's awareness/update flow.
    });

    ws.on('close', () => {
      ipCounts.set(ip, (ipCounts.get(ip) ?? 1) - 1);
    });
  });

  return wss;
}
```

- Frame cap, per-IP cap, Origin enforcement are **normative**. &#x20;
- The spec also provides a room stats publisher snippet; adapt it to broadcast `{type:"room_stats", bytes, cap}` at most every 5s or ≥100KB change. &#x20;

---

## 9) Wire it all together (Sentry, Prisma, Redis, HTTP, WS)

**Agent: create `server/src/index.ts`**

```ts
import http from 'node:http';
import { createHttpApp, originAllowlist } from './http';
import { initSentry, sentryErrorHandler } from './sentry';
import { attachWs } from './ws';
import { connectRedis } from './redis';
import { PrismaClient } from '@prisma/client';
import { mountApi } from './api';

async function main() {
  const app = createHttpApp();
  initSentry(app); // optional based on SENTRY_DSN

  const prisma = new PrismaClient();
  await connectRedis();

  mountApi(app, prisma);

  // Sentry error handler last
  app.use(sentryErrorHandler());

  const server = http.createServer(app);
  attachWs(server);

  const port = parseInt(process.env.PORT ?? '3000', 10);
  server.listen(port, () => {
    console.log(`Server listening on http://localhost:${port}`);
    console.log(`Origin allowlist: ${[...originAllowlist].join(', ') || '(empty)'}`);
  });

  // Graceful shutdown
  const shutdown = async () => {
    console.log('Shutting down…');
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

---

## 10) Integrate y-websocket with Redis persistence (hook flush)

Use the official `y-websocket` server. Add hooks so that when the Y.Doc state changes (debounced \~2–3s), you compress and persist via `persistYDoc(...)`. The spec includes an **illustrative** gzip(4) writeState function—your implementation should follow it.&#x20;

**Agent: create `server/src/yjs-server.ts` (sketch)**

```ts
// Pseudocode scaffold — attach to your ws and persist periodically
// Import the y-websocket server and bind to your wss instance.
// On each accepted Yjs update, debounce-save the room's doc:
//   const size = await persistYDoc(prisma, roomId, ydoc.encodeStateAsUpdate(...));
// Then maybePublishRoomStats(roomId, size, 10*1024*1024);
```

**Normative details to honor while implementing:**

- Flush cadence target **2–3 s** (≤5 s worst).&#x20;
- `sizeBytes` = length of last **gzip(4)** buffer stored.&#x20;
- TTL extends only on **accepted writes**; presence/viewing does not.&#x20;

---

## 11) Map gateway errors & read-only states (for later client)

While Phase 1 focuses server-side, your gateway hygiene must be able to emit these statuses for the client in Phase 2/8:

- `room_full` at capacity 105.
- Close connection when inbound frame > 2 MB (`offline_delta_too_large`).
- Enforce **per-IP WS ≤ 8**.
  These caps are **normative**.&#x20;

---

## 12) Start scripts and run

Ensure server workspace has:

```json
// server/package.json (already aligned in spec)
{
  "name": "avlo-server",
  "type": "module",
  "private": true,
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc",
    "start": "node dist/index.js"
  }
}
```

These scripts/stack are in the canonical overview.&#x20;

**Agent: run**

```bash
# From repo root after Phase 0 baseline exists
npm run dev --workspace=server
```

---

## 13) Acceptance checklist the agent must verify (Phase 1)

- Disallowed origins are rejected at **both** HTTP and WS.&#x20;
- WS rejects frames > **2 MB**; per-IP concurrent WS limited to **8**.&#x20;
- `GET /api/rooms/:id/metadata` returns **404** when the Redis doc is missing (even if DB row exists). &#x20;
- `POST /api/rooms` with an existing id returns **200** idempotently; new rooms **201** and respond with `{ roomId, shareLink }`.&#x20;
- With sustained edits, the server publishes `room_stats` to clients at least every **5 s** or after **≥100 KB** increase.&#x20;

---

## 14) Guardrails / invariants to assert in PRs

- Never store raw Y.Doc without gzip(4). **All accounting** uses compressed length.&#x20;
- Room TTL derived from `ROOM_TTL_DAYS`; **only** accepted writes extend TTL.&#x20;
- Enforce Origin allowlist for **HTTP + WS**; **no wildcards** accepted. &#x20;
- Rate-limit room creation: 10/h per IP.&#x20;
- Logs/counters must **never** include document content (non-content observability only).&#x20;

---

## 15) Copy-paste prompts for Claude Code (execute one at a time)

> **Prompt A — Create server scaffolding**
>
> - Add files exactly as described in steps 3–9 (`src/http.ts`, `src/sentry.ts`, `src/api.ts`, `src/redis.ts`, `src/yjs-persistence.ts`, `src/ws.ts`, `src/index.ts`).
> - Use the normative constraints (cited).
> - Don’t introduce any other dependencies or features.
>
> **Success conditions:** server compiles; `/healthz` returns `{ ok: true }`.

> **Prompt B — Prisma model + migrations**
>
> - Create the `Room` Prisma model as specified and run a migration named `init_rooms`.
> - Generate Prisma client and import it where appropriate.

> **Prompt C — Wire rate limits and Origin enforcement**
>
> - Apply the `createRoomLimiter` to `POST /api/rooms`.
> - Block HTTP requests whose `Origin` header is not in `ORIGIN_ALLOWLIST`.
> - Ensure WS path `/ws` enforces the same allowlist, frame cap, and per-IP cap.

> **Prompt D — Add gzip(4) persistence hook**
>
> - Add a debounced flush (2–3 s) on Y.Doc updates that persists to Redis with gzip level 4 and upserts `sizeBytes`.
> - Implement room stats broadcast at most every 5 s or after ≥100 KB increase.

> **Prompt E — Sentry**
>
> - Initialize Sentry only if `SENTRY_DSN` is present; add request/tracing handlers and error handler as shown.

> **Prompt F — Acceptance test checklist**
>
> - Manually verify: CORS/Origin rejection, WS frame cap, per-IP cap, metadata 404, create 201/200 idempotency, and stats cadence.

---

## 16) Local manual test script (what to type)

```bash
# 1) Start Postgres + Redis locally (compose or services)
# 2) Run the server
npm run dev --workspace=server

# 3) Smoke test HTTP
curl -i http://localhost:3000/healthz
curl -i -X POST http://localhost:3000/api/rooms -H "Content-Type: application/json" -d '{"title":"My Room"}'

# 4) Try an Origin-forbidden request
curl -i -H "Origin: http://evil.example" http://localhost:3000/api/rooms

# 5) (Optional) WS test with wscat and oversize frame to ensure close at >2MB
```

---

## 17) “Definition of Done” for Phase 1 PR

- **Server boots** with Express, `WS /ws`, Sentry (if DSN present), pino logging. (Env set aligns with spec.)&#x20;
- **Metadata DB** present with `Room` model; **no document content** stored in Postgres.&#x20;
- **Redis persistence** uses gzip level 4; `sizeBytes` reflects compressed length; TTL extended only on write. &#x20;
- **Origin allowlist** enforced for HTTP & WS; no wildcards; per-IP ≤8; frame cap 2MB. &#x20;
- **API** implements create/metadata/rename with idempotency and rate limits (10/h). &#x20;
- **Room stats** broadcast cadence implemented (5s or ≥100 KB).&#x20;

---

## 18) Common pitfalls the agent must avoid

- **Do not** compute `sizeBytes` from uncompressed buffers (must be gzip(4)).&#x20;
- **Do not** extend TTL on view/presence or reads; only on accepted writes.&#x20;
- **Do not** allow any Origin not in `ORIGIN_ALLOWLIST` (including `*`).&#x20;
- **Do not** exceed per-IP 8 WS connections; enforce close on 2MB frames.&#x20;
- **Do not** log or store document content in logs/metrics. Observe counters only.&#x20;
