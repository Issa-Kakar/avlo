import { useState, useEffect } from 'react';
import type { WebsocketProvider } from 'y-websocket';

export type ConnectionState = 'Online' | 'Reconnecting' | 'Offline' | 'Read-only';

export function useConnectionState(
  provider?: WebsocketProvider,
  readOnly = false,
): ConnectionState {
  const [isConnected, setIsConnected] = useState(false);
  const [isSynced, setIsSynced] = useState(false);
  const [isOnline, setIsOnline] = useState(navigator.onLine);

  useEffect(() => {
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  useEffect(() => {
    if (!provider) return;

    // y-websocket v3 uses these events:
    // - 'status' event with { status: 'connected' | 'disconnected' | 'connecting' }
    // - 'sync' event when the document syncs (boolean parameter)
    // - wsconnected property for WebSocket connection state
    
    const handleStatus = ({ status }: { status: string }) => {
      console.log('[ConnectionState] Status event:', status);
      setIsConnected(status === 'connected');
    };

    // y-websocket emits 'sync' with a boolean, not 'synced'
    const handleSync = (isSynced: boolean) => {
      console.log('[ConnectionState] Sync event:', isSynced);
      setIsSynced(isSynced);
    };

    const handleConnection = () => {
      // Check if WebSocket is connected and synced
      const connected = !!provider.wsconnected;
      const synced = !!(provider as any).synced; // Check synced property directly
      setIsConnected(connected);
      setIsSynced(synced);
    };

    // Check initial state
    handleConnection();
    
    // Listen for events
    provider.on('status', handleStatus);
    provider.on('sync', handleSync);
    
    // Also check connection state periodically as fallback
    const interval = setInterval(handleConnection, 1000);

    return () => {
      provider.off('status', handleStatus);
      provider.off('sync', handleSync);
      clearInterval(interval);
    };
  }, [provider]);

  if (readOnly) return 'Read-only';
  if (!isOnline) return 'Offline';
  if (isConnected && isSynced) return 'Online';
  if (isConnected && !isSynced) return 'Reconnecting'; // Connected but not synced yet
  // If navigator is online but provider not connected => show "Reconnecting"
  return navigator.onLine ? 'Reconnecting' : 'Offline';
}
