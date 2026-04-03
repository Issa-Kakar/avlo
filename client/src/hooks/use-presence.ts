import { useEffect, useState } from 'react';
import type { PresenceView } from '@/types/awareness';
import { getActiveRoomDoc } from '@/canvas/room-runtime';

/**
 * Hook to subscribe to presence updates.
 * Returns the current presence view.
 * Parent must remount via key={roomId} on room switch.
 */
export function usePresence(): PresenceView {
  const [presence, setPresence] = useState<PresenceView>(() => getActiveRoomDoc().currentPresence);

  useEffect(() => {
    const unsub = getActiveRoomDoc().subscribePresence((newPresence) => {
      setPresence(newPresence);
    });
    return unsub;
  }, []);

  return presence;
}
