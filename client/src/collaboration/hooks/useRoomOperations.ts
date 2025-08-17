import { useCallback, useMemo } from 'react';
import { RoomDocManager } from '../RoomDocManager.js';
import { WriteOperation } from '../RoomSnapshot.js';
import { nanoid } from 'nanoid';

export function useRoomOperations(roomId: string | undefined) {
  const manager = useMemo(() => {
    if (!roomId || !/^[A-Za-z0-9_-]+$/.test(roomId)) return null;
    return RoomDocManager.getInstance(roomId);
  }, [roomId]);

  const updateCursor = useCallback(
    (x: number | null, y: number | null) => {
      manager?.updateCursor(x, y);
    },
    [manager],
  );

  const updatePresence = useCallback(
    (updates: any) => {
      manager?.updatePresence(updates);
    },
    [manager],
  );

  const enqueueWrite = useCallback(
    (type: string, execute: (ydoc: any) => void, origin?: string) => {
      if (!manager) return;

      const operation: WriteOperation = {
        id: nanoid(),
        type: type as any,
        execute,
        origin,
      };

      manager.enqueueWrite(operation);
    },
    [manager],
  );

  const destroy = useCallback(() => {
    manager?.destroy();
  }, [manager]);

  return {
    updateCursor,
    updatePresence,
    enqueueWrite,
    destroy,
  };
}
