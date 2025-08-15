# Avlo

A link-based, account-less, offline-first, real-time collaborative whiteboard with an integrated code executor.

## Tech Stack

- **Frontend**: React (Vite), TypeScript, Tailwind, HTML Canvas, Monaco Editor
- **Realtime & Offline**: Yjs CRDT, y-websocket, y-indexeddb
- **Backend**: Node.js, Express, WebSocket, Redis, PostgreSQL (via Prisma)
- **Code Execution**: JavaScript + Python (via Pyodide)

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

# Generate Prisma client
npm run db:generate

# Run database migrations
npm run db:migrate

# Install Playwright browsers for E2E testing
npm run e2e:install

# Start development servers
npm run dev
```

### Environment Variables

Create a `.env` file in the root directory:

```env
NODE_ENV=development
PORT=3000
DATABASE_URL=postgresql://user:password@localhost:5432/avlo
REDIS_URL=redis://localhost:6379
ORIGIN_ALLOWLIST=http://localhost:5173,http://localhost:3000
ROOM_TTL_DAYS=14
APP_VERSION=0.1.0
SENTRY_DSN=your_sentry_dsn_here (optional)
```

## Project Structure

```
avlo/
├── client/          # React frontend
├── server/          # Node.js backend
├── prisma/          # Database schema
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
- `npm run e2e:install` - Install Playwright browsers (required once)
- `npm run e2e:serve` - Build and serve the app for E2E testing

## License

Private