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
  ROOM_CONFIG,
  STROKE_CONFIG as _STROKE_CONFIG, // Will be used in later Phase 2.3 steps
  TEXT_CONFIG as _TEXT_CONFIG, // Will be used in later Phase 2.3 steps
  isRoomReadOnly as _isRoomReadOnly, // Will be used in later Phase 2.3 steps
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

// Type aliases for Y structures - internal use only
// CRITICAL: Y.Map's generic parameter doesn't define the value shape
// Use Y.Map<unknown> and cast when accessing specific properties
type YMeta = Y.Map<unknown>;
type YStrokes = Y.Array<Stroke>;
type YTexts = Y.Array<TextBlock>;
type YCode = Y.Map<unknown>;
type YOutputs = Y.Array<Output>;
type YSceneTicks = Y.Array<number>;

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
  // NOTE: No cached Y structure references - all access via helper methods

  // Providers (will be null initially, added in later phases)
  private indexeddbProvider: unknown = null;
  private websocketProvider: unknown = null;
  private webrtcProvider: unknown = null;

  // Current state
  private _currentSnapshot: Snapshot;

  // Subscription management
  private snapshotSubscribers = new Set<(snap: Snapshot) => void>();
  private presenceSubscribers = new Set<(p: PresenceView) => void>();
  private statsSubscribers = new Set<(s: RoomStats | null) => void>();

  constructor(roomId: RoomId) {
    this.roomId = roomId;

    // CRITICAL: Create Y.Doc with guid matching roomId
    this.ydoc = new Y.Doc({ guid: roomId });

    // Initialize all structures under root in a single transaction
    this.ydoc.transact(() => {
      const root = this.ydoc.getMap('root');

      // Create Y structures if not present
      if (!root.has('meta')) {
        const meta = new Y.Map();
        meta.set('scene_ticks', new Y.Array<number>());
        meta.set('schema_version', 1); // Future-proof
        root.set('meta', meta);
      }

      if (!root.has('strokes')) {
        root.set('strokes', new Y.Array<Stroke>());
      }

      if (!root.has('texts')) {
        root.set('texts', new Y.Array<TextBlock>());
      }

      if (!root.has('code')) {
        const code = new Y.Map();
        code.set('lang', 'javascript');
        code.set('body', '');
        code.set('version', 0);
        root.set('code', code);
      }

      if (!root.has('outputs')) {
        root.set('outputs', new Y.Array<Output>());
      }
    }, 'init');

    // CRITICAL: Initialize with EmptySnapshot (NEVER null)
    this._currentSnapshot = createEmptySnapshot();

    // PHASE 2.3 STOPS HERE - No observers/publish loop (Phase 2.4 concerns)
  }

  // Public getters
  get currentSnapshot(): Snapshot {
    return this._currentSnapshot;
  }

  // CRITICAL: These are PRIVATE helpers for internal use only
  // NEVER expose these to external code or cache their return values
  // Each call must go through the helper to ensure encapsulation

  private getRoot(): Y.Map<unknown> {
    return this.ydoc.getMap('root');
  }

  private getMeta(): YMeta {
    const meta = this.getRoot().get('meta');
    if (!(meta instanceof Y.Map)) {
      throw new Error('Meta structure corrupted');
    }
    return meta as YMeta;
  }

  private getSceneTicks(): YSceneTicks {
    const meta = this.getMeta();
    const ticks = meta.get('scene_ticks');
    if (!(ticks instanceof Y.Array)) {
      throw new Error('Scene ticks structure corrupted');
    }
    return ticks as YSceneTicks;
  }

  private getStrokes(): YStrokes {
    const strokes = this.getRoot().get('strokes');
    if (!(strokes instanceof Y.Array)) {
      throw new Error('Strokes structure corrupted');
    }
    return strokes as YStrokes;
  }

  private getTexts(): YTexts {
    const texts = this.getRoot().get('texts');
    if (!(texts instanceof Y.Array)) {
      throw new Error('Texts structure corrupted');
    }
    return texts as YTexts;
  }

  private getCode(): YCode {
    const code = this.getRoot().get('code');
    if (!(code instanceof Y.Map)) {
      throw new Error('Code structure corrupted');
    }
    return code as YCode;
  }

  private getOutputs(): YOutputs {
    const outputs = this.getRoot().get('outputs');
    if (!(outputs instanceof Y.Array)) {
      throw new Error('Outputs structure corrupted');
    }
    return outputs as YOutputs;
  }

  // Helper to get current scene
  private getCurrentScene(): number {
    const sceneTicks = this.getSceneTicks();
    return sceneTicks.length;
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
    // Will be connected to WriteQueue/CommandBus in Phase 2.5
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

    // Clear subscribers
    this.snapshotSubscribers.clear();
    this.presenceSubscribers.clear();
    this.statsSubscribers.clear();

    // Destroy providers (when added in Phase 4)
    // this.indexeddbProvider?.destroy();
    // this.websocketProvider?.destroy();
    // this.webrtcProvider?.destroy();

    // Destroy Y.Doc
    this.ydoc.destroy();

    // Remove from registry
    RoomDocManagerRegistry.remove(this.roomId);
  }

  // NOTE: Phase 2.4 methods (setupObservers, publish loop, etc.) will be added in Phase 2.4
  // For now, these are stubbed out and not called from constructor

  // Private: Build immutable snapshot from Y.Doc
  private buildSnapshot(): Snapshot {
    // Get current state vector for svKey
    const stateVector = Y.encodeStateVector(this.ydoc);
    const svKey = btoa(String.fromCharCode(...stateVector));

    // Use helper to get current scene
    const currentScene = this.getCurrentScene();

    // Build stroke views using helper (filter by current scene)
    const strokes = this.getStrokes()
      .toArray()
      .filter((s) => s.scene === currentScene)
      .map((s) => ({
        id: s.id,
        points: s.points, // Include points for renderer to build Float32Array
        // CRITICAL: Float32Array MUST be created at render time only, never in snapshot
        polyline: null as unknown as Float32Array | null, // Will be created at render time from points
        style: {
          color: s.color,
          size: s.size,
          opacity: s.opacity,
          tool: s.tool,
        },
        bbox: s.bbox,
      }));

    // Build text views using helper (filter by current scene)
    const texts = this.getTexts()
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
      cap: ROOM_CONFIG.ROOM_SIZE_READONLY_BYTES, // Use shared config
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
