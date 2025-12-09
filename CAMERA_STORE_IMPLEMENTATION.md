# Camera Store Architecture Implementation Guide

## Executive Summary

This document provides step-by-step instructions to replace `ViewTransformContext` (React Context) with a centralized Zustand camera store. The goal is maximum imperative access with zero prop drilling - tools, render loops, and overlays read directly from the store.

**Scope:** Complete replacement, not gradual migration. Delete ViewTransformContext entirely.

**Key Principle:** Be as destructive as possible. Eliminate all boilerplate, callback chains, and ref juggling.

---

## Table of Contents

1. [Phase 1: Create Camera Store Foundation](#phase-1-create-camera-store-foundation)
2. [Phase 2: Add Module-Level Canvas Reference](#phase-2-add-module-level-canvas-reference)
3. [Phase 3: Update CanvasStage to Update Store Directly](#phase-3-update-canvasstage-to-update-store-directly)
4. [Phase 4: Update RenderLoop](#phase-4-update-renderloop)
5. [Phase 5: Update OverlayRenderLoop](#phase-5-update-overlayrendererloop)
6. [Phase 6: Update DirtyRectTracker](#phase-6-update-dirtyrecttracker)
7. [Phase 7: Simplify ZoomAnimator](#phase-7-simplify-zoomanimator)
8. [Phase 8: Update All Tools](#phase-8-update-all-tools)
9. [Phase 9: Major Canvas.tsx Refactor](#phase-9-major-canvastsx-refactor)
10. [Phase 10: Update UI Components](#phase-10-update-ui-components)
11. [Phase 11: Delete Old Files](#phase-11-delete-old-files)
12. [Phase 12: Update Tests](#phase-12-update-tests)
13. [Phase 13: Typecheck and Verification](#phase-13-typecheck-and-verification)

---

## Phase 1: Create Camera Store Foundation

**File to CREATE:** `client/src/stores/camera-store.ts`

### Step 1.1: Create the store file

Create a new file at `client/src/stores/camera-store.ts` with the following structure:

**Imports needed:**
- `create` from `zustand`
- `subscribeWithSelector` from `zustand/middleware`
- `PERFORMANCE_CONFIG` from `@avlo/shared`

### Step 1.2: Define interfaces

Define the following interfaces in the camera store file:

**CameraState interface:**
- `scale: number` - zoom level (1.0 = 100%)
- `pan: { x: number; y: number }` - world offset in world units
- `cssWidth: number` - viewport CSS width
- `cssHeight: number` - viewport CSS height
- `dpr: number` - device pixel ratio

**CameraActions interface:**
- `setScale: (scale: number) => void`
- `setPan: (pan: { x: number; y: number }) => void`
- `setScaleAndPan: (scale: number, pan: { x: number; y: number }) => void`
- `setViewport: (cssWidth: number, cssHeight: number, dpr: number) => void`
- `resetView: () => void`

### Step 1.3: Implement store with subscribeWithSelector middleware

The store must use `subscribeWithSelector` middleware to enable granular subscriptions.

**setScale action:**
- Clamp to `PERFORMANCE_CONFIG.MIN_ZOOM` and `PERFORMANCE_CONFIG.MAX_ZOOM`
- Use `set({ scale: clampedScale })`

**setPan action:**
- Clamp x and y to `PERFORMANCE_CONFIG.MAX_PAN_DISTANCE` (symmetric bounds)
- Use `set({ pan: clampedPan })`

**setScaleAndPan action:**
- Apply both clamps in a single set call
- This is used by ZoomAnimator for atomic updates

**setViewport action:**
- Simply `set({ cssWidth, cssHeight, dpr })`

**resetView action:**
- `set({ scale: 1, pan: { x: 0, y: 0 } })`

**Initial state:**
- `scale: 1`
- `pan: { x: 0, y: 0 }`
- `cssWidth: 1` (safe non-zero default)
- `cssHeight: 1`
- `dpr: typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1`

### Step 1.4: Create pure transform functions (exported from module)

These are NOT part of the store state - they are pure functions that read from the store synchronously.

**worldToCanvas function:**
- Signature: `(worldX: number, worldY: number) => [number, number]`
- Implementation: Get scale and pan from `useCameraStore.getState()`, return `[(worldX - pan.x) * scale, (worldY - pan.y) * scale]`

**canvasToWorld function:**
- Signature: `(canvasX: number, canvasY: number) => [number, number]`
- Implementation: Get scale and pan from store, guard scale with `Math.max(1e-6, scale)`, return `[canvasX / s + pan.x, canvasY / s + pan.y]`

**screenToWorld function:**
- Signature: `(clientX: number, clientY: number) => [number, number] | null`
- Implementation: Get canvas rect from module-level ref (see Phase 2), compute canvasX/Y as clientX - rect.left, call canvasToWorld
- Return null if rect.width is 0 (not yet mounted)

**worldToClient function:**
- Signature: `(worldX: number, worldY: number) => [number, number]`
- Implementation: Get canvas rect, call worldToCanvas, add rect.left/top to result

### Step 1.5: Create viewport utility functions

**getVisibleWorldBounds function:**
- Signature: `() => { minX: number; minY: number; maxX: number; maxY: number }`
- Read cssWidth, cssHeight, scale, pan from store
- Return `{ minX: pan.x, minY: pan.y, maxX: cssWidth / scale + pan.x, maxY: cssHeight / scale + pan.y }`

**getViewportInfo function:**
- Signature: `() => { pixelWidth: number; pixelHeight: number; cssWidth: number; cssHeight: number; dpr: number }`
- Read from store, compute pixelWidth as `Math.round(cssWidth * dpr)`

### Step 1.6: Create selectors for React components

Export named selectors for efficient subscriptions:
- `selectScale = (s: CameraStore) => s.scale`
- `selectPan = (s: CameraStore) => s.pan`
- `selectDpr = (s: CameraStore) => s.dpr`

### Step 1.7: Create getViewTransform helper

**getViewTransform function:**
- Signature: `() => ViewTransform`
- Returns an object matching the existing ViewTransform interface with worldToCanvas, canvasToWorld functions, scale, and pan
- This provides backward compatibility for code that expects the old interface

---

## Phase 2: Add Module-Level Canvas Reference

**File:** `client/src/stores/camera-store.ts` (same file)

### Step 2.1: Add module-level variable

At the top of the camera store file (after imports, before store), add:
- `let canvasElement: HTMLCanvasElement | null = null;`

### Step 2.2: Add setter function

**setCanvasElement function:**
- Signature: `(el: HTMLCanvasElement | null) => void`
- Implementation: `canvasElement = el;`
- Export this function

### Step 2.3: Add getter function

**getCanvasRect function:**
- Signature: `() => DOMRect`
- Implementation: `return canvasElement?.getBoundingClientRect() ?? new DOMRect();`
- Export this function

This pattern avoids putting the canvas element in React state (which would cause re-renders) while still making it accessible to the pure transform functions.

---

## Phase 3: Update CanvasStage to Update Store Directly

**File:** `client/src/canvas/CanvasStage.tsx`

### Step 3.1: Import camera store

Add import for `useCameraStore` from `@/stores/camera-store`

### Step 3.2: Get setViewport action

Inside the component, get the setViewport action:
- Use `useCameraStore(s => s.setViewport)` or `useCameraStore.getState().setViewport`
- Prefer the latter to avoid subscription overhead since this is called imperatively

### Step 3.3: Update ResizeObserver callback

In the ResizeObserver callback (around line 196-237):
- After computing width, height, dpr: call `useCameraStore.getState().setViewport(width, height, dpr)`
- Keep the existing `onResize?.(info)` call for backward compatibility during migration
- Later, the onResize prop can be removed entirely

### Step 3.4: Update DPR change handler

In the DPR change handler (around line 143-193):
- After recomputing with new DPR: call `useCameraStore.getState().setViewport(rect.width, rect.height, newDpr)`
- Keep the existing `onResize?.(info)` call

### Step 3.5: Consider removing onResize prop entirely

Once Canvas.tsx is updated to read viewport from store, the `onResize` callback becomes unnecessary. Mark it as deprecated or remove it.

---

## Phase 4: Update RenderLoop

**File:** `client/src/renderer/RenderLoop.ts`

### Step 4.1: Import camera store functions

Add imports from `@/stores/camera-store`:
- `useCameraStore`
- `worldToCanvas`
- `canvasToWorld`
- `getVisibleWorldBounds`
- `getViewportInfo`
- `getViewTransform`

### Step 4.2: Update RenderLoopConfig interface

Modify the `RenderLoopConfig` interface:
- REMOVE: `getView: () => ViewTransform`
- REMOVE: `getViewport: () => ViewportInfo`
- Keep: `stageRef`, `getSnapshot`, `getGates`, `onStats`, `isMobile`

### Step 4.3: Update tick() method

In the tick() method (around line 196):

**Replace view reading:**
- OLD: `const view = this.config.getView();`
- NEW: `const { scale, pan } = useCameraStore.getState();`
- Create inline transform object if needed, OR use `getViewTransform()` helper

**Replace viewport reading:**
- OLD: `const viewport = this.config.getViewport();`
- NEW: `const viewport = getViewportInfo();`

**Add early exit guard:**
- At the start of tick(), add: `if (viewport.cssWidth <= 0 || viewport.cssHeight <= 0) return;`
- This handles the case where viewport isn't sized yet

### Step 4.4: Update dirty rect tracking

In the transform change detection (around line 240-253):
- Read scale and pan directly from store
- Compare with `this.lastTransformState` as before
- Call `this.dirtyTracker.notifyTransformChange({ scale, pan })` with inline object

### Step 4.5: Update coordinate conversions

Replace any calls to `view.worldToCanvas()` or `view.canvasToWorld()` with the imported pure functions.

### Step 4.6: Update clip region calculation

In the clip region conversion (around line 359-395):
- Use the imported `canvasToWorld` function instead of `view.canvasToWorld`

### Step 4.7: Update drawing pass transform

In the draw pass (around line 345-346):
- Apply transform using scale and pan from store: `ctx.scale(scale, scale); ctx.translate(-pan.x, -pan.y);`

---

## Phase 5: Update OverlayRenderLoop

**File:** `client/src/renderer/OverlayRenderLoop.ts`

### Step 5.1: Import camera store

Add imports from `@/stores/camera-store`:
- `useCameraStore`
- `getViewTransform`
- `getViewportInfo`

### Step 5.2: Update OverlayLoopConfig interface

Modify the config interface:
- REMOVE: `getView: () => ViewTransform`
- REMOVE: `getViewport: () => { cssWidth, cssHeight, dpr }`
- Keep: `stage`, `getGates`, `getPresence`, `getSnapshot`, `drawPresence`

### Step 5.3: Update frame() method

Replace view/viewport reading:
- OLD: `const view = this.config.getView();`
- NEW: `const view = getViewTransform();`
- OLD: `const vp = this.config.getViewport();`
- NEW: Read directly from store or use getViewportInfo

### Step 5.4: Add viewport guard

Add early exit: `if (vp.cssWidth <= 0) return;`

---

## Phase 6: Update DirtyRectTracker

**File:** `client/src/renderer/DirtyRectTracker.ts`

### Step 6.1: Analysis - minimal changes needed

DirtyRectTracker receives ViewTransform as a parameter to its methods - it doesn't store or subscribe to it. The changes are minimal.

### Step 6.2: Update invalidateWorldBounds method signature (optional)

Currently: `invalidateWorldBounds(bounds: WorldBounds, viewTransform: ViewTransform): void`

Two options:
1. Keep as-is: Caller passes viewTransform (still works)
2. Import from store: Call `getViewTransform()` internally

**Recommendation:** Option 1 for now. The caller (RenderLoop.invalidateWorld) constructs the transform object and passes it. This keeps DirtyRectTracker more testable.

### Step 6.3: Update Canvas.tsx invalidation calls

When Canvas.tsx calls `renderLoop.invalidateWorld(bounds)`, the RenderLoop will internally get the view from the store and pass to DirtyRectTracker. No change needed in DirtyRectTracker itself.

---

## Phase 7: Simplify ZoomAnimator

**File:** `client/src/canvas/animation/ZoomAnimator.ts`

### Step 7.1: Import camera store

Add import: `import { useCameraStore } from '@/stores/camera-store';`

### Step 7.2: Remove constructor parameters

**OLD constructor:**
```
constructor(
  private getView: () => { scale, pan },
  private setScale: (scale: number) => void,
  private setPan: (pan: { x, y }) => void,
)
```

**NEW constructor:**
```
constructor() {
  // No parameters needed!
}
```

### Step 7.3: Update tick() method

**Replace view reading:**
- OLD: `const v = this.getView();`
- NEW: `const { scale, pan } = useCameraStore.getState();`

**Replace state updates:**
- OLD: `this.setScale(scale); this.setPan(pan);`
- NEW: `useCameraStore.getState().setScaleAndPan(newScale, newPan);`

Use setScaleAndPan for atomic updates during animation.

### Step 7.4: Update convergence snap

At the end of animation (when converged):
- OLD: `this.setScale(this.targetScale); this.setPan(this.targetPan);`
- NEW: `useCameraStore.getState().setScaleAndPan(this.targetScale, this.targetPan);`

---

## Phase 8: Update All Tools

### Step 8.1: SelectTool.ts

**File:** `client/src/lib/tools/SelectTool.ts`

**Update SelectToolOpts interface:**
- REMOVE: `getView: () => ViewTransform`

**Add import:**
- `import { useCameraStore, worldToCanvas } from '@/stores/camera-store';`

**Update view reading (all occurrences):**
- OLD: `const view = this.getView();`
- NEW: `const { scale, pan } = useCameraStore.getState();`

**Update transform calls:**
- OLD: `view.worldToCanvas(x, y)`
- NEW: `worldToCanvas(x, y)` (imported function)

**Locations to update (approximately):**
- Line 127: begin() threshold check
- Line 170: move() threshold check
- Line 313: click finalization
- Line 1143: hitTestHandle() handle radius
- Line 1192: hitTestObjects() hit radius

### Step 8.2: DrawingTool.ts

**File:** `client/src/lib/tools/DrawingTool.ts`

**Update constructor:**
- REMOVE: `getView?: () => ViewTransform` parameter

**Add import:**
- `import { useCameraStore, worldToCanvas } from '@/stores/camera-store';`

**Update HoldDetector jitter check:**
- OLD: `if (this.getView) { const [sx, sy] = this.getView().worldToCanvas(worldX, worldY); ... }`
- NEW: `const [sx, sy] = worldToCanvas(worldX, worldY);` (no guard needed, always available)

**Locations:**
- Line 166-167: begin() jitter detection
- Line 180: move() hold tracking

### Step 8.3: EraserTool.ts

**File:** `client/src/lib/tools/EraserTool.ts`

**Update constructor:**
- REMOVE: `getView?: () => ViewTransform` parameter

**Add import:**
- `import { useCameraStore } from '@/stores/camera-store';`

**Update hit test radius calculation:**
- OLD: `const viewTransform = this.getView ? this.getView() : snapshot.view;`
- NEW: `const { scale } = useCameraStore.getState();`
- Then: `const radiusWorld = (ERASER_RADIUS_PX + ERASER_SLACK_PX) / scale;`

**Remove fallback to snapshot.view** - store is always available.

### Step 8.4: PanTool.ts

**File:** `client/src/lib/tools/PanTool.ts`

**Update constructor:**
- REMOVE: `private getView: () => ViewTransform`
- REMOVE: `private setPan: (pan: Point) => void`

**Add import:**
- `import { useCameraStore } from '@/stores/camera-store';`

**Update updatePan method:**
- OLD: `const view = this.getView(); this.setPan({ x: view.pan.x - dx/view.scale, ... });`
- NEW:
  ```
  const { scale, pan } = useCameraStore.getState();
  useCameraStore.getState().setPan({ x: pan.x - dx/scale, y: pan.y - dy/scale });
  ```

### Step 8.5: TextTool.ts

**File:** `client/src/lib/tools/TextTool.ts`

**Update CanvasHandle interface:**
- REMOVE: `getView: () => ViewTransform`
- KEEP: `worldToClient` (or replace with import from camera-store)
- KEEP: `getEditorHost`

**Add import:**
- `import { useCameraStore, worldToClient } from '@/stores/camera-store';`

**Update scale reading:**
- OLD: `const view = this.canvasHandle.getView(); const scaledFontSize = this.config.size * view.scale;`
- NEW: `const { scale } = useCameraStore.getState(); const scaledFontSize = this.config.size * scale;`

**Update worldToClient calls:**
- If keeping on CanvasHandle: no change
- If importing from store: replace `this.canvasHandle.worldToClient(x, y)` with `worldToClient(x, y)`

**Update onViewChange:**
- Still needs to be called when camera changes (from Canvas.tsx subscription)
- Reads scale from store

---

## Phase 9: Major Canvas.tsx Refactor

**File:** `client/src/canvas/Canvas.tsx`

This is the largest change. Take it step by step.

### Step 9.1: Update imports

**ADD:**
- `import { useCameraStore, setCanvasElement, screenToWorld, worldToClient, getViewportInfo, getViewTransform } from '@/stores/camera-store';`

**REMOVE:**
- `import { useViewTransform } from './ViewTransformContext';`
- `import { useCoordinateTransform } from '@/hooks/use-coordinate-transform';` (if present)

### Step 9.2: Remove ViewTransform-related refs

**DELETE these refs:**
- `viewTransformRef`
- `setScaleRef`
- `setPanRef`
- `canvasSizeRef` (viewport now in store)

### Step 9.3: Remove ViewTransform context usage

**DELETE:**
- `const { transform: viewTransform, setScale, setPan } = useViewTransform();`

**REPLACE with store usage:**
- For reactive updates in component: `const scale = useCameraStore(selectScale);`
- For imperative access in callbacks: `useCameraStore.getState()`

### Step 9.4: Remove ref syncing useLayoutEffect

**DELETE the entire useLayoutEffect block:**
```
useLayoutEffect(() => {
  viewTransformRef.current = viewTransform;
  setScaleRef.current = setScale;
  setPanRef.current = setPan;
  activeToolRef.current = activeTool;
}, [viewTransform, setScale, setPan, activeTool]);
```

**Keep only activeToolRef sync if needed** (or remove and read from store/ref directly)

### Step 9.5: Remove screenToWorld/worldToClient useCallbacks

**DELETE:**
```
const screenToWorld = useCallback((clientX, clientY) => { ... }, []);
const worldToClient = useCallback((worldX, worldY) => { ... }, []);
```

**These are now imported from camera-store as pure functions.**

### Step 9.6: Update setCanvasElement on mount

**ADD a useEffect to register the canvas element:**
```
useEffect(() => {
  const el = baseStageRef.current?.getCanvasElement();
  setCanvasElement(el ?? null);
  return () => setCanvasElement(null);
}, [baseStageRef.current]); // Or use a stageReady dependency
```

### Step 9.7: Update handleBaseResize callback

**OLD:**
```
const handleBaseResize = useCallback((info: ResizeInfo) => {
  setCanvasSize(info);
  canvasSizeRef.current = info;
  renderLoopRef.current?.setResizeInfo({ width, height, dpr });
}, []);
```

**NEW (much simpler):**
```
const handleBaseResize = useCallback((info: ResizeInfo) => {
  // Store is already updated by CanvasStage!
  // Just notify RenderLoop if it needs device pixel dimensions
  renderLoopRef.current?.setResizeInfo({
    width: info.pixelWidth,
    height: info.pixelHeight,
    dpr: info.dpr,
  });
}, []);
```

Or if RenderLoop reads from store, this callback can be removed entirely.

### Step 9.8: Update RenderLoop.start() call

**REMOVE from config:**
- `getView: () => viewTransformRef.current`
- `getViewport: () => { ... }`

**Keep:**
- `stageRef`
- `getSnapshot: () => snapshotRef.current`
- `getGates: () => roomDoc.getGateStatus()`
- `isMobile`
- `onStats` (if DEV)

### Step 9.9: Update OverlayRenderLoop.start() call

**REMOVE from config:**
- `getView`
- `getViewport`

**Keep:**
- `stage`
- `getGates`
- `getPresence`
- `getSnapshot`
- `drawPresence`

### Step 9.10: Update ZoomAnimator instantiation

**OLD:**
```
zoomAnimatorRef.current = new ZoomAnimator(
  () => viewTransformRef.current,
  (s) => setScaleRef.current?.(s),
  (p) => setPanRef.current?.(p),
);
```

**NEW:**
```
zoomAnimatorRef.current = new ZoomAnimator();
```

### Step 9.11: Update tool instantiation

**For each tool, remove getView from constructor/options:**

**SelectTool:**
- OLD: `new SelectTool(roomDoc, { invalidateWorld, invalidateOverlay, getView, applyCursor, setCursorOverride })`
- NEW: `new SelectTool(roomDoc, { invalidateWorld, invalidateOverlay, applyCursor, setCursorOverride })`

**DrawingTool:**
- OLD: `new DrawingTool(roomDoc, toolType, userId, onInvalidateBounds, requestOverlayFrame, getView, opts)`
- NEW: `new DrawingTool(roomDoc, toolType, userId, onInvalidateBounds, requestOverlayFrame, opts)`

**EraserTool:**
- OLD: `new EraserTool(roomDoc, onInvalidate, getView)`
- NEW: `new EraserTool(roomDoc, onInvalidate)`

**PanTool:**
- OLD: `new PanTool(getView, setPan, onInvalidateOverlay, applyCursor, setCursorOverride)`
- NEW: `new PanTool(onInvalidateOverlay, applyCursor, setCursorOverride)`

**TextTool:**
- OLD: `new TextTool(roomDoc, textSettings, userId, { worldToClient, getView, getEditorHost }, onInvalidate)`
- NEW: `new TextTool(roomDoc, textSettings, userId, { getEditorHost }, onInvalidate)`

### Step 9.12: Update event handlers

**handlePointerDown, handlePointerMove, handlePointerUp:**
- Replace `screenToWorld(e.clientX, e.clientY)` with imported `screenToWorld(e.clientX, e.clientY)`
- These now call the pure function from camera-store

**handleWheel:**
- Replace `const v = viewTransformRef.current;` with `const { scale, pan } = useCameraStore.getState();`
- Use `zoomAnimatorRef.current?.to(targetScale, targetPan);` (unchanged)

**MMB pan in handlePointerMove:**
- Replace ref reads with store reads
- Replace `setPanRef.current?.(newPan)` with `useCameraStore.getState().setPan(newPan)`

### Step 9.13: Update transform change effect

**OLD:**
```
useEffect(() => {
  renderLoopRef.current?.invalidateCanvas({ x: 0, y: 0, width: 1, height: 1 });
  overlayLoopRef.current?.invalidateAll();
  if (toolRef.current && 'onViewChange' in toolRef.current) {
    (toolRef.current as any).onViewChange();
  }
}, [viewTransform.scale, viewTransform.pan.x, viewTransform.pan.y]);
```

**NEW (subscribe to store):**
```
useEffect(() => {
  const unsubscribe = useCameraStore.subscribe(
    (state) => ({ scale: state.scale, pan: state.pan }),
    () => {
      renderLoopRef.current?.invalidateCanvas({ x: 0, y: 0, width: 1, height: 1 });
      overlayLoopRef.current?.invalidateAll();
      if (toolRef.current && 'onViewChange' in toolRef.current) {
        (toolRef.current as any).onViewChange();
      }
    },
    { equalityFn: (a, b) => a.scale === b.scale && a.pan.x === b.pan.x && a.pan.y === b.pan.y }
  );
  return unsubscribe;
}, []);
```

### Step 9.14: Simplify stageReady pattern

**Current:** `const stageReady = !!(renderLoopRef.current && baseStageRef.current?.getCanvasElement());`

**This can likely be simplified** since we no longer depend on refs for camera state. Review whether stageReady is still needed as a dependency - it may only be needed for event listener attachment timing.

### Step 9.15: Update imperative handle

**OLD screenToWorld wrapper:**
```
screenToWorld: (clientX, clientY) => {
  const result = screenToWorld(clientX, clientY);
  return result || [clientX, clientY];
}
```

**NEW (simpler):**
```
screenToWorld: (clientX, clientY) => {
  return screenToWorld(clientX, clientY) ?? [clientX, clientY];
}
```

The function is now imported from camera-store.

---

## Phase 10: Update UI Components

### Step 10.1: ZoomControls.tsx

**File:** `client/src/pages/components/ZoomControls.tsx`

**Update imports:**
- REMOVE: `import { useViewTransform } from '../../canvas/ViewTransformContext';`
- ADD: `import { useCameraStore, selectScale } from '@/stores/camera-store';`

**Update hook usage:**
- OLD: `const { viewState, setScale, resetView } = useViewTransform();`
- NEW:
  ```
  const scale = useCameraStore(selectScale);
  const setScale = useCameraStore(s => s.setScale);
  const resetView = useCameraStore(s => s.resetView);
  ```

**Update display:**
- OLD: `viewState.scale`
- NEW: `scale`

### Step 10.2: RoomPage.tsx

**File:** `client/src/pages/RoomPage.tsx`

**REMOVE ViewTransformProvider wrapper:**
```
// DELETE:
<ViewTransformProvider>
  <RoomCanvas roomId={roomId} />
</ViewTransformProvider>

// REPLACE WITH:
<RoomCanvas roomId={roomId} />
```

### Step 10.3: App.tsx (if applicable)

**File:** `client/src/App.tsx`

**REMOVE ViewTransformProvider wrapper** from any test harness or dev setup.

---

## Phase 11: Delete Old Files

### Step 11.1: Delete ViewTransformContext.tsx

**DELETE:** `client/src/canvas/ViewTransformContext.tsx`

### Step 11.2: Delete use-coordinate-transform.ts

**DELETE:** `client/src/hooks/use-coordinate-transform.ts`

This hook is currently unused (dead code) but delete it to avoid confusion.

### Step 11.3: Remove exports/imports

Search the codebase for any remaining imports of:
- `ViewTransformContext`
- `ViewTransformProvider`
- `useViewTransform`
- `useCoordinateTransform`

Remove all of them.

---

## Phase 12: Update Tests

### Step 12.1: Canvas.test.tsx

**File:** `client/src/canvas/__tests__/Canvas.test.tsx`

**REMOVE:** ViewTransformProvider wrapper from test setup

**ADD:** Mock or initialize the camera store before tests:
```
beforeEach(() => {
  useCameraStore.setState({
    scale: 1,
    pan: { x: 0, y: 0 },
    cssWidth: 800,
    cssHeight: 600,
    dpr: 1,
  });
});
```

### Step 12.2: transforms.test.ts

**File:** `client/src/canvas/__tests__/transforms.test.ts`

Update tests to use the new camera store functions if they test coordinate transforms.

### Step 12.3: Tool tests (if any)

Update any tool tests to not pass getView callbacks.

---

## Phase 13: Typecheck and Verification

### Step 13.1: Run typecheck

From the repository root:
```
npm run typecheck
```

### Step 13.2: Fix any remaining type errors

Common issues to look for:
- Missing imports of camera store functions
- Leftover references to removed interfaces
- Constructor signature mismatches for tools
- Missing props that were removed from interfaces

### Step 13.3: Manual testing checklist

After implementation, verify:

- [ ] Wheel zoom centers on cursor and animates smoothly
- [ ] Zoom buttons (+/-/reset) work
- [ ] MMB pan works smoothly
- [ ] Pan tool works
- [ ] Drawing at various zoom levels positions correctly
- [ ] Selection handles scale and position correctly
- [ ] Eraser hit testing works at all zoom levels
- [ ] Text tool positions correctly during pan/zoom
- [ ] No console errors
- [ ] Multiple rooms can have independent camera states (if applicable)

---

## Summary of Files Changed

### Files to CREATE:
- `client/src/stores/camera-store.ts`

### Files to DELETE:
- `client/src/canvas/ViewTransformContext.tsx`
- `client/src/hooks/use-coordinate-transform.ts`

### Files to MODIFY (High Impact):
- `client/src/canvas/Canvas.tsx` (major refactor)
- `client/src/canvas/CanvasStage.tsx`
- `client/src/renderer/RenderLoop.ts`
- `client/src/renderer/OverlayRenderLoop.ts`
- `client/src/canvas/animation/ZoomAnimator.ts`

### Files to MODIFY (Medium Impact - Tools):
- `client/src/lib/tools/SelectTool.ts`
- `client/src/lib/tools/DrawingTool.ts`
- `client/src/lib/tools/EraserTool.ts`
- `client/src/lib/tools/PanTool.ts`
- `client/src/lib/tools/TextTool.ts`

### Files to MODIFY (Low Impact - UI):
- `client/src/pages/components/ZoomControls.tsx`
- `client/src/pages/RoomPage.tsx`
- `client/src/App.tsx`
- `client/src/canvas/__tests__/Canvas.test.tsx`

### Files UNCHANGED:
- `client/src/renderer/DirtyRectTracker.ts` (receives ViewTransform as parameter, no store dependency)
- `client/src/renderer/layers/objects.ts` (receives ViewTransform as parameter)
- `packages/shared/src/types/snapshot.ts` (ViewTransform interface kept for compatibility)
- `packages/shared/src/config.ts` (PERFORMANCE_CONFIG unchanged)

---

## Architecture Comparison

### Before:

```
ViewTransformContext (React Context)
    ↓
useViewTransform() hook
    ↓
Canvas.tsx (stores in refs, syncs with useLayoutEffect)
    ↓
Callbacks passed to: RenderLoop, OverlayRenderLoop, Tools, ZoomAnimator
    ↓
Each consumer calls getView() callback
```

**Problems:**
- 16+ refs in Canvas.tsx
- Complex useLayoutEffect syncing
- Callback chains and prop drilling
- React Context re-renders

### After:

```
useCameraStore (Zustand)
    ↓
Pure functions: worldToCanvas, screenToWorld, etc.
    ↓
All consumers import directly from camera-store
    ↓
Store.getState() for imperative access
```

**Benefits:**
- Single source of truth
- No prop drilling
- No callback chains
- Pure functions (no closures)
- Selective subscriptions
- Simpler testing

---

## Implementation Order Recommendation

1. **Phase 1-2:** Create camera store with all functions
2. **Phase 7:** Update ZoomAnimator (isolated, easy to test)
3. **Phase 8:** Update all tools (can be done in parallel)
4. **Phase 4-5:** Update render loops
5. **Phase 3:** Update CanvasStage
6. **Phase 9:** Major Canvas.tsx refactor
7. **Phase 10:** Update UI components
8. **Phase 11:** Delete old files
9. **Phase 12-13:** Tests and verification

This order minimizes the time the codebase is in an inconsistent state.
