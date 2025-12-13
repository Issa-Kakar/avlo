# Canvas Surface Management Proposal

**Author:** Independent Analysis
**Date:** 2025-01-XX
**Status:** Proposal for Review

---

## Executive Summary

This document proposes architectural changes to decouple canvas surface management from React lifecycle. The core recommendation is to replace `CanvasStage.tsx` with a plain TypeScript `CanvasSurfaceManager` class, make render loops receive surfaces directly instead of through React refs, and centralize resize/DPR handling.

---

## Current Architecture Analysis

### CanvasStage.tsx (330 lines)

**What it does:**
1. Renders a `<canvas>` element with 100% width/height
2. Creates ResizeObserver on the canvas element itself
3. Creates DPR change listener via `matchMedia('(resolution: ${dpr}dppx)')`
4. Sets canvas backing store dimensions (`canvas.width/height`)
5. Gets 2D context and configures it (`configureContext2D()`)
6. Applies DPR transform: `ctx.setTransform(dpr, 0, 0, dpr, 0, 0)`
7. Updates camera-store: `setViewport(cssWidth, cssHeight, dpr)`
8. Exposes imperative handle with `clear()`, `withContext()`, `getBounds()`, `getCanvasElement()`
9. Optionally registers as pointer target via `setCanvasElement()`

**Problems:**
1. **Two ResizeObservers** - Base and overlay canvases each have their own CanvasStage instance, each with its own ResizeObserver. This is wasteful and creates race conditions.
2. **Observing wrong target** - Observes the canvas element itself, not the container. Canvas element is sized to 100% of parent, so this works, but conceptually wrong.
3. **React escape hatch** - `useImperativeHandle` exposes methods that runtime code depends on. This keeps React "in the middle" of imperative operations.
4. **DPR transform magic** - Loops rely on the DPR transform being pre-applied and preserved via save/restore. This is implicit correctness.

### RenderLoop.ts (565 lines)

**What it does:**
1. Accepts `stageRef: RefObject<CanvasStageHandle>` in config
2. Calls `stageRef.current.withContext()` for all drawing operations
3. Owns `DirtyRectTracker` internally
4. Subscribes to camera-store for self-invalidation
5. Handles document visibility (rAF vs setInterval)
6. Calls `dirtyTracker.setCanvasSize()` **every tick** (line 298)
7. Calls `dirtyTracker.notifyTransformChange()` on camera changes

**Problems:**
1. **Per-tick canvas size update** - `setCanvasSize()` called every frame even though size rarely changes
2. **Transform tracking in wrong place** - DirtyRectTracker tracks `lastTransform`, but transform changes are a render policy concern, not a dirty rect concern
3. **Stage ref indirection** - Goes through React ref mechanism for canvas access
4. **Implicit DPR handling** - Clear pass resets to identity transform, assumes save/restore will bring back DPR

### DirtyRectTracker.ts (267 lines)

**What it does:**
1. Stores `canvasSize` (device pixels) and `dpr`
2. Stores `lastTransform` for change detection
3. `notifyTransformChange()` sets `fullClearRequired` if transform changed
4. `invalidateWorldBounds()` converts world coords to device pixels
5. `invalidateCanvasPixels()` accepts CSS pixels, converts to device pixels

**Problems:**
1. **DPR passed twice** - Stored in `setCanvasSize(w, h, dpr)` AND passed to `invalidateCanvasPixels(rect, scale, dpr)`. Mismatch risk.
2. **Transform tracking is wrong responsibility** - Tracker should track dirty rects, not transform changes. Caller should call `invalidateAll('transform-change')`.

### OverlayRenderLoop.ts (447 lines)

**What it does:**
1. Accepts stage object with `withContext()` and `clear()`
2. Subscribes to camera-store for self-invalidation
3. Full clear every frame (cheap for overlay)
4. Draws preview + presence

**Problems:**
- Same stage indirection issue as RenderLoop

### camera-store.ts (305 lines)

**What it does:**
1. Module-level `canvasElement` for coordinate conversion
2. Zustand store with scale, pan, cssWidth, cssHeight, dpr
3. Pure transform functions (worldToCanvas, screenToWorld, etc.)
4. `setViewport()` action updates viewport dimensions

**Status:** Well-structured. This is the foundation for imperative access. Keep as-is.

---

## Key Decisions

### 1. Should We Keep CanvasStage.tsx?

**NO.**

Reasoning:
- It's a React abstraction around a runtime concern (canvas sizing/DPR)
- The imperative handle is an escape hatch that loops depend on
- Two instances = two ResizeObservers = waste + race condition risk
- DPR transform magic happens inside React lifecycle

**Alternative:** Move to `CanvasSurfaceManager.ts` (plain TypeScript class).

### 2. Should Render Loops Take Stage Refs?

**NO.**

They should accept a surface object directly:

```typescript
interface CanvasSurface {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
}
```

This eliminates React indirection entirely.

### 3. Who Should Own Resize/DPR?

**CanvasSurfaceManager** (owned by CanvasRuntime).

Responsibilities:
- Single ResizeObserver on **container** (not individual canvases)
- DPR change listener
- Sets backing store for **both** canvases atomically
- Calls `configureContext2D()` after resize (context state is nuked by resize)
- Updates camera-store viewport via `setViewport()`
- Notifies render loops of surface changes

### 4. Should Loops Subscribe to Camera Store?

**YES, but only for transform changes (scale/pan).**

For viewport changes (cssWidth, cssHeight, dpr), the flow should be:
```
ResizeObserver → SurfaceManager → camera-store.setViewport() → SurfaceManager notifies loops
```

Not:
```
ResizeObserver → camera-store.setViewport() → loop subscription fires
```

The difference is who originates the notification. SurfaceManager owns surface events and should directly notify loops, not rely on them subscribing to camera-store for viewport changes.

**For transform changes**, the current loop subscription is fine:
```
User pan/zoom → camera-store.setScaleAndPan() → loop subscription fires → invalidateAll()
```

### 5. What Should DirtyRectTracker Do?

**Only track dirty rects.**

Remove:
- `notifyTransformChange()` - not its responsibility
- `lastTransform` - unnecessary state
- DPR parameter from `invalidateCanvasPixels()` - use stored DPR

Keep:
- `setCanvasSize(w, h, dpr)` - called once when surface changes
- `invalidateWorldBounds()` and `invalidateCanvasPixels()` - core function
- `invalidateAll()` - called by RenderLoop on transform changes

### 6. Should Document Visibility Be in RenderLoop?

**YES, keep it there.**

Since we're not creating a central FrameScheduler, keeping visibility handling in RenderLoop is fine. OverlayRenderLoop is simpler and doesn't need the same complexity.

If we later want two-canvas synced scheduling, we'd create a FrameScheduler. But that's not necessary now.

### 7. How Should DPR Be Handled?

**Loops should set transforms explicitly per pass.**

Current (implicit):
```typescript
// CanvasStage sets: ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
// Loop relies on save/restore to preserve this

stage.withContext((ctx) => {
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);  // Clear pass - identity
  ctx.clearRect(0, 0, pixelWidth, pixelHeight);
  ctx.restore();  // Back to DPR transform (implicit)
});

stage.withContext((ctx) => {
  // DPR already applied (implicit)
  ctx.scale(view.scale, view.scale);
  // draw world
});
```

Proposed (explicit):
```typescript
// Clear pass - identity for device pixel clearing
ctx.setTransform(1, 0, 0, 1, 0, 0);
ctx.clearRect(0, 0, pixelWidth, pixelHeight);

// World pass - DPR × scale × translate
ctx.setTransform(
  dpr * scale, 0, 0, dpr * scale,
  -pan.x * dpr * scale, -pan.y * dpr * scale
);
// draw world content

// Screen pass (HUD) - DPR only
ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
// draw HUD elements
```

This makes transforms **deterministic** and **self-contained** per tick. No reliance on external state.

### 8. Should We Keep Resize in React?

**NO.**

If the goal is "React only mounts DOM, runtime owns everything else," then resize is a runtime concern. Canvas.tsx should render raw `<canvas>` elements, and CanvasSurfaceManager should handle resize.

---

## Proposed Architecture

### New Files

| File | Purpose |
|------|---------|
| `CanvasSurfaceManager.ts` | Resize/DPR/backing store ownership |
| `InputManager.ts` | DOM event forwarding (already planned) |
| `tool-registry.ts` | Tool singletons (already planned) |
| `CanvasRuntime.ts` | The brain (already planned) |

### CanvasSurfaceManager.ts

```typescript
interface CanvasSurface {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
}

interface SurfaceInfo {
  cssWidth: number;
  cssHeight: number;
  dpr: number;
  pixelWidth: number;
  pixelHeight: number;
}

interface SurfaceManagerConfig {
  container: HTMLElement;
  baseCanvas: HTMLCanvasElement;
  overlayCanvas: HTMLCanvasElement;
  onSurfaceChange?: (info: SurfaceInfo) => void;
}

class CanvasSurfaceManager {
  private resizeObserver: ResizeObserver | null = null;
  private dprMediaQuery: MediaQueryList | null = null;
  private baseSurface: CanvasSurface | null = null;
  private overlaySurface: CanvasSurface | null = null;
  private currentDpr = 1;

  constructor(private config: SurfaceManagerConfig) {}

  start(): void {
    // Get contexts
    this.baseSurface = this.initSurface(this.config.baseCanvas);
    this.overlaySurface = this.initSurface(this.config.overlayCanvas);

    // Register base canvas as pointer target
    setCanvasElement(this.config.baseCanvas);

    // Single ResizeObserver on container
    this.resizeObserver = new ResizeObserver(this.handleResize);
    this.resizeObserver.observe(this.config.container);

    // DPR listener
    this.setupDprListener();
  }

  stop(): void {
    this.resizeObserver?.disconnect();
    if (this.dprMediaQuery) {
      this.dprMediaQuery.removeEventListener('change', this.handleDprChange);
    }
    setCanvasElement(null);
  }

  getSurface(type: 'base' | 'overlay'): CanvasSurface | null {
    return type === 'base' ? this.baseSurface : this.overlaySurface;
  }

  private initSurface(canvas: HTMLCanvasElement): CanvasSurface {
    const ctx = canvas.getContext('2d', { willReadFrequently: false })!;
    configureContext2D(ctx);
    return { canvas, ctx };
  }

  private handleResize = (entries: ResizeObserverEntry[]) => {
    const entry = entries[0];
    const { width, height } = entry.contentRect;  // CSS pixels
    this.updateBothCanvases(width, height, this.currentDpr);
  };

  private handleDprChange = () => {
    const newDpr = window.devicePixelRatio || 1;
    if (newDpr !== this.currentDpr) {
      const rect = this.config.container.getBoundingClientRect();
      this.updateBothCanvases(rect.width, rect.height, newDpr);
      this.setupDprListener();  // Re-bind for new DPR value
    }
  };

  private setupDprListener(): void {
    if (this.dprMediaQuery) {
      this.dprMediaQuery.removeEventListener('change', this.handleDprChange);
    }
    this.currentDpr = window.devicePixelRatio || 1;
    this.dprMediaQuery = window.matchMedia(`(resolution: ${this.currentDpr}dppx)`);
    this.dprMediaQuery.addEventListener('change', this.handleDprChange);
  }

  private updateBothCanvases(cssWidth: number, cssHeight: number, dpr: number): void {
    const maxDim = PERFORMANCE_CONFIG.MAX_CANVAS_DIMENSION;
    const pixelWidth = Math.min(Math.round(cssWidth * dpr), maxDim);
    const pixelHeight = Math.min(Math.round(cssHeight * dpr), maxDim);

    // Compute effective DPR if clamped
    const effectiveDpr = pixelWidth / cssWidth;  // May differ if clamped

    // Update both canvases atomically
    for (const surface of [this.baseSurface, this.overlaySurface]) {
      if (!surface) continue;
      const { canvas, ctx } = surface;

      // Only set if changed (setting dimensions clears canvas!)
      if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
        canvas.width = pixelWidth;
        canvas.height = pixelHeight;
        // Context state is nuked by resize - reconfigure
        configureContext2D(ctx);
      }
    }

    // Update camera store
    useCameraStore.getState().setViewport(cssWidth, cssHeight, effectiveDpr);

    // Notify callback
    this.config.onSurfaceChange?.({
      cssWidth,
      cssHeight,
      dpr: effectiveDpr,
      pixelWidth,
      pixelHeight,
    });
  }
}
```

### Modified RenderLoop.ts

**Key Changes:**
1. Accept `surface: CanvasSurface` instead of `stageRef`
2. Add `setSurface(info: SurfaceInfo)` method
3. Remove per-tick `setCanvasSize()` call
4. Make transforms explicit per pass
5. Keep camera subscription for transform changes

```typescript
interface RenderLoopConfig {
  surface: CanvasSurface;  // Direct surface, not stageRef

}

class RenderLoop {
  private surface: CanvasSurface | null = null;
  private surfaceInfo: SurfaceInfo | null = null;
  private dirtyTracker = new DirtyRectTracker();
  // ... rest of state

  start(config: RenderLoopConfig): void {
    this.surface = config.surface;
    // ... subscribe to camera store for transform changes (keep existing)
  }

  // Called by SurfaceManager on resize
  setSurface(info: SurfaceInfo): void {
    this.surfaceInfo = info;
    this.dirtyTracker.setCanvasSize(info.pixelWidth, info.pixelHeight, info.dpr);
    this.dirtyTracker.invalidateAll('geometry-change');
    this.markDirty();
  }

  private tick(): void {
    if (!this.surface || !this.surfaceInfo) return;
    const { canvas, ctx } = this.surface;
    const { pixelWidth, pixelHeight, dpr } = this.surfaceInfo;

    const view = getViewTransform();
    const clearInstructions = this.dirtyTracker.getClearInstructions();

    // Clear pass - identity transform, device pixels
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (clearInstructions.type === 'full') {
      ctx.clearRect(0, 0, pixelWidth, pixelHeight);
    } else if (clearInstructions.type === 'dirty' && clearInstructions.rects) {
      for (const rect of clearInstructions.rects) {
        ctx.clearRect(rect.x, rect.y, rect.width, rect.height);
      }
    }

    // World pass - DPR × scale × translate
    ctx.setTransform(
      dpr * view.scale, 0, 0, dpr * view.scale,
      -view.pan.x * dpr * view.scale, -view.pan.y * dpr * view.scale
    );

    // Apply clipping if dirty rects...
    drawBackground(ctx, snapshot, view, viewport);
    drawObjects(ctx, snapshot, view, viewport);
    drawText(ctx, snapshot, view, viewport); //legacy
    drawAuthoringOverlays(ctx, snapshot, view, viewport); //legacy

    // Screen pass - DPR only (for HUD elements)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawHUD(ctx, snapshot, view, viewport);  //legacy

    this.dirtyTracker.reset();
  }
}
```

### Modified DirtyRectTracker.ts

**Key Changes:**
1. Remove `notifyTransformChange()` and `lastTransform`
2. Remove dpr parameter from `invalidateCanvasPixels()` - use stored dpr

```typescript
class DirtyRectTracker {
  private rects: DevicePixelRect[] = [];
  private fullClearRequired = false;
  private canvasSize = { width: 0, height: 0 };
  private dpr = 1;

  // Remove lastTransform - not our concern

  setCanvasSize(width: number, height: number, dpr: number): void {
    this.canvasSize = { width, height };
    this.dpr = dpr;
  }

  // Remove notifyTransformChange() - caller should use invalidateAll('transform-change')

  invalidateWorldBounds(bounds: WorldBounds, viewTransform: ViewTransform): void {
    // Convert world to CSS pixels
    const [minCanvasX, minCanvasY] = viewTransform.worldToCanvas(bounds.minX, bounds.minY);
    const [maxCanvasX, maxCanvasY] = viewTransform.worldToCanvas(bounds.maxX, bounds.maxY);

    // Use stored DPR - no parameter needed
    this.invalidateCanvasPixels({
      x: minCanvasX,
      y: minCanvasY,
      width: maxCanvasX - minCanvasX,
      height: maxCanvasY - minCanvasY,
    }, viewTransform.scale);
  }

  // Remove dpr parameter - use this.dpr
  invalidateCanvasPixels(rect: CSSPixelRect, scale: number): void {
    if (this.fullClearRequired) return;

    // Convert CSS pixels to device pixels using stored dpr
    const deviceRect = {
      x: rect.x * this.dpr,
      y: rect.y * this.dpr,
      width: rect.width * this.dpr,
      height: rect.height * this.dpr,
    };

    // ... rest of logic (margins, clamping, etc.)
    this.rects.push(inflated);
    this.checkPromotion();
  }

  invalidateAll(_reason: InvalidationReason): void {
    this.fullClearRequired = true;
    this.rects = [];
  }

  // ... rest unchanged
}
```

### Modified Canvas.tsx

**Goal:** ~100-150 lines, thin React wrapper

```typescript
export const Canvas = ({ roomId, className }: CanvasProps) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const baseCanvasRef = useRef<HTMLCanvasElement>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null);
  const editorHostRef = useRef<HTMLDivElement>(null);
  const runtimeRef = useRef<CanvasRuntime | null>(null);

  const roomDoc = useRoomDoc(roomId);

  // Set active room context (tools need this)
  useLayoutEffect(() => {
    setActiveRoom({ roomId, roomDoc });
    return () => setActiveRoom(null);
  }, [roomId, roomDoc]);

  // Set editor host (TextTool needs this)
  useLayoutEffect(() => {
    setEditorHost(editorHostRef.current);
    return () => setEditorHost(null);
  }, []);

  // Create and start runtime
  useLayoutEffect(() => {
    if (!containerRef.current || !baseCanvasRef.current || !overlayCanvasRef.current) return;

    const runtime = new CanvasRuntime();
    runtimeRef.current = runtime;

    runtime.start({
      container: containerRef.current,
      baseCanvas: baseCanvasRef.current,
      overlayCanvas: overlayCanvasRef.current,
      roomDoc,
    });

    return () => {
      runtime.stop();
      runtimeRef.current = null;
    };
  }, [roomDoc]);

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
      <div
        ref={editorHostRef}
        style={{ position: 'absolute', inset: 0, zIndex: 3, pointerEvents: 'none' }}
      />
    </div>
  );
};
```

### CanvasRuntime.ts

```typescript
interface RuntimeConfig {
  container: HTMLElement;
  baseCanvas: HTMLCanvasElement;
  overlayCanvas: HTMLCanvasElement;
  roomDoc: IRoomDocManager;
}

class CanvasRuntime {
  private surfaceManager: CanvasSurfaceManager | null = null;
  private renderLoop: RenderLoop | null = null;
  private overlayLoop: OverlayRenderLoop | null = null;
  private inputManager: InputManager | null = null;
  private zoomAnimator: ZoomAnimator | null = null;
  private snapshotUnsubscribe: (() => void) | null = null;

  start(config: RuntimeConfig): void {
    // Create surface manager
    this.surfaceManager = new CanvasSurfaceManager({
      container: config.container,
      baseCanvas: config.baseCanvas,
      overlayCanvas: config.overlayCanvas,
      onSurfaceChange: (info) => {
        this.renderLoop?.setSurface(info);
        this.overlayLoop?.setSurface(info);
      },
    });
    this.surfaceManager.start();

    // Create render loops with surfaces
    const baseSurface = this.surfaceManager.getSurface('base')!;
    const overlaySurface = this.surfaceManager.getSurface('overlay')!;

    this.renderLoop = new RenderLoop();
    this.renderLoop.start({
      surface: baseSurface,
      getSnapshot: () => config.roomDoc.currentSnapshot,
      getGates: () => config.roomDoc.getGateStatus(),
    });

    this.overlayLoop = new OverlayRenderLoop();
    this.overlayLoop.start({
      surface: overlaySurface,
      getGates: () => config.roomDoc.getGateStatus(),
      getPresence: () => config.roomDoc.currentSnapshot.presence,
      getSnapshot: () => config.roomDoc.currentSnapshot,
    });

    // Register invalidators
    setWorldInvalidator((bounds) => this.renderLoop?.invalidateWorld(bounds));
    setOverlayInvalidator(() => this.overlayLoop?.invalidateAll());

    // Create input manager (forwards events to this runtime)
    this.inputManager = new InputManager(this);
    this.inputManager.attach();

    // Create zoom animator
    this.zoomAnimator = new ZoomAnimator();

    // Subscribe to snapshots
    this.snapshotUnsubscribe = config.roomDoc.subscribeSnapshot((snapshot) => {
      // Handle dirty patches, invalidation, etc.
      // (Logic currently in Canvas.tsx moves here)
    });
  }

  stop(): void {
    this.snapshotUnsubscribe?.();
    this.zoomAnimator?.destroy();
    this.inputManager?.detach();
    setWorldInvalidator(null);
    setOverlayInvalidator(null);
    this.overlayLoop?.stop();
    this.overlayLoop?.destroy();
    this.renderLoop?.stop();
    this.renderLoop?.destroy();
    this.surfaceManager?.stop();
  }

  // Event handlers (called by InputManager)
  handlePointerDown(e: PointerEvent): void { /* ... */ }
  handlePointerMove(e: PointerEvent): void { /* ... */ }
  handlePointerUp(e: PointerEvent): void { /* ... */ }
  handlePointerCancel(e: PointerEvent): void { /* ... */ }
  handlePointerLeave(e: PointerEvent): void { /* ... */ }
  handleLostPointerCapture(e: PointerEvent): void { /* ... */ }
  handleWheel(e: WheelEvent): void { /* ... */ }
}
```

---

## Initialization Order

The new initialization order preserves correctness:

1. **Canvas.tsx mounts** - DOM elements exist
2. **useLayoutEffect** (synchronous with commit phase):
   - `setActiveRoom()` - room context available
   - `setEditorHost()` - editor host available
   - `runtime.start()`:
     - SurfaceManager starts
     - SurfaceManager.handleResize fires (first ResizeObserver callback is synchronous for elements already in DOM)
     - camera-store.setViewport() called
     - RenderLoop/OverlayLoop created with surfaces
     - InputManager attached
3. **Paint happens**
4. **useEffect** (if any) - none in simplified Canvas.tsx

This works because:
- `useLayoutEffect` is synchronous with React's commit phase
- ResizeObserver first callback fires synchronously for elements already sized
- All runtime components are ready before any user interaction

---

## Migration Path

### Phase 2A: Create CanvasSurfaceManager.ts
- Implement the class as described above
- Test in isolation

### Phase 2B: Create CanvasRuntime Shell
- Basic start/stop with SurfaceManager
- No event handling yet

### Phase 2C: Modify RenderLoop
- Accept surface instead of stageRef
- Add setSurface() method
- Make transforms explicit
- Remove per-tick setCanvasSize()
- Keep camera subscription for now

### Phase 2D: Modify DirtyRectTracker
- Remove notifyTransformChange() and lastTransform
- Remove dpr parameter from invalidateCanvasPixels()
- RenderLoop calls invalidateAll('transform-change') on camera changes

### Phase 2E: Modify OverlayRenderLoop
- Accept surface instead of stage object
- Add setSurface() method
- Make transforms explicit

### Phase 2F: Wire Up CanvasRuntime
- Add event handlers (move from Canvas.tsx)
- Add snapshot subscription (move from Canvas.tsx)
- Add tool dispatch

### Phase 2G: Create InputManager.ts
- Attach/detach event listeners
- Forward raw events to runtime

### Phase 2H: Simplify Canvas.tsx
- Remove all event handlers
- Remove render loop management
- Remove imperative handle
- Remove CanvasStage usage
- Render raw canvas elements

### Phase 2I: Delete CanvasStage.tsx
- Remove the file entirely
- Clean up any remaining references

---

## Open Questions

### 1. Should RenderLoop still subscribe to camera-store for transform changes?

**Current recommendation:** Yes, keep it.

The subscription is working and provides clean separation. RenderLoop doesn't need to know *why* the transform changed, just that it did. The subscription handles this well.

Alternative: Centralize in CanvasRuntime and call `renderLoop.invalidateAll()` directly. This is valid but adds complexity for no clear benefit.

### 2. Should we create a FrameScheduler?

**Current recommendation:** No, not yet.

Document visibility handling in RenderLoop is working. OverlayRenderLoop is simpler and doesn't need it. If we later want synced scheduling (e.g., for animation coordination), we can add a FrameScheduler then.

### 3. Should camera-store.ts own mobile detection?

**Current recommendation:** Yes.

Add `isMobile(): boolean` function to camera-store that's computed once when `setCanvasElement()` is called. RenderLoop can read it imperatively for FPS throttling.

---

## Deleted Items

| Item | Reason |
|------|--------|
| `CanvasStage.tsx` | Replaced by CanvasSurfaceManager |
| `CanvasStageHandle` interface | No longer needed |
| `stageRef` in RenderLoop config | Replaced by surface |
| `notifyTransformChange()` in DirtyRectTracker | Not its responsibility |
| `lastTransform` in DirtyRectTracker | Not its responsibility |
| Per-tick `setCanvasSize()` call | Event-driven via setSurface() |
| `withContext()` pattern | Loops use ctx directly |
| `CanvasHandle` in Canvas.tsx | Imperative handle removed |

---

## Success Criteria

1. **CanvasStage.tsx deleted** - replaced by CanvasSurfaceManager
2. **Single ResizeObserver** - on container, updates both canvases
3. **Loops receive surfaces directly** - no React refs
4. **Transforms explicit per pass** - no implicit DPR reliance
5. **DirtyRectTracker simplified** - no transform tracking
6. **Canvas.tsx < 150 lines** - thin React wrapper
7. **All tests pass** - `npm run typecheck`
