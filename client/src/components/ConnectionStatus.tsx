import React from 'react';
import { useRoomDoc } from '../hooks/use-room-doc';
import { useRoomStats } from '../hooks/use-room-stats';
import { ROOM_CONFIG } from '@avlo/shared';

interface ConnectionStatusProps {
  roomId: string;
}

export function ConnectionStatus({ roomId }: ConnectionStatusProps) {
  const room = useRoomDoc(roomId);
  const gates = room.getGateStatus();
  const stats = useRoomStats(roomId);

  let status = 'Offline';
  let className = 'text-gray-500';

  if (gates.wsSynced) {
    status = 'Online';
    className = 'text-green-500';
  } else if (gates.wsConnected) {
    status = 'Syncing...';
    className = 'text-yellow-500';
  }

  // Check if room is read-only
  if (stats && stats.bytes >= ROOM_CONFIG.ROOM_SIZE_READONLY_BYTES) {
    status = 'Read-only';
    className = 'text-red-500';
  }

  return (
    <div className={`flex items-center gap-2 text-sm ${className}`}>
      <div className={`w-2 h-2 rounded-full ${className.replace('text', 'bg')}`} />
      <span>{status}</span>
    </div>
  );
}
