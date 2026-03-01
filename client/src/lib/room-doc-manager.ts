/**
 * RoomDocManager - Central authority for Y.Doc and real-time collaboration
 */

import * as Y from 'yjs';
import { IndexeddbPersistence } from 'y-indexeddb';
import YProvider from 'y-partyserver/provider';
import { Awareness as YAwareness } from 'y-protocols/awareness';
import { createEmptySnapshot, AWARENESS_CONFIG } from '@avlo/shared';
import { UserProfile } from './user-identity';
import { userProfileManager } from './user-profile-manager';
import { clearCursorTrails } from '@/renderer/layers/presence-cursors';
import type { RoomId, Snapshot, PresenceView } from '@avlo/shared';
import { ObjectSpatialIndex } from '@avlo/shared';
import type { ObjectHandle, ObjectKind, DirtyPatch, WorldBounds } from '@avlo/shared';
import { computeBBoxFor, bboxEquals, bboxToBounds } from '@avlo/shared';
import {
  initConnectorLookup,
  hydrateConnectorLookup,
  clearConnectorLookup,
  processConnectorAdded,
  processConnectorUpdated,
  processConnectorDeleted,
  processShapeDeleted,
} from './connectors';
import { getTextProps } from '@avlo/shared';
import { ySyncPluginKey } from '@tiptap/y-tiptap';
import { textLayoutCache, computeTextBBox } from './text/text-system';
import { useSelectionStore } from '@/stores/selection-store';

type Unsub = () => void;

// Type aliases for Y structures
// Use Y.Map<unknown> and cast when accessing specific properties
type YMeta = Y.Map<unknown>;
type YObjects = Y.Map<Y.Map<unknown>>;
// type YCode = Y.Map<unknown>;
// type YOutputs = Y.Array<Output>;

// Manager interface - public API
export interface IRoomDocManager {
  // Snapshot - immutable view of Y.Doc state (no presence)
  readonly currentSnapshot: Snapshot;
  subscribeSnapshot(cb: (snap: Snapshot) => void): Unsub;

  // Presence - separate subscription for cursor/activity updates
  readonly currentPresence: PresenceView;
  subscribePresence(cb: (p: PresenceView) => void): Unsub;

  // Mutations
  mutate(fn: (ydoc: Y.Doc) => void): void;
  destroy(): void;
  undo(): void;
  redo(): void;
  getUndoManager(): Y.UndoManager | null;

  // Gate status methods
  getGateStatus(): Readonly<{
    idbReady: boolean;
    wsConnected: boolean;
    wsSynced: boolean;
    awarenessReady: boolean;
    firstSnapshot: boolean;
  }>;
  isIndexedDBReady(): boolean;

  // Awareness API
  updateCursor(worldX: number | undefined, worldY: number | undefined): void;
  updateActivity(activity: 'idle' | 'drawing' | 'typing'): void;
}

// Options for RoomDocManager (currently empty, but preserved for future use)
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface RoomDocManagerOptions {}

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

// Implementation class (exported for registry use)
export class RoomDocManagerImpl implements IRoomDocManager {
  // Core properties
  private readonly roomId: RoomId;
  private readonly ydoc: Y.Doc;
  private readonly userId: string; // stable userId
  private userProfile: UserProfile; // User name and color for awareness

  // Providers (will be null initially, added in later phases)
  private indexeddbProvider: IndexeddbPersistence | null = null;
  private websocketProvider: YProvider | null = null;

  // Awareness instance (aliased to avoid collision with app's Awareness interface)
  private yAwareness?: YAwareness;

  // Undo/Redo manager
  private undoManager: Y.UndoManager | null = null;

  // Current state
  private _currentSnapshot: Snapshot;

  // Subscription management
  private snapshotSubscribers = new Set<(snap: Snapshot) => void>();
  private presenceSubscribers = new Set<(p: PresenceView) => void>();

  // Presence animation state (RAF is now on-demand, not continuous)
  // Doc changes are event-driven via handleYDocUpdate → publishSnapshotNow()
  private publishState = {
    presenceDirty: false, // Track if presence needs republishing
    rafId: -1, // Presence animation RAF ID (-1 = not scheduled)
  };

  // Track if destroyed for cleanup
  private destroyed = false;

  // Document version tracking
  private docVersion = 0; // Increments on every Y.Doc update
  private sawAnyDocUpdate = false; // Tracks if we've seen any doc updates

  // Awareness state tracking
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

  // Cursor interpolation fields
  private peerSmoothers = new Map<number, PeerSmoothing>(); // Keyed by clientId for proper cleanup
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

  // Awareness event handler storage for cleanup
  private _onAwarenessUpdate: ((event: any) => void) | null = null;
  private _onWebSocketStatus: ((event: { status: string }) => void) | null = null;

  // ============================================================
  // TWO-EPOCH ARCHITECTURE: Minimal State
  // ============================================================

  //  Y.Map-based object storage
  private objectsById = new Map<string, ObjectHandle>();
  private spatialIndex: ObjectSpatialIndex | null = null; // Created ONCE in buildSnapshot
  private dirtyRects: WorldBounds[] = [];
  private cacheEvictIds = new Set<string>();
  private objectsObserver: ((events: Y.YEvent<any>[], tx: Y.Transaction) => void) | null = null;
  private needsSpatialRebuild = true; // Start true, goes false after first hydration

  constructor(roomId: RoomId, _options?: RoomDocManagerOptions) {
    this.roomId = roomId;

    // Get stable identity from singleton
    const identity = userProfileManager.getIdentity();
    this.userId = identity.userId;
    this.userProfile = {
      name: identity.name,
      color: identity.color,
    };

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

    // Initialize presence animation state
    this.publishState = {
      presenceDirty: false,
      rafId: -1,
    };

    // Start with empty snapshot
    this._currentSnapshot = createEmptySnapshot();

    // Setup observers (must be before IDB to catch updates)
    this.setupObservers();
    // NOTE: setupObjectsObserver() will be called after Y.js structures are initialized

    // CRITICAL FIX: Attach IDB FIRST before creating any structures
    this.initializeIndexedDBProvider();
    this.whenGateOpen('idbReady').then(() => {
      const root = this.ydoc.getMap('root');
      if (root.has('meta')) {
        this.setupObjectsObserver();
        this.attachUndoManager();
      }
    });
    // Initialize WebSocket provider
    this.initializeWebSocketProvider();

    // Seed only after IDB is ready *and* we've given WS a brief chance to sync.
    this.whenGateOpen('idbReady').then(async () => {
      await Promise.race([
        this.whenGateOpen('wsSynced'),
        this.delay(5_000), // prevents cross-tab fresh-room races
      ]);

      const root = this.ydoc.getMap('root');
      if (!root.has('meta')) {
        this.initializeYjsStructures();
        this.setupObjectsObserver();
        this.attachUndoManager();
      }

      // Now that structures exist (either from IDB/WS or freshly initialized),
      // it's safe to attach array observers for incremental updates
      this.setupObjectsObserver();
      // Attach UndoManager after observers are set up
      this.attachUndoManager();
    });

    // - Doc changes: event-driven via handleYDocUpdate → publishSnapshotNow()
    // - Presence changes: triggered by awareness updates → triggerPresenceAnimation()
  }

  // Public getters
  get currentSnapshot(): Snapshot {
    return this._currentSnapshot;
  }

  get currentPresence(): PresenceView {
    return this.buildPresenceView();
  }

  private getRoot(): Y.Map<unknown> {
    return this.ydoc.getMap('root');
  }

  private getMeta(): YMeta | undefined {
    const meta = this.getRoot().get('meta');
    if (!(meta instanceof Y.Map)) {
      return undefined;
    }
    return meta as YMeta;
  }

  private getObjects(): YObjects {
    const root = this.getRoot();
    const objects = root.get('objects');
    if (!(objects instanceof Y.Map)) {
      throw new Error('objects map not initialized');
    }
    return objects as YObjects;
  }

  /**
   * Attach UndoManager to track local changes
   * CRITICAL: Only call after Y.Doc structures are initialized
   */
  private attachUndoManager(): void {
    if (this.undoManager) {
      console.warn('[RoomDocManager] UndoManager already attached');
      return;
    }

    const objects = this.getObjects();

    // Track changes to objects map
    // ySyncPluginKey origin captures text fragment edits from ProseMirror sync plugin
    // (only fires when a local editor is mounted — zero impact on normal undo)
    this.undoManager = new Y.UndoManager([objects], {
      trackedOrigins: new Set([this.userId, ySyncPluginKey]),
      captureTimeout: 500, // Merge rapid changes within 500ms
    });
  }

  // Ingest awareness updates with seq-based ordering
  private ingestAwareness(clientId: number, state: any, now: number): void {
    let ps = this.peerSmoothers.get(clientId);
    if (!ps) {
      ps = { hasCursor: false, lastSeq: -1 };
      this.peerSmoothers.set(clientId, ps);
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
    const now = performance.now();
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
      // Cache the local clientID to avoid repeated access
      const localClientId = this.yAwareness.clientID;
      this.yAwareness.getStates().forEach((state, clientId) => {
        // Check clientId instead of userId - exclude our own awareness
        if (state.userId && clientId !== localClientId) {
          // Get smoother by clientId
          let ps = this.peerSmoothers.get(clientId);
          if (!ps) {
            ps = { hasCursor: false, lastSeq: -1 };
            this.peerSmoothers.set(clientId, ps);
          }

          // Get smoothed cursor position
          const displayCursor = this.getDisplayCursor(ps, now);

          // Still output by userId for UI stability
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
      userId: this.userId,
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

  // Initialize Y.js structures with proper setup
  private initializeYjsStructures(): void {
    this.ydoc.transact(() => {
      const root = this.ydoc.getMap('root');
      // Bump schema version for Y.Map migration
      root.set('v', 2);
      // Keep meta
      if (!root.has('meta')) {
        const meta = new Y.Map();
        root.set('meta', meta);
      }
      // NEW: Create objects map instead of arrays
      if (!root.has('objects')) {
        root.set('objects', new Y.Map());
      }
    }, 'init-structures'); // Origin for debugging
  }

  // Step 4: Add output with size enforcement
  // Step 6: Validate structure integrity

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
    cb(this.buildPresenceView());

    return () => {
      this.presenceSubscribers.delete(cb);
    };
  }

  // Simple mutate method
  mutate(fn: (ydoc: Y.Doc) => void): void {
    // Check if destroyed first
    if (this.destroyed) return;

    // Pre-init guard: before IDB hydration or seeding, don't create containers via writes.
    // This prevents the race condition where writes could create fresh containers that
    // compete with persisted ones from IDB or WS. Once 'meta' exists, structures are initialized.
    const root = this.ydoc.getMap('root');
    if (!root.has('meta')) {
      // Defer writes until either (a) WS syncs, or (b) a long grace elapses after IDB.
      this.whenGateOpen('idbReady').then(async () => {
        await Promise.race([this.whenGateOpen('wsSynced'), this.delay(5_000)]);
        const r = this.ydoc.getMap('root');
        if (!r.has('meta')) {
          // Truly fresh doc even after IDB + grace → seed once.
          this.initializeYjsStructures();
        }
        this.mutate(fn); // replay the write
      });
      return;
    }

    // Execute in single transaction with user origin
    // Doc changes are published immediately via handleYDocUpdate → publishSnapshotNow()
    this.ydoc.transact(() => {
      fn(this.ydoc);
    }, this.userId); // Origin for undo/redo tracking
  }

  undo(): void {
    if (this.destroyed) return;
    if (!this.undoManager) {
      console.warn('[RoomDocManager] UndoManager not initialized');
      return;
    }

    this.undoManager.undo();
  }

  redo(): void {
    if (this.destroyed) return;
    if (!this.undoManager) {
      console.warn('[RoomDocManager] UndoManager not initialized');
      return;
    }

    this.undoManager.redo();
  }

  getUndoManager(): Y.UndoManager | null {
    return this.undoManager;
  }

  // Lifecycle
  destroy(): void {
    // Check if already destroyed (makes it safe to call multiple times)
    if (this.destroyed) return;

    // Set destroyed flag
    this.destroyed = true;

    // Stop presence animation RAF (if running)
    if (this.publishState.rafId !== -1) {
      cancelAnimationFrame(this.publishState.rafId);
      this.publishState.rafId = -1;
    }

    // Clear gate timeouts
    this.gateTimeouts.forEach((timeout) => clearTimeout(timeout));
    this.gateTimeouts.clear();

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

    // Destroy UndoManager
    if (this.undoManager) {
      this.undoManager.destroy();
      this.undoManager = null;
    }

    // Remove Y.Doc observers
    // NOTE: This correctly removes the listener because handleYDocUpdate
    // is an arrow function property with stable identity (see setupObservers)
    this.ydoc.off('updateV2', this.handleYDocUpdate);

    // Remove objects observer
    if (this.objectsObserver) {
      try {
        const objects = this.getObjects();
        objects.unobserveDeep(this.objectsObserver);
      } catch {
        // Ignore errors during cleanup
      }
      this.objectsObserver = null;
    }

    // Clean up spatial index
    if (this.spatialIndex) {
      this.spatialIndex.clear();
      this.spatialIndex = null;
    }

    // Clear connector lookup
    clearConnectorLookup();

    // Clear text layout cache
    textLayoutCache.clear();

    // Clear object maps
    this.objectsById.clear();

    // Clear subscriptions
    this.snapshotSubscribers.clear();
    this.presenceSubscribers.clear();

    // Clear cursor interpolation state
    this.peerSmoothers.clear();
    this.presenceAnimDeadlineMs = 0;

    // Destroy Y.Doc
    this.ydoc.destroy();

    // Note: Registry removal is handled externally
    // The registry that created this manager should handle cleanup
  }

  // ============================================================
  // ON-DEMAND PRESENCE ANIMATION (Replaces continuous RAF loop)
  // ============================================================

  /**
   * Trigger presence animation RAF loop (on-demand, not continuous).
   * Only schedules RAF if:
   * 1. Not already running
   * 2. Not destroyed
   * 3. Inside animation window OR presence is dirty
   */
  private triggerPresenceAnimation(): void {
    // Already running - let current loop handle it
    if (this.publishState.rafId !== -1) return;
    // Destroyed - don't schedule
    if (this.destroyed) return;

    this.publishState.rafId = requestAnimationFrame(() => {
      // Clear the RAF ID first (allows re-triggering)
      this.publishState.rafId = -1;

      // Guard: check destroyed again (could have changed during frame)
      if (this.destroyed) return;

      const now = performance.now();
      const stillAnimating = now < this.presenceAnimDeadlineMs;

      // Publish presence update
      this.publishPresenceUpdate();

      // Continue loop only if still within animation window
      if (stillAnimating && !this.destroyed) {
        this.triggerPresenceAnimation();
      }
    });
  }

  /**
   * Publish presence update to all subscribers.
   * Called from triggerPresenceAnimation() during cursor interpolation.
   */
  private publishPresenceUpdate(): void {
    const presence = this.buildPresenceView();

    // Notify presence subscribers
    this.presenceSubscribers.forEach((cb) => {
      try {
        cb(presence);
      } catch (e) {
        console.error('[RoomDocManager] Presence subscriber error:', e);
      }
    });

    // Clear presence dirty flag
    this.publishState.presenceDirty = false;
  }

  // Phase 2.4 Component B: Y.Doc Observer Setup
  private setupObservers(): void {
    // CRITICAL: Use 'update' event for batching, not deep observe for objects
    // NOTE: handleYDocUpdate is an arrow function property (not a method), which creates
    // a stable function reference bound to this instance.
    this.ydoc.on('updateV2', this.handleYDocUpdate);

    // Optional: Track specific events for debugging
    //   this.ydoc.on('afterTransaction', (_transaction: Y.Transaction) => {
  }

  // ============================================================
  // PART 2: Objects Observers (Deep observer on objects Y.Map)
  // ============================================================
  private setupObjectsObserver(): void {
    if (this.objectsObserver) return; // idempotent

    const objects = this.getObjects();

    this.objectsObserver = (events, _tx) => {
      // CRITICAL: Ignore during rebuild epoch
      if (this.needsSpatialRebuild) return;

      const touchedIds = new Set<string>();
      const deletedIds = new Set<string>();

      for (const ev of events) {
        // Top-level object adds/deletes
        if (ev.target === objects && ev instanceof Y.YMapEvent) {
          for (const [key, change] of ev.changes.keys) {
            const id = String(key);
            if (change.action === 'delete') {
              deletedIds.add(id);
            } else {
              touchedIds.add(id);
            }
          }
          continue;
        }

        // Nested changes - path[0] is object ID
        const path = ev.path as (string | number)[];
        const id = String(path[0] ?? '');
        if (!id) continue;

        touchedIds.add(id);

        // Y.XmlFragment change: invalidate text cache (full)
        if (path.length >= 2 && String(path[1] ?? '') === 'content') {
          textLayoutCache.invalidateContent(id);
        }
      }

      if (touchedIds.size === 0 && deletedIds.size === 0) return;

      this.applyObjectChanges(touchedIds, deletedIds);
      // No flag needed - handleYDocUpdate → publishSnapshotNow() handles publishing
    };

    objects.observeDeep(this.objectsObserver);
    // needsSpatialRebuild is already true from initialization
  }

  private applyObjectChanges(touchedIds: Set<string>, deletedIds: Set<string>): void {
    const objects = this.getObjects();

    // Process deletions
    for (const id of deletedIds) {
      const handle = this.objectsById.get(id);
      if (!handle) continue;

      // Update spatial index
      if (this.spatialIndex) {
        this.spatialIndex.remove(id, handle.bbox);
      }

      // Track for cache eviction
      this.cacheEvictIds.add(id);

      // Mark dirty
      this.dirtyRects.push(bboxToBounds(handle.bbox));

      // Remove from registry
      this.objectsById.delete(id);

      // Update connector lookup
      if (handle.kind === 'connector') {
        processConnectorDeleted(id);
      } else {
        processShapeDeleted(id); // Clean up lookup entry for this shape
      }

      // Remove text cache entry on deletion
      if (handle.kind === 'text') {
        textLayoutCache.remove(id);
      }
    }

    // Process additions/updates
    // Read selection context once before loop
    const sel = useSelectionStore.getState();
    const editingId = sel.textEditingId;
    const selectedSet = sel.selectedIdSet;
    let needsRefresh = false;
    let needsReposition = false;

    // Deletion bridge
    if (selectedSet.size > 0) {
      for (const id of deletedIds) {
        if (selectedSet.has(id)) { sel.clearSelection(); break; }
      }
    } else if (editingId && deletedIds.has(editingId)) {
      useSelectionStore.getState().endTextEditing();
    }

    for (const id of touchedIds) {
      const yObj = objects.get(id);
      if (!yObj) continue;

      const kind = (yObj.get('kind') as ObjectKind) ?? 'stroke';
      const prev = this.objectsById.get(id);
      const oldBBox = prev?.bbox ?? null;

      // Compute new bbox - use specialized computation for text
      let newBBox: [number, number, number, number];
      if (kind === 'text') {
        const props = getTextProps(yObj);
        if (props) {
          newBBox = computeTextBBox(id, props);
        } else {
          const origin = (yObj.get('origin') as [number, number]) ?? [0, 0];
          const fontSize = (yObj.get('fontSize') as number) ?? 20;
          newBBox = [origin[0], origin[1] - fontSize, origin[0] + 1, origin[1] + 1];
        }
      } else {
        newBBox = computeBBoxFor(kind, yObj);
      }

      const handle: ObjectHandle = {
        id,
        kind,
        y: yObj,
        bbox: newBBox,
      };

      this.objectsById.set(id, handle);

      // Update spatial index (already exists from buildSnapshot)
      if (this.spatialIndex) {
        if (oldBBox) {
          this.spatialIndex.update(id, oldBBox, newBBox, kind);
        } else {
          this.spatialIndex.insert(id, newBBox, kind);
        }
      }

      // Update connector lookup for connector objects
      if (kind === 'connector') {
        if (oldBBox) {
          processConnectorUpdated(id, yObj);
        } else {
          processConnectorAdded(id, yObj);
        }
      }

      // Handle cache and dirty rects
      if (!oldBBox) {
        // New object
        this.dirtyRects.push(bboxToBounds(newBBox));
      } else {
        const bboxChanged = !bboxEquals(oldBBox, newBBox);

        if (bboxChanged) {
          // Geometry changed (INCLUDING width changes since bbox includes width!)
          this.cacheEvictIds.add(id);
          this.dirtyRects.push(bboxToBounds(oldBBox));
          this.dirtyRects.push(bboxToBounds(newBBox));
        } else {
          // BBox unchanged — still push dirty rect for style-only mutations (color, fill, opacity)
          if (kind === 'shape') this.cacheEvictIds.add(id);
          this.dirtyRects.push(bboxToBounds(newBBox));
        }
      }

      // Bridge: track selection/editing relevance inline
      if (selectedSet.has(id) || id === editingId) {
        needsRefresh = true;
        if (!oldBBox || !bboxEquals(oldBBox, newBBox)) needsReposition = true;
      }
    }

    // Bridge: apply accumulated flags
    if (needsRefresh) useSelectionStore.getState().refreshStyles();
    if (needsReposition) useSelectionStore.setState((s) => ({ boundsVersion: s.boundsVersion + 1 }));
  }

  // ============================================================
  // PART 3: Rebuild Epoch (Hydrate from Y.Map)
  // ============================================================

  private hydrateObjectsFromY(): void {
    const objects = this.getObjects();

    // Reset everything EXCEPT spatial index (already created in buildSnapshot)
    this.objectsById.clear();
    if (this.spatialIndex) {
      this.spatialIndex.clear();
    }
    // Clear dirty tracking - this is a full rebuild
    this.dirtyRects.length = 0;
    this.cacheEvictIds.clear();
    // Clear text layout cache on full rebuild
    textLayoutCache.clear();

    // Build handles from Y.Doc
    const handles: ObjectHandle[] = [];
    objects.forEach((yObj, key) => {
      const id = String(key);
      const kind = (yObj.get('kind') as ObjectKind) ?? 'stroke';

      // Compute bbox - use specialized computation for text
      let bbox: [number, number, number, number];
      if (kind === 'text') {
        const props = getTextProps(yObj);
        if (props) {
          bbox = computeTextBBox(id, props);
        } else {
          const origin = (yObj.get('origin') as [number, number]) ?? [0, 0];
          const fontSize = (yObj.get('fontSize') as number) ?? 20;
          bbox = [origin[0], origin[1] - fontSize, origin[0] + 1, origin[1] + 1];
        }
      } else {
        bbox = computeBBoxFor(kind, yObj);
      }

      const handle: ObjectHandle = { id, kind, y: yObj, bbox };
      this.objectsById.set(id, handle);
      handles.push(handle);
    });

    // Bulk load spatial index
    if (this.spatialIndex && handles.length > 0) {
      this.spatialIndex.bulkLoad(handles);
    }

    // Hydrate connector lookup from built handles
    hydrateConnectorLookup(this.objectsById);
    // Publishing happens via handleYDocUpdate → publishSnapshotNow()
  }

  // Arrow function property ensures stable reference for event listener cleanup
  private handleYDocUpdate = (_update: Uint8Array, _origin: unknown): void => {
    // Increment docVersion on ANY Y.Doc change
    this.docVersion = (this.docVersion + 1) >>> 0; // Use unsigned 32-bit int
    this.sawAnyDocUpdate = true; // We've now seen real doc data

    // EVENT-DRIVEN: Publish immediately instead of setting dirty flag
    // The objectsObserver has already updated objectsById and spatialIndex
    this.publishSnapshotNow();
  };

  private initializeIndexedDBProvider(): void {
    try {
      // Create room-scoped IDB provider
      const dbName = `avlo.v1.rooms.${this.roomId}`;
      // Creating IndexedDB provider
      this.indexeddbProvider = new IndexeddbPersistence(dbName, this.ydoc);

      // Set up IDB gate with 2s timeout
      const timeoutId = setTimeout(() => {
        // IDB timeout reached, proceeding with empty doc
        this.handleIDBReady(); // Use unified handler
      }, 2000);
      this.gateTimeouts.set('idbReady', timeoutId);

      // Listen for IDB sync completion for gate control
      this.indexeddbProvider.whenSynced
        .then(() => {
          // IndexedDB whenSynced resolved
          this.handleIDBReady(); // Use unified handler
        })
        .catch((err: unknown) => {
          console.error('[RoomDocManager] IDB sync error (non-critical):', err);
          // Still open gate on error - fallback to empty doc
          this.handleIDBReady(); // Use unified handler
        });

      // Note: No need to listen for 'synced' event to mark dirty
      // Y.Doc updates from IDB will trigger the existing doc update handler
    } catch (err: unknown) {
      console.error('[RoomDocManager] IDB initialization failed (non-critical):', err);
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
    // Open the gate - structure initialization is handled in constructor
    // via whenGateOpen('idbReady').then(...)
    this.openGate('idbReady');
  }

  private initializeWebSocketProvider(): void {
    try {
      // Use window.location.host for PartyServer connection
      const host = window.location.host;

      // Create YProvider (replaces WebsocketProvider)
      this.websocketProvider = new YProvider(
        host,
        this.roomId, // Room name (not appended to URL)
        this.ydoc,
        {
          connect: true,
          party: 'rooms', // MUST match env binding name in wrangler.toml
          awareness: this.yAwareness,
          maxBackoffTime: 10_000,
          resyncInterval: -1,
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
        const now = performance.now();

        // Process changed states
        if (event && typeof event === 'object') {
          // Handle added/updated states
          const changedClientIds = [
            ...(event.added || []),
            ...(event.updated || []),
            ...(event.removed || []),
          ];

          // Cache the local clientID to avoid repeated access and handle undefined case
          const localClientId = this.yAwareness?.clientID;
          for (const clientId of changedClientIds) {
            const state = this.yAwareness?.getStates()?.get(clientId);
            // Key change: check clientId !== localClientId (our own clientID)
            if (state && state.userId && clientId !== localClientId) {
              // Pass clientId, not userId!
              this.ingestAwareness(clientId, state, now);
            } else if (!state && clientId) {
              // Handle removed peers - This now works correctly!
              const ps = this.peerSmoothers.get(clientId);
              if (ps) {
                ps.hasCursor = false;
                ps.prev = ps.last = ps.displayStart = undefined;
                ps.animStartMs = ps.animEndMs = undefined;
              }
              this.peerSmoothers.delete(clientId);
            }
          }
        }

        // ON-DEMAND PRESENCE ANIMATION:
        // If we're inside an animation window (cursor interpolation), start/continue RAF
        // Otherwise, just publish once (no ongoing loop needed)
        // Note: reuses `now` from line 1301
        if (now < this.presenceAnimDeadlineMs) {
          // Cursor interpolation in progress - trigger animation loop
          this.triggerPresenceAnimation();
        } else {
          // No animation needed - publish immediately (one-shot)
          this.publishPresenceUpdate();
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
          if (!this.gates.awarenessReady) {
            this.openGate('awarenessReady');

            // Mark dirty to trigger initial awareness send on reconnect
            if (this.yAwareness) {
              this.awarenessIsDirty = true;
              this.scheduleAwarenessSend();
            }

            // Also mark presence dirty to ensure initial publish
            this.publishState.presenceDirty = true;
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

          // Close awareness gate on disconnect
          // This ensures cursors hide immediately when offline
          if (this.gates.awarenessReady) {
            this.closeGate('awarenessReady');
            // Clear cursor trails to prevent stale data across sessions
            clearCursorTrails();
            // Mark presence dirty to trigger immediate UI update
            this.publishState.presenceDirty = true;

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

  // Gate management
  private openGate(gateName: keyof typeof this.gates): void {
    const wasOpen = this.gates[gateName];
    if (wasOpen) return; // Already open

    this.gates[gateName] = true;

    // Force presence publish when both gates are open for the first time
    // The RAF loop is already running from constructor, so just mark dirty
    if (!wasOpen && gateName === 'firstSnapshot' && this.gates.awarenessReady) {
      this.publishState.presenceDirty = true;
    }
    // Similar check if awarenessReady opens after firstSnapshot
    if (!wasOpen && gateName === 'awarenessReady' && this.gates.firstSnapshot) {
      this.publishState.presenceDirty = true;
    }

    // Notify internal waiters (whenGateOpen promises)
    const callbacks = this.gateCallbacks.get(gateName);
    if (callbacks) {
      callbacks.forEach((cb) => cb());
      callbacks.clear();
    }

    // Note: G_FIRST_SNAPSHOT opens in buildSnapshot() when first doc-derived snapshot publishes
    // Do NOT open it here based on other gates
  }

  private closeGate(gateName: keyof typeof this.gates): void {
    if (!this.gates[gateName]) return; // Already closed
    this.gates[gateName] = false;
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

  // ============================================================
  // PART 5: Event-Driven Snapshot Publishing
  // ============================================================
  // NOTE: The old buildSnapshot() and publishSnapshot() methods have been
  // removed. Doc publishing is now event-driven via publishSnapshotNow().

  /**
   * Publish snapshot immediately (event-driven, no RAF delay)
   * Called directly from handleYDocUpdate for immediate publishing.
   */
  private publishSnapshotNow(): void {
    const meta = this.getMeta();
    // Guard: structures must exist
    if (!meta) {
      return;
    }

    // Create spatial index ONCE (first time only)
    if (!this.spatialIndex) {
      this.spatialIndex = new ObjectSpatialIndex();
      initConnectorLookup(); // Initialize connector lookup alongside spatial index
    }

    // Two-epoch model: rebuild on first run or when flagged
    if (this.needsSpatialRebuild) {
      this.hydrateObjectsFromY();
      this.needsSpatialRebuild = false;
    }

    // Build dirty patch from accumulated changes
    let dirtyPatch: DirtyPatch | null = null;
    if (this.dirtyRects.length > 0 || this.cacheEvictIds.size > 0) {
      dirtyPatch = {
        rects: this.dirtyRects.splice(0),
        evictIds: Array.from(this.cacheEvictIds),
      };
      this.cacheEvictIds.clear();
    }

    // Create Snapshot (no presence, no view - those are handled separately)
    const snap: Snapshot = {
      docVersion: this.docVersion,
      objectsById: this.objectsById,
      spatialIndex: this.spatialIndex,
      createdAt: Date.now(),
      dirtyPatch,
    };

    // Update current snapshot
    this._currentSnapshot = snap;

    // Notify snapshot subscribers (event-driven path)
    this.snapshotSubscribers.forEach((cb) => {
      try {
        cb(snap);
      } catch (error) {
        console.error('[Snapshot] Subscriber error:', error);
      }
    });

    // Open first snapshot gate if applicable
    if (!this.gates.firstSnapshot && this.sawAnyDocUpdate) {
      this.openGate('firstSnapshot');
    }
  }
}
