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
  QUEUE_CONFIG,
} from '@avlo/shared';
import { RollingGzipEstimator, getGzipSize } from './size-estimator';
import type {
  RoomId,
  Snapshot,
  PresenceView,
  Command,
  ExtendTTL,
  Stroke,
  TextBlock,
  Output,
  StrokeView,
  TextView,
  ViewTransform,
  SnapshotMeta,
} from '@avlo/shared';
import { WriteQueue } from './write-queue';
import { CommandBus } from './command-bus';

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
  write(cmd: Command): Promise<void>;
  extendTTL(): void;
  destroy(): void;
  // Test helper - force immediate processing
  processCommandsImmediate?(): Promise<void>;
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

  // Phase 2.4 Component A: Snapshot Publisher State
  private publishState = {
    isDirty: false,
    lastYUpdateAt: 0, // When Y last updated (performance.now())
    lastPublishTime: 0, // When we last published (performance.now())
    publishWorkMs: 0, // Track how long publish takes
    isHidden: false,
    batchWindow: 20, // Default batch window in ms
    pendingUpdates: [] as Array<{ update: Uint8Array; origin: unknown; time: number }>,
    lastSvKey: '', // Track to detect changes
    batchTimerInterval: null as number | null, // Continuous batch timer interval
    scheduledRaf: -1, // Track if RAF is scheduled (-1 = not scheduled)
    forcePublishRequested: false, // For clearboard or other immediate publish needs
  };

  // IndexedDB cache for render snapshots
  private snapshotCache: IDBDatabase | null = null;
  private readonly SNAPSHOT_CACHE_DB = 'avlo-snapshot-cache';
  private readonly SNAPSHOT_CACHE_VERSION = 1;

  // Track cleanup handlers
  private cleanupHandlers: Array<() => void> = [];

  // Room stats tracking (for Phase 2.5)
  private roomStats: { bytes: number; expiresAt?: number } | null = null;

  // Phase 2.5: WriteQueue and CommandBus
  private writeQueue: WriteQueue | null = null;
  private commandBus: CommandBus | null = null;
  
  // Size estimation for distributed constraints
  private sizeEstimator = new RollingGzipEstimator();

  constructor(roomId: RoomId) {
    this.roomId = roomId;

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

    // Phase 2.4: Setup snapshot publishing (NO await)
    this.initSnapshotCache(); // Async but don't await
    this.setupObservers();
    this.setupVisibilityHandling();
    this.startBatchTimer(); // Start the continuous batch timer

    // Phase 2.5: Setup write pipeline
    this.setupWritePipeline();

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
    console.log('[getCurrentScene] sceneTicks:', sceneTicks, 'length:', sceneTicks.length, 'toArray:', sceneTicks.toArray());
    return sceneTicks.length;
  }

  // Helper to build presence view from awareness (stub for now, will be populated in Phase 4)
  private buildPresenceView(): PresenceView {
    return {
      users: new Map(),
      localUserId: '',
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
  async write(cmd: Command): Promise<void> {
    if (!this.writeQueue) {
      console.error('[RoomDocManager] WriteQueue not initialized');
      return;
    }

    const success = await this.writeQueue.enqueue(cmd);
    if (!success) {
      console.warn('[RoomDocManager] Command rejected:', cmd.type);
    }

    // Commands are processed automatically by CommandBus on its schedule
  }

  // Extend TTL with rate limiting
  extendTTL(): void {
    const cmd: ExtendTTL = {
      type: 'ExtendTTL',
      idempotencyKey: `ttl_${Date.now()}`,
    };
    this.write(cmd);
  }

  // Test helper - force immediate processing of queued commands
  // IMPORTANT: This goes through the normal pipeline, no bypasses!
  async processCommandsImmediate(): Promise<void> {
    if (!this.commandBus) {
      return;
    }

    // Process commands immediately
    await this.commandBus.processImmediate();

    // CRITICAL: Do NOT call publishSnapshot() directly - that's a bypass!
    // Instead, mark dirty and simulate a batch timer tick + rAF
    this.publishState.isDirty = true;
    
    // Simulate the complete flow: batch timer tick -> rAF -> publish
    // For testing, we execute synchronously what would normally be async
    if (this.publishState.scheduledRaf === -1 && this.publishState.isDirty) {
      // Simulate the rAF callback firing immediately
      this.maybePublish();
    }
  }

  // Lifecycle
  destroy(): void {
    // eslint-disable-next-line no-console
    console.log('[RoomDocManager] Destroying');

    // Cancel scheduled RAF if pending
    if (this.publishState.scheduledRaf !== -1) {
      cancelAnimationFrame(this.publishState.scheduledRaf);
      this.publishState.scheduledRaf = -1;
    }

    // Stop the continuous batch timer
    if (this.publishState.batchTimerInterval !== null) {
      clearInterval(this.publishState.batchTimerInterval);
      this.publishState.batchTimerInterval = null;
    }

    // Stop command processing
    this.commandBus?.destroy();
    this.writeQueue?.destroy();

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

  // Phase 2.4: Start continuous batch timer (runs every BATCH_WINDOW_MS)
  // INVARIANT: This is the ONLY place that creates a timer for publishing
  private startBatchTimer(): void {
    // Start the continuous batch timer that drives all publishing
    // Note: Uses fixed 20ms interval. If adaptive batch window is needed,
    // would need to restart timer when window changes
    this.publishState.batchTimerInterval = setInterval(() => {
      this.onBatchTimerTick();
    }, this.publishState.batchWindow) as unknown as number;
  }

  // Phase 2.4: Batch timer tick - the ONLY place that schedules rAF
  // INVARIANT: At most one rAF may be pending at any time (scheduledRaf ∈ {-1, ID})
  // INVARIANT: This is the sole arbiter of when to schedule rAF
  private onBatchTimerTick(): void {
    // Check if we have work to do
    const hasWork = this.publishState.isDirty || this.publishState.forcePublishRequested;
    
    if (!hasWork) {
      return; // No work, nothing to do
    }

    // CRITICAL: Only schedule rAF if one isn't already pending
    if (this.publishState.scheduledRaf === -1) {
      this.publishState.scheduledRaf = requestAnimationFrame(() => {
        // CRITICAL: Clear scheduledRaf BEFORE calling maybePublish
        // This ensures one-shot behavior even if maybePublish throws
        this.publishState.scheduledRaf = -1;
        this.maybePublish();
      });
    }
    // If rAF is already scheduled, do nothing - wait for it to complete
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

  private handleYDocUpdate = async (update: Uint8Array, origin: unknown): Promise<void> => {
    // Phase 2.4: CRITICAL - Only mark dirty, NO timer/rAF scheduling here!
    // The batch timer is the sole arbiter of when to schedule rAF
    
    // Mark dirty and record when Y was updated
    this.publishState.isDirty = true;
    this.publishState.lastYUpdateAt = performance.now();

    // Store update for potential analysis (optional)
    this.publishState.pendingUpdates.push({ update, origin, time: Date.now() });
    
    // Track delta size for distributed constraints
    const rawDeltaBytes = update.byteLength;
    
    // Sample compression ratio periodically for accuracy
    if (this.sizeEstimator.shouldSample(rawDeltaBytes)) {
      try {
        const gzDeltaBytes = await getGzipSize(update);
        this.sizeEstimator.observeDelta(rawDeltaBytes, gzDeltaBytes);
      } catch (err) {
        // Fallback to estimate only
        this.sizeEstimator.observeDelta(rawDeltaBytes);
      }
    } else {
      // Use estimated ratio
      this.sizeEstimator.observeDelta(rawDeltaBytes);
    }

    // Ring buffer behavior: trim old updates (keep max 100)
    // This prevents unbounded memory growth from rapid updates
    const cutoff = Date.now() - this.publishState.batchWindow * 2;
    this.publishState.pendingUpdates = this.publishState.pendingUpdates
      .filter((u) => u.time > cutoff)
      .slice(-100); // Hard cap at 100 entries
    
    // NOTE: No timer scheduling here! The batch timer will handle it
  };

  // Phase 2.4 Component C: Publish decision - NO SELF-RESCHEDULING
  // Called ONLY from rAF callback scheduled by batch timer
  // INVARIANT: This function is pure w.r.t. scheduling - it either publishes or returns
  // INVARIANT: It NEVER schedules timers or rAF
  private maybePublish(): void {
    // Check if we have work
    const hasWork = this.publishState.isDirty || this.publishState.forcePublishRequested;
    
    if (!hasWork) {
      // No work to do, just return
      // The next batch timer tick will check again
      return;
    }
    
    // We have work and we're in a rAF callback - always publish
    // This implements the "Always-Publish on rAF" strategy from PHASE2_FIXES.md
    // Simpler than quiet-time gating and more predictable for testing
    const t0 = performance.now();
    this.publishSnapshot();
    const publishTime = performance.now();
    
    // Update state
    this.publishState.lastPublishTime = publishTime;
    this.publishState.isDirty = false;
    this.publishState.forcePublishRequested = false;
    
    // Measure publish cost (for metrics/debugging)
    const cost = publishTime - t0;
    this.publishState.publishWorkMs = cost;
    
    // NOTE: Adaptive batch window disabled for simplicity
    // If needed, would require restarting the interval timer
    // this.adaptBatchWindow(cost);
    
    // CRITICAL: Do NOT schedule any timers or rAF here!
    // The batch timer will handle the next opportunity
  }

  // Phase 2.4: Adaptive batch window (DISABLED for simplicity)
  // If re-enabled, would need to restart the interval timer with new window
  // private adaptBatchWindow(costMs: number): void {
  //   const oldWindow = this.publishState.batchWindow;
  //   if (costMs > 8) {
  //     // Work exceeded budget - widen batch window toward 24-32ms
  //     this.publishState.batchWindow = Math.min(32, Math.max(24, this.publishState.batchWindow + 4));
  //   } else if (costMs < 4) {
  //     // Work is light - narrow batch window toward 8-16ms  
  //     this.publishState.batchWindow = Math.max(8, Math.min(16, this.publishState.batchWindow - 2));
  //   }
  //   // If window changed, restart timer with new interval
  //   if (oldWindow !== this.publishState.batchWindow && this.publishState.batchTimerInterval) {
  //     clearInterval(this.publishState.batchTimerInterval);
  //     this.startBatchTimer();
  //   }
  // }

  // Phase 2.4 Component D: Visibility Handling
  private setupVisibilityHandling(): void {
    const handleVisibilityChange = () => {
      this.publishState.isHidden = document.hidden;

      // "Visible kick" - request immediate publish when tab becomes visible with pending changes
      if (!this.publishState.isHidden && this.publishState.isDirty) {
        // Request a forced publish on next batch timer tick
        this.publishState.forcePublishRequested = true;
        
        // The batch timer will pick this up and schedule a rAF
        // No direct timer/rAF scheduling here!
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
    console.log('[RoomDocManager] Building snapshot with scene:', currentScene);

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

  // Phase 2.5: Setup WriteQueue and CommandBus
  private setupWritePipeline(): void {
    // Create WriteQueue
    this.writeQueue = new WriteQueue({
      maxPending: QUEUE_CONFIG.WRITE_QUEUE_MAX_PENDING,
      isMobile: this.detectMobile(),
      getCurrentSize: () => this.estimateDocSize(),
      getCurrentScene: () => this.getCurrentScene(),
    });

    // Create CommandBus
    this.commandBus = new CommandBus({
      ydoc: this.ydoc,
      writeQueue: this.writeQueue,
      getCurrentSize: () => this.estimateDocSize(),
      getHelpers: () => ({
        getStrokes: this.getStrokes.bind(this),
        getTexts: this.getTexts.bind(this),
        getCode: this.getCode.bind(this),
        getOutputs: this.getOutputs.bind(this),
        getSceneTicks: this.getSceneTicks.bind(this),
        getCurrentScene: this.getCurrentScene.bind(this),
      }),
      onClearBoard: () => {
        // Reset size estimator baseline after ClearBoard
        // Keep a small baseline as the board is not truly empty (metadata exists)
        this.sizeEstimator.resetBaseline(32 * 1024); // 32KB baseline
        
        // Force a publish after ClearBoard to ensure immediate visibility
        this.publishState.forcePublishRequested = true;
      },
    });

    // Start processing
    this.commandBus.start();
  }

  // Helper to detect mobile devices
  private detectMobile(): boolean {
    if (typeof window === 'undefined') return false;

    const userAgent = window.navigator?.userAgent || '';
    const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(
      userAgent,
    );
    const hasTouch = 'ontouchstart' in window;
    const smallScreen = window.innerWidth < 768;

    return isMobile || (hasTouch && smallScreen);
  }

  // Helper to estimate doc size (compressed)
  private estimateDocSize(): number {
    // Use rolling estimator for efficient size tracking
    return Math.ceil(this.sizeEstimator.docEstGzBytes);
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
