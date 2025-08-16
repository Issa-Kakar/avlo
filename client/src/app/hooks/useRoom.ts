// Never mutate Y.Doc guid; persistence is per-room and not cleared on leave.
import { useEffect, useRef, useState } from 'react';
import type { Doc } from 'yjs';
import type { WebsocketProvider } from 'y-websocket';
import type { Awareness } from 'y-protocols/awareness';
import { createProviders, teardownProviders, YjsProviders } from '../providers/yjsClient.js';
import { generateUserName, generateUserColor, Presence } from '../state/presence.js';
import { toast } from '../utils/toast.js';
import { useGatewayErrors } from '../../hooks/useGatewayErrors.js';
import { isLimitsUIEnabled } from '../../limits/index.js';

export interface RoomHandles {
  roomId: string;
  ydoc: Doc;
  provider: WebsocketProvider;
  awareness: Awareness;
  readOnly: boolean;
  roomStats?: { bytes: number; cap: number; softWarn: boolean };
  destroy: () => void;
}

export function useRoom(roomId: string | undefined): RoomHandles | null {
  // Initialize isValid based on the initial roomId
  const [isValid, setIsValid] = useState(() => {
    if (!roomId) {
      console.log('[useRoom] Initial validation: No room ID');
      return false;
    }
    const valid = /^[A-Za-z0-9_-]+$/.test(roomId);
    console.log('[useRoom] Initial validation for roomId:', roomId, 'valid:', valid);
    return valid;
  });
  const [readOnly, setReadOnly] = useState(false);
  const [roomStats, setRoomStats] = useState<
    { bytes: number; cap: number; softWarn: boolean } | undefined
  >();
  const [providers, setProviders] = useState<YjsProviders | null>(null);
  const userInfoRef = useRef<{ name: string; color: string } | null>(null);

  // Phase 8: Gateway error handling
  const { handleGatewayError, handleWebSocketError } = useGatewayErrors(
    isLimitsUIEnabled() ? setReadOnly : undefined,
  );

  // Validate room ID when it changes
  useEffect(() => {
    console.log('[useRoom] Validating room ID:', roomId);
    if (!roomId) {
      console.log('[useRoom] No room ID provided');
      setIsValid(false);
      return;
    }
    const valid = /^[A-Za-z0-9_-]+$/.test(roomId);
    console.log('[useRoom] Room ID valid:', valid);
    setIsValid(valid);
  }, [roomId]);

  // Setup providers
  useEffect(() => {
    console.log('[useRoom] Provider setup - isValid:', isValid, 'roomId:', roomId);
    if (!isValid || !roomId) {
      console.log('[useRoom] Skipping provider setup');
      return;
    }

    // Don't recreate providers if they already exist for this room
    if (providers && providers.ydoc.guid === roomId) {
      console.log('[useRoom] Providers already exist for room:', roomId);
      return;
    }

    // Generate user info once per session
    if (!userInfoRef.current) {
      userInfoRef.current = {
        name: generateUserName(),
        color: generateUserColor(),
      };
    }

    console.log('[useRoom] Creating providers for room:', roomId);
    // Create providers
    const newProviders = createProviders(roomId);
    setProviders(newProviders);
    console.log('[useRoom] Providers created and stored in state');

    // Set up awareness with presence
    const awareness = newProviders.wsProvider.awareness;
    const presence: Presence = {
      name: userInfoRef.current.name,
      color: userInfoRef.current.color,
      cursor: null,
      activity: 'idle',
    };
    awareness.setLocalStateField('user', presence);

    // Cleanup on unmount
    return () => {
      console.log('[useRoom] Cleanup - tearing down providers');
      awareness.setLocalState(null);
      teardownProviders(newProviders);
      // Only clear the state if it's still the same providers instance
      setProviders((current) => (current === newProviders ? null : current));
    };
  }, [isValid, roomId]); // Don't include providers in deps - that causes infinite loop!

  // Handle WebSocket messages with proper race condition handling
  useEffect(() => {
    const provider = providers?.wsProvider;
    if (!provider) return;

    let detach: (() => void) | null = null;

    const attach = () => {
      // guard: provider.ws may not exist immediately
      const ws: WebSocket | undefined = (provider as any).ws;
      if (!ws) return;

      const onMessage = (ev: MessageEvent) => {
        // Phase 8: Handle room stats and gateway errors
        if (isLimitsUIEnabled()) {
          // Try Phase 8 gateway error handling first
          handleWebSocketError(ev);
        }

        // handle custom advisories like { type: 'room_stats', ... }
        try {
          const data = JSON.parse(ev.data);

          // Phase 8: Handle room stats messages
          if (
            data?.type === 'room_stats' &&
            typeof data.bytes === 'number' &&
            typeof data.cap === 'number'
          ) {
            const stats = {
              bytes: data.bytes,
              cap: data.cap,
              softWarn: data.bytes >= 0.8 * data.cap,
            };
            setRoomStats(stats);
            setReadOnly(data.bytes >= data.cap);
          }

          // Legacy error handling (Phase 8 takes precedence if enabled)
          if (!isLimitsUIEnabled()) {
            // Handle room full error
            if (data?.type === 'error' && data?.code === 'ROOM_FULL') {
              setReadOnly(true);
              toast.error('Room is full — create a new room.');
            }
            // Handle offline delta too large
            if (data?.type === 'error' && data?.code === 'DELTA_TOO_LARGE') {
              toast.error('Change too large. Refresh to rejoin.');
            }
          }
        } catch {
          // Ignore non-JSON messages or binary Yjs messages
        }
      };
      ws.addEventListener('message', onMessage);
      detach = () => ws.removeEventListener('message', onMessage);
    };

    const onStatus = ({ status }: { status: string }) => {
      if (status === 'connected') {
        detach?.(); // avoid duplicates
        attach();
      } else {
        detach?.();
        detach = null;
      }
    };

    provider.on('status', onStatus);
    // in case we were already connected by the time this ran
    const maybeWsConnected = (provider as unknown as { wsconnected?: boolean }).wsconnected;
    if (maybeWsConnected) attach();

    return () => {
      provider.off('status', onStatus);
      detach?.();
    };
  }, [providers]);

  // Phase 8: Test hooks to simulate stats/errors without WS coupling
  useEffect(() => {
    if (!isLimitsUIEnabled()) return;

    const onCustomStats = (ev: Event) => {
      const e = ev as CustomEvent;
      const data = e.detail as { bytes: number; cap?: number } | undefined;
      if (!data || typeof data.bytes !== 'number') return;
      const cap = typeof data.cap === 'number' ? data.cap : 10 * 1024 * 1024;
      console.log('[useRoom][TestHook] room-stats-update received', { bytes: data.bytes, cap });
      setRoomStats({ bytes: data.bytes, cap, softWarn: data.bytes >= 0.8 * cap });
      setReadOnly(data.bytes >= cap);
      console.log('[useRoom][TestHook] state after stats', { readOnly: data.bytes >= cap });
    };

    const onGatewayError = (ev: Event) => {
      const e = ev as CustomEvent;
      const payload = e.detail;
      try {
        if (payload && typeof payload.type === 'string') {
          console.log('[useRoom][TestHook] gateway-error received', payload);
          // Reuse existing handler
          handleGatewayError(payload);
        }
      } catch {
        // ignore
      }
    };

    type Listener = (evt: Event) => void;
    const onCustomStatsListener: Listener = onCustomStats;
    const onGatewayErrorListener: Listener = onGatewayError;

    window.addEventListener('room-stats-update', onCustomStatsListener);
    window.addEventListener('gateway-error', onGatewayErrorListener);
    try {
      (window as any).__phase8TestReady = true;
      console.log('[useRoom][TestHook] listeners attached, __phase8TestReady=true');
    } catch {
      void 0;
    }
    return () => {
      window.removeEventListener('room-stats-update', onCustomStatsListener);
      window.removeEventListener('gateway-error', onGatewayErrorListener);
      try {
        (window as any).__phase8TestReady = false;
      } catch {
        void 0;
      }
    };
  }, [handleGatewayError]);

  const hasProviders = !!providers;
  console.log(
    '[useRoom] Check before return - isValid:',
    isValid,
    'roomId:',
    roomId,
    'hasProviders:',
    hasProviders,
  );

  if (!isValid || !roomId || !providers) {
    console.log('[useRoom] Returning null');
    return null;
  }

  console.log('[useRoom] Returning room handles for room:', roomId);
  return {
    roomId,
    ydoc: providers.ydoc,
    provider: providers.wsProvider,
    awareness: providers.wsProvider.awareness,
    readOnly,
    roomStats,
    destroy: () => {
      if (providers) {
        teardownProviders(providers);
        setProviders(null);
      }
    },
  };
}
