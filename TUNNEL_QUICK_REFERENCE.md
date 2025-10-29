# 🚀 AVLO Cloudflare Tunnel - Quick Reference

## Current Active Tunnels
- **Client URL**: https://champions-portrait-cursor-organizer.trycloudflare.com
- **Server URL**: https://questions-fool-lighting-vic.trycloudflare.com
- **Test Room**: https://champions-portrait-cursor-organizer.trycloudflare.com/room/test-room

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