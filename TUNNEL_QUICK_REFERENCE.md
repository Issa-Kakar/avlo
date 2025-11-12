# 🚀 AVLO Cloudflare Tunnel - Quick Reference

## example tunnels Tunnels
- **Client URL**: https://champions-portrait-cursor-organizer.trycloudflare.com
- **Server URL**: https://questions-fool-lighting-vic.trycloudflare.com

### Root Causes
1. **Proxy Layer Incompatibility**: WebSocket connections were trying to route through Vite's development proxy (`localhost:3000` → `localhost:3001`)
2. **CORS Restrictions**: Server wasn't accepting `*.trycloudflare.com` origins
3. **URL Construction**: Client was building WebSocket URLs based on `window.location.host`, which pointed to the Cloudflare tunnel instead of the actual WebSocket server
4. **Single Tunnel Limitation**: Using one tunnel for the client meant WebSocket traffic had to go through Vite's proxy, which doesn't work with Cloudflare

### The Solution
Create TWO separate Cloudflare tunnels:
- **Client tunnel**: Exposes Vite dev server (port 3000) for the React app
- **Server tunnel**: Exposes Express + WebSocket server (port 3001) directly
- **Direct WebSocket connection**: Bypass Vite proxy by configuring client to connect directly to the server tunnel

## Architecture & How It Works

### Local Development (Default)
```
Browser → localhost:3000 (Vite)
           ├→ React App
           └→ /ws/* proxied to → localhost:3001 (Express + WS)
```

### Cloudflare Tunnel Setup
```
Internet Browser → Client Tunnel → localhost:3000 (Vite) → React App
                                                              ↓
                                                    VITE_WS_URL configured
                                                              ↓
Internet Browser → Server Tunnel → localhost:3001 (Express + WS)
```

Key difference: WebSocket connections go DIRECTLY to the server tunnel, bypassing Vite's proxy entirely.


2. **Ensure your codebase has the necessary modifications** (already done):
   - Server CORS accepts `*.trycloudflare.com` origins
   - Client config supports `VITE_WS_URL` environment variable
   - RoomDocManager uses direct WebSocket URL when provided

## Setup in 7 Steps (The Right Way)

```bash
# 1. Clean slate
pkill cloudflared && pkill -f "npm run dev"

# 2. Start dev servers (BOTH)
npm run dev

# 3. Wait, then verify
lsof -i :3000 -i :3001 | grep LISTEN

# 4. Start CLIENT tunnel (new terminal)
cloudflared tunnel --url localhost:3000
# Save the URL!

# 5. Start SERVER tunnel (another terminal)
cloudflared tunnel --url localhost:3001
# Save the URL!

# 6. Update client/.env.local
# VITE_WS_URL=wss://[SERVER-TUNNEL-URL].trycloudflare.com/ws

# 7. Restart ONLY client (critical!)
kill $(lsof -i :3000 | grep LISTEN | awk '{print $2}')
cd client && npm run dev
```

## ⚠️ Golden Rules

1. **NEVER** kill the server after tunnels start
2. **ALWAYS** use the SERVER tunnel URL for VITE_WS_URL
3. **ONLY** restart the client after editing .env.local
4. **START** servers before tunnels
5. **INCLUDE** `/ws` at the end of VITE_WS_URL

## Quick Commands

### Check Status
```bash
# What's running?
lsof -i :3000 -i :3001 | grep LISTEN

# Are tunnels active?
ps aux | grep cloudflared | grep -v grep
```

### Switch to Local
```bash
# Quick (keep tunnels)
# 1. Comment out VITE_WS_URL in .env.local
# 2. Restart client only
kill $(lsof -i :3000 | grep LISTEN | awk '{print $2}')
cd client && npm run dev
```

### Switch to Tunnel
```bash
# 1. Uncomment VITE_WS_URL in .env.local
# 2. Restart client only
kill $(lsof -i :3000 | grep LISTEN | awk '{print $2}')
cd client && npm run dev
```

### Emergency Reset
```bash
pkill cloudflared && pkill -f "npm run dev" && pkill vite && pkill tsx
```

## Common Issues & Fixes

| Symptom | Cause | Fix |
|---------|-------|-----|
| WebSocket 101 repeating | Wrong VITE_WS_URL | Use SERVER tunnel URL, restart client |
| "Connection refused" | Server died | Never kill server after tunnels start |
| "Address in use" | Port blocked | `lsof -i :3001` then `kill -9 [PID]` |
| No collaboration | Different rooms | Check both browsers use same room URL |
| .env.local ignored | Client not restarted | Always restart client after changes |

## The Architecture
```
[Browser] → [Client Tunnel] → :3000 (Vite/React)
    ↓
[WebSocket Direct] → [Server Tunnel] → :3001 (Express/WS)
```

## Files to Remember
- Config: `client/.env.local`
- Server CORS: `server/src/middleware/index.ts`
- WS URL Builder: `client/src/lib/room-doc-manager.ts`

## One-Liner Health Check
```bash
echo "Client: $(lsof -i :3000 -t | wc -l) | Server: $(lsof -i :3001 -t | wc -l) | Tunnels: $(pgrep cloudflared | wc -l)"
```
Should show: "Client: 1 | Server: 1 | Tunnels: 2"



### Problem: WebSocket connections failing (repeating 101 status)
**Cause**: Wrong tunnel URL in VITE_WS_URL or client not restarted
**Solution**:
1. Verify VITE_WS_URL points to SERVER tunnel (not client)
2. Ensure you restarted ONLY the client after updating .env.local
3. Check URL includes `/ws` at the end

### Problem: "Connection refused" errors in cloudflared output
**Cause**: Server died or was restarted after tunnel was established
**Solution**:
1. Keep the server running! Don't kill it after tunnels start
2. If you did kill it, start over from Step 1

### Problem: Collaboration works but drawing doesn't appear
**Cause**: Both clients might be in different rooms
**Solution**: Ensure both browsers are at the exact same room URL

### Problem: Tunnels work but can't access the app
**Cause**: Using wrong URL or tunnels not fully established
**Solution**:
1. Wait 5-10 seconds after tunnel starts
2. Use the CLIENT tunnel URL to access the app
3. The SERVER tunnel is only for WebSocket connections

### Problem: Changes to .env.local not taking effect
**Cause**: Client wasn't restarted after editing
**Solution**: Always restart the client (and ONLY the client) after changing .env.local

## Technical Details

### Files Modified for Tunnel Support

1. **`/server/src/middleware/index.ts`**
   - Added wildcard CORS support for `*.trycloudflare.com`
   ```javascript
   if (origin.endsWith('.trycloudflare.com')) {
     callback(null, true);
     return;
   }
   ```

2. **`/server/src/websocket-server.ts`**
   - Added WebSocket origin check for Cloudflare domains

3. **`/client/src/lib/config-schema.ts`**
   - Added optional `VITE_WS_URL` configuration
   ```typescript
   VITE_WS_URL: z.string().optional()
   ```

4. **`/client/src/lib/room-doc-manager.ts`**
   - Modified `buildWebSocketUrl` to use direct URL when provided
   ```typescript
   if (clientConfig.VITE_WS_URL) {
     return clientConfig.VITE_WS_URL.replace(/\/$/, '');
   }