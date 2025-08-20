import { useEffect, useState } from 'react';
import { RoomId, Snapshot } from '@avlo/shared';
import { useRoomDoc } from './use-room-doc';

/**
 * Hook to subscribe to snapshot updates
 * Returns the current immutable snapshot
 */
export function useSnapshot(roomId: RoomId): Snapshot {
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
