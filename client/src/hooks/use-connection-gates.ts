import { useSyncExternalStore } from 'react';
import { useRoomDoc } from './use-room-doc';

export interface GateStatus {
  idbReady: boolean;
  wsConnected: boolean;
  wsSynced: boolean;
  awarenessReady: boolean;
  firstSnapshot: boolean;
}

/**
 * Hook to subscribe to connection gate status changes using useSyncExternalStore
 * Provides event-driven updates instead of polling
 */
export function useConnectionGates(roomId: string) {
  const room = useRoomDoc(roomId);

  const subscribe = (onStoreChange: () => void) => {
    return room.subscribeGates(() => onStoreChange());
  };

  const getSnapshot = () => room.getGateStatus();
  const getServerSnapshot = getSnapshot;

  const gates = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  return {
    gates,
    isOffline: !gates.wsConnected,
    isOnline: gates.wsSynced,
    hasFirstSnapshot: gates.firstSnapshot,
    hasIDBReady: gates.idbReady,
    hasAwareness: gates.awarenessReady,
  };
}
