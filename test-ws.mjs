#!/usr/bin/env node

import WebSocket from 'ws';

const roomId = 'test-room-' + Date.now();
const ws = new WebSocket('ws://localhost:3000/ws', {
  headers: {
    'Origin': 'http://localhost:5173'
  }
});

let connected = false;

ws.on('open', () => {
  connected = true;
  console.log('✓ WebSocket connected');
  
  // Send room identification
  ws.send(JSON.stringify({ roomId }));
  console.log(`✓ Sent room ID: ${roomId}`);
  
  // Close after 2 seconds
  setTimeout(() => {
    ws.close();
  }, 2000);
});

ws.on('message', (data) => {
  const msgPreview = data.toString().substring(0, 100);
  console.log(`✓ Received message: ${msgPreview}${data.length > 100 ? '...' : ''}`);
});

ws.on('close', () => {
  if (connected) {
    console.log('✓ WebSocket closed cleanly');
  } else {
    console.log('✗ WebSocket failed to connect');
  }
  process.exit(connected ? 0 : 1);
});

ws.on('error', (error) => {
  console.error(`✗ WebSocket error: ${error.message}`);
  process.exit(1);
});

// Timeout after 5 seconds
setTimeout(() => {
  if (!connected) {
    console.log('✗ WebSocket connection timeout');
    process.exit(1);
  }
}, 5000);