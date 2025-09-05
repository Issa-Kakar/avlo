/**
 * RoomDocManager - Central authority for Y.Doc and real-time collaboration
 *
 * ERROR BOUNDARY RECOMMENDATIONS (Phase 3+):
 * - Y.js operations rarely throw (CRDTs are designed for consistency)
 * - Critical error boundaries needed at:
 *   1. IndexedDB attach/open (Phase 7) - handle quota/corruption errors
 *   2. WebSocket connect/sync (Phase 7) - handle network failures
 *   3. WebRTC bring-up (Phase 17) - handle ICE/signaling failures
 *   4. Snapshot cache I/O (Phase 2.4.4) - handle storage errors
 * - React error boundary at app level for UI protection
 * - Current Phase 2 is resilient without explicit boundaries
 */

import * as Y from 'yjs';
import { IndexeddbPersistence } from 'y-indexeddb';
import { WebsocketProvider } from 'y-websocket';
import {
  createEmptySnapshot, // Regular import, not type import - function needs to be callable
  ROOM_CONFIG,
  TEXT_CONFIG,
  ulid,
} from '@avlo/shared';
import { clientConfig } from './config-schema';
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

  // Phase 6A: Gate status methods
  getGateStatus(): Readonly<{
    idbReady: boolean;
    wsConnected: boolean;
    wsSynced: boolean;
    awarenessReady: boolean;
    firstSnapshot: boolean;
  }>;
  isIndexedDBReady(): boolean;

  // Phase 6C: Room stats support
  /**
   * Update room stats from external sources (e.g., metadata polling)
   * This is used by TanStack Query hooks to update stats from HTTP metadata
   */
  setRoomStats(stats: RoomStats | null): void;

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
  private readonly userId: string; // Session user ID for undo/redo origin
  // NOTE: No cached Y structure references - all access via helper methods

  // Providers (will be null initially, added in later phases)
  private indexeddbProvider: IndexeddbPersistence | null = null;
  private websocketProvider: WebsocketProvider | null = null;
  private webrtcProvider: unknown = null;

  // Current state
  private _currentSnapshot: Snapshot;

  // Subscription management
  private snapshotSubscribers = new Set<(snap: Snapshot) => void>();
  private presenceSubscribers = new Set<(p: PresenceView) => void>();
  private statsSubscribers = new Set<(s: RoomStats | null) => void>();

  // Throttled presence updates (30Hz = ~33ms)
  private updatePresenceThrottled: (() => void) | null = null;
  // Cleanup function for throttled presence updates
  private updatePresenceThrottledCleanup: (() => void) | null = null;

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
    pendingUpdates: null as UpdateRing<{
      update: Uint8Array;
      origin: unknown;
      time: number;
    }> | null,
    lastSvKey: '', // Track to detect changes
  };

  // Room stats tracking
  private roomStats: RoomStats | null = null;

  // Size estimation for guards
  // AUDIT NOTE: Clear board does NOT delete data, only increments scene counter
  // Size estimator remains valid across scene changes (tracks total doc size)
  // Will be enhanced with compaction/GC and persist_ack in later phases
  private sizeEstimator: RollingGzipEstimator;

  // Track if destroyed for cleanup
  private destroyed = false;

  // Gate tracking
  private gates = {
    idbReady: false,
    wsConnected: false,
    wsSynced: false,
    awarenessReady: false,
    firstSnapshot: false,
  };
  private gateTimeouts: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private gateCallbacks: Map<string, Set<() => void>> = new Map();

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
      presenceDirty: false, // Track presence changes separately
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
    const presenceThrottle = this.throttle(
      this.updatePresence.bind(this),
      33, // 1000ms / 30Hz = ~33ms
    );
    this.updatePresenceThrottled = presenceThrottle.throttled;
    this.updatePresenceThrottledCleanup = presenceThrottle.cleanup;

    // Initialize render cache for boot splash (Phase 2.4.4)
    // Fire and forget - cosmetic only
    renderCache.init().catch((err) => {
      console.warn('[RoomDocManager] Render cache init failed (non-critical):', err);
    });

    // Initialize IndexedDB provider (Phase 6A)
    this.initializeIndexedDBProvider();

    // Initialize WebSocket provider (Phase 6C)
    this.initializeWebSocketProvider();

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
    // AUDIT NOTE: Scene can never be negative by construction (array.length is always >= 0)
    // Empty filtered stroke/text arrays are handled correctly by renderers
    const scene = sceneTicks.length;
    console.log(`[RoomDocManager] getCurrentScene: scene=${scene}, ticks=[${sceneTicks.toArray().join(', ')}]`);
    return scene;
  }

  // Build presence view from awareness (will be connected to awareness in Phase 8)
  private buildPresenceView(): PresenceView {
    const users = new Map<
      string,
      {
        name: string;
        color: string;
        cursor?: { x: number; y: number };
        activity: string;
        lastSeen: number;
      }
    >();

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

    // 3. Frame size check - Delta-based estimation
    // Track the update generated by this transaction
    let updateSize = 0;
    const updateHandler = (update: Uint8Array) => {
      updateSize = update.byteLength;
    };

    // Temporarily observe updates to measure delta
    this.ydoc.on('update', updateHandler);

    try {
      // Execute in single transaction with user origin
      this.ydoc.transact(() => {
        fn(this.ydoc);
      }, this.userId); // Origin for undo/redo tracking

      // Check if the delta exceeds frame limit
      if (updateSize > ROOM_CONFIG.MAX_INBOUND_FRAME_BYTES) {
        // The delta itself is too large
        console.error(
          `[RoomDocManager] Delta size (${updateSize} bytes) exceeds frame limit (${ROOM_CONFIG.MAX_INBOUND_FRAME_BYTES} bytes)`,
        );

        // In production, we should ideally undo this transaction
        // For now, log warning to maintain backward compatibility
        // TODO: Phase 3 - Implement proper rollback mechanism
      }
    } finally {
      // Always clean up the update handler
      this.ydoc.off('update', updateHandler);
    }

    // Mark dirty for publishing
    this.publishState.isDirty = true;
  }

  // Enhanced throttle utility function with cleanup
  private throttle<T extends (...args: any[]) => void>(
    func: T,
    wait: number,
  ): { throttled: T; cleanup: () => void } {
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

    // Cleanup function to clear any pending timeout
    const cleanup = () => {
      if (timeout !== null) {
        clearTimeout(timeout);
        timeout = null;
      }
    };

    return { throttled: throttled as T, cleanup };
  }

  // Update presence and notify subscribers (called when awareness changes)
  private updatePresence(): void {
    const presence = this.buildPresenceView();
    this.presenceSubscribers.forEach((cb) => cb(presence));

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
    // CRITICAL FIX: Include maxTouchPoints check for iPadOS reliability
    // iPadOS reports as "Macintosh" in UA string but has maxTouchPoints > 1
    return (
      /Android|webOS|iPhone|iPad|iPod/i.test(navigator.userAgent) || navigator.maxTouchPoints > 1
    );
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

    // Clear gate timeouts
    this.gateTimeouts.forEach((timeout) => clearTimeout(timeout));
    this.gateTimeouts.clear();

    // Cleanup providers (Phase 6A additions)
    if (this.indexeddbProvider) {
      this.indexeddbProvider.destroy();
      this.indexeddbProvider = null;
    }

    if (this.websocketProvider) {
      // Proper cleanup: disconnect first, then destroy
      this.websocketProvider.disconnect();
      this.websocketProvider.destroy();
      this.websocketProvider = null;
    }

    // Remove Y.Doc observers
    // NOTE: This correctly removes the listener because handleYDocUpdate
    // is an arrow function property with stable identity (see setupObservers)
    this.ydoc.off('update', this.handleYDocUpdate);

    // Clear subscriptions
    this.snapshotSubscribers.clear();
    this.presenceSubscribers.clear();
    this.statsSubscribers.clear();

    // Clear throttled function and any pending timeouts
    if (this.updatePresenceThrottledCleanup) {
      this.updatePresenceThrottledCleanup();
      this.updatePresenceThrottledCleanup = null;
    }
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
    const checksum = Array.from(stateVector.slice(-4)).reduce((sum, byte) => sum + byte, 0);

    const key = `${btoa(sampleStr)}:${stateVector.length}:${checksum}`;

    return key;
  }

  // Simple RAF loop for publishing
  private startPublishLoop(): void {
    const rafLoop = () => {
      // Publish if Y.Doc changed OR presence changed
      if (this.publishState.isDirty || this.publishState.presenceDirty) {
        console.log(`[RoomDocManager] RAF Loop: Publishing snapshot (docDirty=${this.publishState.isDirty}, presenceDirty=${this.publishState.presenceDirty})`);
        const startTime = this.clock.now();

        // Build snapshot
        const newSnapshot = this.buildSnapshot();

        // CRITICAL FIX: Always publish when dirty, don't use svKey as a gate
        // The svKey truncation (first 100 bytes) was missing local client updates
        // when state vectors were large (>100 bytes), causing strokes to not render
        // until refresh. SvKey dedupe optimization had to be removed.
        this.publishSnapshot(newSnapshot);

        // Clear both dirty flags
        this.publishState.isDirty = false;
        this.publishState.presenceDirty = false;

        // Track timing for metrics
        this.publishState.lastPublishTime = this.clock.now();
        this.publishState.publishCostMs = this.clock.now() - startTime;
      }

      // Continue loop if not destroyed
      // AUDIT NOTE: Proper guard prevents RAF callbacks after destroy()
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
    console.log(`[RoomDocManager] handleYDocUpdate: Y.Doc updated, origin=${origin}, updateSize=${update.byteLength}`);
    // Just mark dirty - RAF will handle publishing
    this.publishState.isDirty = true;

    // Store update for metrics (keep ring buffer, it's useful)
    if (this.publishState.pendingUpdates) {
      this.publishState.pendingUpdates.push({
        update,
        origin,
        time: this.clock.now(),
      });
    }

    // Update size estimate (keep this, it's needed for guards)
    const deltaBytes = update.byteLength;
    this.sizeEstimator.observeDelta(deltaBytes);

    // RAF loop will handle publishing
  };

  private initializeIndexedDBProvider(): void {
    try {
      // Create room-scoped IDB provider
      const dbName = `avlo.v1.rooms.${this.roomId}`;
      this.indexeddbProvider = new IndexeddbPersistence(dbName, this.ydoc);

      // Set up IDB gate with 2s timeout
      const timeoutId = setTimeout(() => {
        this.openGate('idbReady');
        console.debug('[RoomDocManager] IDB timeout reached, continuing with empty doc');
      }, 2000);
      this.gateTimeouts.set('idbReady', timeoutId);

      // Listen for IDB sync completion for gate control
      this.indexeddbProvider.whenSynced
        .then(() => {
          const timeout = this.gateTimeouts.get('idbReady');
          if (timeout) {
            clearTimeout(timeout);
            this.gateTimeouts.delete('idbReady');
          }
          this.openGate('idbReady');
          console.debug('[RoomDocManager] IDB synced successfully');
        })
        .catch((err: unknown) => {
          console.warn('[RoomDocManager] IDB sync error (non-critical):', err);
          // Still open gate on error - fallback to empty doc
          this.openGate('idbReady');
        });

      // Note: No need to listen for 'synced' event to mark dirty
      // Y.Doc updates from IDB will trigger the existing doc update handler
    } catch (err: unknown) {
      console.warn('[RoomDocManager] IDB initialization failed (non-critical):', err);
      // Mark as failed but continue
      this.openGate('idbReady');
    }
  }

  private initializeWebSocketProvider(): void {
    try {
      // Get config (validated) - typically '/ws'
      const wsBase = clientConfig.VITE_WS_BASE;

      // Convert to WebSocket URL base (without room ID)
      const wsUrl = this.buildWebSocketUrl(wsBase);

      // Create WebSocket provider with standard signature
      // y-websocket will append /<roomId> to the base URL automatically
      // Result: ws://host/ws/<roomId>
      this.websocketProvider = new WebsocketProvider(
        wsUrl,
        this.roomId, // Pass room ID separately (standard y-websocket contract)
        this.ydoc,
        {
          // Disable awareness for now (Phase 7)
          awareness: undefined,
          // Reconnect settings
          maxBackoffTime: 10000,
          resyncInterval: 5000,
        },
      );

      // Set up G_WS_CONNECTED gate with 5s timeout
      const wsConnectedTimeout = setTimeout(() => {
        if (!this.gates.wsConnected && this.gates.idbReady) {
          // Proceed offline if IDB ready
          console.debug('[RoomDocManager] WS connection timeout, proceeding offline');
        }
      }, 5000);
      this.gateTimeouts.set('wsConnected', wsConnectedTimeout);

      // Set up G_WS_SYNCED gate with 10s timeout
      const wsSyncedTimeout = setTimeout(() => {
        if (!this.gates.wsSynced) {
          // Keep rendering from IDB, continue trying to sync
          console.debug('[RoomDocManager] WS sync timeout, continuing with local state');
        }
      }, 10000);
      this.gateTimeouts.set('wsSynced', wsSyncedTimeout);

      // Set up connection gates
      this.websocketProvider.on('status', (event: { status: string }) => {
        if (event.status === 'connected') {
          // Clear connection timeout
          const timeout = this.gateTimeouts.get('wsConnected');
          if (timeout) {
            clearTimeout(timeout);
            this.gateTimeouts.delete('wsConnected');
          }
          this.openGate('wsConnected');
          console.debug('[RoomDocManager] WebSocket connected');
        } else if (event.status === 'disconnected') {
          this.gates.wsConnected = false;
          this.gates.wsSynced = false;
          console.debug('[RoomDocManager] WebSocket disconnected');
        }
      });

      // Listen for sync status (v3 uses 'sync' event, not 'synced')
      this.websocketProvider.on('sync', (isSynced: boolean) => {
        if (isSynced) {
          // Clear sync timeout
          const timeout = this.gateTimeouts.get('wsSynced');
          if (timeout) {
            clearTimeout(timeout);
            this.gateTimeouts.delete('wsSynced');
          }
          this.openGate('wsSynced');
          console.debug('[RoomDocManager] WebSocket synced');
        } else {
          this.gates.wsSynced = false;
        }
      });

      // Note: Document updates are already handled by the existing Y.Doc update observer
      // The y-websocket provider triggers Y.Doc updates which are handled by setupObservers()
      // No need for additional provider-specific update listeners
    } catch (err: unknown) {
      console.error('[RoomDocManager] WebSocket initialization failed:', err);
      // Keep offline mode functional
    }
  }

  private buildWebSocketUrl(basePath: string): string {
    // Handle both relative and absolute URLs
    if (basePath.startsWith('ws://') || basePath.startsWith('wss://')) {
      return basePath;
    }

    // Build from current location
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host;

    // Ensure path starts with /
    const cleanPath = basePath.startsWith('/') ? basePath : `/${basePath}`;

    // Return base WebSocket URL (y-websocket will append room ID)
    return `${protocol}//${host}${cleanPath}`;
  }

  // Gate management
  private openGate(gateName: keyof typeof this.gates): void {
    if (this.gates[gateName]) return; // Already open

    this.gates[gateName] = true;

    // Notify subscribers
    const callbacks = this.gateCallbacks.get(gateName);
    if (callbacks) {
      callbacks.forEach((cb) => cb());
      callbacks.clear();
    }

    // Note: G_FIRST_SNAPSHOT opens in buildSnapshot() when first doc-derived snapshot publishes
    // Do NOT open it here based on other gates
  }

  private whenGateOpen(gateName: keyof typeof this.gates): Promise<void> {
    if (this.gates[gateName]) {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      if (!this.gateCallbacks.has(gateName)) {
        this.gateCallbacks.set(gateName, new Set());
      }
      this.gateCallbacks.get(gateName)!.add(resolve);
    });
  }

  public getGateStatus(): Readonly<typeof this.gates> {
    return { ...this.gates };
  }

  public isIndexedDBReady(): boolean {
    return this.gates.idbReady;
  }

  // Phase 6C: Room stats support
  private updateRoomStats(stats: RoomStats | null): void {
    this.roomStats = stats;

    // Notify subscribers
    this.statsSubscribers.forEach((cb) => cb(stats));

    // Update read-only state if needed
    if (stats && stats.bytes >= ROOM_CONFIG.ROOM_SIZE_READONLY_BYTES) {
      // Room is read-only due to size
      console.warn('[RoomDocManager] Room is read-only due to size limit');
    }
  }

  // Public method for external updates (e.g., from TanStack Query)
  public setRoomStats(stats: RoomStats | null): void {
    if (this.destroyed) return;
    this.updateRoomStats(stats);
  }

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
    console.log('[RoomDocManager] buildSnapshot: Building new snapshot');
    // Get current state vector for svKey
    const stateVector = Y.encodeStateVector(this.ydoc);
    // CRITICAL: Use safe encoding to avoid stack overflow on large state vectors
    // Create a hash-like key from first 100 bytes + length for uniqueness
    // This is sufficient for cosmetic cache invalidation purposes
    const svKey = this.createSafeStateVectorKey(stateVector);

    // Use helper to get current scene
    const currentScene = this.getCurrentScene();
    console.log(`[RoomDocManager] buildSnapshot: currentScene=${currentScene}`);
    // Building snapshot with currentScene

    // Build stroke views using helper (filter by current scene)
    const allStrokes = this.getStrokes().toArray();
    console.log(`[RoomDocManager] buildSnapshot: Total strokes=${allStrokes.length}`);
    const strokes = allStrokes
      .filter((s) => {
        const match = s.scene === currentScene;
        if (!match) {
          console.log(`[RoomDocManager] Filtering out stroke ${s.id} (scene=${s.scene}, currentScene=${currentScene})`);
        }
        return match;
      })
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
        size: t.size, // Flattened for simpler access
        scene: t.scene, // Include scene field (assigned at commit time, used for filtering)
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

    // Check if svKey changed to track first doc-derived snapshot
    if (snapshot.svKey !== this.publishState.lastSvKey) {
      // CRITICAL: This is the ONLY place where G_FIRST_SNAPSHOT opens
      // Opens when first doc-derived snapshot publishes (≤ 1 rAF after any Y update)
      if (!this.gates.firstSnapshot && snapshot.svKey !== '') {
        this.openGate('firstSnapshot');
        console.debug('[RoomDocManager] First doc-derived snapshot published');
      }
    }

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
      this.statsSubscribers.forEach((cb) => cb(this.roomStats));
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
   * @deprecated MVP: not used by Phase 6. Do not call from app UI.
   */
  async storeRenderCache(canvas: HTMLCanvasElement): Promise<void> {
    if (process.env.NODE_ENV === 'production') {
      // MVP pivot: splash/render-cache paths are disabled in prod
      return Promise.resolve();
    }
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
   * @deprecated MVP: not used by Phase 6. Do not call from app UI.
   */
  async showBootSplash(targetElement: HTMLElement): Promise<(() => void) | null> {
    if (process.env.NODE_ENV === 'production') {
      // MVP pivot: splash/render-cache paths are disabled in prod
      return Promise.resolve(null);
    }
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
   * @deprecated MVP: not used by Phase 6. Do not call from app UI.
   */
  async clearRenderCache(): Promise<void> {
    if (process.env.NODE_ENV === 'production') {
      // MVP pivot: splash/render-cache paths are disabled in prod
      return Promise.resolve();
    }
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
  private refCounts = new Map<RoomId, number>();
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
   * @deprecated Use acquire() instead for proper reference counting
   */
  get(roomId: RoomId, options?: RoomDocManagerOptions): IRoomDocManager {
    // For backward compatibility, delegate to acquire
    // But don't increment ref count (maintains old behavior for tests)
    let manager = this.managers.get(roomId);

    if (!manager) {
      // eslint-disable-next-line no-console
      console.log('[Registry] Creating new RoomDocManager for:', roomId);
      // Use provided options, fall back to default options, or use browser defaults
      const finalOptions = options ?? this.defaultOptions;
      manager = new RoomDocManagerImpl(roomId, finalOptions);
      this.managers.set(roomId, manager);
      // Don't set ref count for backward compatibility with tests
    }

    return manager;
  }

  /**
   * Acquire a reference to a manager for a room
   * Creates the manager if it doesn't exist, increments reference count
   * Must be paired with release() when done
   */
  acquire(roomId: RoomId, options?: RoomDocManagerOptions): IRoomDocManager {
    let manager = this.managers.get(roomId);

    if (!manager) {
      // eslint-disable-next-line no-console
      console.log('[Registry] Creating new RoomDocManager for:', roomId);
      const finalOptions = options ?? this.defaultOptions;
      manager = new RoomDocManagerImpl(roomId, finalOptions);
      this.managers.set(roomId, manager);
      this.refCounts.set(roomId, 0);
    }

    // Increment reference count
    const currentCount = this.refCounts.get(roomId) || 0;
    this.refCounts.set(roomId, currentCount + 1);
    // eslint-disable-next-line no-console
    console.log(`[Registry] Acquired reference for ${roomId}, refCount: ${currentCount + 1}`);

    return manager;
  }

  /**
   * Release a reference to a manager
   * Decrements reference count and destroys manager if count reaches 0
   */
  release(roomId: RoomId): void {
    const count = this.refCounts.get(roomId);
    if (count === undefined) {
      // If no refcount, this manager was created with legacy get() method
      // Don't do anything to maintain backward compatibility
      return;
    }

    const newCount = count - 1;
    // eslint-disable-next-line no-console
    console.log(`[Registry] Released reference for ${roomId}, refCount: ${newCount}`);

    if (newCount <= 0) {
      // Reference count reached 0, destroy and remove
      const manager = this.managers.get(roomId);
      if (manager) {
        // eslint-disable-next-line no-console
        console.log(`[Registry] Destroying RoomDocManager for ${roomId} (refCount: 0)`);
        manager.destroy();
      }
      this.managers.delete(roomId);
      this.refCounts.delete(roomId);
    } else {
      this.refCounts.set(roomId, newCount);
    }
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

  /**
   * Get the reference count for a room (for debugging/testing)
   */
  getRefCount(roomId: RoomId): number {
    return this.refCounts.get(roomId) || 0;
  }

  remove(roomId: RoomId): void {
    const manager = this.managers.get(roomId);
    if (manager) {
      // eslint-disable-next-line no-console
      console.log('[Registry] Removing RoomDocManager for:', roomId);
      manager.destroy();
      this.managers.delete(roomId);
      this.refCounts.delete(roomId);
    }
  }

  /**
   * Destroy all managers and clear the registry
   * Used for cleanup in tests and app teardown
   * AUDIT NOTE: Simple forEach is sufficient - no inter-manager dependencies exist
   * If future phases add inter-dependencies, implement topological sort
   */
  destroyAll(): void {
    // eslint-disable-next-line no-console
    console.log('[Registry] Destroying all RoomDocManagers');
    this.managers.forEach((manager) => manager.destroy());
    this.managers.clear();
    this.refCounts.clear();
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
  attachDocObserver:
    process.env.NODE_ENV === 'test'
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
      : null,
};
