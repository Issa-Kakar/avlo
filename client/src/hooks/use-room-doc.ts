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
  const roomIdRef = useRef<RoomId>();

  // Check if roomId has changed or if we don't have a manager yet
  if (!managerRef.current || roomIdRef.current !== roomId) {
    // Get the manager for the current roomId
    managerRef.current = registry.get(roomId);
    roomIdRef.current = roomId;
  }

  useEffect(() => {
    // Manager lifecycle is handled by the registry
    // Components don't destroy managers directly
    // The registry maintains reference counting internally
    // Note: We don't call registry.remove() here because:
    // 1. Other components in the same tab might be using the same manager
    // 2. The registry handles cleanup when appropriate
    return () => {
      // No cleanup needed - registry manages lifecycle
    };
  }, [roomId]);

  return managerRef.current;
}
