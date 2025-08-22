import { useEffect, useState } from 'react';
import { useRoomDoc } from './use-room-doc';
/**
 * Hook to subscribe to room snapshot updates
 * Returns the current immutable snapshot
 * UI components should use this instead of accessing the manager directly
 */
export function useRoomSnapshot(roomId) {
    const roomDoc = useRoomDoc(roomId);
    const [snapshot, setSnapshot] = useState(roomDoc.currentSnapshot);
    useEffect(() => {
        // Subscribe to snapshot updates
        const unsub = roomDoc.subscribeSnapshot((newSnapshot) => {
            setSnapshot(newSnapshot);
        });
        return unsub;
    }, [roomDoc]);
    return snapshot;
}
