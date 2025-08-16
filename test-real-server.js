import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';

const roomId = 'test-real-server';

console.log('Testing connection to real server on port 3000...');

const ydoc = new Y.Doc({ guid: roomId });

// Connect directly to server port 3000
const provider = new WebsocketProvider('ws://localhost:3000/ws', roomId, ydoc, { 
  connect: true,
  params: { v: 'dev' }
});

provider.on('status', (e) => {
  console.log('[Real Server] Status:', e.status);
});

provider.on('sync', (b) => {
  console.log('[Real Server] Sync:', b);
  if (b) {
    console.log('✅ Connected to real server and synced!');
    
    // Test data
    const ymap = ydoc.getMap('test');
    ymap.set('test', 'Hello from test client');
    
    setTimeout(() => {
      console.log('Data in document:', ymap.toJSON());
      process.exit(0);
    }, 1000);
  }
});

provider.on('connection-close', (e) => {
  console.log('[Real Server] Connection closed:', e.code, e.reason);
});

provider.on('connection-error', (e) => {
  console.log('[Real Server] Connection error:', e);
});

// Timeout after 10 seconds
setTimeout(() => {
  console.log('❌ Timeout - no sync received');
  process.exit(1);
}, 10000);