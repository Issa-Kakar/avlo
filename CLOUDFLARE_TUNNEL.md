# Cloudflare Tunnel Setup for AVLO

This guide explains how to expose your local AVLO development environment to the internet using Cloudflare Tunnel, enabling remote collaboration without breaking your local setup.

## Why Use Cloudflare Tunnel?

- Share your local development with team members or clients
- Test on real mobile devices
- Collaborate in real-time from different locations
- No need for port forwarding or complex networking

## Prerequisites

1. Install `cloudflared`:
   ```bash
   # macOS
   brew install cloudflare/cloudflare/cloudflared

   # Ubuntu/Debian
   wget -q https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
   sudo dpkg -i cloudflared-linux-amd64.deb

   # Windows (via winget)
   winget install --id Cloudflare.cloudflared
   ```

2. Ensure your dev servers are running:
   ```bash
   npm run dev  # Starts client on :3000, server on :3001
   ```

## Method 1: Automatic Setup (Recommended)

Use the provided script for automatic tunnel setup:

```bash
./tunnel-setup.sh
```

The script will:
1. Start tunnels for both client (3000) and server (3001)
2. Display the URLs you need
3. Provide instructions for updating your configuration

## Method 2: Manual Setup

### Step 1: Create Two Tunnels

Open two terminal windows:

**Terminal 1 - Client Tunnel:**
```bash
cloudflared tunnel --url localhost:3000
# Note the URL, e.g., https://quick-example.trycloudflare.com
```

**Terminal 2 - Server Tunnel:**
```bash
cloudflared tunnel --url localhost:3001
# Note the URL, e.g., https://server-example.trycloudflare.com
```

### Step 2: Configure WebSocket URL

Update your `client/.env.local` file:

```env
# Add this line with YOUR server tunnel URL
VITE_WS_URL=wss://server-example.trycloudflare.com/ws
```

### Step 3: Restart Client Dev Server

```bash
# Stop the client (Ctrl+C) then restart
npm run dev -w client
```

### Step 4: Access Your App

Open the **client tunnel URL** in your browser:
```
https://quick-example.trycloudflare.com
```

## How It Works

The solution involves two key changes:

1. **Server CORS**: Automatically accepts any `*.trycloudflare.com` origin
2. **WebSocket Override**: `VITE_WS_URL` bypasses the proxy and connects directly to the server tunnel

```
Internet → Cloudflare Tunnel (Client) → localhost:3000 (Vite)
                      ↓
              React Application
                      ↓
Internet → Cloudflare Tunnel (Server) → localhost:3001 (Express + WS)
```

## Reverting to Local Development

To go back to normal local development:

1. **Option A**: Remove or comment out `VITE_WS_URL` from `.env.local`:
   ```env
   # VITE_WS_URL=wss://...  (commented out)
   ```

2. **Option B**: Keep separate env files:
   ```bash
   # For local dev
   cp .env.local.backup .env.local

   # For tunnel
   cp .env.tunnel .env.local
   ```

3. Restart the client dev server

## Troubleshooting

### WebSocket connections failing
- Ensure BOTH tunnels are running (client AND server)
- Verify `VITE_WS_URL` points to the server tunnel (not client)
- Check that the URL includes `/ws` at the end

### 502 Bad Gateway errors
- Make sure your dev servers are actually running (`npm run dev`)
- Check that ports 3000 and 3001 are not blocked

### Collaboration not working
- Ensure all users access the same room URL (e.g., `/room/team-meeting`)
- Verify WebSocket connections show status 101 (successful upgrade)

### Tunnel URLs change on restart
- Cloudflare free tunnels generate random URLs each time
- Update `VITE_WS_URL` whenever you restart the server tunnel

## Security Notes

- Cloudflare tunnels are publicly accessible - anyone with the URL can access your dev environment
- Don't share sensitive data or credentials through tunnel sessions
- Stop tunnels (Ctrl+C) when not in use
- Tunnels automatically expire after inactivity

## Room Creation

Rooms work exactly the same through tunnels:
```
https://your-client-tunnel.trycloudflare.com/room/my-awesome-room
```

Share this URL with collaborators to work in the same room!