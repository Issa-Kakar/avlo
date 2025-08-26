import { useEffect, useRef } from 'react';
import { RoomId } from '@avlo/shared';
import { RoomDocManager } from '../lib/room-doc-manager';
import { useRoomDocRegistry } from '../lib/room-doc-registry-context';

/**
 * Internal hook to get or create a RoomDocManager instance
 * NOTE: This is an internal hook. UI components should use
 * useSnapshot, usePresence, or useRoomStats instead to maintain
 * a narrow, hook-based surface as per the architecture.
 * @internal
 */
export function useRoomDoc(roomId: RoomId): RoomDocManager {
  const registry = useRoomDocRegistry();
  const managerRef = useRef<RoomDocManager>();

  if (!managerRef.current) {
    managerRef.current = registry.get(roomId);
  }

  useEffect(() => {
    // Manager lifecycle is handled by the registry
    // Components don't destroy managers directly
    return () => {
      // Cleanup if needed in future
    };
  }, [roomId]);

  return managerRef.current;
}
