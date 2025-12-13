# Phase 2B: Tool Registry & Preview Provider Coupling

**STATUS:** Implementation Plan - Ready for Execution
**DEPENDS ON:** Phase 2A (CanvasStage Elimination) ✅ Complete
**BRANCH:** `refactor/canvas-runtime-phase1`

---

## Executive Summary

This phase creates the **tool-registry.ts** module with self-constructing tool singletons and couples the preview provider directly to the overlay render loop. This eliminates per-render tool construction in Canvas.tsx and establishes the foundation for CanvasRuntime.

**Key Outcomes:**
1. Tools become true singletons (constructed once at module load)
2. OverlayRenderLoop self-manages preview via tool-registry import
3. Canvas.tsx stops constructing tools on activeTool change
4. Overlay invalidates on tool switch (subscription pattern)
5. MMB pan uses panTool singleton directly (no more mmbPanRef duplication)

---

## Current State Analysis

### Canvas.tsx Pain Points (~740 lines)

| Problem | Lines | Solution |
|---------|-------|----------|
| Tool construction on every activeTool change | ~60 lines | Use tool-registry singletons |
| mmbPanRef duplicating PanTool state | ~25 lines | Use panTool.begin/move/end directly |
| suppressToolPreviewRef | ~10 lines | Remove (panTool.isActive() check sufficient) |
| activeToolRef | ~5 lines | Remove (read from store) |
| Manual previewProvider wiring | ~15 lines | OverlayRenderLoop self-manages |
| lastMouseClientRef for eraser seeding | ~10 lines | Keep temporarily, move later |
| Tool-specific event handling branches | ~80 lines | Simplify with unified interface |

### Tool Interface Analysis

All tools share this core interface (implicit, not typed):

```typescript
interface PointerTool {
  canBegin(): boolean;
  begin(pointerId: number, worldX: number, worldY: number, ...extra?: any[]): void;
  move(worldX: number, worldY: number): void;
  end(worldX?: number, worldY?: number): void;
  cancel(): void;
  isActive(): boolean;
  getPointerId(): number | null;
  getPreview(): PreviewData | null;
  destroy(): void;
}
```

**Tool-Specific Extensions:**
- `PanTool.updatePan(clientX, clientY)` - screen delta panning
- `TextTool.onViewChange()` / `EraserTool.onViewChange()` - DOM repositioning
- `SelectTool.updateHoverCursor(worldX, worldY)` - cursor state
- `TextTool.updateConfig()` - live config updates (legacy)

---

## Implementation Plan

### Step 1: Create PointerTool Interface Type

**File:** `client/src/lib/tools/types.ts`

Add explicit interface to unify tool typing:

```typescript
/**
 * PointerTool - Common interface for all pointer-based tools.
 * All tools implement this interface for polymorphic dispatch.
 */
export interface PointerTool {
  /** Check if tool can start a new gesture */
  canBegin(): boolean;

  /** Start a gesture with pointer ID and world coordinates */
  begin(pointerId: number, worldX: number, worldY: number, clientX?: number, clientY?: number): void;

  /** Update during pointer movement */
  move(worldX: number, worldY: number): void;

  /** End the gesture (with optional final coordinates) */
  end(worldX?: number, worldY?: number): void;

  /** Cancel the gesture */
  cancel(): void;

  /** Check if gesture is in progress */
  isActive(): boolean;

  /** Get the active pointer ID (null if idle) */
  getPointerId(): number | null;

  /** Get preview data for overlay rendering (null if none) */
  getPreview(): PreviewData | null;

  /** Cleanup resources */
  destroy(): void;
}

/**
 * Optional methods that some tools implement.
 * Use type guards: `if ('onViewChange' in tool) { ... }`
 */
export interface ViewChangeHandler {
  onViewChange(): void;
}

export interface HoverHandler {
  clearHover?(): void;
  updateHoverCursor?(worldX: number, worldY: number): void;
}
```

### Step 2: Create tool-registry.ts

**File:** `client/src/canvas/tool-registry.ts`

```typescript
/**
 * Tool Registry - Self-constructing tool singletons
 *
 * Tools are constructed ONCE at module load time, not per-gesture.
 * CanvasRuntime and OverlayRenderLoop import this module to access tools.
 *
 * Key exports:
 * - getCurrentTool(): Active tool from device-ui-store
 * - getToolById(id): Tool lookup
 * - getActivePreview(): Preview from current tool
 * - panTool: Direct export for MMB handling
 *
 * @module canvas/tool-registry
 */

import { DrawingTool } from '@/lib/tools/DrawingTool';
import { EraserTool } from '@/lib/tools/EraserTool';
import { TextTool } from '@/lib/tools/TextTool';
import { PanTool } from '@/lib/tools/PanTool';
import { SelectTool } from '@/lib/tools/SelectTool';
import { useDeviceUIStore, type Tool as ToolId } from '@/stores/device-ui-store';
import type { PointerTool, PreviewData } from '@/lib/tools/types';

// ===========================================
// SINGLETONS - Construct at module load time
// ===========================================

const drawingTool = new DrawingTool();
const eraserTool = new EraserTool();
const textTool = new TextTool();
const panTool = new PanTool();
const selectTool = new SelectTool();

// ===========================================
// LOOKUP TABLE
// ===========================================

/** Map tool IDs to singleton instances */
const toolMap = new Map<ToolId, PointerTool>([
  ['pen', drawingTool],
  ['highlighter', drawingTool],  // Same tool, different mode
  ['shape', drawingTool],        // Same tool, shape mode
  ['eraser', eraserTool],
  ['text', textTool],
  ['pan', panTool],
  ['select', selectTool],
]);

// ===========================================
// EXPORTS
// ===========================================

/**
 * Get tool singleton by ID.
 * Returns undefined for unsupported tools (image, code).
 */
export function getToolById(toolId: ToolId): PointerTool | undefined {
  return toolMap.get(toolId);
}

/**
 * Get the currently active tool from device-ui-store.
 * Returns undefined if active tool has no pointer implementation.
 */
export function getCurrentTool(): PointerTool | undefined {
  const { activeTool } = useDeviceUIStore.getState();
  return toolMap.get(activeTool);
}

/**
 * Get preview data from the currently active tool.
 * Returns null if no active tool or no preview.
 */
export function getActivePreview(): PreviewData | null {
  const tool = getCurrentTool();
  return tool?.getPreview() ?? null;
}

/**
 * Get the currently active tool ID from device-ui-store.
 */
export function getActiveToolId(): ToolId {
  return useDeviceUIStore.getState().activeTool;
}

/**
 * Check if any tool gesture is currently active.
 * Useful for blocking operations during gestures.
 */
export function isAnyToolActive(): boolean {
  const tool = getCurrentTool();
  return tool?.isActive() ?? false;
}

// ===========================================
// DIRECT EXPORTS for special access
// ===========================================

/** Export panTool directly for MMB pan handling */
export { panTool };

/** Export all tools for testing/debugging */
export const allTools = {
  drawingTool,
  eraserTool,
  textTool,
  panTool,
  selectTool,
} as const;
```

### Step 3: Update OverlayRenderLoop for Self-Managed Preview

**File:** `client/src/renderer/OverlayRenderLoop.ts`

**Changes:**
1. Import `getActivePreview` from tool-registry
2. Subscribe to device-ui-store for activeTool changes
3. Remove setPreviewProvider() method
4. Replace previewProvider.getPreview() with getActivePreview()

```typescript
// NEW IMPORTS
import { getActivePreview, getActiveToolId } from '@/canvas/tool-registry';
import { useDeviceUIStore } from '@/stores/device-ui-store';

export class OverlayRenderLoop {
  // REMOVE: private previewProvider: PreviewProvider | null = null;
  private toolUnsubscribe: (() => void) | null = null;
  // ... rest of existing fields ...

  start(config: OverlayLoopConfig = {}) {
    this.config = config;
    this.eraserTrail = [];

    // Subscribe to camera store (existing)
    this.cameraUnsubscribe = useCameraStore.subscribe(/* ... existing ... */);

    // NEW: Subscribe to tool changes for invalidation
    this.toolUnsubscribe = useDeviceUIStore.subscribe(
      (state) => state.activeTool,
      () => {
        // Tool switched - invalidate to update preview
        this.cachedPreview = null;
        this.holdPreviewOneFrame = false;
        this.invalidateAll();
      }
    );
  }

  stop() {
    this.cameraUnsubscribe?.();
    this.cameraUnsubscribe = null;
    this.toolUnsubscribe?.();  // NEW
    this.toolUnsubscribe = null;  // NEW
    // ... rest of existing cleanup ...
  }

  // REMOVE: setPreviewProvider() method entirely

  private frame() {
    // ... existing setup ...

    // REPLACE:
    // const preview = this.previewProvider?.getPreview();
    // WITH:
    const preview = getActivePreview();

    // ... rest of existing frame logic unchanged ...
  }

  destroy() {
    this.cameraUnsubscribe?.();
    this.cameraUnsubscribe = null;
    this.toolUnsubscribe?.();  // NEW
    this.toolUnsubscribe = null;  // NEW
    this.stop();
    // REMOVE: this.previewProvider = null;
  }
}
```

### Step 4: Update Canvas.tsx

**Changes:**
1. Import from tool-registry instead of individual tools
2. Remove toolRef and tool construction logic
3. Remove previewProvider wiring
4. Update event handlers to use getCurrentTool()
5. Unify MMB pan with panTool singleton
6. Remove mmbPanRef, suppressToolPreviewRef, activeToolRef

```typescript
// REPLACE imports
// BEFORE:
import { DrawingTool } from '@/lib/tools/DrawingTool';
import { EraserTool } from '@/lib/tools/EraserTool';
// ... etc

// AFTER:
import {
  getCurrentTool,
  getActiveToolId,
  panTool,
  isAnyToolActive,
} from './tool-registry';
import type { PointerTool } from '@/lib/tools/types';

// REMOVE these refs:
// - toolRef
// - mmbPanRef
// - suppressToolPreviewRef
// - activeToolRef

// KEEP for now (will move to CanvasRuntime later):
// - lastMouseClientRef (eraser seeding)
// - zoomAnimatorRef

// REMOVE this entire useEffect that constructs tools:
// The one with `activeTool`, `textSize`, `textColor` dependencies

// ADD simpler effect for eraser seeding on tool switch:
useLayoutEffect(() => {
  const toolId = getActiveToolId();

  // Seed eraser preview with last known mouse position
  if (toolId === 'eraser' && lastMouseClientRef.current) {
    const { x, y } = lastMouseClientRef.current;
    const world = cameraScreenToWorld(x, y);
    if (world) {
      const tool = getCurrentTool();
      tool?.move(world[0], world[1]);
    }
  }

  // Reset cursor on tool switch
  setCursorOverride(null);
}, [useDeviceUIStore((s) => s.activeTool)]);
```

### Step 5: Unified MMB Pan with panTool Singleton

**In Canvas.tsx event handlers:**

```typescript
// BEFORE (in handlePointerDown):
if (e.button === 1) {
  e.preventDefault();
  if (toolRef.current?.isActive()) return;
  // ... mmbPanRef setup ...
  mmbPanRef.current = { active: true, pointerId: e.pointerId, lastClient: {...} };
  setCursorOverride('grabbing');
  suppressToolPreviewRef.current = true;
  // ...
}

// AFTER:
if (e.button === 1) {
  e.preventDefault();

  // Block if tool gesture is active
  if (isAnyToolActive()) return;

  // Block if pan already in progress (could be from pan tool mode)
  if (panTool.isActive()) return;

  const canvas = baseCanvasRef.current;
  if (!canvas) return;
  canvas.setPointerCapture(e.pointerId);

  const world = cameraScreenToWorld(e.clientX, e.clientY);
  if (!world) return;

  // Use panTool directly!
  panTool.begin(e.pointerId, world[0], world[1], e.clientX, e.clientY);
  return;
}

// BEFORE (in handlePointerMove):
if (mmbPanRef.current.active && e.pointerId === mmbPanRef.current.pointerId) {
  // ... manual pan math ...
}

// AFTER:
if (panTool.isActive() && panTool.getPointerId() === e.pointerId) {
  panTool.updatePan(e.clientX, e.clientY);
  return;
}

// BEFORE (in handlePointerUp):
if (mmbPanRef.current.active && e.pointerId === mmbPanRef.current.pointerId) {
  // ... cleanup mmbPanRef ...
}

// AFTER:
if (panTool.isActive() && panTool.getPointerId() === e.pointerId) {
  try {
    baseCanvasRef.current?.releasePointerCapture(e.pointerId);
  } catch { /* ignore */ }
  panTool.end();
  return;
}
```

### Step 6: Remove roomDoc.updateActivity() Calls

**In Canvas.tsx event handlers:**

```typescript
// REMOVE all instances of:
roomDoc.updateActivity('drawing');
roomDoc.updateActivity('idle');
roomDoc.updateActivity('typing');

// The TextTool still calls updateActivity internally for its DOM editor.
// Leave that for now - will be removed when TextTool is replaced.
```

### Step 7: Remove isMobile Checks from Canvas.tsx

```typescript
// REMOVE all instances of:
const isMobile = /Android|webOS|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
                 navigator.maxTouchPoints > 1;
if (isMobile) return;

// Mobile detection is cached in camera-store.ts isMobile()
// But we're removing the guards entirely - they block development iteration.
// If mobile support is needed, add proper touch handling later.
```

### Step 8: Update Tool View Change Subscription

Keep this for TextTool/EraserTool DOM repositioning, but simplify:

```typescript
// Keep this effect but update to use getCurrentTool():
useEffect(() => {
  const unsubscribe = useCameraStore.subscribe(
    (state) => ({ scale: state.scale, panX: state.pan.x, panY: state.pan.y }),
    () => {
      const tool = getCurrentTool();
      if (tool && 'onViewChange' in tool) {
        (tool as any).onViewChange?.();
      }
    },
    { equalityFn: (a, b) => a.scale === b.scale && a.panX === b.panX && a.panY === b.panY }
  );
  return unsubscribe;
}, []);
```

---

## File Changes Summary

### New Files

| File | Purpose |
|------|---------|
| `client/src/canvas/tool-registry.ts` | Self-constructing tool singletons |

### Modified Files

| File | Changes |
|------|---------|
| `client/src/lib/tools/types.ts` | Add PointerTool interface |
| `client/src/renderer/OverlayRenderLoop.ts` | Self-managed preview, tool switch subscription |
| `client/src/canvas/Canvas.tsx` | Use tool-registry, unify MMB pan, remove refs |

### Lines Removed (Estimated)

| Item | Lines |
|------|-------|
| Tool construction logic | ~60 |
| mmbPanRef and handling | ~25 |
| suppressToolPreviewRef | ~10 |
| activeToolRef | ~5 |
| previewProvider wiring | ~15 |
| isMobile checks | ~20 |
| roomDoc.updateActivity calls | ~5 |
| **Total** | **~140** |

**Canvas.tsx after Phase 2B:** ~600 lines (down from ~740)

---

## Testing Checklist

1. **Tool Singletons:**
   - [ ] Hot reload doesn't create duplicate tool instances
   - [ ] Tool state persists across tool switches (not reset)
   - [ ] DrawingTool correctly handles pen/highlighter/shape modes

2. **Preview Provider:**
   - [ ] Preview updates immediately on tool switch
   - [ ] Preview clears when switching to tool with no preview
   - [ ] Eraser trail continues animating during use

3. **MMB Pan:**
   - [ ] MMB pan works identically to before
   - [ ] Can't start MMB pan while tool gesture active
   - [ ] Can't start tool gesture while MMB pan active
   - [ ] Cursor shows 'grabbing' during MMB pan

4. **Tool Switch:**
   - [ ] Eraser preview shows immediately on switch (seeded from last mouse pos)
   - [ ] Cursor updates correctly on switch
   - [ ] No flash/flicker on tool switch

5. **Regression:**
   - [ ] All existing tool behaviors work as before
   - [ ] No console errors/warnings
   - [ ] `npm run typecheck` passes

---

## Commands

```bash
# Type check
npm run typecheck

# Manual testing (if permitted)
npm run dev
```

---

## Success Criteria

1. ✅ `tool-registry.ts` created with singleton pattern
2. ✅ `PointerTool` interface defined in types.ts
3. ✅ OverlayRenderLoop imports `getActivePreview()` directly
4. ✅ OverlayRenderLoop subscribes to tool changes
5. ✅ `setPreviewProvider()` method removed
6. ✅ Canvas.tsx uses `getCurrentTool()` instead of toolRef
7. ✅ `mmbPanRef` removed, using `panTool` singleton
8. ✅ `suppressToolPreviewRef` removed
9. ✅ `activeToolRef` removed
10. ✅ `isMobile` checks removed from Canvas.tsx
11. ✅ `roomDoc.updateActivity()` calls removed from Canvas.tsx
12. ✅ All tests pass

---

## Future Phases (Not This PR)

### Phase 2C: CanvasRuntime.ts

After tool-registry is complete, create CanvasRuntime as the central orchestrator:

```typescript
class CanvasRuntime {
  private surfaceManager: SurfaceManager | null = null;
  private renderLoop: RenderLoop | null = null;
  private overlayLoop: OverlayRenderLoop | null = null;
  private zoomAnimator: ZoomAnimator | null = null;
  private inputManager: InputManager | null = null;

  start(config: { baseCanvas: HTMLCanvasElement; overlayCanvas: HTMLCanvasElement }): void;
  stop(): void;

  // Event handling (called by InputManager)
  handlePointerDown(e: PointerEvent): void;
  handlePointerMove(e: PointerEvent): void;
  handlePointerUp(e: PointerEvent): void;
  handlePointerCancel(e: PointerEvent): void;
  handlePointerLeave(e: PointerEvent): void;
  handleLostPointerCapture(e: PointerEvent): void;
  handleWheel(e: WheelEvent): void;
}
```

### Phase 2D: InputManager.ts

Dumb DOM event layer:

```typescript
class InputManager {
  constructor(runtime: CanvasRuntime);
  attach(): void;  // Add event listeners to canvas from getCanvasElement()
  detach(): void;  // Remove event listeners
}
```

### Phase 2E-F: Move Event Handling & Final Cleanup

- Move all event handler logic from Canvas.tsx to CanvasRuntime
- Canvas.tsx becomes ~100-150 lines (just mounts DOM, creates runtime)

---

## Long-Term Considerations

### Render Controller Proposal

For future optimization, consider a unified **RenderController** that:

1. **Owns both render loops** instead of CanvasRuntime
2. **Handles all invalidation triggers:**
   - Viewport/transform changes (already subscribed in loops)
   - Snapshot changes with viewport culling
   - Presence updates with visibility checks
3. **Manages animation coordination:**
   - ZoomAnimator
   - Eraser trail (currently in OverlayRenderLoop)
   - Future animations
4. **Optimizes presence rendering:**
   - Skip frame scheduling if no visible cursors
   - Exclude self-cursor
   - Viewport cull presence before invalidating

### Tool State Machine Unification

All tools internally track `isActive()` state. Consider:

1. Explicit `ToolPhase` type per tool (some already have this)
2. Unified `getPhase()` method returning discriminated union
3. Move all cursor logic into tools (not scattered in Canvas.tsx)
4. Make `onViewChange()` required method with default no-op

### Eraser Trail Extraction

The eraser trail animation lives in OverlayRenderLoop but should probably be:

1. Extracted to separate `EraserTrailAnimator` class
2. Owned by RenderController or CanvasRuntime
3. Only runs when eraser is active
4. Cleaner separation of concerns

---

## References

- `CANVAS_RUNTIME_END_GOAL.md` - Master architecture vision
- `REFACTOR_STATE.md` - Progress tracking
- `CLAUDE.md` - Codebase documentation
