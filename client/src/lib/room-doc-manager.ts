// Polyfills for Node.js environment (for testing)
declare global {
  interface Window {
    requestAnimationFrame: typeof requestAnimationFrame;
    cancelAnimationFrame: typeof cancelAnimationFrame;
  }
}

if (typeof globalThis.requestAnimationFrame === 'undefined') {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).requestAnimationFrame = (callback: () => void) => {
    return setTimeout(callback, 16); // ~60fps
  };
}

if (typeof globalThis.cancelAnimationFrame === 'undefined') {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).cancelAnimationFrame = (id: number) => {
    clearTimeout(id);
  };
}

import * as Y from 'yjs';
import {
  createEmptySnapshot, // Regular import, not type import - function needs to be callable
} from '@avlo/shared';
import type {
  RoomId,
  Snapshot,
  PresenceView,
  Command,
  Stroke,
  TextBlock,
  Output,
  StrokeView,
  TextView,
  ViewTransform,
  SnapshotMeta,
} from '@avlo/shared';

// Type for unsubscribe function
type Unsub = () => void;

// Room statistics
interface RoomStats {
  bytes: number; // Compressed size in bytes
  cap: number; // Hard cap (10MB)
}

// Manager interface - public API
export interface IRoomDocManager {
  readonly currentSnapshot: Snapshot;
  subscribeSnapshot(cb: (snap: Snapshot) => void): Unsub;
  subscribePresence(cb: (p: PresenceView) => void): Unsub;
  subscribeRoomStats(cb: (s: RoomStats | null) => void): Unsub;
  write(cmd: Command): void;
  extendTTL(): void;
  destroy(): void;
}

// Private implementation
class RoomDocManagerImpl implements IRoomDocManager {
  // Core properties
  private readonly roomId: RoomId;
  private readonly ydoc: Y.Doc;
  private readonly yRoot: Y.Map<unknown>;

  // Y.js structures (initialized in constructor)
  private readonly yStrokes: Y.Array<Stroke>;
  private readonly yTexts: Y.Array<TextBlock>;
  private readonly yCode: Y.Map<unknown>;
  private readonly yOutputs: Y.Array<Output>;
  private readonly yMeta: Y.Map<unknown>;

  // Providers (will be null initially, added in later phases)
  private indexeddbProvider: unknown = null;
  private websocketProvider: unknown = null;
  private webrtcProvider: unknown = null;

  // Current state
  private _currentSnapshot: Snapshot;
  private lastStateVector: Uint8Array | null = null;

  // Subscription management
  private snapshotSubscribers = new Set<(snap: Snapshot) => void>();
  private presenceSubscribers = new Set<(p: PresenceView) => void>();
  private statsSubscribers = new Set<(s: RoomStats | null) => void>();

  // Publishing state
  private publishRAF: number | null = null;
  private pendingPublish = false;
  private lastPublishTime = 0;
  private isTabHidden = false;

  // Batch window management
  private batchWindowMs = 8; // Start with 8-16ms window
  private readonly MIN_BATCH_WINDOW = 8;
  private readonly MAX_BATCH_WINDOW = 32;
  
  // Event handlers for cleanup
  private ydocUpdateHandler: ((update: Uint8Array, origin: unknown) => void) | null = null;
  private visibilityChangeHandler: (() => void) | null = null;

  constructor(roomId: RoomId) {
    this.roomId = roomId;

    // CRITICAL: Create Y.Doc with guid matching roomId
    this.ydoc = new Y.Doc({ guid: roomId });

    // Initialize root Y.Map as required by OVERVIEW.MD
    this.yRoot = this.ydoc.getMap('root');
    
    // Initialize all structures under root in a single transaction
    this.ydoc.transact(() => {
      // Create Y structures if not present
      if (!this.yRoot.has('meta')) {
        const meta = new Y.Map();
        meta.set('scene_ticks', new Y.Array<number>());
        meta.set('schema_version', 1); // Future-proof
        this.yRoot.set('meta', meta);
      }
      
      if (!this.yRoot.has('strokes')) {
        this.yRoot.set('strokes', new Y.Array<Stroke>());
      }
      
      if (!this.yRoot.has('texts')) {
        this.yRoot.set('texts', new Y.Array<TextBlock>());
      }
      
      if (!this.yRoot.has('code')) {
        const code = new Y.Map();
        code.set('lang', 'javascript');
        code.set('body', '');
        code.set('version', 0);
        this.yRoot.set('code', code);
      }
      
      if (!this.yRoot.has('outputs')) {
        this.yRoot.set('outputs', new Y.Array<Output>());
      }
    });
    
    // Store references to structures (now from root)
    this.yMeta = this.yRoot.get('meta') as Y.Map<unknown>;
    this.yStrokes = this.yRoot.get('strokes') as Y.Array<Stroke>;
    this.yTexts = this.yRoot.get('texts') as Y.Array<TextBlock>;
    this.yCode = this.yRoot.get('code') as Y.Map<unknown>;
    this.yOutputs = this.yRoot.get('outputs') as Y.Array<Output>;

    // CRITICAL: Initialize with EmptySnapshot (NEVER null)
    this._currentSnapshot = createEmptySnapshot();

    // Set up observers
    this.setupObservers();

    // Set up visibility change detection
    this.setupVisibilityHandling();

    // Start publish loop
    this.startPublishLoop();
  }

  // Public getters
  get currentSnapshot(): Snapshot {
    return this._currentSnapshot;
  }

  // Subscription methods
  subscribeSnapshot(cb: (snap: Snapshot) => void): Unsub {
    this.snapshotSubscribers.add(cb);
    // Immediately call with current snapshot
    cb(this._currentSnapshot);

    return () => {
      this.snapshotSubscribers.delete(cb);
    };
  }

  subscribePresence(cb: (p: PresenceView) => void): Unsub {
    this.presenceSubscribers.add(cb);
    // Immediately call with current presence
    cb(this._currentSnapshot.presence);

    return () => {
      this.presenceSubscribers.delete(cb);
    };
  }

  subscribeRoomStats(cb: (s: RoomStats | null) => void): Unsub {
    this.statsSubscribers.add(cb);
    // Immediately call with current stats if available
    const stats = this._currentSnapshot.meta.bytes
      ? { bytes: this._currentSnapshot.meta.bytes, cap: this._currentSnapshot.meta.cap }
      : null;
    cb(stats);

    return () => {
      this.statsSubscribers.delete(cb);
    };
  }

  // Write command (stub - will be implemented with WriteQueue)
  write(cmd: Command): void {
    // eslint-disable-next-line no-console
    console.log('[RoomDocManager] Write command:', cmd.type);
    // Will be connected to WriteQueue/CommandBus in step 2.5
    this.requestPublish();
  }

  // Extend TTL (stub)
  extendTTL(): void {
    // eslint-disable-next-line no-console
    console.log('[RoomDocManager] Extending TTL');
    // Will be implemented with rate limiting
  }

  // Lifecycle
  destroy(): void {
    // eslint-disable-next-line no-console
    console.log('[RoomDocManager] Destroying');
    // Cancel any pending publish
    if (this.publishRAF !== null) {
      cancelAnimationFrame(this.publishRAF);
      this.publishRAF = null;
    }

    // Clear subscribers
    this.snapshotSubscribers.clear();
    this.presenceSubscribers.clear();
    this.statsSubscribers.clear();

    // Remove event listeners
    if (this.ydocUpdateHandler) {
      this.ydoc.off('update', this.ydocUpdateHandler);
      this.ydocUpdateHandler = null;
    }
    
    if (this.visibilityChangeHandler && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.visibilityChangeHandler);
      this.visibilityChangeHandler = null;
    }

    // Destroy providers (when added)
    // this.indexeddbProvider?.destroy();
    // this.websocketProvider?.destroy();
    // this.webrtcProvider?.destroy();

    // Destroy Y.Doc
    this.ydoc.destroy();

    // Remove from registry
    RoomDocManagerRegistry.remove(this.roomId);
  }

  // Private: Set up Y.js observers
  private setupObservers(): void {
    // Create and store the update handler for cleanup
    this.ydocUpdateHandler = (_update: Uint8Array, _origin: unknown) => {
      // eslint-disable-next-line no-console
      console.log('[RoomDocManager] Y.Doc updated');
      this.requestPublish();
    };
    
    // Observe document changes
    this.ydoc.on('update', this.ydocUpdateHandler);

    // Will add more specific observers as needed
  }

  // Private: Handle tab visibility
  private setupVisibilityHandling(): void {
    // Only set up visibility handling in browser environment
    if (typeof document === 'undefined') {
      return;
    }

    // Create and store the visibility handler for cleanup
    this.visibilityChangeHandler = () => {
      const wasHidden = this.isTabHidden;
      this.isTabHidden = document.hidden;
      // eslint-disable-next-line no-console
      console.log('[RoomDocManager] Tab visibility:', this.isTabHidden ? 'hidden' : 'visible');

      // When switching from visible to hidden, cancel RAF and use setTimeout
      if (!wasHidden && this.isTabHidden && this.publishRAF !== null) {
        cancelAnimationFrame(this.publishRAF);
        this.publishRAF = null;
        // If we have pending publish, reschedule with setTimeout
        if (this.pendingPublish) {
          const delay = Math.min(125, this.batchWindowMs); // Cap at 8 FPS
          setTimeout(() => this.publish(), delay);
        }
      }
      // When switching from hidden to visible, re-request publish if pending
      else if (wasHidden && !this.isTabHidden && this.pendingPublish) {
        this.requestPublish();
      }
    };
    
    document.addEventListener('visibilitychange', this.visibilityChangeHandler);
  }

  // Private: Start the publish loop
  private startPublishLoop(): void {
    // Publish loop will be called via requestAnimationFrame
    // when updates occur
  }

  // Private: Request a publish on next frame
  private requestPublish(): void {
    if (this.pendingPublish) return;

    this.pendingPublish = true;

    // Cancel any existing scheduled publish
    if (this.publishRAF !== null) {
      cancelAnimationFrame(this.publishRAF);
      this.publishRAF = null;
    }

    // Use appropriate timing based on tab visibility
    if (this.isTabHidden) {
      // Use setTimeout when hidden (target ~8 FPS max)
      // Use batch window timing, but cap at 125ms (8 FPS)
      const delay = Math.min(125, this.batchWindowMs);
      setTimeout(() => this.publish(), delay);
    } else {
      // Use requestAnimationFrame when visible (up to 60 FPS)
      this.publishRAF = requestAnimationFrame(() => this.publish());
    }
  }

  // Private: Build and publish snapshot
  private publish(): void {
    const startTime = performance.now();
    this.pendingPublish = false;
    this.publishRAF = null;

    // Build new snapshot
    const snapshot = this.buildSnapshot();

    // Check if snapshot actually changed (by comparing svKey)
    if (snapshot.svKey === this._currentSnapshot.svKey) {
      // No actual changes, skip publish
      return;
    }

    // Update current snapshot
    this._currentSnapshot = snapshot;

    // Notify all subscribers
    this.snapshotSubscribers.forEach((cb) => {
      try {
        cb(snapshot);
      } catch (err) {
        console.error('[RoomDocManager] Snapshot subscriber error:', err);
      }
    });

    // Notify presence subscribers if presence changed
    this.presenceSubscribers.forEach((cb) => {
      try {
        cb(snapshot.presence);
      } catch (err) {
        console.error('[RoomDocManager] Presence subscriber error:', err);
      }
    });

    // Track publish time for adaptive batching
    const publishTime = performance.now() - startTime;
    this.lastPublishTime = publishTime;

    // Adjust batch window based on performance
    if (publishTime > 8) {
      // Expand window if publish is taking too long
      this.batchWindowMs = Math.min(this.MAX_BATCH_WINDOW, this.batchWindowMs * 1.5);
    } else if (publishTime < 4 && this.batchWindowMs > this.MIN_BATCH_WINDOW) {
      // Shrink window if we have headroom
      this.batchWindowMs = Math.max(this.MIN_BATCH_WINDOW, this.batchWindowMs * 0.9);
    }
  }

  // Private: Build immutable snapshot from Y.Doc
  private buildSnapshot(): Snapshot {
    // Get current state vector for svKey
    const stateVector = Y.encodeStateVector(this.ydoc);
    const svKey = btoa(String.fromCharCode(...stateVector));

    // Get current scene
    const sceneTicks = (this.yMeta.get('scene_ticks') as Y.Array<number>)?.toArray() || [];
    const currentScene = sceneTicks.length;

    // Build stroke views (filter by current scene)
    const strokes = this.yStrokes
      .toArray()
      .filter((s) => s.scene === currentScene)
      .map((s) => ({
        id: s.id,
        // CRITICAL: Float32Array MUST be created at render time only, never in snapshot
        polyline: null as unknown as Float32Array | null, // Will be created at render time from s.points
        style: {
          color: s.color,
          size: s.size,
          opacity: s.opacity,
          tool: s.tool,
        },
        bbox: s.bbox,
      }));

    // Build text views (filter by current scene)
    const texts = this.yTexts
      .toArray()
      .filter((t) => t.scene === currentScene)
      .map((t) => ({
        id: t.id,
        x: t.x,
        y: t.y,
        w: t.w,
        h: t.h,
        content: t.content,
        style: {
          color: t.color,
          size: t.size,
        },
      }));

    // Build presence view (stub for now)
    const presence: PresenceView = {
      users: new Map(),
      localUserId: '',
    };

    // Build spatial index (stub for now)
    const spatialIndex = { _tree: null };

    // Build view transform (identity for now)
    const view: ViewTransform = {
      worldToCanvas: (x: number, y: number) => [x, y],
      canvasToWorld: (x: number, y: number) => [x, y],
      scale: 1,
      pan: { x: 0, y: 0 },
    };

    // Build metadata
    const meta: SnapshotMeta = {
      cap: 10 * 1024 * 1024, // 10MB
      readOnly: false,
      bytes: undefined,
      expiresAt: undefined,
    };

    // Create frozen snapshot (in development)
    const snapshot: Snapshot = {
      svKey,
      scene: currentScene,
      strokes: Object.freeze(strokes) as ReadonlyArray<StrokeView>,
      texts: Object.freeze(texts) as ReadonlyArray<TextView>,
      presence,
      spatialIndex,
      view,
      meta,
      createdAt: Date.now(),
    };

    // Freeze entire snapshot in development
    // Freeze entire snapshot in development
    if (typeof process !== 'undefined' && process.env?.NODE_ENV === 'development') {
      return Object.freeze(snapshot);
    }

    return snapshot;
  }
}

// Singleton Registry
class RoomDocManagerRegistryClass {
  private managers = new Map<RoomId, IRoomDocManager>();

  get(roomId: RoomId): IRoomDocManager {
    let manager = this.managers.get(roomId);

    if (!manager) {
      // eslint-disable-next-line no-console
      console.log('[Registry] Creating new RoomDocManager for:', roomId);
      manager = new RoomDocManagerImpl(roomId);
      this.managers.set(roomId, manager);
    }

    return manager;
  }

  has(roomId: RoomId): boolean {
    return this.managers.has(roomId);
  }

  remove(roomId: RoomId): void {
    const manager = this.managers.get(roomId);
    if (manager) {
      // eslint-disable-next-line no-console
      console.log('[Registry] Removing RoomDocManager for:', roomId);
      this.managers.delete(roomId);
    }
  }

  destroyAll(): void {
    // eslint-disable-next-line no-console
    console.log('[Registry] Destroying all RoomDocManagers');
    this.managers.forEach((manager) => manager.destroy());
    this.managers.clear();
  }
}

// Export singleton instance
export const RoomDocManagerRegistry = new RoomDocManagerRegistryClass();

// Export manager type
export type RoomDocManager = IRoomDocManager;
