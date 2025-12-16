# RoomDocManager Refactor Handoff

**Date:** 2025-12-16
**Status:** In Progress - Types & Interface Complete
**Reference:** `docs/ROOMDOC_REFACTOR_PLAN.md`

---

## What Was Completed

### Step 1: DocSnapshot Type Created
**File:** `packages/shared/src/types/snapshot.ts`

- Added `DocSnapshot` interface (doc-only, no presence, no view)
- `Snapshot` now extends `DocSnapshot` for backward compatibility
- Added `createEmptyDocSnapshot()` helper function
- Exports automatically available via `@avlo/shared`

```typescript
// NEW type - the event-driven snapshot
export interface DocSnapshot {
  docVersion: number;
  objectsById: ReadonlyMap<string, ObjectHandle>;
  spatialIndex: ObjectSpatialIndex | null;
  createdAt: number;
  dirtyPatch?: DirtyPatch | null;
}

// LEGACY - extends DocSnapshot, adds presence + view (view is dead code)
export interface Snapshot extends DocSnapshot {
  presence: PresenceView;
  view: ViewTransform;  // DEAD CODE - camera-store is source of truth
}
```

### Step 2: Interface Updated
**File:** `client/src/lib/room-doc-manager.ts`

Added to `IRoomDocManager` interface:
```typescript
// NEW: Doc-only subscription (preferred - event-driven, no presence/view)
readonly currentDocSnapshot: DocSnapshot;
subscribeDocSnapshot(cb: (snap: DocSnapshot) => void): Unsub;
```

### Step 3: Implementation Added
**File:** `client/src/lib/room-doc-manager.ts`

- Added `_currentDocSnapshot: DocSnapshot` state
- Added `docSnapshotSubscribers` Set
- Initialized in constructor with `createEmptyDocSnapshot()`
- Implemented `currentDocSnapshot` getter
- Implemented `subscribeDocSnapshot()` method
- Added cleanup in `destroy()` method

### Verification
- **Typecheck passes** - All workspaces compile cleanly

---

## What Remains To Do

### Step 3 (Plan): Event-Driven Doc Publishing
**This is the critical next step.**

Currently `handleYDocUpdate` just sets `isDirty = true` and the RAF loop picks it up. Need to:

1. Create `publishDocSnapshotNow()` method that:
   - Guards on meta/objects existence
   - Creates spatial index if needed
   - Runs hydration if `needsSpatialRebuild`
   - Builds dirty patch
   - Creates `DocSnapshot`
   - Updates `_currentDocSnapshot`
   - Notifies `docSnapshotSubscribers`
   - Opens `firstSnapshot` gate if applicable
   - Calls legacy `publishLegacySnapshot()` for backward compat

2. Update `handleYDocUpdate` to call `publishDocSnapshotNow()` directly instead of just setting dirty flag

### Step 4 (Plan): Presence-Only RAF Loop
Replace `startPublishLoop()` with presence-only animation:

1. Create `triggerPresenceAnimation()` - starts RAF only when cursor animation is needed
2. Create `publishPresenceUpdate()` - builds presence view, notifies subscribers
3. Update `_onAwarenessUpdate` handler to trigger animation
4. RAF should NOT run continuously - only during cursor interpolation window

### Step 5 (Plan): Constructor Changes
- Remove `startPublishLoop()` call from constructor
- Presence animation is triggered on-demand by awareness updates

### Step 6 (Plan): Cleanup
- Delete old `startPublishLoop()` method
- Remove `publishState.isDirty` (doc changes are immediate now)
- Keep `publishState.presenceDirty` or similar for presence tracking

### Step 7 (Plan): Update CanvasRuntime Consumer
**File:** `client/src/canvas/CanvasRuntime.ts`

Change from:
```typescript
this.snapshotUnsub = roomDoc.subscribeSnapshot((snapshot) => { ... });
```

To:
```typescript
this.docSnapshotUnsub = roomDoc.subscribeDocSnapshot((docSnap) => { ... });
this.presenceUnsub = roomDoc.subscribePresence(() => { ... });
```

### Step 8 (Plan): Update OverlayRenderLoop
**File:** `client/src/renderer/OverlayRenderLoop.ts`

Update presence reading to use direct access instead of `snapshot.presence`.

---

## Key Files Modified

| File | Changes |
|------|---------|
| `packages/shared/src/types/snapshot.ts` | Added `DocSnapshot`, `createEmptyDocSnapshot()` |
| `client/src/lib/room-doc-manager.ts` | Interface + implementation for doc-only subscription |

---

## Key Files To Modify Next

| File | Changes Needed |
|------|----------------|
| `client/src/lib/room-doc-manager.ts` | Event-driven publishing, presence-only RAF |
| `client/src/canvas/CanvasRuntime.ts` | Use `subscribeDocSnapshot` + `subscribePresence` |
| `client/src/renderer/OverlayRenderLoop.ts` | Direct presence access |
| `client/src/canvas/room-runtime.ts` | Add `getCurrentPresence()` helper |

---

## Architecture Notes

### Why Remove `view` from Snapshot?
The `view` field in `Snapshot` was dead code. All rendering reads from `camera-store.ts` directly:
- `RenderLoop.ts` uses `getViewTransform()` from camera-store
- `OverlayRenderLoop.ts` uses `getViewTransform()` from camera-store
- The `getViewTransform()` in RoomDocManager just returned identity transforms

### Two-Epoch Model (Unchanged)
The spatial index rebuild logic remains the same:
1. **Rebuild Epoch:** `hydrateObjectsFromY()` on first load or when flagged
2. **Steady-State Epoch:** Incremental updates via `objectsObserver`

### Event-Driven Goal
- Doc changes: Publish immediately in `handleYDocUpdate` (no RAF delay)
- Presence changes: RAF only during cursor interpolation window (~66ms)
- When idle: No RAF running at all

---

## Testing After Implementation

1. **No idle RAF:** Open room, wait, check DevTools Performance - no recurring frames
2. **Immediate doc updates:** Add object, verify instant render (no frame delay)
3. **Presence animation lifecycle:** Move cursor, RAF starts, stops after ~66ms
4. **Memory:** No new Map allocations per frame when idle
5. **Backward compat:** `subscribeSnapshot` still works, `currentSnapshot` includes presence
