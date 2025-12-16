/**
 * AwarenessManager - Handles local awareness state and peer cursor tracking
 *
 * Responsibilities:
 * - Local cursor position and activity state
 * - Awareness sending with backpressure handling
 * - Peer cursor tracking (raw data, no interpolation)
 * - Subscription mechanism for peer cursor changes
 *
 * Design decisions:
 * - Backpressure via callback - keeps WebSocket internals in RoomDocManager
 * - Gate check via callback - keeps gate state in RoomDocManager
 * - No interpolation here - that's render-time concern (PresenceInterpolator)
 * - Uses lodash throttle for battle-tested rate limiting
 */

import throttle from 'lodash/throttle';
import type { Awareness as YAwareness } from 'y-protocols/awareness';
import { AWARENESS_CONFIG } from '@avlo/shared';

// Quantization constant - matches sender quantization
const CURSOR_Q_STEP = 0.5;
const quantize = (v: number): number => Math.round(v / CURSOR_Q_STEP) * CURSOR_Q_STEP;

/**
 * Raw peer cursor data from awareness
 * No interpolation - just the latest received state
 */
export interface PeerCursor {
  clientId: number;
  userId: string;
  name: string;
  color: string;
  cursor: { x: number; y: number } | null;
  activity: 'idle' | 'drawing' | 'typing';
  seq: number;
  ts: number;
}

/**
 * Backpressure status from WebSocket buffer check
 */
export interface BackpressureStatus {
  shouldSkip: boolean;     // Buffer is high, skip this send
  shouldDegrade: boolean;  // Buffer is critical, reduce rate
  shouldRecover: boolean;  // Buffer recovered, restore rate
}

/**
 * Callback type for backpressure checking
 * Returns the current WebSocket buffer status
 */
export type BackpressureChecker = () => BackpressureStatus;

/**
 * Configuration options for AwarenessManager
 */
export interface AwarenessManagerOptions {
  userId: string;
  userProfile: { name: string; color: string };
  yAwareness: YAwareness;
  checkBackpressure: BackpressureChecker;
  isGateOpen: () => boolean; // Returns true if awarenessReady gate is open
}

/**
 * Subscriber callback type for peer cursor changes
 */
export type PeerCursorsSubscriber = (peers: ReadonlyMap<number, PeerCursor>) => void;

export class AwarenessManager {
  // Cached at construction for stable identity
  public readonly clientId: number;

  // Dependencies (injected)
  private readonly yAwareness: YAwareness;
  private readonly userId: string;
  private userProfile: { name: string; color: string };
  private readonly checkBackpressure: BackpressureChecker;
  private readonly isGateOpen: () => boolean;

  // Local state
  private localCursor: { x: number; y: number } | undefined;
  private localActivity: 'idle' | 'drawing' | 'typing' = 'idle';
  private seq = 0;
  private sendRate = AWARENESS_CONFIG.AWARENESS_HZ_BASE_WS;
  private isDirty = true; // Start dirty for initial send
  private lastSentState: {
    cursor?: { x: number; y: number };
    activity: string;
    name: string;
    color: string;
  } | null = null;

  // Peer state (raw, no interpolation)
  private peerCursors = new Map<number, PeerCursor>();

  // Subscribers
  private subscribers = new Set<PeerCursorsSubscriber>();

  // Throttled send (lodash)
  private sendThrottled: ReturnType<typeof throttle>;
  private boundAwarenessHandler: (event: {
    added?: number[];
    updated?: number[];
    removed?: number[];
  }) => void;

  constructor(options: AwarenessManagerOptions) {
    this.yAwareness = options.yAwareness;
    this.userId = options.userId;
    this.userProfile = options.userProfile;
    this.checkBackpressure = options.checkBackpressure;
    this.isGateOpen = options.isGateOpen;

    // CRITICAL: Cache clientId immediately
    this.clientId = this.yAwareness.clientID;

    // Create throttled send (lodash throttle with trailing call)
    // Base rate is ~15Hz (66ms), degraded is ~8Hz (125ms)
    const baseInterval = 1000 / this.sendRate;
    this.sendThrottled = throttle(this.sendAwareness.bind(this), baseInterval, {
      leading: true,
      trailing: true,
    });

    // Bind and attach awareness handler
    this.boundAwarenessHandler = this.handleAwarenessUpdate.bind(this);
    this.yAwareness.on('update', this.boundAwarenessHandler);
  }

  // ============================================================
  // Public API - Cursor and Activity Updates
  // ============================================================

  /**
   * Update local cursor position
   * Applies quantization and marks dirty if changed
   */
  updateCursor(worldX: number | undefined, worldY: number | undefined): void {
    const newCursor =
      worldX !== undefined && worldY !== undefined
        ? { x: quantize(worldX), y: quantize(worldY) }
        : undefined;

    if (this.cursorChanged(newCursor)) {
      this.localCursor = newCursor;
      this.isDirty = true;
      if (this.isGateOpen()) {
        this.sendThrottled();
      }
    }
  }

  /**
   * Update local activity state
   */
  updateActivity(activity: 'idle' | 'drawing' | 'typing'): void {
    if (this.localActivity !== activity) {
      this.localActivity = activity;
      this.isDirty = true;
      if (this.isGateOpen()) {
        this.sendThrottled();
      }
    }
  }

  /**
   * Update user profile (name/color) if changed externally
   */
  updateProfile(profile: { name: string; color: string }): void {
    if (this.userProfile.name !== profile.name || this.userProfile.color !== profile.color) {
      this.userProfile = profile;
      this.isDirty = true;
      if (this.isGateOpen()) {
        this.sendThrottled();
      }
    }
  }

  // ============================================================
  // Public API - Peer Cursor Access
  // ============================================================

  /**
   * Get current peer cursors (raw data, no interpolation)
   */
  getPeerCursors(): ReadonlyMap<number, PeerCursor> {
    return this.peerCursors;
  }

  /**
   * Subscribe to peer cursor changes
   * Returns unsubscribe function
   */
  subscribe(cb: PeerCursorsSubscriber): () => void {
    this.subscribers.add(cb);
    // Immediate callback with current state
    cb(this.peerCursors);
    return () => this.subscribers.delete(cb);
  }

  // ============================================================
  // Public API - Gate Lifecycle
  // ============================================================

  /**
   * Called when awarenessReady gate opens (connect/reconnect)
   * Triggers pending send if dirty
   */
  onGateOpen(): void {
    if (this.isDirty) {
      this.sendThrottled();
    }
  }

  /**
   * Called when awarenessReady gate closes (disconnect)
   * Clears local cursor and signals departure to peers
   */
  onGateClose(): void {
    this.localCursor = undefined;
    try {
      this.yAwareness.setLocalState(null);
    } catch {
      /* ignore */
    }
  }

  // ============================================================
  // Lifecycle
  // ============================================================

  /**
   * Clean up resources
   */
  destroy(): void {
    this.sendThrottled.cancel();
    this.yAwareness.off('update', this.boundAwarenessHandler);
    try {
      this.yAwareness.setLocalState(null);
    } catch {
      /* ignore */
    }
    this.peerCursors.clear();
    this.subscribers.clear();
  }

  // ============================================================
  // Internal - Cursor Change Detection
  // ============================================================

  private cursorChanged(newCursor: { x: number; y: number } | undefined): boolean {
    if (!this.localCursor && !newCursor) return false;
    if (!this.localCursor || !newCursor) return true;
    return this.localCursor.x !== newCursor.x || this.localCursor.y !== newCursor.y;
  }

  // ============================================================
  // Internal - Awareness Update Handler
  // ============================================================

  private handleAwarenessUpdate(event: {
    added?: number[];
    updated?: number[];
    removed?: number[];
  }): void {
    const changed = [...(event.added ?? []), ...(event.updated ?? [])];
    const removed = event.removed ?? [];
    let hasChanges = false;

    // Process additions/updates
    for (const clientId of changed) {
      if (clientId === this.clientId) continue; // Skip self

      const state = this.yAwareness.getStates().get(clientId);
      if (state?.userId) {
        const cursor = state.cursor as { x: number; y: number } | undefined;
        this.peerCursors.set(clientId, {
          clientId,
          userId: state.userId as string,
          name: (state.name as string) || 'Anonymous',
          color: (state.color as string) || '#808080',
          cursor: cursor ?? null,
          activity: (state.activity as 'idle' | 'drawing' | 'typing') || 'idle',
          seq: (state.seq as number) ?? 0,
          ts: (state.ts as number) ?? Date.now(),
        });
        hasChanges = true;
      }
    }

    // Process removals
    for (const clientId of removed) {
      if (this.peerCursors.delete(clientId)) {
        hasChanges = true;
      }
    }

    // Notify subscribers
    if (hasChanges) {
      this.notifySubscribers();
    }
  }

  private notifySubscribers(): void {
    for (const cb of this.subscribers) {
      try {
        cb(this.peerCursors);
      } catch {
        /* ignore */
      }
    }
  }

  // ============================================================
  // Internal - Awareness Sending with Backpressure
  // ============================================================

  private sendAwareness(): void {
    // Check if gate is closed
    if (!this.isGateOpen()) return;

    // Only send if dirty
    if (!this.isDirty) return;

    // Check backpressure
    const bp = this.checkBackpressure();
    if (bp.shouldSkip) {
      // Stay dirty, throttle will retry
      return;
    }

    // Handle rate degradation/recovery
    if (bp.shouldDegrade && this.sendRate > AWARENESS_CONFIG.AWARENESS_HZ_DEGRADED) {
      this.sendRate = AWARENESS_CONFIG.AWARENESS_HZ_DEGRADED;
      // Recreate throttle with new rate
      this.sendThrottled.cancel();
      this.sendThrottled = throttle(this.sendAwareness.bind(this), 1000 / this.sendRate, {
        leading: true,
        trailing: true,
      });
    }
    if (bp.shouldRecover && this.sendRate < AWARENESS_CONFIG.AWARENESS_HZ_BASE_WS) {
      this.sendRate = AWARENESS_CONFIG.AWARENESS_HZ_BASE_WS;
      this.sendThrottled.cancel();
      this.sendThrottled = throttle(this.sendAwareness.bind(this), 1000 / this.sendRate, {
        leading: true,
        trailing: true,
      });
    }

    // Build current state
    const currentState = {
      cursor: this.localCursor,
      activity: this.localActivity,
      name: this.userProfile.name,
      color: this.userProfile.color,
    };

    // Check if actually changed from last sent
    if (this.lastSentState && this.stateEquals(currentState, this.lastSentState)) {
      this.isDirty = false;
      return;
    }

    // Send
    this.seq++;
    this.yAwareness.setLocalState({
      userId: this.userId,
      name: this.userProfile.name,
      color: this.userProfile.color,
      cursor: this.localCursor,
      activity: this.localActivity,
      seq: this.seq,
      ts: Date.now(),
      aw_v: 1,
    });

    this.lastSentState = { ...currentState };
    this.isDirty = false;
  }

  private stateEquals(
    a: { cursor?: { x: number; y: number }; activity: string; name: string; color: string },
    b: { cursor?: { x: number; y: number }; activity: string; name: string; color: string }
  ): boolean {
    // Compare cursors - both null/undefined OR both defined with same coords
    let cursorSame: boolean;
    if (!a.cursor && !b.cursor) {
      cursorSame = true;
    } else if (a.cursor && b.cursor) {
      cursorSame = a.cursor.x === b.cursor.x && a.cursor.y === b.cursor.y;
    } else {
      cursorSame = false;
    }
    return cursorSame && a.activity === b.activity && a.name === b.name && a.color === b.color;
  }
}
