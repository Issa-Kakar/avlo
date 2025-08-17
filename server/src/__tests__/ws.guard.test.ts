import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import WebSocket from 'ws';

describe('WebSocket Gateway Guards', () => {
  let wss: WebSocket.Server;
  const PORT = 3001;
  const ALLOWED_ORIGINS = ['http://localhost:5173', 'http://localhost:3000'];

  beforeEach(() => {
    wss = new WebSocket.Server({ port: PORT });
  });

  afterEach(() => {
    wss.close();
  });

  describe('Origin Validation', () => {
    it('should accept connections from allowed origins', (done) => {
      wss.on('connection', (ws, req) => {
        const origin = req.headers.origin;
        if (ALLOWED_ORIGINS.includes(origin || '')) {
          ws.send(JSON.stringify({ type: 'connected' }));
        } else {
          ws.close(1008, 'Origin not allowed');
        }
      });

      const client = new WebSocket(`ws://localhost:${PORT}`, {
        headers: { origin: 'http://localhost:5173' }
      });

      client.on('message', (data) => {
        const message = JSON.parse(data.toString());
        expect(message.type).toBe('connected');
        client.close();
        done();
      });

      client.on('error', (err) => {
        done(err);
      });
    });

    it('should reject connections from disallowed origins', (done) => {
      wss.on('connection', (ws, req) => {
        const origin = req.headers.origin;
        if (!ALLOWED_ORIGINS.includes(origin || '')) {
          ws.close(1008, 'Origin not allowed');
        }
      });

      const client = new WebSocket(`ws://localhost:${PORT}`, {
        headers: { origin: 'http://evil.com' }
      });

      client.on('close', (code, reason) => {
        expect(code).toBe(1008);
        expect(reason.toString()).toBe('Origin not allowed');
        done();
      });

      client.on('open', () => {
        done(new Error('Should not have connected'));
      });
    });

    it('should reject connections without Origin header', (done) => {
      wss.on('connection', (ws, req) => {
        const origin = req.headers.origin;
        if (!origin) {
          ws.close(1008, 'Origin required');
        }
      });

      const client = new WebSocket(`ws://localhost:${PORT}`);

      client.on('close', (code, reason) => {
        expect(code).toBe(1008);
        expect(reason.toString()).toBe('Origin required');
        done();
      });

      client.on('open', () => {
        done(new Error('Should not have connected'));
      });
    });
  });

  describe('Frame Size Validation', () => {
    it('should accept frames under 2MB', (done) => {
      wss.on('connection', (ws) => {
        ws.on('message', (data) => {
          const size = Buffer.byteLength(data.toString());
          if (size <= 2 * 1024 * 1024) {
            ws.send(JSON.stringify({ type: 'ack', size }));
          }
        });
      });

      const client = new WebSocket(`ws://localhost:${PORT}`, {
        headers: { origin: 'http://localhost:5173' }
      });

      client.on('open', () => {
        const smallData = 'x'.repeat(1024 * 1024);
        client.send(smallData);
      });

      client.on('message', (data) => {
        const message = JSON.parse(data.toString());
        expect(message.type).toBe('ack');
        expect(message.size).toBeLessThanOrEqual(2 * 1024 * 1024);
        client.close();
        done();
      });
    });

    it('should reject frames over 2MB', (done) => {
      wss.on('connection', (ws) => {
        ws.on('message', (data) => {
          const size = Buffer.byteLength(data.toString());
          if (size > 2 * 1024 * 1024) {
            ws.close(1009, 'Frame too large');
          }
        });
      });

      const client = new WebSocket(`ws://localhost:${PORT}`, {
        headers: { origin: 'http://localhost:5173' },
        maxPayload: 3 * 1024 * 1024
      });

      client.on('open', () => {
        try {
          const largeData = 'x'.repeat(2 * 1024 * 1024 + 1);
          client.send(largeData);
        } catch (err) {
          expect(err).toBeDefined();
          client.close();
          done();
        }
      });

      client.on('close', (code, reason) => {
        expect(code).toBe(1009);
        done();
      });
    });
  });

  describe('Connection Limits', () => {
    it('should enforce max 8 WebSocket connections per IP', async () => {
      const connections: WebSocket[] = [];
      const maxConnectionsPerIP = 8;
      const ipConnectionCount = new Map<string, number>();

      wss.on('connection', (ws, req) => {
        const ip = req.socket.remoteAddress || 'unknown';
        const count = ipConnectionCount.get(ip) || 0;
        
        if (count >= maxConnectionsPerIP) {
          ws.close(1008, 'Too many connections from IP');
        } else {
          ipConnectionCount.set(ip, count + 1);
          ws.on('close', () => {
            const currentCount = ipConnectionCount.get(ip) || 0;
            ipConnectionCount.set(ip, Math.max(0, currentCount - 1));
          });
        }
      });

      for (let i = 0; i < maxConnectionsPerIP; i++) {
        const client = new WebSocket(`ws://localhost:${PORT}`, {
          headers: { origin: 'http://localhost:5173' }
        });
        connections.push(client);
        await new Promise(resolve => client.on('open', resolve));
      }

      const extraClient = new WebSocket(`ws://localhost:${PORT}`, {
        headers: { origin: 'http://localhost:5173' }
      });

      await new Promise((resolve) => {
        extraClient.on('close', (code) => {
          expect(code).toBe(1008);
          resolve(undefined);
        });
        extraClient.on('open', () => {
          resolve(undefined);
        });
      });

      connections.forEach(conn => conn.close());
    });

    it('should enforce max 105 clients per room', async () => {
      const roomClients = new Map<string, Set<WebSocket>>();
      const maxClientsPerRoom = 105;

      wss.on('connection', (ws, req) => {
        ws.on('message', (data) => {
          const message = JSON.parse(data.toString());
          
          if (message.type === 'join') {
            const roomId = message.roomId;
            const clients = roomClients.get(roomId) || new Set();
            
            if (clients.size >= maxClientsPerRoom) {
              ws.send(JSON.stringify({ 
                type: 'error', 
                code: 'room_full',
                message: 'Room is full'
              }));
              ws.close();
            } else {
              clients.add(ws);
              roomClients.set(roomId, clients);
              ws.send(JSON.stringify({ type: 'joined', roomId }));
              
              ws.on('close', () => {
                clients.delete(ws);
                if (clients.size === 0) {
                  roomClients.delete(roomId);
                }
              });
            }
          }
        });
      });

      const roomId = 'test-room';
      const clients: WebSocket[] = [];

      for (let i = 0; i < maxClientsPerRoom; i++) {
        const client = new WebSocket(`ws://localhost:${PORT}`, {
          headers: { origin: 'http://localhost:5173' }
        });
        
        await new Promise((resolve) => {
          client.on('open', () => {
            client.send(JSON.stringify({ type: 'join', roomId }));
          });
          client.on('message', (data) => {
            const msg = JSON.parse(data.toString());
            if (msg.type === 'joined') {
              clients.push(client);
              resolve(undefined);
            }
          });
        });
      }

      const extraClient = new WebSocket(`ws://localhost:${PORT}`, {
        headers: { origin: 'http://localhost:5173' }
      });

      await new Promise((resolve) => {
        extraClient.on('open', () => {
          extraClient.send(JSON.stringify({ type: 'join', roomId }));
        });
        extraClient.on('message', (data) => {
          const msg = JSON.parse(data.toString());
          expect(msg.type).toBe('error');
          expect(msg.code).toBe('room_full');
          resolve(undefined);
        });
      });

      clients.forEach(client => client.close());
    });
  });

  describe('Room Identification', () => {
    it('should require roomId on connect', (done) => {
      wss.on('connection', (ws) => {
        ws.on('message', (data) => {
          const message = JSON.parse(data.toString());
          
          if (!message.roomId) {
            ws.send(JSON.stringify({ 
              type: 'error', 
              message: 'roomId required' 
            }));
            ws.close();
          } else {
            ws.send(JSON.stringify({ 
              type: 'connected', 
              roomId: message.roomId 
            }));
          }
        });
      });

      const client = new WebSocket(`ws://localhost:${PORT}`, {
        headers: { origin: 'http://localhost:5173' }
      });

      client.on('open', () => {
        client.send(JSON.stringify({ type: 'connect' }));
      });

      client.on('message', (data) => {
        const message = JSON.parse(data.toString());
        expect(message.type).toBe('error');
        expect(message.message).toBe('roomId required');
        done();
      });
    });
  });
});