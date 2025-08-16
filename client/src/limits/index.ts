/**
 * Phase 8 Limits UI Feature Module
 *
 * Provides room size limits UI and gateway error mapping.
 * Feature flag: LIMITS_UI_ENABLED (default on in dev)
 */

// Feature flag management
export function isLimitsUIEnabled(): boolean {
  // Check for e2e test flag first
  if (typeof window !== 'undefined' && (window as any).__LIMITS_UI_ENABLED_OVERRIDE !== undefined) {
    return (window as any).__LIMITS_UI_ENABLED_OVERRIDE;
  }

  // Check environment variable or localStorage override
  if (typeof window !== 'undefined') {
    const localOverride = localStorage.getItem('LIMITS_UI_ENABLED');
    if (localOverride !== null) {
      return localOverride !== 'false';
    }
  }

  // Default to true in development, or if explicitly enabled via env
  return process.env.NODE_ENV === 'development' || process.env.LIMITS_UI_ENABLED === 'true';
}

// Component exports
export { SizePill, SizePillContainer } from '../ui/limits/SizePill';
export { ReadonlyBanner, ReadonlyBannerCompact } from '../ui/limits/ReadonlyBanner';

// State management exports
import {
  useRoomStats,
  useRoomStatsUpdater,
  formatBytes,
  type RoomStats,
  type RoomStatsMessage,
} from '../state/roomStats';

export { useRoomStats, useRoomStatsUpdater, formatBytes, type RoomStats, type RoomStatsMessage };

// Error handling exports
import {
  useGatewayErrors,
  parseGatewayError,
  isGatewayHttpError,
  type GatewayErrorType,
  type GatewayError,
} from '../hooks/useGatewayErrors';

export {
  useGatewayErrors,
  parseGatewayError,
  isGatewayHttpError,
  type GatewayErrorType,
  type GatewayError,
};

// Integration helpers
export interface LimitsUIConfig {
  roomId?: string;
  onReadOnlyChange?: (readOnly: boolean) => void;
  onCreateRoom?: () => void;
}

/**
 * Main integration hook for limits UI
 */
export function useLimitsUI(config: LimitsUIConfig) {
  const { roomId, onReadOnlyChange } = config;

  // Only enable if feature flag is on
  const isEnabled = isLimitsUIEnabled();

  // Get room stats
  const roomStats = useRoomStats(isEnabled ? roomId : undefined);

  // Get gateway error handlers
  const { handleGatewayError, handleWebSocketError, handleHttpError } = useGatewayErrors(
    isEnabled ? onReadOnlyChange : undefined,
  );

  return {
    isEnabled,
    roomStats,
    handlers: {
      handleGatewayError,
      handleWebSocketError,
      handleHttpError,
    },
  };
}

// Constants
export const LIMITS_CONSTANTS = {
  DEFAULT_CAP: 10 * 1024 * 1024, // 10 MB
  SOFT_WARN_THRESHOLD: 0.8, // 80%
  STATS_UPDATE_INTERVAL: 5000, // 5 seconds max
  MIN_STATS_DELTA: 100 * 1024, // 100 KB minimum delta
} as const;
