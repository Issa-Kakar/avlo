import { useCallback } from 'react';
import { toast } from '../app/utils/toast.js';

export type GatewayErrorType =
  | 'room_full'
  | 'room_full_readonly'
  | 'offline_delta_too_large'
  | 'create_room_rate_limited';

export interface GatewayError {
  type: GatewayErrorType;
  message?: string;
  details?: any;
}

/**
 * Hook for handling gateway errors and mapping them to UI responses.
 *
 * Per Phase 8 requirements:
 * - room_full → toast "Room is full — create a new room."
 * - room_full_readonly → switch client to Read-only and show banner; awareness continues
 * - offline_delta_too_large → toast "Change too large. Refresh to rejoin."
 * - create_room_rate_limited (HTTP 429) → toast "Too many requests — try again shortly." (include backoff hint)
 */
export function useGatewayErrors(onReadOnlyStateChange?: (readOnly: boolean) => void) {
  const handleGatewayError = useCallback(
    (error: GatewayError) => {
      switch (error.type) {
        case 'room_full':
          toast.error('Room is full — create a new room.');
          break;

        case 'room_full_readonly':
          // Switch client to read-only mode
          if (onReadOnlyStateChange) {
            onReadOnlyStateChange(true);
          }
          // Note: Banner will be shown by the read-only state in the UI
          break;

        case 'offline_delta_too_large':
          toast.error('Change too large. Refresh to rejoin.');
          break;

        case 'create_room_rate_limited': {
          // Include backoff hint for rate limiting
          const backoffSeconds = error.details?.retryAfter || 60;
          const backoffMinutes = Math.ceil(backoffSeconds / 60);
          const hint =
            backoffMinutes > 1 ? ` Try again in ${backoffMinutes} minutes.` : ' Try again shortly.';
          toast.error(`Too many requests —${hint}`);
          break;
        }

        default:
          console.warn('[GatewayErrors] Unknown gateway error type:', error.type);
      }
    },
    [onReadOnlyStateChange],
  );

  const handleWebSocketError = useCallback(
    (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data);

        // Check if this is a gateway error message
        if (
          data.type &&
          ['room_full', 'room_full_readonly', 'offline_delta_too_large'].includes(data.type)
        ) {
          handleGatewayError({
            type: data.type as GatewayErrorType,
            message: data.message,
            details: data.details,
          });
        }
      } catch {
        // Ignore invalid JSON or non-gateway messages
      }
    },
    [handleGatewayError],
  );

  const handleHttpError = useCallback(
    (response: Response) => {
      if (response.status === 429) {
        // Extract retry-after header if available
        const retryAfter = response.headers.get('Retry-After');
        const retryAfterSeconds = retryAfter ? parseInt(retryAfter, 10) : undefined;

        handleGatewayError({
          type: 'create_room_rate_limited',
          details: {
            retryAfter: retryAfterSeconds,
            status: response.status,
          },
        });
        return true; // Handled
      }

      return false; // Not handled
    },
    [handleGatewayError],
  );

  return {
    handleGatewayError,
    handleWebSocketError,
    handleHttpError,
  };
}

/**
 * Utility to extract gateway error from WebSocket message
 */
export function parseGatewayError(message: string): GatewayError | null {
  try {
    const data = JSON.parse(message);

    if (
      data.type &&
      ['room_full', 'room_full_readonly', 'offline_delta_too_large'].includes(data.type)
    ) {
      return {
        type: data.type as GatewayErrorType,
        message: data.message,
        details: data.details,
      };
    }
  } catch {
    // Not a valid gateway error message
  }

  return null;
}

/**
 * Utility to check if an HTTP response represents a gateway error
 */
export function isGatewayHttpError(response: Response): boolean {
  return response.status === 429; // create_room_rate_limited
}
