/**
 * RoomDocManager - Central authority for Y.Doc and real-time collaboration
 *
 * ERROR BOUNDARY RECOMMENDATIONS (Phase 3+):
 * - Y.js operations rarely throw (CRDTs are designed for consistency)
 * - Critical error boundaries needed at:
 *   1. IndexedDB attach/open (Phase 6) - handle quota/corruption errors
 *   2. WebSocket connect/sync (Phase 6) - handle network failures
 *   3. WebRTC bring-up (Phase 17) - handle ICE/signaling failures
 * - React error boundary at app level for UI protection
 * - Current Phase 2 is resilient without explicit boundaries
 */

import * as Y from 'yjs';
import { IndexeddbPersistence } from 'y-indexeddb';
import { WebsocketProvider } from 'y-websocket';
import { Awareness as YAwareness } from 'y-protocols/awareness';
import {
  createEmptySnapshot, // Regular import, not type import - function needs to be callable
  ROOM_CONFIG,
  TEXT_CONFIG,
  AWARENESS_CONFIG,
  ulid,
} from '@avlo/shared';
import { clientConfig } from './config-schema';
import { RollingGzipEstimator, GzipImpl } from './size-estimator';
import { generateUserProfile, UserProfile } from './user-identity';
import { clearCursorTrails } from '@/renderer/layers/presence-cursors';
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

  // Phase 6A: Gate status methods
  getGateStatus(): Readonly<{
    idbReady: boolean;
    wsConnected: boolean;
    wsSynced: boolean;
    awarenessReady: boolean;
    firstSnapshot: boolean;
  }>;
  isIndexedDBReady(): boolean;

  // Phase 7: Event-driven gate subscription
  subscribeGates(
    cb: (
      gates: Readonly<{
        idbReady: boolean;
        wsConnected: boolean;
        wsSynced: boolean;
        awarenessReady: boolean;
        firstSnapshot: boolean;
      }>,
    ) => void,
  ): Unsub;

  // Phase 6C: Room stats support
  /**
   * Update room stats from external sources (e.g., metadata polling)
   * This is used by TanStack Query hooks to update stats from HTTP metadata
   */
  setRoomStats(stats: RoomStats | null): void;

  // Phase 7: Awareness API
  updateCursor(worldX: number | undefined, worldY: number | undefined): void;
  updateActivity(activity: 'idle' | 'drawing' | 'typing'): void;
}

// Extended options for RoomDocManager
export interface RoomDocManagerOptions extends TimingOptions {
  gzipImpl?: GzipImpl;
}

// Interpolation types for cursor smoothing
type Pt = { x: number; y: number; t: number };

interface PeerSmoothing {
  lastSeq: number; // last accepted seq from that sender

  // Inputs (from awareness):
  prev?: Pt; // previous accepted sample (post-quantize)
  last?: Pt; // latest accepted sample (post-quantize)
  hasCursor: boolean; // whether the latest awareness advertises a cursor

  // Animation state (for lerp between displayStart -> last)
  displayStart?: Pt; // position we started lerping from
  animStartMs?: number; // when lerp starts
  animEndMs?: number; // when lerp should finish
}

// Interpolation constants
const INTERP_WINDOW_MS = 66; // ~1–2 frames @60 FPS
const CURSOR_Q_STEP = 0.5; // world-unit quantization (matches sender)

// Private implementation
class RoomDocManagerImpl implements IRoomDocManager {
  // Core properties
  private readonly roomId: RoomId;
  private readonly ydoc: Y.Doc;
  private readonly userId: string; // Session user ID for undo/redo origin
  private userProfile: UserProfile; // User name and color for awareness
  // NOTE: No cached Y structure references - all access via helper methods

  // Providers (will be null initially, added in later phases)
  private indexeddbProvider: IndexeddbPersistence | null = null;
  private websocketProvider: WebsocketProvider | null = null;
  private webrtcProvider: unknown = null;

  // Awareness instance (aliased to avoid collision with app's Awareness interface)
  private yAwareness?: YAwareness;

  // Current state
  private _currentSnapshot: Snapshot;

  // Subscription management
  private snapshotSubscribers = new Set<(snap: Snapshot) => void>();
  private presenceSubscribers = new Set<(p: PresenceView) => void>();
  private statsSubscribers = new Set<(s: RoomStats | null) => void>();
  private gateSubscribers = new Set<(gates: Readonly<typeof this.gates>) => void>();

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

  // Document version tracking (replaces svKey)
  private docVersion = 0; // Increments on every Y.Doc update
  private sawAnyDocUpdate = false; // Tracks if we've seen any doc updates

  // Awareness state tracking (Phase 7)
  private localActivity: 'idle' | 'drawing' | 'typing' = 'idle';
  private awarenessIsDirty = false;

  // Backpressure fields for awareness
  private localCursor: { x: number; y: number } | undefined = undefined;
  private awarenessSeq = 0;
  private awarenessSendTimer: number | null = null;
  private awarenessSkipCount = 0;
  private awarenessSendRate = AWARENESS_CONFIG.AWARENESS_HZ_BASE_WS;
  private lastSentAwareness: {
    cursor?: { x: number; y: number };
    activity: string;
    name: string;
    color: string;
  } | null = null;

  // Cursor interpolation fields (Phase 7 - interpolation)
  private peerSmoothers = new Map<string, PeerSmoothing>();
  private presenceAnimDeadlineMs = 0;

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

  // Gate subscription state for debouncing
  private lastGateState: typeof this.gates | null = null;
  private gateDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  // Awareness event handler storage for cleanup
  private _onAwarenessUpdate: ((event: any) => void) | null = null;
  private _onWebSocketStatus: ((event: { status: string }) => void) | null = null;

  constructor(roomId: RoomId, options?: RoomDocManagerOptions) {
    console.log(`[RoomDocManagerImpl Constructor] Creating new instance for roomId: ${roomId}`);
    this.roomId = roomId;
    this.userId = ulid(); // User ID for this session

    // Generate random user profile per tab
    this.userProfile = generateUserProfile();

    // Initialize Y.Doc with room GUID
    this.ydoc = new Y.Doc({ guid: roomId });

    // Create awareness instance bound to this doc
    this.yAwareness = new YAwareness(this.ydoc);

    // Mark awareness as dirty to trigger initial send when gate opens
    // Don't send immediately - wait for awareness gate to open
    if (this.yAwareness) {
      // Store initial values but don't send yet
      this.localActivity = 'idle';
      this.awarenessIsDirty = true;
      // The actual send will happen when G_AWARENESS_READY opens
      // via the WebSocket status handler
    }

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
    };

    // Start with empty snapshot
    this._currentSnapshot = createEmptySnapshot();

    // Setup observers (must be before IDB to catch updates)
    this.setupObservers();

    // Initialize throttled presence updates (30Hz = ~33ms)
    const presenceThrottle = this.throttle(
      this.updatePresence.bind(this),
      33, // 1000ms / 30Hz = ~33ms
    );
    this.updatePresenceThrottled = presenceThrottle.throttled;
    this.updatePresenceThrottledCleanup = presenceThrottle.cleanup;

    // CRITICAL FIX: Attach IDB FIRST before creating any structures
    // This prevents race condition where fresh containers overwrite persisted ones
    this.initializeIndexedDBProvider();

    // Initialize WebSocket provider (Phase 6C)
    this.initializeWebSocketProvider();

    // Seed only after IDB is ready *and* we've given WS a brief chance to sync.
    // This avoids a peer joining a fresh room and locally seeding just before WS
    // delivers the authoritative (possibly non-empty) doc.
    this.whenGateOpen('idbReady').then(async () => {
      await Promise.race([
        this.whenGateOpen('wsSynced'),
        this.delay(350), // ~1–2 frames; prevents cross-tab fresh-room races
      ]);

      const root = this.ydoc.getMap('root');
      if (!root.has('meta')) {
        console.log(`[RoomDocManager] Seeding structures for new room: ${this.roomId}`);
        this.initializeYjsStructures();
      } else {
        console.log(`[RoomDocManager] Room ${this.roomId} already has structures from IDB/WS`);
        this.logContainerIdentities('LOADED_FROM_IDB_OR_WS');
      }
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
    // AUDIT NOTE: Scene can never be negative by construction (array.length is always >= 0)
    // Empty filtered stroke/text arrays are handled correctly by renderers
    const scene = sceneTicks.length;
    // Scene determined from scene ticks length
    return scene;
  }

  // Ingest awareness updates with seq-based ordering
  private ingestAwareness(userId: string, state: any, now: number): void {
    let ps = this.peerSmoothers.get(userId);
    if (!ps) {
      ps = { hasCursor: false, lastSeq: -1 };
      this.peerSmoothers.set(userId, ps);
    }

    const seq: number | undefined = state.seq;
    const c = state.cursor as { x: number; y: number } | undefined;

    // Handle removal / no cursor
    if (!c) {
      ps.hasCursor = false;
      ps.prev = ps.last = ps.displayStart = undefined;
      ps.animStartMs = ps.animEndMs = undefined;
      return;
    }

    // Drop stale or duplicate frames
    if (typeof seq === 'number' && seq <= ps.lastSeq) return;

    // Quantize once at ingest (match sender)
    const q = (v: number) => Math.round(v / CURSOR_Q_STEP) * CURSOR_Q_STEP;
    const nx = q(c.x);
    const ny = q(c.y);

    const hadLast = !!ps.last;
    if (hadLast) ps.prev = ps.last;
    ps.last = { x: nx, y: ny, t: now };
    ps.hasCursor = true;

    // Gap detection
    const gap = typeof seq === 'number' && ps.lastSeq >= 0 && seq > ps.lastSeq + 1;

    // Animation policy:
    // - if first sample, or gap>0 → snap (no lerp)
    // - else start a short lerp window
    if (!hadLast || gap) {
      ps.displayStart = undefined;
      ps.animStartMs = undefined;
      ps.animEndMs = undefined;
    } else {
      ps.displayStart = undefined; // set lazily on first publish in window
      ps.animStartMs = now;
      ps.animEndMs = now + INTERP_WINDOW_MS;
      this.presenceAnimDeadlineMs = Math.max(this.presenceAnimDeadlineMs, ps.animEndMs);
    }

    if (typeof seq === 'number') ps.lastSeq = seq;
  }

  // Get smoothed display cursor position
  private getDisplayCursor(ps: PeerSmoothing, now: number): { x: number; y: number } | undefined {
    if (!ps.hasCursor || !ps.last) return undefined;

    // Inside the lerp window
    if (ps.animStartMs !== undefined && ps.animEndMs !== undefined && now < ps.animEndMs) {
      if (!ps.displayStart) {
        const s = ps.prev ?? ps.last;
        ps.displayStart = { x: s.x, y: s.y, t: now };
      }
      const u = Math.max(0, Math.min(1, (now - ps.animStartMs) / (ps.animEndMs - ps.animStartMs)));
      const x = ps.displayStart.x + (ps.last.x - ps.displayStart.x) * u;
      const y = ps.displayStart.y + (ps.last.y - ps.displayStart.y) * u;
      return { x, y };
    }

    // No active animation → just show the last accepted target
    return { x: ps.last.x, y: ps.last.y };
  }

  // Build presence view from awareness
  private buildPresenceView(): PresenceView {
    const now = this.clock.now();
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

    if (this.yAwareness) {
      this.yAwareness.getStates().forEach((state) => {
        if (state.userId && state.userId !== this.userId) {
          // Get or create smoother for this peer
          let ps = this.peerSmoothers.get(state.userId);
          if (!ps) {
            ps = { hasCursor: false, lastSeq: -1 };
            this.peerSmoothers.set(state.userId, ps);
          }

          // Get smoothed cursor position
          const displayCursor = this.getDisplayCursor(ps, now);

          users.set(state.userId, {
            name: state.name || 'Anonymous',
            color: state.color || '#808080',
            cursor: displayCursor,
            activity: state.activity || 'idle',
            // Use the timestamp from the remote state if available
            lastSeen: typeof state.ts === 'number' ? state.ts : Date.now(),
          });
        }
      });
    }

    return {
      users,
      localUserId: this.userId,
    };
  }

  // Awareness sending with backpressure
  private scheduleAwarenessSend(): void {
    // Only schedule if not already scheduled and we have changes to send
    if (this.awarenessSendTimer !== null || !this.awarenessIsDirty) return;

    // Calculate interval with degradation
    const baseInterval = 1000 / this.awarenessSendRate;
    const jitter = (Math.random() - 0.5) * 20; // ±10ms jitter
    const interval = Math.max(75, Math.min(150, baseInterval + jitter));

    this.awarenessSendTimer = window.setTimeout(() => {
      this.awarenessSendTimer = null;
      this.sendAwareness();
    }, interval);
  }

  private sendAwareness(): void {
    // Check if gate is closed (offline) - remain dirty and retry
    if (!this.gates.awarenessReady) {
      // Keep dirty flag and reschedule to try again when online
      this.scheduleAwarenessSend();
      return;
    }

    // Only send if we have changes (implements "no pings" policy)
    if (!this.awarenessIsDirty) {
      return;
    }

    // Check provider availability - remain dirty and retry
    if (!this.yAwareness || !this.websocketProvider) {
      this.scheduleAwarenessSend();
      return;
    }

    // Check if actual state changed (not just seq/ts)
    const currentState = {
      cursor: this.localCursor,
      activity: this.localActivity,
      name: this.userProfile.name,
      color: this.userProfile.color,
    };

    // Compare with last sent state (shallow compare of meaningful fields)
    if (this.lastSentAwareness) {
      const cursorSame =
        (!currentState.cursor && !this.lastSentAwareness.cursor) ||
        (currentState.cursor &&
          this.lastSentAwareness.cursor &&
          currentState.cursor.x === this.lastSentAwareness.cursor.x &&
          currentState.cursor.y === this.lastSentAwareness.cursor.y);

      const otherSame =
        currentState.activity === this.lastSentAwareness.activity &&
        currentState.name === this.lastSentAwareness.name &&
        currentState.color === this.lastSentAwareness.color;

      if (cursorSame && otherSame) {
        // Nothing actually changed, clear dirty flag and return (no reschedule needed)
        this.awarenessIsDirty = false;
        return;
      }
    }

    // Best-effort backpressure check - only skip if we can successfully read bufferedAmount AND it's high
    let shouldSkipDueToBackpressure = false;
    try {
      const ws: WebSocket | undefined = (this.websocketProvider as any)?.ws;
      if (ws && ws.readyState === WebSocket.OPEN) {
        const bufferedAmount = ws.bufferedAmount ?? 0;
        if (bufferedAmount > AWARENESS_CONFIG.WEBSOCKET_BUFFER_HIGH_BYTES) {
          shouldSkipDueToBackpressure = true;
          this.awarenessSkipCount++;

          // If critical, degrade send rate
          if (bufferedAmount > AWARENESS_CONFIG.WEBSOCKET_BUFFER_CRITICAL_BYTES) {
            this.awarenessSendRate = AWARENESS_CONFIG.AWARENESS_HZ_DEGRADED;
          }
        } else if (this.awarenessSendRate < AWARENESS_CONFIG.AWARENESS_HZ_BASE_WS) {
          // Buffer recovered, restore rate
          this.awarenessSendRate = AWARENESS_CONFIG.AWARENESS_HZ_BASE_WS;
        }
      }
      // If ws is missing or not OPEN, do NOT treat as fatal - proceed to send
    } catch {
      // Swallow exception - proceed to send normally
    }

    // Only skip if we successfully detected high buffer
    if (shouldSkipDueToBackpressure) {
      // Stay dirty AND schedule the next attempt
      this.scheduleAwarenessSend();
      return;
    }

    // Check if mobile device
    const isMobile = /Mobi|Android/i.test(navigator.userAgent) || navigator.maxTouchPoints > 1;

    // Actually send awareness (only increment seq when we really send)
    // Future RTC: seq provides total ordering across WS+RTC channels - prevents duplicates/jitter
    this.awarenessSeq++;
    this.yAwareness.setLocalState({
      userId: this.userId, // Use existing per-tab userId
      name: this.userProfile.name,
      color: this.userProfile.color,
      cursor: isMobile ? undefined : this.localCursor, // No cursor on mobile
      activity: isMobile ? 'idle' : this.localActivity, // Always idle on mobile
      seq: this.awarenessSeq,
      ts: Date.now(),
      aw_v: 1,
    });

    // Update last sent state and clear dirty flag
    this.lastSentAwareness = { ...currentState };
    this.awarenessIsDirty = false;
  }

  // Public API for updating cursor
  public updateCursor(worldX: number | undefined, worldY: number | undefined): void {
    // Apply 0.5 world-unit quantization to prevent sub-pixel jitter
    const quantize = (v: number): number => Math.round(v / 0.5) * 0.5;

    const newCursor =
      worldX !== undefined && worldY !== undefined
        ? { x: quantize(worldX), y: quantize(worldY) }
        : undefined;

    // Check if cursor actually changed (now comparing quantized values)
    const cursorChanged =
      (!this.localCursor && newCursor) ||
      (this.localCursor && !newCursor) ||
      (this.localCursor &&
        newCursor &&
        (this.localCursor.x !== newCursor.x || this.localCursor.y !== newCursor.y));

    if (cursorChanged) {
      this.localCursor = newCursor;
      this.awarenessIsDirty = true;

      // Only schedule send if gate is open
      // If offline, the dirty flag remains set and will trigger send on reconnect
      if (this.gates.awarenessReady) {
        this.scheduleAwarenessSend();
      }
    }
  }

  // Public API for updating activity
  public updateActivity(activity: 'idle' | 'drawing' | 'typing'): void {
    if (this.localActivity !== activity) {
      this.localActivity = activity;
      this.awarenessIsDirty = true;

      // Only schedule send if gate is open
      // If offline, the dirty flag remains set and will trigger send on reconnect
      if (this.gates.awarenessReady) {
        this.scheduleAwarenessSend();
      }
    }
  }

  // Tiny helper to await a timeout (used for the WS-sync grace window)
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
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
    console.log(`[RoomDocManager] initializeYjsStructures running for room: ${this.roomId}`);

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
    }, 'init-structures'); // Origin for debugging

    // Log container identities right after initialization
    this.logContainerIdentities('AFTER_INIT');
  }

  // Helper to log container identities for debugging
  private logContainerIdentities(phase: string): void {
    const root = this.ydoc.getMap('root');
    const strokes = root.get('strokes');
    const meta = root.get('meta');
    const sceneTicks = meta instanceof Y.Map ? meta.get('scene_ticks') : null;

    // Create stable identifiers using object reference + type
    const strokesId = strokes
      ? `${(strokes as any)._item?.id?.clock || 'unknown'}-${strokes.constructor.name}`
      : 'null';
    const metaId = meta
      ? `${(meta as any)._item?.id?.clock || 'unknown'}-${meta.constructor.name}`
      : 'null';
    const ticksId = sceneTicks
      ? `${(sceneTicks as any)._item?.id?.clock || 'unknown'}-${sceneTicks.constructor.name}`
      : 'null';

    console.log(`[Container Identity - ${phase}] room: ${this.roomId}`);
    console.log(
      `  strokes: ${strokesId}, length: ${strokes instanceof Y.Array ? strokes.length : 'N/A'}`,
    );
    console.log(`  meta: ${metaId}`);
    console.log(
      `  scene_ticks: ${ticksId}, length: ${sceneTicks instanceof Y.Array ? sceneTicks.length : 'N/A'}`,
    );
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
    // Return no-op if destroyed
    if (this.destroyed) {
      return () => {};
    }

    this.snapshotSubscribers.add(cb);
    // Immediately call with current snapshot
    cb(this._currentSnapshot);

    return () => {
      this.snapshotSubscribers.delete(cb);
    };
  }

  subscribePresence(cb: (p: PresenceView) => void): Unsub {
    // Return no-op if destroyed
    if (this.destroyed) {
      return () => {};
    }

    this.presenceSubscribers.add(cb);
    // Immediately call with current presence
    cb(this._currentSnapshot.presence);

    return () => {
      this.presenceSubscribers.delete(cb);
    };
  }

  subscribeRoomStats(cb: (s: RoomStats | null) => void): Unsub {
    // Return no-op if destroyed
    if (this.destroyed) {
      return () => {};
    }

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

  subscribeGates(cb: (gates: Readonly<typeof this.gates>) => void): Unsub {
    // Return no-op if destroyed
    if (this.destroyed) {
      return () => {};
    }

    this.gateSubscribers.add(cb);
    // Immediately call with current gate status
    cb(this.getGateStatus());

    return () => {
      this.gateSubscribers.delete(cb);
    };
  }

  // Simple mutate method with minimal guards
  mutate(fn: (ydoc: Y.Doc) => void): void {
    // Check if destroyed first
    if (this.destroyed) return;

    // Pre-init guard: before IDB hydration or seeding, don't create containers via writes.
    // This prevents the race condition where writes could create fresh containers that
    // compete with persisted ones from IDB or WS. Once 'meta' exists, structures are initialized.
    const root = this.ydoc.getMap('root');
    if (!root.has('meta')) {
      // Defer writes until either (a) WS syncs, or (b) a short grace elapses after IDB.
      this.whenGateOpen('idbReady').then(async () => {
        await Promise.race([this.whenGateOpen('wsSynced'), this.delay(350)]);
        const r = this.ydoc.getMap('root');
        if (!r.has('meta')) {
          // Truly fresh doc even after IDB + grace → seed once.
          this.initializeYjsStructures();
        }
        this.mutate(fn); // replay the write
      });
      return;
    }

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

  // Helper to ensure RAF loop is running (only restarts if stopped)
  private schedulePublish(): void {
    // Only restart if the loop is truly stopped (e.g., after destroy/recreate)
    if (this.publishState.rafId === -1 && !this.destroyed) {
      this.publishState.isDirty = true; // ensure first tick publishes
      this.startPublishLoop();
    }
    // If loop is already running, it will pick up dirty flags on next tick
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
    // Check if destroyed first
    if (this.destroyed) return;

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
    // Check if already destroyed (makes it safe to call multiple times)
    if (this.destroyed) return;

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

    // Clear gate debounce timer
    if (this.gateDebounceTimer) {
      clearTimeout(this.gateDebounceTimer);
      this.gateDebounceTimer = null;
    }

    // Clear awareness timer and dirty flag
    if (this.awarenessSendTimer !== null) {
      clearTimeout(this.awarenessSendTimer);
      this.awarenessSendTimer = null;
    }
    this.awarenessIsDirty = false;

    // Clear cursor trails to prevent memory leaks and cross-room contamination
    clearCursorTrails();

    // Cleanup providers (Phase 6A additions)
    if (this.indexeddbProvider) {
      this.indexeddbProvider.destroy();
      this.indexeddbProvider = null;
    }

    // Cleanup WebSocket status listener
    if (this.websocketProvider && this._onWebSocketStatus) {
      try {
        (this.websocketProvider as any).off?.('status', this._onWebSocketStatus);
      } catch {
        // Ignore errors during cleanup
      }
      this._onWebSocketStatus = null;
    }

    if (this.websocketProvider) {
      // Proper cleanup: disconnect first, then destroy
      this.websocketProvider.disconnect();
      this.websocketProvider.destroy();
      this.websocketProvider = null;
    }

    // Cleanup awareness defensively
    if (this.yAwareness) {
      // Signal departure by setting local state to null
      try {
        this.yAwareness.setLocalState(null);
      } catch {
        // Ignore errors during cleanup
      }

      // Unregister event listeners (if the off method exists)
      if (this._onAwarenessUpdate) {
        try {
          (this.yAwareness as any).off?.('update', this._onAwarenessUpdate);
        } catch {
          // Ignore errors during cleanup
        }
        this._onAwarenessUpdate = null;
      }

      // Call destroy if it exists
      try {
        if (typeof (this.yAwareness as any).destroy === 'function') {
          (this.yAwareness as any).destroy();
        }
      } catch {
        // Ignore errors during cleanup
      }

      this.yAwareness = undefined;
    }

    // Remove Y.Doc observers
    // NOTE: This correctly removes the listener because handleYDocUpdate
    // is an arrow function property with stable identity (see setupObservers)
    this.ydoc.off('update', this.handleYDocUpdate);

    // Clear subscriptions
    this.snapshotSubscribers.clear();
    this.presenceSubscribers.clear();
    this.statsSubscribers.clear();
    this.gateSubscribers.clear();

    // Clear cursor interpolation state
    this.peerSmoothers.clear();
    this.presenceAnimDeadlineMs = 0;

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

  // Simple RAF loop for publishing
  private startPublishLoop(): void {
    const rafLoop = () => {
      // Keep publishing during presence animation window
      const now = this.clock.now();
      if (!this.publishState.presenceDirty && now < this.presenceAnimDeadlineMs) {
        // Force a presence publish to progress the interpolation
        this.publishState.presenceDirty = true;
      }

      // Option B-prime: Handle doc vs presence-only updates separately
      if (this.publishState.isDirty) {
        // Document changed - build full snapshot (expensive)
        const startTime = this.clock.now();
        const newSnapshot = this.buildSnapshot();
        this.publishSnapshot(newSnapshot);
        this.publishState.isDirty = false;
        this.publishState.presenceDirty = false; // Clear both flags

        // Track timing for metrics
        this.publishState.lastPublishTime = this.clock.now();
        this.publishState.publishCostMs = this.clock.now() - startTime;
      } else if (this.publishState.presenceDirty) {
        // Presence-only update - reuse last snapshot (cheap!)
        const startTime = this.clock.now();
        const livePresence = this.buildPresenceView();
        const prev = this._currentSnapshot;

        // Construct a fresh object so identity changes
        const snap: Snapshot = {
          ...prev,                // reuses already-frozen arrays & fields
          presence: livePresence, // new presence
          createdAt: Date.now(),  // fresh timestamp
        };

        // Dev parity with buildSnapshot(): freeze the top-level object
        if (typeof process !== 'undefined' && process.env?.NODE_ENV === 'development') {
          Object.freeze(snap);
        }

        this.publishSnapshot(snap); // sets current + notifies subscribers
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
      this.ydoc.on('afterTransaction', (_transaction: Y.Transaction) => {
        // Transaction origin tracked
      });
    }
  }

  // Arrow function property ensures stable reference for event listener cleanup
  // This is NOT a memory leak - the same function reference is used for on() and off()
  private handleYDocUpdate = (update: Uint8Array, origin: unknown): void => {
    // Log transaction origin to track IDB vs local updates
    const originStr =
      typeof origin === 'string'
        ? origin
        : origin === this.indexeddbProvider
          ? 'IDB_PROVIDER'
          : origin === this.websocketProvider
            ? 'WS_PROVIDER'
            : origin
              ? (origin as any).constructor?.name || 'unknown'
              : 'null';

    console.log(
      `[Transaction Origin] room: ${this.roomId}, origin: ${originStr}, update size: ${update.byteLength}`,
    );

    // If this is from IDB, check if container identities changed
    if (origin === this.indexeddbProvider || originStr === 'IDB_PROVIDER') {
      console.log('[Transaction] IDB update detected, checking for container changes...');
      this.logContainerIdentities('DURING_IDB_UPDATE');
    }

    // Increment docVersion on ANY Y.Doc change
    this.docVersion = (this.docVersion + 1) >>> 0; // Use unsigned 32-bit int
    this.sawAnyDocUpdate = true; // We've now seen real doc data

    // Y.Doc updated
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
      console.log(`[RoomDocManager] Creating IndexedDB with name: ${dbName}`);
      this.indexeddbProvider = new IndexeddbPersistence(dbName, this.ydoc);

      // Set up IDB gate with 2s timeout
      const timeoutId = setTimeout(() => {
        console.log(
          `[RoomDocManager] IDB timeout reached for room: ${this.roomId}, proceeding with empty doc`,
        );
        this.handleIDBReady(); // Use unified handler
      }, 2000);
      this.gateTimeouts.set('idbReady', timeoutId);

      // Listen for IDB sync completion for gate control
      this.indexeddbProvider.whenSynced
        .then(() => {
          console.log(
            `[RoomDocManager] IndexedDB whenSynced resolved for room: ${this.roomId}, dbName: avlo.v1.rooms.${this.roomId}`,
          );
          this.handleIDBReady(); // Use unified handler
        })
        .catch((err: unknown) => {
          console.warn('[RoomDocManager] IDB sync error (non-critical):', err);
          // Still open gate on error - fallback to empty doc
          this.handleIDBReady(); // Use unified handler
        });

      // Note: No need to listen for 'synced' event to mark dirty
      // Y.Doc updates from IDB will trigger the existing doc update handler
    } catch (err: unknown) {
      console.warn('[RoomDocManager] IDB initialization failed (non-critical):', err);
      // Mark as failed but continue
      this.handleIDBReady(); // Use unified handler
    }
  }

  // Centralized handler for IDB ready state - ensures consistent behavior
  private handleIDBReady(): void {
    // Clear any pending timeout
    const timeout = this.gateTimeouts.get('idbReady');
    if (timeout) {
      clearTimeout(timeout);
      this.gateTimeouts.delete('idbReady');
    }

    // Log container identities after IDB is ready (either synced or timed out)
    this.logContainerIdentities('AFTER_IDB_READY');

    // Open the gate - structure initialization is handled in constructor
    // via whenGateOpen('idbReady').then(...)
    this.openGate('idbReady');
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
          // ENABLE AWARENESS
          awareness: this.yAwareness,
          // Reconnect settings
          maxBackoffTime: 10000,
          resyncInterval: 5000,
        },
      );

      // Set up G_WS_CONNECTED gate with 5s timeout
      const wsConnectedTimeout = setTimeout(() => {
        if (!this.gates.wsConnected && this.gates.idbReady) {
          // Proceed offline if IDB ready
          // WS connection timeout, proceeding offline
        }
      }, 5000);
      this.gateTimeouts.set('wsConnected', wsConnectedTimeout);

      // Set up G_WS_SYNCED gate with 10s timeout
      const wsSyncedTimeout = setTimeout(() => {
        if (!this.gates.wsSynced) {
          // Keep rendering from IDB, continue trying to sync
          // WS sync timeout, continuing with local state
        }
      }, 10000);
      this.gateTimeouts.set('wsSynced', wsSyncedTimeout);

      // Store bound handlers for cleanup
      this._onAwarenessUpdate = (event: any) => {
        // Ingest awareness changes with interpolation
        const now = this.clock.now();

        // Process changed states
        if (event && typeof event === 'object') {
          // Handle added/updated states
          const changedClientIds = [
            ...(event.added || []),
            ...(event.updated || []),
            ...(event.removed || []),
          ];

          for (const clientId of changedClientIds) {
            const state = this.yAwareness?.getStates()?.get(clientId);
            if (state && state.userId && state.userId !== this.userId) {
              this.ingestAwareness(state.userId as string, state, now);
            } else if (!state && clientId) {
              // Handle removed peers
              const ps = this.peerSmoothers.get(String(clientId));
              if (ps) {
                ps.hasCursor = false;
                ps.prev = ps.last = ps.displayStart = undefined;
                ps.animStartMs = ps.animEndMs = undefined;
              }
            }
          }
        }

        // Mark presence dirty for next RAF publish
        this.publishState.presenceDirty = true;

        // Trigger throttled presence update for subscribers
        if (this.updatePresenceThrottled) {
          this.updatePresenceThrottled();
        }
      };

      this._onWebSocketStatus = (event: { status: string }) => {
        if (event.status === 'connected') {
          // Handle connection gates
          if (!this.gates.wsConnected) {
            // Clear connection timeout
            const timeout = this.gateTimeouts.get('wsConnected');
            if (timeout) {
              clearTimeout(timeout);
              this.gateTimeouts.delete('wsConnected');
            }
            this.openGate('wsConnected');
          }

          // Open awareness gate immediately on WS connect
          // No need to wait for remote awareness states
          if (!this.gates.awarenessReady) {
            this.openGate('awarenessReady');

            // Mark dirty to trigger initial awareness send on reconnect
            if (this.yAwareness) {
              this.awarenessIsDirty = true;
              this.scheduleAwarenessSend();
            }

            // Also mark presence dirty to ensure initial publish
            this.publishState.presenceDirty = true;
            // No need to call schedulePublish() - the loop is already running
          }
          // WebSocket connected
        } else if (event.status === 'disconnected') {
          // Close connection gates if they're open
          if (this.gates.wsConnected) {
            this.closeGate('wsConnected');
          }
          if (this.gates.wsSynced) {
            this.closeGate('wsSynced');
          }

          // CRITICAL: Close awareness gate on disconnect
          // This ensures cursors hide immediately when offline
          if (this.gates.awarenessReady) {
            this.closeGate('awarenessReady');

            // Clear cursor trails to prevent stale data across sessions
            clearCursorTrails();

            // Mark presence dirty to trigger immediate UI update
            this.publishState.presenceDirty = true;
            // No need to call schedulePublish() - the loop is already running

            // Clear local cursor state
            this.localCursor = undefined;

            // NOTE: We keep awarenessIsDirty true if it was true,
            // and let sendAwareness() handle the retry logic when reconnected.
            // This ensures pending state changes are sent once back online.

            // Force awareness state clear to signal departure to peers
            if (this.yAwareness) {
              try {
                this.yAwareness.setLocalState(null);
              } catch {
                // Ignore errors during awareness cleanup
              }
            }
          }
          // WebSocket disconnected
        }
      };

      // Listen for awareness updates
      if (this.yAwareness && this._onAwarenessUpdate) {
        this.yAwareness.on('update', this._onAwarenessUpdate);
      }

      // Set up connection gates with new handler
      this.websocketProvider.on('status', this._onWebSocketStatus);

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
          // Log identities after the first WS sync to verify origin of containers
          this.logContainerIdentities('AFTER_WS_SYNC');
          // WebSocket synced
        } else {
          this.closeGate('wsSynced');
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
    const wasOpen = this.gates[gateName];
    if (wasOpen) return; // Already open

    this.gates[gateName] = true;

    // Force presence publish when both gates are open for the first time
    // The RAF loop is already running from constructor, so just mark dirty
    if (!wasOpen && gateName === 'firstSnapshot' && this.gates.awarenessReady) {
      this.publishState.presenceDirty = true;
      // No need to call schedulePublish() - the loop is already running
    }
    // Similar check if awarenessReady opens after firstSnapshot
    if (!wasOpen && gateName === 'awarenessReady' && this.gates.firstSnapshot) {
      this.publishState.presenceDirty = true;
      // No need to call schedulePublish() - the loop is already running
    }

    // Notify subscribers
    const callbacks = this.gateCallbacks.get(gateName);
    if (callbacks) {
      callbacks.forEach((cb) => cb());
      callbacks.clear();
    }

    // Notify gate subscribers about the change
    this.notifyGateChange();

    // Note: G_FIRST_SNAPSHOT opens in buildSnapshot() when first doc-derived snapshot publishes
    // Do NOT open it here based on other gates
  }

  private closeGate(gateName: keyof typeof this.gates): void {
    if (!this.gates[gateName]) return; // Already closed

    this.gates[gateName] = false;

    // Notify gate subscribers about the change
    this.notifyGateChange();
  }

  private notifyGateChange(): void {
    const currentGates = this.getGateStatus();

    // Only notify if gates actually changed (shallow compare)
    if (
      this.lastGateState &&
      this.lastGateState.idbReady === currentGates.idbReady &&
      this.lastGateState.wsConnected === currentGates.wsConnected &&
      this.lastGateState.wsSynced === currentGates.wsSynced &&
      this.lastGateState.awarenessReady === currentGates.awarenessReady &&
      this.lastGateState.firstSnapshot === currentGates.firstSnapshot
    ) {
      return;
    }

    this.lastGateState = { ...currentGates };

    // Debounce notifications by 150ms to prevent flicker
    if (this.gateDebounceTimer) {
      clearTimeout(this.gateDebounceTimer);
    }

    this.gateDebounceTimer = setTimeout(() => {
      this.gateSubscribers.forEach((cb) => {
        try {
          cb(currentGates);
        } catch (err) {
          console.error('Error in gate subscriber:', err);
        }
      });
      this.gateDebounceTimer = null;
    }, 150);
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
    // Early return if Y.Doc structure is not yet initialized
    // This can happen during the first RAF frame before initializeYjsStructures completes
    const root = this.ydoc.getMap('root');
    if (!root.has('meta')) {
      return this._currentSnapshot; // Return current (empty) snapshot
    }

    // Building new snapshot

    // Use helper to get current scene
    const currentScene = this.getCurrentScene();
    // Current scene determined
    // Building snapshot with currentScene

    // Build stroke views using helper (filter by current scene)
    const allStrokes = this.getStrokes().toArray();
    // Processing strokes
    const strokes = allStrokes
      .filter((s) => {
        const match = s.scene === currentScene;
        if (!match) {
          // Filtering stroke by scene
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

    // Deferred for now
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
      docVersion: this.docVersion, // Use docVersion instead of svKey
      scene: currentScene,
      strokes: Object.freeze(strokes) as ReadonlyArray<StrokeView>,
      texts: Object.freeze(texts) as ReadonlyArray<TextView>,
      presence,
      spatialIndex,
      view,
      meta,
      createdAt: Date.now(),
    };

    // Open G_FIRST_SNAPSHOT when we've seen any doc updates
    if (!this.gates.firstSnapshot && this.sawAnyDocUpdate) {
      this.openGate('firstSnapshot');
      // First doc-derived snapshot published
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
    console.warn(
      `[Registry] DEPRECATED get() method called for roomId: ${roomId} - should use acquire() instead`,
    );
    // For backward compatibility, delegate to acquire
    // But don't increment ref count (maintains old behavior for tests)
    let manager = this.managers.get(roomId);

    if (!manager) {
      console.log(
        `[Registry] Creating new RoomDocManager via deprecated get() for roomId: ${roomId}`,
      );
      // Creating new RoomDocManager
      // Use provided options, fall back to default options, or use browser defaults
      const finalOptions = options ?? this.defaultOptions;
      manager = new RoomDocManagerImpl(roomId, finalOptions);
      this.managers.set(roomId, manager);
      // Don't set ref count for backward compatibility with tests
    } else {
      console.log(
        `[Registry] Reusing existing RoomDocManager via deprecated get() for roomId: ${roomId}`,
      );
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
      console.log(`[Registry] Creating new RoomDocManager via acquire() for roomId: ${roomId}`);
      // Creating new RoomDocManager
      const finalOptions = options ?? this.defaultOptions;
      manager = new RoomDocManagerImpl(roomId, finalOptions);
      this.managers.set(roomId, manager);
      this.refCounts.set(roomId, 0);
    } else {
      console.log(`[Registry] Reusing existing RoomDocManager via acquire() for roomId: ${roomId}`);
    }

    // Increment reference count
    const currentCount = this.refCounts.get(roomId) || 0;
    this.refCounts.set(roomId, currentCount + 1);
    // Reference acquired

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
    // Reference released

    if (newCount <= 0) {
      // Reference count reached 0, destroy and remove
      const manager = this.managers.get(roomId);
      if (manager) {
        // Destroying RoomDocManager (refCount: 0)
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
      // Removing RoomDocManager
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
    // Destroying all RoomDocManagers
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
