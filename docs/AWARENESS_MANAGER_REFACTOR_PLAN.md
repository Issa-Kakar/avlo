# AwarenessManager & Presence System Refactor Plan

**Date:** 2025-12-14
**Status:** READY FOR IMPLEMENTATION (REVISED)
**Priority:** HIGH - Significant boilerplate reduction, architectural improvements

---

## Executive Summary

This plan refactors the awareness/presence system with these key changes:

1. **Extract AwarenessManager** - Move ~400 lines from RoomDocManager into dedicated class
2. **Gates as Zustand Store** - Replace callback-based gates with a proper store (massive simplification)
3. **`whenGateOpen()` with temporary subscriptions** - Promise-based API that subscribes, waits for gate, auto-cleans up
4. **Remove `firstSnapshot` gate entirely** - RenderLoop already renders on docVersion updates, not needed
5. **Backpressure in AwarenessManager** - Keep backpressure logic coupled with awareness sending via callback pattern
6. **Remove cursor trails** - Delete ~280 lines from presence-cursors.ts
7. **Lodash throttle** - Replace custom throttle with battle-tested lodash
8. **Remove presence from snapshot** - Direct subscription model, bypass RAF loop
9. **Remove mobile checks** - Clean up user agent sniffing

**Key Goals:**
- Separation of concerns (awareness is its own module)
- Event-driven presence (no RAF polling)
- Render-time interpolation (correct architectural layer)
- Store-based gates with `whenGateOpen()` utility (no callbacks, no encoding hacks, React-friendly)
- Proper backpressure without splitting responsibilities

**Estimated Lines Removed:** ~800
**Estimated Lines Added:** ~440
**Net Reduction:** ~350+ lines

---

## Part 1: Current Architecture Problems (Detailed Analysis)

### 1.1 Gates System Problems

**Current Implementation (room-doc-manager.ts):**

| Lines | Code | Problem |
|-------|------|---------|
| 189-196 | `private gates = {...}` | Simple object, no reactivity |
| 197-202 | Timeouts, callbacks, debounce state | Scattered state management |
| 744-758 | `subscribeGates()` | Manual Set-based subscription |
| 1583-1614 | `notifyGateChange()` | Manual field-by-field equality check |
| 1616-1627 | `whenGateOpen()` | Awkward Promise-with-callback pattern |

**Hook Workaround (use-connection-gates.ts):**
```typescript
// Lines 19-35: Encode/decode gates to string to avoid useSyncExternalStore instability
function encodeGates(gates: GateStatus): GateSnapshot {
  return `${+gates.idbReady}|${+gates.wsConnected}|...` as GateSnapshot;
}
```

**Problems:**
1. Manual equality checks for every gate field
2. 150ms debounce timer managed separately
3. Promise-based `whenGateOpen()` requires callback management
4. React hook needs string encoding hack for `useSyncExternalStore`
5. `firstSnapshot` gate awkwardly tied to presence rendering (wrong abstraction)

### 1.2 Backpressure Split Problem

**Previous Plan's Mistake:** Removed backpressure from AwarenessManager entirely.

**Current backpressure (room-doc-manager.ts:556-584):**
```typescript
// Lines 556-584 - Backpressure check
let shouldSkipDueToBackpressure = false;
try {
  const ws: WebSocket | undefined = (this.websocketProvider as any)?.ws;
  if (ws && ws.readyState === WebSocket.OPEN) {
    const bufferedAmount = ws.bufferedAmount ?? 0;
    if (bufferedAmount > AWARENESS_CONFIG.WEBSOCKET_BUFFER_HIGH_BYTES) {
      shouldSkipDueToBackpressure = true;
      this.awarenessSkipCount++;
      if (bufferedAmount > AWARENESS_CONFIG.WEBSOCKET_BUFFER_CRITICAL_BYTES) {
        this.awarenessSendRate = AWARENESS_CONFIG.AWARENESS_HZ_DEGRADED;
      }
    } else if (this.awarenessSendRate < AWARENESS_CONFIG.AWARENESS_HZ_BASE_WS) {
      this.awarenessSendRate = AWARENESS_CONFIG.AWARENESS_HZ_BASE_WS;
    }
  }
} catch { /* ignore */ }
```

**The Issue:** Backpressure is tightly coupled with awareness sending. Lodash throttle handles rate limiting, but backpressure (checking WS buffer) is a separate concern that must stay with awareness.

**Solution:** Pass a callback to AwarenessManager that checks backpressure without exposing WebSocket internals.

### 1.3 Presence in Snapshot Problem

**Current flow:**
```
Y.Awareness.update
    ↓
_onAwarenessUpdate() [line 1395]
    ↓
ingestAwareness() [line 371] — interpolation computed here
    ↓
presenceDirty = true [line 1430]
    ↓
updatePresenceThrottled() [line 1434]
    ↓
RAF loop → buildPresenceView() [line 442]
    ↓
getDisplayCursor() — mutates smoothing state during read [line 422]
    ↓
Snapshot published with presence
    ↓
OverlayRenderLoop reads snapshot.presence
    ↓
drawCursors()
```

**Problems:**
1. **Interpolation in data layer** - `getDisplayCursor()` mutates state during read
2. **Triple-notify pattern** - RAF dirty flag, throttled update, awareness handler
3. **Unnecessary coupling** - Presence goes through snapshot pipeline
4. **Wrong gate check** - `awarenessReady && firstSnapshot` for presence

### 1.4 Mobile Checks

**Current (room-doc-manager.ts:587-597):**
```typescript
const isMobile = /Mobi|Android/i.test(navigator.userAgent) || navigator.maxTouchPoints > 1;
// ...
cursor: isMobile ? undefined : this.localCursor,
activity: isMobile ? 'idle' : this.localActivity,
```

**Problem:** Arbitrary restriction on mobile devices. Remove entirely.

### 1.5 `firstSnapshot` Gate is Unnecessary

**Current Implementation:**
```typescript
// In buildSnapshot() - opens gate when first doc update seen
if (!this.gates.firstSnapshot && this.sawAnyDocUpdate) {
  this.openGate('firstSnapshot');
}

// In various places - checks gate before rendering
if (gates.awarenessReady && gates.firstSnapshot) { ... }
```

**Why it's not needed:**

1. **RenderLoop already handles this** - The render loop subscribes to snapshots and only renders when `docVersion` changes. Empty doc = version 0, any data = version > 0.

2. **Snapshot is always valid** - `createEmptySnapshot()` provides valid defaults. There's no "invalid" state to guard against.

3. **Race condition it "prevented" doesn't exist** - The concern was rendering before IDB/WS data arrived. But:
   - RenderLoop doesn't render until subscribed
   - Subscription happens after Canvas mounts
   - By then, IDB has either loaded or timed out

4. **Simplifies gate logic** - Fewer gates = fewer state combinations to reason about.

**Action:** Remove `firstSnapshot` from gate store, remove all checks for it, remove `sawAnyDocUpdate` tracking.

### 1.6 presence-cursors.ts Bloat

**Current file: 356 lines** - Mostly cursor trail rendering.

| Lines | Feature | Status |
|-------|---------|--------|
| 10-65 | Trail types and config | DELETE |
| 37-55 | DEFAULT_TRAIL_PROFILE | DELETE |
| 88-119 | Catmull-Rom resampling | DELETE |
| 142-225 | Trail lifecycle management | DELETE |
| 229-291 | `drawTrailLaser()` | DELETE |
| 295-355 | `drawCursorPointer()` / `drawNameLabel()` | KEEP (simplified) |
| 123-225 | `drawCursors()` main function | SIMPLIFY |

**After refactor: ~80 lines** (just pointer + label)

---

## Part 2: New Architecture

### 2.1 Gate Store (gate-store.ts)

Replace callback-based gates with Zustand store.

**CRITICAL INSIGHT:** The `firstSnapshot` gate is likely unnecessary. The RenderLoop already renders on every `docVersion` update from Y.Doc, so there's no risk of rendering before data exists. Consider removing `firstSnapshot` entirely during implementation.

```typescript
// client/src/stores/gate-store.ts (~100 lines)
import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';

export type GateName = 'idbReady' | 'wsConnected' | 'wsSynced' | 'awarenessReady';

export interface GateState {
  // Core gates (NOTE: firstSnapshot removed - not needed)
  idbReady: boolean;
  wsConnected: boolean;
  wsSynced: boolean;
  awarenessReady: boolean;

  // Actions
  openGate: (gate: GateName) => void;
  closeGate: (gate: GateName) => void;
  resetGates: () => void;
}

const initialGates = {
  idbReady: false,
  wsConnected: false,
  wsSynced: false,
  awarenessReady: false,
};

// Factory function - creates store per room
export function createGateStore() {
  return create<GateState>()(
    subscribeWithSelector((set, get) => ({
      ...initialGates,

      openGate: (gate) => {
        if (get()[gate]) return; // idempotent - no state change if already open
        set({ [gate]: true });
      },

      closeGate: (gate) => {
        if (!get()[gate]) return; // idempotent - no state change if already closed
        set({ [gate]: false });
      }),

      resetGates: () => set(initialGates),
    }))
  );
}

// Type for the store instance
export type GateStore = ReturnType<typeof createGateStore>;

// ============================================================
// CRITICAL: whenGateOpen - Promise-based gate waiting
// ============================================================
// This REPLACES the gateCallbacks Map pattern entirely.
// Uses temporary Zustand subscription that auto-cleans up.
//
// How it works:
// 1. Check current state - if gate already open, resolve immediately
// 2. Otherwise, subscribe to just that gate's state
// 3. When gate opens, unsubscribe IMMEDIATELY from inside callback
// 4. Then resolve the promise
//
// This is safe because Zustand's subscribe() returns an unsubscribe
// function that can be called from within the callback itself.
// ============================================================
export function whenGateOpen(store: GateStore, gate: GateName): Promise<void> {
  // Immediate check - resolve synchronously if already open
  if (store.getState()[gate]) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const unsub = store.subscribe(
      (state) => state[gate],  // Selector for just this gate
      (isOpen) => {
        if (isOpen) {
          unsub();  // Clean up listener IMMEDIATELY (this is safe!)
          resolve();
        }
      },
      { fireImmediately: false }  // Don't fire with current (false) value
    );
  });
}

// Selectors (for use with useStore)
export const selectGates = (state: GateState) => ({
  idbReady: state.idbReady,
  wsConnected: state.wsConnected,
  wsSynced: state.wsSynced,
  awarenessReady: state.awarenessReady,
});
export const selectIsOnline = (state: GateState) => state.wsSynced;
export const selectIsOffline = (state: GateState) => !state.wsConnected;
export const selectCanRender = (state: GateState) => state.idbReady;
export const selectAwarenessReady = (state: GateState) => state.awarenessReady;
```

**Benefits:**
- No manual equality checking (Zustand handles it)
- No `gateCallbacks` Map - `whenGateOpen()` replaces it entirely
- No 150ms debounce timer needed - Zustand's equality checking prevents spurious notifications
- No string encoding hack in React hooks - direct selector usage
- React-friendly with `useStore(gateStore, selector)`
- Imperative access via `gateStore.getState()`
- Per-room stores (factory pattern)

**What becomes unnecessary:**
- `gateCallbacks: Map<string, Set<() => void>>` - replaced by `whenGateOpen()` temporary subscriptions
- `lastGateState` - Zustand handles equality internally
- `gateDebounceTimer` - not needed with Zustand's batching
- `notifyGateChange()` method - Zustand notifies subscribers automatically
- String encoding/decoding in `use-connection-gates.ts` - direct selectors work

### 2.2 AwarenessManager Class

```typescript
// client/src/lib/awareness-manager.ts (~220 lines)
import throttle from 'lodash/throttle';
import { Awareness as YAwareness } from 'y-protocols/awareness';
import { AWARENESS_CONFIG } from '@avlo/shared';

// Quantization constant
const CURSOR_Q_STEP = 0.5;
const quantize = (v: number) => Math.round(v / CURSOR_Q_STEP) * CURSOR_Q_STEP;

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

// Backpressure callback type
export interface BackpressureStatus {
  shouldSkip: boolean;      // Buffer is high, skip this send
  shouldDegrade: boolean;   // Buffer is critical, reduce rate
  shouldRecover: boolean;   // Buffer recovered, restore rate
}

export type BackpressureChecker = () => BackpressureStatus;

export interface AwarenessManagerOptions {
  userId: string;
  userProfile: { name: string; color: string };
  yAwareness: YAwareness;
  checkBackpressure: BackpressureChecker;
  isGateOpen: () => boolean; // Returns true if awarenessReady gate is open
}

export class AwarenessManager {
  // Cached at construction
  public readonly clientId: number;

  // Dependencies
  private readonly yAwareness: YAwareness;
  private readonly userId: string;
  private userProfile: { name: string; color: string };
  private checkBackpressure: BackpressureChecker;
  private isGateOpen: () => boolean;

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
  private subscribers = new Set<(peers: ReadonlyMap<number, PeerCursor>) => void>();

  // Throttled send (lodash)
  private sendThrottled: ReturnType<typeof throttle>;
  private boundAwarenessHandler: (event: any) => void;

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

  // Public API
  updateCursor(worldX: number | undefined, worldY: number | undefined): void {
    const newCursor = (worldX !== undefined && worldY !== undefined)
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

  updateActivity(activity: 'idle' | 'drawing' | 'typing'): void {
    if (this.localActivity !== activity) {
      this.localActivity = activity;
      this.isDirty = true;
      if (this.isGateOpen()) {
        this.sendThrottled();
      }
    }
  }

  getPeerCursors(): ReadonlyMap<number, PeerCursor> {
    return this.peerCursors;
  }

  subscribe(cb: (peers: ReadonlyMap<number, PeerCursor>) => void): () => void {
    this.subscribers.add(cb);
    // Immediate callback with current state
    cb(this.peerCursors);
    return () => this.subscribers.delete(cb);
  }

  // Called when gate opens (reconnect scenario)
  onGateOpen(): void {
    if (this.isDirty) {
      this.sendThrottled();
    }
  }

  // Called when gate closes (disconnect scenario)
  onGateClose(): void {
    this.localCursor = undefined;
    try {
      this.yAwareness.setLocalState(null);
    } catch { /* ignore */ }
  }

  destroy(): void {
    this.sendThrottled.cancel();
    this.yAwareness.off('update', this.boundAwarenessHandler);
    try {
      this.yAwareness.setLocalState(null);
    } catch { /* ignore */ }
    this.peerCursors.clear();
    this.subscribers.clear();
  }

  // Internal
  private cursorChanged(newCursor: { x: number; y: number } | undefined): boolean {
    if (!this.localCursor && !newCursor) return false;
    if (!this.localCursor || !newCursor) return true;
    return this.localCursor.x !== newCursor.x || this.localCursor.y !== newCursor.y;
  }

  private handleAwarenessUpdate(event: { added?: number[]; updated?: number[]; removed?: number[] }): void {
    const changed = [...(event.added ?? []), ...(event.updated ?? [])];
    const removed = event.removed ?? [];

    // Process updates
    for (const clientId of changed) {
      if (clientId === this.clientId) continue; // Skip self

      const state = this.yAwareness.getStates().get(clientId);
      if (state?.userId) {
        this.peerCursors.set(clientId, {
          clientId,
          userId: state.userId,
          name: state.name || 'Anonymous',
          color: state.color || '#808080',
          cursor: state.cursor ?? null,
          activity: state.activity || 'idle',
          seq: state.seq ?? 0,
          ts: state.ts ?? Date.now(),
        });
      }
    }

    // Process removals
    for (const clientId of removed) {
      this.peerCursors.delete(clientId);
    }

    // Notify subscribers
    this.notifySubscribers();
  }

  private notifySubscribers(): void {
    for (const cb of this.subscribers) {
      try { cb(this.peerCursors); } catch { /* ignore */ }
    }
  }

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

    // Check if actually changed
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
    b: { cursor?: { x: number; y: number }; activity: string; name: string; color: string },
  ): boolean {
    const cursorSame = (!a.cursor && !b.cursor) ||
      (a.cursor && b.cursor && a.cursor.x === b.cursor.x && a.cursor.y === b.cursor.y);
    return cursorSame && a.activity === b.activity && a.name === b.name && a.color === b.color;
  }
}
```

**Key Design Decisions:**
1. **Backpressure via callback** - `checkBackpressure()` returns status, AwarenessManager decides what to do
2. **Lodash throttle** - Simple, battle-tested, supports cancel
3. **No interpolation** - Raw data only, interpolation at render time
4. **No mobile checks** - Removed entirely
5. **Direct subscription** - No RAF loop intermediary

### 2.3 PresenceInterpolator (Render-Time)

Designed with future AnimationController in mind.

```typescript
// client/src/renderer/presence-interpolator.ts (~120 lines)
import type { PeerCursor } from '@/lib/awareness-manager';

const INTERP_WINDOW_MS = 66; // ~1-2 frames @60 FPS

interface CursorSmoother {
  prev: { x: number; y: number } | null;
  current: { x: number; y: number } | null;
  animStart: number;
  animEnd: number;
  lastSeq: number;
}

export interface InterpolatedCursor {
  clientId: number;
  userId: string;
  name: string;
  color: string;
  x: number;
  y: number;
}

/**
 * PresenceInterpolator - Computes cursor interpolation at render time.
 *
 * Future AnimationController Integration:
 * This class is designed to fit into a job-based animation system:
 * - `isAnimating()` reports if animation is in progress (job has target)
 * - `needsOverlayInvalidation()` returns true when cursors need redraw
 * - Animation "completes" when all cursors reach their targets
 *
 * The interpolator doesn't drive the render loop - it responds to it.
 * The render loop calls `getInterpolatedCursors()` on each frame,
 * and the interpolator reports if more frames are needed.
 */
export class PresenceInterpolator {
  private smoothers = new Map<number, CursorSmoother>();
  private _needsOverlay = false;

  /**
   * Called when peer data changes (from AwarenessManager subscription)
   */
  onPeersChanged(peers: ReadonlyMap<number, PeerCursor>, now: number): void {
    // Remove stale smoothers
    for (const clientId of this.smoothers.keys()) {
      if (!peers.has(clientId)) {
        this.smoothers.delete(clientId);
        this._needsOverlay = true;
      }
    }

    // Update smoothers for each peer
    for (const [clientId, peer] of peers) {
      if (!peer.cursor) {
        if (this.smoothers.has(clientId)) {
          this.smoothers.delete(clientId);
          this._needsOverlay = true;
        }
        continue;
      }

      let s = this.smoothers.get(clientId);
      if (!s) {
        s = { prev: null, current: null, animStart: 0, animEnd: 0, lastSeq: -1 };
        this.smoothers.set(clientId, s);
      }

      // Skip if same seq (no new data)
      if (peer.seq <= s.lastSeq) continue;

      // Gap detection: if seq jumped, snap instead of lerp
      const gap = s.lastSeq >= 0 && peer.seq > s.lastSeq + 1;

      if (!s.current || gap) {
        // Snap: no interpolation
        s.prev = null;
        s.current = { x: peer.cursor.x, y: peer.cursor.y };
        s.animStart = 0;
        s.animEnd = 0;
      } else {
        // Lerp: interpolate from current to new
        s.prev = s.current;
        s.current = { x: peer.cursor.x, y: peer.cursor.y };
        s.animStart = now;
        s.animEnd = now + INTERP_WINDOW_MS;
      }

      s.lastSeq = peer.seq;
      this._needsOverlay = true;
    }
  }

  /**
   * Called at render time to get interpolated cursor positions
   */
  getInterpolatedCursors(peers: ReadonlyMap<number, PeerCursor>, now: number): InterpolatedCursor[] {
    const result: InterpolatedCursor[] = [];

    for (const [clientId, peer] of peers) {
      if (!peer.cursor) continue;

      const s = this.smoothers.get(clientId);
      if (!s || !s.current) {
        // No smoother yet, use raw position
        result.push({
          clientId,
          userId: peer.userId,
          name: peer.name,
          color: peer.color,
          x: peer.cursor.x,
          y: peer.cursor.y,
        });
        continue;
      }

      let x = s.current.x;
      let y = s.current.y;

      // Apply interpolation if in animation window
      if (s.prev && s.animEnd > 0 && now < s.animEnd) {
        const t = Math.min(1, Math.max(0, (now - s.animStart) / (s.animEnd - s.animStart)));
        x = s.prev.x + (s.current.x - s.prev.x) * t;
        y = s.prev.y + (s.current.y - s.prev.y) * t;
      }

      result.push({
        clientId,
        userId: peer.userId,
        name: peer.name,
        color: peer.color,
        x,
        y,
      });
    }

    return result;
  }

  /**
   * Returns true if any cursor is mid-interpolation
   * Used by render loop to know if more frames are needed
   */
  isAnimating(now: number): boolean {
    for (const s of this.smoothers.values()) {
      if (s.animEnd > now) return true;
    }
    return false;
  }

  /**
   * Returns true if overlay needs redraw due to cursor changes
   * Clears the flag after reading (one-shot)
   */
  needsOverlayInvalidation(): boolean {
    const needs = this._needsOverlay;
    this._needsOverlay = false;
    return needs;
  }

  clear(): void {
    this.smoothers.clear();
    this._needsOverlay = false;
  }
}
```

**Future AnimationController Integration:**
```typescript
// Conceptual - NOT implementing now, but PresenceInterpolator fits this shape
interface AnimationJob {
  id: string;
  update(now: number): void;
  isComplete(): boolean;
  needsBaseInvalidation(): boolean;
  needsOverlayInvalidation(): boolean;
}

class PresenceAnimationJob implements AnimationJob {
  constructor(private interpolator: PresenceInterpolator) {}

  update(now: number): void {
    // Called by AnimationController on each tick
  }

  isComplete(): boolean {
    return !this.interpolator.isAnimating(performance.now());
  }

  needsBaseInvalidation(): boolean {
    return false; // Presence never needs base canvas
  }

  needsOverlayInvalidation(): boolean {
    return this.interpolator.needsOverlayInvalidation() ||
           this.interpolator.isAnimating(performance.now());
  }
}
```

### 2.4 Simplified presence-cursors.ts

```typescript
// client/src/renderer/layers/presence-cursors.ts (~80 lines)
import type { ViewTransform } from '@avlo/shared';
import type { InterpolatedCursor } from '../presence-interpolator';

export interface RenderableCursor extends InterpolatedCursor {}

/**
 * Draw cursor pointers and name labels for presence.
 * NO trails, NO resampling, NO animation (interpolation handled upstream).
 */
export function drawCursors(
  ctx: CanvasRenderingContext2D,
  cursors: RenderableCursor[],
  viewTransform: ViewTransform,
  gates: { awarenessReady: boolean },
): void {
  // Only check awarenessReady - no firstSnapshot dependency
  if (!gates.awarenessReady) return;

  for (const cursor of cursors) {
    const [cx, cy] = viewTransform.worldToCanvas(cursor.x, cursor.y);
    drawCursorPointer(ctx, cx, cy, cursor.color);
    drawNameLabel(ctx, cx, cy, cursor.name, cursor.color);
  }
}

function drawCursorPointer(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  color: string,
): void {
  ctx.save();
  ctx.fillStyle = color;
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.3)';
  ctx.lineWidth = 1;

  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x - 4, y + 10);
  ctx.lineTo(x + 1, y + 7);
  ctx.lineTo(x + 6, y + 12);
  ctx.closePath();

  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

function drawNameLabel(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  name: string,
  color: string,
): void {
  ctx.save();

  const labelX = x + 8;
  const labelY = y + 14;

  ctx.font = '11px system-ui, -apple-system, sans-serif';
  const metrics = ctx.measureText(name);
  const padding = 4;
  const width = metrics.width + padding * 2;
  const height = 16;

  ctx.fillStyle = color;
  ctx.globalAlpha = 0.9;
  ctx.beginPath();
  ctx.roundRect(labelX, labelY, width, height, height / 2);
  ctx.fill();

  ctx.fillStyle = '#FFFFFF';
  ctx.globalAlpha = 1;
  ctx.fillText(name, labelX + padding, labelY + 12);

  ctx.restore();
}

// Backward compatibility stub - trails are gone
export function clearCursorTrails(): void {
  // No-op
}
```

### 2.5 New Data Flow

```
                    ┌─────────────────────────────────────────┐
                    │           Y.Awareness update            │
                    └─────────────────┬───────────────────────┘
                                      │
                                      ▼
                    ┌─────────────────────────────────────────┐
                    │  AwarenessManager.handleAwarenessUpdate │
                    │  - Update peerCursors Map (raw data)    │
                    │  - Notify subscribers                   │
                    └─────────────────┬───────────────────────┘
                                      │
           ┌──────────────────────────┼──────────────────────────┐
           │                          │                          │
           ▼                          ▼                          ▼
┌─────────────────────┐   ┌─────────────────────┐   ┌─────────────────────┐
│   React Components  │   │  OverlayRenderLoop  │   │    Other Loops      │
│   (via subscription)│   │  (subscribed)       │   │                     │
└─────────────────────┘   └──────────┬──────────┘   └─────────────────────┘
                                     │
                                     ▼
                    ┌─────────────────────────────────────────┐
                    │  PresenceInterpolator.onPeersChanged()  │
                    │  - Update smoothers                     │
                    │  - Set needsOverlayInvalidation         │
                    └─────────────────┬───────────────────────┘
                                      │
                                      ▼
                    ┌─────────────────────────────────────────┐
                    │  invalidateAll() if needed              │
                    └─────────────────┬───────────────────────┘
                                      │
                                      ▼
                    ┌─────────────────────────────────────────┐
                    │  OverlayRenderLoop.frame()              │
                    │  - getInterpolatedCursors(peers, now)   │
                    │  - drawCursors(ctx, cursors, view, gates)│
                    │  - if (isAnimating()) invalidateAll()   │
                    └─────────────────────────────────────────┘
```

**Key Differences from Current:**
1. **Event-driven** - No RAF polling for presence
2. **No snapshot intermediary** - Direct subscription
3. **Render-time interpolation** - Correct architectural layer
4. **Only `awarenessReady` gate** - No `firstSnapshot` dependency

---

## Part 3: Implementation Steps

### Phase 1: Create Gate Store (First)

**Step 1.1: Create gate-store.ts**

Create `client/src/stores/gate-store.ts` as shown in 2.1 above.

**Step 1.2: Update RoomDocManager to use Gate Store**

```typescript
// In room-doc-manager.ts

// ADD: Import gate store factory and whenGateOpen utility
import { createGateStore, whenGateOpen, GateStore, GateName, selectGates } from '@/stores/gate-store';

// CHANGE: Replace gate-related fields
// DELETE these fields:
// - private gates = { idbReady: false, ... }
// - private gateSubscribers = new Set<...>()
// - private gateCallbacks: Map<string, Set<() => void>> = new Map()
// - private lastGateState: typeof this.gates | null = null
// - private gateDebounceTimer: ReturnType<typeof setTimeout> | null = null
//
// KEEP this field (timeouts are side effects, not state):
// - private gateTimeouts: Map<string, ReturnType<typeof setTimeout>> = new Map()

// ADD: Store instance
private gateStore: GateStore;

// In constructor:
this.gateStore = createGateStore();

// REPLACE openGate() - now just delegates to store:
private openGate(gate: GateName): void {
  this.gateStore.getState().openGate(gate);
  // NOTE: No need to call notifyGateChange() - Zustand notifies subscribers automatically
  // NOTE: No need to iterate gateCallbacks - whenGateOpen() handles this via subscriptions
}

// REPLACE closeGate() - now just delegates to store:
private closeGate(gate: GateName): void {
  this.gateStore.getState().closeGate(gate);
}

// REPLACE whenGateOpen() - now delegates to utility function:
private whenGateOpen(gate: GateName): Promise<void> {
  return whenGateOpen(this.gateStore, gate);
}

// REPLACE getGateStatus() - simplified:
public getGateStatus() {
  return selectGates(this.gateStore.getState());
}

// REPLACE subscribeGates() - simplified one-liner:
public subscribeGates(cb: (gates: ReturnType<typeof selectGates>) => void): () => void {
  return this.gateStore.subscribe(selectGates, cb);
  // NOTE: No custom equalityFn needed - Zustand's subscribeWithSelector
  // does shallow equality by default, and our selector returns same shape
}

// ADD: Expose store for direct access (render loops, React hooks)
public getGateStore(): GateStore {
  return this.gateStore;
}

// In destroy():
// - Keep: clearing gateTimeouts (they're still managed here)
// - Add: this.gateStore.getState().resetGates()
// - Delete: clearing gateDebounceTimer, gateCallbacks, gateSubscribers

// DELETE these methods entirely:
// - notifyGateChange() (~30 lines) - Zustand handles notification
```

**Timeout Management (stays in RoomDocManager as side effects):**
```typescript
// Timeouts are NOT state - they're side effects that trigger state changes
// Keep gateTimeouts Map, but simplify usage:

private initializeIndexedDBProvider(): void {
  // ...
  const timeoutId = setTimeout(() => {
    this.openGate('idbReady');  // ← Now uses store action
  }, 2000);
  this.gateTimeouts.set('idbReady', timeoutId);

  this.indexeddbProvider.whenSynced.then(() => {
    const timeout = this.gateTimeouts.get('idbReady');
    if (timeout) {
      clearTimeout(timeout);
      this.gateTimeouts.delete('idbReady');
    }
    this.openGate('idbReady');  // ← Now uses store action
  });
}
```

**Step 1.3: Update use-connection-gates.ts**

```typescript
// client/src/hooks/use-connection-gates.ts (~25 lines - down from ~70)
//
// DELETED: GateSnapshot type, encodeGates(), decodeGates()
// DELETED: queueMicrotask wrapper
// These hacks were needed because useSyncExternalStore requires stable snapshots.
// Zustand's useStore handles this automatically with selector equality checking.

import { useStore } from 'zustand';
import { useRoomDoc } from './use-room-doc';
import { selectGates } from '@/stores/gate-store';

export function useConnectionGates(roomId: string) {
  const room = useRoomDoc(roomId);
  const gateStore = room.getGateStore();

  // Direct Zustand subscription - NO encoding hack needed!
  // NO queueMicrotask needed - Zustand handles React batching properly
  const gates = useStore(gateStore, selectGates);

  return {
    gates,
    isOffline: !gates.wsConnected,
    isOnline: gates.wsSynced,
    hasIDBReady: gates.idbReady,
    hasAwareness: gates.awarenessReady,
    // REMOVED: hasFirstSnapshot (not needed - RenderLoop handles docVersion)
  };
}

// Re-export for convenience
export type { GateState } from '@/stores/gate-store';
```

**Summary of RoomDocManager deletions for gate refactor:**

| Lines (approx) | Code | Reason |
|----------------|------|--------|
| 189-196 | `private gates = {...}` | Replaced by gateStore |
| 197-198 | `gateCallbacks`, type | Replaced by `whenGateOpen()` utility |
| 201-202 | `lastGateState`, `gateDebounceTimer` | Not needed with Zustand |
| 135 | `gateSubscribers` Set | Replaced by store subscriptions |
| 744-758 | `subscribeGates()` body | Simplified to one-liner |
| 1542-1572 | `openGate()` body | Simplified to one-liner |
| 1574-1580 | `closeGate()` body | Simplified to one-liner |
| 1583-1614 | `notifyGateChange()` entirely | Zustand handles this |
| 1616-1627 | `whenGateOpen()` body | Delegates to utility |
| destroy() | ~15 lines gate cleanup | Simplified |

**Net gate-related reduction in RoomDocManager:** ~80 lines

**Step 1.4: Remove `firstSnapshot` gate entirely**

The `firstSnapshot` gate is unnecessary because RenderLoop already renders based on `docVersion` changes.

```typescript
// DELETE from RoomDocManager:
// - private sawAnyDocUpdate = false;  (line ~166)
// - All references to gates.firstSnapshot
// - The check in buildSnapshot() that opens firstSnapshot gate (lines ~1700-1702)

// In handleYDocUpdate():
// DELETE: this.sawAnyDocUpdate = true;

// In buildSnapshot():
// DELETE: if (!this.gates.firstSnapshot && this.sawAnyDocUpdate) {
//           this.openGate('firstSnapshot');
//         }

// In openGate():
// DELETE: Special handling for firstSnapshot + awarenessReady combination
```

**Search and remove all `firstSnapshot` references:**
```bash
# Find all references to remove:
grep -r "firstSnapshot" client/src/
grep -r "sawAnyDocUpdate" client/src/
```

Expected locations to update:
- `room-doc-manager.ts` - Remove gate, field, and all checks
- `use-connection-gates.ts` - Remove `hasFirstSnapshot` from return (already done in Step 1.3)
- Any component that checks `gates.firstSnapshot` - Remove the check or replace with `idbReady`

---

### Phase 2: Create AwarenessManager (Second)

**Step 2.1: Create awareness-manager.ts**

Create `client/src/lib/awareness-manager.ts` as shown in 2.2 above.

**Step 2.2: Create backpressure checker in RoomDocManager**

```typescript
// In room-doc-manager.ts

// ADD: Backpressure checker factory
private createBackpressureChecker(): BackpressureChecker {
  return () => {
    try {
      const ws: WebSocket | undefined = (this.websocketProvider as any)?.ws;
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        return { shouldSkip: false, shouldDegrade: false, shouldRecover: false };
      }

      const bufferedAmount = ws.bufferedAmount ?? 0;
      const high = bufferedAmount > AWARENESS_CONFIG.WEBSOCKET_BUFFER_HIGH_BYTES;
      const critical = bufferedAmount > AWARENESS_CONFIG.WEBSOCKET_BUFFER_CRITICAL_BYTES;

      return {
        shouldSkip: high,
        shouldDegrade: critical,
        shouldRecover: !high,
      };
    } catch {
      return { shouldSkip: false, shouldDegrade: false, shouldRecover: false };
    }
  };
}
```

**Step 2.3: Integrate AwarenessManager into RoomDocManager**

```typescript
// In room-doc-manager.ts

// ADD: Import
import { AwarenessManager, BackpressureChecker } from './awareness-manager';

// ADD: Field
private awarenessManager: AwarenessManager | null = null;

// In constructor, after yAwareness creation:
this.awarenessManager = new AwarenessManager({
  userId: this.userId,
  userProfile: this.userProfile,
  yAwareness: this.yAwareness,
  checkBackpressure: this.createBackpressureChecker(),
  isGateOpen: () => this.gateStore.getState().awarenessReady,
});

// REPLACE updateCursor():
public updateCursor(worldX: number | undefined, worldY: number | undefined): void {
  this.awarenessManager?.updateCursor(worldX, worldY);
}

// REPLACE updateActivity():
public updateActivity(activity: 'idle' | 'drawing' | 'typing'): void {
  this.awarenessManager?.updateActivity(activity);
}

// ADD: Expose AwarenessManager for direct subscription
public getAwarenessManager(): AwarenessManager | null {
  return this.awarenessManager;
}

// In WebSocket status handler (connected):
this.awarenessManager?.onGateOpen();

// In WebSocket status handler (disconnected):
this.awarenessManager?.onGateClose();

// In destroy():
this.awarenessManager?.destroy();
this.awarenessManager = null;
```

**DELETE from RoomDocManager:**
- Lines 168-187: Awareness state fields
- Lines 269-275: Throttle setup
- Lines 370-440: `ingestAwareness()`, `getDisplayCursor()`
- Lines 442-489: `buildPresenceView()` (simplified version remains for backward compat during migration)
- Lines 491-606: `sendAwareness()` pipeline, `scheduleAwarenessSend()`
- Lines 609-650: `updateCursor()`, `updateActivity()` (replaced)
- Lines 814-851: Custom throttle implementation
- Lines 1394-1436: `_onAwarenessUpdate` handler (moved to AwarenessManager)

---

### Phase 3: Create PresenceInterpolator (Third)

**Step 3.1: Create presence-interpolator.ts**

Create `client/src/renderer/presence-interpolator.ts` as shown in 2.3 above.

**Step 3.2: Simplify presence-cursors.ts**

Replace `client/src/renderer/layers/presence-cursors.ts` with simplified version from 2.4.

---

### Phase 4: Update OverlayRenderLoop (Fourth)

**Step 4.1: Subscribe to AwarenessManager directly**

```typescript
// In OverlayRenderLoop.ts

// ADD: Imports
import { AwarenessManager, PeerCursor } from '@/lib/awareness-manager';
import { PresenceInterpolator, InterpolatedCursor } from './presence-interpolator';
import { drawCursors } from './layers/presence-cursors';

// ADD: Fields
private presenceInterpolator = new PresenceInterpolator();
private awarenessUnsub: (() => void) | null = null;
private peerCursors: ReadonlyMap<number, PeerCursor> = new Map();

// In start():
// Subscribe to AwarenessManager (get from room-runtime)
const awarenessManager = getActiveRoom()?.roomDoc?.getAwarenessManager();
if (awarenessManager) {
  this.awarenessUnsub = awarenessManager.subscribe((peers) => {
    this.peerCursors = peers;
    this.presenceInterpolator.onPeersChanged(peers, performance.now());
    if (this.presenceInterpolator.needsOverlayInvalidation()) {
      this.invalidateAll();
    }
  });
}

// In frame():
const now = performance.now();
const gates = getGateStatus();

// Draw presence (only needs awarenessReady now)
if (gates.awarenessReady && this.peerCursors.size > 0) {
  const cursors = this.presenceInterpolator.getInterpolatedCursors(this.peerCursors, now);
  ctx.save();
  ctx.setTransform(vp.dpr, 0, 0, vp.dpr, 0, 0);
  drawCursors(ctx, cursors, view, { awarenessReady: gates.awarenessReady });
  ctx.restore();

  // Keep animating if interpolation in progress
  if (this.presenceInterpolator.isAnimating(now)) {
    this.invalidateAll();
  }
}

// In stop():
this.awarenessUnsub?.();
this.awarenessUnsub = null;
this.presenceInterpolator.clear();
```

**Step 4.2: Remove snapshot.presence usage**

Remove references to `snapshot.presence` in OverlayRenderLoop - presence comes directly from AwarenessManager now.

---

### Phase 5: Remove Presence from Snapshot (Fifth)

**Step 5.1: Remove presence from Snapshot interface**

In `packages/shared/src/types/snapshot.ts`:
- Remove `presence: PresenceView;` from Snapshot interface
- Remove `presence` from `createEmptySnapshot()`

**Step 5.2: Remove presence from buildSnapshot()**

In `room-doc-manager.ts`:
- Remove `presence: this.buildPresenceView()` from `buildSnapshot()`
- Delete `buildPresenceView()` method entirely

**Step 5.3: Update consumers**

Update any code that reads `snapshot.presence` to use AwarenessManager subscription instead.

---

### Phase 6: Remove Dead Code (Sixth)

**Step 6.1: Delete from RoomDocManager**

- `PeerSmoothing` interface (lines 92-108)
- `peerSmoothers` Map (line 186)
- `presenceAnimDeadlineMs` (line 187)
- `updatePresenceThrottled` and cleanup (lines 138-141, 269-275)
- `presenceSubscribers` Set (line 134) - if no longer needed
- `subscribePresence()` method (lines 729-742) - if no longer needed

**Step 6.2: Delete files**

- Delete `client/src/lib/ring-buffer.ts` (if not used elsewhere)

**Step 6.3: Clean up presence-cursors.ts**

All trail-related code should be gone now.

---

## Part 4: Files Summary

### Files to Create

| File | Lines | Purpose |
|------|-------|---------|
| `client/src/stores/gate-store.ts` | ~80 | Zustand store for gates |
| `client/src/lib/awareness-manager.ts` | ~220 | Awareness sending and peer tracking |
| `client/src/renderer/presence-interpolator.ts` | ~120 | Render-time cursor interpolation |

### Files to Modify

| File | Changes |
|------|---------|
| `client/src/lib/room-doc-manager.ts` | Delete ~500 lines, add ~50 lines |
| `client/src/renderer/layers/presence-cursors.ts` | Replace ~356 lines with ~80 lines |
| `client/src/renderer/OverlayRenderLoop.ts` | Modify ~80 lines |
| `client/src/hooks/use-connection-gates.ts` | Simplify ~70 lines to ~30 lines |
| `packages/shared/src/types/snapshot.ts` | Remove `presence`, `view`, `createdAt` |
| `packages/shared/src/types/awareness.ts` | Remove `lastSeen` from PresenceView |

### Files to Delete

| File | Reason |
|------|--------|
| `client/src/lib/ring-buffer.ts` | No longer needed (metrics) |

---

## Part 5: Testing Checklist

### Gate Store Tests
- [ ] `openGate()` transitions closed → open
- [ ] `openGate()` is no-op when already open
- [ ] `closeGate()` transitions open → closed
- [ ] `closeGate()` is no-op when already closed
- [ ] Zustand subscriptions fire on change
- [ ] Selectors compute derived state correctly

### AwarenessManager Tests
- [ ] `updateCursor()` quantizes and marks dirty
- [ ] `updateActivity()` marks dirty on change
- [ ] `subscribe()` / unsubscribe works
- [ ] `handleAwarenessUpdate()` processes peers correctly
- [ ] Backpressure callback is respected
- [ ] Gate check prevents sending when closed
- [ ] `onGateOpen()` triggers pending send
- [ ] `onGateClose()` clears state

### PresenceInterpolator Tests
- [ ] `onPeersChanged()` updates smoothers
- [ ] Gap detection snaps instead of lerping
- [ ] `getInterpolatedCursors()` computes lerp correctly
- [ ] `isAnimating()` returns correct state
- [ ] `needsOverlayInvalidation()` is one-shot

### Integration Tests
- [ ] Cursor appears when peer joins
- [ ] Cursor disappears when peer leaves
- [ ] Cursor interpolates smoothly
- [ ] Offline/reconnect behavior works
- [ ] No memory leaks on room change

### Visual Tests
- [ ] Cursor pointer renders correctly
- [ ] Name label renders correctly
- [ ] No trails (verify removal)
- [ ] No visual regression

---

## Part 6: Migration Notes

### Breaking Changes
- `snapshot.presence` removed (use AwarenessManager subscription)
- `snapshot.view` removed (use `camera-store.getViewTransform()`)
- `snapshot.createdAt` removed (not used)
- `PresenceView.users[].lastSeen` removed (not used)
- `clearCursorTrails()` is now a no-op
- **`firstSnapshot` gate removed entirely** - RenderLoop already renders on every `docVersion` update, so there's no risk of rendering before data exists. Remove all `firstSnapshot` checks from codebase.
- `hasFirstSnapshot` removed from `useConnectionGates` return
- Gate store is now a Zustand store (internal change, API unchanged)

### Backward Compatibility
- `IRoomDocManager.updateCursor()` unchanged
- `IRoomDocManager.updateActivity()` unchanged
- `IRoomDocManager.subscribeGates()` unchanged (implementation different, signature same)
- `IRoomDocManager.getGateStatus()` returns same shape (minus `firstSnapshot`)
- **NEW:** `IRoomDocManager.getGateStore()` exposes Zustand store for direct access

### IRoomDocManager Interface Updates

```typescript
// Update the interface in room-doc-manager.ts:
export interface IRoomDocManager {
  // ... existing methods unchanged ...

  // UPDATED: Remove firstSnapshot from gate status return type
  getGateStatus(): Readonly<{
    idbReady: boolean;
    wsConnected: boolean;
    wsSynced: boolean;
    awarenessReady: boolean;
    // REMOVED: firstSnapshot: boolean;
  }>;

  // UPDATED: subscribeGates callback type matches getGateStatus
  subscribeGates(
    cb: (gates: Readonly<{
      idbReady: boolean;
      wsConnected: boolean;
      wsSynced: boolean;
      awarenessReady: boolean;
    }>) => void,
  ): Unsub;

  // NEW: Direct store access for advanced use cases
  getGateStore(): GateStore;
}
```

---

## Summary

| Metric | Before | After | Change |
|--------|--------|-------|--------|
| room-doc-manager.ts | ~1915 lines | ~1320 lines | -595 |
| presence-cursors.ts | ~356 lines | ~80 lines | -276 |
| use-connection-gates.ts | ~70 lines | ~25 lines | -45 |
| Gate management | Callback-based | Zustand store | Much simpler |
| Presence data flow | Through snapshot | Direct subscription | Decoupled |
| gate-store.ts | 0 | ~100 lines | +100 |
| awareness-manager.ts | 0 | ~220 lines | +220 |
| presence-interpolator.ts | 0 | ~120 lines | +120 |
| **Net** | | | **~350+ lines** |

### Key Wins
1. **Gates as Zustand store** - No callbacks, React-friendly, built-in equality
2. **`whenGateOpen()` with temporary subscriptions** - Clean Promise-based API, auto-cleanup, replaces gateCallbacks Map entirely
3. **No 150ms debounce needed** - Zustand's equality checking handles flicker prevention
4. **No string encoding hack** - `use-connection-gates.ts` dramatically simplified
5. **`firstSnapshot` gate removed** - RenderLoop already handles docVersion updates
6. **Backpressure in AwarenessManager** - Tightly coupled where it belongs
7. **No cursor trails** - Simpler, cleaner presence rendering
8. **Lodash throttle** - Battle-tested, less custom code
9. **Render-time interpolation** - Correct architectural layer
10. **Event-driven presence** - No RAF polling
11. **Removed mobile checks** - No arbitrary restrictions
12. **Future AnimationController ready** - PresenceInterpolator fits job-based model

### Implementation Order (Recommended)
1. **Phase 1: Gate Store** - Create store, migrate RoomDocManager gates, update hook
2. **Phase 2: AwarenessManager** - Extract awareness logic
3. **Phase 3: PresenceInterpolator** - Move interpolation to render time
4. **Phase 4: Update OverlayRenderLoop** - Subscribe to AwarenessManager
5. **Phase 5: Remove presence from Snapshot** - Clean up data flow
6. **Phase 6: Delete dead code** - Final cleanup

---

*Plan revised 2025-12-15*
