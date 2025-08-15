// Never mutate Y.Doc guid; persistence is per-room and not cleared on leave.
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { IndexeddbPersistence } from 'y-indexeddb';
import { getWsUrl } from '../utils/url.js';

export interface YjsProviders {
  ydoc: Y.Doc;
  wsProvider: WebsocketProvider;
  indexeddbProvider: IndexeddbPersistence;
}

export function createYDoc(roomId: string): Y.Doc {
  return new Y.Doc({ guid: roomId });
}

export function createProviders(roomId: string): YjsProviders {
  const ydoc = createYDoc(roomId);

  // Attach IndexedDB persistence (never delete on leave)
  const indexeddbProvider = new IndexeddbPersistence(roomId, ydoc);

  // Attach WebSocket provider
  const wsUrl = getWsUrl();
  const wsProvider = new WebsocketProvider(wsUrl, roomId, ydoc, {
    connect: true,
    params: {},
    protocols: [],
    resyncInterval: 5000,
  });

  return {
    ydoc,
    wsProvider,
    indexeddbProvider,
  };
}

export function teardownProviders(providers: YjsProviders): void {
  providers.wsProvider.destroy();
  providers.indexeddbProvider.destroy();
  providers.ydoc.destroy();
}
