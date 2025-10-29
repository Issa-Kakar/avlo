import { useCallback } from 'react';
import { useRoomDoc } from './use-room-doc';
import type { RoomId } from '@avlo/shared';

export interface UndoRedoActions {
  undo: () => void;
  redo: () => void;
}

/**
 * Hook to access undo/redo functionality for a room
 */
export function useUndoRedo(roomId: RoomId): UndoRedoActions {
  const roomDoc = useRoomDoc(roomId);

  const undo = useCallback(() => {
    roomDoc.undo();
  }, [roomDoc]);

  const redo = useCallback(() => {
    roomDoc.redo();
  }, [roomDoc]);

  return { undo, redo };
}