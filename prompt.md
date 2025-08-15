SYSTEM / GOAL
You are working in a Linux shell with NO sudo. Fix the monorepo so installs are deterministic and workspace-correct:
- Root: orchestration only (scripts + Playwright + concurrently). NO runtime server deps at root.
- Server: ALL runtime server deps (Express 4, Prisma 5 client, Redis, ws, y-websocket, Zod 3, etc.) and its own dev tooling.
- Client: Client deps per spec.
- E2E uses @playwright/test at the root; browser is installed to user cache (chromium only), NO --with-deps.

NON-NEGOTIABLES
1) No sudo; do not install OS packages.
2) Stick to spec majors: Express 4, Prisma 5, Zod 3, express-rate-limit 7. Do NOT upgrade to Express 5 / Prisma 6 / Zod 4 unless explicitly told later.
3) Use npm workspaces correctly; no reliance on hoisting.
4) Use `npm ci` (lockfile-driven).
5) Keep `.env` at repo root for local dev; commit `.env.example` only.

REFERENCE (from spec; follow these exact shapes)
- Root scripts present: dev, dev:server, dev:client, build, bundle:assets, db:generate, db:migrate, db:deploy, test:e2e*, e2e:install, e2e:serve.
- copy script: scripts/copy-client-dist.mjs copies client/dist → server/public.
- Server runtime deps: express@4, ws@8, y-websocket@3, redis@5, @prisma/client@5, zod@3, helmet@8, cors@2, express-rate-limit@7, pino, pino-http (+ yjs if used server-side).
- Server dev deps: prisma@5, typescript, tsx, @types/express@4, @types/ws, @types/cors.
- Root dev deps: concurrently, @playwright/test (or playwright if the repo already uses that cli; prefer @playwright/test).
- Playwright: install chromium only; config at repo root; webServer runs `npm run e2e:serve`.

TASK 0 — PRINT CURRENT STATE
- Show: `cat package.json` (root), `cat server/package.json`, `cat client/package.json`.
- Show Playwright config: `ls -la playwright* e2e* || true` and `sed -n '1,200p' playwright.config.* || true`
- Show env samples: `ls -la .env .env.example || true`

TASK 1 — PIN USER-SPACE NODE
- Ensure root `.nvmrc` contains just: `20`. If missing, create it.
- In the current shell:
  ```bash
  if ! command -v nvm >/dev/null 2>&1; then curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash; fi
  . "$HOME/.nvm/nvm.sh"
  nvm install 20
  nvm use 20
  node -v
TASK 2 — FIX ROOT PACKAGE.JSON (NO RUNTIME DEPS)

In root package.json:

Ensure scripts are exactly:

swift
Copy
Edit
"dev": "concurrently \"npm:dev:server\" \"npm:dev:client\"",
"dev:server": "npm run dev --workspace=server",
"dev:client": "npm run dev --workspace=client",
"build": "npm run build --workspace=client && npm run build --workspace=server && npm run bundle:assets",
"bundle:assets": "node scripts/copy-client-dist.mjs",
"db:generate": "npm run prisma:generate --workspace=server",
"db:migrate": "npm run prisma:migrate --workspace=server",
"db:deploy":  "npm run prisma:deploy --workspace=server",
"test:e2e": "playwright test",
"test:e2e:ui": "playwright test --ui",
"test:e2e:report": "playwright show-report",
"e2e:install": "playwright install chromium",
"e2e:serve": "npm run build && node server/dist/index.js"
Root devDependencies should be ONLY:

concurrently

@playwright/test (preferred) OR playwright if this repo already uses that CLI in scripts.

Remove ALL server runtime libraries from the root (express, cors, redis, ws, @prisma/client, helmet, pino, pino-http, zod, express-rate-limit, y-websocket, etc.).

Create/ensure scripts/copy-client-dist.mjs copies client/dist → server/public (idempotent).

TASK 3 — MOVE RUNTIME DEPENDENCIES INTO SERVER WORKSPACE

For any of these found at the root, uninstall them at root and install them scoped to server:

bash
Copy
Edit
# remove from root if present
npm uninstall express cors redis ws @prisma/client helmet pino pino-http zod express-rate-limit y-websocket yjs
# add to server
npm install -w server express@^4 ws@^8 y-websocket@^3 redis@^5 @prisma/client@^5 cors@^2 express-rate-limit@^7 helmet@^8 pino pino-http zod@^3 yjs@^13
In server/package.json, ensure devDependencies include:

json
Copy
Edit
{
  "prisma": "^5",
  "typescript": "^5",
  "tsx": "^4",
  "@types/express": "^4",
  "@types/ws": "^8",
  "@types/cors": "^2"
}
Sentry:

Put @sentry/node in dependencies (it’s used at runtime).

Put @sentry/profiling-node in optionalDependencies and dynamically import it (profiling is optional; absence must not break install or startup).

In code, guard profiling:

ts
Copy
Edit
// server/src/sentry.ts
import * as Sentry from '@sentry/node';
export async function initSentry() {
  const integrations: any[] = [];
  try {
    const mod = await import('@sentry/profiling-node');
    // @ts-ignore optional
    integrations.push(mod.nodeProfilingIntegration());
  } catch {}
  Sentry.init({ dsn: process.env.SENTRY_DSN, enabled: !!process.env.SENTRY_DSN, integrations });
}
Call await initSentry() early in the server bootstrap.

Server scripts must exist:

json
Copy
Edit
"dev": "tsx watch src/index.ts",
"build": "tsc",
"start": "node dist/index.js",
"prisma:generate": "prisma generate",
"prisma:migrate": "prisma migrate dev",
"prisma:deploy":  "prisma migrate deploy"
TASK 4 — CLIENT WORKSPACE CHECK

Ensure the client deps match the spec (React/Vite/Monaco/Y packages, etc.). Do NOT add d3/papaparse/plotly/Radix/clsx/lucide unless the app genuinely uses them.

Keep pako only in client if used there; remove from server.

TASK 5 — PLAYWRIGHT (ROOT)

Ensure @playwright/test is a root devDependency.

Keep "e2e:install": "playwright install chromium" (no --with-deps).

Root playwright.config.ts must use webServer: { command: 'npm run e2e:serve', url: process.env.BASE_URL ?? 'http://localhost:3000' } and a chromium project.

TASK 6 — ENV + NPM BEHAVIOR

Create .env.example at repo root (safe to commit):

NODE_ENV=development
PORT=3000
DATABASE_URL=postgresql://USER:PASS@localhost:5432/avlo
REDIS_URL=redis://localhost:6379
ORIGIN_ALLOWLIST=http://localhost:5173,http://localhost:3000
SENTRY_DSN=                     # leave blank in example
APP_VERSION=dev
ROOM_TTL_DAYS=14

If .env is missing and we only need prisma generate, copy example to .env locally. Do NOT commit .env. # ensure the real .env stays private
grep -qxF '.env' .gitignore || echo '.env' >> .gitignore

Create root .npmrc:

ini
Copy
Edit
omit=optional
fund=false
audit=false
(Installs skip optional/native add-ons by default; on CI/prod you can opt-in via npm ci --include=optional.)

TASK 7 — CLEAN INSTALL & VERIFY (NO SUDO)

bash
Copy
Edit
npm ci
[ -f .env ] || cp .env.example .env
npm run db:generate
npx playwright install chromium
npm run build
npm run test:e2e || echo "If headless browser libs are missing in this shell, tests still pass in CI."
TASK 8 — OUTPUT REPORT

Summarize file changes (paths + diff highlights).

List final deps split by workspace (root dev only; server runtime; server dev; client).

Output Node/npm versions.

Confirm no sudo was required.

Flag any remaining human decisions (e.g., enabling Sentry DSN, database URL for real environments).
END OF PROMPT