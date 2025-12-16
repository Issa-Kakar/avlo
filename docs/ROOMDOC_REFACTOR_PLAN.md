# RoomDocManager Refactor Plan: Event-Driven Architecture

**Status:** Ready for Implementation
**Scope:** First slice - Presence Decoupling + RAF Elimination
**Prerequisites:** None (this IS the prerequisite work)

---

## Executive Summary

This plan addresses five architectural violations in `RoomDocManager`:

1. **Continuous RAF polling** - Runs every frame regardless of changes
2. **Presence coupled to snapshots** - `buildPresenceView()` inside `buildSnapshot()`
3. **Interpolation at wrong layer** - Cursor smoothing in data manager
4. **Hot-path allocation** - `new Map()` every frame during cursor animation
5. **Over-complicated gates** - 5 gates when 2-3 suffice

**End Goal:** Event-driven, decoupled, minimal-allocation architecture.

**This Plan:** First slice that enables all subsequent refactors.

---

## Part 1: Current Architecture Trace

### 1.1 Initial Hydration Flow

```
constructor(roomId)
  │
  ├─ Initialize Y.Doc({ guid: roomId })
  ├─ Create YAwareness(ydoc) ← BEFORE providers (problem: gate needed)
  │
  ├─ setupObservers()
  │     └─ ydoc.on('update', handleYDocUpdate)
  │
  ├─ initializeIndexedDBProvider()
  │     └─ IndexeddbPersistence → whenSynced → openGate('idbReady')
  │
  ├─ whenGateOpen('idbReady').then(...)
  │     ├─ if root.has('meta'): setupObjectsObserver() + attachUndoManager()
  │     └─ (duplicate call later)
  │
  ├─ initializeWebSocketProvider()
  │     ├─ YProvider with awareness option
  │     ├─ on('status') → wsConnected/awarenessReady gates
  │     ├─ on('sync') → wsSynced gate
  │     └─ yAwareness.on('update', _onAwarenessUpdate)
  │
  ├─ whenGateOpen('idbReady').then(async ...)
  │     ├─ Promise.race([wsSynced, delay(5000)])
  │     ├─ if !root.has('meta'): initializeYjsStructures()
  │     ├─ setupObjectsObserver() ← called again (idempotent guard)
  │     └─ attachUndoManager() ← called again (idempotent guard)
  │
  └─ startPublishLoop() ← RAF begins immediately
```

**Key Problems:**
- YAwareness created before WS provider, requiring `awarenessReady` gate
- Guard complexity because objects map is nested under root
- RAF starts immediately, runs forever

### 1.2 Objects Observer Flow (Steady-State)

```
Y.Doc change (local or remote)
  │
  ├─ handleYDocUpdate()
  │     ├─ docVersion++
  │     ├─ sawAnyDocUpdate = true
  │     └─ publishState.isDirty = true
  │
  └─ objectsObserver(events, tx)
        ├─ if needsSpatialRebuild: return (skip during rebuild)
        │
        ├─ Classify events:
        │     ├─ touchedIds (added/updated)
        │     ├─ deletedIds
        │     └─ textOnlyIds (text-only changes, optimization)
        │
        └─ applyObjectChanges()
              ├─ Deletions:
              │     ├─ spatialIndex.remove(id, bbox)
              │     ├─ cacheEvictIds.add(id)
              │     ├─ dirtyRects.push(bounds)
              │     └─ objectsById.delete(id)
              │
              └─ Updates:
                    ├─ computeBBoxFor(kind, yObj)
                    ├─ objectsById.set(id, handle)
                    ├─ spatialIndex.update/insert()
                    └─ dirtyRects.push(bounds)
```

**Key Insight:** Observer is well-structured. The problem is the polling loop, not the observer.

### 1.3 RAF Publish Loop (The Problem)

```typescript
// Lines 910-954 - Runs EVERY FRAME
startPublishLoop():
  rafLoop = () => {
    // Force presence publish if animating (even if nothing changed!)
    if (!presenceDirty && now < presenceAnimDeadlineMs) {
      presenceDirty = true;  // ← Forces work every frame during animation
    }

    if (isDirty) {
      // Full snapshot rebuild
      newSnapshot = buildSnapshot();  // ← Calls buildPresenceView()
      publishSnapshot(newSnapshot);
    } else if (presenceDirty) {
      // Presence-only update
      livePresence = buildPresenceView();  // ← Allocates new Map
      snap = { ...prev, presence: livePresence };
      publishSnapshot(snap);
    }

    if (!destroyed) {
      rafId = requestAnimationFrame(rafLoop);  // ← Runs forever
    }
  }
```

**Problems:**
1. RAF runs unconditionally (even when idle)
2. `buildPresenceView()` called in both paths
3. Presence embedded in Snapshot
4. Animation forces frame work via `presenceAnimDeadlineMs`

### 1.4 Presence/Awareness Flow

```
Local cursor update:
  updateCursor(worldX, worldY)
    ├─ Quantize to 0.5 world units
    ├─ Compare with localCursor
    ├─ if changed:
    │     ├─ localCursor = newCursor
    │     ├─ awarenessIsDirty = true
    │     └─ if awarenessReady: scheduleAwarenessSend()
    │
    scheduleAwarenessSend()
      └─ setTimeout(sendAwareness, 75-150ms with jitter)

    sendAwareness()
      ├─ Gate check (awarenessReady)
      ├─ Compare with lastSentAwareness (skip if identical)
      ├─ Backpressure check (ws.bufferedAmount)
      ├─ yAwareness.setLocalState({...})
      └─ Update lastSentAwareness, clear dirty

Remote cursor received:
  _onAwarenessUpdate(event)
    ├─ for each changedClientId:
    │     └─ if not self: ingestAwareness(clientId, state, now)
    │
    ├─ publishState.presenceDirty = true  // ← Triggers RAF work
    └─ updatePresenceThrottled()

  ingestAwareness(clientId, state, now)
    ├─ Get/create PeerSmoothing for clientId
    ├─ Drop stale frames (seq check)
    ├─ Quantize cursor
    ├─ Update ps.prev, ps.last
    ├─ Set animation window: animStartMs, animEndMs
    └─ Update presenceAnimDeadlineMs  // ← Extends RAF work period

  getDisplayCursor() [called from buildPresenceView]
    ├─ if inside animation window: lerp displayStart → last
    └─ else: return last position
```

**Problems:**
1. `ingestAwareness` + `getDisplayCursor` = interpolation in data manager
2. `presenceAnimDeadlineMs` forces RAF to keep running
3. `buildPresenceView()` allocates `new Map()` every call

### 1.5 buildPresenceView Allocation Issue

```typescript
// Lines 396-442 - Called every frame during animation
private buildPresenceView(): PresenceView {
  const now = performance.now();
  const users = new Map<string, {...}>();  // ← NEW MAP EVERY CALL

  if (this.yAwareness) {
    this.yAwareness.getStates().forEach((state, clientId) => {
      if (state.userId && clientId !== localClientId) {
        let ps = this.peerSmoothers.get(clientId);
        // ... get smoothed cursor ...
        users.set(state.userId, {...});  // ← New object per user
      }
    });
  }

  return { users, localUserId: this.userId };
}
```

**Called from:**
- `buildSnapshot()` (line 1493)
- RAF loop else-if branch (line 931)

---

## Part 2: Target Architecture

### 2.1 High-Level Goal

```
┌─────────────────────────────────────────────────────────────────┐
│                    RoomDocManager (Event-Driven)                │
│                                                                 │
│  • Owns: Y.Doc, IDB provider, WS provider, UndoManager          │
│  • NO RAF loop - reactive to Y.Doc 'update' events              │
│  • Emits: 'snapshot' (doc only, no presence)                    │
│                                                                 │
│  subscribeSnapshot(cb) → cb(DocSnapshot)                        │
│  mutate(fn)                                                     │
│  undo() / redo()                                                │
└───────────────────────────────┬─────────────────────────────────┘
                                │
         ┌──────────────────────┼──────────────────────┐
         │                      │                      │
         ▼                      ▼                      ▼
┌─────────────────┐  ┌─────────────────────┐  ┌─────────────────┐
│ AwarenessManager│  │ PresenceInterpolator│  │   CanvasRuntime │
│ (Future Phase)  │  │ (Render Layer)      │  │   (Orchestrator)│
│                 │  │                     │  │                 │
│ • Owns YAwareness│  │ • Subscribes to     │  │ • Subscribes to │
│ • Throttled send│  │   awareness events  │  │   both snapshot │
│ • Backpressure  │  │ • Owns interpolation│  │   and presence  │
│ • Raw positions │  │ • AnimationJob      │  │                 │
└─────────────────┘  └─────────────────────┘  └─────────────────┘
```

### 2.2 This Slice's Scope

**What we're doing:**
1. Remove `presence` from `Snapshot` interface
2. Create separate presence publication path
3. Make doc publishing event-driven (no RAF for docs)
4. Keep RAF ONLY for presence interpolation animation
5. Simplify gate system

**What we're NOT doing (future slices):**
- Extract AwarenessManager class
- Move interpolation to render layer
- Top-level Y.Map migration
- Full EventEmitter3 adoption

---

## Part 3: Implementation Plan

### Step 1: Create DocSnapshot Type (Decouple Types)

**File:** `packages/shared/src/types/snapshot.ts`

```typescript
// NEW: Doc-only snapshot (no presence)
export interface DocSnapshot {
  docVersion: number;
  objectsById: ReadonlyMap<string, ObjectHandle>;
  spatialIndex: ObjectSpatialIndex | null;
  view: ViewTransform;
  createdAt: number;
  dirtyPatch?: DirtyPatch | null;
}

// KEEP for backward compat during transition
// After all consumers migrate, delete this
export interface Snapshot extends DocSnapshot {
  presence: PresenceView;
}

// Helper to create empty doc snapshot
export function createEmptyDocSnapshot(): DocSnapshot {
  return {
    docVersion: 0,
    objectsById: new Map(),
    spatialIndex: null,
    view: {
      worldToCanvas: (x, y) => [x, y],
      canvasToWorld: (x, y) => [x, y],
      scale: 1,
      pan: { x: 0, y: 0 },
    },
    createdAt: Date.now(),
    dirtyPatch: null,
  };
}
```

**Why:** Separates the concepts at the type level first.

### Step 2: Add Doc-Only Subscription to Interface

**File:** `client/src/lib/room-doc-manager.ts`

Add to `IRoomDocManager` interface:

```typescript
export interface IRoomDocManager {
  // Existing
  readonly currentSnapshot: Snapshot;
  subscribeSnapshot(cb: (snap: Snapshot) => void): Unsub;
  subscribePresence(cb: (p: PresenceView) => void): Unsub;

  // NEW: Doc-only subscription (preferred)
  readonly currentDocSnapshot: DocSnapshot;
  subscribeDocSnapshot(cb: (snap: DocSnapshot) => void): Unsub;

  // ... rest unchanged
}
```

### Step 3: Implement Event-Driven Doc Publishing

**File:** `client/src/lib/room-doc-manager.ts`

**3a. Add doc snapshot state:**

```typescript
private _currentDocSnapshot: DocSnapshot;
private docSnapshotSubscribers = new Set<(snap: DocSnapshot) => void>();
```

**3b. Make handleYDocUpdate publish immediately:**

```typescript
private handleYDocUpdate = (_update: Uint8Array, _origin: unknown): void => {
  this.docVersion = (this.docVersion + 1) >>> 0;
  this.sawAnyDocUpdate = true;

  // EVENT-DRIVEN: Publish immediately instead of setting dirty flag
  // The observer has already updated objectsById and spatialIndex
  this.publishDocSnapshotNow();
};

private publishDocSnapshotNow(): void {
  // Guard: structures must exist
  const meta = this.getMeta();
  const objects = this.getRoot().get('objects');
  if (!meta || !objects) return;

  // Create spatial index if needed
  if (!this.spatialIndex) {
    this.spatialIndex = new ObjectSpatialIndex();
  }

  // Two-epoch: rebuild on first or when flagged
  if (this.needsSpatialRebuild) {
    this.hydrateObjectsFromY();
    this.needsSpatialRebuild = false;
  }

  // Build dirty patch
  let dirtyPatch: DirtyPatch | null = null;
  if (this.dirtyRects.length > 0 || this.cacheEvictIds.size > 0) {
    dirtyPatch = {
      rects: this.dirtyRects.splice(0),
      evictIds: Array.from(this.cacheEvictIds)
    };
    this.cacheEvictIds.clear();
  }

  const docSnap: DocSnapshot = {
    docVersion: this.docVersion,
    objectsById: this.objectsById,
    spatialIndex: this.spatialIndex,
    view: this.getViewTransform(),
    createdAt: Date.now(),
    dirtyPatch,
  };

  this._currentDocSnapshot = docSnap;

  // Notify doc subscribers
  this.docSnapshotSubscribers.forEach(cb => {
    try { cb(docSnap); } catch (e) { console.error('[DocSnapshot] Subscriber error:', e); }
  });

  // Open gate if applicable
  if (!this.gates.firstSnapshot && this.sawAnyDocUpdate) {
    this.openGate('firstSnapshot');
  }

  // COMPAT: Also update legacy snapshot (with presence)
  this.publishLegacySnapshot(docSnap);
}

private publishLegacySnapshot(docSnap: DocSnapshot): void {
  const snap: Snapshot = {
    ...docSnap,
    presence: this.buildPresenceView(),
  };
  this._currentSnapshot = snap;
  this.snapshotSubscribers.forEach(cb => {
    try { cb(snap); } catch (e) { console.error('[Snapshot] Subscriber error:', e); }
  });
}
```

### Step 4: Presence-Only RAF Loop

**File:** `client/src/lib/room-doc-manager.ts`

Replace `startPublishLoop()` with presence-only animation:

```typescript
private startPresenceAnimationLoop(): void {
  const presenceLoop = () => {
    if (this.destroyed) return;

    const now = performance.now();

    // Only continue if we have active animations
    if (now < this.presenceAnimDeadlineMs) {
      // Publish presence update for interpolation
      this.publishPresenceUpdate();
      this.presenceRafId = requestAnimationFrame(presenceLoop);
    } else {
      // Animation complete, stop loop
      this.presenceRafId = -1;
    }
  };

  // Don't start automatically - wait for awareness update to trigger
  this.presenceRafId = -1;
}

private triggerPresenceAnimation(): void {
  // Only schedule if not already running
  if (this.presenceRafId === -1 && !this.destroyed) {
    this.presenceRafId = requestAnimationFrame(() => {
      this.presenceRafId = -1;
      const now = performance.now();

      if (now < this.presenceAnimDeadlineMs) {
        this.publishPresenceUpdate();
        this.triggerPresenceAnimation(); // Continue if still animating
      } else {
        this.publishPresenceUpdate(); // Final frame
      }
    });
  }
}

private publishPresenceUpdate(): void {
  const presence = this.buildPresenceView();

  // Notify presence subscribers
  this.presenceSubscribers.forEach(cb => cb(presence));

  // COMPAT: Update legacy snapshot presence field
  if (this._currentSnapshot) {
    this._currentSnapshot = {
      ...this._currentDocSnapshot,
      presence,
    };
    // Note: Don't notify snapshot subscribers for presence-only changes
    // They should use subscribePresence() for presence updates
  }
}
```

**Update awareness handler to trigger animation:**

```typescript
this._onAwarenessUpdate = (event: any) => {
  // ... existing ingestAwareness logic ...

  // Trigger presence animation if we have new cursor positions
  if (this.presenceAnimDeadlineMs > performance.now()) {
    this.triggerPresenceAnimation();
  } else {
    // No animation needed, just publish once
    this.publishPresenceUpdate();
  }
};
```

### Step 5: Update Constructor Initialization Order

```typescript
constructor(roomId: RoomId, _options?: RoomDocManagerOptions) {
  // ... existing init ...

  // Initialize state
  this._currentSnapshot = createEmptySnapshot();
  this._currentDocSnapshot = createEmptyDocSnapshot();

  // Setup observers BEFORE providers
  this.setupObservers();

  // Initialize IDB first
  this.initializeIndexedDBProvider();

  // Guard sequence for structure initialization
  this.whenGateOpen('idbReady').then(() => {
    const root = this.ydoc.getMap('root');
    if (root.has('meta')) {
      this.setupObjectsObserver();
      this.attachUndoManager();
    }
  });

  // Initialize WS
  this.initializeWebSocketProvider();

  // Structure seeding after sync window
  this.whenGateOpen('idbReady').then(async () => {
    await Promise.race([
      this.whenGateOpen('wsSynced'),
      this.delay(5_000),
    ]);

    const root = this.ydoc.getMap('root');
    if (!root.has('meta')) {
      this.initializeYjsStructures();
    }
    this.setupObjectsObserver();
    this.attachUndoManager();
  });

  // NO startPublishLoop() - event-driven now!
  // Presence animation is triggered by awareness updates
}
```

### Step 6: Delete RAF Loop Code

Remove from `RoomDocManagerImpl`:
- `startPublishLoop()` method entirely
- `publishState` object (except for tracking)
- RAF-related cleanup in `destroy()`

Update destroy():
```typescript
destroy(): void {
  if (this.destroyed) return;
  this.destroyed = true;

  // Cancel presence animation
  if (this.presenceRafId !== -1) {
    cancelAnimationFrame(this.presenceRafId);
    this.presenceRafId = -1;
  }

  // ... rest of cleanup unchanged
}
```

### Step 7: Update CanvasRuntime Consumer

**File:** `client/src/canvas/CanvasRuntime.ts`

Update snapshot subscription to use doc-only:

```typescript
start(config: RuntimeConfig): void {
  // ... existing setup ...

  // 7. Doc snapshot subscription (replaces full snapshot)
  const roomDoc = getActiveRoomDoc();
  this.lastDocVersion = roomDoc.currentDocSnapshot.docVersion;

  this.docSnapshotUnsub = roomDoc.subscribeDocSnapshot((docSnap) => {
    if (docSnap.docVersion !== this.lastDocVersion) {
      this.lastDocVersion = docSnap.docVersion;
      this.overlayLoop?.holdPreviewForOneFrame();

      if (docSnap.dirtyPatch) {
        const { rects, evictIds } = docSnap.dirtyPatch;
        const cache = getObjectCacheInstance();
        cache.evictMany(evictIds);

        const viewport = getVisibleWorldBounds();
        for (const bounds of rects) {
          if (boundsIntersect(bounds, viewport)) {
            this.renderLoop?.invalidateWorld(bounds);
          }
        }
      } else if (this.lastDocVersion < 2) {
        this.renderLoop?.invalidateWorld(getVisibleWorldBounds());
      }

      this.overlayLoop?.invalidateAll();
    }
  });

  // 8. Presence subscription (separate from doc)
  this.presenceUnsub = roomDoc.subscribePresence(() => {
    // Presence changed - only update overlay
    this.overlayLoop?.invalidateAll();
  });
}
```

### Step 8: Update OverlayRenderLoop

**File:** `client/src/renderer/OverlayRenderLoop.ts`

The overlay loop already reads presence from snapshot. Update to use direct presence access:

```typescript
// In frame() method, update presence drawing section:

// Get presence directly (not from snapshot)
const presence = getCurrentPresence(); // New helper in room-runtime.ts
const gates = getGateStatus();

if (gates.awarenessReady && gates.firstSnapshot) {
  ctx.save();
  ctx.setTransform(vp.dpr, 0, 0, vp.dpr, 0, 0);
  drawPresenceOverlays(ctx, presence, view, {...}, gates);
  ctx.restore();
}
```

**File:** `client/src/canvas/room-runtime.ts`

Add helper:

```typescript
export function getCurrentPresence(): PresenceView {
  return getActiveRoomDoc().currentSnapshot.presence;
}
```

### Step 9: Simplify Gate System (Optional for This Slice)

Keep for now:
- `idbReady` - IDB loaded
- `wsConnected` - WS open
- `wsSynced` - First WS sync

Remove:
- `firstSnapshot` - Replace with `sawAnyDocUpdate` check directly
- `awarenessReady` - Derive from `wsConnected`

```typescript
// Simplify awareness gate check
private get isAwarenessReady(): boolean {
  return this.gates.wsConnected;
}
```

---

## Part 4: Migration Checklist

### Files to Modify

| File | Changes |
|------|---------|
| `packages/shared/src/types/snapshot.ts` | Add `DocSnapshot`, `createEmptyDocSnapshot()` |
| `client/src/lib/room-doc-manager.ts` | Event-driven publishing, presence-only RAF |
| `client/src/canvas/CanvasRuntime.ts` | Use `subscribeDocSnapshot` + `subscribePresence` |
| `client/src/canvas/room-runtime.ts` | Add `getCurrentPresence()` helper |
| `client/src/renderer/OverlayRenderLoop.ts` | Use direct presence access |

### Consumers to Update (After Core Changes)

| Consumer | Current | After |
|----------|---------|-------|
| `CanvasRuntime` | `subscribeSnapshot` | `subscribeDocSnapshot` + `subscribePresence` |
| `OverlayRenderLoop` | `snapshot.presence` | `getCurrentPresence()` |
| `RenderLoop` | `getCurrentSnapshot()` | `getCurrentDocSnapshot()` |
| `usePresence` hook | `subscribePresence` | No change (already correct) |
| `useSnapshot` hook | (if exists) | Update to `DocSnapshot` |

### Tests to Add/Update

1. **Event-driven publishing test:**
   - Mutate doc → verify immediate publish (no RAF delay)
   - Verify no RAF running when idle

2. **Presence decoupling test:**
   - Presence change → only presence subscribers called
   - Doc change → only doc subscribers called

3. **Animation lifecycle test:**
   - Receive remote cursor → RAF starts
   - Animation complete → RAF stops
   - No leaking RAF after destroy

---

## Part 5: Future Slices (Reference Only)

### Slice 2: AwarenessManager Extraction
- New `AwarenessManager` class
- Owns: YAwareness, send throttling, backpressure
- Emits: `local-change`, `remote-change` events
- NO interpolation (raw positions only)

### Slice 3: PresenceInterpolator at Render Layer
- Move `PeerSmoothing`, `ingestAwareness`, `getDisplayCursor`
- Implements `AnimationJob` interface
- Subscribes to AwarenessManager events
- Owns RAF for cursor animation

### Slice 4: Top-Level Y.Map Migration
- Change `root.objects` → `ydoc.getMap('objects')`
- Remove guard complexity in constructor
- Simplify `initializeYjsStructures()`

### Slice 5: Full Gate Simplification
- Remove all gates except `ready` and `online`
- Derive states from provider events
- Remove `whenGateOpen` promise system

---

## Part 6: Verification Steps

After implementation, verify:

1. **No idle RAF:**
   - Open room, wait for load
   - Stop moving cursor
   - Check DevTools Performance: no recurring frames

2. **Event-driven doc updates:**
   - Add object → immediate render (no frame delay)
   - Delete object → immediate render

3. **Presence animation lifecycle:**
   - Move cursor → RAF starts
   - Stop moving → RAF continues for ~66ms
   - After animation → RAF stops

4. **Memory:**
   - No new Map allocations per frame when idle
   - Profile `buildPresenceView` call frequency

5. **Backwards compatibility:**
   - `subscribeSnapshot` still works
   - `currentSnapshot` includes presence
   - Existing hooks continue functioning

---

## Appendix: Key Code Locations

| Concept | File | Lines |
|---------|------|-------|
| RAF loop (to delete) | room-doc-manager.ts | 910-954 |
| handleYDocUpdate | room-doc-manager.ts | 1142-1149 |
| buildPresenceView | room-doc-manager.ts | 396-442 |
| ingestAwareness | room-doc-manager.ts | 324-373 |
| getDisplayCursor | room-doc-manager.ts | 376-393 |
| PeerSmoothing type | room-doc-manager.ts | 69-81 |
| Gate system | room-doc-manager.ts | 156-162, 1383-1428 |
| Objects observer | room-doc-manager.ts | 970-1021 |
| Awareness handler | room-doc-manager.ts | 1239-1280 |
| Snapshot type | shared/types/snapshot.ts | 14-23 |
| PresenceView type | shared/types/awareness.ts | 20-32 |
