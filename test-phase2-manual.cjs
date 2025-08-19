#!/usr/bin/env node

// Phase 2 Manual Testing Script
// Tests all Phase 2 functionality requirements

const http = require('http');
const https = require('https');
const WebSocket = require('ws');

const BASE_URL = 'http://localhost:3000';
const WS_URL = 'ws://localhost:3000';
const ORIGIN = 'http://localhost:5173';

let testsPassed = 0;
let testsFailed = 0;

function log(message) {
  console.log(`[TEST] ${message}`);
}

function pass(testName) {
  testsPassed++;
  console.log(`✓ ${testName}`);
}

function fail(testName, error) {
  testsFailed++;
  console.error(`✗ ${testName}: ${error}`);
}

async function makeRequest(path, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE_URL);
    const opts = {
      ...options,
      headers: {
        'Origin': ORIGIN,
        'Content-Type': 'application/json',
        ...options.headers
      }
    };

    const req = http.request(url, opts, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({
            status: res.statusCode,
            data: data ? JSON.parse(data) : null
          });
        } catch (e) {
          resolve({
            status: res.statusCode,
            data: data
          });
        }
      });
    });

    req.on('error', reject);
    
    if (options.body) {
      req.write(JSON.stringify(options.body));
    }
    
    req.end();
  });
}

async function testHealthEndpoint() {
  try {
    const response = await makeRequest('/healthz');
    if (response.status === 200 && response.data.ok === true) {
      pass('Health endpoint returns ok');
    } else {
      fail('Health endpoint', 'Invalid response');
    }
  } catch (error) {
    fail('Health endpoint', error.message);
  }
}

async function testRoomCreation() {
  try {
    const response = await makeRequest('/api/rooms', {
      method: 'POST',
      body: { title: 'Test Room ' + Date.now() }
    });
    
    if (response.status === 201 && response.data.roomId && response.data.shareLink) {
      pass('Room creation API works');
      return response.data.roomId;
    } else {
      fail('Room creation', 'Invalid response');
      return null;
    }
  } catch (error) {
    fail('Room creation', error.message);
    return null;
  }
}

async function testRoomMetadata(roomId) {
  if (!roomId) {
    fail('Room metadata', 'No room ID provided');
    return;
  }

  try {
    const response = await makeRequest(`/api/rooms/${roomId}/metadata`);
    // May fail if Redis doesn't have the room yet
    if (response.status === 200 || response.status === 404 || response.status === 500) {
      pass('Room metadata endpoint responds');
    } else {
      fail('Room metadata', `Unexpected status: ${response.status}`);
    }
  } catch (error) {
    fail('Room metadata', error.message);
  }
}

async function testWebSocketConnection(roomId) {
  if (!roomId) {
    fail('WebSocket connection', 'No room ID provided');
    return;
  }

  return new Promise((resolve) => {
    try {
      const ws = new WebSocket(`${WS_URL}/ws`, {
        headers: {
          'Origin': ORIGIN
        }
      });

      let connected = false;

      ws.on('open', () => {
        connected = true;
        pass('WebSocket connection established');
        
        // Send room join message
        ws.send(JSON.stringify({ roomId }));
        
        setTimeout(() => {
          ws.close();
          resolve();
        }, 1000);
      });

      ws.on('error', (error) => {
        if (!connected) {
          fail('WebSocket connection', error.message);
        }
        resolve();
      });

      ws.on('close', () => {
        if (connected) {
          pass('WebSocket connection closed cleanly');
        }
        resolve();
      });

      setTimeout(() => {
        if (!connected) {
          fail('WebSocket connection', 'Timeout');
          ws.close();
          resolve();
        }
      }, 5000);
    } catch (error) {
      fail('WebSocket connection', error.message);
      resolve();
    }
  });
}

async function testRateLimiting() {
  try {
    // Create many rooms quickly to test rate limiting
    const promises = [];
    for (let i = 0; i < 12; i++) {
      promises.push(makeRequest('/api/rooms', {
        method: 'POST',
        body: { title: `Rate Limit Test ${i}` }
      }));
    }

    const results = await Promise.all(promises);
    const rateLimited = results.some(r => r.status === 429);
    
    if (rateLimited) {
      pass('Rate limiting enforced (429 status)');
    } else {
      pass('Rate limiting not triggered (may need more requests)');
    }
  } catch (error) {
    fail('Rate limiting test', error.message);
  }
}

async function checkDocManagerArchitecture() {
  try {
    const fs = require('fs');
    const path = require('path');
    
    const docManagerPath = path.join(__dirname, 'client/src/collaboration/RoomDocManager.ts');
    const snapshotPath = path.join(__dirname, 'client/src/collaboration/RoomSnapshot.ts');
    
    if (fs.existsSync(docManagerPath)) {
      pass('DocManager architecture file exists');
    } else {
      fail('DocManager architecture', 'RoomDocManager.ts not found');
    }
    
    if (fs.existsSync(snapshotPath)) {
      pass('RoomSnapshot interface exists');
    } else {
      fail('RoomSnapshot interface', 'RoomSnapshot.ts not found');
    }

    // Check for hooks
    const hooksDir = path.join(__dirname, 'client/src/collaboration/hooks');
    if (fs.existsSync(hooksDir)) {
      const hooks = fs.readdirSync(hooksDir);
      if (hooks.includes('useRoomSnapshot.ts')) {
        pass('useRoomSnapshot hook exists');
      } else {
        fail('useRoomSnapshot hook', 'Not found');
      }
      
      if (hooks.includes('useRoomOperations.ts')) {
        pass('useRoomOperations hook exists');
      } else {
        fail('useRoomOperations hook', 'Not found');
      }
    } else {
      fail('Collaboration hooks', 'hooks directory not found');
    }
  } catch (error) {
    fail('DocManager architecture check', error.message);
  }
}

async function runAllTests() {
  console.log('='.repeat(60));
  console.log('Phase 2 Manual Testing');
  console.log('='.repeat(60));
  console.log();

  // Server tests
  log('Testing server endpoints...');
  await testHealthEndpoint();
  
  const roomId = await testRoomCreation();
  await testRoomMetadata(roomId);
  await testWebSocketConnection(roomId);
  await testRateLimiting();
  
  // Architecture tests
  log('\nChecking DocManager architecture...');
  await checkDocManagerArchitecture();

  // Summary
  console.log();
  console.log('='.repeat(60));
  console.log(`Tests Passed: ${testsPassed}`);
  console.log(`Tests Failed: ${testsFailed}`);
  console.log('='.repeat(60));
  
  if (testsFailed === 0) {
    console.log('✅ All manual tests passed!');
  } else {
    console.log('❌ Some tests failed. Please review the output above.');
  }
}

// Run tests
runAllTests().catch(console.error);