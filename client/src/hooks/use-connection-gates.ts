import { useSyncExternalStore } from 'react';
import { useRoomDoc } from './use-room-doc';

export interface GateStatus {
  idbReady: boolean;
  wsConnected: boolean;
  wsSynced: boolean;
  awarenessReady: boolean;
  firstSnapshot: boolean;
}

// Type for the encoded gate status string
type GateSnapshot = `${0 | 1}|${0 | 1}|${0 | 1}|${0 | 1}|${0 | 1}`;

/**
 * Encode gate status to a stable string primitive
 * This avoids referential instability issues with useSyncExternalStore
 */
function encodeGates(gates: GateStatus): GateSnapshot {
  return `${+gates.idbReady}|${+gates.wsConnected}|${+gates.wsSynced}|${+gates.awarenessReady}|${+gates.firstSnapshot}` as GateSnapshot;
}

/**
 * Decode gate status string back to object
 */
function decodeGates(snapshot: GateSnapshot): GateStatus {
  const [idb, wc, ws, aw, fs] = snapshot.split('|').map((n) => n === '1');
  return {
    idbReady: idb,
    wsConnected: wc,
    wsSynced: ws,
    awarenessReady: aw,
    firstSnapshot: fs,
  };
}

/**
 * Hook to subscribe to connection gate status changes using useSyncExternalStore
 * Provides event-driven updates instead of polling
 *
 * Uses a stable string snapshot to avoid infinite re-render loops caused by
 * referential instability when returning new objects
 */
export function useConnectionGates(roomId: string) {
  const room = useRoomDoc(roomId);

  const subscribe = (onStoreChange: () => void) => {
    // Wrap callback in queueMicrotask to prevent synchronous calls
    // during mount that can cause infinite loops in StrictMode
    return room.subscribeGates(() => queueMicrotask(onStoreChange));
  };

  // Return a stable primitive (string) that can be compared by value
  const getSnapshot = () => encodeGates(room.getGateStatus());
  const getServerSnapshot = getSnapshot;

  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  // Decode the string snapshot back to an object
  const gates = decodeGates(snapshot);

  return {
    gates,
    isOffline: !gates.wsConnected,
    isOnline: gates.wsSynced,
    hasFirstSnapshot: gates.firstSnapshot,
    hasIDBReady: gates.idbReady,
    hasAwareness: gates.awarenessReady,
  };
}
