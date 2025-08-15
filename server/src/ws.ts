import { WebSocketServer, WebSocket } from 'ws';
import type { Server, IncomingMessage } from 'http';
import { URL } from 'node:url';
import { isAllowedOrigin } from './util/origin.js';
import { getClientIp } from './util/ip.js';
import { crumb } from './obs.js';
import { yjsEvents, scheduleWrite, loadState } from './yjs-hooks.js';
import * as Y from 'yjs';

// Import from @y/websocket-server (official server for y-websocket v3)
import { setupWSConnection, setPersistence } from '@y/websocket-server/utils';

const MAX_FRAME = 2 * 1024 * 1024; // 2MB
const MAX_IP_CONNS = 8;
const MAX_ROOM_CONNS = 105;

const ipCounts = new Map<string, number>();
const roomConns = new Map<string, Set<WebSocket>>();

setPersistence({
  bindState: async (docName: string, ydoc: Y.Doc) => {
    // Load existing state from Redis
    const state = await loadState(docName);
    if (state) Y.applyUpdate(ydoc, state);

    // Schedule writes on updates
    ydoc.on('update', () => scheduleWrite(docName, () => Y.encodeStateAsUpdate(ydoc)));
  },
  writeState: async (docName: string, ydoc: Y.Doc) => {
    scheduleWrite(docName, () => Y.encodeStateAsUpdate(ydoc));
  },
});

// Derive room from URL path; accept ?room= as fallback for compatibility.
function getRoomId(req: IncomingMessage): string | null {
  const url = new URL(req.url || '/', 'http://ws.local');
  
  // Try query param first (for backward compatibility)
  const fromQuery = url.searchParams.get('room') || url.searchParams.get('doc') || undefined;
  if (fromQuery && /^[A-Za-z0-9_-]{1,64}$/.test(fromQuery)) {
    return fromQuery;
  }
  
  // Standard y-websocket pattern: /ws/<roomId>
  // Strip /ws prefix and get the room ID
  const path = url.pathname;
  const match = path.match(/^\/ws\/([A-Za-z0-9_-]{1,64})$/);
  if (match) {
    return match[1];
  }
  
  return null;
}

export function registerWsGateway(server: Server, allowlistCsv: string) {
  const wss = new WebSocketServer({ 
    noServer: true,
    // Cap inbound message size at 2 MB (enforced before Node buffers it)
    maxPayload: MAX_FRAME
  });

  // Broadcast advisories
  yjsEvents.on(
    'room_stats',
    ({ roomId, bytes, cap }: { roomId: string; bytes: number; cap: number }) => {
      const conns = roomConns.get(roomId);
      if (!conns) return;
      const msg = JSON.stringify({ type: 'room_stats', bytes, cap });
      for (const ws of conns) {
        if (ws.readyState === WebSocket.OPEN)
          try {
            ws.send(msg);
          } catch {
            /* ignore send errors */
          }
      }
    },
  );
  yjsEvents.on('readonly', ({ roomId }: { roomId: string }) => {
    const conns = roomConns.get(roomId);
    if (!conns) return;
    const msg = JSON.stringify({
      type: 'room_full_readonly',
      message: 'Board is read-only — size limit reached.',
    });
    for (const ws of conns) {
      if (ws.readyState === WebSocket.OPEN)
        try {
          ws.send(msg);
        } catch {
          /* ignore send errors */
        }
    }
  });

  server.on('upgrade', (req, socket, head) => {
    // Only accept WebSocket connections to /ws/*
    const url = new URL(req.url || '/', `http://${req.headers.host}`);
    if (!url.pathname.startsWith('/ws')) {
      socket.destroy();
      return;
    }

    const origin = req.headers.origin as string | undefined;
    if (!isAllowedOrigin(origin, allowlistCsv)) {
      crumb('origin_reject', 'gateway', 'warning');
      socket.destroy();
      return;
    }
    
    const ip = getClientIp(req);
    const count = (ipCounts.get(ip) || 0) + 1;
    if (count > MAX_IP_CONNS) {
      crumb('per_ip_ws_cap', 'gateway', 'warning');
      socket.destroy();
      return;
    }
    ipCounts.set(ip, count);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    wss.handleUpgrade(req as any, socket as any, head, (ws) => {
      // Get room ID from URL path or query
      const roomId = getRoomId(req);
      if (!roomId) {
        ws.close(1008, 'missing_room');
        ipCounts.set(ip, Math.max(0, (ipCounts.get(ip) || 1) - 1));
        return;
      }

      // Room capacity check
      const set = roomConns.get(roomId) || new Set<WebSocket>();
      if (set.size >= MAX_ROOM_CONNS) {
        try {
          ws.send(
            JSON.stringify({ type: 'room_full', message: 'Room is full — create a new room.' }),
          );
        } catch {
          /* ignore send error */
        }
        ws.close(1008, 'room_full');
        ipCounts.set(ip, Math.max(0, (ipCounts.get(ip) || 1) - 1));
        return;
      }
      set.add(ws);
      roomConns.set(roomId, set);

      // Let @y/websocket-server wire the Yjs protocol for this socket
      // CRITICAL: @y/websocket-server expects docName to be derived from req.url
      // We need to modify req.url to just be the room ID for compatibility
      const modifiedReq = Object.create(req);
      modifiedReq.url = `/${roomId}`; // @y/websocket-server expects /docName format
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      setupWSConnection(ws as any, modifiedReq as any, { /* gc options if needed */ });

      // Handle frame size limit - listen for oversize frames
      ws.on('message', (data: Buffer) => {
        if (data.length > MAX_FRAME) {
          crumb('frame_too_large', 'gateway', 'warning');
          try {
            ws.send(
              JSON.stringify({
                type: 'offline_delta_too_large',
                message: 'Change too large. Refresh to rejoin.',
              }),
            );
          } catch {
            /* ignore send error */
          }
          ws.close(1009, 'Frame too large');
        }
      });

      const cleanup = () => {
        const ip = getClientIp(req as IncomingMessage);
        ipCounts.set(ip, Math.max(0, (ipCounts.get(ip) || 1) - 1));
        const s = roomConns.get(roomId);
        if (s) {
          s.delete(ws);
          if (s.size === 0) roomConns.delete(roomId);
        }
      };

      ws.on('close', cleanup);
      ws.on('error', cleanup);
    });
  });
}
