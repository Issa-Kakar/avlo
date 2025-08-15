// Never mutate Y.Doc guid; persistence is per-room and not cleared on leave.
import { useEffect, useRef, useState } from 'react';
import type { Doc } from 'yjs';
import type { WebsocketProvider } from 'y-websocket';
import type { Awareness } from 'y-protocols/awareness';
import { createProviders, teardownProviders, YjsProviders } from '../providers/yjsClient.js';
import { generateUserName, generateUserColor, Presence } from '../state/presence.js';

export interface RoomHandles {
  roomId: string;
  ydoc: Doc;
  provider: WebsocketProvider;
  awareness: Awareness;
  readOnly: boolean;
  destroy: () => void;
}

export function useRoom(roomId: string | undefined): RoomHandles | null {
  const [isValid, setIsValid] = useState(false);
  const [readOnly, setReadOnly] = useState(false);
  const providersRef = useRef<YjsProviders | null>(null);
  const userInfoRef = useRef<{ name: string; color: string } | null>(null);

  // Validate room ID
  useEffect(() => {
    if (!roomId) {
      setIsValid(false);
      return;
    }
    setIsValid(/^[A-Za-z0-9_-]+$/.test(roomId));
  }, [roomId]);

  // Setup providers
  useEffect(() => {
    if (!isValid || !roomId) return;

    // Generate user info once per session
    if (!userInfoRef.current) {
      userInfoRef.current = {
        name: generateUserName(),
        color: generateUserColor(),
      };
    }

    // Create providers
    const providers = createProviders(roomId);
    providersRef.current = providers;

    // Set up awareness with presence
    const awareness = providers.wsProvider.awareness;
    const presence: Presence = {
      name: userInfoRef.current.name,
      color: userInfoRef.current.color,
      cursor: null,
      activity: 'idle',
    };
    awareness.setLocalStateField('user', presence);

    // Handle room stats messages
    const handleMessage = (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'room_stats' && data.bytes >= data.cap) {
          setReadOnly(true);
        }
      } catch {
        // Ignore non-JSON messages
      }
    };

    if (providers.wsProvider.ws) {
      providers.wsProvider.ws.addEventListener('message', handleMessage);
    }

    // Cleanup on unmount
    return () => {
      if (providers.wsProvider.ws) {
        providers.wsProvider.ws.removeEventListener('message', handleMessage);
      }
      awareness.setLocalState(null);
      teardownProviders(providers);
      providersRef.current = null;
    };
  }, [isValid, roomId]);

  if (!isValid || !roomId || !providersRef.current) {
    return null;
  }

  return {
    roomId,
    ydoc: providersRef.current.ydoc,
    provider: providersRef.current.wsProvider,
    awareness: providersRef.current.wsProvider.awareness,
    readOnly,
    destroy: () => {
      if (providersRef.current) {
        teardownProviders(providersRef.current);
        providersRef.current = null;
      }
    },
  };
}
