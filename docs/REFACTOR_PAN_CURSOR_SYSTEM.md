# Pan & Cursor System Refactor

**Status:** Investigation complete, ready for implementation
**Blocking:** PanTool and SelectTool zero-arg conversion
**Branch:** `refactor/canvas-runtime-phase1`

---

## Executive Summary

The panning system has **duplicated logic** between MMB (middle mouse button) pan and the dedicated PanTool. Cursor management is **scattered across multiple refs and callbacks**.

**Key Insight:** With tools as singletons (never destroyed), MMB pan can simply USE the PanTool directly. No separate pan-controller needed - PanTool IS the pan state.

---

## Current System Analysis

### The Two Panning Modes

**1. MMB Pan (Middle Mouse Button)**
- Triggered by button 1 press anywhere on canvas
- Works as an "override" - can interrupt idle tools
- Blocked if a tool gesture is already active
- Lives entirely in Canvas.tsx (~100 lines of handlers)

**2. Dedicated PanTool**
- Activated when `activeTool === 'pan'` in toolbar
- Created/destroyed on tool switch (like other tools) ← **THIS IS THE PROBLEM**
- Has its own state: `pointerId`, `lastClient`, `isDragging`
- Constructor takes 3 callbacks: `onInvalidateOverlay`, `applyCursor`, `setCursorOverride`

### The Duplication Problem

Both use **identical pan math**:

```typescript
// Canvas.tsx MMB pan (line ~586)
const { scale, pan } = useCameraStore.getState();
const newPan = {
  x: pan.x - dx / scale,
  y: pan.y - dy / scale,
};
useCameraStore.getState().setPan(newPan);

// PanTool.updatePan() (line ~71)
const { scale, pan, setPan } = useCameraStore.getState();
setPan({
  x: pan.x - dx / scale,
  y: pan.y - dy / scale,
});
```

### Why Duplication Existed

The duplication exists because **tools are created/destroyed on activeTool change**:
- When `activeTool === 'eraser'`, PanTool doesn't exist
- But MMB pan still needs to work
- So MMB pan logic was duplicated in Canvas.tsx

**With singletons, this problem disappears.** PanTool always exists, so MMB can just use it directly.

### Ref Explosion in Canvas.tsx

```typescript
// Panning state - DUPLICATES PanTool's internal state
const mmbPanRef = useRef<{
  active: boolean;
  pointerId: number | null;
  lastClient: { x: number; y: number } | null;
}>({ active: false, pointerId: null, lastClient: null });

// Cursor state
const cursorOverrideRef = useRef<string | null>(null);

// OBSOLETE - can be removed
const suppressToolPreviewRef = useRef(false);  // Was for old eraser CSS cursor
const lastMouseClientRef = useRef<{ x: number; y: number } | null>(null);  // Was for tool seeding

// Tool state
const activeToolRef = useRef<string>(activeTool);  // For stable closures
const toolRef = useRef<PointerTool>();
```

### Canvas Element Registration Bug

In CanvasStage.tsx, BOTH base and overlay canvases call `setCanvasElement()`:

```typescript
const canvasRefCallback = useCallback((el: HTMLCanvasElement | null) => {
  canvasRef.current = el;
  setCanvasElement(el);  // Called for BOTH canvases!
}, []);
```

The **last one to mount wins** (overlay), but overlay has `pointer-events: none`. This means `getCanvasElement()` returns the wrong canvas, and **cursor-manager.ts won't work correctly**.

---

## The Singleton Insight

### Old Model (Tools Created/Destroyed)

```
activeTool = 'pen'    → DrawingTool exists, PanTool destroyed
activeTool = 'eraser' → EraserTool exists, PanTool destroyed
activeTool = 'pan'    → PanTool exists, others destroyed

MMB pan needs to work regardless → duplicate logic in Canvas.tsx
```

### New Model (Tools as Singletons)

```
All tools exist as singletons in CanvasRuntime:
  - drawingTool (always exists)
  - eraserTool (always exists)
  - panTool (always exists)      ← MMB can use this directly!
  - selectTool (always exists)
  - textTool (always exists)

activeTool just determines which tool handles button 0
MMB always routes to panTool.begin() directly
```

### Why This Eliminates Duplication

1. **PanTool always exists** - It's a singleton, available for MMB regardless of activeTool
2. **MMB calls `panTool.begin()` directly** - No separate state tracking needed
3. **Cursor restoration is automatic** - cursor-manager reads `activeTool` for base cursor
4. **Gesture blocking is trivial** - Just check `panTool.isActive()`

---

## Proposed Architecture

### PanTool as Zero-Arg Singleton

```typescript
// PanTool.ts - Zero-arg, self-contained
import { useCameraStore } from '@/stores/camera-store';
import { setCursorOverride, applyCursor } from '@/canvas/cursor-manager';
import { invalidateOverlay } from '@/canvas/invalidation-helpers';

export class PanTool {
  private pointerId: number | null = null;
  private lastClient: { x: number; y: number } | null = null;

  constructor() {} // Zero-arg!

  canBegin(): boolean {
    return this.pointerId === null;
  }

  begin(pointerId: number, _wx: number, _wy: number, clientX?: number, clientY?: number): void {
    if (clientX === undefined || clientY === undefined) return;
    this.pointerId = pointerId;
    this.lastClient = { x: clientX, y: clientY };
    setCursorOverride('grabbing');
    applyCursor();
  }

  updatePan(clientX: number, clientY: number): void {
    if (!this.lastClient) return;

    const dx = clientX - this.lastClient.x;
    const dy = clientY - this.lastClient.y;
    this.lastClient = { x: clientX, y: clientY };

    // Pan math lives HERE - single source of truth
    const { scale, pan, setPan } = useCameraStore.getState();
    setPan({
      x: pan.x - dx / scale,
      y: pan.y - dy / scale,
    });

    invalidateOverlay();
  }

  end(): void {
    this.pointerId = null;
    this.lastClient = null;
    setCursorOverride(null);
    applyCursor(); // Automatically restores correct cursor based on activeTool
  }

  cancel(): void { this.end(); }
  isActive(): boolean { return this.pointerId !== null; }
  getPointerId(): number | null { return this.pointerId; }
  getPreview(): null { return null; }
  destroy(): void { this.end(); }
}
```

### CanvasRuntime Pointer Dispatch

```typescript
class CanvasRuntime {
  // Tool singletons - created once, never destroyed
  private panTool = new PanTool();
  private drawingTool = new DrawingTool();
  private eraserTool = new EraserTool();
  // ... etc

  private getCurrentTool(): PointerTool | null {
    const { activeTool } = useDeviceUIStore.getState();
    switch (activeTool) {
      case 'pan': return this.panTool;
      case 'pen':
      case 'highlighter':
      case 'shape': return this.drawingTool;
      case 'eraser': return this.eraserTool;
      // ...
    }
  }

  handlePointerDown(e: PointerEvent): void {
    // MMB Pan - use panTool singleton directly
    if (e.button === 1) {
      const currentTool = this.getCurrentTool();
      if (currentTool?.isActive()) return; // Block if tool gesture active
      if (!this.panTool.canBegin()) return;

      setPointerCapture(e.pointerId);
      const world = screenToWorld(e.clientX, e.clientY);
      this.panTool.begin(e.pointerId, world[0], world[1], e.clientX, e.clientY);
      return;
    }

    // Normal tool (button 0)
    if (e.button === 0) {
      if (this.panTool.isActive()) return; // Block if pan active (MMB in progress)

      const tool = this.getCurrentTool();
      if (tool?.canBegin()) {
        setPointerCapture(e.pointerId);
        const world = screenToWorld(e.clientX, e.clientY);
        tool.begin(e.pointerId, world[0], world[1], e.clientX, e.clientY);
      }
    }
  }

  handlePointerMove(e: PointerEvent): void {
    // Pan takes priority (whether started via MMB or dedicated pan tool)
    if (this.panTool.isActive() && this.panTool.getPointerId() === e.pointerId) {
      this.panTool.updatePan(e.clientX, e.clientY);
      return;
    }

    // Normal tool move
    const tool = this.getCurrentTool();
    if (tool?.isActive()) {
      const world = screenToWorld(e.clientX, e.clientY);
      tool.move(world[0], world[1]);
    }
  }

  handlePointerUp(e: PointerEvent): void {
    // Check pan first (handles both MMB and dedicated)
    if (this.panTool.isActive() && this.panTool.getPointerId() === e.pointerId) {
      releasePointerCapture(e.pointerId);
      this.panTool.end();
      return;
    }

    // Normal tool end
    const tool = this.getCurrentTool();
    if (tool?.isActive() && tool.getPointerId() === e.pointerId) {
      releasePointerCapture(e.pointerId);
      const world = screenToWorld(e.clientX, e.clientY);
      tool.end(world[0], world[1]);
    }
  }
}
```

### Cursor Restoration Flow

**When MMB pan ends (activeTool = 'pen'):**
1. `panTool.end()` calls `setCursorOverride(null)`
2. `applyCursor()` reads `activeTool` from store → 'pen'
3. Cursor set to 'crosshair' (pen's base cursor)

**When dedicated pan ends (activeTool = 'pan'):**
1. `panTool.end()` calls `setCursorOverride(null)`
2. `applyCursor()` reads `activeTool` from store → 'pan'
3. Cursor set to 'grab' (pan's base cursor)

**No mode tracking needed** - cursor-manager handles it automatically!

---

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                     Module-Level Singletons                      │
│  room-runtime      cursor-manager      invalidation-helpers     │
│  editor-host-registry                  camera-store             │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Tools (Zero-Arg Singletons)                   │
│  DrawingTool ✅    EraserTool ✅    TextTool ✅                  │
│  PanTool ⏳ (handles BOTH MMB and dedicated pan)                │
│  SelectTool ⏳ (uses cursor-manager for handle cursors)         │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│              CanvasRuntime.ts (Future)                           │
│  - Owns tool singletons (created once, never destroyed)         │
│  - Owns RenderLoop + OverlayRenderLoop + ZoomAnimator           │
│  - Pointer dispatch:                                             │
│    • MMB → panTool.begin() directly (panTool always exists!)    │
│    • Button 0 → getCurrentTool().begin()                        │
│  - Gesture blocking: panTool.isActive() || tool.isActive()      │
│  - Canvas.tsx becomes thin React mount/unmount wrapper          │
└─────────────────────────────────────────────────────────────────┘
```

---

## Implementation Plan

### Phase A: Fix Prerequisites

1. **Fix CanvasStage canvas registration**
   - Add `registerAsPointerTarget?: boolean` prop
   - Only call `setCanvasElement()` when true
   - Canvas.tsx: only base stage gets this prop

2. **Wire cursor-manager.ts**
   - Remove `applyCursor` useCallback from Canvas.tsx
   - Remove `cursorOverrideRef` from Canvas.tsx
   - Import `applyCursor`, `setCursorOverride` from cursor-manager
   - Update pointer handlers to use cursor-manager

3. **Remove obsolete refs**
   - `suppressToolPreviewRef` - no longer needed
   - `lastMouseClientRef` - no longer needed

### Phase B: PanTool Zero-Arg

4. **Refactor PanTool to zero-arg**
   - Remove constructor args
   - Import cursor-manager functions
   - Import invalidation-helpers
   - Self-contained pan math

5. **Update Canvas.tsx MMB handling**
   - Remove `mmbPanRef` entirely
   - Call `panTool.begin/updatePan/end` directly
   - Remove duplicated pan math

### Phase C: Complete Tool Migration

6. **Refactor SelectTool to zero-arg**
   - Remove constructor args
   - Use cursor-manager for handle hover cursors
   - Use invalidation-helpers for invalidation
   - Use room-runtime for roomDoc access

### Phase D: Create CanvasRuntime

7. **Create `CanvasRuntime.ts`**
   - Consolidate tool singletons
   - Consolidate render loop creation
   - Consolidate pointer event dispatch
   - Canvas.tsx becomes thin wrapper

---

## Files to Modify

| File | Changes |
|------|---------|
| `client/src/canvas/CanvasStage.tsx` | Add `registerAsPointerTarget` prop |
| `client/src/canvas/cursor-manager.ts` | Already complete, just needs wiring |
| `client/src/canvas/Canvas.tsx` | Wire cursor-manager, remove mmbPanRef, use panTool directly |
| `client/src/lib/tools/PanTool.ts` | Zero-arg, self-contained |
| `client/src/lib/tools/SelectTool.ts` | Zero-arg, use cursor-manager |
| `client/src/canvas/CanvasRuntime.ts` | **NEW** (Phase D) - consolidated runtime |

**NOT needed:** ~~pan-controller.ts~~ - PanTool IS the pan controller!

---

## Key Insights

1. **Singletons eliminate the need for separate pan state** - With tools never destroyed, PanTool always exists and MMB can use it directly.

2. **Cursor priority is handled by cursor-manager** - Override > base, and base is computed from activeTool. No mode tracking needed.

3. **Gesture blocking is trivial** - Just `if (panTool.isActive() || tool.isActive()) return;`

4. **PanTool handles both modes identically** - The only difference is which tool handles button 0, but panTool handles ALL panning.

5. **The canvas element bug must be fixed first** - cursor-manager needs the correct (base) canvas element.

---

## References

- `docs/REFACTOR_STATE.md` - Overall refactor progress
- `docs/REFACTOR_PHASE_1_ROOM_RUNTIME.md` - Phase 1 design doc
- `client/src/canvas/Canvas.tsx` - Current implementation (~900 lines)
- `client/src/lib/tools/PanTool.ts` - Current PanTool (82 lines)
- `client/src/canvas/cursor-manager.ts` - Created but not wired
