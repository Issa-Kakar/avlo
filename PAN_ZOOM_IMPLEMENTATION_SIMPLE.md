# Pan/Zoom Implementation Guide (Simplified Architecture)

## Executive Summary

This guide implements pan and zoom functionality for the AVLO whiteboard using a **simplified, bulletproof architecture**. After reverting a complex implementation that suffered from mid-gesture teardowns and cursor flickering, we're adopting a minimal approach focused on stability.

### Core Principles (Non-Negotiable)

1. **OS Cursors Only**: No DOM HUD, no pulse rings, no timers. Use native `crosshair`, `grab`, and `grabbing` cursors.
2. **No Mid-Gesture Teardown**: Event handlers read from refs; no unstable dependencies in effects.
3. **MMB Blocked During Strokes**: Middle-mouse-button pan is completely ignored when `tool.isActive()` returns true.
4. **Wheel Zoom Works Mid-Stroke**: Users can zoom while drawing/erasing without interrupting the gesture.
5. **Split Effect Responsibilities**: One effect for mount-once listeners, one for tool lifecycle.

### What We're Building

- **Wheel zoom-to-cursor**: Smooth zoom anchored at pointer position (~9% per tick)
- **MMB pan (transient)**: Middle-mouse drag pans without changing active tool
- **Zoom buttons**: UI controls that zoom to/from viewport center
- **Fit-to-content**: Button to frame all content with padding
- **Optional smooth animation**: Exponential approach for buttery zoom

### What We're NOT Building

- ❌ DOM HUD with glass morphism
- ❌ Pulse rings or animated cursors
- ❌ Debounce timers (source of stuck states)
- ❌ Complex cursor state machines

---

## Current State Analysis

### Canvas.tsx Architecture (Post-Revert)

**File**: `/home/issak/dev/avlo/client/src/canvas/Canvas.tsx`

**Current Structure:**
```typescript
// Lines 1-174: Imports, setup, refs, snapshot subscription
const Canvas = React.forwardRef(() => {
  // Refs
  const baseStageRef, overlayStageRef, editorHostRef
  const toolRef, snapshotRef, viewTransformRef, canvasSizeRef
  const renderLoopRef, overlayLoopRef

  // Transform from context
  const { transform: viewTransform } = useViewTransform();

  // Store refs
  useLayoutEffect(() => {
    viewTransformRef.current = viewTransform; // Keep ref updated
  }, [viewTransform]);

  // Coordinate helpers (PROBLEM: worldToClient has unstable deps)
  const screenToWorld = useCallback(..., []); // ✅ Stable
  const worldToClient = useCallback(..., [viewTransform]); // ❌ UNSTABLE!

  // Render loops initialization (lines 294-437)
  useLayoutEffect(() => { /* base render loop */ }, []);
  useLayoutEffect(() => { /* overlay render loop */ }, [roomDoc]);

  // THE MONSTER EFFECT (lines 443-692) - NEEDS SPLITTING
  useEffect(() => {
    // Tool creation based on activeTool
    // Event listeners (down, move, up, cancel, leave)
    // Cleanup
  }, [
    roomDoc, userId, activeTool, pen, highlighter, eraser, text,
    stageReady,
    screenToWorld,    // ✅ Stable
    worldToClient,    // ❌ UNSTABLE - recreated every pan/zoom!
  ]);

  // Transform change notifier (lines 695-706)
  useEffect(() => {
    // Invalidate loops on transform change
  }, [viewTransform.scale, viewTransform.pan.x, viewTransform.pan.y]);
});
```

### The Root Cause of Previous Failure

**Lines 256-270** - The Smoking Gun:
```typescript
const worldToClient = useCallback(
  (worldX: number, worldY: number): [number, number] => {
    // ... implementation ...
  },
  [viewTransform], // ❌ THIS IS THE KILLER
);
```

**Impact Chain:**
1. User scrolls wheel → `viewTransform` updates (new object)
2. `worldToClient` function recreated (new reference)
3. Monster effect sees dependency change → **FULL TEARDOWN**:
   - Releases pointer capture (mid-gesture!)
   - Destroys active tool
   - Clears preview provider
   - Removes all event listeners
4. Effect re-runs, recreates everything
5. **But the gesture is already broken** (pointer capture lost, tool destroyed)

### ViewTransformContext (Currently Stable)

**File**: `/home/issak/dev/avlo/client/src/canvas/ViewTransformContext.tsx`

```typescript
interface ViewState {
  scale: number;  // 1.0 = 100% zoom
  pan: { x: number; y: number }; // World offset in WORLD UNITS
}

const ViewTransformContext = createContext<{
  viewState: ViewState;
  transform: ViewTransform;
  setScale: (scale: number) => void;      // ✅ Stable (useCallback with empty deps)
  setPan: (pan: Point) => void;           // ✅ Stable (useCallback with empty deps)
  resetView: () => void;
}>(...);

// Transform object (recreated on every state change - expected)
const transform = useMemo<ViewTransform>(
  () => ({
    worldToCanvas: (x, y) => [(x - pan.x) * scale, (y - pan.y) * scale],
    canvasToWorld: (x, y) => [x / scale + pan.x, y / scale + pan.y],
    scale,
    pan,
  }),
  [viewState.scale, viewState.pan]
);
```

**Key Facts:**
- `setScale` and `setPan` are stable (empty deps)
- `transform` object is **intentionally unstable** (recreated on state changes)
- Clamps are applied in setters (MIN_ZOOM=0.01, MAX_ZOOM=5.0, MAX_PAN_DISTANCE=1,000,000)

### Transform Utilities (Already Exists)

**File**: `/home/issak/dev/avlo/client/src/canvas/internal/transforms.ts`

```typescript
// Already implemented:
export function clampScale(scale: number): number;
export function calculateZoomTransform(
  currentScale: number,
  currentPan: Point,
  zoomFactor: number,
  zoomCenter: Point, // Canvas CSS pixels
): { scale: number; pan: Point };

export function getVisibleWorldBounds(...): Bounds;
export function applyViewTransform(ctx, scale, pan): void;
```

**Critical: Transform Math**
```
// Authoritative equations:
worldToCanvas: [(x - pan.x) * scale, (y - pan.y) * scale]
canvasToWorld: [x / scale + pan.x, y / scale + pan.y]

// Context transform order (for rendering):
ctx.scale(scale, scale);
ctx.translate(-pan.x, -pan.y);
```

### Tool Architecture (Polymorphic)

**All tools implement the same interface:**
```typescript
type PointerTool = DrawingTool | EraserTool | TextTool;

interface PointerToolMethods {
  canBegin(): boolean;
  begin(pointerId: number, worldX: number, worldY: number): void;
  move(worldX: number, worldY: number): void;
  end(worldX?: number, worldY?: number): void;
  cancel(): void;
  isActive(): boolean;
  getPointerId(): number | null;
  getPreview(): PreviewData | null;
  destroy(): void;
  clearHover?(): void; // Optional (EraserTool)
}
```

**Tool State Management:**
- DrawingTool: `state.isDrawing` tracks gesture
- EraserTool: `state.isErasing` tracks gesture
- TextTool: State machine (idle → placing → editing)

**Critical for MMB Blocking:**
```typescript
// We'll call this before allowing MMB pan:
if (toolRef.current?.isActive()) {
  return; // Block MMB when tool has active gesture
}
```

---

## Implementation Plan

### Phase 0: Fix the Unstable Dependencies (CRITICAL)

**Goal**: Make `worldToClient` stable to prevent effect re-runs during pan/zoom.

**File**: `client/src/canvas/Canvas.tsx`

#### Step 0.1: Fix worldToClient Dependencies

**Location**: Lines 256-270

**Change**:
```typescript
// BEFORE (UNSTABLE):
const worldToClient = useCallback(
  (worldX: number, worldY: number): [number, number] => {
    if (!baseStageRef.current) return [worldX, worldY];
    const [canvasX, canvasY] = viewTransform.worldToCanvas(worldX, worldY); // ❌ Closure
    const rect = baseStageRef.current.getBounds();
    return [canvasX + rect.left, canvasY + rect.top];
  },
  [viewTransform], // ❌ Recreates on every transform change
);

// AFTER (STABLE):
const worldToClient = useCallback(
  (worldX: number, worldY: number): [number, number] => {
    const stage = baseStageRef.current;
    const transform = viewTransformRef.current; // ✅ Read from ref!
    if (!stage || !transform) return [worldX, worldY];

    const [canvasX, canvasY] = transform.worldToCanvas(worldX, worldY);
    const rect = stage.getBounds();
    return [canvasX + rect.left, canvasY + rect.top];
  },
  [], // ✅ EMPTY DEPS - stable function
);
```

**Why This Works:**
- Function reference never changes → no effect re-runs
- Always reads latest transform from ref → correct values
- No stale closures

#### Step 0.2: Verify screenToWorld is Already Stable

**Location**: Lines 237-252

**Current Code** (already correct):
```typescript
const screenToWorld = useCallback((clientX: number, clientY: number): [number, number] | null => {
  const canvas = baseStageRef.current?.getCanvasElement();
  const transform = viewTransformRef.current; // ✅ Read from ref
  if (!canvas || !transform) {
    console.warn('Cannot convert coordinates: canvas or transform not ready');
    return null;
  }

  const rect = canvas.getBoundingClientRect();
  const canvasX = clientX - rect.left;
  const canvasY = clientY - rect.top;

  return transform.canvasToWorld(canvasX, canvasY);
}, []); // ✅ Empty deps - already stable
```

**No changes needed** - this is the correct pattern.

---

### Phase 1: Split the Monster Effect

**Goal**: Separate mount-once event listeners from tool lifecycle to prevent listener churn.

**File**: `client/src/canvas/Canvas.tsx`

#### Architecture Decision

**Current (Bad)**:
```
Single useEffect [roomDoc, activeTool, ..., worldToClient] {
  - Create tool
  - Set preview provider
  - Attach event listeners
  - Return cleanup (tears down EVERYTHING on any dep change)
}
```

**New (Good)**:
```
Effect A [stageReady] { // Mount-once
  - Attach event listeners (read everything from refs)
  - Return: remove listeners ONLY
}

Effect B [roomDoc, activeTool, pen, ...] { // Tool lifecycle
  - Create tool
  - Set preview provider
  - Set cursor style
  - Return: destroy tool, clear provider ONLY
}
```

#### Step 1.1: Create Effect A - Mount-Once Listeners

**Location**: Insert BEFORE line 443 (before current monster effect)

```typescript
// EFFECT A: Mount-once event listeners
// CRITICAL: No transform dependencies - handlers read from refs
useEffect(() => {
  const canvas = baseStageRef.current?.getCanvasElement();
  if (!canvas || !stageReady) return;

  // Mobile detection (same logic as before)
  const isMobile =
    /Android|webOS|iPhone|iPad|iPod/i.test(navigator.userAgent) || navigator.maxTouchPoints > 1;

  // ========== MMB Pan Gesture State (transient) ==========
  // Stored in closure - recreated only when stageReady changes (once)
  let panGesture: {
    pointerId: number;
    startPan: { x: number; y: number };
    startClient: { x: number; y: number };
    startScale: number;
  } | null = null;

  // ========== POINTER EVENT HANDLERS ==========
  // Read all dynamic state from refs - no closures over changing values

  const handlePointerDown = (e: PointerEvent) => {
    if (isMobile) return;

    // BRANCH 1: Transient MMB pan gesture
    // CRITICAL: Check MMB FIRST, before tool logic
    if (e.button === 1 && e.pointerType === 'mouse') {
      // CRITICAL: Block MMB if tool has active stroke
      const tool = toolRef.current;
      if (tool?.isActive()) {
        return; // Ignore MMB completely during drawing/erasing
      }

      e.preventDefault();
      canvas.setPointerCapture(e.pointerId);

      // Set OS cursor to grabbing
      canvas.style.cursor = 'grabbing';

      // Read LATEST transform from ref
      const v = viewTransformRef.current;
      if (!v) return;

      panGesture = {
        pointerId: e.pointerId,
        startPan: { ...v.pan },
        startClient: { x: e.clientX, y: e.clientY },
        startScale: v.scale,
      };
      return; // Exit - don't touch tool
    }

    // BRANCH 2: Normal tool interaction
    const tool = toolRef.current;
    if (!tool?.canBegin()) return;

    // Use the STABLE screenToWorld helper (reads from ref internally)
    const worldCoords = screenToWorld(e.clientX, e.clientY);
    if (!worldCoords) return;

    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);

    tool.begin(e.pointerId, worldCoords[0], worldCoords[1]);
    roomDoc.updateActivity('drawing');
  };

  const handlePointerMove = (e: PointerEvent) => {
    // Track last mouse position for tool seeding (eraser keyboard shortcut)
    lastMouseClientRef.current = { x: e.clientX, y: e.clientY };

    // BRANCH 1: MMB pan in progress
    if (panGesture && panGesture.pointerId === e.pointerId) {
      const dx = e.clientX - panGesture.startClient.x;
      const dy = e.clientY - panGesture.startClient.y;

      // Pan formula: pan = startPan - delta / startScale
      const newPan = {
        x: panGesture.startPan.x - dx / panGesture.startScale,
        y: panGesture.startPan.y - dy / panGesture.startScale,
      };

      // Get stable setters from context (they don't recreate)
      const { setPan } = useViewTransform(); // ❌ WAIT - this won't work in closure!
      // FIX: We need to get setPan/setScale from refs too
      setPan(newPan);

      // Update awareness cursor during pan (desktop only)
      if (!isMobile) {
        const worldCoords = screenToWorld(e.clientX, e.clientY);
        if (worldCoords) {
          roomDoc.updateCursor(worldCoords[0], worldCoords[1]);
        }
      }

      return; // Don't update tool during MMB pan
    }

    // BRANCH 2: Normal movement (awareness + tool)
    if (!isMobile) {
      const worldCoords = screenToWorld(e.clientX, e.clientY);
      if (worldCoords) {
        roomDoc.updateCursor(worldCoords[0], worldCoords[1]);

        const tool = toolRef.current;
        if (tool) {
          tool.move(worldCoords[0], worldCoords[1]);
        }
      }
    }
  };

  const handlePointerUp = (e: PointerEvent) => {
    // BRANCH 1: MMB pan end
    if (panGesture && panGesture.pointerId === e.pointerId) {
      try {
        canvas.releasePointerCapture(e.pointerId);
      } catch {}

      // Restore cursor based on active tool
      const tool = toolRef.current;
      // Read activeTool from deviceUI store? Or track in ref? Need to solve this.
      canvas.style.cursor = 'crosshair'; // Simplified for now
      panGesture = null;
      return;
    }

    // BRANCH 2: Tool gesture end
    const tool = toolRef.current;
    if (!tool?.isActive() || e.pointerId !== tool.getPointerId()) return;

    try {
      canvas.releasePointerCapture(e.pointerId);
    } catch {}

    const worldCoords = screenToWorld(e.clientX, e.clientY);
    tool.end(worldCoords?.[0], worldCoords?.[1]);
    roomDoc.updateActivity('idle');
  };

  const handlePointerCancel = (e: PointerEvent) => {
    // MMB pan cancel
    if (panGesture && panGesture.pointerId === e.pointerId) {
      try {
        canvas.releasePointerCapture(e.pointerId);
      } catch {}
      canvas.style.cursor = 'crosshair';
      panGesture = null;
      return;
    }

    // Tool cancel
    const tool = toolRef.current;
    if (!tool || e.pointerId !== tool.getPointerId()) return;

    try {
      canvas.releasePointerCapture(e.pointerId);
    } catch {}

    tool.cancel();
    roomDoc.updateActivity('idle');
  };

  const handleLostPointerCapture = (e: PointerEvent) => {
    // MMB pan lost
    if (panGesture && panGesture.pointerId === e.pointerId) {
      canvas.style.cursor = 'crosshair';
      panGesture = null;
    }

    // Tool lost
    const tool = toolRef.current;
    if (tool && e.pointerId === tool.getPointerId()) {
      tool.cancel();
      roomDoc.updateActivity('idle');
    }
  };

  const handlePointerLeave = () => {
    roomDoc.updateCursor(undefined, undefined);

    const tool = toolRef.current;
    if (tool && 'clearHover' in tool) {
      (tool as any).clearHover();
    }
  };

  // ========== WHEEL ZOOM HANDLER ==========

  const handleWheel = (e: WheelEvent) => {
    e.preventDefault();

    // Block wheel during MMB pan to avoid scale conflicts
    if (panGesture) return;

    // OPTIONAL: Block wheel during active tool gesture
    // const tool = toolRef.current;
    // if (tool?.isActive()) return;

    const rect = canvas.getBoundingClientRect();
    const canvasX = e.clientX - rect.left;
    const canvasY = e.clientY - rect.top;

    // Normalize wheel delta to standard "steps"
    let deltaY = e.deltaY;
    if (e.deltaMode === 1) deltaY *= 40;
    else if (e.deltaMode === 2) deltaY *= 800;
    const steps = deltaY / 120;

    // Calculate zoom factor (~9% per step)
    const ZOOM_STEP = Math.log(1.09);
    const factor = Math.exp(-steps * ZOOM_STEP);

    // Read LATEST transform from ref
    const v = viewTransformRef.current;
    if (!v) return;

    const { scale: targetScale, pan: targetPan } = calculateZoomTransform(
      v.scale,
      v.pan,
      factor,
      { x: canvasX, y: canvasY }
    );

    // Apply directly (smooth animation in later phase)
    // Need access to setScale/setPan - solve in next step
    setScale(targetScale);
    setPan(targetPan);
  };

  // Prevent Windows autoscroll circle on MMB
  const handleAuxClick = (e: MouseEvent) => {
    if (e.button === 1) {
      e.preventDefault();
    }
  };

  // ========== ATTACH LISTENERS ==========
  canvas.addEventListener('pointerdown', handlePointerDown, { passive: false });
  canvas.addEventListener('pointermove', handlePointerMove, { passive: false });
  canvas.addEventListener('pointerup', handlePointerUp, { passive: false });
  canvas.addEventListener('pointercancel', handlePointerCancel, { passive: false });
  canvas.addEventListener('lostpointercapture', handleLostPointerCapture, { passive: false });
  canvas.addEventListener('pointerleave', handlePointerLeave, { passive: false });
  canvas.addEventListener('wheel', handleWheel, { passive: false });
  canvas.addEventListener('auxclick', handleAuxClick, { passive: false });

  // ========== CLEANUP - LISTENERS ONLY ==========
  return () => {
    canvas.removeEventListener('pointerdown', handlePointerDown);
    canvas.removeEventListener('pointermove', handlePointerMove);
    canvas.removeEventListener('pointerup', handlePointerUp);
    canvas.removeEventListener('pointercancel', handlePointerCancel);
    canvas.removeEventListener('lostpointercapture', handleLostPointerCapture);
    canvas.removeEventListener('pointerleave', handlePointerLeave);
    canvas.removeEventListener('wheel', handleWheel);
    canvas.removeEventListener('auxclick', handleAuxClick);
  };
}, [stageReady]); // ONLY re-run when stage becomes ready (once)
```

**PROBLEM SPOTTED**: Handler closures can't access `setScale`/`setPan` from context without creating new handlers.

**SOLUTION**: Store setters in refs too!

```typescript
// Add near line 168:
const setScaleRef = useRef<(scale: number) => void>();
const setPanRef = useRef<(pan: Point) => void>();

// After getting context (line 135):
const { transform: viewTransform, setScale, setPan } = useViewTransform();

// Update refs in layout effect:
useLayoutEffect(() => {
  viewTransformRef.current = viewTransform;
  setScaleRef.current = setScale;
  setPanRef.current = setPan;
}, [viewTransform, setScale, setPan]);

// In handlers, use:
setScaleRef.current?.(targetScale);
setPanRef.current?.(targetPan);
```

#### Step 1.2: Create Effect B - Tool Lifecycle

**Location**: REPLACE the current monster effect (lines 443-692)

```typescript
// EFFECT B: Tool lifecycle
// Recreates tool only when activeTool or config changes
// Does NOT include transform helpers in deps
useEffect(() => {
  // Special handling for text tool config changes during editing
  if (activeTool === 'text' && toolRef.current?.isActive()) {
    const textTool = toolRef.current as any;
    if ('updateConfig' in textTool) {
      textTool.updateConfig(text);
      return;
    }
  }

  const renderLoop = renderLoopRef.current;
  const canvas = baseStageRef.current?.getCanvasElement();
  const initialTransform = viewTransformRef.current;

  if (!renderLoop || !canvas || !roomDoc || !initialTransform) {
    if (import.meta.env.DEV) {
      console.debug('Tool waiting for dependencies:', {
        renderLoop: !!renderLoop,
        canvas: !!canvas,
        room: !!roomDoc,
        viewTransform: !!initialTransform,
      });
    }
    return;
  }

  const isMobile =
    /Android|webOS|iPhone|iPad|iPod/i.test(navigator.userAgent) || navigator.maxTouchPoints > 1;

  // Create tool based on activeTool (same logic as before)
  let tool: PointerTool | null = null;

  if (activeTool === 'eraser') {
    tool = new EraserTool(
      roomDoc,
      eraser,
      userId,
      () => overlayLoopRef.current?.invalidateAll(),
      () => {
        const size = canvasSizeRef.current;
        if (size) return { cssWidth: size.cssWidth, cssHeight: size.cssHeight, dpr: size.dpr };
        return { cssWidth: 1, cssHeight: 1, dpr: 1 };
      },
      () => viewTransformRef.current,
    );
  } else if (activeTool === 'pen' || activeTool === 'highlighter') {
    const settings = activeTool === 'pen' ? pen : highlighter;
    tool = new DrawingTool(
      roomDoc,
      settings,
      activeTool,
      userId,
      (_bounds) => overlayLoopRef.current?.invalidateAll(),
      () => overlayLoopRef.current?.invalidateAll(),
      () => viewTransformRef.current,
    );
  } else if (activeTool === 'text') {
    tool = new TextTool(
      roomDoc,
      text,
      userId,
      {
        worldToClient, // ✅ Now stable from Step 0.1
        getView: () => viewTransformRef.current,
        getEditorHost: () => editorHostRef.current,
      },
      () => overlayLoopRef.current?.invalidateAll(),
    );
  } else {
    return; // Unsupported tool
  }

  toolRef.current = tool;

  // Set preview provider
  if (!isMobile && overlayLoopRef.current) {
    overlayLoopRef.current.setPreviewProvider({
      getPreview: () => tool?.getPreview() || null,
    });
  }

  // Set OS cursor based on tool
  canvas.style.cursor = activeTool === 'eraser' ? 'none' : 'crosshair';

  // Seed eraser preview if switching to eraser via keyboard
  if (!isMobile && activeTool === 'eraser' && lastMouseClientRef.current) {
    const { x, y } = lastMouseClientRef.current;
    const world = screenToWorld(x, y);
    if (world) {
      tool.move(world[0], world[1]);
    }
  }

  // ========== CLEANUP - TOOL ONLY ==========
  return () => {
    const pointerId = tool?.getPointerId();
    if (pointerId !== null) {
      try {
        canvas.releasePointerCapture(pointerId);
      } catch {}
    }
    tool?.cancel();
    tool?.destroy();
    toolRef.current = undefined;
    overlayLoopRef.current?.setPreviewProvider(null);
  };
}, [
  roomDoc,
  userId,
  activeTool,
  pen,
  highlighter,
  eraser,
  text,
  stageReady,
  screenToWorld,  // ✅ Stable (empty deps)
  worldToClient,  // ✅ NOW stable (empty deps from Step 0.1)
  // REMOVED: setScale, setPan (not needed here)
]);
```

---

### Phase 2: Add Zoom Helpers

**Goal**: Create helper functions for zoom operations.

**File**: `client/src/canvas/internal/zoom-helpers.ts` (NEW)

```typescript
import type { Snapshot } from '@avlo/shared';
import { clampScale } from './transforms';

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function getContentBounds(snapshot: Snapshot): Bounds | null {
  if (snapshot.strokes.length === 0 && snapshot.texts.length === 0) {
    // Check for base board in meta (if implemented)
    const meta = snapshot.meta as any;
    if (meta?.canvas) {
      return {
        minX: 0,
        minY: 0,
        maxX: meta.canvas.baseW,
        maxY: meta.canvas.baseH,
      };
    }
    return null;
  }

  let minX = Infinity, minY = Infinity;
  let maxX = -Infinity, maxY = -Infinity;

  for (const stroke of snapshot.strokes) {
    minX = Math.min(minX, stroke.bbox[0]);
    minY = Math.min(minY, stroke.bbox[1]);
    maxX = Math.max(maxX, stroke.bbox[2]);
    maxY = Math.max(maxY, stroke.bbox[3]);
  }

  for (const text of snapshot.texts) {
    minX = Math.min(minX, text.x);
    minY = Math.min(minY, text.y);
    maxX = Math.max(maxX, text.x + text.w);
    maxY = Math.max(maxY, text.y + text.h);
  }

  return { minX, minY, maxX, maxY };
}

export function fitToContent(
  bounds: Bounds,
  viewportWidth: number,
  viewportHeight: number,
  padding: number = 64,
): { scale: number; pan: { x: number; y: number } } {
  const contentWidth = bounds.maxX - bounds.minX + padding * 2;
  const contentHeight = bounds.maxY - bounds.minY + padding * 2;

  const scaleX = viewportWidth / contentWidth;
  const scaleY = viewportHeight / contentHeight;
  const scale = clampScale(Math.min(scaleX, scaleY));

  const worldCenterX = (bounds.minX + bounds.maxX) / 2;
  const worldCenterY = (bounds.minY + bounds.maxY) / 2;

  const canvasCenterX = viewportWidth / 2;
  const canvasCenterY = viewportHeight / 2;

  const pan = {
    x: worldCenterX - canvasCenterX / scale,
    y: worldCenterY - canvasCenterY / scale,
  };

  return { scale, pan };
}
```

---

### Phase 3: Add Zoom Buttons Integration

**Goal**: Make zoom buttons use viewport-centered zoom.

**File**: `client/src/canvas/Canvas.tsx`

Add zoom API methods (after coordinate helpers, around line 287):

```typescript
// Zoom API for UI controls (viewport-centered)
// CRITICAL: No dependencies - reads from refs
const zoomToViewportCenter = useCallback((factor: number) => {
  const stage = baseStageRef.current;
  if (!stage) return;

  const rect = stage.getBounds();
  const centerX = rect.width / 2;
  const centerY = rect.height / 2;

  // Read LATEST transform from ref
  const v = viewTransformRef.current;
  if (!v) return;

  const { scale: newScale, pan: newPan } = calculateZoomTransform(
    v.scale,
    v.pan,
    factor,
    { x: centerX, y: centerY },
  );

  // Apply directly (or via animator in Phase 7)
  setScaleRef.current?.(newScale);
  setPanRef.current?.(newPan);
}, []); // Empty deps - uses refs

const fitToViewport = useCallback(() => {
  const stage = baseStageRef.current;
  if (!stage || !roomDoc) return;

  const snapshot = roomDoc.currentSnapshot;
  const bounds = getContentBounds(snapshot);

  if (!bounds) {
    // No content, reset to origin
    setScaleRef.current?.(1);
    setPanRef.current?.({ x: 0, y: 0 });
    return;
  }

  const rect = stage.getBounds();
  const { scale, pan } = fitToContent(bounds, rect.width, rect.height);

  setScaleRef.current?.(scale);
  setPanRef.current?.(pan);
}, []); // Empty deps - uses refs
```

**File**: `client/src/pages/components/ZoomControls.tsx`

Update to use the new API via context or imperative handle.

---

### Phase 4: Initial View Setup (Optional)

**Goal**: Position viewport on first load.

**File**: `client/src/canvas/Canvas.tsx`

Add after render loop initialization:

```typescript
// Set initial view on first mount
useEffect(() => {
  if (!stageReady || !roomDoc) return;

  const stage = baseStageRef.current;
  if (!stage) return;

  const snapshot = roomDoc.currentSnapshot;
  const hasContent = snapshot.strokes.length > 0 || snapshot.texts.length > 0;

  const rect = stage.getBounds();
  const v = viewTransformRef.current;
  if (!v) return;

  if (hasContent) {
    // Fit to content
    const bounds = getContentBounds(snapshot);
    if (bounds) {
      const { scale, pan } = fitToContent(bounds, rect.width, rect.height);
      setScaleRef.current?.(scale);
      setPanRef.current?.(pan);
    }
  } else {
    // Center origin in viewport
    const centerPan = {
      x: 0 - (rect.width / 2) / v.scale,
      y: 0 - (rect.height / 2) / v.scale,
    };
    setPanRef.current?.(centerPan);
  }
}, [stageReady]); // Only on first mount
```

---

### Phase 5: Smooth Zoom Animation 

**Goal**: Add buttery-smooth zoom with exponential approach.

**File**: `client/src/canvas/animation/ZoomAnimator.ts` (NEW)

```typescript
import { clampScale } from '../canvas/internal/transforms';

export class ZoomAnimator {
  private active = false;
  private rafId: number | null = null;
  private targetScale = 1;
  private targetPan = { x: 0, y: 0 };
  private lastTime = 0;

  constructor(
    private getView: () => { scale: number; pan: { x: number; y: number } },
    private setScale: (scale: number) => void,
    private setPan: (pan: { x: number; y: number }) => void,
  ) {}

  to(targetScale: number, targetPan: { x: number; y: number }) {
    this.targetScale = clampScale(targetScale);
    this.targetPan = targetPan;

    if (!this.active) {
      this.active = true;
      this.lastTime = performance.now();
      this.rafId = requestAnimationFrame(this.tick);
    }
  }

  private tick = (now: number) => {
    const dt = Math.min(0.05, (now - this.lastTime) / 1000);
    this.lastTime = now;

    const v = this.getView();

    // Exponential approach
    const ZOOM_DAMPING = 18; // ~120ms half-life
    const alpha = 1 - Math.exp(-ZOOM_DAMPING * dt);

    const scale = v.scale + (this.targetScale - v.scale) * alpha;
    const pan = {
      x: v.pan.x + (this.targetPan.x - v.pan.x) * alpha,
      y: v.pan.y + (this.targetPan.y - v.pan.y) * alpha,
    };

    this.setScale(scale);
    this.setPan(pan);

    // Check convergence
    const scaleClose = Math.abs(scale - this.targetScale) / this.targetScale < 0.001;
    const panClose = Math.hypot(pan.x - this.targetPan.x, pan.y - this.targetPan.y) < 0.01;

    if (!scaleClose || !panClose) {
      this.rafId = requestAnimationFrame(this.tick);
    } else {
      this.setScale(this.targetScale);
      this.setPan(this.targetPan);
      this.active = false;
      this.rafId = null;
    }
  };

  destroy() {
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.active = false;
  }
}
```

**Integration** in Canvas.tsx:

```typescript
// Add ref
const zoomAnimatorRef = useRef<ZoomAnimator | null>(null);

// Initialize in useEffect
useEffect(() => {
  zoomAnimatorRef.current = new ZoomAnimator(
    () => viewTransformRef.current,
    (s) => setScaleRef.current?.(s),
    (p) => setPanRef.current?.(p),
  );

  return () => {
    zoomAnimatorRef.current?.destroy();
  };
}, []);

// Use in wheel handler and zoom buttons:
const { scale: targetScale, pan: targetPan } = calculateZoomTransform(...);
zoomAnimatorRef.current?.to(targetScale, targetPan);
```

---

## Critical Implementation Rules

### Dependency Array Discipline

**NEVER include these in effect deps:**
- ❌ `viewTransform` (object recreated every state change)
- ❌ `transform` (same as above)
- ❌ Any function that depends on transform
- ❌ `setScale`/`setPan` unless already stable

**ALWAYS safe to include:**
- ✅ `stageReady` (boolean)
- ✅ `roomDoc` (stable from hook)
- ✅ `activeTool`, `pen`, `highlighter`, `eraser`, `text` (Zustand selectors)
- ✅ `userId` (stable from useState)
- ✅ `screenToWorld` (empty deps)
- ✅ `worldToClient` (after Phase 0 fix - empty deps)

### Cursor Management (Simplified)

**OS Cursor Mapping:**
```typescript
// Drawing tools (pen/highlighter)
canvas.style.cursor = 'crosshair';

// Eraser tool
canvas.style.cursor = 'none'; // Eraser ring drawn in overlay

// MMB pan active
canvas.style.cursor = 'grabbing';

// Pan tool idle (if implemented)
canvas.style.cursor = 'grab';

// Pan tool dragging
canvas.style.cursor = 'grabbing';
```

**No timers, no state machines, no DOM overlays.**

### Transform Reading Pattern

```typescript
// ✅ CORRECT - Read from ref in handlers/closures
const handleWheel = (e: WheelEvent) => {
  const v = viewTransformRef.current; // Always fresh
  if (!v) return;
  // Use v.scale, v.pan
};

// ❌ WRONG - Capture from closure
const handleWheel = useCallback((e) => {
  const { scale, pan } = viewTransform; // Stale!
}, [viewTransform]); // Recreates every zoom!
```

### MMB Blocking Logic

```typescript
// In handlePointerDown, check tool BEFORE starting MMB pan:
if (e.button === 1 && e.pointerType === 'mouse') {
  const tool = toolRef.current;
  if (tool?.isActive()) {
    return; // CRITICAL: Ignore MMB completely
  }
  // ... start pan gesture
}
```

---

## Testing Checklist

### Phase 0 Validation
- [ ] Canvas renders normally after worldToClient fix
- [ ] Tools still work (pen, highlighter, eraser, text)
- [ ] No console errors about transforms

### Phase 1 Validation (After Split)
- [ ] Tool creation still works
- [ ] Drawing/erasing still works
- [ ] Tool switching still works
- [ ] Cursor changes appropriately
- [ ] No "effect ran twice" issues

### Wheel Zoom
- [ ] Wheel up zooms in, wheel down zooms out
- [ ] World point under cursor stays fixed
- [ ] Can zoom while drawing (stroke continues)
- [ ] Can zoom while erasing (erase continues)
- [ ] Zoom clamps at MIN/MAX limits
- [ ] Trackpad pinch works (ctrlKey + wheel)

### MMB Pan
- [ ] MMB drag pans viewport
- [ ] Cursor changes to `grabbing` during drag
- [ ] **CRITICAL**: MMB ignored when drawing/erasing
- [ ] Tool cursor returns after MMB release
- [ ] Awareness cursor updates during MMB pan
- [ ] Windows autoscroll circle doesn't appear

### Cursor Stability
- [ ] Crosshair stays visible during wheel zoom
- [ ] Eraser ring stays visible during wheel zoom
- [ ] No cursor flicker during any operation
- [ ] Cursor hides during MMB pan
- [ ] Cursor returns immediately after MMB release

### Zoom Buttons
- [ ] Plus button zooms to viewport center
- [ ] Minus button zooms from viewport center
- [ ] Percentage label updates correctly
- [ ] Fit button fits content with padding

### Edge Cases
- [ ] Rapid wheel events don't cause drift
- [ ] MMB during tool drag doesn't break tool
- [ ] Transform limits respected (pan clamp)
- [ ] Mobile remains view-only
- [ ] No memory leaks on tool switching

---

## Migration Steps (From Current State)

### Step-by-Step Execution

1. **Commit current working state** (pre-refactor safety)

2. **Apply Phase 0** (Fix worldToClient)
   - Change deps from `[viewTransform]` to `[]`
   - Add `viewTransformRef` read inside function
   - Test: verify tools still work

3. **Add refs for setters**
   - Create `setScaleRef`, `setPanRef`
   - Update in layout effect
   - Test: verify state still updates

4. **Split the monster effect**
   - Create Effect A (listeners) with `[stageReady]` deps
   - Create Effect B (tool) with existing deps minus helpers
   - **CRITICAL**: Move ALL pointer handlers to Effect A
   - Test: verify tools still work, listeners attach

5. **Add wheel handler** to Effect A
   - Implement handleWheel
   - Test: verify zoom works

6. **Add MMB handlers** to Effect A
   - Implement MMB pan gesture
   - Add blocking logic for tool.isActive()
   - Test: verify MMB pan works, blocking works

7. **Add zoom helpers**
   - Create zoom-helpers.ts
   - Add zoomToViewportCenter
   - Test: verify button zoom works

8. **Wire up UI controls**
   - Update ZoomControls component
   - Add fit-to-content button
   - Test: verify all buttons work

9. **(Optional) Add smooth animation**
   - Create ZoomAnimator class
   - Integrate in Canvas
   - Test: verify smooth zoom

---

## Known Issues & Limitations

### Current Limitations

1. **Pan tool not implemented**: Guide focuses on MMB pan (transient gesture)
2. **No minimap**: Deferred per OVERVIEW.MD
3. **No zoom indicator HUD**: Simplified approach uses OS cursors only

### Why This Works Better

**Previous approach** (failed):
- DOM HUD with pulse animations
- 180ms debounce timers
- Complex cursor state machine
- Transform-dependent helpers in effect deps
- Result: **Mid-gesture teardown**

**New approach** (bulletproof):
- OS cursors only (no timers)
- Stable helpers (empty deps)
- Split effects (listeners vs tool lifecycle)
- MMB blocking when tool active
- Result: **Rock-solid gestures**

---

## Appendix: File Checklist

### Files to Modify (3)
1. `client/src/canvas/Canvas.tsx` - Main changes
2. `client/src/canvas/ViewTransformContext.tsx` - No changes needed (already stable)
3. `client/src/pages/components/ZoomControls.tsx` - Wire to new API

### Files to Create (2)
1. `client/src/canvas/internal/zoom-helpers.ts` - Content bounds, fit
2. `client/src/canvas/animation/ZoomAnimator.ts` - (Optional) Smooth zoom

### Files Already Correct (No Changes)
1. `client/src/canvas/internal/transforms.ts` - Math helpers already exist
2. `client/src/lib/tools/DrawingTool.ts` - Tool interface stable
3. `client/src/lib/tools/EraserTool.ts` - Tool interface stable
4. `client/src/renderer/RenderLoop.ts` - Event-driven invalidation works
5. `client/src/renderer/OverlayRenderLoop.ts` - Preview rendering works

---


