#!/bin/bash

# Cloudflare Tunnel Setup Script for AVLO
# This script helps you set up Cloudflare tunnels for both client and server

echo "==================================="
echo "AVLO Cloudflare Tunnel Setup"
echo "==================================="
echo ""
echo "This script will help you expose your local AVLO development to the internet."
echo ""
echo "Prerequisites:"
echo "1. cloudflared must be installed (https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/installation)"
echo "2. Your dev servers should be running (npm run dev)"
echo ""
read -p "Press Enter to continue or Ctrl+C to cancel..."

echo ""
echo "Checking if dev servers are running..."
if ! lsof -i :3000 >/dev/null 2>&1; then
    echo "ERROR: Client dev server is not running on port 3000"
    echo "Please run 'npm run dev' first"
    exit 1
fi
if ! lsof -i :3001 >/dev/null 2>&1; then
    echo "ERROR: Server is not running on port 3001"
    echo "Please run 'npm run dev' first"
    exit 1
fi
echo "✓ Dev servers detected"

echo ""
echo "Starting Cloudflare tunnels..."
echo ""

# Clean up any existing temp files
rm -f /tmp/avlo-client-*.txt /tmp/avlo-server-*.txt

# Function to extract URL from cloudflared output
extract_tunnel_url() {
    local port=$1
    local output_file=$2
    local url_file=$3

    # Start cloudflared and capture all output
    cloudflared tunnel --url localhost:$port 2>&1 > $output_file &
    local pid=$!

    # Wait for the URL to appear in the output (max 20 seconds)
    local count=0
    while [ $count -lt 20 ]; do
        if grep -q "Your quick Tunnel has been created" $output_file 2>/dev/null; then
            # Extract the URL
            grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' $output_file | head -1 > $url_file
            if [ -s $url_file ]; then
                echo "$(cat $url_file)"
                return 0
            fi
        fi
        sleep 1
        count=$((count + 1))
    done

    # Timeout reached
    kill $pid 2>/dev/null
    return 1
}

# Start client tunnel
echo "1. Starting tunnel for CLIENT (port 3000)..."
echo "   (This may take up to 10 seconds...)"
CLIENT_URL=$(extract_tunnel_url 3000 /tmp/avlo-client-output.txt /tmp/avlo-client-url.txt)
if [ $? -ne 0 ] || [ -z "$CLIENT_URL" ]; then
    echo "ERROR: Failed to establish client tunnel"
    echo "Debug output:"
    cat /tmp/avlo-client-output.txt 2>/dev/null | head -20
    exit 1
fi
echo "   ✓ Client tunnel: $CLIENT_URL"

# Start server tunnel
echo ""
echo "2. Starting tunnel for SERVER (port 3001)..."
echo "   (This may take up to 10 seconds...)"
SERVER_URL=$(extract_tunnel_url 3001 /tmp/avlo-server-output.txt /tmp/avlo-server-url.txt)
if [ $? -ne 0 ] || [ -z "$SERVER_URL" ]; then
    echo "ERROR: Failed to establish server tunnel"
    echo "Debug output:"
    cat /tmp/avlo-server-output.txt 2>/dev/null | head -20
    # Kill client tunnel before exiting
    pkill -f "cloudflared tunnel --url localhost:3000"
    exit 1
fi
echo "   ✓ Server tunnel: $SERVER_URL"

# Convert server URL to WebSocket URL
WS_URL="wss://${SERVER_URL#https://}/ws"

# Create a file with the current tunnel information
cat > CURRENT_TUNNELS.txt << EOF
CLOUDFLARE TUNNELS ARE ACTIVE
==============================
CLIENT URL: $CLIENT_URL
SERVER URL: $SERVER_URL
WebSocket URL: $WS_URL

To use: Add this to client/.env.local:
VITE_WS_URL=$WS_URL

Then restart the client dev server.
EOF

echo ""
echo "==================================="
echo "Tunnels Established Successfully!"
echo "==================================="
echo ""
echo "CLIENT URL: $CLIENT_URL"
echo "SERVER URL: $SERVER_URL"
echo "WebSocket URL: $WS_URL"
echo ""
echo "Next steps:"
echo ""
echo "1. Update your client/.env.local file by adding:"
echo "   VITE_WS_URL=$WS_URL"
echo ""
echo "2. Restart your client dev server:"
echo "   cd client && npm run dev"
echo ""
echo "3. Access your app at:"
echo "   $CLIENT_URL"
echo ""
echo "4. Share this URL with others to collaborate:"
echo "   $CLIENT_URL/room/YOUR-ROOM-NAME"
echo ""
echo "The tunnel information has been saved to CURRENT_TUNNELS.txt"
echo ""
echo "To stop the tunnels, run: pkill cloudflared"
echo ""
echo "Note: Tunnels are now running in the background."
echo "They will continue running even if you close this terminal."