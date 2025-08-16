import { useEffect, useState } from 'react';
import { createProviders } from './app/providers/yjsClient';

export function TestVanillaClient() {
  const [status, setStatus] = useState('Not connected');
  const [sync, setSync] = useState(false);
  const [awareness, setAwareness] = useState(0);

  useEffect(() => {
    // Override getWsUrl to point to vanilla server
    const originalGetWsUrl = (window as any).getWsUrl;
    (window as any).getWsUrl = () => 'ws://localhost:3001/ws';

    const roomId = 'test-room-client';
    console.log('Creating providers for room:', roomId);

    const providers = createProviders(roomId);

    providers.wsProvider.on('status', ({ status }: { status: string }) => {
      console.log('[TestVanilla] Status:', status);
      setStatus(status);
    });

    providers.wsProvider.on('sync', (synced: boolean) => {
      console.log('[TestVanilla] Sync:', synced);
      setSync(synced);
    });

    providers.wsProvider.awareness.on('update', () => {
      const states = providers.wsProvider.awareness.getStates();
      console.log('[TestVanilla] Awareness update, clients:', states.size);
      setAwareness(states.size);
    });

    // Test data sync
    const ymap = providers.ydoc.getMap('test');
    ymap.observe(() => {
      console.log('[TestVanilla] Map updated:', ymap.toJSON());
    });

    setTimeout(() => {
      ymap.set('from_client', 'Hello from real client');
      ymap.set('timestamp', Date.now());
    }, 2000);

    return () => {
      providers.wsProvider.destroy();
      providers.indexeddbProvider.destroy();
      providers.ydoc.destroy();
      (window as any).getWsUrl = originalGetWsUrl;
    };
  }, []);

  return (
    <div style={{ padding: '20px' }}>
      <h2>Test Vanilla Client Connection</h2>
      <div>Status: {status}</div>
      <div>Sync: {sync ? 'true' : 'false'}</div>
      <div>Awareness clients: {awareness}</div>
    </div>
  );
}
