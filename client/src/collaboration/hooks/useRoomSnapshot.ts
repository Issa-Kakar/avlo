import { useState, useEffect } from 'react';
import { RoomDocManager } from '../RoomDocManager.js';
import { RoomSnapshot } from '../RoomSnapshot.js';

export function useRoomSnapshot(roomId: string | undefined): RoomSnapshot | null {
  const [snapshot, setSnapshot] = useState<RoomSnapshot | null>(null);

  useEffect(() => {
    if (!roomId || !/^[A-Za-z0-9_-]+$/.test(roomId)) {
      setSnapshot(null);
      return;
    }

    const manager = RoomDocManager.getInstance(roomId);
    const unsubscribe = manager.subscribe(setSnapshot);

    return () => {
      unsubscribe();
      // Note: We don't destroy the manager here as other components may be using it
      // The manager will be destroyed when the room is left
    };
  }, [roomId]);

  return snapshot;
}
