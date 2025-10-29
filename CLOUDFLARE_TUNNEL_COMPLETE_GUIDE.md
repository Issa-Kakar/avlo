# Complete Cloudflare Tunnel Setup Guide for AVLO

## Table of Contents
1. [Overview](#overview)
2. [The Problem We Solved](#the-problem-we-solved)
3. [Architecture & How It Works](#architecture--how-it-works)
4. [Prerequisites](#prerequisites)
5. [Step-by-Step Setup Instructions](#step-by-step-setup-instructions)
6. [Switching Back to Local Development](#switching-back-to-local-development)
7. [Quick Reference Commands](#quick-reference-commands)
8. [Troubleshooting](#troubleshooting)
9. [Technical Details](#technical-details)
10. [Important Notes & Behaviors](#important-notes--behaviors)

---

## Overview

This guide documents the complete process for exposing your local AVLO development environment to the internet using Cloudflare Tunnel, enabling real-time collaboration from anywhere. The setup preserves your local development workflow while adding the ability to share your work externally.

## Why Use Cloudflare Tunnel?

- Share your local development with team members or clients
- Test on real mobile devices
- Collaborate in real-time from different locations
- No need for port forwarding or complex networking

## The Problem We Solved

### Initial Issue
When attempting to tunnel AVLO through Cloudflare, WebSocket connections were failing with these symptoms:
- Network tab showed 101 status codes (WebSocket upgrade attempts) repeating 2x per second
- No real-time collaboration was working
- WebSocket requests were piling up indefinitely

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

## Prerequisites

1. **Install cloudflared**:
   ```bash
   # macOS
   brew install cloudflare/cloudflare/cloudflared

   # Ubuntu/Debian
   wget -q https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
   sudo dpkg -i cloudflared-linux-amd64.deb

   # Verify installation
   cloudflared --version
   ```

2. **Ensure your codebase has the necessary modifications** (already done):
   - Server CORS accepts `*.trycloudflare.com` origins
   - Client config supports `VITE_WS_URL` environment variable
   - RoomDocManager uses direct WebSocket URL when provided

## Step-by-Step Setup Instructions

### ⚠️ CRITICAL: The Order of Operations Matters!

Follow these steps EXACTLY in order. The most common failure is doing steps out of sequence.

### Step 1: Clean Slate
First, ensure no conflicting processes are running:

```bash
# Kill any existing cloudflared tunnels
pkill cloudflared

# Kill any existing dev servers
pkill -f "npm run dev"
pkill -f vite
pkill -f tsx

# Verify ports are free
lsof -i :3000 -i :3001
# Should return nothing
```

### Step 2: Reset Environment Configuration
Ensure your `.env.local` is in default local dev mode:

```bash
# Check current configuration
cat client/.env.local

# Should look like this (with VITE_WS_URL commented out):
# Client environment configuration for Phase 6
VITE_WS_BASE=/ws
VITE_API_BASE=/api
VITE_ROOM_TTL_DAYS=14
# Cloudflare Tunnel WebSocket URL (comment out for local dev)
# VITE_WS_URL=wss://server-tunnel-url.trycloudflare.com/ws
```

### Step 3: Start Development Servers
Start BOTH servers using the standard dev command:

```bash
npm run dev
```

Wait for both servers to be ready. You should see:
- Client: `VITE v5.4.11 ready` on `http://localhost:3000/`
- Server: Running on port 3001

Verify both are listening:
```bash
lsof -i :3000 -i :3001 | grep LISTEN
# Should show both ports
```

### Step 4: Start Client Tunnel (First Terminal)
Open a new terminal and start the client tunnel:

```bash
cloudflared tunnel --url localhost:3000
```

Wait for the message:
```
Your quick Tunnel has been created! Visit it at:
https://[random-words].trycloudflare.com
```

**SAVE THIS URL** - This is your CLIENT URL.

### Step 5: Start Server Tunnel (Second Terminal)
Open another terminal and start the server tunnel:

```bash
cloudflared tunnel --url localhost:3001
```

Wait for the message:
```
Your quick Tunnel has been created! Visit it at:
https://[different-random-words].trycloudflare.com
```

**SAVE THIS URL** - This is your SERVER URL.

### Step 6: Configure WebSocket URL
Update your `client/.env.local` file with the SERVER tunnel URL:

```bash
# Edit the file
nano client/.env.local

# Uncomment and update the VITE_WS_URL line:
VITE_WS_URL=wss://[your-server-tunnel-url].trycloudflare.com/ws

# Example:
VITE_WS_URL=wss://questions-fool-lighting-vic.trycloudflare.com/ws
```

⚠️ **IMPORTANT**: Use the SERVER tunnel URL, not the client tunnel URL!

### Step 7: Restart ONLY the Client Dev Server

This is the critical step that often goes wrong:

```bash
# Find the Vite process ID
lsof -i :3000 | grep LISTEN | awk '{print $2}'

# Kill ONLY the client (replace PID with actual number)
kill [PID]

# Restart the client
cd client && npm run dev
```

⚠️ **DO NOT**:
- Kill the server (port 3001)
- Kill both servers
- Restart npm run dev (which would restart both)

The server MUST stay running with its existing connection to the Cloudflare tunnel.

### Step 8: Test Collaboration
1. Open your CLIENT tunnel URL in a browser:
   ```
   https://[your-client-tunnel].trycloudflare.com/room/test-room
   ```

2. Open the same URL in another browser/device/incognito window

3. Draw on one screen - it should appear on the other in real-time!

## Switching Back to Local Development

### Method 1: Quick Switch (Preserve Tunnels)
If you want to keep tunnels running but work locally:

```bash
# 1. Comment out VITE_WS_URL in client/.env.local
nano client/.env.local
# Add # in front of VITE_WS_URL line

# 2. Restart ONLY the client
kill $(lsof -i :3000 | grep LISTEN | awk 'NR==2{print $2}')
cd client && npm run dev
```

### Method 2: Full Teardown
Complete shutdown and return to local-only mode:

```bash
# 1. Kill everything
pkill cloudflared
pkill -f "npm run dev"

# 2. Ensure .env.local has VITE_WS_URL commented out
# 3. Start fresh
npm run dev
```

## Quick Reference Commands

### Check What's Running
```bash
# Check dev servers
lsof -i :3000 -i :3001 | grep LISTEN

# Check cloudflared tunnels
ps aux | grep cloudflared | grep -v grep

# Check all AVLO processes
ps aux | grep -E "vite|tsx|cloudflared" | grep -v grep
```

### Emergency Reset
```bash
# Nuclear option - kill everything and start fresh
pkill cloudflared && pkill -f "npm run dev" && pkill vite && pkill tsx
```

### Get Current Tunnel URLs
```bash
# If you lost the URLs, check running processes
ps aux | grep cloudflared
# The URLs will be in the process arguments
```

## Troubleshooting

### Problem: "Address already in use"
**Cause**: Previous server didn't shut down cleanly
**Solution**:
```bash
# Find and kill the process
lsof -i :3001 | grep LISTEN
kill -9 [PID]
```

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
   ```

### How y-websocket Builds URLs
The y-websocket library takes a base URL and roomId separately:
```javascript
new WebsocketProvider(
  wsUrl,        // Base URL: wss://server.trycloudflare.com/ws
  this.roomId,  // Room ID: abc123
  this.ydoc
)
// Results in: wss://server.trycloudflare.com/ws/abc123
```

### Why Two Tunnels?
- **Single tunnel approach fails** because WebSocket upgrade requests can't properly traverse through Vite's HTTP proxy when accessed via Cloudflare
- **Two tunnels solution** allows WebSocket connections to bypass the proxy entirely, going directly to the Express server

## Important Notes & Behaviors

### Tunnel Characteristics
- **Random URLs**: Free Cloudflare tunnels generate random URLs each time
- **No persistence**: URLs change every time you restart tunnels
- **Public access**: Anyone with the URL can access your dev environment

### Performance Considerations
- **Latency**: Expect 50-200ms additional latency through tunnels
- **Bandwidth**: Free tunnels have bandwidth limitations
- **Stability**: Free tunnels may occasionally disconnect

### Security Notes
- Tunnels make your local dev publicly accessible
- Don't share sensitive data during tunnel sessions
- Always kill tunnels when not in use
- Room URLs are public - use random room names for privacy

### Development Workflow Tips
1. **Keep terminals organized**: Label terminal windows (Client Tunnel, Server Tunnel, Dev Servers)
2. **Save URLs immediately**: Tunnel URLs are shown only once
3. **Test locally first**: Ensure everything works on localhost before tunneling
4. **Don't kill the server**: Once tunnels are up, the server must stay running
5. **Client restarts are safe**: You can restart the client without breaking tunnels

### Common Mistakes to Avoid
1. ❌ Using client tunnel URL for VITE_WS_URL (use server tunnel)
2. ❌ Restarting both servers after updating .env.local (restart only client)
3. ❌ Starting tunnels before dev servers are running
4. ❌ Forgetting to add `/ws` to the WebSocket URL
5. ❌ Killing the server after tunnels are established

## Summary

The Cloudflare tunnel setup for AVLO requires:
1. Two separate tunnels (client + server)
2. Proper environment configuration (VITE_WS_URL)
3. Correct order of operations
4. Only restarting the client when applying config changes

When done correctly, you get full real-time collaboration capabilities accessible from anywhere on the internet, while maintaining the ability to quickly switch back to local development.

Remember: The key is keeping the server running and stable once the tunnels are established, and only restarting the client when needed.