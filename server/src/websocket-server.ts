import { WebSocketServer, WebSocket } from 'ws';
import { Server as HTTPServer } from 'http';
import { IncomingMessage } from 'http';
import { setupWSConnection, getYDoc } from '@y/websocket-server/utils';
import * as Y from 'yjs';
import { ServerEnv } from './config/env.js';
import { getRedisAdapter } from './lib/redis.js';
import { prisma } from './lib/prisma.js';

// Track room connections (docs are managed by @y/websocket-server internally)
const roomConnections = new Map<string, Set<WebSocket>>();

export function setupWebSocketServer(server: HTTPServer, env: ServerEnv) {
  const wss = new WebSocketServer({
    server,
    // No path restriction - accept all WebSocket connections and validate path in handler
    maxPayload: env.WS_MAX_FRAME_BYTES,
  });

  wss.on('connection', async (ws: WebSocket, req: IncomingMessage) => {
    // Extract room ID from URL path: /ws/<roomId>
    const url = new URL(req.url!, `http://${req.headers.host}`);
    const pathMatch = url.pathname.match(/^\/ws\/(.+)$/);

    if (!pathMatch) {
      ws.close(1008, 'Invalid room path - expected /ws/<roomId>');
      return;
    }

    const roomId = pathMatch[1];

    // Origin check
    const origin = req.headers.origin;
    if (origin && !env.ORIGIN_ALLOWLIST.includes(origin)) {
      ws.close(1008, 'Origin not allowed');
      return;
    }

    // Capacity check
    const connections = roomConnections.get(roomId) || new Set();
    if (connections.size >= env.MAX_CLIENTS_PER_ROOM) {
      // Send capacity message before closing
      ws.send(
        JSON.stringify({
          type: 'room_full',
          readOnly: true,
          message: 'Room at capacity',
        }),
      );
      ws.close(1008, 'Room at capacity');
      return;
    }

    // Track connection
    connections.add(ws);
    roomConnections.set(roomId, connections);

    // Get Y.Doc managed by websocket-server (will be created if doesn't exist)
    // The getYDoc function returns the singleton doc for this roomId
    const doc = getYDoc(roomId); // Single argument in v0.1.x

    // Load from Redis if this is the first connection to the room
    if (connections.size === 1) {
      const redis = await getRedisAdapter(env);
      const savedState = await redis.loadRoom(roomId);
      if (savedState) {
        Y.applyUpdate(doc, savedState);
      }
    }

    // Setup y-websocket server for this connection (v0.1.x API)
    setupWSConnection(ws, req, { docName: roomId });

    // Set up persistence with debouncing
    let persistTimeout: ReturnType<typeof setTimeout> | null = null;
    const persistRoom = async () => {
      try {
        const redis = await getRedisAdapter(env);
        const fullState = Y.encodeStateAsUpdate(doc!);
        const sizeBytes = await redis.saveRoom(roomId, fullState);

        // Update metadata
        await prisma.roomMetadata.upsert({
          where: { id: roomId },
          create: {
            id: roomId,
            title: '',
            sizeBytes,
            lastWriteAt: new Date(),
          },
          update: {
            sizeBytes,
            lastWriteAt: new Date(),
          },
        });
      } catch (err) {
        console.error(`[WebSocket] Failed to persist room ${roomId}:`, err);
      }
    };

    // Listen for ALL updates to persist (not just from specific origin)
    // Only set up persistence handler if this is the first connection
    // Alternative: Use global setPersistence({ bindState, writeState }) to avoid per-connection handlers
    let updateHandler: ((_update: Uint8Array, _origin: unknown) => void) | null = null;

    if (connections.size === 1) {
      updateHandler = async (_update: Uint8Array, _origin: unknown) => {
        // Debounce persistence to avoid excessive writes
        // Clear existing timeout
        if (persistTimeout) {
          clearTimeout(persistTimeout);
        }

        // Set new timeout for persistence (100ms debounce)
        persistTimeout = setTimeout(persistRoom, 100);
      };

      doc.on('update', updateHandler);
    }

    // Cleanup on disconnect
    ws.on('close', () => {
      connections.delete(ws);
      if (connections.size === 0) {
        // Last client left, cleanup room
        roomConnections.delete(roomId);

        // Remove update handler if we set one
        if (updateHandler) {
          doc.off('update', updateHandler);
        }

        // Clear any pending persistence
        if (persistTimeout) {
          clearTimeout(persistTimeout);
          // Do final persist before cleanup
          persistRoom();
        }

        // Note: The Y.Doc cleanup is handled by @y/websocket-server internally
        // It has its own garbage collection after all connections close
      }
    });
  });

  console.debug('[WebSocket] Server initialized');
}
