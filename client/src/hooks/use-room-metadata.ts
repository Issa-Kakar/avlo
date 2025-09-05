import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '../lib/api-client';
import { useEffect } from 'react';
import { useRoomDoc } from './use-room-doc';
import { ROOM_CONFIG } from '@avlo/shared';

export function useRoomMetadata(roomId: string) {
  const room = useRoomDoc(roomId);

  const query = useQuery({
    queryKey: ['rooms', 'metadata', roomId],
    queryFn: () => apiClient.getRoomMetadata(roomId),
    staleTime: 10_000, // 10 seconds
    retry: 1,
    refetchOnWindowFocus: false,
    refetchInterval: 10_000, // Poll every 10s
  });

  // Update room stats when metadata changes
  useEffect(() => {
    if (query.data) {
      // Use public API to set room stats
      room.setRoomStats({
        bytes: query.data.sizeBytes,
        cap: ROOM_CONFIG.ROOM_SIZE_READONLY_BYTES,
        expiresAt: new Date(query.data.expiresAt).getTime(),
      });
    } else if (query.error?.message?.includes('not found')) {
      // Room expired
      room.setRoomStats(null);
    }
  }, [query.data, query.error, room]);

  return query;
}

export function useRenameRoom(roomId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (title: string) => apiClient.renameRoom(roomId, title),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['rooms', 'metadata', roomId] });
    },
  });
}
