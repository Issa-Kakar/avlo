import WebSocket from 'ws';

const roomId = 'test-room-' + Date.now();
const wsUrl = `ws://localhost:3000/ws/${roomId}`;

console.log('Connecting to:', wsUrl);

const ws = new WebSocket(wsUrl, {
  headers: {
    origin: 'http://localhost:5173'
  }
});

let messageCount = 0;

ws.on('open', () => {
  console.log('✅ WebSocket connected');
  
  // Send initial Yjs sync message (protocol 0)
  const syncStep1 = new Uint8Array([0, 0, 1, 0]); // Sync step 1
  ws.send(syncStep1);
  console.log('Sent sync step 1');
});

ws.on('message', (data) => {
  messageCount++;
  console.log(`📥 Message #${messageCount}:`, data.length, 'bytes');
  
  const arr = new Uint8Array(data);
  const messageType = arr[0];
  console.log('Message type:', messageType);
  
  if (messageType === 0) {
    console.log('Received sync message');
  } else if (messageType === 1) {
    console.log('Received awareness update');
  }
  
  if (messageCount === 2) {
    // Send awareness update with cursor position
    const awareness = new Uint8Array([
      1, // awareness protocol
      1, // number of clients
      1, 0, 0, 0, // client id
      10, // clock
      JSON.stringify({
        user: {
          name: 'Test User',
          color: '#ff0000',
          cursor: { x: 100, y: 200 }
        }
      }).length,
      ...new TextEncoder().encode(JSON.stringify({
        user: {
          name: 'Test User',
          color: '#ff0000',
          cursor: { x: 100, y: 200 }
        }
      }))
    ]);
    ws.send(awareness);
    console.log('Sent awareness update with cursor');
  }
  
  if (messageCount >= 5) {
    console.log('✅ Test complete - closing connection');
    ws.close();
  }
});

ws.on('error', (err) => {
  console.error('❌ WebSocket error:', err.message);
});

ws.on('close', (code, reason) => {
  console.log(`🔌 WebSocket closed - code: ${code}, reason: ${reason}`);
  process.exit(0);
});

setTimeout(() => {
  console.log('⏰ Timeout - closing connection');
  ws.close();
  process.exit(1);
}, 10000);