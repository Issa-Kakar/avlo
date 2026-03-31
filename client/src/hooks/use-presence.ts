import { useEffect, useState } from 'react';
import type { RoomId } from '@avlo/shared';
import type { PresenceView } from '@/types/awareness';
import { useRoomDoc } from './use-room-doc';

/**
 * Hook to subscribe to presence updates
 * Returns the current presence view
 */
export function usePresence(roomId: RoomId): PresenceView {
  const roomDoc = useRoomDoc(roomId);
  const [presence, setPresence] = useState<PresenceView>(roomDoc.currentPresence);

  useEffect(() => {
    // Subscribe to presence updates
    const unsub = roomDoc.subscribePresence((newPresence) => {
      setPresence(newPresence);
    });

    return unsub;
  }, [roomDoc]);

  return presence;
}
