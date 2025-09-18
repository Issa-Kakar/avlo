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
 */
export function useClearScene(roomId: string) {
  const room = useRoomDoc(roomId);

  const clearScene = useCallback(() => {
    // Phase 9: Safe check - if manager doesn't exist or doesn't have mutate, no-op
    if (!room?.mutate) {
      console.warn('Clear scene not available - room manager not ready');
      return;
    }

    try {
      room.mutate((ydoc) => {
        const root = ydoc.getMap('root');
        const meta = root.get('meta') as any;
        if (meta) {
          const sceneTicks = meta.get('scene_ticks') as any;
          if (sceneTicks) {
            sceneTicks.push([Date.now()]);
          }
        }
      });
    } catch (error) {
      console.error('Failed to clear scene:', error);
    }
  }, [room]);

  // Return undefined if room is not available, making it optional
  return room ? clearScene : undefined;
}
