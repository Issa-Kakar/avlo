import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import WebSocket from 'ws';

// Monkey-patch WebSocket to add origin header
const OriginalWebSocket = WebSocket;
global.WebSocket = class extends OriginalWebSocket {
  constructor(url, protocols) {
    super(url, protocols, {
      headers: {
        'Origin': 'http://localhost:5173'
      }
    });
  }
};

const roomId = 'test-provider-origin';

console.log('Testing y-websocket provider with origin header...');

const ydoc = new Y.Doc({ guid: roomId });
const provider = new WebsocketProvider('ws://localhost:3000/ws', roomId, ydoc, { 
  connect: true,
  params: { v: 'dev' }
});

provider.on('status', (e) => {
  console.log('[Provider] Status:', e.status);
});

provider.on('sync', (b) => {
  console.log('[Provider] Sync:', b);
  if (b) {
    console.log('✅ Provider connected and synced!');
    
    // Test data sync
    const ymap = ydoc.getMap('test');
    ymap.set('test', 'Hello from provider');
    
    setTimeout(() => {
      console.log('Data in document:', ymap.toJSON());
      console.log('✅ Test successful!');
      process.exit(0);
    }, 1000);
  }
});

provider.on('connection-close', (e) => {
  console.log('[Provider] Connection closed:', e.code, e.reason);
});

provider.on('connection-error', (e) => {
  console.log('[Provider] Connection error:', e);
});

// Timeout after 10 seconds
setTimeout(() => {
  console.log('❌ Timeout - no sync received');
  process.exit(1);
}, 10000);