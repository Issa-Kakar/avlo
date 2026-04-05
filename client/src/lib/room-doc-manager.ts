/**
 * RoomDocManager - Central authority for Y.Doc and real-time collaboration
 */

import * as Y from 'yjs';
import { IndexeddbPersistence } from 'y-indexeddb';
import YProvider from 'y-partyserver/provider';
import { Awareness as YAwareness } from 'y-protocols/awareness';
const AWARENESS_HZ_BASE = 15;
const AWARENESS_HZ_DEGRADED = 8;
const WS_BUFFER_HIGH = 64 * 1024;
const WS_BUFFER_CRITICAL = 256 * 1024;
import { UserProfile } from './user-identity';
import { userProfileManager } from './user-profile-manager';
import type { RoomId } from '@avlo/shared';
import type { Snapshot } from '@/types/snapshot';
import type { PresenceView } from '@/types/awareness';
import { ObjectSpatialIndex } from '@/lib/spatial';
import type { ObjectHandle, ObjectKind } from '@/types/objects';
import type { BBoxTuple } from '@/types/geometry';
import { computeBBoxFor, bboxEquals } from '@/lib/geometry/bbox';
import { getObjectCacheInstance } from '@/renderer/object-cache';
import { invalidateWorldBBox, invalidateWorldAll } from '@/canvas/invalidation-helpers';
import { getVisibleWorldBounds } from '@/stores/camera-store';
import {
  initConnectorLookup,
  hydrateConnectorLookup,
  clearConnectorLookup,
  processConnectorAdded,
  processConnectorUpdated,
  processConnectorDeleted,
  processShapeDeleted,
} from './connectors';
import { getTextProps } from '@/lib/object-accessors';
import { ySyncPluginKey } from '@tiptap/y-tiptap';
import { textLayoutCache, computeTextBBox, computeNoteBBox } from './text/text-system';
import { getNoteProps } from '@/lib/object-accessors';
import { codeSystem, computeCodeBBox } from './code/code-system';
import { getCodeProps } from '@/lib/object-accessors';
import { useSelectionStore } from '@/stores/selection-store';
import { hydrateImages } from '@/lib/image/image-manager';
import { invalidateBookmarkLayout, clearBookmarkLayouts } from '@/lib/bookmark/bookmark-render';

type Unsub = () => void;

// Type alias for Y structures
type YObjects = Y.Map<Y.Map<unknown>>;

// Manager interface - public API
export interface IRoomDocManager {
  // Top-level objects map — always exists, no seeding needed
  readonly objects: YObjects;
  readonly objectsById: ReadonlyMap<string, ObjectHandle>;
  readonly spatialIndex: ObjectSpatialIndex;

  // Snapshot - immutable view of Y.Doc state (no presence)
  readonly currentSnapshot: Snapshot;
  subscribeSnapshot(cb: (snap: Snapshot) => void): Unsub;

  // Presence - separate subscription for cursor/activity updates
  readonly currentPresence: PresenceView;
  subscribePresence(cb: (p: PresenceView) => void): Unsub;

  // Mutations
  mutate(fn: () => void): void;
  destroy(): void;
  undo(): void;
  redo(): void;
  getUndoManager(): Y.UndoManager | null;

  // Connection status
  isConnected(): boolean;

  // Awareness API
  updateCursor(worldX: number | undefined, worldY: number | undefined): void;
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
  readonly objects: YObjects;

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

  // Awareness state tracking
  private awarenessIsDirty = false;

  // Backpressure fields for awareness
  private localCursor: { x: number; y: number } | undefined = undefined;
  private awarenessSeq = 0;
  private awarenessSendTimer: number | null = null;
  private awarenessSkipCount = 0;
  private awarenessSendRate = AWARENESS_HZ_BASE;
  private lastSentAwareness: {
    cursor?: { x: number; y: number };
    name: string;
    color: string;
  } | null = null;

  // Cursor interpolation fields
  private peerSmoothers = new Map<number, PeerSmoothing>(); // Keyed by clientId for proper cleanup
  private presenceAnimDeadlineMs = 0;

  // Connection tracking
  private wsConnected = false;
  private wsRepacked = false;

  // Awareness event handler storage for cleanup
  private _onAwarenessUpdate: ((event: any) => void) | null = null;
  private _onWebSocketStatus: ((event: { status: string }) => void) | null = null;

  // ============================================================
  // TWO-EPOCH ARCHITECTURE: Minimal State
  // ============================================================

  //  Y.Map-based object storage
  readonly objectsById = new Map<string, ObjectHandle>();
  readonly spatialIndex = new ObjectSpatialIndex();
  private objectsObserver: ((events: Y.YEvent<any>[], tx: Y.Transaction) => void) | null = null;

  constructor(roomId: RoomId, _options?: RoomDocManagerOptions) {
    this.roomId = roomId;

    const identity = userProfileManager.getIdentity();
    this.userId = identity.userId;
    this.userProfile = { name: identity.name, color: identity.color };

    this.ydoc = new Y.Doc({ guid: roomId });
    this.objects = this.ydoc.getMap('objects') as YObjects;
    this.yAwareness = new YAwareness(this.ydoc);
    if (this.yAwareness) this.awarenessIsDirty = true;

    this.publishState = { presenceDirty: false, rafId: -1 };

    // Initial snapshot references our live (empty) instances
    this._currentSnapshot = {
      docVersion: 0,
      objectsById: this.objectsById,
      spatialIndex: this.spatialIndex,
    };

    // Y.Doc-level update observer (before IDB to catch updates)
    this.setupObservers();

    // Async init: IDB → hydrate → observer → UndoManager → WS
    void this.init();
  }

  private async init(): Promise<void> {
    // 1. IDB sync with 1s timeout
    await this.initializeIndexedDBProvider();
    if (this.destroyed) return;

    // 2. Init connector lookup + hydrate from IDB data (first STR bulk load)
    initConnectorLookup();
    this.hydrateObjectsFromY();
    this.publishSnapshotNow();

    // 3. Attach deep observer AFTER hydrate (critical ordering)
    this.setupObjectsObserver();

    // 4. UndoManager
    this.attachUndoManager();

    // 5. WS provider (sync listener handles repack)
    if (!this.destroyed) this.initializeWebSocketProvider();
  }

  // Public getters
  get currentSnapshot(): Snapshot {
    return this._currentSnapshot;
  }

  get currentPresence(): PresenceView {
    return this.buildPresenceView();
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

    // Track changes to objects map
    // ySyncPluginKey origin captures text fragment edits from ProseMirror sync plugin
    // (only fires when a local editor is mounted — zero impact on normal undo)
    this.undoManager = new Y.UndoManager([this.objects], {
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
    if (!this.wsConnected) {
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

    // Check if actual state changed (not just seq)
    const currentState = {
      cursor: this.localCursor,
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
        if (bufferedAmount > WS_BUFFER_HIGH) {
          shouldSkipDueToBackpressure = true;
          this.awarenessSkipCount++;

          // If critical, degrade send rate
          if (bufferedAmount > WS_BUFFER_CRITICAL) {
            this.awarenessSendRate = AWARENESS_HZ_DEGRADED;
          }
        } else if (this.awarenessSendRate < AWARENESS_HZ_BASE) {
          // Buffer recovered, restore rate
          this.awarenessSendRate = AWARENESS_HZ_BASE;
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
      seq: this.awarenessSeq,
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
      if (this.wsConnected) {
        this.scheduleAwarenessSend();
      }
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
    cb(this.buildPresenceView());

    return () => {
      this.presenceSubscribers.delete(cb);
    };
  }

  mutate(fn: () => void): void {
    if (this.destroyed) return;
    this.ydoc.transact(fn, this.userId);
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

    // Clear awareness timer and dirty flag
    if (this.awarenessSendTimer !== null) {
      clearTimeout(this.awarenessSendTimer);
      this.awarenessSendTimer = null;
    }
    this.awarenessIsDirty = false;

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
        this.objects.unobserveDeep(this.objectsObserver);
      } catch {
        // Ignore errors during cleanup
      }
      this.objectsObserver = null;
    }

    // Clean up spatial index
    this.spatialIndex.clear();

    // Clear connector lookup
    clearConnectorLookup();

    // Clear layout caches
    textLayoutCache.clear();
    codeSystem.clear();
    clearBookmarkLayouts();

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

    this.objectsObserver = (events, _tx) => {
      const touchedIds = new Set<string>();
      const deletedIds = new Set<string>();

      for (const ev of events) {
        // Top-level object adds/deletes
        if (ev.target === this.objects && ev instanceof Y.YMapEvent) {
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

        // Y.XmlFragment change: invalidate text cache (eager re-tokenize for inline styles)
        // Y.Text change (code blocks): sync tokenize + dispatch to Lezer worker
        if (path.length >= 2 && String(path[1] ?? '') === 'content') {
          const yObj = this.objects.get(id);
          const content = yObj?.get('content');
          const kind = yObj?.get('kind') as string | undefined;
          if (kind === 'code' && ev instanceof Y.YTextEvent) {
            const lang = getCodeProps(yObj!)?.language ?? 'javascript';
            codeSystem.handleContentChange(id, ev, lang);
          } else if (content instanceof Y.XmlFragment) {
            textLayoutCache.invalidateContent(id, content);
          }
        }
      }

      if (touchedIds.size === 0 && deletedIds.size === 0) return;

      this.applyObjectChanges(touchedIds, deletedIds);
      // No flag needed - handleYDocUpdate → publishSnapshotNow() handles publishing
    };

    this.objects.observeDeep(this.objectsObserver);
  }

  private applyObjectChanges(touchedIds: Set<string>, deletedIds: Set<string>): void {
    const dirtyBBoxes: BBoxTuple[] = [];
    const cache = getObjectCacheInstance();

    // Process deletions
    for (const id of deletedIds) {
      const handle = this.objectsById.get(id);
      if (!handle) continue;

      this.spatialIndex.remove(id, handle.bbox);
      cache.evict(id);
      dirtyBBoxes.push(handle.bbox);

      // Remove from registry
      this.objectsById.delete(id);

      // Update connector lookup
      if (handle.kind === 'connector') {
        processConnectorDeleted(id);
      } else {
        processShapeDeleted(id); // Clean up lookup entry for this shape
      }

      // Remove layout cache entries on deletion
      if (handle.kind === 'text' || handle.kind === 'shape' || handle.kind === 'note') {
        textLayoutCache.remove(id);
      }
      if (handle.kind === 'code') {
        codeSystem.remove(id);
      }
      if (handle.kind === 'bookmark') {
        invalidateBookmarkLayout(id);
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
        if (selectedSet.has(id)) {
          sel.clearSelection();
          break;
        }
      }
    } else if (editingId && deletedIds.has(editingId)) {
      useSelectionStore.getState().endTextEditing();
    }
    // Code editing deletion bridge
    const codeEditingId = sel.codeEditingId;
    if (codeEditingId && deletedIds.has(codeEditingId)) {
      useSelectionStore.getState().endCodeEditing();
    }

    for (const id of touchedIds) {
      const yObj = this.objects.get(id);
      if (!yObj) continue;

      const kind = (yObj.get('kind') as ObjectKind) ?? 'stroke';
      const prev = this.objectsById.get(id);
      const oldBBox = prev?.bbox ?? null;

      // Compute new bbox - use specialized computation for text/note/code
      let newBBox: [number, number, number, number];
      if (kind === 'note') {
        const props = getNoteProps(yObj);
        newBBox = props ? computeNoteBBox(id, props) : computeBBoxFor(kind, yObj);
      } else if (kind === 'text') {
        const props = getTextProps(yObj);
        newBBox = props ? computeTextBBox(id, props) : computeBBoxFor(kind, yObj);
      } else if (kind === 'code') {
        newBBox = computeCodeBBox(id, yObj);
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

      // Update spatial index
      if (oldBBox) {
        this.spatialIndex.update(id, oldBBox, newBBox, kind);
      } else {
        this.spatialIndex.insert(id, newBBox, kind);
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
        dirtyBBoxes.push(newBBox);
      } else {
        const bboxChanged = !bboxEquals(oldBBox, newBBox);

        if (bboxChanged) {
          // Geometry changed (INCLUDING width changes since bbox includes width!)
          cache.evict(id);
          dirtyBBoxes.push(oldBBox);
          dirtyBBoxes.push(newBBox);
        } else {
          // BBox unchanged — still push dirty rect for style-only mutations (color, fill, opacity)
          if (kind === 'shape') cache.evict(id);
          dirtyBBoxes.push(newBBox);
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
    if (needsReposition)
      useSelectionStore.setState((s) => ({ boundsVersion: s.boundsVersion + 1 }));

    this.flushDirtyBBoxes(dirtyBBoxes);
  }

  private flushDirtyBBoxes(bboxes: BBoxTuple[]): void {
    if (bboxes.length === 0) return;
    const vp = getVisibleWorldBounds();
    for (const bbox of bboxes) {
      if (bbox[2] >= vp.minX && bbox[0] <= vp.maxX && bbox[3] >= vp.minY && bbox[1] <= vp.maxY) {
        invalidateWorldBBox(bbox);
      }
    }
  }

  // ============================================================
  // PART 3: Rebuild Epoch (Hydrate from Y.Map)
  // ============================================================

  private hydrateObjectsFromY(): void {
    this.objectsById.clear();
    this.spatialIndex.clear();
    // Clear all caches on full rebuild
    getObjectCacheInstance().clear();
    textLayoutCache.clear();
    codeSystem.clear();
    clearBookmarkLayouts();

    // Build handles from Y.Doc
    const handles: ObjectHandle[] = [];
    this.objects.forEach((yObj, key) => {
      const id = String(key);
      const kind = (yObj.get('kind') as ObjectKind) ?? 'stroke';

      // Compute bbox - use specialized computation for text/note/code
      let bbox: [number, number, number, number];
      if (kind === 'note') {
        const props = getNoteProps(yObj);
        bbox = props ? computeNoteBBox(id, props) : computeBBoxFor(kind, yObj);
      } else if (kind === 'text') {
        const props = getTextProps(yObj);
        bbox = props ? computeTextBBox(id, props) : computeBBoxFor(kind, yObj);
      } else if (kind === 'code') {
        bbox = computeCodeBBox(id, yObj);
      } else {
        bbox = computeBBoxFor(kind, yObj);
      }

      const handle: ObjectHandle = { id, kind, y: yObj, bbox };
      this.objectsById.set(id, handle);
      handles.push(handle);
    });

    // Bulk load spatial index (STR packing)
    if (handles.length > 0) {
      this.spatialIndex.bulkLoad(handles);
    }

    // Hydrate connector lookup from built handles
    hydrateConnectorLookup(this.objectsById);

    // Hydrate images: ensure all in IDB, decode only viewport-visible
    hydrateImages(this.objects);

    // v2: bookmark unfurls are drained by image worker IDB queue on init (no main-thread scan needed)

    // Signal full base-canvas clear after rebuild
    invalidateWorldAll();
  }

  // Arrow function property ensures stable reference for event listener cleanup
  private handleYDocUpdate = (_update: Uint8Array, _origin: unknown): void => {
    // Increment docVersion on ANY Y.Doc change
    this.docVersion = (this.docVersion + 1) >>> 0; // Use unsigned 32-bit int

    // EVENT-DRIVEN: Publish immediately instead of setting dirty flag
    // The objectsObserver has already updated objectsById and spatialIndex
    this.publishSnapshotNow();
  };

  private async initializeIndexedDBProvider(): Promise<void> {
    try {
      const dbName = `avlo.v1.rooms.${this.roomId}`;
      this.indexeddbProvider = new IndexeddbPersistence(dbName, this.ydoc);
      await Promise.race([
        this.indexeddbProvider.whenSynced,
        new Promise<void>((resolve) => setTimeout(resolve, 1000)),
      ]).catch(() => {});
    } catch (err) {
      console.error('[RoomDocManager] IDB initialization failed (non-critical):', err);
    }
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
          if (!this.wsConnected) {
            this.wsConnected = true;

            // Trigger initial awareness send on connect/reconnect
            if (this.yAwareness) {
              this.awarenessIsDirty = true;
              this.scheduleAwarenessSend();
            }
            this.publishState.presenceDirty = true;
          }
        } else if (event.status === 'disconnected') {
          if (this.wsConnected) {
            this.wsConnected = false;
            this.wsRepacked = false;
            // Mark presence dirty to trigger immediate UI update
            this.publishState.presenceDirty = true;

            // Clear local cursor state
            this.localCursor = undefined;
            // Force awareness state clear to signal departure to peers
            if (this.yAwareness) {
              try {
                this.yAwareness.setLocalState(null);
              } catch {
                // Ignore errors during awareness cleanup
              }
            }
          }
        }
      };

      // Listen for awareness updates
      if (this.yAwareness && this._onAwarenessUpdate) {
        this.yAwareness.on('update', this._onAwarenessUpdate);
      }

      // Set up connection gates with new handler
      this.websocketProvider.on('status', this._onWebSocketStatus);

      // Listen for sync status — repack spatial index on first sync per connection
      this.websocketProvider.on('sync', (isSynced: boolean) => {
        if (isSynced && !this.wsRepacked) {
          this.repackSpatialIndex();
          this.wsRepacked = true;
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

  private repackSpatialIndex(): void {
    this.spatialIndex.clear();
    const handles = Array.from(this.objectsById.values());
    if (handles.length > 0) this.spatialIndex.bulkLoad(handles);
  }

  public isConnected(): boolean {
    return this.wsConnected;
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
    const snap: Snapshot = {
      docVersion: this.docVersion,
      objectsById: this.objectsById,
      spatialIndex: this.spatialIndex,
    };
    this._currentSnapshot = snap;
    this.snapshotSubscribers.forEach((cb) => {
      try {
        cb(snap);
      } catch (e) {
        console.error('[Snapshot] Subscriber error:', e);
      }
    });
  }
}
