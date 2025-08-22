import { useEffect, useState } from 'react';
import { useRoomDoc } from './use-room-doc';
/**
 * Hook to subscribe to presence updates
 * Returns the current presence view
 */
export function usePresence(roomId) {
    const roomDoc = useRoomDoc(roomId);
    const [presence, setPresence] = useState(roomDoc.currentSnapshot.presence);
    useEffect(() => {
        // Subscribe to presence updates
        const unsub = roomDoc.subscribePresence((newPresence) => {
            setPresence(newPresence);
        });
        return unsub;
    }, [roomDoc]);
    return presence;
}
