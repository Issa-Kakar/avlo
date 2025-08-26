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
import { renderCache } from './render-cache';

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
  
  // Phase 2.4.4: Render cache for boot splash (cosmetic only)
  storeRenderCache(canvas: HTMLCanvasElement): Promise<void>;
  showBootSplash(targetElement: HTMLElement): Promise<(() => void) | null>;
  clearRenderCache(): Promise<void>;
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
  
  // Throttled presence updates (30Hz = ~33ms)
  private updatePresenceThrottled: (() => void) | null = null;

  // Timing abstractions (injected for testing)
  private clock: Clock;
  private frames: FrameScheduler;
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


  // Room stats tracking
  private roomStats: RoomStats | null = null;
  
  // Size estimation for guards
  private sizeEstimator: RollingGzipEstimator;
  
  // Track if destroyed for cleanup
  private destroyed = false;

  constructor(roomId: RoomId, options?: RoomDocManagerOptions) {
    this.roomId = roomId;
    this.userId = ulid(); // User ID for this session
    
    // Initialize Y.Doc with room GUID
    this.ydoc = new Y.Doc({ guid: roomId });
    
    // Initialize timing abstractions
    this.clock = options?.clock || new BrowserClock();
    this.frames = options?.frames || new BrowserFrameScheduler();
    
    // Initialize helpers
    this.sizeEstimator = new RollingGzipEstimator();
    
    // Initialize state
    this.publishState = {
      isDirty: false,
      presenceDirty: false,  // Track presence changes separately
      rafId: -1,
      lastPublishTime: 0,
      publishCostMs: 0,
      pendingUpdates: new UpdateRing(16), // Keep ring buffer for metrics
      lastSvKey: '', // Track to detect changes
    };
    
    // Start with empty snapshot
    this._currentSnapshot = createEmptySnapshot();
    
    // Initialize root structure
    this.initializeYjsStructures();
    
    // Setup observers
    this.setupObservers();
    
    // Initialize throttled presence updates (30Hz = ~33ms)
    this.updatePresenceThrottled = this.throttle(
      this.updatePresence.bind(this),
      33 // 1000ms / 30Hz = ~33ms
    );
    
    // Initialize render cache for boot splash (Phase 2.4.4)
    // Fire and forget - cosmetic only
    renderCache.init().catch(err => {
      console.warn('[RoomDocManager] Render cache init failed (non-critical):', err);
    });
    
    // Start RAF loop
    this.startPublishLoop();
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
    const users = new Map<string, {
      name: string;
      color: string;
      cursor?: { x: number; y: number };
      activity: string;
      lastSeen: number;
    }>();
    
    // For now, return proper structure even if awareness not connected
    // This will be populated in Phase 8 when awareness is integrated
    // Example of what will be added in Phase 8:
    // if (this.awareness) {
    //   this.awareness.getStates().forEach((state, clientId) => {
    //     if (state.userId && state.cursor) {
    //       users.set(state.userId, {
    //         name: state.name || 'Anonymous',
    //         color: state.color || '#000000',
    //         cursor: state.cursor,
    //         activity: state.activity || 'idle',
    //         lastSeen: Date.now(),
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

      // Initialize schema version (CRITICAL: Required per OVERVIEW.MD line 235)
      if (!root.has('v')) {
        root.set('v', 1); // Schema version for future migrations
      }

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
    const estimatedSize = this.sizeEstimator.docEstGzBytes;
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

  // Simple throttle utility function
  private throttle<T extends (...args: any[]) => void>(
    func: T,
    wait: number
  ): T {
    let timeout: ReturnType<typeof setTimeout> | null = null;
    let lastCallTime = 0;
    
    const throttled = (...args: any[]) => {
      const now = Date.now();
      const timeSinceLastCall = now - lastCallTime;
      
      if (timeSinceLastCall >= wait) {
        // Enough time has passed, execute immediately
        lastCallTime = now;
        func.apply(this, args);
      } else if (!timeout) {
        // Schedule for later
        const delay = wait - timeSinceLastCall;
        timeout = setTimeout(() => {
          lastCallTime = Date.now();
          timeout = null;
          func.apply(this, args);
        }, delay);
      }
      // If timeout is already scheduled, skip this call (throttling)
    };
    
    return throttled as T;
  }
  
  // Update presence and notify subscribers (called when awareness changes)
  private updatePresence(): void {
    const presence = this.buildPresenceView();
    this.presenceSubscribers.forEach(cb => cb(presence));
    
    // Mark presence dirty to trigger snapshot publish
    this.publishState.presenceDirty = true;
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
    if (typeof window === 'undefined' || typeof navigator === 'undefined') return false;
    return /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
  }

  // Lifecycle
  destroy(): void {
    // Set destroyed flag
    this.destroyed = true;
    
    // Stop RAF loop
    if (this.publishState.rafId !== -1) {
      this.frames.cancel(this.publishState.rafId);
      this.publishState.rafId = -1;
    }
    
    // Remove Y.Doc observers
    // NOTE: This correctly removes the listener because handleYDocUpdate
    // is an arrow function property with stable identity (see setupObservers)
    this.ydoc.off('update', this.handleYDocUpdate);
    
    // Clear subscriptions
    this.snapshotSubscribers.clear();
    this.presenceSubscribers.clear();
    this.statsSubscribers.clear();
    
    // Clear throttled function reference
    this.updatePresenceThrottled = null;
    
    // Destroy Y.Doc
    this.ydoc.destroy();
    
    // Clear references
    this._currentSnapshot = createEmptySnapshot();
    this.roomStats = null;
    
    // Note: Registry removal is handled externally
    // The registry that created this manager should handle cleanup
  }

  /**
   * Create a safe state vector key for cache invalidation.
   * Uses first 100 bytes + length to create a unique identifier
   * without risk of stack overflow on large state vectors.
   */
  private createSafeStateVectorKey(stateVector: Uint8Array): string {
    // Take first 100 bytes (or less if vector is smaller)
    const sampleSize = Math.min(100, stateVector.length);
    const sample = stateVector.slice(0, sampleSize);
    
    // Convert sample to base64
    let sampleStr = '';
    for (let i = 0; i < sample.length; i++) {
      sampleStr += String.fromCharCode(sample[i]);
    }
    
    // Include length for additional uniqueness
    // Format: base64(first100bytes):length:checksum
    const checksum = Array.from(stateVector.slice(-4))
      .reduce((sum, byte) => sum + byte, 0);
    
    return `${btoa(sampleStr)}:${stateVector.length}:${checksum}`;
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
    // NOTE: handleYDocUpdate is an arrow function property (not a method), which creates
    // a stable function reference bound to this instance. This ensures:
    // 1. The same function identity is used for both on() and off()
    // 2. Proper cleanup occurs in destroy() with no memory leak
    // 3. 'this' context is correctly bound without .bind()
    // This is the recommended pattern for event handlers in classes.
    this.ydoc.on('update', this.handleYDocUpdate);

    // Optional: Track specific events for debugging
    if (typeof process !== 'undefined' && process.env?.NODE_ENV === 'development') {
      this.ydoc.on('afterTransaction', (transaction: Y.Transaction) => {
        // eslint-disable-next-line no-console
        console.log('[Snapshot] Transaction origin:', transaction.origin);
      });
    }
  }

  // Arrow function property ensures stable reference for event listener cleanup
  // This is NOT a memory leak - the same function reference is used for on() and off()
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



  // Phase 2.4 Component E: Snapshot Building & Publishing
  private publishSnapshot(newSnapshot: Snapshot): void {
    // Update svKey tracker
    this.publishState.lastSvKey = newSnapshot.svKey;

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


  // Private: Build immutable snapshot from Y.Doc
  private buildSnapshot(): Snapshot {
    // Get current state vector for svKey
    const stateVector = Y.encodeStateVector(this.ydoc);
    // CRITICAL: Use safe encoding to avoid stack overflow on large state vectors
    // Create a hash-like key from first 100 bytes + length for uniqueness
    // This is sufficient for cosmetic cache invalidation purposes
    const svKey = this.createSafeStateVectorKey(stateVector);

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
        scene: s.scene, // Include scene field (assigned at commit time, used for filtering)
        createdAt: s.createdAt,
        userId: s.userId,
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
        color: t.color, // Flattened for simpler access
        size: t.size,   // Flattened for simpler access
        scene: t.scene,  // Include scene field (assigned at commit time, used for filtering)
        createdAt: t.createdAt,
        userId: t.userId,
      }));

    // Build presence view
    const presence: PresenceView = this.buildPresenceView();

    // Build spatial index (Phase 6 - for now just null)
    const spatialIndex = null;

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

  // Phase 2.4.4: Render cache methods for boot splash (cosmetic only)
  
  /**
   * Store current render to cache for boot splash
   * Called after successful canvas render (Phase 3)
   * @param canvas - The rendered canvas element
   */
  async storeRenderCache(canvas: HTMLCanvasElement): Promise<void> {
    if (!canvas || this.destroyed) return;
    
    try {
      // Store with current svKey for validation
      await renderCache.store(this.roomId, this._currentSnapshot.svKey, canvas);
    } catch (error) {
      // Non-critical - just log and continue
      console.debug('[RoomDocManager] Failed to store render cache:', error);
    }
  }

  /**
   * Show boot splash from cache while Y.Doc loads
   * @param targetElement - Element to display splash in
   * @returns Cleanup function to fade out splash, or null if no cache
   */
  async showBootSplash(targetElement: HTMLElement): Promise<(() => void) | null> {
    try {
      const shown = await renderCache.showBootSplash(this.roomId, targetElement);
      if (shown) {
        // Find the image element and return its fadeOut function
        const img = targetElement.querySelector('img[style*="z-index"]') as any;
        return img?.fadeOut || null;
      }
      return null;
    } catch (error) {
      console.debug('[RoomDocManager] Failed to show boot splash:', error);
      return null;
    }
  }

  /**
   * Clear render cache for this room
   * Called when room data is cleared/deleted
   */
  async clearRenderCache(): Promise<void> {
    try {
      await renderCache.clear(this.roomId);
    } catch (error) {
      console.debug('[RoomDocManager] Failed to clear render cache:', error);
    }
  }
}

// Registry class for managing RoomDocManager instances
export class RoomDocManagerRegistry {
  private managers = new Map<RoomId, IRoomDocManager>();
  private defaultOptions?: RoomDocManagerOptions;

  /**
   * Set default options for all new managers
   * Useful for test environments
   */
  setDefaultOptions(options: RoomDocManagerOptions): void {
    this.defaultOptions = options;
  }

  /**
   * Get or create a manager for a room
   * Ensures singleton per room within this registry instance
   */
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

  /**
   * Create an isolated manager instance for testing
   * This manager is NOT tracked by the registry
   */
  createIsolated(roomId: RoomId, options?: RoomDocManagerOptions): IRoomDocManager {
    const finalOptions = options ?? this.defaultOptions;
    return new RoomDocManagerImpl(roomId, finalOptions);
  }

  has(roomId: RoomId): boolean {
    return this.managers.has(roomId);
  }

  remove(roomId: RoomId): void {
    const manager = this.managers.get(roomId);
    if (manager) {
      // eslint-disable-next-line no-console
      console.log('[Registry] Removing RoomDocManager for:', roomId);
      manager.destroy();
      this.managers.delete(roomId);
    }
  }

  /**
   * Destroy all managers and clear the registry
   * Used for cleanup in tests and app teardown
   */
  destroyAll(): void {
    // eslint-disable-next-line no-console
    console.log('[Registry] Destroying all RoomDocManagers');
    this.managers.forEach((manager) => manager.destroy());
    this.managers.clear();
    this.defaultOptions = undefined;
  }

  /**
   * Reset the registry completely (for tests)
   * More thorough than destroyAll - resets all state
   */
  reset(): void {
    this.destroyAll();
    // Any additional reset logic can go here
  }

  /**
   * Get the count of managed instances (for debugging/testing)
   */
  size(): number {
    return this.managers.size;
  }
}

// Factory function to create a new registry
export function createRoomDocManagerRegistry(): RoomDocManagerRegistry {
  return new RoomDocManagerRegistry();
}

// Export manager type
export type RoomDocManager = IRoomDocManager;

// Re-export render cache for direct access if needed
export { renderCache } from './render-cache';

// Test-only exports - clearly marked for testing purposes only
// These should NEVER be used in production code
export const __testonly = {
  RoomDocManagerImpl: process.env.NODE_ENV === 'test' ? RoomDocManagerImpl : null,
  // Helper to observe Y.Doc behavior in tests without exposing Y types to app
  attachDocObserver: process.env.NODE_ENV === 'test' 
    ? (manager: IRoomDocManager, callback: (event: string, data?: unknown) => void) => {
        // Type assertion to access private impl
        const impl = manager as unknown as RoomDocManagerImpl;
        // Access the private ydoc for test observation
        const ydoc = (impl as any).ydoc;
        if (!ydoc) return () => {};
        
        // Observe update events
        const updateHandler = (update: Uint8Array, origin: unknown) => {
          callback('update', { updateSize: update.length, origin });
        };
        
        // Observe transaction events  
        const transactionHandler = (transaction: any) => {
          callback('transaction', { origin: transaction.origin || null });
        };
        
        ydoc.on('update', updateHandler);
        ydoc.on('afterTransaction', transactionHandler);
        
        // Return cleanup function
        return () => {
          ydoc.off('update', updateHandler);
          ydoc.off('afterTransaction', transactionHandler);
        };
      }
    : null
};
