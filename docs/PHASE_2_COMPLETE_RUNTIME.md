# Phase 2: Complete Canvas Runtime Implementation

**STATUS:** Ready for Execution
**BRANCH:** `refactor/canvas-runtime-phase1`

---

## Key Insights from Code Analysis

### 1. PanTool CAN Use World Coordinates

**Current state is broken by design:**
```typescript
// PanTool.ts - current
begin(pointerId, _worldX, _worldY, clientX?, clientY?) {
  // IGNORES world coords (underscore prefix)!
  this.lastClient = { x: clientX, y: clientY };
}

move(_worldX, _worldY) {
  // EMPTY! Does literally nothing!
}

// Actual pan logic is in a separate method:
updatePan(clientX, clientY) { ... }
```

**The insight:** `worldToCanvas(screenToWorld(S)) = S` always!

When you receive world coords and convert back to screen:
- Screen position S → World = S/scale + pan
- worldToCanvas(World) = (S/scale + pan - pan) × scale = S

**Even when pan changes mid-gesture**, converting world back to screen gives the correct screen position. The delta calculation works!

**Trace through:**
```
Frame 1: Screen (100,100), pan=(0,0)
  → World (100,100)
  → Store lastScreen = worldToCanvas(100,100) = (100,100)

Frame 2: Drag to screen (110,100), pan=(0,0)
  → World (110,100)
  → currentScreen = worldToCanvas(110,100) = (110,100)
  → dx = 10, apply pan → pan=(-10,0)

Frame 3: Pointer still at screen (110,100), pan=(-10,0)
  → World = screenToWorld(110,100) = (100,100)  // Changed!
  → currentScreen = worldToCanvas(100,100) = (110,100)  // Same screen pos!
  → dx = 0 ✓
```

**Solution: PanTool fits the standard interface!**
- Receives world coords like all other tools
- Converts to screen internally for delta calculation
- IS a real tool in the registry
- Works for both MMB pan AND dedicated pan tool mode

### 2. SelectTool Hover Cursor

**Current problem:**
```typescript
// Canvas.tsx - special casing
if (activeToolRef.current === 'select' && !tool.isActive()) {
  (tool as SelectTool).updateHoverCursor(world[0], world[1]);
}
```

**Why?** SelectTool's `move()` has no `case 'idle':` in its switch statement. When idle, `move()` does nothing.

**Solution:** Add `case 'idle':` to `move()` that handles hover cursor internally. No external call needed.

### 3. Module-Level References

**Current problem:** `this.baseCanvas?` everywhere with optional chaining.

**Solution:** Once runtime starts, canvas exists until stop. Use module-level functions:
- `getCanvasElement()` - already exists in camera-store
- Add `capturePointer(id)` / `releasePointer(id)` to camera-store
- Add `updatePresenceCursor()` / `clearPresenceCursor()` to room-runtime

---

## Architecture Changes

### Pan IS a Tool (with Smart Helpers)

```
tool-registry.ts:
  pen, highlighter, shape → DrawingTool (singleton)
  eraser → EraserTool (singleton)
  text → TextTool (singleton)
  pan → PanTool (singleton)  ✓ INCLUDED!
  select → SelectTool (singleton)

Helpers:
  getCurrentTool() → current tool singleton (including panTool)
  canStartMMBPan() → checks if MMB pan can start
  panTool → exported for direct MMB access
```

**CanvasRuntime logic:**
```typescript
handlePointerDown(e: PointerEvent) {
  // MMB: always pan (if allowed)
  if (e.button === 1) {
    if (!canStartMMBPan()) return;
    e.preventDefault();
    const world = screenToWorld(e.clientX, e.clientY);
    if (!world) return;
    capturePointer(e.pointerId);
    panTool.begin(e.pointerId, world[0], world[1]);
    return;
  }

  // Left click: use current tool (might be panTool!)
  if (e.button === 0) {
    const tool = getCurrentTool();
    if (!tool?.canBegin()) return;
    e.preventDefault();
    const world = screenToWorld(e.clientX, e.clientY);
    if (!world) return;
    capturePointer(e.pointerId);
    tool.begin(e.pointerId, world[0], world[1]);
  }
  // Right click (button 2+): ignored
}
```

**Key points:**
- When activeTool='pan', `getCurrentTool()` returns panTool
- Left click with pan tool works naturally - no special casing
- MMB uses panTool directly via helper, regardless of activeTool
- Right click is properly ignored (not caught by `!tool` check)

---

## File Changes

### 1. camera-store.ts - Add Pointer Capture Helpers

```typescript
// Add after getCanvasElement():

export function capturePointer(pointerId: number): void {
  try {
    canvasElement?.setPointerCapture(pointerId);
  } catch {}
}

export function releasePointer(pointerId: number): void {
  try {
    canvasElement?.releasePointerCapture(pointerId);
  } catch {}
}
```

### 2. room-runtime.ts - Add Presence Helpers

```typescript
// Add at end:

export function updatePresenceCursor(worldX: number, worldY: number): void {
  getActiveRoomDoc().updateCursor(worldX, worldY);
}

export function clearPresenceCursor(): void {
  getActiveRoomDoc().updateCursor(undefined, undefined);
}
```

### 3. types.ts - Add PointerTool Interface

```typescript
/**
 * PointerTool - Interface for tools that handle pointer gestures.
 * All methods required. Use no-ops where not applicable.
 */
export interface PointerTool {
  canBegin(): boolean;
  begin(pointerId: number, worldX: number, worldY: number): void;
  move(worldX: number, worldY: number): void;
  end(worldX?: number, worldY?: number): void;
  cancel(): void;
  isActive(): boolean;
  getPointerId(): number | null;
  getPreview(): PreviewData | null;
  onPointerLeave(): void;
  onViewChange(): void;
  destroy(): void;
}
```

### 4. PanTool.ts - Rewrite with World-Space Interface

```typescript
import { useCameraStore, worldToCanvas } from '@/stores/camera-store';
import { setCursorOverride } from '@/canvas/cursor-manager';
import { invalidateOverlay } from '@/canvas/invalidation-helpers';
import type { PointerTool, PreviewData } from './types';

/**
 * PanTool - Viewport panning.
 *
 * Implements PointerTool interface using world coordinates.
 * Internally converts to screen space for delta calculation.
 *
 * Key insight: worldToCanvas(screenToWorld(S)) = S always!
 * So even when pan changes mid-gesture, converting world→screen
 * gives the correct screen position for delta calculation.
 */
export class PanTool implements PointerTool {
  private pointerId: number | null = null;
  private lastScreen: [number, number] | null = null;

  canBegin(): boolean {
    return this.pointerId === null;
  }

  begin(pointerId: number, worldX: number, worldY: number): void {
    this.pointerId = pointerId;
    // Convert world to screen and store
    this.lastScreen = worldToCanvas(worldX, worldY);
    setCursorOverride('grabbing');
    invalidateOverlay();
  }

  move(worldX: number, worldY: number): void {
    if (!this.lastScreen) return;

    // Convert world to screen for accurate delta
    const currentScreen = worldToCanvas(worldX, worldY);

    const dx = currentScreen[0] - this.lastScreen[0];
    const dy = currentScreen[1] - this.lastScreen[1];
    this.lastScreen = currentScreen;

    const { scale, pan, setPan } = useCameraStore.getState();
    setPan({
      x: pan.x - dx / scale,
      y: pan.y - dy / scale,
    });
    invalidateOverlay();
  }

  end(): void {
    this.pointerId = null;
    this.lastScreen = null;
    setCursorOverride(null);
    invalidateOverlay();
  }

  cancel(): void {
    this.end();
  }

  isActive(): boolean {
    return this.pointerId !== null;
  }

  getPointerId(): number | null {
    return this.pointerId;
  }

  getPreview(): PreviewData | null {
    return null;
  }

  onPointerLeave(): void {}
  onViewChange(): void {}
  destroy(): void { this.cancel(); }
}
```

### 5. SelectTool.ts - Handle Hover in move()

Add `case 'idle':` to move() method:

```typescript
move(worldX: number, worldY: number): void {
  const [screenX, screenY] = worldToCanvas(worldX, worldY);

  switch (this.phase) {
    case 'idle': {
      // Handle hover cursor when not in a gesture
      this.handleHoverCursor(worldX, worldY);
      break;
    }
    case 'pendingClick': { /* existing */ }
    case 'marquee': { /* existing */ }
    case 'translate': { /* existing */ }
    case 'scale': { /* existing */ }
  }
}

private handleHoverCursor(worldX: number, worldY: number): void {
  const { selectedIds } = useSelectionStore.getState();
  if (selectedIds.length === 0) {
    setCursorOverride(null);
    return;
  }

  const handle = this.hitTestHandle(worldX, worldY);
  if (handle) {
    setCursorOverride(this.getHandleCursor(handle));
  } else {
    setCursorOverride(null);
  }
}

// Rename clearHover to onPointerLeave
onPointerLeave(): void {
  setCursorOverride(null);
}

// Add no-op
onViewChange(): void {}
```

**Remove:** `updateHoverCursor()` public method (logic moved into move())
**Rename:** `clearHover()` → `onPointerLeave()`

### 6. EraserTool.ts - Rename Methods

```typescript
// Rename clearHover to onPointerLeave
onPointerLeave(): void {
  if (!this.state.isErasing) {
    this.state.lastWorld = null;
    invalidateOverlay();
  }
}

// Keep existing onViewChange
onViewChange(): void {
  if (this.state.isErasing && this.state.lastWorld) {
    this.updateHitTest();
    invalidateOverlay();
  }
}
```

### 7. DrawingTool.ts / TextTool.ts - Add No-ops

```typescript
onPointerLeave(): void {}
onViewChange(): void {}  // TextTool keeps its existing implementation
```

### 8. tool-registry.ts (NEW)

```typescript
import { DrawingTool } from '@/lib/tools/DrawingTool';
import { EraserTool } from '@/lib/tools/EraserTool';
import { TextTool } from '@/lib/tools/TextTool';
import { PanTool } from '@/lib/tools/PanTool';
import { SelectTool } from '@/lib/tools/SelectTool';
import { useDeviceUIStore, type Tool as ToolId } from '@/stores/device-ui-store';
import type { PointerTool, PreviewData } from '@/lib/tools/types';

// ===========================================
// SINGLETONS - Constructed at module load
// ===========================================

const drawingTool = new DrawingTool();
const eraserTool = new EraserTool();
const textTool = new TextTool();
const panTool = new PanTool();
const selectTool = new SelectTool();

// ===========================================
// TOOL LOOKUP
// ===========================================

const toolMap = new Map<ToolId, PointerTool>([
  ['pen', drawingTool],
  ['highlighter', drawingTool],
  ['shape', drawingTool],
  ['eraser', eraserTool],
  ['text', textTool],
  ['pan', panTool],      // Pan IS a tool!
  ['select', selectTool],
]);

// ===========================================
// HELPERS
// ===========================================

/** Get tool by ID. Returns undefined for 'image', 'code'. */
export function getToolById(toolId: ToolId): PointerTool | undefined {
  return toolMap.get(toolId);
}

/** Get current tool from activeTool state. */
export function getCurrentTool(): PointerTool | undefined {
  return toolMap.get(useDeviceUIStore.getState().activeTool);
}

/** Get preview from current tool. */
export function getActivePreview(): PreviewData | null {
  return getCurrentTool()?.getPreview() ?? null;
}

/**
 * Check if MMB pan can start.
 * - Pan must not already be active
 * - No other tool can be in an active gesture
 */
export function canStartMMBPan(): boolean {
  if (panTool.isActive()) return false;
  const tool = getCurrentTool();
  // If current tool is panTool, we already checked above
  // Otherwise, check if another tool is busy
  return !(tool && tool !== panTool && tool.isActive());
}

// ===========================================
// EXPORTS
// ===========================================

/** Export panTool for direct MMB access */
export { panTool };

/** Export all tools for testing */
export const allTools = { drawingTool, eraserTool, textTool, panTool, selectTool };
```

### 9. InputManager.ts (NEW)

```typescript
import { getCanvasElement } from '@/stores/camera-store';
import type { CanvasRuntime } from './CanvasRuntime';

/**
 * InputManager - Dumb DOM event forwarder.
 * No coordinate conversion. No tool logic. No state.
 */
export class InputManager {
  private canvas: HTMLCanvasElement | null = null;

  constructor(private runtime: CanvasRuntime) {}

  attach(): void {
    this.canvas = getCanvasElement();
    if (!this.canvas) return;

    this.canvas.addEventListener('pointerdown', this.onPointerDown, { passive: false });
    this.canvas.addEventListener('pointermove', this.onPointerMove, { passive: false });
    this.canvas.addEventListener('pointerup', this.onPointerUp, { passive: false });
    this.canvas.addEventListener('pointercancel', this.onPointerCancel, { passive: false });
    this.canvas.addEventListener('pointerleave', this.onPointerLeave, { passive: false });
    this.canvas.addEventListener('lostpointercapture', this.onLostCapture, { passive: false });
    this.canvas.addEventListener('wheel', this.onWheel, { passive: false });
  }

  detach(): void {
    if (!this.canvas) return;
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    this.canvas.removeEventListener('pointermove', this.onPointerMove);
    this.canvas.removeEventListener('pointerup', this.onPointerUp);
    this.canvas.removeEventListener('pointercancel', this.onPointerCancel);
    this.canvas.removeEventListener('pointerleave', this.onPointerLeave);
    this.canvas.removeEventListener('lostpointercapture', this.onLostCapture);
    this.canvas.removeEventListener('wheel', this.onWheel);
    this.canvas = null;
  }

  private onPointerDown = (e: PointerEvent) => this.runtime.handlePointerDown(e);
  private onPointerMove = (e: PointerEvent) => this.runtime.handlePointerMove(e);
  private onPointerUp = (e: PointerEvent) => this.runtime.handlePointerUp(e);
  private onPointerCancel = (e: PointerEvent) => this.runtime.handlePointerCancel(e);
  private onPointerLeave = (e: PointerEvent) => this.runtime.handlePointerLeave(e);
  private onLostCapture = (e: PointerEvent) => this.runtime.handleLostPointerCapture(e);
  private onWheel = (e: WheelEvent) => this.runtime.handleWheel(e);
}
```

### 10. CanvasRuntime.ts (NEW)

```typescript
import { RenderLoop } from '@/renderer/RenderLoop';
import { OverlayRenderLoop } from '@/renderer/OverlayRenderLoop';
import { ZoomAnimator } from './animation/ZoomAnimator';
import { SurfaceManager } from './SurfaceManager';
import { InputManager } from './InputManager';
import { getCurrentTool, canStartMMBPan, panTool } from './tool-registry';
import { setWorldInvalidator, setOverlayInvalidator } from './invalidation-helpers';
import { setBaseContext, setOverlayContext } from './canvas-context-registry';
import { updatePresenceCursor, clearPresenceCursor } from './room-runtime';
import {
  setCanvasElement,
  screenToWorld,
  screenToCanvas,
  capturePointer,
  releasePointer,
  useCameraStore,
} from '@/stores/camera-store';
import { calculateZoomTransform } from './internal/transforms';

export interface RuntimeConfig {
  container: HTMLElement;
  baseCanvas: HTMLCanvasElement;
  overlayCanvas: HTMLCanvasElement;
}

export class CanvasRuntime {
  private inputManager: InputManager | null = null;
  private surfaceManager: SurfaceManager | null = null;
  private renderLoop: RenderLoop | null = null;
  private overlayLoop: OverlayRenderLoop | null = null;
  private zoomAnimator: ZoomAnimator | null = null;
  private cameraUnsub: (() => void) | null = null;

  start(config: RuntimeConfig): void {
    const { container, baseCanvas, overlayCanvas } = config;

    // 1. Register contexts
    const baseCtx = baseCanvas.getContext('2d', { willReadFrequently: false });
    const overlayCtx = overlayCanvas.getContext('2d', { willReadFrequently: false });
    if (!baseCtx || !overlayCtx) throw new Error('Failed to get 2D contexts');

    setBaseContext(baseCtx);
    setOverlayContext(overlayCtx);
    setCanvasElement(baseCanvas);

    // 2. Surface manager (resize/DPR)
    this.surfaceManager = new SurfaceManager(container, baseCanvas, overlayCanvas);
    this.surfaceManager.start();

    // 3. Render loops
    this.renderLoop = new RenderLoop();
    this.renderLoop.start();
    setWorldInvalidator((bounds) => this.renderLoop?.invalidateWorld(bounds));

    this.overlayLoop = new OverlayRenderLoop();
    this.overlayLoop.start();
    setOverlayInvalidator(() => this.overlayLoop?.invalidateAll());

    // 4. Zoom animator
    this.zoomAnimator = new ZoomAnimator();

    // 5. Input manager
    this.inputManager = new InputManager(this);
    this.inputManager.attach();

    // 6. Camera subscription for tool view changes
    this.cameraUnsub = useCameraStore.subscribe(
      (s) => ({ scale: s.scale, px: s.pan.x, py: s.pan.y }),
      () => getCurrentTool()?.onViewChange(),
      { equalityFn: (a, b) => a.scale === b.scale && a.px === b.px && a.py === b.py }
    );
  }

  stop(): void {
    this.cameraUnsub?.();
    this.inputManager?.detach();
    this.zoomAnimator?.destroy();

    setWorldInvalidator(null);
    this.renderLoop?.stop();
    this.renderLoop?.destroy();

    setOverlayInvalidator(null);
    this.overlayLoop?.stop();
    this.overlayLoop?.destroy();

    this.surfaceManager?.stop();

    setBaseContext(null);
    setOverlayContext(null);
    setCanvasElement(null);

    this.inputManager = null;
    this.surfaceManager = null;
    this.renderLoop = null;
    this.overlayLoop = null;
    this.zoomAnimator = null;
    this.cameraUnsub = null;
  }

  // === Event Handlers ===

  handlePointerDown(e: PointerEvent): void {
    // MMB: always pan (if allowed)
    if (e.button === 1) {
      if (!canStartMMBPan()) return;
      e.preventDefault();
      const world = screenToWorld(e.clientX, e.clientY);
      if (!world) return;
      capturePointer(e.pointerId);
      panTool.begin(e.pointerId, world[0], world[1]);
      return;
    }

    // Left click: use current tool (might be panTool!)
    if (e.button === 0) {
      const tool = getCurrentTool();
      if (!tool?.canBegin()) return;
      e.preventDefault();
      const world = screenToWorld(e.clientX, e.clientY);
      if (!world) return;
      capturePointer(e.pointerId);
      tool.begin(e.pointerId, world[0], world[1]);
    }
    // Right click (button 2+): ignored
  }

  handlePointerMove(e: PointerEvent): void {
    const world = screenToWorld(e.clientX, e.clientY);
    if (world) updatePresenceCursor(world[0], world[1]);

    // Pan active? (from MMB or pan tool mode)
    if (panTool.isActive() && panTool.getPointerId() === e.pointerId) {
      if (world) panTool.move(world[0], world[1]);
      return;
    }

    // Tool (active gesture or hover)
    const tool = getCurrentTool();
    if (tool && world) {
      tool.move(world[0], world[1]);
    }
  }

  handlePointerUp(e: PointerEvent): void {
    // Pan release (from MMB or pan tool mode)
    if (panTool.isActive() && panTool.getPointerId() === e.pointerId) {
      releasePointer(e.pointerId);
      panTool.end();
      return;
    }

    // Tool release
    const tool = getCurrentTool();
    if (tool?.isActive() && tool.getPointerId() === e.pointerId) {
      releasePointer(e.pointerId);
      const world = screenToWorld(e.clientX, e.clientY);
      tool.end(world?.[0], world?.[1]);
    }
  }

  handlePointerCancel(e: PointerEvent): void {
    if (panTool.isActive() && panTool.getPointerId() === e.pointerId) {
      panTool.cancel();
      return;
    }

    const tool = getCurrentTool();
    if (tool?.getPointerId() === e.pointerId) {
      releasePointer(e.pointerId);
      tool.cancel();
    }
  }

  handlePointerLeave(_e: PointerEvent): void {
    clearPresenceCursor();
    getCurrentTool()?.onPointerLeave();
  }

  handleLostPointerCapture(e: PointerEvent): void {
    if (panTool.isActive() && panTool.getPointerId() === e.pointerId) {
      panTool.cancel();
      return;
    }

    const tool = getCurrentTool();
    if (tool?.getPointerId() === e.pointerId) {
      tool.cancel();
      tool.onPointerLeave();
    }
  }

  handleWheel(e: WheelEvent): void {
    e.preventDefault();
    if (panTool.isActive()) return;

    const canvas = screenToCanvas(e.clientX, e.clientY);
    if (!canvas) return;

    let deltaY = e.deltaY;
    if (e.deltaMode === 1) deltaY *= 40;
    else if (e.deltaMode === 2) deltaY *= 800;

    const factor = Math.exp((-deltaY / 120) * Math.log(1.16));
    const { scale, pan } = useCameraStore.getState();
    const target = calculateZoomTransform(scale, pan, factor, { x: canvas[0], y: canvas[1] });

    this.zoomAnimator?.to(target.scale, target.pan);
  }
}
```

### 11. OverlayRenderLoop.ts - Self-Manage Preview

```typescript
// Add import
import { getActivePreview } from '@/canvas/tool-registry';
import { useDeviceUIStore } from '@/stores/device-ui-store';

// Remove:
// - PreviewProvider interface
// - setPreviewProvider() method
// - previewProvider field

// In start():
this.toolUnsub = useDeviceUIStore.subscribe(
  (s) => s.activeTool,
  () => {
    this.cachedPreview = null;
    this.holdPreviewOneFrame = false;
    this.invalidateAll();
  }
);

// In stop()/destroy():
this.toolUnsub?.();

// In frame():
const preview = getActivePreview();  // Instead of this.previewProvider?.getPreview()
```

### 12. RenderLoop.ts - Remove Config Interface

```typescript
// Change:
export interface RenderLoopConfig {
  _placeholder?: never;
}

// To:
// (Remove interface entirely, or keep empty)

// start() takes no parameters
start(): void { ... }
```

### 13. Canvas.tsx - Thin Wrapper (~100 lines)

```typescript
import React, { useRef, useLayoutEffect, useEffect } from 'react';
import type { RoomId } from '@avlo/shared';
import { useRoomDoc } from '@/hooks/use-room-doc';
import { CanvasRuntime } from './CanvasRuntime';
import { setActiveRoom } from './room-runtime';
import { setEditorHost } from './editor-host-registry';
import { applyCursor } from './cursor-manager';
import { useDeviceUIStore } from '@/stores/device-ui-store';
import { getObjectCacheInstance } from '@/renderer/object-cache';
import { getVisibleWorldBounds, boundsIntersect } from '@/stores/camera-store';

export interface CanvasProps {
  roomId: RoomId;
  className?: string;
}

export const Canvas: React.FC<CanvasProps> = ({ roomId, className }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const baseCanvasRef = useRef<HTMLCanvasElement>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null);
  const editorHostRef = useRef<HTMLDivElement>(null);
  const runtimeRef = useRef<CanvasRuntime | null>(null);

  const roomDoc = useRoomDoc(roomId);

  // 1. Set active room context
  useLayoutEffect(() => {
    setActiveRoom({ roomId, roomDoc });
    return () => setActiveRoom(null);
  }, [roomId, roomDoc]);

  // 2. Set editor host for TextTool
  useLayoutEffect(() => {
    setEditorHost(editorHostRef.current);
    return () => setEditorHost(null);
  }, []);

  // 3. Create and start runtime
  useLayoutEffect(() => {
    const container = containerRef.current;
    const baseCanvas = baseCanvasRef.current;
    const overlayCanvas = overlayCanvasRef.current;
    if (!container || !baseCanvas || !overlayCanvas) return;

    const runtime = new CanvasRuntime();
    runtimeRef.current = runtime;
    runtime.start({ container, baseCanvas, overlayCanvas });

    return () => {
      runtime.stop();
      runtimeRef.current = null;
      getObjectCacheInstance().clear();
    };
  }, []);

  // 4. Update cursor on tool switch
  useLayoutEffect(() => {
    applyCursor();
  }, [useDeviceUIStore((s) => s.activeTool)]);

  // 5. Subscribe to snapshots for dirty rects
  useEffect(() => {
    let lastVersion = -1;
    const unsub = roomDoc.subscribeSnapshot((snap) => {
      const runtime = runtimeRef.current;
      if (!runtime || snap.docVersion === lastVersion) return;
      lastVersion = snap.docVersion;

      if (snap.dirtyPatch) {
        const cache = getObjectCacheInstance();
        cache.evictMany(snap.dirtyPatch.evictIds);
        const viewport = getVisibleWorldBounds();
        for (const rect of snap.dirtyPatch.rects) {
          if (boundsIntersect(rect, viewport)) {
            // runtime.invalidateWorld(rect) - need to expose this
          }
        }
      }
    });
    return unsub;
  }, [roomDoc]);

  return (
    <div ref={containerRef} className="relative w-full h-full" style={{ backgroundColor: '#FFF' }}>
      <canvas
        ref={baseCanvasRef}
        className={className}
        style={{ position: 'absolute', inset: 0, zIndex: 1, width: '100%', height: '100%', touchAction: 'none' }}
      />
      <canvas
        ref={overlayCanvasRef}
        style={{ position: 'absolute', inset: 0, zIndex: 2, width: '100%', height: '100%', pointerEvents: 'none' }}
      />
      <div
        ref={editorHostRef}
        style={{ position: 'absolute', inset: 0, zIndex: 3, pointerEvents: 'none' }}
      />
    </div>
  );
};
```

---

## What Gets Removed

### From Canvas.tsx (delete ~600 lines)
- `mmbPanRef` and all MMB handling
- `suppressToolPreviewRef`
- `activeToolRef`
- `toolRef` and all tool construction
- `lastMouseClientRef` (eraser seeding - LEGACY)
- `snapshotRef`
- All event handlers
- `renderLoopRef`, `overlayLoopRef`, `zoomAnimatorRef`, `surfaceManagerRef`
- Tool imports
- `isMobile` checks
- `roomDoc.updateActivity()` calls
- `setPreviewProvider()` wiring
- Camera subscription for view changes
- All special casing

### From OverlayRenderLoop.ts
- `PreviewProvider` interface
- `setPreviewProvider()` method
- `previewProvider` field

### From SelectTool.ts
- `updateHoverCursor()` public method (moved into `move()`)

### From all tools
- `clearHover()` → renamed to `onPointerLeave()`

---

## Summary of Key Changes

| Change | Why |
|--------|-----|
| PanTool uses world coords (converts internally) | Fits standard interface; `worldToCanvas(screenToWorld(S)) = S` |
| Pan IS a tool in registry | Real toolbar button, works like other tools |
| `canStartMMBPan()` helper | Clean check for MMB pan availability |
| SelectTool hover in `move()` | No external `updateHoverCursor()` call |
| `onPointerLeave()` method | Unified interface, no type guards |
| `onViewChange()` method | Unified interface, no type guards |
| `capturePointer()` / `releasePointer()` | Module-level helpers, no `this.baseCanvas?` |
| `updatePresenceCursor()` / `clearPresenceCursor()` | Clean presence updates |

---

## Implementation Order

1. Add helpers to `camera-store.ts` (capturePointer, releasePointer)
2. Add helpers to `room-runtime.ts` (updatePresenceCursor, clearPresenceCursor)
3. Add `PointerTool` interface to `types.ts`
4. Rewrite `PanTool.ts` with screen-space interface
5. Update `SelectTool.ts` (move hover into `move()`, rename `clearHover`)
6. Update `EraserTool.ts` (rename `clearHover`)
7. Update `DrawingTool.ts` / `TextTool.ts` (add no-ops)
8. Create `tool-registry.ts`
9. Update `OverlayRenderLoop.ts` (self-manage preview)
10. Create `InputManager.ts`
11. Create `CanvasRuntime.ts`
12. Simplify `Canvas.tsx`
13. Run `npm run typecheck`

---

## Success Criteria

1. **Canvas.tsx < 100 lines**
2. **No special casing** - no `if (tool === 'select')`, no type guards
3. **Pan IS a tool** - in registry, uses world coords (converts internally)
4. **Unified PointerTool interface** - all tools implement all methods
5. **Module-level helpers** - no `this.baseCanvas?`, clean presence updates
6. **No eraser seeding** - removed
7. **MMB pan via helper** - `canStartMMBPan()` for clean checks
8. **All tests pass** - `npm run typecheck`
