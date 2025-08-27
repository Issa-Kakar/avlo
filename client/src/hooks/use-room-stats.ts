import { useEffect, useState } from 'react';
import { RoomId } from '@avlo/shared';
import { useRoomDoc } from './use-room-doc';

interface RoomStats {
  bytes: number;
  cap: number;
}

/**
 * Hook to subscribe to room statistics updates
 * Returns the current room stats (size/cap) or null
 */
export function useRoomStats(roomId: RoomId): RoomStats | null {
  const roomDoc = useRoomDoc(roomId);
  const [stats, setStats] = useState<RoomStats | null>(null);

  useEffect(() => {
    // Subscribe to room stats updates
    const unsub = roomDoc.subscribeRoomStats((newStats) => {
      setStats(newStats);
    });

    return unsub;
  }, [roomDoc]);

  return stats;
}
