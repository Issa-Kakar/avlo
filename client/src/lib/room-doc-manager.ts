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
  TEXT_CONFIG,
  ulid,
} from '@avlo/shared';
import { RollingGzipEstimator, GzipImpl } from './size-estimator';
import type {
  RoomId,
  Snapshot,
  PresenceView,
  Stroke,
  TextBlock,
  Output,
  StrokeView,
  TextView,
  ViewTransform,
  SnapshotMeta,
  RoomStats,
} from '@avlo/shared';
import { UpdateRing } from './ring-buffer';
import {
  Clock,
  FrameScheduler,
  BrowserClock,
  BrowserFrameScheduler,
  TimingOptions,
} from './timing-abstractions';

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

// Manager interface - public API
export interface IRoomDocManager {
  readonly currentSnapshot: Snapshot;
  subscribeSnapshot(cb: (snap: Snapshot) => void): Unsub;
  subscribePresence(cb: (p: PresenceView) => void): Unsub;
  subscribeRoomStats(cb: (s: RoomStats | null) => void): Unsub;
  mutate(fn: (ydoc: Y.Doc) => void): void;
  extendTTL(): void;
  destroy(): void;
}

// Extended options for RoomDocManager
export interface RoomDocManagerOptions extends TimingOptions {
  gzipImpl?: GzipImpl;
}

// Private implementation
class RoomDocManagerImpl implements IRoomDocManager {
  // Core properties
  private readonly roomId: RoomId;
  private readonly ydoc: Y.Doc;
  private readonly userId: string;  // Session user ID for undo/redo origin
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

  // Timing abstractions (injected for testing)
  private clock: Clock;
  private frames: FrameScheduler;
  private batchWindowMs: number;
  private gzipImpl?: GzipImpl;

  // Simplified publish state for RAF loop
  private publishState = {
    isDirty: false,
    presenceDirty: false, // Track presence changes separately
    rafId: -1, // RAF request ID (-1 = not scheduled)
    lastPublishTime: 0, // When we last published (clock.now())
    publishCostMs: 0, // Track how long publish takes
    pendingUpdates: null as UpdateRing<{ update: Uint8Array; origin: unknown; time: number }> | null,
    lastSvKey: '', // Track to detect changes
  };

  // IndexedDB cache for render snapshots
  private snapshotCache: IDBDatabase | null = null;
  private readonly SNAPSHOT_CACHE_DB = 'avlo-snapshot-cache';
  private readonly SNAPSHOT_CACHE_VERSION = 1;

  // Track cleanup handlers
  private cleanupHandlers: Array<() => void> = [];

  // Room stats tracking
  private roomStats: RoomStats | null = null;
  
  // Size estimation for guards
  private sizeEstimator: RollingGzipEstimator;
  
  // Track if destroyed for cleanup
  private destroyed = false;

  constructor(roomId: RoomId, options?: RoomDocManagerOptions) {
    this.roomId = roomId;
    this.userId = ulid(); // Generate session user ID for undo/redo origin

    // Initialize timing abstractions with defaults
    this.clock = options?.clock ?? new BrowserClock();
    this.frames = options?.frames ?? new BrowserFrameScheduler();
    this.gzipImpl = options?.gzipImpl;

    // Initialize helpers
    this.sizeEstimator = new RollingGzipEstimator(this.gzipImpl);

    // Initialize ring buffer for pending updates (keep for metrics)
    const pendingCap = options?.pendingCap ?? 16;
    this.publishState.pendingUpdates = new UpdateRing(pendingCap);

    // CRITICAL: Create Y.Doc with guid matching roomId
    this.ydoc = new Y.Doc({ guid: roomId });

    // Initialize Yjs structures
    this.initializeYjsStructures();

    // Validate structure integrity
    if (!this.validateStructure()) {
      throw new Error('Failed to initialize Y.Doc structure');
    }

    // CRITICAL: Initialize with EmptySnapshot (NEVER null)
    this._currentSnapshot = createEmptySnapshot();

    // Setup snapshot publishing
    this.initSnapshotCache(); // Async but don't await
    this.setupObservers();
    this.setupVisibilityHandling();
    this.startPublishLoop(); // Start simple RAF loop

    // ❌ DO NOT cache Y structure references:
    // this.yStrokes = ...             // WRONG
    // this.yMeta = ...                // WRONG

    // ✅ Always access through helper methods
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
    // Debug: sceneTicks length is the current scene
    return sceneTicks.length;
  }

  // Build presence view from awareness (will be connected to awareness in Phase 8)
  private buildPresenceView(): PresenceView {
    const users = new Map<string, any>();
    
    // For now, return proper structure even if awareness not connected
    // This will be populated in Phase 8 when awareness is integrated
    // if (this.awareness) {
    //   this.awareness.getStates().forEach((state, clientId) => {
    //     if (state.userId && state.cursor) {
    //       users.set(clientId.toString(), {
    //         userId: state.userId,
    //         name: state.name || 'Anonymous',
    //         color: state.color || '#000000',
    //         cursor: state.cursor,
    //         activity: state.activity || 'idle',
    //       });
    //     }
    //   });
    // }
    
    return {
      users,
      localUserId: this.userId,
    };
  }

  // Helper to get view transform (identity for now, will be populated in Phase 3)
  private getViewTransform(): ViewTransform {
    return {
      worldToCanvas: (x: number, y: number) => [x, y],
      canvasToWorld: (x: number, y: number) => [x, y],
      scale: 1,
      pan: { x: 0, y: 0 },
    };
  }

  // Step 3: Initialize Y.js structures with proper setup
  private initializeYjsStructures(): void {
    this.ydoc.transact(() => {
      const root = this.ydoc.getMap('root');

      // Initialize meta if not present
      if (!root.has('meta')) {
        const meta = new Y.Map();
        const sceneTicks = new Y.Array<number>();
        meta.set('scene_ticks', sceneTicks);
        // Canvas reference is optional per OVERVIEW.MD
        // meta.set('canvas', { baseW: 1920, baseH: 1080 }); // Optional
        root.set('meta', meta);
      }

      // Initialize strokes array
      if (!root.has('strokes')) {
        root.set('strokes', new Y.Array<Stroke>());
      }

      // Initialize texts array
      if (!root.has('texts')) {
        root.set('texts', new Y.Array<TextBlock>());
      }

      // Initialize code cell
      if (!root.has('code')) {
        const code = new Y.Map();
        code.set('lang', 'javascript');
        code.set('body', '');
        code.set('version', 0);
        root.set('code', code);
      }

      // Initialize outputs array with enforcement wrapper
      if (!root.has('outputs')) {
        root.set('outputs', new Y.Array<Output>());
      }
    }, 'init'); // Origin for debugging
  }

  // Step 4: Add output with size enforcement
  private addOutput(output: Output): void {
    const outputs = this.getOutputs();

    // Validate single output size
    const outputSize = new TextEncoder().encode(output.text).length;
    if (outputSize > TEXT_CONFIG.MAX_OUTPUT_BYTES_PER_RUN) {
      throw new Error(`Output exceeds ${TEXT_CONFIG.MAX_OUTPUT_BYTES_PER_RUN} bytes limit`);
    }

    this.ydoc.transact(() => {
      // Add new output
      outputs.push([output]);

      // Enforce max count (keep last N)
      while (outputs.length > TEXT_CONFIG.MAX_OUTPUTS_COUNT) {
        outputs.delete(0, 1);
      }

      // Validate total size
      let totalSize = 0;
      for (const out of outputs) {
        totalSize += new TextEncoder().encode(out.text).length;
      }

      // If total exceeds limit, remove oldest until under limit
      while (totalSize > TEXT_CONFIG.MAX_TOTAL_OUTPUT_BYTES && outputs.length > 0) {
        const removed = outputs.get(0);
        if (removed) {
          totalSize -= new TextEncoder().encode(removed.text).length;
        }
        outputs.delete(0, 1);
      }
    }, 'add-output');
  }

  // Step 6: Validate structure integrity
  private validateStructure(): boolean {
    try {
      const root = this.getRoot();

      // Check all required structures exist
      if (!root.has('meta')) return false;
      if (!root.has('strokes')) return false;
      if (!root.has('texts')) return false;
      if (!root.has('code')) return false;
      if (!root.has('outputs')) return false;

      // Validate meta structure
      const meta = this.getMeta();
      if (!meta.has('scene_ticks')) return false;

      // Validate scene_ticks is array
      const sceneTicks = meta.get('scene_ticks');
      if (!(sceneTicks instanceof Y.Array)) return false;

      // Validate code structure
      const code = this.getCode();
      if (!code.has('lang')) return false;
      if (!code.has('body')) return false;
      if (!code.has('version')) return false;

      return true;
    } catch {
      return false;
    }
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

  // Write command via WriteQueue and CommandBus
  // Simple mutate method with minimal guards
  mutate(fn: (ydoc: Y.Doc) => void): void {
    // Minimal guards (same as spec)
    
    // 1. Check room read-only (≥15MB)
    if (this.roomStats && this.roomStats.bytes >= ROOM_CONFIG.ROOM_SIZE_READONLY_BYTES) {
      console.warn('[RoomDocManager] Room is read-only (size limit exceeded)');
      return;
    }
    
    // 2. Check mobile view-only
    if (this.isMobileDevice()) {
      console.warn('[RoomDocManager] Mobile devices are view-only');
      return;
    }
    
    // 3. Check frame size (if we have a pending update estimate)
    // Note: This is a simplified check - actual implementation would estimate
    // the size of the operation about to be performed
    const estimatedSize = this.sizeEstimator.getCurrentEstimate();
    if (estimatedSize > ROOM_CONFIG.MAX_INBOUND_FRAME_BYTES) {
      console.warn('[RoomDocManager] Operation too large (frame size limit)');
      return;
    }
    
    // Execute in single transaction with user origin
    this.ydoc.transact(() => {
      fn(this.ydoc);
    }, this.userId); // Origin for undo/redo tracking
    
    // Mark dirty for publishing
    this.publishState.isDirty = true;
  }

  // Extend TTL with minimal write
  extendTTL(): void {
    // Perform a minimal write to extend TTL
    this.mutate((_ydoc) => {
      const meta = this.getMeta();
      // Set a timestamp to trigger a write
      meta.set('lastExtendedAt', Date.now());
    });
  }

  // Helper for mobile detection
  private isMobileDevice(): boolean {
    if (typeof window === 'undefined') return false;
    return /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
  }

  // Lifecycle
  destroy(): void {
    // Set destroyed flag
    this.destroyed = true;
    
    // eslint-disable-next-line no-console
    console.log('[RoomDocManager] Destroying');

    // Cancel scheduled RAF if pending
    if (this.publishState.rafId !== -1) {
      this.frames.cancel(this.publishState.rafId);
      this.publishState.rafId = -1;
    }

    // Clean up observers
    this.ydoc.off('update', this.handleYDocUpdate);

    // Clean up visibility handler
    this.cleanupHandlers.forEach((cleanup) => cleanup());

    // Close IndexedDB
    this.snapshotCache?.close();

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

  // Simple RAF loop for publishing
  private startPublishLoop(): void {
    const rafLoop = () => {
      // Publish if Y.Doc changed OR presence changed
      if (this.publishState.isDirty || this.publishState.presenceDirty) {
        const startTime = this.clock.now();
        
        // Build snapshot
        const newSnapshot = this.buildSnapshot();
        
        // Optional optimization: Skip publish if svKey unchanged and no presence update
        const svKeyChanged = newSnapshot.svKey !== this.publishState.lastSvKey;
        if (svKeyChanged || this.publishState.presenceDirty) {
          this.publishSnapshot(newSnapshot);
        }
        
        // Clear both dirty flags
        this.publishState.isDirty = false;
        this.publishState.presenceDirty = false;
        
        // Track timing for metrics
        this.publishState.lastPublishTime = this.clock.now();
        this.publishState.publishCostMs = this.clock.now() - startTime;
      }
      
      // Continue loop if not destroyed
      if (!this.destroyed) {
        this.publishState.rafId = this.frames.request(rafLoop);
      }
    };
    
    // Start the loop
    this.publishState.rafId = this.frames.request(rafLoop);
  }

  // Phase 2.4 Component B: Y.Doc Observer Setup
  private setupObservers(): void {
    // CRITICAL: Use 'update' event for batching, not deep observe
    this.ydoc.on('update', this.handleYDocUpdate);

    // Optional: Track specific events for debugging
    if (typeof process !== 'undefined' && process.env?.NODE_ENV === 'development') {
      this.ydoc.on('afterTransaction', (transaction: Y.Transaction) => {
        // eslint-disable-next-line no-console
        console.log('[Snapshot] Transaction origin:', transaction.origin);
      });
    }
  }

  private handleYDocUpdate = (update: Uint8Array, origin: unknown): void => {
    // Just mark dirty - RAF will handle publishing
    this.publishState.isDirty = true;
    
    // Store update for metrics (keep ring buffer, it's useful)
    if (this.publishState.pendingUpdates) {
      this.publishState.pendingUpdates.push({
        update,
        origin,
        time: this.clock.now()
      });
    }
    
    // Update size estimate (keep this, it's needed for guards)
    const deltaBytes = update.byteLength;
    this.sizeEstimator.observeDelta(deltaBytes);
    
    // RAF loop will handle publishing
  };


  // Visibility handling (simplified)
  private setupVisibilityHandling(): void {
    const handleVisibilityChange = () => {
      // When tab becomes visible with pending changes, mark dirty to trigger publish
      if (!document.hidden && this.publishState.isDirty) {
        // RAF loop will pick this up automatically
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);

    // Store for cleanup
    this.cleanupHandlers.push(() => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    });
  }

  // Phase 2.4 Component E: Snapshot Building & Publishing
  private publishSnapshot(): void {
    // Build new snapshot
    const newSnapshot = this.buildSnapshot();

    // Check if svKey changed (actual Y.Doc update)
    if (newSnapshot.svKey !== this.publishState.lastSvKey) {
      this.publishState.lastSvKey = newSnapshot.svKey;

      // Cache in IndexedDB (async, don't await)
      this.cacheSnapshot(newSnapshot);
    }

    // Update current snapshot
    this._currentSnapshot = newSnapshot;

    // Notify subscribers
    this.snapshotSubscribers.forEach((cb) => {
      try {
        cb(newSnapshot);
      } catch (error) {
        console.error('[Snapshot] Subscriber error:', error);
      }
    });
  }

  // Phase 2.4 Component F: IndexedDB Snapshot Cache
  private async initSnapshotCache(): Promise<void> {
    try {
      const request = indexedDB.open(this.SNAPSHOT_CACHE_DB, this.SNAPSHOT_CACHE_VERSION);

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        if (!db.objectStoreNames.contains('snapshots')) {
          const store = db.createObjectStore('snapshots', { keyPath: 'key' });
          store.createIndex('roomId', 'roomId', { unique: false });
          store.createIndex('timestamp', 'timestamp', { unique: false });
        }
      };

      request.onsuccess = (event) => {
        this.snapshotCache = (event.target as IDBOpenDBRequest).result;
        this.loadCachedSnapshot();
      };

      request.onerror = () => {
        console.warn('[Snapshot] Failed to open IndexedDB cache');
      };
    } catch (error) {
      console.warn('[Snapshot] IndexedDB not available:', error);
    }
  }

  private async cacheSnapshot(snapshot: Snapshot): Promise<void> {
    if (!this.snapshotCache) return;

    try {
      const transaction = this.snapshotCache.transaction(['snapshots'], 'readwrite');
      const store = transaction.objectStore('snapshots');

      // Store only essential data (no typed arrays, minimal size)
      const cacheEntry = {
        key: `${this.roomId}:${snapshot.svKey}`,
        roomId: this.roomId,
        svKey: snapshot.svKey,
        timestamp: Date.now(),
        snapshot: {
          scene: snapshot.scene,
          strokes: snapshot.strokes.map((s) => ({
            id: s.id,
            points: s.points, // Plain array, not Float32Array
            style: s.style,
            bbox: s.bbox,
            scene: s.scene,
          })),
          texts: snapshot.texts.map((t) => ({
            id: t.id,
            x: t.x,
            y: t.y,
            w: t.w,
            h: t.h,
            content: t.content,
            style: t.style,
            scene: t.scene,
          })),
          meta: snapshot.meta,
        },
      };

      // Delete old entries for this room
      const deleteReq = store.index('roomId').openCursor(IDBKeyRange.only(this.roomId));
      deleteReq.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest).result;
        if (cursor) {
          if (cursor.value.svKey !== snapshot.svKey) {
            cursor.delete();
          }
          cursor.continue();
        }
      };

      // Add new entry
      store.put(cacheEntry);
    } catch (error) {
      console.warn('[Snapshot] Failed to cache:', error);
    }
  }

  private async loadCachedSnapshot(): Promise<void> {
    if (!this.snapshotCache) return;

    try {
      // Calculate current svKey
      const stateVector = Y.encodeStateVector(this.ydoc);
      // Safe base64 encoding for arbitrary bytes
      const currentSvKey = btoa(
        Array.from(stateVector, (byte) => String.fromCharCode(byte)).join(''),
      );

      const transaction = this.snapshotCache.transaction(['snapshots'], 'readonly');
      const store = transaction.objectStore('snapshots');
      const request = store.get(`${this.roomId}:${currentSvKey}`);

      request.onsuccess = (event) => {
        const result = (event.target as IDBRequest).result;
        if (result && result.snapshot) {
          // Restore snapshot for immediate render
          this._currentSnapshot = this.reconstructSnapshot(result.snapshot, currentSvKey);

          // Notify subscribers
          this.snapshotSubscribers.forEach((cb) => cb(this._currentSnapshot));
        }
      };
    } catch (error) {
      console.warn('[Snapshot] Failed to load cache:', error);
    }
  }

  private reconstructSnapshot(cached: any, svKey: string): Snapshot {
    return {
      svKey,
      scene: cached.scene,
      strokes: cached.strokes.map((s: any) => ({
        ...s,
        polyline: null as unknown as Float32Array | null,
      })),
      texts: cached.texts,
      presence: { users: new Map(), localUserId: '' },
      spatialIndex: { _tree: null },
      view: {
        worldToCanvas: (x: number, y: number) => [x, y],
        canvasToWorld: (x: number, y: number) => [x, y],
        scale: 1,
        pan: { x: 0, y: 0 },
      },
      meta: cached.meta,
      createdAt: Date.now(),
    };
  }

  // Private: Build immutable snapshot from Y.Doc
  private buildSnapshot(): Snapshot {
    // Get current state vector for svKey
    const stateVector = Y.encodeStateVector(this.ydoc);
    // CRITICAL: Use safe encoding to avoid stack overflow on large state vectors
    const svKey = btoa(Array.from(stateVector, (byte) => String.fromCharCode(byte)).join(''));

    // Use helper to get current scene
    const currentScene = this.getCurrentScene();
    // Building snapshot with currentScene

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
        scene: s.scene, // CRITICAL: Include scene for causal consistency
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
        scene: t.scene, // CRITICAL: Include scene for causal consistency
      }));

    // Build presence view
    const presence: PresenceView = this.buildPresenceView();

    // Build spatial index (stub for now)
    const spatialIndex = { _tree: null };

    // Build view transform
    const view: ViewTransform = this.getViewTransform();

    // Build metadata
    const meta: SnapshotMeta = {
      cap: ROOM_CONFIG.ROOM_SIZE_READONLY_BYTES, // Use shared config
      readOnly: this.roomStats?.bytes
        ? this.roomStats.bytes >= ROOM_CONFIG.ROOM_SIZE_READONLY_BYTES
        : false,
      bytes: this.roomStats?.bytes,
      expiresAt: this.roomStats?.expiresAt,
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

    // CRITICAL: Freeze in development to catch mutations
    if (typeof process !== 'undefined' && process.env?.NODE_ENV === 'development') {
      // Deep freeze strokes and texts arrays
      Object.freeze(strokes);
      strokes.forEach((s) => Object.freeze(s));
      Object.freeze(texts);
      texts.forEach((t) => Object.freeze(t));

      // Freeze entire snapshot
      return Object.freeze(snapshot);
    }

    return snapshot;
  }

  // Method to handle persist acknowledgments from server
  handlePersistAck(ack: { sizeBytes: number; timestamp: string }): void {
    // Update room stats with authoritative size
    const oldStats = this.roomStats;
    this.roomStats = {
      bytes: ack.sizeBytes,
      cap: ROOM_CONFIG.ROOM_SIZE_READONLY_BYTES,
    };
    
    // Notify subscribers if changed
    if (oldStats?.bytes !== ack.sizeBytes) {
      this.statsSubscribers.forEach(cb => cb(this.roomStats));
    }
    
    // Check if room became read-only
    if (ack.sizeBytes >= ROOM_CONFIG.ROOM_SIZE_READONLY_BYTES) {
      console.warn('[RoomDocManager] Room is now read-only due to size limit');
      // Could emit an event or update UI state here
    }
  }
}

// Singleton Registry
class RoomDocManagerRegistryClass {
  private managers = new Map<RoomId, IRoomDocManager>();
  private defaultOptions?: RoomDocManagerOptions;

  /**
   * Set default options for all new managers
   * Useful for test environments
   */
  setDefaultOptions(options: RoomDocManagerOptions): void {
    this.defaultOptions = options;
  }

  get(roomId: RoomId, options?: RoomDocManagerOptions): IRoomDocManager {
    let manager = this.managers.get(roomId);

    if (!manager) {
      // eslint-disable-next-line no-console
      console.log('[Registry] Creating new RoomDocManager for:', roomId);
      // Use provided options, fall back to default options, or use browser defaults
      const finalOptions = options ?? this.defaultOptions;
      manager = new RoomDocManagerImpl(roomId, finalOptions);
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
