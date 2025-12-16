# RoomDocManager Refactor Handoff

**Date:** 2025-12-16
**Status:** Complete - Steps 1-9 Implemented
**Reference:** `docs/ROOMDOC_REFACTOR_PLAN.md`

---

## Summary

The RoomDocManager refactor is complete. The architecture has been updated from continuous RAF polling to an event-driven model:

- **Doc changes:** Event-driven via `subscribeDocSnapshot` (no RAF delay)
- **Presence changes:** On-demand RAF for cursor interpolation (~66ms windows)
- **Idle state:** No RAF running at all

---

## What Was Completed

### Step 1: DocSnapshot Type Created ✅
**File:** `packages/shared/src/types/snapshot.ts`

- Added `DocSnapshot` interface (doc-only, no presence, no view)
- `Snapshot` now extends `DocSnapshot` for backward compatibility
- Added `createEmptyDocSnapshot()` helper function
- Exports automatically available via `@avlo/shared`

### Step 2: Interface Updated ✅
**File:** `client/src/lib/room-doc-manager.ts`

Added to `IRoomDocManager` interface:
```typescript
readonly currentDocSnapshot: DocSnapshot;
subscribeDocSnapshot(cb: (snap: DocSnapshot) => void): Unsub;
```

### Step 3: Event-Driven Doc Publishing ✅
**File:** `client/src/lib/room-doc-manager.ts`

- `handleYDocUpdate` → `publishDocSnapshotNow()` → immediate notification
- `publishLegacySnapshot()` for backward compat with `subscribeSnapshot`
- Removed `isDirty` flag - doc changes are immediate now

### Step 4: On-Demand Presence RAF ✅
**File:** `client/src/lib/room-doc-manager.ts`

- Replaced `startPublishLoop()` with `triggerPresenceAnimation()`
- Added `publishPresenceUpdate()` method
- RAF is now on-demand, triggered by awareness updates
- Constructor no longer calls `startPublishLoop()`
- `_onAwarenessUpdate` calls `triggerPresenceAnimation()` or `publishPresenceUpdate()` directly

### Step 5: Dead Code Cleanup ✅
**File:** `client/src/lib/room-doc-manager.ts`

Removed:
- `throttle()` method
- `updatePresence()` method
- `updatePresenceThrottled` property
- `updatePresenceThrottledCleanup` property
- `publishState.isDirty` flag
- `buildSnapshot()` and `publishSnapshot()` methods
- References to throttle cleanup in `destroy()`

### Step 6: CanvasRuntime Consumer Updated ✅
**File:** `client/src/canvas/CanvasRuntime.ts`

Changed from:
```typescript
this.snapshotUnsub = roomDoc.subscribeSnapshot((snapshot) => { ... });
```

To:
```typescript
this.docSnapshotUnsub = roomDoc.subscribeDocSnapshot((docSnap) => { ... });
this.presenceUnsub = roomDoc.subscribePresence(() => { ... });
```

- Doc changes handled separately via `subscribeDocSnapshot` (event-driven)
- Presence changes handled via `subscribePresence` (invalidates overlay only)
- Proper cleanup of both subscriptions in `stop()`

### Step 7: OverlayRenderLoop Updated ✅
**File:** `client/src/renderer/OverlayRenderLoop.ts`

- Now uses `getCurrentPresence()` directly instead of `getCurrentSnapshot().presence`
- Cleaner separation of concerns

### Step 8: drawPresenceOverlays Signature Updated ✅
**File:** `client/src/renderer/layers/index.ts`

- Changed signature from `(ctx, snapshot, view, ...)` to `(ctx, presence, view, ...)`
- Takes `PresenceView` directly instead of extracting from `Snapshot`

### Step 9: room-runtime.ts Helpers Added ✅
**File:** `client/src/canvas/room-runtime.ts`

Added:
```typescript
export function getCurrentDocSnapshot(): DocSnapshot;
export function getCurrentPresence(): PresenceView;
```

---

## Architecture Summary

### Event-Driven Flow
```
Doc Change:
  Y.Doc update → handleYDocUpdate() → publishDocSnapshotNow()
                                    → publishLegacySnapshot() [compat]

Presence Change:
  awareness update → _onAwarenessUpdate()
                   → if animating: triggerPresenceAnimation() [RAF loop]
                   → else: publishPresenceUpdate() [one-shot]
```

### RAF Behavior
- **Idle:** No RAF running
- **Doc change:** No RAF needed (event-driven)
- **Cursor animation:** RAF runs for ~66ms window, then stops
- **Presence-only (no animation):** One-shot publish, no RAF

### Consumer Patterns

**CanvasRuntime (event-driven):**
```typescript
// Doc changes - event-driven, immediate
roomDoc.subscribeDocSnapshot((docSnap) => {
  // Cache eviction, dirty rect invalidation
});

// Presence changes - overlay update only
roomDoc.subscribePresence(() => {
  overlayLoop.invalidateAll();
});
```

**OverlayRenderLoop (direct access):**
```typescript
const presence = getCurrentPresence();
drawPresenceOverlays(ctx, presence, view, viewport, gates);
```

**React Hooks (unchanged):**
```typescript
// usePresence still works via subscribePresence
const unsub = roomDoc.subscribePresence((presence) => setPresence(presence));
```

---

## Files Modified

| File | Changes |
|------|---------|
| `client/src/lib/room-doc-manager.ts` | Dead code removal, cleanup |
| `client/src/canvas/CanvasRuntime.ts` | Split subscriptions (doc + presence) |
| `client/src/canvas/room-runtime.ts` | Added `getCurrentDocSnapshot()`, `getCurrentPresence()` |
| `client/src/renderer/OverlayRenderLoop.ts` | Use `getCurrentPresence()` |
| `client/src/renderer/layers/index.ts` | `drawPresenceOverlays` takes `PresenceView` directly |

---

## Testing Checklist

1. **No idle RAF:** Open room, wait, check DevTools Performance - no recurring frames
2. **Immediate doc updates:** Add object, verify instant render (no frame delay)
3. **Presence animation lifecycle:** Move cursor, RAF starts, stops after ~66ms
4. **Memory:** No new Map allocations per frame when idle
5. **Backward compat:** `subscribeSnapshot` still works, `currentSnapshot` includes presence
6. **Cursor trails:** Verify cursor interpolation still works smoothly
7. **UI hooks:** Verify `usePresence` hook updates correctly

---

## Future Considerations

### Presence Subscription Tiers (Optional)
Currently `presenceSubscribers` gets updates at animation rate during cursor movement. For UI consumers that don't need 60fps:

```typescript
// Future: High-frequency for cursor animation (RAF-driven)
subscribePresenceAnimation(cb): Unsub;

// Future: Throttled for UI consumers (modals, user lists)
subscribePresenceUI(cb): Unsub; // lodash.throttle at 30Hz
```

For now, UI consumers can handle their own throttling if needed.

### Future Slices (from ROOMDOC_REFACTOR_PLAN.md)
- Slice 2: AwarenessManager Extraction
- Slice 3: PresenceInterpolator at Render Layer
- Slice 4: Top-Level Y.Map Migration
- Slice 5: Full Gate Simplification

---

## Typecheck Status

✅ All workspaces pass typecheck:
- `@avlo/shared` - OK
- `@avlo/client` - OK
- `worker` - OK
