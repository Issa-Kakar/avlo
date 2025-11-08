# Development Setup - Cloudflare Workers with Durable Objects

## The Problem We Solved
The Cloudflare Vite plugin doesn't properly inject Durable Object namespace bindings in development mode. When `routePartykitRequest` tried to access `env.rooms.idFromName()`, it failed because `env.rooms` was undefined.

## The Solution
We now run the Cloudflare Worker and Vite dev server separately:
- **Wrangler Dev Server**: Runs on port 8787 with proper Durable Object bindings
- **Vite Dev Server**: Runs on port 3000 and proxies WebSocket/HTTP requests to Wrangler

## How to Run

### Option 1: Run Both Together (Recommended)
```bash
npm run dev
```
This uses `concurrently` to run both servers in parallel.

### Option 2: Run Separately
Terminal 1:
```bash
npm run dev:worker
```

Terminal 2:
```bash
npm run dev:client
```

## How It Works

1. **Vite Config** (`client/vite.config.ts`):
   - Removed the Cloudflare Vite plugin
   - Added proxy configuration for `/parties` routes
   - WebSocket connections to `/parties/*` are proxied to `ws://localhost:8787`

2. **Wrangler** (`wrangler.toml`):
   - Runs the worker with Durable Object bindings properly configured
   - The `rooms` namespace binding is correctly created with `idFromName` method

3. **Client** (`client/src/lib/room-doc-manager.ts`):
   - Uses `window.location.host` (localhost:3000) as the WebSocket host
   - Connects to `/parties/rooms/{roomId}`
   - Vite proxies this to Wrangler at port 8787

## URLs
- Frontend: http://localhost:3000
- Worker (direct): http://localhost:8787
- Rooms: http://localhost:3000/room/{roomId}

## Troubleshooting
- If port 8787 is already in use, update both:
  - `package.json`: Change the port in `dev:worker` script
  - `client/vite.config.ts`: Update the proxy target port