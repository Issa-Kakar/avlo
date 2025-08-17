// Temporary compatibility layer for existing code
import { useRoomSnapshot } from './useRoomSnapshot.js';
import { useRoomOperations } from './useRoomOperations.js';
import { RoomDocManager } from '../RoomDocManager.js';
import { useEffect } from 'react';
import { recordRoomOpen } from '../../app/features/myrooms/integrations.js';

export interface RoomHandles {
  roomId: string;
  ydoc: any; // Deprecated - will be removed
  provider: any; // Deprecated - will be removed
  awareness: any; // Deprecated - will be removed
  readOnly: boolean;
  roomStats?: { bytes: number; cap: number; softWarn: boolean };
  destroy: () => void;
}

export function useRoom(roomId: string | undefined): RoomHandles | null {
  const snapshot = useRoomSnapshot(roomId);
  const operations = useRoomOperations(roomId);

  // Record room open for MyRooms
  useEffect(() => {
    if (roomId && snapshot) {
      recordRoomOpen({ roomId }).catch(console.error);
    }
  }, [roomId, snapshot]);

  // Handle room stats messages
  useEffect(() => {
    if (!roomId || !snapshot) return;

    // TODO: Integrate WebSocket message handling into DocManager
    // For now, room stats will be handled directly in the DocManager

    return () => {
      // Cleanup
    };
  }, [roomId, snapshot]);

  if (!snapshot || !operations || !roomId) return null;

  // For backwards compatibility, expose deprecated fields
  // These will be removed once all components are updated
  const manager = RoomDocManager.getInstance(roomId);
  const internalState =
    import.meta.env.DEV === true
      ? manager.getInternalState()
      : { ydoc: null, provider: null, awareness: null };

  return {
    roomId,
    ydoc: internalState.ydoc, // Deprecated
    provider: internalState.provider, // Deprecated
    awareness: internalState.awareness, // Deprecated
    readOnly: snapshot.isReadOnly,
    roomStats: snapshot.roomStats,
    destroy: operations.destroy,
  };
}
