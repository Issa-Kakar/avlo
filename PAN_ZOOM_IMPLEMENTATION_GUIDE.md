# Pan/Zoom Implementation Guide for AVLO Whiteboard

## Executive Summary

This guide provides a comprehensive, step-by-step implementation plan for adding pan and zoom functionality to the AVLO whiteboard. The implementation includes wheel zoom-to-cursor, middle-mouse-button (MMB) pan, zoom UI buttons that anchor to viewport center, initial view centering, fit-to-content, and a persistent pan tool.

### Key Features to Implement
1. **Wheel zoom-to-cursor**: Zoom anchored at cursor position with smooth animation
2. **MMB pan**: Transient pan gesture without changing active tool
3. **Zoom buttons**: Fixed-step zoom anchored at viewport center
4. **Initial view**: Board top-center positioned in viewport, or fit-to-content if content exists
5. **Fit-to-content**: Button to fit all content in viewport with padding
6. **Pan tool**: Persistent pan mode selectable from toolbar
7. **Smooth animations**: Exponential approach for buttery-smooth zoom

### Architecture Summary
- **Transform Math**: `canvas = (world - pan) × scale` (pan is in world units)
- **DPR Handling**: Applied only in CanvasStage, transparent to transform logic
- **Event-driven Rendering**: Transform changes auto-invalidate render loops
- **Tool Architecture**: MMB pan is gesture-based (not tool-based) to avoid teardown
- **Awareness Updates**: Presence cursor updates on every pointermove including during MMB pan

### Transform Limits & Clamps
- Zoom is clamped globally by `clampScale()` to `MIN_ZOOM=0.01, MAX_ZOOM=5.0`.
- Pan is clamped centrally in `ViewTransformContext.setPan` to
  `±PERFORMANCE_CONFIG.MAX_PAN_DISTANCE` (currently **1,000,000**).
- Handlers/tools SHOULD NOT re-clamp. Always call `setPan`/`setScale` and let the context clamp.
- **Edge behavior:** if a zoom-to-cursor or pan tween computes a pan beyond the clamp,
  `setPan` will clamp it; the world point may no longer stay perfectly anchored to the
  cursor near the extremes (expected).

---

## Cursor System Architecture

### Overview
The cursor system provides visual feedback during pan/zoom operations through either CSS cursors (fallback) or a DOM-based HUD (preferred). This system operates independently of tool state to prevent teardown during transient gestures.

### Cursor Mode Types
```typescript
export type CursorMode =
  | 'hidden'              // OS cursor hidden (eraser shows ring, or HUD active)
  | 'default'             // crosshair or standard cursor
  | 'pan-idle'            // open hand (hover state for pan tool)
  | 'pan-active'          // closed hand (dragging with pan tool or MMB)
  | 'zoom-in-pulse'       // wheel up: shows + indicator with pulse animation
  | 'zoom-out-pulse';     // wheel down: shows - indicator with pulse animation
```

### Canvas-Local Cursor State
```typescript
// In Canvas.tsx - local state to avoid tool rebuilds
const cursorModeRef = useRef<CursorMode>('default');
const cursorDebounceRef = useRef<number | null>(null);

const setCursorMode = (mode: CursorMode) => {
  cursorModeRef.current = mode;
  updateCanvasCursor(mode);

  // Notify HUD if mounted (optional DOM overlay)
  if (cursorHudRef.current) {
    cursorHudRef.current.setMode(mode);
  }
};

const updateCanvasCursor = (mode: CursorMode) => {
  const canvas = baseStageRef.current?.getCanvasElement();
  if (!canvas) return;

  // When HUD is active, hide OS cursor
  const hudActive = mode !== 'default' && mode !== 'pan-idle';

  if (hudActive) {
    canvas.style.cursor = 'none';
  } else if (mode === 'pan-idle') {
    canvas.style.cursor = 'grab';
  } else if (mode === 'pan-active') {
    canvas.style.cursor = 'grabbing';
  } else if (activeTool === 'eraser') {
    canvas.style.cursor = 'none'; // Eraser shows its own ring
  } else {
    canvas.style.cursor = 'crosshair';
  }
};
```

### DOM HUD Implementation (Optional but Recommended)
```typescript
// cursor-hud/CursorHud.tsx
interface CursorHudProps {
  mode: CursorMode;
  position: { x: number; y: number }; // Client coordinates
  enabled: boolean;
}

export const CursorHud: React.FC<CursorHudProps> = ({ mode, position, enabled }) => {
  if (!enabled || mode === 'default') return null;

  return (
    <div
      className={`cursor-hud cursor-hud--${mode}`}
      style={{
        transform: `translate(${position.x}px, ${position.y}px)`,
        pointerEvents: 'none',
        position: 'fixed',
        zIndex: 10000
      }}
    >
      {/* SVG icons for different modes */}
      {mode === 'pan-idle' && <HandOpenIcon />}
      {mode === 'pan-active' && <HandClosedIcon />}
      {mode === 'zoom-in-pulse' && <ZoomInIcon />}
      {mode === 'zoom-out-pulse' && <ZoomOutIcon />}
    </div>
  );
};
```

### CSS Fallback (When HUD is Disabled)
```css
/* cursor.css - Image cursor fallbacks */
.canvas-cursor-pan-idle {
  cursor: url('/cursors/hand-open-32.png') 16 16, grab;
}

.canvas-cursor-pan-active {
  cursor: url('/cursors/hand-closed-32.png') 16 16, grabbing;
}

/* Respect reduced motion */
@media (prefers-reduced-motion: reduce) {
  .cursor-hud {
    animation: none !important;
    transition: none !important;
  }

  /* Use system cursors as fallback */
  .canvas-cursor-pan-idle {
    cursor: grab;
  }

  .canvas-cursor-pan-active {
    cursor: grabbing;
  }
}
```

---

## Phase 1: Wheel Zoom-to-Cursor Implementation

### Objective
Enable mild-adaptive mouse wheel/trackpad zoom that keeps the world point under the cursor fixed in place.

### Files to Modify
- `/home/issak/dev/avlo/client/src/canvas/Canvas.tsx`

### Implementation Steps

#### 1.1 Add Wheel Event Handler (Mild-Adaptive)

In Canvas.tsx, add after line 636 (after handlePointerLeave):

```typescript
// Wheel zoom handler with mild-adaptive normalization and zoom-to-cursor math
// NOTE: Do not add dependencies - read from refs to avoid stale closures
const handleWheel = (e: WheelEvent) => {
  e.preventDefault(); // Prevent browser scroll

  // Block wheel during MMB pan to avoid scale conflicts
  if (panGestureRef.current) return;

  const stage = baseStageRef.current;
  if (!stage) return;

  // Get cursor position in canvas CSS pixels
  const rect = stage.getBounds(); // Returns CSS client rect
  const canvasX = e.clientX - rect.left;
  const canvasY = e.clientY - rect.top;

  // Normalize wheel delta to standard "steps"
  let deltaY = e.deltaY;
  if (e.deltaMode === 1) deltaY *= 40; // lines to pixels
  else if (e.deltaMode === 2) deltaY *= 800; // pages to pixels
  const steps = deltaY / 120; // Standard wheel step

  // Calculate zoom factor with mild-adaptive behavior
  // ~9% per step provides smooth device-friendly zoom for mice and trackpads
  const ZOOM_STEP = Math.log(1.09); // Mild-adaptive: 8-12% per tick
  const factor = Math.exp(-steps * ZOOM_STEP);

  // Set cursor mode for visual feedback
  const pulse = steps < 0 ? 'zoom-in-pulse' : 'zoom-out-pulse';
  setCursorMode(pulse);

  // Clear existing debounce timer
  if (cursorDebounceRef.current) {
    window.clearTimeout(cursorDebounceRef.current);
  }

  // Revert cursor after 180ms
  cursorDebounceRef.current = window.setTimeout(() => {
    setCursorMode(activeTool === 'pan' ? 'pan-idle' : 'default');
    cursorDebounceRef.current = null;
  }, 180);

  // Read LATEST transform from ref (not closure)
  const v = viewTransformRef.current!;
  const { scale: targetScale, pan: targetPan } = calculateZoomTransform(
    v.scale,
    v.pan,
    factor,
    { x: canvasX, y: canvasY }
  );

  // If using smooth animation (Phase 7), call animator
  // Otherwise apply directly:
  setScale(targetScale);
  setPan(targetPan);
};
```

#### 1.2 Add Auxclick Handler (Prevent MMB Autoscroll)

```typescript
const handleAuxClick = (e: MouseEvent) => {
  if (e.button === 1) {
    e.preventDefault(); // Prevent Windows autoscroll circle
  }
};
```

#### 1.3 Attach Event Listeners

In the useEffect after line 655:

```typescript
canvas.addEventListener('wheel', handleWheel, { passive: false });
canvas.addEventListener('auxclick', handleAuxClick, { passive: false });
```

And in cleanup (after line 678):

```typescript
canvas.removeEventListener('wheel', handleWheel);
canvas.removeEventListener('auxclick', handleAuxClick);
```

#### 1.4 Import calculateZoomTransform

At the top of Canvas.tsx:

```typescript
import { calculateZoomTransform } from './internal/transforms';
```

### Expected Behavior
- Mouse wheel scrolling zooms in/out with mild-adaptive steps (~9% per tick)
- The world point under the cursor stays fixed during zoom (zoom-to-cursor invariant)
- Trackpad pinch gestures work (they emit wheel events with ctrlKey)
- Zoom is clamped to MIN_ZOOM (0.01) and MAX_ZOOM (5.0)

---

## Phase 2: MMB Pan Implementation (Transient Gesture)

### Objective
Enable middle-mouse-button drag to pan the viewport as a transient gesture that never changes the active tool.

### Files to Modify
- `/home/issak/dev/avlo/client/src/canvas/Canvas.tsx`

### Implementation Steps

#### 2.1 Add Pan Gesture State

After line 431 (before the tool creation effect):

```typescript
// MMB pan gesture state (transient, doesn't change activeTool)
const panGestureRef = useRef<{
  pointerId: number;
  startPan: { x: number; y: number };
  startClient: { x: number; y: number };
  startScale: number;
} | null>(null);
```

#### 2.2 Modify Pointer Event Handlers

Replace handlePointerDown (line 562) with:

```typescript
const handlePointerDown = (e: PointerEvent) => {
  // Canvas gates for mobile (not tool)
  if (isMobile) return;

  // BRANCH 1: Transient MMB pan gesture (check FIRST before tools)
  // IMPORTANT: This is a transient gesture - never changes activeTool
  if (e.button === 1 && e.pointerType === 'mouse') {
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);

    // Set cursor to pan-active (grabbing) for duration of gesture
    setCursorMode('pan-active');

    // Read current transform from ref to avoid stale closures
    const v = viewTransformRef.current!;

    panGestureRef.current = {
      pointerId: e.pointerId,
      startPan: { ...v.pan },
      startClient: { x: e.clientX, y: e.clientY },
      startScale: v.scale
    };
    return; // EXIT - don't create/destroy tools
  }

  // BRANCH 2: Existing tool logic
  if (!tool?.canBegin()) return;

  const worldCoords = screenToWorld(e.clientX, e.clientY);
  if (!worldCoords) return;

  e.preventDefault();
  canvas.setPointerCapture(e.pointerId);

  tool.begin(e.pointerId, worldCoords[0], worldCoords[1]);
  roomDoc.updateActivity('drawing');
};
```

Replace handlePointerMove (line 578) with:

```typescript
const handlePointerMove = (e: PointerEvent) => {
  // Track last mouse position for tool seeding
  lastMouseClientRef.current = { x: e.clientX, y: e.clientY };

  // BRANCH 1: MMB pan in progress
  const pg = panGestureRef.current;
  if (pg && pg.pointerId === e.pointerId) {
    const dx = e.clientX - pg.startClient.x;
    const dy = e.clientY - pg.startClient.y;

    // Pan formula: pan = startPan - delta / scale
    const newPan = {
      x: pg.startPan.x - dx / pg.startScale,
      y: pg.startPan.y - dy / pg.startScale
    };

    setPan(newPan);

    // Update awareness cursor with updated transform (desktop only)
    if (!isMobile) {
      const worldCoords = screenToWorld(e.clientX, e.clientY);
      if (worldCoords) {
        roomDoc.updateCursor(worldCoords[0], worldCoords[1]);
      }
    }

    return; // Don't update tool during pan
  }

  // BRANCH 2: Normal movement (awareness + tool)
  if (!isMobile) {
    const worldCoords = screenToWorld(e.clientX, e.clientY);
    if (worldCoords) {
      roomDoc.updateCursor(worldCoords[0], worldCoords[1]);

      if (tool) {
        tool.move(worldCoords[0], worldCoords[1]);
      }
    }
  }
};
```

Add MMB release logic to handlePointerUp (before line 597):

```typescript
// Helper function to determine cursor mode based on active tool
// IMPORTANT: This determines what cursor to show when NOT in a gesture
const getToolImpliedCursor = () => {
  if (activeTool === 'pan') return 'pan-idle'; // Open hand for pan tool
  if (activeTool === 'eraser') return 'hidden'; // Eraser shows its own ring
  return 'default'; // Crosshair for drawing tools
};

// Unified MMB pan end handler (transient gesture cleanup)
const endMMBPan = (e: PointerEvent) => {
  const pg = panGestureRef.current;
  if (!pg || pg.pointerId !== e.pointerId) return;

  try {
    canvas.releasePointerCapture(e.pointerId);
  } catch {}

  // CRITICAL: Restore cursor to tool-implied mode (not always 'default')
  setCursorMode(getToolImpliedCursor());
  panGestureRef.current = null;
};

const handlePointerUp = (e: PointerEvent) => {
  // BRANCH 1: MMB pan end
  if (panGestureRef.current?.pointerId === e.pointerId) {
    endMMBPan(e);
    return;
  }

  // BRANCH 2: Existing tool logic
  if (!tool?.isActive() || e.pointerId !== tool.getPointerId()) return;

  const worldCoords = screenToWorld(e.clientX, e.clientY);
  if (worldCoords) {
    tool.end(worldCoords[0], worldCoords[1]);
  } else {
    tool.end();
  }

  try {
    canvas.releasePointerCapture(e.pointerId);
  } catch {}

  roomDoc.updateActivity('idle');
};

// Also handle cancel and lost capture for proper cleanup
const handlePointerCancel = (e: PointerEvent) => {
  // Handle MMB pan cancel
  if (panGestureRef.current?.pointerId === e.pointerId) {
    endMMBPan(e);
    return;
  }

  // Handle tool cancel
  if (tool?.isActive() && e.pointerId === tool.getPointerId()) {
    tool.cancel();
    try {
      canvas.releasePointerCapture(e.pointerId);
    } catch {}
    roomDoc.updateActivity('idle');
  }
};

const handleLostPointerCapture = (e: PointerEvent) => {
  // Clean up MMB pan
  if (panGestureRef.current?.pointerId === e.pointerId) {
    setCursorMode(getToolImpliedCursor());
    panGestureRef.current = null;
  }

  // Clean up tool
  if (tool?.isActive() && e.pointerId === tool.getPointerId()) {
    tool.cancel();
    roomDoc.updateActivity('idle');
  }
};
```

### Expected Behavior
- Middle-mouse drag pans the viewport
- Cursor changes to 'grabbing' during pan
- Active tool remains unchanged
- Pan is in world units (smaller movements when zoomed in)
- Awareness cursor updates to reflect world position under pointer at all times

---

## Phase 3: Fix Zoom Buttons (Viewport Center Anchor)

### Objective
Make zoom buttons zoom to/from viewport center instead of world origin.

### Files to Modify
- `/home/issak/dev/avlo/client/src/canvas/Canvas.tsx`
- `/home/issak/dev/avlo/client/src/pages/components/ZoomControls.tsx`

### Implementation Steps

#### 3.1 Add Zoom API to Canvas

In Canvas.tsx, after the coordinate conversion functions (around line 270):

```typescript
// Zoom API for UI controls (viewport-centered)
// NOTE: No dependencies - read from refs to avoid stale closures
const zoomToViewportCenter = useCallback((factor: number) => {
  const stage = baseStageRef.current;
  if (!stage) return;

  const rect = stage.getBounds();
  const centerX = rect.width / 2;
  const centerY = rect.height / 2;

  // Read LATEST transform from ref
  const v = viewTransformRef.current!;
  const { scale: newScale, pan: newPan } = calculateZoomTransform(
    v.scale,
    v.pan,
    factor,
    { x: centerX, y: centerY }
  );

  // If using animator (Phase 7), call zoomAnimator.to(newScale, newPan)
  // Otherwise apply directly:
  setScale(newScale);
  setPan(newPan);
}, []); // Empty deps - uses refs

// Export via imperative handle or context
React.useImperativeHandle(ref, () => ({
  zoomToViewportCenter,
  // ... other methods
}), [zoomToViewportCenter]);
```

#### 3.2 Pass Zoom API to ZoomControls

Create a ZoomApiContext or pass via props:

```typescript
// In Canvas.tsx render
<ZoomApiContext.Provider value={{ zoomToViewportCenter }}>
  <ZoomControls />
</ZoomApiContext.Provider>
```

#### 3.3 Update ZoomControls to Use API

In ZoomControls.tsx:

Add [Fit] on the left and wire it to the shared fit helper (animated). Your implementation guide already lays out this step and a fitToViewport API that reads live transform from refs and computes {scale, pan} via fitToContent(...). Use that. 

Make the % label read-only (remove onClick={resetView}), keep it as the adaptive readout. That removes the reset affordance and matches your desired UI. (Right now the label does reset; we’re changing that.) 

Route +/− through a viewport-center zoom API, not raw setScale, so each click does zoom + derived pan (anchor-locked). You already documented a zoomToViewportCenter(factor) for this; have ZoomControls call it instead of directly multiplying the scale. 
Accessibility: keep aria-label/title on all buttons; set the % label to role="status" so AT users hear the zoom updates without it being a button.

```typescript
const { zoomToViewportCenter } = useZoomApi(); // or via props
const ZOOM_FACTOR = 1.25; // Better than 1.2 for clean percentages

const handleZoomIn = () => {
  zoomToViewportCenter(ZOOM_FACTOR);
};

const handleZoomOut = () => {
  zoomToViewportCenter(1 / ZOOM_FACTOR);
};
```

### Expected Behavior
- Zoom buttons now zoom to/from viewport center
- Content stays centered when using buttons
- 25% steps (100% → 125% → 156% → 195% → 244%)

---

## Phase 4: Initial View (Board Top-Center)

### Objective
Start with board's top-center positioned in viewport, or fit-to-content if content exists.

### Files to Modify
- `/home/issak/dev/avlo/client/src/canvas/Canvas.tsx`

### Implementation Steps

#### 4.1 Add Initial View Setup

In Canvas.tsx, add a new effect after the stage setup (around line 420):

```typescript
// Set initial view on first mount
useEffect(() => {
  if (!stageReady || !roomDoc) return;

  const stage = baseStageRef.current;
  if (!stage) return;

  const snapshot = roomDoc.currentSnapshot;
  const hasContent = snapshot.strokes.length > 0 || snapshot.texts.length > 0;

  const rect = stage.getBounds();
  const viewportWidth = rect.width;
  const viewportHeight = rect.height;

  // Get current transform from ref
  const v = viewTransformRef.current!;

  if (hasContent) {
    // Fit to content
    const bounds = getContentBounds(snapshot);
    if (bounds) {
      const { scale, pan } = fitToContent(bounds, viewportWidth, viewportHeight);
      setScale(scale);
      setPan(pan);
    }
  } else {
    // Position board's top-center in viewport
    // To put world point W at canvas center C: pan = W - C/scale

    const paddingTop = 64; // Small top margin for better visual

    // World point to position (board top-center)
    let worldAnchor = { x: 0, y: paddingTop }; // Default if no board

    // Check if meta.canvas exists (currently it doesn't in the codebase)
    const meta = snapshot.meta as any;
    if (meta?.canvas?.baseW && meta?.canvas?.baseH) {
      // Top-center of the base board
      worldAnchor = {
        x: meta.canvas.baseW / 2,
        y: paddingTop  // Small padding from top
      };
    }

    // Canvas center in CSS pixels
    const canvasCenter = {
      x: viewportWidth / 2,
      y: viewportHeight / 2
    };

    // Apply formula: pan = W - C/scale
    const centerPan = {
      x: worldAnchor.x - canvasCenter.x / v.scale,
      y: worldAnchor.y - canvasCenter.y / v.scale
    };

    setPan(centerPan);
  }
}, [stageReady]); // Only on first mount when stage becomes ready

// NOTE: meta.canvas is not currently populated by RoomDocManager
// To use board centering, you need to add this to the snapshot meta:
// meta.set('canvas', { baseW: 1920, baseH: 1080, padding: 64 });
```

#### 4.2 Add Helper Functions

```typescript
function getContentBounds(snapshot: Snapshot): Bounds | null {
  if (snapshot.strokes.length === 0 && snapshot.texts.length === 0) {
    // Check for base board
    const meta = snapshot.meta;
    if (meta?.canvas) {
      return {
        minX: 0,
        minY: 0,
        maxX: meta.canvas.baseW,
        maxY: meta.canvas.baseH
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

function fitToContent(
  bounds: Bounds,
  viewportWidth: number,
  viewportHeight: number,
  padding: number = 64  // Increased default padding for better visual
): { scale: number; pan: Point } {
  // Add padding to content dimensions
  const contentWidth = bounds.maxX - bounds.minX + padding * 2;
  const contentHeight = bounds.maxY - bounds.minY + padding * 2;

  // Calculate scale to fit content with padding
  const scaleX = viewportWidth / contentWidth;
  const scaleY = viewportHeight / contentHeight;
  const scale = clampScale(Math.min(scaleX, scaleY));

  // World center of content (without padding)
  const worldCenterX = (bounds.minX + bounds.maxX) / 2;
  const worldCenterY = (bounds.minY + bounds.maxY) / 2;

  // Canvas center in CSS pixels
  const canvasCenterX = viewportWidth / 2;
  const canvasCenterY = viewportHeight / 2;

  // Apply formula: To put world point W at canvas point C
  // pan = W - C / scale
  const pan = {
    x: worldCenterX - canvasCenterX / scale,
    y: worldCenterY - canvasCenterY / scale
  };

  return { scale, pan };
}
```

### Expected Behavior
- Empty canvas starts with board top-center positioned in viewport (content appears below)
- Canvas with content automatically fits content on load
- Subsequent joins remember their view state (if persisted)

---

## Phase 5: Fit-to-Content Button

### Objective
Add a button to fit all content in the viewport with padding.

### Files to Modify
- `/home/issak/dev/avlo/client/src/pages/components/ZoomControls.tsx`
- `/home/issak/dev/avlo/client/src/canvas/Canvas.tsx`

### Implementation Steps

#### 5.1 Add Fit Method to Canvas API

In Canvas.tsx:

```typescript
// NOTE: No dependencies - uses refs to avoid stale closures
const fitToViewport = useCallback(() => {
  const stage = baseStageRef.current;
  if (!stage || !roomDoc) return;

  const snapshot = roomDoc.currentSnapshot;
  const bounds = getContentBounds(snapshot);

  if (!bounds) {
    // No content, center world origin
    const rect = stage.getBounds();
    const v = viewTransformRef.current!;
    const centerPan = {
      x: 0 - (rect.width / 2) / v.scale,
      y: 0 - (rect.height / 2) / v.scale
    };
    setPan(centerPan);
    setScale(1); // Reset to 100%
    return;
  }

  const rect = stage.getBounds();
  const { scale, pan } = fitToContent(
    bounds,
    rect.width,
    rect.height
  );

  // If using animator (Phase 7), call zoomAnimator.to(scale, pan)
  // Otherwise apply directly:
  setScale(scale);
  setPan(pan);
}, []);
```

#### 5.2 Add Fit Button to ZoomControls

In ZoomControls.tsx:

```typescript
<button
  className="zoom-btn"
  onClick={fitToViewport}
  aria-label="Fit to content"
  title="Fit to Content"
>
  <svg className="icon icon-sm" viewBox="0 0 24 24">
    {/* Fit icon - four corners */}
    <path d="M5 5h4v2H7v2H5V5zm10 0h4v4h-2V7h-2V5zM5 15h2v2h2v2H5v-4zm14 0v4h-4v-2h2v-2h2z" />
  </svg>
</button>
```

### Expected Behavior
- Fit button calculates content bounds
- Zooms and pans to fit all content with padding
- Works with strokes, text, and base board
- Falls back to reset if no content

---

## Phase 6: Create Persistent PanTool

### Objective
Create a PanTool class for when user selects pan from toolbar.

### Files to Create
- `/home/issak/dev/avlo/client/src/lib/tools/PanTool.ts`

### Files to Modify
- `/home/issak/dev/avlo/client/src/canvas/Canvas.tsx`

### Implementation Steps

#### 6.1 Create PanTool Class

Create new file PanTool.ts:

```typescript
import type { IRoomDocManager } from '@avlo/shared';

export class PanTool {
  private isActive = false;
  private pointerId: number | null = null;
  private startPan: { x: number; y: number } | null = null;
  private startClient: { x: number; y: number } | null = null;
  private startScale: number = 1;

  constructor(
    private roomDoc: IRoomDocManager,
    private setPan: (pan: { x: number; y: number }) => void,
    private getView: () => { scale: number; pan: { x: number; y: number } },
    private setCursorMode?: (mode: CursorMode) => void
  ) {}

  canBegin(): boolean {
    return !this.isActive;
  }

  begin(pointerId: number, worldX: number, worldY: number): void {
    if (this.isActive) return;

    const view = this.getView();
    this.isActive = true;
    this.pointerId = pointerId;
    this.startPan = { ...view.pan };
    this.startScale = view.scale;

    // Set cursor to grabbing
    if (this.setCursorMode) {
      this.setCursorMode('pan-active');
    }

    // Store client position for drag calculation
    // Convert world back to screen for reference
    const canvasX = (worldX - view.pan.x) * view.scale;
    const canvasY = (worldY - view.pan.y) * view.scale;
    this.startClient = { x: canvasX, y: canvasY };
  }

  move(worldX: number, worldY: number): void {
    if (!this.isActive || !this.startPan || !this.startClient) return;

    const view = this.getView();
    const canvasX = (worldX - view.pan.x) * view.scale;
    const canvasY = (worldY - view.pan.y) * view.scale;

    const dx = canvasX - this.startClient.x;
    const dy = canvasY - this.startClient.y;

    // Pan formula: pan = startPan - delta / startScale
    const newPan = {
      x: this.startPan.x - dx / this.startScale,
      y: this.startPan.y - dy / this.startScale
    };

    this.setPan(newPan);
  }

  end(): void {
    this.isActive = false;
    this.pointerId = null;
    this.startPan = null;
    this.startClient = null;

    // Restore cursor to idle
    if (this.setCursorMode) {
      this.setCursorMode('pan-idle');
    }
  }

  cancel(): void {
    this.end();
  }

  isActive(): boolean {
    return this.isActive;
  }

  getPointerId(): number | null {
    return this.pointerId;
  }

  getPreview(): null {
    return null; // Pan tool has no preview
  }

  destroy(): void {
    this.cancel();
    // Reset cursor on destroy
    if (this.setCursorMode) {
      this.setCursorMode('default');
    }
  }
}
```

#### 6.2 Add PanTool to Canvas Tool Creation

In Canvas.tsx tool creation effect (around line 490):

```typescript
} else if (activeTool === 'pan') {
  tool = new PanTool(
    roomDoc,
    setPan,
    () => viewTransformRef.current,
    setCursorMode  // Pass cursor setter for drag state
  );

  // Set initial cursor to pan-idle (open hand)
  setCursorMode('pan-idle');
```

### Expected Behavior
- Selecting pan tool from toolbar activates persistent pan mode
- Left-click drag pans the viewport
- Cursor shows 'grab' when hovering, 'grabbing' when dragging
- Tool persists until user selects different tool

---

## Phase 7: Zoom Animation (Optional Polish)

### Objective
Add smooth animation to wheel zoom for buttery-smooth feel.

### Files to Modify
- `/home/issak/dev/avlo/client/src/canvas/Canvas.tsx`

### Implementation Steps

#### 7.1 Add Zoom Animator

After the pan gesture ref (line 432):

```typescript
// Zoom animation state
const zoomAnimRef = useRef<{
  rafId: number | null;
  currentScale: number;
  targetScale: number;
  anchorCanvas: { x: number; y: number };
  anchorWorld: { x: number; y: number };
  lastTime: number;
} | null>(null);
```

#### 7.2 Create Animation Loop

```typescript
// Better approach: Create a ZoomAnimator class instance
class ZoomAnimator {
  private active = false;
  private rafId: number | null = null;
  private targetScale = 1;
  private targetPan = { x: 0, y: 0 };
  private lastTime = 0;

  constructor(
    private getView: () => { scale: number; pan: { x: number; y: number } },
    private setScale: (scale: number) => void,
    private setPan: (pan: { x: number; y: number }) => void,
    private clampScale: (scale: number) => number
  ) {}

  to(targetScale: number, targetPan: { x: number; y: number }) {
    // Clamp and store targets
    this.targetScale = this.clampScale(targetScale);
    this.targetPan = targetPan;

    // Start animation if not running
    if (!this.active) {
      this.active = true;
      this.lastTime = performance.now();
      this.rafId = requestAnimationFrame(this.tick);
    }
  }

  private tick = (now: number) => {
    // Calculate dt with cap for tab switches
    const dt = Math.min(0.05, (now - this.lastTime) / 1000);
    this.lastTime = now;

    // Read CURRENT view from ref (critical: don't store local state)
    const v = this.getView();

    // Exponential approach with damping
    const ZOOM_DAMPING = 18; // ~120ms half-life
    const alpha = 1 - Math.exp(-ZOOM_DAMPING * dt);

    // Blend current toward target
    const scale = v.scale + (this.targetScale - v.scale) * alpha;
    const pan = {
      x: v.pan.x + (this.targetPan.x - v.pan.x) * alpha,
      y: v.pan.y + (this.targetPan.y - v.pan.y) * alpha
    };

    // Apply transforms (triggers Canvas effect → render invalidation)
    this.setScale(scale);
    this.setPan(pan);

    // Check if close enough to target
    const scaleClose = Math.abs(scale - this.targetScale) / this.targetScale < 0.001;
    const panClose = Math.hypot(
      pan.x - this.targetPan.x,
      pan.y - this.targetPan.y
    ) < 0.01;

    if (!scaleClose || !panClose) {
      this.rafId = requestAnimationFrame(this.tick);
    } else {
      // Snap to exact targets
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

// In Canvas.tsx, create the animator instance
const zoomAnimatorRef = useRef<ZoomAnimator | null>(null);

// Initialize on mount
useEffect(() => {
  zoomAnimatorRef.current = new ZoomAnimator(
    () => viewTransformRef.current!,
    setScale,
    setPan,
    clampScale
  );

  return () => {
    zoomAnimatorRef.current?.destroy();
  };
}, []); // Only on mount
```

#### 7.3 Update Handlers to Use Animation

Update the wheel handler to use the animator:

```typescript
// In handleWheel, replace direct setScale/setPan with:
const v = viewTransformRef.current!;
const { scale: targetScale, pan: targetPan } = calculateZoomTransform(
  v.scale,
  v.pan,
  factor,
  { x: canvasX, y: canvasY }
);

// Animate to target
zoomAnimatorRef.current?.to(targetScale, targetPan);
```

Similarly, update zoom buttons and fit-to-content:

```typescript
// In zoomToViewportCenter:
const { scale: targetScale, pan: targetPan } = calculateZoomTransform(
  v.scale,
  v.pan,
  factor,
  { x: centerX, y: centerY }
);
zoomAnimatorRef.current?.to(targetScale, targetPan);

// In fitToViewport:
const { scale, pan } = fitToContent(bounds, rect.width, rect.height);
zoomAnimatorRef.current?.to(scale, pan);
```

### Expected Behavior
- Wheel zoom smoothly animates over ~120-150ms
- Multiple wheel events coalesce (retarget during animation)
- Cursor stays perfectly locked to world point during animation
- No drift or wobble

### Hidden Tab Handling (Optional)

**Note:** The render loops already handle hidden tabs by throttling to ~8 FPS. Transform changes auto-invalidate both loops. This visibility handler is **completely optional** and only needed if you want deterministic state after tab switches.

```typescript
// OPTIONAL: Snap zoom animator to target when tab is hidden
// Only add this if you notice UX roughness resuming mid-zoom after long tab switches
useEffect(() => {
  const handleVisibilityChange = () => {
    if (document.hidden && zoomAnimatorRef.current?.active) {
      // Snap to target immediately for deterministic state
      zoomAnimatorRef.current?.snapToTarget();
    }
  };

  document.addEventListener('visibilitychange', handleVisibilityChange);
  return () => {
    document.removeEventListener('visibilitychange', handleVisibilityChange);
  };
}, []);
```

---

## Critical Implementation Notes

### Why No viewTransform in Dependencies
**CRITICAL**: Event handlers must NOT include `viewTransform` in their dependency arrays. This would cause handlers to be recreated during zoom/pan animations, leading to:
- Lost pointer capture mid-gesture
- Stale closures with outdated transform values
- Performance issues from constant handler recreation

**Solution**: Always read transform from `viewTransformRef.current` inside handlers. This ensures you get the latest value without recreation.

```typescript
// ❌ WRONG - causes handler recreation
const handleWheel = useCallback((e) => {
  const { scale, pan } = viewTransform; // Stale closure!
}, [viewTransform]); // Recreates during animation

// ✅ CORRECT - stable handler with fresh data
const handleWheel = (e: WheelEvent) => {
  const v = viewTransformRef.current!; // Always fresh
  // ... use v.scale, v.pan
}; // No deps, attached once
```

### Transform Invariants
- **Pan is in WORLD units**, not pixels
- Transform equation: `canvas = (world - pan) × scale`
- Transform order: `ctx.scale(scale, scale)` THEN `ctx.translate(-pan.x, -pan.y)`
- DPR is handled ONLY in CanvasStage, transparent to transforms

### Event Handler Pattern
- MMB pan must be checked BEFORE tool logic to prevent tool activation
- Use early returns to cleanly separate gesture branches
- Always use `{ passive: false }` for listeners that need preventDefault
- Pointer capture is per-gesture (MMB gets its own, tools get their own)

### State Management
- viewTransform is NOT in Canvas effect deps (prevents mid-gesture teardown)
- MMB pan state is ref-based (doesn't trigger re-renders)
- Tool state remains stable during transient gestures

### Coordinate Conversions
- Screen (clientX/Y) → Canvas (subtract rect) → World (divide by scale, add pan)
- Always read fresh transform from refs, not stale closures
- Canvas bounds come from getBoundingClientRect() in CSS pixels

### Meta.canvas Doesn't Exist Yet
The guide references `meta.canvas` for board dimensions, but this is **not currently populated** by RoomDocManager. Until implemented:
- Initial centering will use world origin (0, 0)
- Fit-to-content won't find a base board

To add board support, modify RoomDocManager's snapshot building:
```typescript
// In RoomDocManager when building snapshot meta
meta.set('canvas', {
  baseW: 1920,
  baseH: 1080,
  padding: 64
});
```

### Performance Considerations
- Transform changes trigger automatic full clear (already optimized)
- RAF coalescing happens inside tools, not at Canvas level
- Zoom animation uses exponential approach (critically damped)
- Mobile is view-only, so pan/zoom can be heavier on desktop

---

## Testing Checklist

### Wheel Zoom
- [ ] Wheel up zooms in, wheel down zooms out
- [ ] World point under cursor stays fixed
- [ ] Trackpad pinch works (via wheel + ctrlKey)
- [ ] Zoom clamps at MIN_ZOOM (0.01) and MAX_ZOOM (5.0)
- [ ] No browser scroll occurs

### MMB Pan
- [ ] Middle-mouse drag pans viewport
- [ ] Cursor shows 'grabbing' during drag
- [ ] Active tool doesn't change
- [ ] Tool preview remains stable
- [ ] Windows autoscroll circle doesn't appear

### Zoom Buttons
- [ ] Plus button zooms to viewport center
- [ ] Minus button zooms from viewport center
- [ ] Reset returns to 100% at origin
- [ ] Disabled state at min/max zoom

### Initial View
- [ ] Empty canvas positions board top-center in viewport
- [ ] Canvas with content fits content
- [ ] Padding is appropriate

### Pan Tool
- [ ] Toolbar button activates pan mode
- [ ] Left-drag pans in pan mode
- [ ] Cursor shows grab/grabbing
- [ ] Switching tools exits pan mode

### Edge Cases
- [ ] Rapid wheel events don't cause drift
- [ ] MMB during tool drag doesn't break
- [ ] Transform limits are respected
- [ ] Mobile remains view-only

---
