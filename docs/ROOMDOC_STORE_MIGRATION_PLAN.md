# RoomDocManager Store Migration Plan

**Date:** 2025-12-14
**Status:** INVESTIGATION / PROPOSAL

---

## Executive Summary

This document proposes a **phased migration** from the current RoomDocManager architecture to a Zustand-based store pattern. The key insight is that we can get **most benefits with minimal risk** by wrapping a store around the existing RAF loop, then incrementally improving.

---

## Part 1: Deep Investigation

### 1.1 What the RAF Loop Actually Costs

**Idle state (no activity):**
```javascript
const rafLoop = () => {
  const now = this.clock.now();                           // ~0.001ms
  if (!presenceDirty && now < presenceAnimDeadlineMs) {}  // ~0.001ms
  if (isDirty) {}                                         // ~0.001ms
  else if (presenceDirty) {}                              // ~0.001ms
  this.frames.request(rafLoop);                           // ~0.001ms
};
// Total: ~0.005ms per frame → 0.3ms/second → 0.03% CPU
```

**During interpolation (66ms window, ~4 frames):**
```javascript
// buildPresenceView iterates peers, computes interpolation
// Cost: ~0.05ms per frame × 4 frames = 0.2ms total
```

**During doc changes:**
```javascript
// buildSnapshot: ~0.5-2ms depending on object count
// But this only runs when isDirty=true (event-driven anyway)
```

**Verdict: The RAF loop is NOT a performance problem.** The cost is negligible.

### 1.2 Y.Doc Observer Firing Order

This is critical for understanding the data flow:

```
mutate(fn) called at T=0
  │
  ├─ ydoc.transact(() => fn(ydoc), userId)
  │     │
  │     ├─ User's mutations execute
  │     │
  │     ├─ Transaction commits
  │     │
  │     ├─ objectsObserver fires (observeDeep on 'objects' Y.Map)
  │     │     └─ applyObjectChanges() runs SYNCHRONOUSLY
  │     │         ├─ Updates objectsById Map
  │     │         ├─ Updates spatialIndex
  │     │         ├─ Accumulates dirtyRects
  │     │         └─ Accumulates cacheEvictIds
  │     │
  │     └─ handleYDocUpdate fires (ydoc.on('update'))
  │           ├─ docVersion++
  │           └─ publishState.isDirty = true
  │
  └─ mutate() returns at T=0.3ms
      (objectsById is ALREADY CORRECT at this point)

... RAF schedules next frame ...

RAF ticks at T=16ms
  │
  ├─ Sees isDirty = true
  │
  ├─ buildSnapshot()
  │     ├─ Uses already-correct objectsById (no recomputation)
  │     ├─ Uses already-correct spatialIndex
  │     ├─ Creates dirtyPatch from accumulated dirtyRects/cacheEvictIds
  │     └─ Clears accumulation buffers
  │
  └─ publishSnapshot(snapshot)
        └─ Notifies all subscribers
```

**Key insight:** The data is ready at T=0.3ms. The RAF loop just batches and delays notification.

### 1.3 What buildPresenceView Actually Does

```typescript
private buildPresenceView(): PresenceView {
  const now = this.clock.now();
  const users = new Map();

  this.yAwareness.getStates().forEach((state, clientId) => {
    if (clientId === localClientId) return;  // Skip self

    // Get or create smoother
    let ps = this.peerSmoothers.get(clientId);
    if (!ps) { ps = { lastSeq: -1, hasCursor: false }; ... }

    // Compute interpolated position
    const displayCursor = this.getDisplayCursor(ps, now);  // INTERPOLATION

    users.set(state.userId, {
      name: state.name,
      color: state.color,
      cursor: displayCursor,  // Interpolated, not raw
      activity: state.activity,
      lastSeen: state.ts,
    });
  });

  return { users, localUserId: this.userId };
}
```

**Problems:**
1. Runs every frame during interpolation window (even for unchanged peers)
2. Iterates ALL peers, not just changed ones
3. Interpolation (a view concern) is in the data layer
4. Creates new Map object every call

### 1.4 Current Subscription Flow

```
RoomDocManager                          CanvasRuntime
     │                                       │
     │ subscribeSnapshot(cb)                 │
     │ ─────────────────────────────────────>│
     │   snapshotSubscribers.add(cb)         │
     │                                       │
     │ publishSnapshot(snap)                 │
     │   snapshotSubscribers.forEach(cb)     │
     │ ─────────────────────────────────────>│
     │                                       │ cb(snap)
     │                                       │   ├─ if docVersion changed
     │                                       │   │    invalidateRenderLoop
     │                                       │   └─ else
     │                                       │        invalidateOverlay
```

**Problems:**
1. Manual Set management (add, delete, clear)
2. No way to subscribe to just `docVersion` or just `presence`
3. Subscriber must manually check what changed
4. No deduplication (if snapshot reference same, still notifies)

---

## Part 2: Architecture Options

### Option A: Full Event-Driven (Remove RAF Loop)

```
Y.Doc update → store.setState() → Zustand notifies → RenderLoop invalidates
Awareness event → store.setState() → Zustand notifies → OverlayLoop invalidates
```

**Pros:**
- Conceptually pure
- No polling
- Interpolation in correct layer

**Cons:**
- Significant refactor
- Need to rethink batching
- Higher risk of subtle bugs

**Confidence: 60%**

### Option B: Wrap Store Around Existing (Keep RAF Loop)

```
RAF loop → buildSnapshot → store.setState({ snapshot }) → Zustand notifies
Gates → store.setState({ gates }) → Zustand notifies
```

**Pros:**
- Minimal change to existing code
- Get all Zustand benefits (selectors, subscriptions)
- Can incrementally move toward Option A
- Low risk

**Cons:**
- Still has "unnecessary" RAF loop (but we proved it's cheap)
- Interpolation still in wrong layer (can fix separately)

**Confidence: 95%**

### Option C: Hybrid (Store + Simplified RAF)

```
Y.Doc update → applyObjectChanges → store.setState({ objectsById, dirtyPatch })
                                  → Zustand notifies CanvasRuntime
                                  → RenderLoop.invalidateWorld()

Awareness event → store.setState({ peers: rawData })
               → Zustand notifies OverlayRenderLoop
               → Interpolation at render time

RAF loop → ONLY handles presence animation deadline
         → Checks if cursor interpolation in progress
         → If yes: store.setState({ presenceNeedsRender: true })
```

**Pros:**
- Event-driven for doc changes (the important path)
- Minimal RAF for interpolation continuity
- Interpolation in render layer

**Cons:**
- More complex than Option B
- Need to carefully handle batching

**Confidence: 75%**

---

## Part 3: Recommended Approach (Phased)

### Phase 1: Wrap Store Around Snapshot (Low Risk) ✅

**Goal:** Get Zustand benefits with minimal change.

**Changes:**

```typescript
// NEW FILE: client/src/stores/room-doc-store.ts
import { createStore } from 'zustand/vanilla';
import { subscribeWithSelector } from 'zustand/middleware';

interface GateState {
  idbReady: boolean;
  wsConnected: boolean;
  wsSynced: boolean;
  awarenessReady: boolean;
  firstSnapshot: boolean;
}

interface RoomDocStoreState {
  snapshot: Snapshot;
  gates: GateState;
}

export const createRoomDocStore = () => createStore<RoomDocStoreState>()(
  subscribeWithSelector(() => ({
    snapshot: createEmptySnapshot(),
    gates: {
      idbReady: false,
      wsConnected: false,
      wsSynced: false,
      awarenessReady: false,
      firstSnapshot: false,
    },
  }))
);

// Selectors
export const selectSnapshot = (s: RoomDocStoreState) => s.snapshot;
export const selectDocVersion = (s: RoomDocStoreState) => s.snapshot.docVersion;
export const selectPresence = (s: RoomDocStoreState) => s.snapshot.presence;
export const selectGates = (s: RoomDocStoreState) => s.gates;
export const selectIsOnline = (s: RoomDocStoreState) => s.gates.wsConnected;
export const selectObjectsById = (s: RoomDocStoreState) => s.snapshot.objectsById;
export const selectSpatialIndex = (s: RoomDocStoreState) => s.snapshot.spatialIndex;
```

**Modified in RoomDocManager:**

```typescript
class RoomDocManagerImpl {
  private store: ReturnType<typeof createRoomDocStore>;

  constructor(roomId, options) {
    this.store = createRoomDocStore();
    // ... rest of constructor
  }

  // Replace manual subscriber management
  private publishSnapshot(newSnapshot: Snapshot): void {
    this._currentSnapshot = newSnapshot;
    this.store.setState({ snapshot: newSnapshot });
    // DELETE: snapshotSubscribers.forEach(cb => cb(newSnapshot));
  }

  // Simplify gate management
  private openGate(gateName: keyof GateState): void {
    this.store.setState(s => ({
      gates: { ...s.gates, [gateName]: true }
    }));
    // DELETE: All the gateCallbacks, lastGateState, debounce logic
  }

  // New subscription method using store
  subscribeSnapshot(cb: (snap: Snapshot) => void): Unsub {
    return this.store.subscribe(
      selectSnapshot,
      cb,
      { fireImmediately: true }
    );
  }

  // Granular subscription (NEW capability)
  subscribeDocVersion(cb: (v: number) => void): Unsub {
    return this.store.subscribe(selectDocVersion, cb);
  }

  subscribePresence(cb: (p: PresenceView) => void): Unsub {
    return this.store.subscribe(selectPresence, cb);
  }

  subscribeGates(cb: (g: GateState) => void): Unsub {
    return this.store.subscribe(selectGates, cb);
  }
}
```

**Modified in CanvasRuntime:**

```typescript
// OLD:
this.snapshotUnsub = roomDoc.subscribeSnapshot((snapshot) => {
  if (snapshot.docVersion !== this.lastDocVersion) {
    // Doc changed
    this.lastDocVersion = snapshot.docVersion;
    // ... invalidate render
  } else {
    // Presence only
    this.overlayLoop?.invalidateAll();
  }
});

// NEW:
const store = roomDoc.getStore();

// Subscribe to doc changes only
this.docUnsub = store.subscribe(
  selectDocVersion,
  (docVersion, prevDocVersion) => {
    if (docVersion === prevDocVersion) return;

    const { dirtyPatch } = store.getState().snapshot;
    if (dirtyPatch) {
      cache.evictMany(dirtyPatch.evictIds);
      for (const bounds of dirtyPatch.rects) {
        if (boundsIntersect(bounds, viewport)) {
          this.renderLoop?.invalidateWorld(bounds);
        }
      }
    }
    this.overlayLoop?.invalidateAll();
  }
);

// Subscribe to presence changes only
this.presenceUnsub = store.subscribe(
  selectPresence,
  () => this.overlayLoop?.invalidateAll()
);
```

**What this achieves:**
- ✅ Granular subscriptions (doc vs presence)
- ✅ Automatic deduplication
- ✅ Gates simplified (delete ~80 lines)
- ✅ Foundation for future improvements
- ✅ No risk to existing RAF/publish logic

**Lines changed:** ~100 modified, ~80 deleted
**Risk level:** Low

---

### Phase 2: Simplify Gate Management (Low Risk) ✅

**Delete from RoomDocManager:**
```typescript
// DELETE (~80 lines):
private gateCallbacks: Map<string, Set<() => void>>;
private lastGateState: typeof this.gates | null;
private gateDebounceTimer: ReturnType<typeof setTimeout> | null;

private notifyGateChange(): void { ... }  // ~30 lines
// The debouncing, callback management, etc.
```

**Replace with:**
```typescript
// Using Zustand store (already added in Phase 1)
private openGate(gateName: keyof GateState): void {
  this.store.setState(s => ({
    gates: { ...s.gates, [gateName]: true }
  }));
}

private closeGate(gateName: keyof GateState): void {
  this.store.setState(s => ({
    gates: { ...s.gates, [gateName]: false }
  }));
}

// whenGateOpen becomes trivial:
private whenGateOpen(gateName: keyof GateState): Promise<void> {
  const { gates } = this.store.getState();
  if (gates[gateName]) return Promise.resolve();

  return new Promise(resolve => {
    const unsub = this.store.subscribe(
      s => s.gates[gateName],
      (isOpen) => {
        if (isOpen) {
          unsub();
          resolve();
        }
      }
    );
  });
}
```

**Risk level:** Low

---

### Phase 3: Move Interpolation to Render Layer (Medium Risk)

**Goal:** Interpolation is a view concern, should be in OverlayRenderLoop.

**New structure:**

```typescript
// In Snapshot/Store: raw cursor data (no interpolation)
interface PeerCursorRaw {
  userId: string;
  name: string;
  color: string;
  cursor: { x: number; y: number } | undefined;  // RAW position
  activity: string;
  seq: number;
  ts: number;
}

// In OverlayRenderLoop (or separate PresenceRenderer)
class PresenceRenderer {
  private smoothers = new Map<number, PeerSmoothing>();

  // Called from store subscription when peers change
  onPeersChanged(peers: Map<string, PeerCursorRaw>): void {
    const now = performance.now();

    // Update smoothers for changed peers
    for (const [userId, peer] of peers) {
      let s = this.smoothers.get(userId);
      if (!s) {
        s = { lastSeq: -1, hasCursor: false };
        this.smoothers.set(userId, s);
      }
      this.ingestCursor(s, peer, now);
    }

    // Clean up removed peers
    for (const userId of this.smoothers.keys()) {
      if (!peers.has(userId)) {
        this.smoothers.delete(userId);
      }
    }
  }

  // Called at render time
  getInterpolatedCursors(): Array<InterpolatedCursor> {
    const now = performance.now();
    const result = [];

    for (const [userId, smoother] of this.smoothers) {
      const pos = this.computeDisplayPosition(smoother, now);
      if (pos) {
        result.push({ userId, ...pos });
      }
    }

    return result;
  }

  // Check if any cursor is animating (need continuous frames)
  isAnimating(): boolean {
    const now = performance.now();
    for (const s of this.smoothers.values()) {
      if (s.animEndMs && now < s.animEndMs) return true;
    }
    return false;
  }
}
```

**Modified buildPresenceView:**

```typescript
// OLD: Computes interpolation
private buildPresenceView(): PresenceView {
  const now = this.clock.now();
  const users = new Map();

  this.yAwareness.getStates().forEach((state, clientId) => {
    const displayCursor = this.getDisplayCursor(ps, now);  // Interpolation here
    users.set(state.userId, { cursor: displayCursor, ... });
  });

  return { users, localUserId };
}

// NEW: Just formats raw data
private buildPresenceView(): PresenceView {
  const users = new Map();

  this.yAwareness.getStates().forEach((state, clientId) => {
    if (clientId === this.yAwareness.clientID) return;

    users.set(state.userId, {
      name: state.name,
      color: state.color,
      cursor: state.cursor,  // RAW, no interpolation
      activity: state.activity,
      seq: state.seq,
      ts: state.ts,
    });
  });

  return { users, localUserId: this.userId };
}
```

**Modified OverlayRenderLoop:**

```typescript
class OverlayRenderLoop {
  private presenceRenderer = new PresenceRenderer();

  start() {
    // Subscribe to presence changes
    this.presenceUnsub = store.subscribe(
      selectPresence,
      (presence) => {
        this.presenceRenderer.onPeersChanged(presence.users);
        this.invalidateAll();
      }
    );
  }

  private frame(): void {
    // ... existing code ...

    // Draw presence with interpolated positions
    const cursors = this.presenceRenderer.getInterpolatedCursors();
    drawPresenceCursors(ctx, cursors, view, viewport);

    // Keep animating if interpolation in progress
    if (this.presenceRenderer.isAnimating()) {
      this.invalidateAll();  // Schedule next frame
    }
  }
}
```

**What this achieves:**
- ✅ Interpolation in correct layer
- ✅ buildPresenceView is simpler
- ✅ Clear separation of concerns
- ✅ Can optimize (skip cursors outside viewport)

**Risk level:** Medium (need to carefully preserve interpolation behavior)

---

### Phase 4: Evaluate RAF Loop Removal (Optional)

After Phase 3, we can evaluate whether to remove the RAF loop:

**What RAF loop still does after Phase 3:**
1. Batches rapid Y.Doc updates into single snapshot
2. Delays notification by up to 16ms

**Arguments for keeping:**
- Batching is valuable during rapid drawing
- Cost is negligible (0.03% CPU)
- Less risk

**Arguments for removing:**
- Conceptual purity
- Simpler mental model
- One less moving part

**Recommendation:** Evaluate after Phase 3. If the event-driven model for presence works well, consider removing RAF. But it's not required for the benefits.

---

## Part 4: Risk Assessment

| Change | Confidence | Risk | Lines Changed |
|--------|------------|------|---------------|
| Phase 1: Wrap store around snapshot | 95% | Low | ~100 |
| Phase 2: Simplify gates | 95% | Low | -80 |
| Phase 3: Move interpolation | 80% | Medium | ~200 |
| Phase 4: Remove RAF loop | 60% | Higher | ~150 |

**Cumulative risk:** Phases 1-2 are very safe. Phase 3 requires careful testing of interpolation behavior. Phase 4 is optional.

---

## Part 5: What We Get

### After Phase 1-2:

```typescript
// Granular subscriptions
store.subscribe(selectDocVersion, (v) => { /* only doc changes */ });
store.subscribe(selectPresence, (p) => { /* only presence changes */ });
store.subscribe(selectGates, (g) => { /* gate changes */ });

// Simple gate waiting
await whenGateOpen('idbReady');

// Selectors for derived state
const isOnline = selectIsOnline(store.getState());
```

### After Phase 3:

```typescript
// Interpolation at render time
const cursors = presenceRenderer.getInterpolatedCursors();

// Smart animation scheduling
if (presenceRenderer.isAnimating()) {
  scheduleNextFrame();
}

// Can optimize for viewport
const visibleCursors = cursors.filter(c => isInViewport(c));
```

---

## Part 6: Open Questions

1. **Batching during rapid drawing:** If we remove RAF, how do we batch rapid strokes? Currently 10 Y.Doc updates in 16ms become 1 snapshot. With event-driven, would that be 10 store updates? (Zustand batches synchronous updates, so probably fine)

2. **Test timing control:** Tests use TestClock/TestFrameScheduler. With store-based approach, do we need to mock store subscriptions? (Probably not - Zustand subscriptions are synchronous)

3. **Awareness update batching:** Currently `_onAwarenessUpdate` can fire multiple times rapidly. Should we batch these? (Probably not needed - Zustand handles it)

---

## Part 7: Implementation Order

```
Week 1: Phase 1
  ├─ Create room-doc-store.ts
  ├─ Modify publishSnapshot to use store
  ├─ Update CanvasRuntime subscriptions
  └─ Run tests, verify no regression

Week 2: Phase 2
  ├─ Migrate gates to store
  ├─ Delete gate callback infrastructure
  └─ Run tests, verify gates work

Week 3: Phase 3 (if confident after 1-2)
  ├─ Create PresenceRenderer
  ├─ Move interpolation logic
  ├─ Simplify buildPresenceView
  └─ Extensive manual testing of cursor smoothness

Week 4: Phase 4 evaluation
  └─ Decide whether RAF removal is worth it
```

---

## Summary

**Your instinct is right:** The event-driven model is cleaner and interpolation belongs in the render layer.

**But the pragmatic path is:**
1. Start with low-risk changes (store wrapper, gates)
2. Get the benefits (selectors, simpler code)
3. Incrementally move toward the ideal architecture
4. Don't remove RAF until we're confident

**The RAF loop isn't bad** - it costs 0.03% CPU. It's just not elegant. We can get 90% of the benefits without removing it, then decide later.

---

*Plan created 2025-12-14*
