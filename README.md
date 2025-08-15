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

### Installation

```bash
# Install dependencies
npm install

# Generate Prisma client
npm run db:generate

# Run database migrations
npm run db:migrate

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

## Scripts

- `npm run dev` - Start development servers
- `npm run build` - Build for production
- `npm run db:migrate` - Run database migrations
- `npm run test:e2e` - Run end-to-end tests

## License

Private