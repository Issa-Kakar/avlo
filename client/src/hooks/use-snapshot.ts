import { useEffect, useState } from 'react';
import type { RoomId } from '@avlo/shared';
import type { Snapshot } from '@/types/snapshot';
import { useRoomDoc } from './use-room-doc';

/**
 * Hook to subscribe to snapshot updates (without presence).
 * Returns the current immutable snapshot.
 */
export function useSnapshot(roomId: RoomId): Snapshot {
  const roomDoc = useRoomDoc(roomId);
  const [snapshot, setSnapshot] = useState<Snapshot>(roomDoc.currentSnapshot);

  useEffect(() => {
    // Subscribe to snapshot updates (without presence)
    const unsub = roomDoc.subscribeSnapshot((newSnapshot) => {
      setSnapshot(newSnapshot);
    });

    return unsub;
  }, [roomDoc]);

  return snapshot;
}
