import WebSocket from 'ws';
import * as Y from 'yjs';

const roomId = 'test-real-server';

console.log('Testing connection to real server with origin header...');

const ydoc = new Y.Doc({ guid: roomId });

// Create WebSocket with origin header
const ws = new WebSocket(`ws://localhost:3000/ws/${roomId}?v=dev`, {
  headers: {
    'Origin': 'http://localhost:5173'
  }
});

let messageBuffer = [];
let awareness = null;

ws.on('open', () => {
  console.log('✅ WebSocket connected!');
  
  // Send Yjs sync step 1
  const encoder = Y.encoding.createEncoder();
  Y.encoding.writeVarUint(encoder, 0); // messageSync
  Y.syncProtocol.writeSyncStep1(encoder, ydoc);
  ws.send(Y.encoding.toUint8Array(encoder));
  console.log('Sent sync step 1');
});

ws.on('message', (data) => {
  console.log('Received message:', data.length, 'bytes');
  
  try {
    const decoder = Y.decoding.createDecoder(new Uint8Array(data));
    const messageType = Y.decoding.readVarUint(decoder);
    console.log('Message type:', messageType);
    
    switch (messageType) {
      case 0: // messageSync
        const syncMessageType = Y.decoding.readVarUint(decoder);
        console.log('Sync message type:', syncMessageType);
        if (syncMessageType === 0 || syncMessageType === 1) { // syncStep1 or syncStep2
          Y.syncProtocol.readSyncMessage(decoder, encoder, ydoc, null);
          console.log('✅ Processed sync message');
        }
        break;
      case 1: // messageAwareness
        console.log('Received awareness update');
        break;
    }
  } catch (err) {
    console.log('Non-Yjs message or error:', err.message);
  }
});

ws.on('close', (code, reason) => {
  console.log('WebSocket closed:', code, reason?.toString());
});

ws.on('error', (err) => {
  console.log('WebSocket error:', err.message);
});

// Timeout after 5 seconds
setTimeout(() => {
  console.log('Test complete');
  ws.close();
  process.exit(0);
}, 5000);