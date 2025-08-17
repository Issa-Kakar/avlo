import { useState, useEffect } from 'react';
import { useRoomSnapshot } from '../../collaboration/hooks/useRoomSnapshot.js';

export type ConnectionState = 'Online' | 'Reconnecting' | 'Offline' | 'Read-only';

export function useConnectionState(roomId?: string, readOnly = false): ConnectionState {
  const snapshot = useRoomSnapshot(roomId);
  const [state, setState] = useState<ConnectionState>('Reconnecting');

  useEffect(() => {
    if (!snapshot) {
      setState('Offline');
      return;
    }

    // Check if room is read-only (takes precedence)
    if (readOnly || snapshot.isReadOnly) {
      setState('Read-only');
      return;
    }

    // Map internal connection states to UI states
    switch (snapshot.connectionState) {
      case 'connected':
        setState('Online');
        break;
      case 'connecting':
      case 'reconnecting':
        setState('Reconnecting');
        break;
      case 'disconnected':
        setState('Offline');
        break;
      default:
        setState('Reconnecting');
    }
  }, [snapshot?.connectionState, snapshot?.isReadOnly, readOnly]);

  return state;
}
