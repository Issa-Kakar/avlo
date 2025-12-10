# Camera Store Migration Changelog

## Overview

This changelog tracks the migration from `ViewTransformContext` (React Context) to a centralized Zustand camera store. The goal is maximum imperative access with zero prop drilling.

**Reference Document:** `CAMERA_STORE_IMPLEMENTATION.md`

---

## Completed Phases (1-8)

### Phase 1: Create Camera Store Foundation ✅

**File Created:** `client/src/stores/camera-store.ts`

**What was implemented:**
- `CameraState` interface with `scale`, `pan`, `cssWidth`, `cssHeight`, `dpr`
- `CameraActions` interface with `setScale`, `setPan`, `setScaleAndPan`, `setViewport`, `resetView`
- Zustand store with `subscribeWithSelector` middleware
- Scale clamping to `PERFORMANCE_CONFIG.MIN_ZOOM` / `MAX_ZOOM`
- Pan clamping to `PERFORMANCE_CONFIG.MAX_PAN_DISTANCE`

**Pure Transform Functions Exported:**
- `worldToCanvas(worldX, worldY)` - Convert world to canvas (CSS pixel) coordinates
- `canvasToWorld(canvasX, canvasY)` - Convert canvas to world coordinates
- `screenToWorld(clientX, clientY)` - Convert screen (client) to world coordinates
- `worldToClient(worldX, worldY)` - Convert world to screen (client) coordinates

**Viewport Utilities Exported:**
- `getVisibleWorldBounds()` - Get world-space bounds visible in viewport
- `getViewportInfo()` - Get viewport info with device pixel dimensions

**Selectors Exported:**
- `selectScale`, `selectPan`, `selectDpr`, `selectViewport`

**Compatibility Helpers:**
- `getViewTransform()` - Returns a `ViewTransform` object matching existing interface
- `createViewTransform(scale, pan)` - Create ViewTransform from explicit values

---

### Phase 2: Add Module-Level Canvas Reference ✅

**File:** `client/src/stores/camera-store.ts` (same file as Phase 1)

**What was implemented:**
- Module-level `canvasElement` variable (private)
- `setCanvasElement(el)` - Set the canvas element for coordinate conversion
- `getCanvasElement()` - Get the canvas element
- `getCanvasRect()` - Get canvas bounding rect for screen-to-canvas conversion

**Why module-level:** Avoids putting canvas element in React state (which would cause re-renders) while making it accessible to pure transform functions.

---

### Phase 3: Update CanvasStage ✅

**File Modified:** `client/src/canvas/CanvasStage.tsx`

**Changes:**
1. Added imports from `@/stores/camera-store`
2. ResizeObserver callback now calls `useCameraStore.getState().setViewport(width, height, dpr)`
3. DPR change handler now calls `useCameraStore.getState().setViewport(rect.width, rect.height, newDpr)`
4. On first context creation, registers canvas element via `setCanvasElement(canvas)`
5. On cleanup/unmount, clears canvas element via `setCanvasElement(null)`
6. Kept `onResize` callback for backward compatibility during migration

---

### Phase 4: Update RenderLoop ✅

**File Modified:** `client/src/renderer/RenderLoop.ts`

**Changes:**
1. Added imports from `@/stores/camera-store`:
   - `useCameraStore`, `getViewTransform`, `getViewportInfo`

2. Updated `RenderLoopConfig` interface:
   - Made `getView` optional with `@deprecated` JSDoc
   - Made `getViewport` optional with `@deprecated` JSDoc
   - This allows gradual migration without breaking existing code

3. Updated `start()` method:
   - Uses `getViewportInfo()` from camera store for initial sizing

4. Updated `tick()` method:
   - Reads `view` from `getViewTransform()` instead of `config.getView()`
   - Reads `viewport` from `getViewportInfo()` instead of `config.getViewport()`
   - Added early exit guard: `if (viewport.cssWidth <= 0 || viewport.cssHeight <= 0) return;`

5. Updated `invalidateWorld()` method:
   - Uses `getViewTransform()` instead of `config.getView()`

6. Updated `invalidateCanvas()` method:
   - Uses `useCameraStore.getState().scale` and `getViewportInfo()` instead of config callbacks

---

### Phase 5: Update OverlayRenderLoop ✅

**File Modified:** `client/src/renderer/OverlayRenderLoop.ts`

**Changes:**
1. Added imports from `@/stores/camera-store`:
   - `getViewTransform`, `getViewportInfo`

2. Updated `OverlayLoopConfig` interface:
   - Made `getView` optional with `@deprecated` JSDoc
   - Made `getViewport` optional with `@deprecated` JSDoc

3. Updated `frame()` method:
   - Uses `getViewportInfo()` from camera store instead of `config.getViewport()`
   - Uses `getViewTransform()` from camera store instead of `config.getView()`
   - Viewport guard already present (checks `cssWidth <= 1`)

---

### Phase 6: DirtyRectTracker - No Changes Needed ✅

**File:** `client/src/renderer/DirtyRectTracker.ts`

**Analysis:**
- DirtyRectTracker receives `ViewTransform` as a parameter to `invalidateWorldBounds()`
- This keeps it decoupled from the store and testable
- The caller (RenderLoop, already updated in Phase 4) gets the view from the camera store and passes it to DirtyRectTracker
- **No changes needed** - the design is correct as-is

---

### Phase 7: Simplify ZoomAnimator ✅

**File Modified:** `client/src/canvas/animation/ZoomAnimator.ts`

**Changes:**
1. Added import from `@/stores/camera-store`:
   - `useCameraStore`

2. **Removed all constructor parameters**:
   - OLD: `constructor(getView, setScale, setPan)`
   - NEW: `constructor()` - no parameters needed

3. Updated `tick()` method:
   - Reads current state via `useCameraStore.getState()` instead of `this.getView()`
   - Uses `setScaleAndPan()` for atomic updates instead of separate `setScale()` and `setPan()` calls
   - Convergence snap also uses `setScaleAndPan()` for atomic final update

4. **Updated Canvas.tsx instantiation** (required for typecheck to pass):
   - OLD: `new ZoomAnimator(() => viewTransformRef.current, (s) => ..., (p) => ...)`
   - NEW: `new ZoomAnimator()` - no arguments

---

### Phase 8: Update All Tools ✅

**Files Modified:**
- `client/src/lib/tools/SelectTool.ts`
- `client/src/lib/tools/DrawingTool.ts`
- `client/src/lib/tools/EraserTool.ts`
- `client/src/lib/tools/PanTool.ts`
- `client/src/lib/tools/TextTool.ts`

#### SelectTool.ts Changes:
1. Added imports: `useCameraStore`, `worldToCanvas` from `@/stores/camera-store`
2. **Removed** `getView` from `SelectToolOpts` interface
3. **Removed** local `ViewTransform` interface definition
4. **Removed** `private getView` field and constructor assignment
5. Updated `begin()`: Uses `worldToCanvas()` directly instead of `this.getView().worldToCanvas()`
6. Updated `move()`: Uses `worldToCanvas()` directly
7. Updated `end()`: Uses `worldToCanvas()` directly
8. Updated `hitTestHandle()`: Uses `useCameraStore.getState().scale` instead of `this.getView().scale`
9. Updated `hitTestObjects()`: Uses `useCameraStore.getState().scale` instead of `this.getView().scale`

#### DrawingTool.ts Changes:
1. **Removed** import of `ViewTransform` from `@avlo/shared`
2. Added import: `worldToCanvas` from `@/stores/camera-store`
3. **Removed** `private getView?: () => ViewTransform` field
4. **Removed** `getView` parameter from constructor (was 6th param, now only 5 params)
5. Updated `begin()`: HoldDetector jitter check now unconditionally uses `worldToCanvas()` (no guard needed)
6. Updated `move()`: HoldDetector jitter check now unconditionally uses `worldToCanvas()`

**New constructor signature:**
```typescript
constructor(
  room: IRoomDocManager,
  toolType: 'pen' | 'highlighter',
  userId: string,
  onInvalidate?: (bounds: [number, number, number, number]) => void,
  requestOverlayFrame?: RequestOverlayFrame,
  opts?: { forceSnapKind?: ForcedSnapKind }
)
```

#### EraserTool.ts Changes:
1. Added import: `useCameraStore` from `@/stores/camera-store`
2. **Removed** `private getView?: () => ViewTransform` field
3. **Removed** `getView` parameter from constructor (was 3rd param, now only 2 params)
4. **Removed** local `ViewTransform` interface definition at end of file
5. Updated `updateHitTest()`: Uses `useCameraStore.getState().scale` instead of `this.getView().scale`

**New constructor signature:**
```typescript
constructor(
  room: IRoomDocManager,
  onInvalidate?: () => void,
)
```

#### PanTool.ts Changes:
1. **Removed** import of `ViewTransform` from `@avlo/shared`
2. Added import: `useCameraStore` from `@/stores/camera-store`
3. **Removed** `private getView` and `private setPan` from constructor params
4. Updated `updatePan()`: Uses `useCameraStore.getState()` to get `scale`, `pan`, and `setPan`

**New constructor signature:**
```typescript
constructor(
  onInvalidateOverlay: () => void,
  applyCursor: () => void,
  setCursorOverride: (cursor: string | null) => void,
)
```

#### TextTool.ts Changes:
1. **Removed** import of `ViewTransform` from `@avlo/shared`
2. Added imports: `useCameraStore`, `worldToClient as cameraWorldToClient` from `@/stores/camera-store`
3. **Removed** `worldToClient` and `getView` from `CanvasHandle` interface (now only has `getEditorHost`)
4. Updated `begin()`: Uses `cameraWorldToClient()` instead of `this.canvasHandle.worldToClient()`
5. Updated `updateConfig()`: Uses `useCameraStore.getState().scale` instead of `this.canvasHandle.getView().scale`
6. Updated `onViewChange()`: Uses `useCameraStore.getState().scale` and `cameraWorldToClient()`
7. Updated `createEditor()`: Uses `useCameraStore.getState().scale`
8. Updated `commitTextCore()`: Uses `useCameraStore.getState().scale`

**New CanvasHandle interface:**
```typescript
export interface CanvasHandle {
  getEditorHost: () => HTMLElement | null;
}
```

---

## Phase 9: Canvas.tsx Refactor (Second Pass - RUNTIME BUG DISCOVERED) ⚠️

### Summary of Current State

Canvas.tsx now compiles cleanly (no typecheck errors), but there is a **critical runtime initialization bug**.

### What Was Fixed (Second Agent):

1. **Removed unused imports** - `setCanvasElement`, `getViewTransform` (CanvasStage handles registration)
2. **Removed `useState` for `_canvasSize`** - No longer needed, store handles viewport
3. **Deleted `screenToWorld`/`worldToClient` useCallback wrappers** - Now uses `cameraScreenToWorld`/`cameraWorldToClient` directly
4. **Deleted `handleBaseResize`/`handleOverlayResize` callbacks** - CanvasStage updates store directly
5. **Removed `onResize` props from CanvasStage JSX** - No more prop drilling for resize
6. **Fixed `viewTransformRef.current` crash** - Removed the check entirely (camera store always has valid defaults)
7. **Cleaned up effect dependencies** - Removed pure functions from dependency arrays
8. **Updated all `screenToWorld` calls** - Now use `cameraScreenToWorld` throughout event handlers
9. **Updated imperative handle** - Uses `cameraScreenToWorld`/`cameraWorldToClient` directly with empty deps

### Typecheck Status: ✅ PASSING

Canvas.tsx has no typecheck errors. The remaining ~25 errors in the codebase are pre-existing unused variable warnings in test files.

---

## 🚨 CRITICAL RUNTIME BUG: DUAL STATE PROBLEM 🚨

### Symptom

Tools, zoom, and pan **only work after switching to the text tool first**. Before that, nothing responds to input.

### Root Cause Analysis

**There are TWO sources of truth for camera state that are NOT connected:**

1. **Camera Store** (`client/src/stores/camera-store.ts`)
   - Has `scale`, `pan`, `cssWidth`, `cssHeight`, `dpr`
   - Tools read from here (via `useCameraStore.getState()`)
   - Canvas event handlers use `cameraScreenToWorld()` which reads from here
   - Initialized with defaults: `scale: 1, pan: {x:0, y:0}, cssWidth: 1, cssHeight: 1`

2. **ViewTransformContext** (`client/src/canvas/ViewTransformContext.tsx`)
   - STILL EXISTS and is STILL the primary source of truth for UI
   - Still wraps the canvas in `RoomPage.tsx` and `App.tsx`
   - `ZoomControls.tsx` uses `useViewTransform()` to read/write scale
   - Has its own `scale`, `pan` state that is NEVER synced to camera store

### Why Text Tool "Fixes" It

When you switch to text tool:
- TextTool places a DOM overlay via `getEditorHost()`
- This might trigger a re-render or effect that happens to initialize something
- OR the act of clicking to place text triggers coordinate conversion that works
- The exact mechanism needs investigation, but the root cause is clear: **dual state**

### Files Still Using ViewTransformContext

```
client/src/App.tsx:
  - import { ViewTransformProvider, useViewTransform }
  - <ViewTransformProvider> wraps entire app (line 149)
  - Uses useViewTransform() for dev UI (line 22)

client/src/pages/RoomPage.tsx:
  - import { ViewTransformProvider }
  - <ViewTransformProvider> wraps canvas (line 184-186)

client/src/pages/components/ZoomControls.tsx:
  - import { useViewTransform }
  - const { viewState, setScale, resetView } = useViewTransform() (line 10)
  - Zoom buttons update ViewTransformContext, NOT camera store!

client/src/hooks/use-coordinate-transform.ts:
  - Uses useViewTransform() internally

client/src/canvas/__tests__/Canvas.test.tsx:
  - Wraps tests in ViewTransformProvider
```

### The Problem Visualized

```
User clicks zoom button
        ↓
ZoomControls calls setScale() from useViewTransform()
        ↓
ViewTransformContext state updates (scale = 2.0)
        ↓
But camera store still has scale = 1.0!
        ↓
Tool reads useCameraStore.getState().scale → gets 1.0
        ↓
Tool operates at wrong scale, coordinates are wrong
        ↓
Nothing works correctly
```

### What Must Happen (Phase 10-11)

**Phase 10 is MANDATORY to fix this bug.** The code cannot work correctly until:

1. **ZoomControls.tsx** must use camera store:
   ```typescript
   // BEFORE:
   const { viewState, setScale, resetView } = useViewTransform();

   // AFTER:
   const scale = useCameraStore(selectScale);
   const setScale = useCameraStore(s => s.setScale);
   const resetView = useCameraStore(s => s.resetView);
   ```

2. **RoomPage.tsx** must remove ViewTransformProvider:
   ```typescript
   // BEFORE:
   <ViewTransformProvider>
     <RoomCanvas roomId={roomId} />
   </ViewTransformProvider>

   // AFTER:
   <RoomCanvas roomId={roomId} />
   ```

3. **App.tsx** must remove ViewTransformProvider wrapper and useViewTransform usage

4. **Delete ViewTransformContext.tsx** entirely (Phase 11)

5. **Delete use-coordinate-transform.ts** (Phase 11)

6. **Update Canvas.test.tsx** to not use ViewTransformProvider

### Why This Bug Exists

Previous agents modified Canvas.tsx and tools to read from camera store, but **never removed the old ViewTransformContext**. The UI components (ZoomControls, etc.) still write to the OLD context, creating a split-brain situation where:
- UI writes to ViewTransformContext
- Tools read from camera store
- The two never communicate

### Canvas Element Registration

One additional concern: `screenToWorld()` returns `null` if the canvas element isn't registered. Check that:
- `setCanvasElement(canvas)` is called correctly by CanvasStage
- The BASE canvas (not overlay) is what gets registered
- Registration happens before any tool attempts to use `screenToWorld()`

In CanvasStage.tsx line 233-235:
```typescript
if (canvas && !getCanvasElement()) {
  setCanvasElement(canvas);
}
```

This only sets if NOT already set. If overlay fires first, base canvas won't register. However, in the JSX order, base canvas is first, so this should be fine. But verify this during debugging.

---

## Phase 10: Update UI Components ✅ COMPLETE

**This phase fixed the initialization bug - tools now work immediately on load.**

### Changes Made:

1. **ZoomControls.tsx** ✅:
   - Replaced `useViewTransform()` with `useCameraStore(selectScale)`, `useCameraStore(s => s.setScale)`, `useCameraStore(s => s.resetView)`
   - All `viewState.scale` references updated to `scale`

2. **RoomPage.tsx** ✅:
   - Removed `ViewTransformProvider` import
   - Removed wrapper - now renders `<RoomCanvas roomId={roomId} />` directly

3. **App.tsx** ✅:
   - Removed `ViewTransformProvider` and `useViewTransform` imports
   - Added `useCameraStore` import
   - Updated `CanvasWithControls` to use camera store for scale/pan/setScale/setPan/resetView
   - Removed `ViewTransformProvider` wrapper from `TestHarness`

---

## Phase 11: Delete Old Files ✅ COMPLETE

- DELETED: `client/src/canvas/ViewTransformContext.tsx`
- DELETED: `client/src/hooks/use-coordinate-transform.ts`

---

## Phase 12: Update Tests ✅ PARTIALLY COMPLETE

- Updated `Canvas.test.tsx`:
  - Removed `ViewTransformProvider` import
  - Added `useCameraStore` import
  - Added camera store reset in `beforeEach`
  - Removed all `ViewTransformProvider` wrappers from test cases

**Note:** Tests may be deleted soon per user's indication.

---

## Additional Fixes Made (Beyond Original Plan)

### Simplified Canvas.tsx - Removed stageReady Over-Engineering

**Key Insight:** The `stageReady` gate was unnecessary. Event handlers already guard themselves with `if (!worldCoords) return` when `screenToWorld()` returns null.

**Changes:**
1. **Removed `stageReady` computation entirely** (was line 192)
2. **Removed `stageReady` guard from event listener effect** - handlers self-guard
3. **Removed `stageReady` from dependency arrays** (tool effect, event listener effect)
4. **Added comment explaining the imperative pattern**

### Synchronous Canvas Registration in CanvasStage

**Key Fix:** Canvas element was being registered in ResizeObserver callback (async), causing a race condition where event handlers would try to use `screenToWorld()` before the canvas was registered.

**Changes to CanvasStage.tsx:**
1. Added `useCallback` import
2. Created `canvasRefCallback` that registers canvas synchronously:
   ```typescript
   const canvasRefCallback = useCallback((el: HTMLCanvasElement | null) => {
     canvasRef.current = el;
     setCanvasElement(el); // Synchronous! Before effects run
   }, []);
   ```
3. Changed canvas JSX from `ref={canvasRef}` to `ref={canvasRefCallback}`
4. Removed async registration from ResizeObserver callback
5. Changed `canvasRef` type to `useRef<HTMLCanvasElement | null>(null)` for mutable ref pattern

### handleWheel Now Uses Camera Store

**Change:** `handleWheel` in Canvas.tsx now uses `getCanvasRect()` from camera-store instead of manually calling `baseStageRef.current?.getCanvasElement()?.getBoundingClientRect()`.

---

## Phase 13: Fix DPR/Resize + Final Simplifications ✅ COMPLETE

### Problem Solved
When moving the browser window between monitors with different DPRs, or when resizing the window, the canvas didn't update properly because Canvas.tsx only subscribed to `scale` and `pan` changes, not viewport changes.

### Solution: Separate Viewport Subscription
Added a second subscription in Canvas.tsx specifically for viewport changes:

```typescript
// 3G: Handle viewport changes (resize/DPR) - triggers full redraw
useEffect(() => {
  const unsubscribe = useCameraStore.subscribe(
    (state) => ({ cssWidth: state.cssWidth, cssHeight: state.cssHeight, dpr: state.dpr }),
    () => {
      renderLoopRef.current?.invalidateAll('geometry-change');
      overlayLoopRef.current?.invalidateAll();
    },
    { equalityFn: (a, b) => a.cssWidth === b.cssWidth && a.cssHeight === b.cssHeight && a.dpr === b.dpr }
  );
  return unsubscribe;
}, []);
```

### Additional Simplifications

**1. Added `screenToCanvas` helper to camera-store:**
```typescript
export function screenToCanvas(clientX: number, clientY: number): [number, number] | null {
  const rect = getCanvasRect();
  if (rect.width === 0) return null;
  return [clientX - rect.left, clientY - rect.top];
}
```

**2. Refactored `screenToWorld` to use `screenToCanvas`:**
```typescript
export function screenToWorld(clientX: number, clientY: number): [number, number] | null {
  const canvasCoords = screenToCanvas(clientX, clientY);
  if (!canvasCoords) return null;
  return canvasToWorld(canvasCoords[0], canvasCoords[1]);
}
```

**3. Simplified handleWheel in Canvas.tsx:**
- Removed manual `getCanvasRect()` call and `e.clientX - rect.left` calculation
- Now uses `cameraScreenToCanvas(e.clientX, e.clientY)` directly

---

## ✅ MIGRATION COMPLETE

### Final State Summary

| Component | Status |
|-----------|--------|
| `camera-store.ts` | ✅ Complete |
| `CanvasStage.tsx` | ✅ Complete (sync registration) |
| `RenderLoop.ts` | ✅ Complete |
| `OverlayRenderLoop.ts` | ✅ Complete |
| `ZoomAnimator.ts` | ✅ Complete |
| All Tools | ✅ Complete |
| `Canvas.tsx` | ✅ Complete (viewport subscription added) |
| `ZoomControls.tsx` | ✅ Complete |
| `RoomPage.tsx` | ✅ Complete |
| `App.tsx` | ✅ Complete |
| `ViewTransformContext.tsx` | ✅ DELETED |
| `use-coordinate-transform.ts` | ✅ DELETED |
| DPR/Resize handling | ✅ FIXED |

### What's Working
- ✅ Initial load - tools work immediately (no tool switch needed)
- ✅ Wheel zoom (centers on cursor, smooth animation)
- ✅ Zoom buttons (+/-/reset)
- ✅ MMB pan
- ✅ Pan tool
- ✅ Drawing at various zoom levels
- ✅ Selection with transforms
- ✅ Window resize triggers canvas redraw
- ✅ DPR change (moving between monitors) updates canvas

---

## Files Changed Summary (Final)

### Created:
- `client/src/stores/camera-store.ts` (Phases 1-2)

### Modified:
- `client/src/canvas/CanvasStage.tsx` - Sync canvas registration via ref callback
- `client/src/canvas/Canvas.tsx` - Uses camera store imperatively, viewport subscription
- `client/src/renderer/RenderLoop.ts` - Reads from camera store
- `client/src/renderer/OverlayRenderLoop.ts` - Reads from camera store
- `client/src/canvas/animation/ZoomAnimator.ts` - No constructor params, reads/writes store
- `client/src/lib/tools/*.ts` - All tools read from camera store
- `client/src/pages/components/ZoomControls.tsx` - Uses camera store
- `client/src/pages/RoomPage.tsx` - Removed ViewTransformProvider
- `client/src/App.tsx` - Uses camera store, removed ViewTransformProvider
- `client/src/canvas/__tests__/Canvas.test.tsx` - Updated for camera store

### Deleted:
- `client/src/canvas/ViewTransformContext.tsx` ✅
- `client/src/hooks/use-coordinate-transform.ts` ✅

### Not Changed (by design):
- `client/src/renderer/DirtyRectTracker.ts` - Receives ViewTransform as parameter, stays decoupled

---

## Architecture Summary

### Before (ViewTransformContext)
```
ViewTransformContext (React Context)
    ↓
useViewTransform() hook
    ↓
Canvas.tsx (16+ refs, useLayoutEffect syncing)
    ↓
Callbacks passed to: RenderLoop, OverlayRenderLoop, Tools, ZoomAnimator
    ↓
Each consumer calls getView() callback
```

### After (Camera Store)
```
useCameraStore (Zustand with subscribeWithSelector)
    ↓
Pure functions: worldToCanvas, screenToWorld, screenToCanvas, etc.
    ↓
All consumers import directly from camera-store
    ↓
Store.getState() for imperative access
```

### Benefits Achieved
- **Single source of truth** for camera state
- **No prop drilling** - all consumers import directly
- **No callback chains** - pure functions read from store
- **Selective subscriptions** - only re-render on relevant changes
- **Simpler testing** - store can be reset/mocked easily
- **Imperative pattern** - try operations, let guards handle edge cases

---

## 🚨 ONGOING: Viewport/DPR Blank Canvas Bug (Phase 14)

### Symptom (STILL OCCURRING)
Canvas goes blank after:
1. Leaving tab idle overnight
2. Switching monitors (DPR change) - specifically: going to monitor A, then B, then back to A while dragging

**Workarounds that fix it:**
- Zoom (triggers full clear via `notifyTransformChange()`)
- Draw (reveals portions via dirty rect clear)

**Key diagnostic clue:**
- **Success case (4 logs):** 2 pairs of `[DirtyRectTracker] invalidateAll: full clear` + `[RenderLoop] geometry-change`
- **Failure case (2 logs):** Only 1 pair of these logs
- When there are 4 logs → canvas renders correctly
- When there are 2 logs → canvas stays blank

---

### Phase 14a: DPR Race Condition Fix ✅ (PARTIAL - Bug Still Occurs)

**Problem identified:** Both ResizeObserver and DPR listener read `window.devicePixelRatio` directly at callback time. When browser updates DPR before ResizeObserver fires, both see the same NEW value and make identical `setViewport()` calls. Zustand doesn't trigger subscribers when values are identical.

**Fix applied to CanvasStage.tsx:**
```typescript
// BEFORE (line 211):
const dpr = window.devicePixelRatio || 1;  // ❌ Reads potentially changed DPR
dprRef.current = dpr;                       // ❌ Overwrites stored DPR

// AFTER:
const dpr = dprRef.current;  // ✅ Use stored DPR - only DPR listener updates this
// DON'T update dprRef here
```

**Rationale:** ResizeObserver handles SIZE changes using confirmed DPR. DPR listener is the single source of truth for DPR value.

---

### Phase 14b: RenderLoop Transform Tracking Cleanup ✅

Removed redundant `lastTransformState` tracking. Transform changes were tracked in TWO places:
1. Subscription callback (detected changes, called `markDirty()`)
2. `tick()` method (ALSO detected changes, called `notifyTransformChange()`)

**Changes to RenderLoop.ts:**
1. Added transform initialization in `start()`: `dirtyTracker.notifyTransformChange(initialView)`
2. Updated subscription callback to call `notifyTransformChange()` directly for transform changes
3. Removed `lastTransformState` field entirely
4. Removed transform comparison block from `tick()`

---

### 🔴 ROOT CAUSE FOUND - Canvas Clearing Without Redraw

**The actual bug is in CanvasStage.tsx, NOT in RenderLoop or DirtyRectTracker.**

#### The Problem

**Critical Canvas API fact**: Setting `canvas.width` or `canvas.height` **ALWAYS clears the canvas**, even if setting to the same value!

CanvasStage unconditionally sets `canvas.width` and `canvas.height` in BOTH:
- ResizeObserver callback (lines 221-222)
- DPR handler (lines 175-176)

#### The Bug Sequence

```
Initial: Monitor A (DPR 1), Store: {cssWidth: 1920, cssHeight: 1080, dpr: 1}
Canvas has content drawn.

=== Drag to Monitor B (DPR 2), then back to Monitor A ===

1. DPR listener fires (DPR changed to 1):
   - canvas.width = 1920 → CANVAS CLEARED BY BROWSER
   - setViewport(1920, 1080, 1) → store changes (was dpr:2)
   - Subscription fires → invalidateAll(), markDirty()
   - tick() scheduled via rAF

2. tick() runs (next animation frame):
   - getClearInstructions() → 'full'
   - Draw pass → content drawn
   - reset() → fullClearRequired = false, needsFrame = false

3. ResizeObserver fires AFTER tick() completed:
   - dpr = dprRef.current = 1 (updated in step 1)
   - canvas.width = 1920 → CANVAS CLEARED AGAIN!
   - setViewport(1920, 1080, 1) → SAME VALUES as store
   - Zustand: equalityFn returns true → NO subscription
   - NO invalidateAll(), NO markDirty()
   - CANVAS STAYS BLANK FOREVER!
```

#### Why 2 logs vs 4 logs

- **4 logs (success)**: Both observers fire BEFORE tick(), both trigger subscriptions
- **2 logs (failure)**: One fires, tick() runs, THEN second fires with same values → clears canvas but no redraw

#### The Fix (Phase 14c)

**Guard canvas.width/height assignments to only set when values actually change:**

```typescript
// In ResizeObserver callback:
const newWidth = Math.min(width * dpr, maxDim);
const newHeight = Math.min(height * dpr, maxDim);

// Only set if changed - setting canvas dimensions clears the canvas!
if (canvas.width !== newWidth || canvas.height !== newHeight) {
  canvas.width = newWidth;
  canvas.height = newHeight;
}

// Always reapply transform (DPR might have changed even if pixel dims same)
ctxRef.current?.setTransform(dpr, 0, 0, dpr, 0, 0);
```

This needs to be applied in BOTH:
1. **ResizeObserver callback** (lines 221-222)
2. **DPR handler** (lines 175-176)

---

### Phase 14c: Check Before Assign Canvas Dimensions ✅ FIXED

**Root Cause Confirmed:**
When dragging a tab Monitor A → Monitor B → back to Monitor A (without pointer up), the canvas goes blank. Debug logs revealed:
- **Success case (4 logs):** Two pairs of invalidation frames triggered
- **Failure case (2 logs):** Only one pair - second ResizeObserver fires with SAME dimensions

**The Bug Sequence:**
1. Return to Monitor A → ResizeObserver fires with identical width/height/DPR
2. `canvas.width = sameValue` executes → **Canvas API clears the canvas** (always happens on assignment!)
3. Zustand equality check sees no change → **No `invalidateAll()` triggered**
4. Canvas stays blank forever

**The Fix (CanvasStage.tsx):**
Added "check before assign" guards in BOTH ResizeObserver and DPR handler:

```typescript
// Calculate new dimensions
const newWidth = Math.min(width * dpr, maxDim);
const newHeight = Math.min(height * dpr, maxDim);

// Only set if changed - setting canvas dimensions ALWAYS clears the canvas!
if (canvas.width !== newWidth || canvas.height !== newHeight) {
  canvas.width = newWidth;
  canvas.height = newHeight;
}
```

This prevents the canvas from being cleared when dimensions haven't actually changed, avoiding the race condition where the canvas is cleared but no redraw is triggered.

**Also removed:** Debug console.log statements (lines 239-241)

---

### Files Changed in This Session (Phase 14a/14b/14c)

| File | Changes |
|------|---------|
| `CanvasStage.tsx` | ResizeObserver now uses `dprRef.current` instead of `window.devicePixelRatio`, removed dprRef update from ResizeObserver, **added check-before-assign guards for canvas dimensions** |
| `RenderLoop.ts` | Added transform init in start(), moved notifyTransformChange() to subscription callback, removed lastTransformState field and tick() transform check |

---

### Previous Attempts (Still in codebase)

**Added RenderLoop camera store subscription:**
```typescript
// In start(), subscribes to camera store
this.cameraUnsubscribe = useCameraStore.subscribe(
  (state) => ({ scale, panX, panY, cssWidth, cssHeight, dpr }),
  (curr, prev) => {
    // Viewport changed -> full clear
    if (cssWidth/cssHeight/dpr changed) {
      this.dirtyTracker.setCanvasSize(pixelWidth, pixelHeight, dpr);
      this.dirtyTracker.invalidateAll('geometry-change');
      this.markDirty();
      return;
    }
    // Transform changed -> notify tracker and schedule frame
    if (scale/pan changed) {
      this.dirtyTracker.notifyTransformChange({ scale, pan });
      this.markDirty();
    }
  }
);
```

**Added OverlayRenderLoop camera store subscription:**
- Subscribes to camera store, calls `invalidateAll()` on any change

**Removed Canvas.tsx redundant subscriptions:**
- Kept only tool notification subscription (for TextTool/EraserTool DOM repositioning)

**Migrated getVisibleWorldBounds:**
- `objects.ts` and `RenderLoop.ts` use parameterless version from camera-store
