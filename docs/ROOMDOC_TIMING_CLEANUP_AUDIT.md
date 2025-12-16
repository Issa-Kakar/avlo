# RoomDocManager Timing & Cleanup Audit

**Date:** 2025-12-14
**Branch:** `cleanup/legacy-renderer-cleanup`

---

## Executive Summary

This document answers your questions about the RoomDocManager timing infrastructure, RAF loop purpose, viewTransform in snapshot, throttling patterns, and proposes concrete cleanup actions.

---

## Question 1: `getViewTransform()` in RoomDocManager - Is It Used?

### Investigation Results

**The `snapshot.view` field is DEAD CODE.**

I searched for all usages of `snapshot.view`:

```typescript
// Only found in tests (Canvas.test.tsx):
expect(snapshot.view.scale).toBe(1);
expect(snapshot.view.pan).toEqual({ x: 0, y: 0 });
const [x, y] = snapshot.view.worldToCanvas(100, 200);
```

**No production code reads `snapshot.view`**. All rendering code reads directly from `camera-store`:
- `RenderLoop.ts`: Uses `getViewTransform()` from `camera-store.ts`
- `OverlayRenderLoop.ts`: Uses `getViewTransform()` from `camera-store.ts`
- `CanvasRuntime.ts`: Uses `useCameraStore.getState()`

### Analysis

The `getViewTransform()` method in `RoomDocManager` creates identity transforms (hardcoded `scale: 1`, `pan: {0, 0}`). It was intended for a "snapshot contains view state" pattern that was never fully implemented. The camera store is the single source of truth.

### Recommendation: REMOVE

**Files to modify:**
1. `packages/shared/src/types/snapshot.ts` - Remove `view: ViewTransform` from `Snapshot` interface, remove from `createEmptySnapshot()`
2. `client/src/lib/room-doc-manager.ts` - Delete `getViewTransform()` method, remove `view: this.getViewTransform()` from `buildSnapshot()`
3. `client/src/canvas/__tests__/Canvas.test.tsx` - Remove tests that reference `snapshot.view`

---

## Question 2: `createdAt` in Snapshot - Is It Used?

### Investigation Results

**`snapshot.createdAt` is NEVER read in production code.**

I searched: `grep -r "snapshot\.createdAt|\.createdAt"` → No matches.

It's set in two places in `room-doc-manager.ts`:
1. `buildSnapshot()` line 1695: `createdAt: Date.now()`
2. Presence-only update line 1039: `createdAt: Date.now()`

### Recommendation: REMOVE

**Files to modify:**
1. `packages/shared/src/types/snapshot.ts` - Remove `createdAt: number` from `Snapshot`, remove from `createEmptySnapshot()`
2. `client/src/lib/room-doc-manager.ts` - Remove `createdAt` assignments in `buildSnapshot()` and the presence-only update block

---

## Question 3: The RAF Loop in RoomDocManager - What Is It Actually Doing?

### Current Architecture (Two RAF Loops!)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        RoomDocManager RAF Loop                               │
│  - Runs at ~60 FPS via requestAnimationFrame                                │
│  - Checks isDirty / presenceDirty flags                                      │
│  - Calls buildSnapshot() when isDirty                                        │
│  - Calls publishSnapshot() to notify subscribers                             │
│  - Builds presence interpolation every frame                                 │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    │ subscribeSnapshot()
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                        CanvasRuntime                                         │
│  - Receives snapshot in callback                                             │
│  - Extracts dirtyPatch, evicts cache, invalidates renderLoop                 │
│  - Invalidates overlayLoop                                                   │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    │ invalidateWorld() / invalidateAll()
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                        RenderLoop RAF Loop                                   │
│  - Event-driven (only runs when needsFrame=true)                             │
│  - Has its own FPS throttling (TARGET_FPS, MOBILE_FPS, HIDDEN_FPS)          │
│  - Handles dirty rect optimization, full clear promotion                     │
│  - Draws background + objects                                                │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│                        OverlayRenderLoop RAF Loop                            │
│  - Event-driven (only runs when needsFrame=true)                             │
│  - Full clear every frame (cheap)                                            │
│  - Draws preview + presence cursors                                          │
└─────────────────────────────────────────────────────────────────────────────┘
```

### The Problem You Identified

**You're right - it IS strange!** The RoomDocManager RAF loop:
1. Runs continuously at 60 FPS regardless of whether there's anything to do
2. Presence interpolation happens in `buildPresenceView()` which is called every frame
3. The render loops have their own event-driven scheduling that only runs when dirty

### What the RoomDocManager RAF Loop Does

```typescript
private startPublishLoop(): void {
  const rafLoop = () => {
    const now = this.clock.now();

    // Force presence publish during interpolation window
    if (!this.publishState.presenceDirty && now < this.presenceAnimDeadlineMs) {
      this.publishState.presenceDirty = true;
    }

    if (this.publishState.isDirty) {
      // Document changed - expensive full snapshot build
      const newSnapshot = this.buildSnapshot();
      this.publishSnapshot(newSnapshot);  // Notifies subscribers
      this.publishState.isDirty = false;
      this.publishState.presenceDirty = false;
    } else if (this.publishState.presenceDirty) {
      // Presence-only - cheap, reuse most of snapshot
      const livePresence = this.buildPresenceView();  // INTERPOLATION HAPPENS HERE
      const snap = { ...prev, presence: livePresence, createdAt: Date.now() };
      this.publishSnapshot(snap);
      this.publishState.presenceDirty = false;
    }

    if (!this.destroyed) {
      this.publishState.rafId = this.frames.request(rafLoop);  // ALWAYS schedules next
    }
  };

  this.publishState.rafId = this.frames.request(rafLoop);
}
```

### Why This Design Exists

1. **Cursor interpolation** - The `presenceAnimDeadlineMs` forces continuous publishing during the 66ms interpolation window
2. **Batching** - Multiple Y.Doc updates within a frame are coalesced into one snapshot
3. **Test determinism** - The `frames` abstraction allows tests to control frame timing

### The Better Design (Your Insight Is Correct)

**Interpolation should happen in the OverlayRenderLoop**, not in snapshot publishing:

```
Current:
  RoomDocManager RAF → builds interpolated positions → publishes snapshot
  OverlayRenderLoop RAF → draws snapshot.presence (already interpolated)

Better:
  RoomDocManager → publishes raw cursor positions when awareness changes (event-driven)
  OverlayRenderLoop RAF → interpolates positions AT RENDER TIME
```

This would make RoomDocManager's loop event-driven:
- Only publish when `isDirty` (doc changes)
- Only publish when awareness actually changes
- No continuous 60 FPS polling

---

## Question 4: Ring Buffer & Timing Abstractions - What's Needed?

### Current Usage

**`UpdateRing`** (ring-buffer.ts):
```typescript
// Only used for "metrics" - storing pending updates
this.publishState.pendingUpdates = new UpdateRing(16);
// In handleYDocUpdate:
this.publishState.pendingUpdates.push({ update, origin, time: this.clock.now() });
```
This is never read anywhere except `.push()`. It's pure bloat for "future metrics".

**Timing Abstractions** (timing-abstractions.ts):
```typescript
// Used in room-doc-manager.ts:
this.clock.now()  // For presence timestamps, publish timing, interpolation
this.frames.request()  // For RAF loop
this.frames.cancel()  // For cleanup

// Used in tests:
TestClock.advance()  // Deterministic time control
TestFrameScheduler.advanceFrame()  // Synchronous frame stepping
```

### What Tests Actually Need

From `test-helpers.ts`:
```typescript
export function createTestManager(roomId: RoomId = 'test-room') {
  const clock = new TestClock();
  const frames = new TestFrameScheduler();
  // ...
  return { manager, clock, frames, registry, cleanup };
}

export async function waitForSnapshot(manager, frames, clock) {
  frames.advanceFrame(clock.now());  // Needs synchronous frame control
}
```

**Tests need:**
1. Deterministic time (`clock.advance()`)
2. Synchronous frame control (`frames.advanceFrame()`)

### Recommendation

**Keep** timing abstractions (they're ~190 lines and essential for deterministic tests).

**Remove** the ring buffer - it's dead code:
1. Delete `client/src/lib/ring-buffer.ts`
2. Remove `pendingUpdates` from `publishState`
3. Remove the `.push()` call in `handleYDocUpdate`

**Simplify** `this.clock.now()` usage:
- For presence timestamps, use `Date.now()` (already done in `sendAwareness`)
- For interpolation timing, use `performance.now()` directly
- Keep `this.clock.now()` only for test-injected timing

---

## Question 5: `this.clock.now()` vs Standard Timing

### Current Usage Analysis

| Location | Current | Purpose | Should Use |
|----------|---------|---------|------------|
| `buildPresenceView()` line 444 | `this.clock.now()` | Get current time for interpolation | `performance.now()` (or keep for tests) |
| RAF loop timing lines 1011-1047 | `this.clock.now()` | Track publish timing | Remove entirely (unused metrics) |
| `handleYDocUpdate` line 1296 | `this.clock.now()` | Ring buffer timestamp | Remove (ring buffer removal) |
| Awareness handler line 1397 | `this.clock.now()` | Ingest timestamp | `performance.now()` |
| `sendAwareness()` line 599 | `Date.now()` | Awareness `ts` field | Keep as-is (wall clock for peers) |

### Recommendation

1. **For interpolation timing**: Use `performance.now()` directly in production, with test injection via constructor option
2. **Remove**: All `publishCostMs`, `lastPublishTime` tracking - it's unused metrics bloat

The simplified pattern:
```typescript
// Constructor:
this.getNow = options?.clock?.now.bind(options.clock) ?? (() => performance.now());

// Usage:
const now = this.getNow();
```

---

## Question 6: Throttling & Backpressure - Could Lodash Help?

### Current Throttle Implementation

```typescript
// In room-doc-manager.ts (~40 lines):
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
      lastCallTime = now;
      func.apply(this, args);
    } else if (!timeout) {
      const delay = wait - timeSinceLastCall;
      timeout = setTimeout(() => {
        lastCallTime = Date.now();
        timeout = null;
        func.apply(this, args);
      }, delay);
    }
  };

  const cleanup = () => {
    if (timeout !== null) {
      clearTimeout(timeout);
      timeout = null;
    }
  };

  return { throttled: throttled as T, cleanup };
}
```

### Lodash Throttle Comparison

```typescript
import throttle from 'lodash/throttle';

// Usage would be:
this.updatePresenceThrottled = throttle(
  this.updatePresence.bind(this),
  33,
  { leading: true, trailing: true }
);

// Cleanup:
this.updatePresenceThrottled?.cancel();
```

### Analysis

| Aspect | Current | Lodash |
|--------|---------|--------|
| Bundle size | ~40 lines inline | +4KB (lodash/throttle) |
| Cleanup | Manual `.cleanup()` | `.cancel()` method |
| Behavior | Leading + trailing | Configurable |
| Dependencies | None | Already in lockfile (y-partyserver uses it) |

**Lodash is already in the dependency tree** (via y-partyserver which depends on it).

### Recommendation: YES, Use Lodash

The benefits:
1. **Less custom code** - 40 lines → 2 lines
2. **Battle-tested** - No edge cases to worry about
3. **No new dependency** - Already in the tree
4. **Better API** - `.cancel()` is cleaner than `.cleanup()`

The awareness backpressure code is more complex and custom (WebSocket buffer checking). Keep that as-is, but use lodash for the simple 30Hz presence throttle.

---

## Question 7: Future Architecture - RoomDoc Store with Zustand

### Current Pain Points

1. **Gates boilerplate** - `getGateStatus()` returns object, no selector pattern
2. **Snapshot vs Presence** - Two subscription methods, manual `presenceDirty` tracking
3. **Cursor position boilerplate** - Manual equality checks in `sendAwareness()`
4. **No derived state** - Can't create computed values without re-subscribing

### Proposed: Zustand Vanilla Store

```typescript
// room-doc-store.ts
import { createStore } from 'zustand/vanilla';
import { subscribeWithSelector } from 'zustand/middleware';

interface RoomDocState {
  // Core state
  docVersion: number;
  objectsById: ReadonlyMap<string, ObjectHandle>;
  spatialIndex: ObjectSpatialIndex | null;
  dirtyPatch: DirtyPatch | null;

  // Presence (separate from doc)
  presence: PresenceView;

  // Gates
  gates: {
    idbReady: boolean;
    wsConnected: boolean;
    wsSynced: boolean;
    awarenessReady: boolean;
    firstSnapshot: boolean;
  };
}

export const createRoomDocStore = () => createStore<RoomDocState>()(
  subscribeWithSelector((set) => ({
    docVersion: 0,
    objectsById: new Map(),
    // ...
  }))
);

// Selectors
export const selectDocVersion = (s: RoomDocState) => s.docVersion;
export const selectPresence = (s: RoomDocState) => s.presence;
export const selectGates = (s: RoomDocState) => s.gates;
export const selectIsOnline = (s: RoomDocState) => s.gates.wsConnected;

// Derived store for sorted visible objects (cached)
export const selectVisibleObjects = (s: RoomDocState, viewport: WorldBounds) => {
  // Could be memoized with useMemo pattern
};
```

### Benefits of This Approach

1. **No manual equality checks** - Zustand's `subscribeWithSelector` handles it
2. **Selectors everywhere** - `selectPresence`, `selectDocVersion`, `selectGates`
3. **Event-driven invalidation** - Subscribe to `docVersion` changes instead of RAF polling
4. **Derived state** - Memoized sorted object lists, computed gate combinations
5. **No callback management** - No more `subscribers.add()` / `subscribers.delete()`

### How This Changes the RAF Loop

```typescript
// Current (polling):
const rafLoop = () => {
  if (this.publishState.isDirty) {
    // build and publish
  }
  requestAnimationFrame(rafLoop);  // Always schedules next
};

// Future (event-driven):
// 1. Y.Doc observer fires
// 2. Store.setState({ docVersion: prev + 1, objectsById, dirtyPatch })
// 3. Zustand notifies subscribers (CanvasRuntime, RenderLoop)
// 4. RenderLoop.markDirty() schedules RAF (only when needed)

// No polling loop in RoomDocManager at all!
```

### Presence Interpolation Moves to OverlayRenderLoop

```typescript
// OverlayRenderLoop gets raw cursor positions from store:
const rawPresence = roomDocStore.getState().presence;

// Interpolation happens at render time:
const interpolatedPresence = interpolateCursors(rawPresence, performance.now());
drawPresenceOverlays(ctx, interpolatedPresence, ...);
```

---

## Concrete Cleanup Actions (Ordered by Dependency)

### Phase 1: Safe Removals (No Test Impact)

1. **Remove `view` from Snapshot**
   - `packages/shared/src/types/snapshot.ts` - Remove field and from `createEmptySnapshot()`
   - `client/src/lib/room-doc-manager.ts` - Remove `getViewTransform()` method, remove from `buildSnapshot()`

2. **Remove `createdAt` from Snapshot**
   - `packages/shared/src/types/snapshot.ts` - Remove field
   - `client/src/lib/room-doc-manager.ts` - Remove assignments

3. **Remove ring buffer**
   - Delete `client/src/lib/ring-buffer.ts`
   - Remove `pendingUpdates` from `publishState`
   - Remove the `.push()` in `handleYDocUpdate`

4. **Remove unused metrics**
   - Remove `publishCostMs`, `lastPublishTime` from `publishState`
   - Remove timing calculations in RAF loop

### Phase 2: Simplify Throttling

5. **Use lodash throttle for presence**
   - Add `import throttle from 'lodash/throttle'`
   - Replace custom `throttle()` method with lodash
   - Update cleanup to use `.cancel()`

### Phase 3: Future - Zustand Store Migration

6. **Create `room-doc-store.ts`** with vanilla Zustand
7. **Move state from class fields to store**
8. **Convert subscriptions to Zustand selectors**
9. **Make RAF loop event-driven** (only run when store changes)
10. **Move interpolation to OverlayRenderLoop**

---

## Summary: Your Questions Answered

| Question | Answer |
|----------|--------|
| Is `getViewTransform` in snapshot used? | **NO** - Dead code, camera-store is the source |
| Is `createdAt` used? | **NO** - Dead code, remove it |
| What is the RAF loop doing? | Publishing snapshots at 60 FPS for interpolation - **should be event-driven** |
| Is it strange to interpolate in snapshot vs render? | **YES** - Interpolation should happen in OverlayRenderLoop at render time |
| Can lodash throttle simplify code? | **YES** - Already in dependency tree, would remove ~40 lines |
| Should timing abstractions stay? | **YES** for testing, but simplify production usage |
| Is the ring buffer needed? | **NO** - It's pure metrics bloat, never read |

---

*Audit completed 2025-12-14*
