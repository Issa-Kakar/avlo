# Presence Refactor Changelog

Incremental cleanup toward the presence system redesign (`docs/PRESENCE_REDESIGN.md`).

---

## Phase 2: Presence/Awareness Cleanup (pre-redesign)

Strip dead awareness fields, eliminate redundant gates, delete undesigned UI, simplify accessors.

### Shared types stripped

- `Awareness` interface: removed `activity`, `ts`, `aw_v`. Kept `userId`, `name`, `color`, `cursor?`, `seq`.
- `PresenceView` user shape: removed `activity` and `lastSeen`.

### UsersModal deleted

- Deleted `UsersModal.tsx` (undesigned, placeholder modal)
- `RoomPage.tsx`: removed modal state, import, JSX
- `UserAvatarCluster.tsx`: removed `onShowModal` prop, `onClick` handler, activity in tooltip
- Barrel export cleaned

### RoomDocManager interface + field cleanup

- Interface: removed `getGateStatus()`, `isIndexedDBReady()`, `updateActivity()`; added `isConnected(): boolean`
- Deleted `localActivity` field and constructor init
- Removed `activity` from `lastSentAwareness` comparison type

### `awarenessReady` gate eliminated

`awarenessReady` opened/closed exactly when `wsConnected` did. All references replaced:

- Removed `awarenessReady: false` from `gates` object
- `sendAwareness()` / `updateCursor()`: `gates.awarenessReady` → `gates.wsConnected`
- `openGate()` cross-checks: `awarenessReady` refs → `wsConnected`
- `_onWebSocketStatus` connected: merged awareness dirty/send into `wsConnected` open block
- `_onWebSocketStatus` disconnected: merged cursor clear + `setLocalState(null)` into `wsConnected` close block

### Dead awareness fields stripped from send path

- `setLocalState()`: removed `activity`, `ts`, `aw_v`. Sends `userId`, `name`, `color`, `cursor`, `seq`.
- `sendAwareness()` comparison: removed `activity ===` check
- `buildPresenceView()`: removed `activity` and `lastSeen` from user map

### Dead methods deleted, `isConnected()` added

- Deleted `updateActivity()`, `getGateStatus()`, `isIndexedDBReady()` implementations
- Added `isConnected(): boolean` (reads `gates.wsConnected`)

### BBox computation simplified

Both `applyObjectChanges()` and `hydrateObjectsFromY()` had verbose `.get()` fallback chains for note/text when typed accessors returned null. Replaced with `computeBBoxFor(kind, yObj)` as generic fallback — clean ternaries instead of 24-line if/else blocks.

### room-runtime.ts cleaned

- Removed `GateStatus` type export
- Removed `getGateStatus()` wrapper function

### Files changed

| File                                          | Action      | Delta |
| --------------------------------------------- | ----------- | ----- |
| `packages/shared/src/types/awareness.ts`      | Edit        | −5    |
| `client/src/components/UsersModal.tsx`        | **Deleted** | −193  |
| `client/src/components/RoomPage.tsx`          | Edit        | −8    |
| `client/src/components/UserAvatarCluster.tsx` | Edit        | −4    |
| `client/src/components/index.ts`              | Edit        | −1    |
| `client/src/lib/room-doc-manager.ts`          | Edit        | −106  |
| `client/src/canvas/room-runtime.ts`           | Edit        | −12   |

**Net: −329 lines**

---

## Phase 1: Overlay Render Loop & Animation System

Thins the overlay loop, removes dead code, establishes a standard animation pattern, and eliminates prop drilling.

---

## Animation System

### `AnimationJob` interface simplified

- `update()` + `render()` + `isActive()` → single `frame(ctx, now, dt): boolean`
- Return `true` = need another frame. Return `false` = done.
- Removed `viewport: ViewportInfo` and `view: ViewTransform` params — jobs read from camera store imperatively
- Jobs handle their own coordinate space (`ctx.save()` / `setTransform` / `ctx.restore()`)

### `AnimationController` push-based invalidation

- `tick()` + `render()` + `hasActiveAnimations()` → single `run(ctx, now)`
- Delta time computed internally (controller owns `lastTickTime`)
- `setInvalidator(fn)` wired once by OverlayRenderLoop — controller calls it if any job needs more frames
- Overlay loop never polls `hasActiveAnimations()` — the controller pushes

### `EraserTrailAnimation` adapted

- Merged `update()` + `render()` into `frame()`
- Handles own DPR transform internally
- Tool-facing API unchanged: `start()`, `addPoint()`, `stop()` — EraserTool needs zero changes

---

## Preview System Extracted

### New `renderer/layers/tool-preview.ts`

All preview dispatch + hold-one-frame mechanism moved out of OverlayRenderLoop:

- `drawToolPreview(ctx)` — routes to stroke/eraser/shape/selection/connector preview renderers
- `holdPreviewForOneFrame()` — prevents single-frame flash on commit
- `clearPreviewCache()` — called on tool switch
- Zero params except `ctx` — reads preview from `getActivePreview()`, scale from camera store, snapshot from room-runtime internally

### `holdPreviewForOneFrame` wiring simplified

- Was: `setHoldPreviewFn(() => this.overlayLoop?.holdPreviewForOneFrame())`
- Now: `setHoldPreviewFn(holdPreviewForOneFrame)` — imported directly from tool-preview.ts
- Snapshot subscriber in CanvasRuntime also calls it directly

---

## Dead Code Removed

### `TextPreview` type deleted

- Removed `TextPreview` interface from `lib/tools/types.ts`
- Removed from `PreviewData` union
- The overlay loop's text preview branch (~30 lines of dashed-box + crosshair rendering) was dead code

### Cursor trail system gutted

`presence-cursors.ts` reduced from ~356 lines to ~95 lines. Deleted:

- `CursorTrail` / `TrailProfile` interfaces
- `cursorTrails` / `peerProfiles` Maps
- `DEFAULT_TRAIL_PROFILE` + all trail constants
- `clearCursorTrails()`, `setPeerTrailProfile()`, `resetPeerTrailProfile()`
- `catmullRom()`, `resampleTrail()`, `drawTrailLaser()`, `prefersReducedMotion()`
- Peer cleanup loop

### `drawPresenceOverlays` indirection removed

- Deleted from `renderer/layers/index.ts` — was a gate-check wrapper around `drawCursors()`
- Gate checks removed as preparation for awareness redesign (gates will be eliminated entirely)

### `clearCursorTrails` references removed

- Import + 2 call sites in `room-doc-manager.ts` (teardown + disconnect handler)

---

## OverlayRenderLoop Simplified

~333 lines → ~130 lines. The new `frame()`:

```
clear → world transform → drawToolPreview(ctx) → drawCursors(ctx) → controller.run(ctx, now)
```

### Removed from the class

- `cachedPreview` / `holdPreviewOneFrame` fields (moved to tool-preview.ts)
- `holdPreviewForOneFrame()` method (moved to tool-preview.ts)
- All 6 per-preview-branch `setTransform` calls (single world transform applied once)
- `getGateStatus()` call + gate checks
- `getCurrentPresence()` / `getCurrentSnapshot()` calls
- `getViewTransform()` / `getViewportInfo()` calls
- `animController.tick()` call
- `animController.hasActiveAnimations()` polling

### Kept

- Camera subscription (invalidate on pan/zoom)
- Tool change subscription (clear preview cache)
- `invalidateAll()` / `schedule()` mechanism
- Canvas resize detection

---

## `drawCursors` — zero-param, self-contained

```typescript
export function drawCursors(ctx: CanvasRenderingContext2D): void;
```

- Reads presence from `getCurrentPresence()`, view transform from `getViewTransform()`, DPR from camera store
- Handles own screen-space DPR transform (`save/setTransform/restore`)
- `drawCursorPointer` and `drawNameLabel` exported for future cursor interpolation animation job
- No gate checks — preparation for gate elimination in presence redesign

---

## Files Changed

| File                                       | Action      | Lines                         |
| ------------------------------------------ | ----------- | ----------------------------- |
| `canvas/animation/AnimationController.ts`  | Rewritten   | 100 (was 166)                 |
| `canvas/animation/EraserTrailAnimation.ts` | Rewritten   | 105 (was 177)                 |
| `canvas/animation/index.ts`                | Updated     | exports unchanged             |
| `renderer/layers/tool-preview.ts`          | **Created** | ~65                           |
| `renderer/OverlayRenderLoop.ts`            | Rewritten   | ~130 (was 333)                |
| `renderer/layers/presence-cursors.ts`      | Rewritten   | ~95 (was 356)                 |
| `renderer/layers/index.ts`                 | Edited      | removed drawPresenceOverlays  |
| `lib/tools/types.ts`                       | Edited      | removed TextPreview           |
| `canvas/CanvasRuntime.ts`                  | Edited      | 3 lines changed               |
| `lib/room-doc-manager.ts`                  | Edited      | removed import + 2 call sites |
