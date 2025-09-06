import React from 'react';
import { useConnectionGates } from '../hooks/use-connection-gates';
import { useRoomStats } from '../hooks/use-room-stats';
import { ROOM_CONFIG } from '@avlo/shared';

interface ConnectionStatusProps {
  roomId: string;
}

export function ConnectionStatus({ roomId }: ConnectionStatusProps) {
  const { isOnline } = useConnectionGates(roomId);
  const stats = useRoomStats(roomId);

  let status = 'Offline';
  let className = 'text-gray-500';

  if (isOnline) {
    status = 'Online';
    className = 'text-green-500';
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
