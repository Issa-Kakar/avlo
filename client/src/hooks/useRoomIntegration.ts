/**
 * Phase 9: Read-only integration hooks for RoomDocManager
 * These hooks provide safe, minimal interfaces to the existing room management system
 */

import { useCallback } from 'react';
import { useRoomDoc } from './use-room-doc';
import { useConnectionGates } from './use-connection-gates';

/**
 * Get connection gates status (read-only)
 */
export function useGates(roomId: string) {
  const gates = useConnectionGates(roomId);
  return gates;
}

/**
 * Get clear scene function (optional, may be undefined)
 * TODO: Implement per-user clear board with atomic delete of all objects tagged with userId
 * This will be implemented when migrating to Y.Map structure
 */
export function useClearScene(roomId: string) {
  const room = useRoomDoc(roomId);

  const clearScene = useCallback(() => {
    // STUB: Scene ticks removed, clear board will be reimplemented with per-user deletion
    console.warn('Clear board is currently disabled during migration to new architecture');
    // TODO: Delete all strokes and texts with matching userId
    // This requires the upcoming Y.Map migration
  }, [room]);

  // Return undefined if room is not available, making it optional
  return room ? clearScene : undefined;
}
