import React from 'react';
import { useDeviceUIStore } from '../stores/device-ui-store';
import type { IRoomDocManager } from '../lib/room-doc-manager';

interface ClearBoardButtonProps {
  room: IRoomDocManager;
  roomId: string;
  scene: number;
  className?: string;
}

/**
 * Clear Board button component with lastSeenScene tracking
 * No cooldown implemented as per Phase 6-7 integration requirements
 */
export function ClearBoardButton({ room, roomId, scene, className = '' }: ClearBoardButtonProps) {
  const updateLastSeenScene = useDeviceUIStore((s) => s.updateLastSeenScene);

  const handleClear = () => {
    // Optimistically update lastSeenScene to the next scene
    updateLastSeenScene(roomId, scene + 1);

    // Perform the clear board mutation using the room's mutate method
    // The mutate function provides the ydoc - we don't import Yjs directly
    room.mutate((ydoc) => {
      const root = ydoc.getMap('root');
      const meta = root.get('meta') as any; // Using any to avoid Y.Map type
      const sceneTicks = meta.get('scene_ticks') as any; // Using any to avoid Y.Array type

      if (sceneTicks) {
        const timestamp = Date.now();
        sceneTicks.push([timestamp]);
      }
    });
  };

  return (
    <button
      onClick={handleClear}
      className={`px-3 py-1 bg-blue-500 text-white rounded hover:bg-blue-600 transition-colors ${className}`}
      title="Clear board for everyone"
    >
      Clear Board
    </button>
  );
}
