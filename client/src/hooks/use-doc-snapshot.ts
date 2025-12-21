import { useEffect, useState } from 'react';
import { RoomId, DocSnapshot } from '@avlo/shared';
import { useRoomDoc } from './use-room-doc';

/**
 * Hook to subscribe to doc snapshot updates (without presence).
 * Returns the current immutable doc snapshot.
 * Preferred over useSnapshot for doc-only access.
 */
export function useDocSnapshot(roomId: RoomId): DocSnapshot {
  const roomDoc = useRoomDoc(roomId);
  const [snapshot, setSnapshot] = useState<DocSnapshot>(roomDoc.currentDocSnapshot);

  useEffect(() => {
    // Subscribe to doc snapshot updates (without presence)
    const unsub = roomDoc.subscribeDocSnapshot((newSnapshot) => {
      setSnapshot(newSnapshot);
    });

    return unsub;
  }, [roomDoc]);

  return snapshot;
}
