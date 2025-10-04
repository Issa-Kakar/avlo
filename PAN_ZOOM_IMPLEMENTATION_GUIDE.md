# Pan & Zoom Feature Implementation Guide

## Overview

This guide documents the complete implementation of pan/zoom functionality in the Avlo whiteboard, including all fixes for the "monster effect" teardown issue that occurs when event handlers have unstable dependencies.

### Implemented Features
1. **Wheel zoom-to-cursor** - Smooth zoom anchored at cursor position with ~9% per step using ZoomAnimator
2. **Middle Mouse Button (MMB) pan** - Ephemeral pan gesture without changing active tool
3. **Pan tool** - Persistent pan mode selectable from toolbar
4. **Smooth animation** - Exponential approach (~120ms half-life) for buttery-smooth zoom transitions

### Critical Architecture Decisions
- **No tool switching for MMB** - MMB pan is an ephemeral override, not a tool change
- **Stable event handlers** - Use refs for all event handler dependencies to prevent teardown
- **Event-driven rendering** - Transform changes auto-invalidate render loops
- **Unified pointer surface** - All tools implement the same PointerTool interface
- **Value-based setPan** - Context uses value setter, not functional updater

## Current Architecture

### Coordinate System
- **Transform formulas** (authoritative from transforms.ts):
  ```typescript
  worldToCanvas: [(x - pan.x) * scale, (y - pan.y) * scale]
  canvasToWorld: [x / scale + pan.x, y / scale + pan.y]
  ```
- **Pan units**: World coordinates (not screen pixels)
- **Context transform order**: `ctx.scale(scale, scale)` THEN `ctx.translate(-pan.x, -pan.y)`
- **DPR handling**: Applied only in CanvasStage, transparent to transform logic

### The "Monster Effect" Root Cause (FIXED)

The `worldToClient` callback previously had `viewTransform` as a dependency, causing recreation on every pan/zoom. This has been fixed by making it stable with empty dependencies, reading the latest transform from a ref.

## Implementation Details

### 1. Fixed Temporal Dead Zone (TDZ) Error

**File**: `client/src/canvas/Canvas.tsx`

Moved `useDeviceUIStore()` call BEFORE `activeToolRef` initialization to prevent TDZ error:

```typescript
// Get toolbar state from Zustand store - MUST come before activeToolRef initialization
const { activeTool, pen, highlighter, eraser, text } = useDeviceUIStore();

// Now safe to use activeTool
const activeToolRef = useRef<string>(activeTool);
```

### 2. Stabilized Callbacks and Refs

Added refs for stable access to context setters and transforms:

```typescript
const setScaleRef = useRef<(scale: number) => void>();
const setPanRef = useRef<(pan: { x: number; y: number }) => void>();
const activeToolRef = useRef<string>(activeTool);
const zoomAnimatorRef = useRef<ZoomAnimator | null>(null);
```

Layout effect to keep refs synchronized:

```typescript
useLayoutEffect(() => {
  viewTransformRef.current = viewTransform;
  setScaleRef.current = setScale;
  setPanRef.current = setPan;
  activeToolRef.current = activeTool;
}, [viewTransform, setScale, setPan, activeTool]);
```

### 3. Stabilized worldToClient Function

Made `worldToClient` stable with empty dependencies:

```typescript
const worldToClient = useCallback((worldX: number, worldY: number): [number, number] => {
  const stage = baseStageRef.current;
  const vt = viewTransformRef.current; // Read latest from ref
  if (!stage || !vt) return [worldX, worldY];

  const [canvasX, canvasY] = vt.worldToCanvas(worldX, worldY);
  const rect = stage.getBounds();
  return [canvasX + rect.left, canvasY + rect.top];
}, []); // ✅ Empty deps = stable function
```

### 4. Fixed Effect Dependencies

Added `worldToClient` and `applyCursor` to Tool Lifecycle effect dependencies (both are now stable):

```typescript
}, [
  roomDoc,
  userId,
  activeTool,
  pen,
  highlighter,
  eraser,
  text,
  stageReady,
  screenToWorld,
  worldToClient, // Now stable with empty deps, safe to include
  applyCursor,   // Also stable with empty deps
]);
```

### 5. MMB Pan Implementation

Added refs for ephemeral MMB pan state:

```typescript
const mmbPanRef = useRef<{
  active: boolean;
  pointerId: number | null;
  lastClient: { x: number; y: number } | null;
}>({ active: false, pointerId: null, lastClient: null });

const cursorOverrideRef = useRef<string | null>(null);
const suppressToolPreviewRef = useRef(false);
```

Stable cursor management function:

```typescript
const applyCursor = useCallback(() => {
  const canvas = baseStageRef.current?.getCanvasElement();
  if (!canvas) return;

  // Priority 1: Explicit override (MMB dragging)
  if (cursorOverrideRef.current) {
    canvas.style.cursor = cursorOverrideRef.current;
    return;
  }

  // Priority 2: Tool-based default (read from ref for stability)
  const currentTool = activeToolRef.current;
  switch (currentTool) {
    case 'eraser':
      canvas.style.cursor = 'none'; // Overlay draws ring
      break;
    case 'pan':
      canvas.style.cursor = 'grab'; // Open hand idle
      break;
    default:
      canvas.style.cursor = 'crosshair';
  }
}, []); // ✅ Empty deps - reads from refs
```

### 6. Pan Tool Implementation

**File**: `client/src/lib/tools/PanTool.ts`

Created PanTool class implementing the PointerTool interface:

```typescript
import type { ViewTransform } from '@avlo/shared';

type Point = { x: number; y: number };

export class PanTool {
  private pointerId: number | null = null;
  private lastClient: { x: number; y: number } | null = null;
  private isDragging = false;

  constructor(
    private getView: () => ViewTransform,
    private setPan: (pan: Point) => void, // Value setter, not functional updater
    private onInvalidateOverlay: () => void,
    private applyCursor: () => void,
    private setCursorOverride: (cursor: string | null) => void,
  ) {}

  // ... PointerTool interface implementation ...

  updatePan(clientX: number, clientY: number): void {
    if (!this.isDragging) return;

    if (this.lastClient) {
      const dx = clientX - this.lastClient.x;
      const dy = clientY - this.lastClient.y;

      const view = this.getView();
      // Use value setter, not functional updater
      this.setPan({
        x: view.pan.x - dx / view.scale,
        y: view.pan.y - dy / view.scale,
      });

      this.onInvalidateOverlay();
    }

    this.lastClient = { x: clientX, y: clientY };
  }
}
```

Integrated PanTool in Canvas.tsx:

```typescript
import { PanTool } from '@/lib/tools/PanTool';

// Unified interface for all pointer tools
type PointerTool = DrawingTool | EraserTool | TextTool | PanTool;

// In tool creation section
} else if (activeTool === 'pan') {
  tool = new PanTool(
    () => viewTransformRef.current,
    (pan) => setPanRef.current?.(pan), // Value setter, not functional updater
    () => overlayLoopRef.current?.invalidateAll(),
    applyCursor,
    (cursor) => { cursorOverrideRef.current = cursor; }
  );
}
```

### 7. Event Handlers Implementation

Split event handlers into a stable effect that mounts once:

```typescript
// Effect A: Stable event listeners (mount once)
useEffect(() => {
  const canvas = baseStageRef.current?.getCanvasElement();
  if (!canvas || !stageReady) return;

  // All handlers read from refs - no closure dependencies
  const handlePointerDown = (e: PointerEvent) => {
    // Mobile check
    const isMobile = /Android|webOS|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
                     navigator.maxTouchPoints > 1;
    if (isMobile) return;

    // MMB ephemeral pan
    if (e.button === 1) {
      e.preventDefault();
      if (toolRef.current?.isActive()) return;

      const canvas = baseStageRef.current?.getCanvasElement();
      if (!canvas) return;
      canvas.setPointerCapture(e.pointerId);

      mmbPanRef.current = {
        active: true,
        pointerId: e.pointerId,
        lastClient: { x: e.clientX, y: e.clientY },
      };

      cursorOverrideRef.current = 'grabbing';
      suppressToolPreviewRef.current = true;
      applyCursor();
      overlayLoopRef.current?.invalidateAll();
      return;
    }

    // Normal tools (left button only)
    if (e.button !== 0) return;
    // ... tool handling ...
  };

  const handlePointerMove = (e: PointerEvent) => {
    lastMouseClientRef.current = { x: e.clientX, y: e.clientY };

    // Update presence first
    if (!isMobile) {
      const world = screenToWorld(e.clientX, e.clientY);
      if (world) {
        roomDoc.updateCursor(world[0], world[1]);
      }
    }

    // MMB pan in progress
    if (mmbPanRef.current.active && e.pointerId === mmbPanRef.current.pointerId) {
      const last = mmbPanRef.current.lastClient!;
      const dx = e.clientX - last.x;
      const dy = e.clientY - last.y;
      mmbPanRef.current.lastClient = { x: e.clientX, y: e.clientY };

      // Pan using world units (VALUE SETTER, not functional updater)
      const view = viewTransformRef.current;
      if (view && setPanRef.current) {
        const newPan = {
          x: view.pan.x - dx / view.scale,
          y: view.pan.y - dy / view.scale,
        };
        setPanRef.current(newPan);
      }

      overlayLoopRef.current?.invalidateAll();
      return;
    }

    // ... rest of handler ...
  };

  // ... other handlers ...

  // Attach ALL listeners with { passive: false }
  canvas.addEventListener('pointerdown', handlePointerDown, { passive: false });
  // ... etc ...

  return () => {
    // Remove all listeners
  };
}, [stageReady, applyCursor, roomDoc, screenToWorld]);
```

### 8. Wheel Zoom Implementation

```typescript
const handleWheel = (e: WheelEvent) => {
  e.preventDefault();

  // Block wheel during MMB pan
  if (mmbPanRef.current.active) return;

  const canvas = baseStageRef.current?.getCanvasElement();
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  const canvasX = e.clientX - rect.left;
  const canvasY = e.clientY - rect.top;

  // Normalize wheel delta
  let deltaY = e.deltaY;
  if (e.deltaMode === 1) deltaY *= 40;  // Lines
  else if (e.deltaMode === 2) deltaY *= 800; // Pages
  const steps = deltaY / 120;

  // Calculate zoom factor (~9% per step)
  const ZOOM_STEP = Math.log(1.09);
  const factor = Math.exp(-steps * ZOOM_STEP);

  // Read LATEST transform from ref
  const v = viewTransformRef.current;
  if (!v) return;

  // Use existing calculateZoomTransform utility
  const { scale: targetScale, pan: targetPan } = calculateZoomTransform(
    v.scale,
    v.pan,
    factor,
    { x: canvasX, y: canvasY }
  );

  // Use ZoomAnimator for smooth transitions
  zoomAnimatorRef.current?.to(targetScale, targetPan);
};
```

### 9. ZoomAnimator Integration

**File**: `client/src/canvas/animation/ZoomAnimator.ts` (already implemented)

Integrated in Canvas.tsx:

```typescript
import { ZoomAnimator } from './animation/ZoomAnimator';

// Initialize ZoomAnimator
useEffect(() => {
  zoomAnimatorRef.current = new ZoomAnimator(
    () => viewTransformRef.current,
    (s) => setScaleRef.current?.(s),
    (p) => setPanRef.current?.(p),
  );

  return () => {
    zoomAnimatorRef.current?.destroy();
    zoomAnimatorRef.current = null;
  };
}, []); // Mount once
```

## Key Invariants

1. **Never cache Y references** - Always traverse from root
2. **Tool state in refs** - Survives React re-renders at 60 FPS
3. **Event handlers read from refs** - No closure dependencies (critical for mount-once pattern)
4. **MMB is ephemeral** - Never touches Zustand store
5. **Single tool branch point** - Route events polymorphically
6. **Transform math** - Pan is in world units, not screen pixels
7. **Presence first** - Update cursor position before handling gestures
8. **Stable callbacks** - Functions with empty deps read everything from refs
9. **Value setter for pan** - Context uses `setPan(pan)`, not `setPan((prev) => ...)`

## Behavior Summary

### Cursor States
- **Pen/Highlighter/Text**: OS crosshair cursor
- **Eraser**: Hidden OS cursor, overlay draws ring
- **Pan tool idle**: OS grab cursor (open hand)
- **Pan tool dragging**: OS grabbing cursor (closed hand)
- **MMB pan override**: OS grabbing cursor (beats any tool cursor)

### Gesture Precedence
1. If tool gesture is active (left button down), MMB is ignored
2. MMB creates ephemeral pan without changing `activeTool`
3. Wheel zoom works unless MMB is active

### Transform Updates
- All transform changes trigger both render loops via existing effect
- Base canvas uses DirtyRectTracker for optimized redraws
- Overlay always does full clear (cheap for sparse content)
- ZoomAnimator provides smooth transitions with exponential approach

## Critical Edge Cases & Solutions

### 1. Tool Switch During MMB Pan
If user switches tools while MMB is held down, the stale `applyCursor` closure issue is avoided by reading from `activeToolRef.current`. The MMB release will restore the correct cursor for the NEW tool.

### 2. Presence Updates During Pan
Presence is updated BEFORE any early returns in pointer move. This ensures remote cursors continue moving during both MMB pan and Pan tool drag.

### 3. Pan Tool First Delta
PanTool.begin() receives client coordinates and seeds `lastClient` immediately, preventing loss of the first drag segment.

### 4. Pan Tool Hover vs Drag
The pointer move handler only returns early from PanTool when `tool.isActive()` returns true (actively dragging). When idle, it falls through to normal `tool.move()` for hover updates.

### 5. Memory Leaks on Fast Tool Switching
Effect cleanup cancels active gestures and releases pointer capture before creating new tools, preventing leaked event listeners or stuck captures.

## Testing Checklist

- [ ] Wheel zoom centers on cursor position
- [ ] Wheel zoom animates smoothly
- [ ] MMB pan works without changing active tool
- [ ] MMB cursor shows 'grabbing' during drag
- [ ] Pan tool shows 'grab' cursor when idle
- [ ] Pan tool shows 'grabbing' cursor when dragging
- [ ] Tool switching during MMB pan restores correct cursor
- [ ] Presence updates continue during pan/zoom
- [ ] No "monster effect" teardown on pan/zoom
- [ ] TypeScript compilation passes with no errors
- [ ] ESLint shows no critical warnings