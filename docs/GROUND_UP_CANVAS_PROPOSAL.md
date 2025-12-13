# Ground-Up Canvas Architecture Proposal

**Author:** Claude Analysis
**Date:** 2025-12-12
**Status:** Proposal - Supersedes SURFACE_MANAGER_PROPOSAL.md

---

## Executive Summary

After analyzing the current implementation from scratch, we don't need a `CanvasSurfaceManager` class or callback-based surface notifications.

**Key findings:**
1. **There's a DPR bug** - camera store gets raw DPR, not effective DPR when canvas is clamped
2. **configureContext2D is pointless** - drawing code already sets lineCap/lineJoin explicitly
3. **Two CanvasStage components are wasteful** - single resize observer on container is better
4. **Context registry pattern is valid** - follows room-runtime.ts pattern
5. **CanvasRuntime will own render loops** - but intermediate steps first

**The path forward is mostly deletion + bug fixing.**

---

## Critical Bug: Effective DPR Not Computed

### The Problem

When canvas dimensions are clamped to `MAX_CANVAS_DIMENSION` (16384), the camera store receives the **raw DPR** instead of the **effective DPR**:

```typescript
// CanvasStage.tsx lines 227-228, 256
const newWidth = Math.min(width * dpr, maxDim);   // e.g., 16384 (clamped from 18000)
canvas.width = newWidth;
useCameraStore.getState().setViewport(width, height, dpr);  // passes RAW dpr = 3!
```

```typescript
// camera-store.ts getViewportInfo()
pixelWidth: Math.round(cssWidth * dpr),  // Returns 18000, but canvas is 16384!
```

```typescript
// RenderLoop.ts line 367
ctx.clearRect(0, 0, viewport.pixelWidth, viewport.pixelHeight);  // WRONG!
```

### The Fix

Compute and store **effective DPR** when clamping occurs:

```typescript
const maxDim = PERFORMANCE_CONFIG.MAX_CANVAS_DIMENSION;
const rawPixelW = width * dpr;
const rawPixelH = height * dpr;
const pixelW = Math.min(rawPixelW, maxDim);
const pixelH = Math.min(rawPixelH, maxDim);

// Effective DPR accounts for clamping
const effectiveDpr = Math.min(pixelW / width, pixelH / height);

canvas.width = Math.round(width * effectiveDpr);
canvas.height = Math.round(height * effectiveDpr);

useCameraStore.getState().setViewport(width, height, effectiveDpr);  // CORRECT!
```

Now `getViewportInfo().pixelWidth` equals actual `canvas.width`.

---

## What's Actually Wrong With Current Architecture

### 1. Two CanvasStage Components = Two ResizeObservers

The problem isn't that CanvasStage "does too much" - it's that we have **TWO instances**, each with their own ResizeObserver watching the same size. Wasteful.

**Solution:** Single resize observer on container, updates both canvases.

### 2. configureContext2D is Pointless

What it sets:
- `imageSmoothingEnabled = true` - only matters for drawImage(), not used yet
- `lineCap = 'round'` - drawing code sets this explicitly (10+ places in objects.ts)
- `lineJoin = 'round'` - drawing code sets this explicitly

**Solution:** DELETE it entirely.

### 3. CanvasStage DPR Transform is Useless

```typescript
ctx.setTransform(dpr, 0, 0, dpr, 0, 0);  // CanvasStage sets this
```

But render loops do explicit transforms anyway (Phase 1.6 complete):
```typescript
ctx.setTransform(dpr * view.scale, 0, 0, dpr * view.scale, ...);  // RenderLoop
```

**Solution:** Remove from CanvasStage (already not used).

### 4. withContext() and clear() Are Overhead

- `withContext()` does save/restore - but loops manage their own state
- `clear()` reads canvas.width/height directly - loops can do this themselves

**Solution:** Loops use ctx directly, no wrapper methods.

### 5. RenderLoop Config is Bloated

```typescript
// CURRENT: Too many callbacks
interface RenderLoopConfig {
  stageRef: RefObject<CanvasStageHandle>;  // ❌ React ref indirection
  getSnapshot: () => Snapshot;              // ❌ Can read from room-runtime
  getGates: () => GateStatus;               // ❌ Can read from room-runtime
  onStats?: (stats: FrameStats) => void;    // ⚠️ Optional, keep
  isMobile?: () => boolean;                 // ⚠️ Move to camera-store
}
```

### 3. DirtyRectTracker Has Transform Tracking (Wrong Responsibility)

```typescript
// CURRENT: Transform tracking in dirty rect tracker
private lastTransform: { scale: number; pan: { x: number; y: number } };
notifyTransformChange(newTransform): void { ... }  // ❌ DELETE
```

The RenderLoop already calls `invalidateAll('transform-change')` on camera subscription. DirtyRectTracker shouldn't track transforms.

### 4. Per-Tick Canvas Size Updates (Wasteful)

```typescript
// CURRENT: RenderLoop.tick() line 298
this.dirtyTracker.setCanvasSize(viewport.pixelWidth, viewport.pixelHeight, viewport.dpr);
```

Canvas size rarely changes. This should be event-driven via camera store subscription, not per-tick.

### 5. Two ResizeObservers (Wasteful)

Both CanvasStage instances (base + overlay) create their own ResizeObserver. They observe the same size. The overlay just mirrors base dimensions.

---

## Ground-Up Design Principles

1. **The camera-store IS the notification channel** - No callbacks, no emitters
2. **Module-level registries, not prop drilling** - Follow room-runtime.ts pattern
3. **Render loops read from modules, not configs** - Zero constructor dependencies
4. **React mounts DOM, runtime owns behavior** - Clear separation
5. **Delete abstractions, don't add them** - withContext(), clear(), SurfaceManager

---

## The Solution

### Architecture: Intermediate vs End Goal

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          INTERMEDIATE STATE                                  │
│  (What we do now to unblock progress)                                       │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Canvas.tsx                                                                 │
│  ├── Renders raw <canvas> elements (delete CanvasStage)                     │
│  ├── Single ResizeObserver on container                                     │
│  ├── Updates both canvas backing stores                                     │
│  ├── Calls setViewport() with EFFECTIVE DPR                                 │
│  ├── Registers contexts with canvas-context-registry                        │
│  ├── Creates RenderLoop / OverlayRenderLoop (still owns them)               │
│  └── Event handlers (still here for now)                                    │
│                                                                             │
│  canvas-context-registry.ts (NEW)                                           │
│  ├── setBaseContext() / getBaseContext()                                    │
│  └── setOverlayContext() / getOverlayContext()                              │
│                                                                             │
│  RenderLoop / OverlayRenderLoop                                             │
│  ├── Read ctx from registry (not stageRef)                                  │
│  ├── Read snapshot/gates from room-runtime                                  │
│  └── No config dependencies                                                 │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘

                                    ↓

┌─────────────────────────────────────────────────────────────────────────────┐
│                            END GOAL                                          │
│  (Phase 2 - CanvasRuntime owns everything)                                  │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Canvas.tsx (~100 lines)                                                    │
│  ├── Renders raw <canvas> elements                                          │
│  ├── Creates CanvasRuntime, passes canvas refs                              │
│  └── setActiveRoom() / setEditorHost()                                      │
│                                                                             │
│  CanvasRuntime.ts (NEW)                                                     │
│  ├── Owns ResizeObserver + DPR listener                                     │
│  ├── Owns both canvas contexts                                              │
│  ├── Owns RenderLoop + OverlayRenderLoop                                    │
│  ├── Owns InputManager (event forwarding)                                   │
│  ├── Owns ZoomAnimator                                                      │
│  └── Registers with invalidation-helpers                                    │
│                                                                             │
│  canvas-context-registry.ts (may be absorbed into CanvasRuntime)            │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### New File: `canvas-context-registry.ts` (~20 lines)

Simple, following `room-runtime.ts` pattern. **No configureContext2D** - drawing code sets lineCap/lineJoin explicitly:

```typescript
// canvas-context-registry.ts
let baseCtx: CanvasRenderingContext2D | null = null;
let overlayCtx: CanvasRenderingContext2D | null = null;

export function setBaseContext(ctx: CanvasRenderingContext2D | null): void {
  baseCtx = ctx;
}

export function setOverlayContext(ctx: CanvasRenderingContext2D | null): void {
  overlayCtx = ctx;
}

export function getBaseContext(): CanvasRenderingContext2D | null {
  return baseCtx;
}

export function getOverlayContext(): CanvasRenderingContext2D | null {
  return overlayCtx;
}
```

That's it. No canvas element tracking (camera-store has that). No configureContext2D (pointless).

### Add to `camera-store.ts`: Mobile Detection (~10 lines)

```typescript
// camera-store.ts additions
let mobileDetected: boolean | null = null;

export function isMobile(): boolean {
  if (mobileDetected === null) {
    mobileDetected =
      /Android|webOS|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
      navigator.maxTouchPoints > 1;
  }
  return mobileDetected;
}
```

### Modified `RenderLoop.ts`: Zero-Config Constructor

```typescript
// RenderLoop.ts - simplified
export interface RenderLoopConfig {
  //onStats?: (stats: FrameStats) => void;  // WE'll make this also self managing
}

export class RenderLoop {
  private dirtyTracker = new DirtyRectTracker();
  private cameraUnsubscribe: (() => void) | null = null;
  private onStats?: (stats: FrameStats) => void;
  // ... existing frame state

  start(config: RenderLoopConfig = {}): void {
    this.onStats = config.onStats;

    // Subscribe to camera store (already doing this)
    this.cameraUnsubscribe = useCameraStore.subscribe(
      (state) => ({ scale: state.scale, panX: state.pan.x, panY: state.pan.y,
                    cssWidth: state.cssWidth, cssHeight: state.cssHeight, dpr: state.dpr }),
      (curr, prev) => {
        // Viewport changed -> update tracker and full clear
        if (curr.cssWidth !== prev.cssWidth || curr.cssHeight !== prev.cssHeight || curr.dpr !== prev.dpr) {
          const pixelW = Math.round(curr.cssWidth * curr.dpr);
          const pixelH = Math.round(curr.cssHeight * curr.dpr);
          this.dirtyTracker.setCanvasSize(pixelW, pixelH, curr.dpr);
          this.dirtyTracker.invalidateAll('geometry-change');
          this.markDirty();
          return;
        }

        // Transform changed -> full clear (NO notifyTransformChange!)
        if (curr.scale !== prev.scale || curr.panX !== prev.panX || curr.panY !== prev.panY) {
          this.dirtyTracker.invalidateAll('transform-change');
          this.markDirty();
        }
      },
      { equalityFn: ... }
    );
  }

  private tick(): void {
    // Get context from registry (not from config!)
    const ctx = getBaseContext();
    if (!ctx) return;

    // Read everything from modules
    const view = getViewTransform();
    const viewport = getViewportInfo();
    const roomDoc = getActiveRoomDoc();
    const snapshot = roomDoc.currentSnapshot;
    const gates = roomDoc.getGateStatus();

    // NO per-tick setCanvasSize - already done in subscription!

    // ... rest of tick (explicit transforms already in place)
  }
}
```

### Modified `OverlayRenderLoop.ts`: Same Pattern

```typescript
// OverlayRenderLoop.ts - simplified
export class OverlayRenderLoop {
  private cameraUnsubscribe: (() => void) | null = null;
  private previewProvider: PreviewProvider | null = null;
  // ...

  start(): void {
    // Subscribe to camera store (already doing this)
    this.cameraUnsubscribe = useCameraStore.subscribe(...);
  }

  private frame(): void {
    // Get context from registry (not from config!)
    const ctx = getOverlayContext();
    if (!ctx) return;

    // Read everything from modules
    const view = getViewTransform();
    const viewport = getViewportInfo();

    // Clear using viewport pixel dimensions (correct after effective DPR fix)
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, viewport.pixelWidth, viewport.pixelHeight);

    // Read snapshot/gates from room-runtime when needed
    const roomDoc = getActiveRoomDoc();
    const snapshot = roomDoc.currentSnapshot;
    const gates = roomDoc.getGateStatus();
    const presence = snapshot.presence;

    // ... rest of frame (drawPresence, drawPreview, etc.)
  }
}
```

**Note:** After the effective DPR fix, `viewport.pixelWidth/Height` will equal actual `canvas.width/height`, so no need to access the canvas element directly for clearing.

### Modified `DirtyRectTracker.ts`: Remove Transform Tracking

```typescript
// DirtyRectTracker.ts - DELETE transform tracking
export class DirtyRectTracker {
  private rects: DevicePixelRect[] = [];
  private fullClearRequired = false;
  private canvasSize = { width: 0, height: 0 };
  private dpr = 1;

  // DELETED: lastTransform
  // DELETED: notifyTransformChange()

  setCanvasSize(width: number, height: number, dpr = 1): void {
    this.canvasSize = { width, height };
    this.dpr = dpr;
  }

  // ... rest unchanged (invalidateWorldBounds, invalidateCanvasPixels, etc.)
}
```

### Modified `Canvas.tsx`: Intermediate State

```typescript
// Canvas.tsx - intermediate state (still owns render loops)
export const Canvas = ({ roomId, className }: CanvasProps) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const baseCanvasRef = useRef<HTMLCanvasElement>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null);
  const editorHostRef = useRef<HTMLDivElement>(null);
  const renderLoopRef = useRef<RenderLoop | null>(null);
  const overlayLoopRef = useRef<OverlayRenderLoop | null>(null);

  const roomDoc = useRoomDoc(roomId);

  // 1. Set active room context
  useLayoutEffect(() => {
    setActiveRoom({ roomId, roomDoc });
    return () => setActiveRoom(null);
  }, [roomId, roomDoc]);

  // 2. Set editor host
  useLayoutEffect(() => {
    setEditorHost(editorHostRef.current);
    return () => setEditorHost(null);
  }, []);

  // 3. Get contexts and register with registry
  useLayoutEffect(() => {
    const baseCanvas = baseCanvasRef.current;
    const overlayCanvas = overlayCanvasRef.current;
    if (!baseCanvas || !overlayCanvas) return;

    const baseCtx = baseCanvas.getContext('2d', { willReadFrequently: false });
    const overlayCtx = overlayCanvas.getContext('2d', { willReadFrequently: false });
    if (!baseCtx || !overlayCtx) return;

    setBaseContext(baseCtx);
    setOverlayContext(overlayCtx);
    setCanvasElement(baseCanvas); // For cursor management + coordinate transforms

    return () => {
      setBaseContext(null);
      setOverlayContext(null);
      setCanvasElement(null);
    };
  }, []);

  // 4. Resize observer and DPR listener
  useEffect(() => {
    const container = containerRef.current;
    const baseCanvas = baseCanvasRef.current;
    const overlayCanvas = overlayCanvasRef.current;
    if (!container || !baseCanvas || !overlayCanvas) return;

    let currentDpr = window.devicePixelRatio || 1;

    const updateCanvasSize = (cssWidth: number, cssHeight: number, dpr: number) => {
      const maxDim = PERFORMANCE_CONFIG.MAX_CANVAS_DIMENSION;

      // Compute pixel dimensions with clamping
      const rawPixelW = cssWidth * dpr;
      const rawPixelH = cssHeight * dpr;
      const pixelW = Math.min(Math.round(rawPixelW), maxDim);
      const pixelH = Math.min(Math.round(rawPixelH), maxDim);

      // CRITICAL: Compute effective DPR (may differ from raw DPR if clamped)
      const effectiveDpr = Math.min(pixelW / cssWidth, pixelH / cssHeight);

      // Only set if changed (setting dimensions clears canvas!)
      if (baseCanvas.width !== pixelW || baseCanvas.height !== pixelH) {
        baseCanvas.width = pixelW;
        baseCanvas.height = pixelH;
        overlayCanvas.width = pixelW;
        overlayCanvas.height = pixelH;
        // Note: Context state is NOT nuked by resize for getContext() already called
        // But transform is reset - render loops handle this via explicit setTransform()
      }

      // Update camera store with EFFECTIVE DPR (render loops subscribe to this)
      useCameraStore.getState().setViewport(cssWidth, cssHeight, effectiveDpr);
    };

    // Single ResizeObserver on container
    const resizeObserver = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect;
      updateCanvasSize(width, height, currentDpr);
    });
    resizeObserver.observe(container);

    // DPR change listener
    const setupDprListener = () => {
      currentDpr = window.devicePixelRatio || 1;
      const mediaQuery = window.matchMedia(`(resolution: ${currentDpr}dppx)`);

      const handleChange = () => {
        const rect = container.getBoundingClientRect();
        currentDpr = window.devicePixelRatio || 1;
        updateCanvasSize(rect.width, rect.height, currentDpr);
        // Re-setup listener for new DPR
        mediaQuery.removeEventListener('change', handleChange);
        setupDprListener();
      };

      mediaQuery.addEventListener('change', handleChange);
      return () => mediaQuery.removeEventListener('change', handleChange);
    };
    const cleanupDpr = setupDprListener();

    return () => {
      resizeObserver.disconnect();
      cleanupDpr();
    };
  }, []);

  // 5. Initialize render loops (simplified)
  useLayoutEffect(() => {
    const renderLoop = new RenderLoop();
    renderLoop.start({
      onStats: import.meta.env.DEV ? (stats) => { /* ... */ } : undefined,
    });

    setWorldInvalidator((bounds) => renderLoop.invalidateWorld(bounds));

    return () => {
      setWorldInvalidator(null);
      renderLoop.stop();
      renderLoop.destroy();
    };
  }, []);

  useLayoutEffect(() => {
    const overlayLoop = new OverlayRenderLoop();
    overlayLoop.start();

    setOverlayInvalidator(() => overlayLoop.invalidateAll());

    return () => {
      setOverlayInvalidator(null);
      overlayLoop.stop();
      overlayLoop.destroy();
    };
  }, []);

  // ... event handlers stay the same (will move to CanvasRuntime later)

  // NO useImperativeHandle! DELETE CanvasHandle!

  return (
    <div ref={containerRef} className="relative w-full h-full" style={{ backgroundColor: '#FFFFFF' }}>
      <canvas
        ref={baseCanvasRef}
        style={{ position: 'absolute', inset: 0, zIndex: 1, display: 'block', width: '100%', height: '100%', touchAction: 'none' }}
        className={className}
      />
      <canvas
        ref={overlayCanvasRef}
        style={{ position: 'absolute', inset: 0, zIndex: 2, display: 'block', width: '100%', height: '100%', pointerEvents: 'none' }}
        className={className}
      />
      <div ref={editorHostRef} style={{ position: 'absolute', inset: 0, zIndex: 3, pointerEvents: 'none' }} />
    </div>
  );
};
```

---

## What Gets Deleted

| Item | Reason |
|------|--------|
| `CanvasStage.tsx` | Replaced by raw `<canvas>` + registry |
| `client/src/canvas/internal/context2d.ts` | `configureContext2D()` is pointless - drawing code sets lineCap/lineJoin |
| `CanvasStageHandle` interface | No imperative handle |
| `useImperativeHandle` in Canvas.tsx | No handle needed |
| `CanvasHandle` interface | Delete entirely |
| `stageRef` in RenderLoop/OverlayLoop | Use context registry |
| `withContext()` pattern | Loops use ctx directly |
| `stage.clear()` | Loops clear themselves |
| `notifyTransformChange()` | Not DirtyRectTracker's job |
| `lastTransform` in DirtyRectTracker | Deleted |
| Per-tick `setCanvasSize()` | Event-driven via subscription |
| `setResizeInfo()` in RenderLoop | Never called, delete |
| `getSnapshot` in config | Read from room-runtime |
| `getGates` in config | Read from room-runtime |
| `getPresence` in config | Read from room-runtime |
| `getView`/`getViewport` in config | Already deprecated, delete |
| `isMobile` callback | Read from camera-store |
| Second ResizeObserver | Single observer on container |
| DPR transform in CanvasStage | Loops do explicit transforms |

---

## Why NOT CanvasSurfaceManager

The proposal wanted to create a `CanvasSurfaceManager` class that:
1. Owns ResizeObserver
2. Owns DPR listener
3. Has `onSurfaceChange` callback
4. Passes "surfaces" to render loops
5. Manages both canvases

**Problems:**
1. It's an extra abstraction layer
2. The callback pattern duplicates what camera-store subscription already does
3. "Surface" is just `{ canvas, ctx }` - we can use a registry instead
4. Resize/DPR handling is fine in React's useEffect
5. Both canvases always have the same dimensions - no need for "manager"

The camera store IS the coordination mechanism. Render loops already subscribe to it. Adding callbacks on top is redundant.

---

## Answer to Your Questions

### 1. "Why callback/emitter when we have camera-store?"

**Answer:** We shouldn't. Delete the callbacks. Render loops already subscribe to camera store.

### 2. "Why update both canvases if overlay mirrors base?"

**Answer:** We don't need special coordination. Just set both dimensions in the resize handler. They're always identical.

### 3. "Why pass getSnapshot/getGates in config?"

**Answer:** We shouldn't. Render loops should call `getActiveRoomDoc().currentSnapshot` and `.getGateStatus()` directly.

### 4. "configureContext2D - do we need it?"

**Answer:** NO. DELETE IT. Drawing code already sets `lineCap`/`lineJoin` explicitly before every draw (10+ places in objects.ts, presence-cursors.ts, etc.). `imageSmoothingEnabled` only matters for `drawImage()` with scaling, which we're not doing yet - and when we do, we'd set it explicitly there.

### 5. "Why not context registry like room-runtime?"

**Answer:** Exactly right. Create `canvas-context-registry.ts` with same pattern.

### 6. "Can resize observer stay in React?"

**Answer:** Yes. It's fine in Canvas.tsx. React handles DOM mounting, the useEffect handles resize observation. Clean separation.

### 7. "Why HTMLCanvasElement passed to render loops?"

**Answer:** It shouldn't be. Use `getBaseCanvas()` from registry when needed (for dimensions). Use `getBaseContext()` for drawing.

---

## Implementation Order

### INTERMEDIATE PHASE (Unblock progress, Canvas.tsx still owns loops)

#### Step 1: Create canvas-context-registry.ts
- Module-level ctx storage
- `setBaseContext()` / `getBaseContext()`
- `setOverlayContext()` / `getOverlayContext()`
- NO configureContext2D - not needed

#### Step 2: Fix effective DPR bug in CanvasStage.tsx (or new resize code)
- Compute `effectiveDpr = Math.min(pixelW / cssWidth, pixelH / cssHeight)` after clamping
- Pass `effectiveDpr` to `setViewport()`, not raw DPR

#### Step 3: Add isMobile() to camera-store.ts
- Single detection on first call
- Cached result

#### Step 4: Simplify DirtyRectTracker
- Delete `notifyTransformChange()`
- Delete `lastTransform`
- Keep `setCanvasSize()` (called on subscription, not per-tick)

#### Step 5: Simplify RenderLoop
- Remove stageRef from config
- Remove getSnapshot/getGates from config
- Read from `getBaseContext()` and `getActiveRoomDoc()`
- Remove per-tick `setCanvasSize()` (done in subscription)
- Delete `setResizeInfo()` if unused

#### Step 6: Simplify OverlayRenderLoop
- Remove stage object from config
- Remove deprecated getView/getViewport
- Remove getGates/getPresence/getSnapshot/drawPresence from config
- Implement own clear: `ctx.setTransform(1,0,0,1,0,0); ctx.clearRect(0,0,canvas.width,canvas.height);`
- Call `drawPresenceOverlays()` directly
- Read from `getOverlayContext()` and `getActiveRoomDoc()`

#### Step 7: Simplify Canvas.tsx
- Delete CanvasStage usage - render raw `<canvas>`
- Single ResizeObserver on container (with effective DPR fix)
- Get contexts and register with canvas-context-registry
- Delete `useImperativeHandle` and `CanvasHandle`
- Still owns render loops (intermediate state)

#### Step 8: Delete files
- `CanvasStage.tsx`
- `client/src/canvas/internal/context2d.ts`

### END GOAL PHASE (CanvasRuntime owns everything)

#### Step 9: Create tool-registry.ts
- Self-constructing tool singletons
- `getCurrentTool()`, `getToolById()`, `panTool`

#### Step 10: Create CanvasRuntime.ts
- Owns ResizeObserver + DPR listener
- Owns both canvas contexts
- Owns RenderLoop + OverlayRenderLoop
- Owns InputManager
- Owns ZoomAnimator
- Registers with invalidation-helpers

#### Step 11: Create InputManager.ts
- Attaches event listeners to canvas
- Forwards raw events to CanvasRuntime

#### Step 12: Final Canvas.tsx (~100 lines)
- Just renders DOM elements
- Creates CanvasRuntime, passes canvas refs
- `setActiveRoom()` / `setEditorHost()`
- No event handlers, no render loops

---

## Success Criteria

### Intermediate Phase
1. **No CanvasStage.tsx** - deleted
2. **No configureContext2D** - deleted
3. **Effective DPR bug fixed** - camera store has correct pixel dimensions
4. **Render loops read from modules** - no stageRef, no config callbacks
5. **Single ResizeObserver** - on container in Canvas.tsx
6. **DirtyRectTracker doesn't track transforms** - simplified
7. **`npm run typecheck` passes**

### End Goal Phase
8. **CanvasRuntime owns everything** - render loops, input, zoom
9. **Canvas.tsx < 100 lines** - thin React wrapper
10. **No CanvasSurfaceManager.ts** - never created (just CanvasRuntime)

---

## File Count Impact

**SURFACE_MANAGER_PROPOSAL.md would create:**
- CanvasSurfaceManager.ts (new)
- InputManager.ts (new - still needed)
- tool-registry.ts (new - still needed)
- CanvasRuntime.ts (new - still needed)

**This proposal creates:**
- canvas-context-registry.ts (new, ~30 lines)
- InputManager.ts (new - still needed for Phase 2)
- tool-registry.ts (new - still needed for Phase 2)
- CanvasRuntime.ts (new - still needed for Phase 2)

**Net: -1 new file (no SurfaceManager)**

---

## Comparison Table

| Aspect | SURFACE_MANAGER_PROPOSAL | THIS PROPOSAL |
|--------|-------------------------|---------------|
| Resize notification | `onSurfaceChange` callback | Camera store subscription (existing) |
| Context access | `CanvasSurface` object passed in | Registry module (room-runtime pattern) |
| RenderLoop config | `surface: CanvasSurface` | No deps (reads from modules) |
| Extra classes | CanvasSurfaceManager | None |
| Resize observer location | CanvasSurfaceManager | Canvas.tsx useEffect |
| Complexity | Higher | Lower |
| Consistency with existing patterns | Mixed | High (follows room-runtime) |
