import { useEffect, useState } from 'react';
import { useRoomDoc } from './use-room-doc';
/**
 * Hook to subscribe to room statistics updates
 * Returns the current room stats (size/cap) or null
 */
export function useRoomStats(roomId) {
    const roomDoc = useRoomDoc(roomId);
    const [stats, setStats] = useState(null);
    useEffect(() => {
        // Subscribe to room stats updates
        const unsub = roomDoc.subscribeRoomStats((newStats) => {
            setStats(newStats);
        });
        return unsub;
    }, [roomDoc]);
    return stats;
}
