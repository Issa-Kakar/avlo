import { useEffect, useState } from 'react';
import { useRoomDoc } from './use-room-doc';
/**
 * Hook to subscribe to snapshot updates
 * Returns the current immutable snapshot
 */
export function useSnapshot(roomId) {
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
