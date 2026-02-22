import { useEffect, useRef } from 'react';
import { RoomId } from '@avlo/shared';
import type { IRoomDocManager } from '../lib/room-doc-manager';
import { useRoomDocRegistry } from '../lib/room-doc-registry-context';

/**
 * Hook to get or create a RoomDocManager instance
 */
export function useRoomDoc(roomId: RoomId): IRoomDocManager {
  const registry = useRoomDocRegistry();
  const managerRef = useRef<IRoomDocManager>(undefined);
  const roomIdRef = useRef<RoomId>(undefined);
  const hasAcquiredRef = useRef(false);

  // Check if roomId has changed or if we don't have a manager yet
  if (!managerRef.current || roomIdRef.current !== roomId) {
    // Release the previous manager if we had one
    if (managerRef.current && roomIdRef.current && hasAcquiredRef.current) {
      registry.release(roomIdRef.current);
      hasAcquiredRef.current = false;
    }

    // Acquire a reference to the new manager
    managerRef.current = registry.acquire(roomId);
    roomIdRef.current = roomId;
    hasAcquiredRef.current = true;
  }

  useEffect(() => {
    // The effect ensures we release when:
    // 1. The component unmounts
    // 2. The roomId changes (handled above, but this is a safety net)

    // Track the current values for cleanup
    const currentRegistry = registry;
    const currentRoomId = roomId;
    const wasAcquired = hasAcquiredRef.current;

    return () => {
      // Release on unmount
      if (wasAcquired) {
        currentRegistry.release(currentRoomId);
      }
    };
  }, [registry, roomId]);

  return managerRef.current;
}
