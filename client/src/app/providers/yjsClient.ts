// Never mutate Y.Doc guid; persistence is per-room and not cleared on leave.
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { IndexeddbPersistence } from 'y-indexeddb';
import { getWsUrl } from '../utils/url.js';
import { computeBackoff } from '../hooks/useReconnector.js';

export interface YjsProviders {
  ydoc: Y.Doc;
  wsProvider: WebsocketProvider;
  indexeddbProvider: IndexeddbPersistence;
}

export function createYDoc(roomId: string): Y.Doc {
  return new Y.Doc({ guid: roomId });
}

class ReconnectingWebsocketProvider extends WebsocketProvider {
  private reconnectAttempt = 0;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private isDestroyed = false;

  constructor(url: string, roomId: string, doc: Y.Doc, opts: any) {
    super(url, roomId, doc, opts);
    this.setupReconnection();
  }

  private setupReconnection() {
    const originalConnect = this.connect.bind(this);

    this.connect = () => {
      if (this.isDestroyed) return;
      this.reconnectAttempt = 0;
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = undefined;
      }
      originalConnect();
    };

    this.on('status', ({ status }: { status: string }) => {
      if (this.isDestroyed) return;

      if (status === 'connected') {
        this.reconnectAttempt = 0;
        if (this.reconnectTimer) {
          clearTimeout(this.reconnectTimer);
          this.reconnectTimer = undefined;
        }
      } else if (status === 'disconnected' && !this.isDestroyed) {
        this.scheduleReconnect();
      }
    });
  }

  private scheduleReconnect() {
    if (this.isDestroyed || this.reconnectTimer) return;

    const backoffMs = computeBackoff(this.reconnectAttempt);
    this.reconnectAttempt++;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (!this.isDestroyed) {
        this.connect();
      }
    }, backoffMs);
  }

  destroy() {
    this.isDestroyed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    super.destroy();
  }
}

export function createProviders(roomId: string): YjsProviders {
  const ydoc = createYDoc(roomId);

  // Attach IndexedDB persistence (never delete on leave)
  let indexeddbProvider: IndexeddbPersistence;
  try {
    indexeddbProvider = new IndexeddbPersistence(roomId, ydoc);
  } catch {
    console.warn('IndexedDB not available (private mode?), continuing without local persistence');
    // Create a dummy provider that does nothing
    indexeddbProvider = {
      destroy: () => {},
    } as IndexeddbPersistence;
  }

  // Attach WebSocket provider with reconnection logic
  const wsUrl = getWsUrl();
  const wsProvider = new ReconnectingWebsocketProvider(wsUrl, roomId, ydoc, {
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
