import { useState, useEffect, useCallback } from 'react';

export interface RoomStats {
  bytes: number;
  cap: number;
  softWarn: boolean;
  readOnly: boolean;
  lastUpdated: number;
}

export interface RoomStatsMessage {
  type: 'room_stats';
  bytes: number;
  cap: number;
}

const DEFAULT_CAP = 10 * 1024 * 1024; // 10 MB default cap
const SOFT_WARN_THRESHOLD = 0.8; // 80% of cap

/**
 * Room statistics state management for Phase 8 limits UI.
 * Subscribes to server's {bytes, cap} advisories and derives UI states.
 *
 * Server publishes stats ≤5s or after ≥100KB growth.
 * Until first stat arrives, show nothing (or advisory estimate).
 */
export function useRoomStats(roomId?: string): RoomStats | null {
  const [stats, setStats] = useState<RoomStats | null>(null);

  const updateStats = useCallback((bytes: number, cap: number = DEFAULT_CAP) => {
    const newStats: RoomStats = {
      bytes,
      cap,
      softWarn: bytes >= SOFT_WARN_THRESHOLD * cap,
      readOnly: bytes >= cap,
      lastUpdated: Date.now(),
    };

    setStats(newStats);
  }, []);

  const handleRoomStatsMessage = useCallback(
    (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data);
        if (
          data.type === 'room_stats' &&
          typeof data.bytes === 'number' &&
          typeof data.cap === 'number'
        ) {
          updateStats(data.bytes, data.cap);
        }
      } catch {
        // Ignore invalid JSON or malformed messages
      }
    },
    [updateStats],
  );

  useEffect(() => {
    if (!roomId) {
      setStats(null);
      return;
    }

    // Reset stats when room changes
    setStats(null);

    // Listen for room stats messages from WebSocket
    // These come through the existing y-websocket connection

    // Note: In the current architecture, we'll need to integrate this with
    // the existing y-websocket provider. For now, set up the handler structure.
    // The actual WebSocket integration will be done in the limits integration.

    return () => {
      // Cleanup will be handled in integration
    };
  }, [roomId, handleRoomStatsMessage]);

  return stats;
}

/**
 * Hook to manually update room stats (for testing or local estimates)
 */
export function useRoomStatsUpdater(): (bytes: number, cap?: number) => void {
  const [, setStats] = useState<RoomStats | null>(null);

  return useCallback((bytes: number, cap: number = DEFAULT_CAP) => {
    const newStats: RoomStats = {
      bytes,
      cap,
      softWarn: bytes >= SOFT_WARN_THRESHOLD * cap,
      readOnly: bytes >= cap,
      lastUpdated: Date.now(),
    };

    setStats(newStats);

    // Emit custom event for other components to listen
    window.dispatchEvent(
      new CustomEvent('room-stats-update', {
        detail: newStats,
      }),
    );
  }, []);
}

/**
 * Format bytes for display in the size pill
 */
export function formatBytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return mb.toFixed(1);
}
