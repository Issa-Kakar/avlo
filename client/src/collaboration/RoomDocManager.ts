import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { IndexeddbPersistence } from 'y-indexeddb';
import { RoomSnapshot, UserPresence, WriteOperation } from './RoomSnapshot.js';
import { getWsUrl } from '../app/utils/url.js';
import { generateUserName, generateUserColor } from '../app/state/presence.js';

export class RoomDocManager {
  private static instances = new Map<string, RoomDocManager>();

  private ydoc: Y.Doc;
  private wsProvider: WebsocketProvider | null = null;
  private idbProvider: IndexeddbPersistence | null = null;
  private snapshot: RoomSnapshot;
  private subscribers = new Set<(snapshot: RoomSnapshot) => void>();
  private updateTimer: number | null = null;
  private destroyed = false;
  private writeQueue: WriteOperation[] = [];
  private processingQueue = false;

  // User info generated once per session
  private localUser: UserPresence;

  private constructor(roomId: string) {
    // CRITICAL: Construct Y.Doc with guid once, never mutate
    this.ydoc = new Y.Doc({ guid: roomId });

    // Generate user info
    this.localUser = {
      id: this.ydoc.clientID.toString(),
      name: generateUserName(),
      color: generateUserColor(),
      cursor: null,
      activity: 'idle',
    };

    // Initialize snapshot
    this.snapshot = {
      epoch: Date.now(),
      roomId,
      connectionState: 'connecting',
      isReadOnly: false,
      presence: new Map(),
      localUser: this.localUser,
    };

    this.setupProviders(roomId);
    this.startSnapshotLoop();
  }

  static getInstance(roomId: string): RoomDocManager {
    if (!RoomDocManager.instances.has(roomId)) {
      RoomDocManager.instances.set(roomId, new RoomDocManager(roomId));
    }
    return RoomDocManager.instances.get(roomId)!;
  }

  private setupProviders(roomId: string) {
    // IndexedDB persistence (offline-first)
    this.idbProvider = new IndexeddbPersistence(roomId, this.ydoc);

    // WebSocket provider with reconnection
    const wsUrl = getWsUrl();
    this.wsProvider = new WebsocketProvider(wsUrl, roomId, this.ydoc, {
      connect: true,
      params: { v: import.meta.env.VITE_APP_VERSION || 'dev' },
    });

    // Set initial awareness
    this.wsProvider.awareness.setLocalStateField('user', this.localUser);

    // Listen for connection state changes
    this.wsProvider.on('status', ({ status }: { status: string }) => {
      this.updateConnectionState(status as any);
    });

    // Listen for awareness changes
    this.wsProvider.awareness.on('change', () => {
      this.scheduleSnapshot();
    });
  }

  private startSnapshotLoop() {
    // Listen for document changes
    this.ydoc.on('update', () => {
      this.scheduleSnapshot();
    });

    // Listen for subdoc events if needed
    this.ydoc.on('subdocs', () => {
      this.scheduleSnapshot();
    });
  }

  private scheduleSnapshot() {
    if (this.destroyed || this.updateTimer !== null) return;

    // Batch updates to max 60 FPS
    this.updateTimer = requestAnimationFrame(() => {
      this.updateTimer = null;
      this.publishSnapshot();
    });
  }

  private publishSnapshot() {
    if (this.destroyed) return;

    // Extract presence from awareness
    const presence = new Map<string, UserPresence>();

    if (this.wsProvider?.awareness) {
      this.wsProvider.awareness.getStates().forEach((state, clientId) => {
        const user = state.user;
        if (user && clientId !== this.ydoc.clientID) {
          presence.set(clientId.toString(), {
            id: clientId.toString(),
            name: user.name || 'Anonymous',
            color: user.color || '#94A3B8',
            cursor: user.cursor || null,
            activity: user.activity || 'idle',
          });
        }
      });
    }

    // Create immutable snapshot
    this.snapshot = Object.freeze({
      epoch: Date.now(),
      roomId: this.snapshot.roomId,
      connectionState: this.snapshot.connectionState,
      isReadOnly: this.snapshot.isReadOnly,
      roomStats: this.snapshot.roomStats,
      presence: new Map(presence),
      localUser: this.localUser,
    });

    // Notify all subscribers
    this.subscribers.forEach((callback) => {
      try {
        callback(this.snapshot);
      } catch (err) {
        console.error('Snapshot subscriber error:', err);
      }
    });
  }

  private updateConnectionState(status: 'connecting' | 'connected' | 'disconnected') {
    const newState = status === 'disconnected' ? 'reconnecting' : status;
    if (this.snapshot.connectionState !== newState) {
      this.snapshot = { ...this.snapshot, connectionState: newState };
      this.scheduleSnapshot();
    }
  }

  // Public API

  subscribe(callback: (snapshot: RoomSnapshot) => void): () => void {
    this.subscribers.add(callback);
    // Immediately call with current snapshot
    callback(this.snapshot);

    return () => {
      this.subscribers.delete(callback);
    };
  }

  updatePresence(updates: Partial<UserPresence>) {
    if (this.destroyed || !this.wsProvider) return;

    const newUser = { ...this.localUser, ...updates };
    this.localUser = newUser;
    this.wsProvider.awareness.setLocalStateField('user', newUser);
  }

  updateCursor(x: number | null, y: number | null) {
    const cursor = x !== null && y !== null ? { x, y } : null;
    this.updatePresence({ cursor });
  }

  setReadOnly(readOnly: boolean) {
    if (this.snapshot.isReadOnly !== readOnly) {
      this.snapshot = { ...this.snapshot, isReadOnly: readOnly };
      this.scheduleSnapshot();
    }
  }

  updateRoomStats(stats: { bytes: number; cap: number; softWarn: boolean }) {
    this.snapshot = { ...this.snapshot, roomStats: stats };
    this.scheduleSnapshot();
  }

  // Write operations queue
  enqueueWrite(operation: WriteOperation) {
    if (this.destroyed || this.snapshot.isReadOnly) {
      console.warn('Cannot write:', this.destroyed ? 'destroyed' : 'read-only');
      return;
    }

    this.writeQueue.push(operation);
    this.processWriteQueue();
  }

  private async processWriteQueue() {
    if (this.processingQueue || this.writeQueue.length === 0) return;
    this.processingQueue = true;

    try {
      while (this.writeQueue.length > 0) {
        const batch = this.writeQueue.splice(0, 10);

        this.ydoc.transact(() => {
          for (const op of batch) {
            try {
              op.execute(this.ydoc);
            } catch (err) {
              console.error('Write operation failed:', op.type, err);
            }
          }
        }, batch[0]?.origin || 'user');
      }
    } finally {
      this.processingQueue = false;
    }
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;

    // Cancel pending updates
    if (this.updateTimer !== null) {
      cancelAnimationFrame(this.updateTimer);
      this.updateTimer = null;
    }

    // Clear awareness
    if (this.wsProvider?.awareness) {
      this.wsProvider.awareness.setLocalState(null);
    }

    // Destroy providers
    this.wsProvider?.destroy();
    this.idbProvider?.destroy();

    // Clear references
    this.subscribers.clear();
    this.writeQueue = [];

    // Remove from instances
    RoomDocManager.instances.delete(this.snapshot.roomId);
  }

  // Test utilities (development only)
  getInternalState() {
    if (import.meta.env.DEV !== true) {
      throw new Error('Internal state access only available in development');
    }
    return {
      ydoc: this.ydoc,
      provider: this.wsProvider,
      awareness: this.wsProvider?.awareness,
    };
  }
}
