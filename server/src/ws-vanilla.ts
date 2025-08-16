import { WebSocketServer } from 'ws';
import { setupWSConnection } from '@y/websocket-server/utils';
import { createServer } from 'http';

// Create a basic HTTP server
const server = createServer();

// Create WebSocket server without path restriction
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (request, socket, head) => {
  // Accept all paths that start with /ws
  const url = new URL(request.url || '/', `http://${request.headers.host}`);
  console.log('[UPGRADE] url:', request.url, 'pathname:', url.pathname);
  
  if (!url.pathname.startsWith('/ws')) {
    socket.destroy();
    return;
  }
  
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request);
  });
});

wss.on('connection', (ws, req) => {
  const url = new URL(req.url || '/', 'http://ws.local');
  
  // Extract room ID from path: /ws/roomId
  const pathParts = url.pathname.split('/').filter(Boolean);
  const room = pathParts[1] || 'debug'; // After 'ws' comes the room ID
  
  console.log('[WS CONNECT] room:', room, 'url:', req.url);
  
  // Setup Yjs connection with the room as docName
  // CRITICAL: setupWSConnection expects req.url to be just the docName
  const modifiedReq = Object.create(req);
  modifiedReq.url = `/${room}`;
  
  setupWSConnection(ws, modifiedReq, { docName: room });
  
  ws.on('close', (code, reason) => {
    console.log('[WS CLOSE]', room, code, reason?.toString());
  });
  
  ws.on('error', (err) => {
    console.error('[WS ERROR]', room, err);
  });
  
  // Log incoming messages for debugging
  ws.on('message', (data) => {
    console.log('[WS IN]', room, data.length, 'bytes');
  });
});

server.listen(3001, () => {
  console.log('vanilla yjs ws up on :3001/ws/<room>');
});