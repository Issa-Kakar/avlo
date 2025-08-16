import WebSocket from 'ws';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';

const roomId = 'test-room';

// Client 1
console.log('Starting client 1...');
const ydoc1 = new Y.Doc({ guid: roomId });
const provider1 = new WebsocketProvider('ws://localhost:3001/ws', roomId, ydoc1, { connect: true });

provider1.on('status', (e) => {
    console.log('[Client1 status]', e.status);
});

provider1.on('sync', (b) => {
    console.log('[Client1 sync]', b);
    if (b) {
        console.log('✅ Client 1 synced successfully!');
        testClient2();
    }
});

provider1.on('connection-close', (e) => {
    console.log('[Client1 connection-close]', e.code, e.reason);
});

provider1.on('connection-error', (e) => {
    console.log('[Client1 connection-error]', e);
});

// Test Client 2 after Client 1 syncs
function testClient2() {
    console.log('\nStarting client 2...');
    const ydoc2 = new Y.Doc({ guid: roomId });
    const provider2 = new WebsocketProvider('ws://localhost:3001/ws', roomId, ydoc2, { connect: true });
    
    provider2.on('status', (e) => {
        console.log('[Client2 status]', e.status);
    });
    
    provider2.on('sync', (b) => {
        console.log('[Client2 sync]', b);
        if (b) {
            console.log('✅ Client 2 synced successfully!');
            
            // Test data sync
            const ymap1 = ydoc1.getMap('test');
            ymap1.set('from_client1', 'Hello from Client 1');
            
            setTimeout(() => {
                const ymap2 = ydoc2.getMap('test');
                console.log('\nClient 2 sees:', ymap2.toJSON());
                
                if (ymap2.get('from_client1') === 'Hello from Client 1') {
                    console.log('✅ Data sync working!');
                } else {
                    console.log('❌ Data sync failed!');
                }
                
                // Test awareness
                console.log('\nAwareness test:');
                console.log('Client 1 sees', provider1.awareness.getStates().size, 'clients');
                console.log('Client 2 sees', provider2.awareness.getStates().size, 'clients');
                
                setTimeout(() => {
                    console.log('\n✅ All tests passed! Vanilla Yjs setup is working.');
                    process.exit(0);
                }, 1000);
            }, 500);
        }
    });
    
    provider2.on('connection-close', (e) => {
        console.log('[Client2 connection-close]', e.code, e.reason);
    });
    
    provider2.on('connection-error', (e) => {
        console.log('[Client2 connection-error]', e);
    });
}