# Avlo

A link-based, account-less, offline-first, real-time collaborative whiteboard with an integrated code executor.

## Tech Stack

- **Frontend**: React (Vite), TypeScript, Tailwind, HTML Canvas, Monaco Editor
- **Realtime & Offline**: Yjs CRDT, y-websocket, y-indexeddb
- **Backend**: Node.js, Express, WebSocket, Redis, PostgreSQL (via Prisma)
- **Code Execution**: JavaScript + Python (via Pyodide)

## Realtime Backend

Server uses @y/websocket-server@0.1.x as the y-websocket backend. Import via `@y/websocket-server/utils` (ESM). We install y-leveldb only to satisfy the package's static import; Redis is the only persistence used in production.

Persistence: Redis authoritative (gzip(4), debounced 2–3s, TTL on accepted writes, 10 MB hard read-only, room_stats ≤ 5s or ≥ 100 KB).

Limits enforced: 2 MB frame, ≤ 8 WS/IP, 105 clients/room. Read-only at 10 MB.

Note: Server uses TypeScript `module: NodeNext`. Relative imports include `.js` in source (Node ESM rule).

Note: Client uses y-websocket provider; server uses @y/websocket-server.

## Development Setup

### Prerequisites

- Node.js (v18+)
- PostgreSQL
- Redis

### System Dependencies (Linux/WSL)

For headless E2E testing with Playwright:

```bash
# Minimal deps for headless E2E testing
sudo apt-get install libnspr4 libnss3 libasound2t64
```

### Installation

```bash
# Install dependencies
npm install

# IMPORTANT: Set up environment variables first (see below)

# Option 1: Use the setup script (recommended)
./scripts/setup-dev.sh

# Option 2: Manual setup
npm run db:generate      # Generate Prisma client
npm run db:migrate       # Run database migrations
npm run e2e:install      # Install Playwright browsers

# Start development servers
npm run dev
```

### Environment Variables

⚠️ **CRITICAL**: Never use placeholder values in DATABASE_URL!

Create a `.env` file in the root directory (copy from `.env.example`):

```bash
cp .env.example .env
```

Then edit `.env` with your **actual** database credentials:

```env
NODE_ENV=development
PORT=3000
# REPLACE with your actual PostgreSQL credentials!
DATABASE_URL=postgresql://YOUR_ACTUAL_USERNAME:YOUR_ACTUAL_PASSWORD@localhost:5432/avlo
REDIS_URL=redis://localhost:6379
ORIGIN_ALLOWLIST=http://localhost:5173,http://localhost:3000
ROOM_TTL_DAYS=14
APP_VERSION=0.1.0
SENTRY_DSN=your_sentry_dsn_here (optional)
```

**The server will reject placeholder credentials like `user:password` or `username:password`.**

If you get authentication errors:
1. Check your PostgreSQL credentials: `psql -U postgres -l`
2. Ensure no shell variables override `.env`: `unset DATABASE_URL`
3. Regenerate Prisma client: `cd server && npm run prisma:generate`

## Project Structure

```
avlo/
├── client/          # React frontend
├── server/          # Node.js backend (includes prisma/)
├── scripts/         # Build scripts
├── e2e/            # End-to-end tests
└── package.json    # Monorepo root
```

## Available Scripts

### Development

- `npm run dev` - Start both client and server in development mode
- `npm run dev:client` - Start only the client dev server
- `npm run dev:server` - Start only the server dev server

### Build & Deploy

- `npm run build` - Build both client and server for production
- `npm run bundle:assets` - Copy client dist to server/public (runs automatically in build)

### Database

- `npm run db:generate` - Generate Prisma client (run after schema changes)
- `npm run db:migrate` - Run database migrations in development
- `npm run db:deploy` - Deploy database migrations in production

### Testing

- `npm run test:e2e` - Run Playwright end-to-end tests
- `npm run test:e2e:ui` - Run tests with Playwright UI (interactive mode)
- `npm run test:e2e:report` - Show HTML test report
- `npm run e2e:install` - Install Playwright browsers (required once, uses chromium only in no-sudo environments)
- `npm run e2e:serve` - Build and serve the app for E2E testing

### Code Quality

- `npm run lint` - Run ESLint on all files
- `npm run lint:fix` - Auto-fix ESLint issues
- `npm run format` - Format all files with Prettier
- `npm run format:check` - Check formatting without fixing
- `npm run typecheck` - Run TypeScript type checking

#### Pre-commit Hooks

This project uses Husky and lint-staged for automatic code quality checks on commit:

- ESLint auto-fix for TypeScript/JavaScript files
- Prettier formatting for all supported files
- Prisma schema formatting

Hooks run automatically on `git commit` and complete in <5s. Type checking is intentionally kept in CI only for performance.

## FAQ

### Why not import /bin/utils.js?

The published package on npm does not include /bin; use /utils (ESM) or /dist/utils.cjs (CJS).

### Why is y-leveldb in package.json if we don't use it?

Satisfies static import; runtime uses Redis.

### About crypto.randomUUID()

Node 18+ provides randomUUID() via `node:crypto` import. This project standardizes on node:crypto import.

### Prisma Connection Pooling

For production, configure pooling via the connection string in DATABASE_URL. See [Prisma docs](https://www.prisma.io/docs/concepts/database-connectors/postgresql#connection-pool) for details.

## License

Private
