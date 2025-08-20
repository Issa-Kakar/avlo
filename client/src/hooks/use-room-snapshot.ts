import { useEffect, useState } from 'react';
import { RoomId, Snapshot } from '@avlo/shared';
import { useRoomDoc } from './use-room-doc';

/**
 * Hook to subscribe to room snapshot updates
 * Returns the current immutable snapshot
 * UI components should use this instead of accessing the manager directly
 */
export function useRoomSnapshot(roomId: RoomId): Snapshot {
  const roomDoc = useRoomDoc(roomId);
  const [snapshot, setSnapshot] = useState<Snapshot>(roomDoc.currentSnapshot);

  useEffect(() => {
    // Subscribe to snapshot updates
    const unsub = roomDoc.subscribeSnapshot((newSnapshot) => {
      setSnapshot(newSnapshot);
    });

    return unsub;
  }, [roomDoc]);

  return snapshot;
}
