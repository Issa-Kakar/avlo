import { useState, useEffect } from 'react';
import type { WebsocketProvider } from 'y-websocket';

export type ConnectionState = 'Online' | 'Reconnecting' | 'Offline' | 'Read-only';

export function useConnectionState(
  provider?: WebsocketProvider,
  readOnly = false,
): ConnectionState {
  const [isConnected, setIsConnected] = useState(false);
  const [isReconnecting, setIsReconnecting] = useState(false);
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

    const handleStatus = ({ status }: { status: string }) => {
      setIsConnected(status === 'connected');
      setIsReconnecting(status === 'connecting');
    };

    provider.on('status', handleStatus);

    return () => {
      provider.off('status', handleStatus);
    };
  }, [provider]);

  if (readOnly) return 'Read-only';
  if (!isOnline) return 'Offline';
  if (isReconnecting) return 'Reconnecting';
  if (isConnected) return 'Online';
  return 'Offline';
}
