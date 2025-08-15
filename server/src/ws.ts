import { WebSocketServer, WebSocket } from 'ws';
import type { Server, IncomingMessage } from 'http';
import { isAllowedOrigin } from './util/origin';
import { getClientIp } from './util/ip';
import { crumb } from './obs';
import { yjsEvents, scheduleWrite, loadState } from './yjs-hooks';
import * as Y from 'yjs';

// Import from @y/websocket-server (official server for y-websocket v3)
import { setupWSConnection, setPersistence } from '@y/websocket-server/utils';

const MAX_FRAME = 2 * 1024 * 1024; // 2MB
const MAX_IP_CONNS = 8;
const MAX_ROOM_CONNS = 105;
const _HARD_CAP = 10 * 1024 * 1024; // 10MB

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

export function registerWsGateway(server: Server, allowlistCsv: string) {
  const wss = new WebSocketServer({ noServer: true });

  // Broadcast advisories
  yjsEvents.on('room_stats', ({ roomId, bytes, cap }) => {
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
  });
  yjsEvents.on('readonly', ({ roomId }) => {
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
      let roomId: string | null = null;

      // Back‑compat URL query fallback
      const url = new URL((req as any).url, 'http://local');
      const roomFromQuery = url.searchParams.get('room');
      if (roomFromQuery && /^[A-Za-z0-9_-]+$/.test(roomFromQuery)) roomId = roomFromQuery;

      const identifyTimer = setTimeout(() => {
        if (!roomId)
          try {
            ws.close(1008, 'Identify required');
          } catch {
            /* ignore close errors */
          }
      }, 5000);

      const onMessage = (data: Buffer) => {
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
          return;
        }
        if (!roomId) {
          try {
            const j = JSON.parse(data.toString('utf8'));
            const candidate = j?.roomId || (j?.type === 'identify' ? j?.roomId : undefined);
            if (typeof candidate === 'string' && /^[A-Za-z0-9_-]+$/.test(candidate))
              roomId = candidate;
            if (!roomId) return; // keep waiting
          } catch {
            return;
          }
        }
        // After identified, let y-websocket handle messages
      };

      ws.on('message', onMessage);

      const afterIdentify = () => {
        if (!roomId) return; // still waiting
        clearTimeout(identifyTimer);
        ws.off('message', onMessage);

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
          ws.close(1008, 'Room full');
          return;
        }
        set.add(ws);
        roomConns.set(roomId, set);

        // Make y-websocket believe the docname is /ws/<roomId>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (req as any).url = `/ws/${encodeURIComponent(roomId)}`;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        setupWSConnection(ws as any, req as any);
      };

      // Check periodically until identified or closed
      const poll = setInterval(() => {
        if (ws.readyState !== WebSocket.OPEN) return clearInterval(poll);
        if (roomId) {
          clearInterval(poll);
          afterIdentify();
        }
      }, 50);

      ws.on('close', () => {
        clearTimeout(identifyTimer);
        clearInterval(poll);
        const ip = getClientIp(req as IncomingMessage);
        ipCounts.set(ip, Math.max(0, (ipCounts.get(ip) || 1) - 1));
        if (roomId) {
          const set = roomConns.get(roomId);
          if (set) {
            set.delete(ws);
            if (set.size === 0) roomConns.delete(roomId);
          }
        }
      });
    });
  });
}
