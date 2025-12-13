# Canvas Runtime Refactor - End Goal Architecture

**STATUS:** Source of Truth - All future refactor work MUST align with this document
**BRANCH:** `refactor/canvas-runtime-phase1`
**SUPERSEDES:** CANVAS_RUNTIME_ARCHITECTURE.md, REFACTOR_PAN_CURSOR_SYSTEM.md (where they conflict)

---

## Executive Summary

The goal is to **completely decouple the canvas runtime from React lifecycle**. Canvas.tsx is currently a "god component" (~800 lines) that controls everything. After this refactor:

- **Canvas.tsx** becomes a thin ~100-150 line React wrapper that only mounts DOM elements
- **CanvasRuntime.ts** is the imperative "brain" that orchestrates everything
- **Tools are true singletons** that self-construct in a registry module
- **Event listeners live in InputManager.ts** (dumb DOM layer, owned by CanvasRuntime)
- **RenderLoops have zero dependencies** besides canvas refs

---

## Architecture Diagram (End Goal)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         Canvas.tsx (~100 lines)                              │
│  - useLayoutEffect creates CanvasRuntime                                    │
│  - Mounts <canvas> elements and editor host div                             │
│  - Passes refs to runtime.start()                                           │
│  - Calls runtime.stop() on unmount                                          │
│  - NO event listeners, NO tool logic, NO render loop management             │
└─────────────────────────────────────┬───────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                     CanvasRuntime.ts (THE BRAIN)                             │
│                                                                              │
│  Responsibilities:                                                           │
│  - Imports tool-registry.ts (self-constructing singletons)                  │
│  - Owns InputManager.ts instance                                            │
│  - Constructs RenderLoop + OverlayRenderLoop (with canvas refs only)        │
│  - Constructs ZoomAnimator                                                  │
│  - Coordinate conversion (screenToWorld, etc.)                              │
│  - Tool dispatch (getCurrentTool().begin/move/end)                          │
│  - MMB pan handling (delegates to panTool singleton directly)               │
│  - Gesture blocking (panTool.isActive() || tool.isActive())                 │
│  - Wheel zoom handling                                                      │
│  - (TBD) May provide getPreview() to OverlayRenderLoop or it self-manages   │
└───────────────────┬─────────────────────────────────────────────────────────┘
                    │
          ┌─────────┴─────────┐
          │                   │
          ▼                   ▼
┌─────────────────────┐   ┌──────────────────────────────────────────────────┐
│  InputManager.ts    │   │              tool-registry.ts                     │
│  (DUMB DOM LAYER)   │   │           (SELF-CONSTRUCTING)                     │
│                     │   │                                                    │
│  - Attaches event   │   │  // Module-level singletons - construct at import │
│    listeners to     │   │  const drawingTool = new DrawingTool();           │
│    canvas element   │   │  const eraserTool = new EraserTool();             │
│    from camera-store│   │  const textTool = new TextTool();                 │
│                     │   │  const panTool = new PanTool();                   │
│  - Forwards RAW     │   │  const selectTool = new SelectTool();             │
│    PointerEvents    │   │                                                    │
│    to runtime:      │   │  // Lookup helpers                                 │
│    handlePointerDown│   │  export function getToolById(id: ToolId)          │
│    handlePointerMove│   │  export function getCurrentTool(): PointerTool    │
│    handlePointerUp  │   │                                                    │
│    handleWheel      │   │  // Direct exports for special access              │
│                     │   │  export { panTool } // For MMB pan                 │
│  - NO coord convert │   │                                                    │
│  - NO tool logic    │   └──────────────────────────────────────────────────┘
│  - NO state         │
└─────────────────────┘
          │
          │ reads canvas element from
          ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                        camera-store.ts                                        │
│  Module-level canvas element: getCanvasElement()                             │
│  Transform functions: screenToWorld(), worldToCanvas(), etc.                 │
│  Viewport state: scale, pan, cssWidth, cssHeight, dpr                        │
│  Mobile detection: isMobile() - set once when canvas element registered      │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

## Component Specifications

### 1. Canvas.tsx (Thin React Wrapper)

**Purpose:** Mount DOM elements and lifecycle bridge to CanvasRuntime

**What it DOES:**
- Render two `<canvas>` elements (base + overlay) and editor host div
- `useLayoutEffect` to create CanvasRuntime and call `start()`
- Pass canvas refs and editor host ref to runtime
- Call `runtime.stop()` on unmount
- Set active room context (`setActiveRoom()`) - this stays in React because roomDoc comes from `useRoomDoc()` hook

**What it does NOT do:**
- NO event listeners (moved to InputManager)
- NO tool construction (moved to tool-registry)
- NO tool dispatch logic (moved to CanvasRuntime)
- NO MMB pan state tracking (unified in PanTool)
- NO render loop management (moved to CanvasRuntime)
- NO coordinate conversion (moved to CanvasRuntime/camera-store)
- NO imperative handle (CanvasHandle REMOVED)

**Approximate structure:**
```typescript
export const Canvas = ({ roomId, className }: CanvasProps) => {
  const baseCanvasRef = useRef<HTMLCanvasElement>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null);
  const editorHostRef = useRef<HTMLDivElement>(null);
  const runtimeRef = useRef<CanvasRuntime | null>(null);

  const roomDoc = useRoomDoc(roomId);

  // Set active room (tools need this)
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
    const runtime = new CanvasRuntime();
    runtimeRef.current = runtime;

    runtime.start({
      baseCanvas: baseCanvasRef.current!,
      overlayCanvas: overlayCanvasRef.current!,
    });

    return () => {
      runtime.stop();
      runtimeRef.current = null;
    };
  }, []);

  return (
    <div className="relative w-full h-full">
      <canvas ref={baseCanvasRef} style={{ position: 'absolute', inset: 0, zIndex: 1 }} />
      <canvas ref={overlayCanvasRef} style={{ position: 'absolute', inset: 0, zIndex: 2, pointerEvents: 'none' }} />
      <div ref={editorHostRef} style={{ position: 'absolute', inset: 0, zIndex: 3, pointerEvents: 'none' }} />
    </div>
  );
};
```

---

### 2. CanvasRuntime.ts (The Brain)

**Purpose:** Imperative orchestrator for all canvas operations

**Responsibilities:**
1. Import tool registry (tools self-construct)
2. Create and own InputManager instance
3. Create RenderLoop and OverlayRenderLoop (with canvas refs only)
4. Create ZoomAnimator
5. Handle all pointer event logic (coordinate conversion, tool dispatch)
6. Handle MMB pan (directly use panTool singleton)
7. Handle wheel zoom
8. Provide `getPreview()` callback for overlay rendering
9. Gesture blocking logic

**Key Methods:**
```typescript
class CanvasRuntime {
  private inputManager: InputManager | null = null;
  private renderLoop: RenderLoop | null = null;
  private overlayLoop: OverlayRenderLoop | null = null;
  private zoomAnimator: ZoomAnimator | null = null;

  start(config: { baseCanvas: HTMLCanvasElement; overlayCanvas: HTMLCanvasElement }): void;
  stop(): void;

  // Called by InputManager
  handlePointerDown(e: PointerEvent): void;
  handlePointerMove(e: PointerEvent): void;
  handlePointerUp(e: PointerEvent): void;
  handlePointerCancel(e: PointerEvent): void;
  handlePointerLeave(e: PointerEvent): void;
  handleLostPointerCapture(e: PointerEvent): void;
  handleWheel(e: WheelEvent): void;

  // TBD: May provide getPreview() if OverlayRenderLoop doesn't self-manage
  // getPreview(): PreviewData | null;
}
```

**MMB Pan Handling (Unified with PanTool):**
```typescript
handlePointerDown(e: PointerEvent): void {
  // MMB = button 1
  if (e.button === 1) {
    e.preventDefault();

    // Block if another tool gesture is active
    const currentTool = getCurrentTool();
    if (currentTool?.isActive()) return;

    // Block if pan already in progress
    if (panTool.isActive()) return;

    // Use panTool singleton directly!
    const canvas = getCanvasElement();
    canvas?.setPointerCapture(e.pointerId);

    const world = screenToWorld(e.clientX, e.clientY);
    if (world) {
      panTool.begin(e.pointerId, world[0], world[1], e.clientX, e.clientY);
    }
    return;
  }

  // Normal tool handling (button 0)
  if (e.button === 0) {
    // Block if pan is active
    if (panTool.isActive()) return;

    const tool = getCurrentTool();
    if (!tool?.canBegin()) return;

    // ... coordinate conversion and tool.begin()
  }
}
```

---

### 3. InputManager.ts (Dumb DOM Layer)

**Purpose:** ONLY handles DOM event listener attachment/detachment

**What it DOES:**
- Get canvas element from `getCanvasElement()` (camera-store module reference)
- Attach pointer and wheel event listeners
- Forward RAW events to CanvasRuntime methods
- Clean up listeners on destroy

**What it does NOT do:**
- NO coordinate conversion
- NO tool selection logic
- NO state tracking
- NO gesture blocking logic
- NO cursor management

**Structure:**
```typescript
export class InputManager {
  private runtime: CanvasRuntime;
  private canvas: HTMLCanvasElement | null = null;

  constructor(runtime: CanvasRuntime) {
    this.runtime = runtime;
  }

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
    // ... remove all listeners
    this.canvas = null;
  }

  // Just forward raw events - that's it!
  private onPointerDown = (e: PointerEvent) => this.runtime.handlePointerDown(e);
  private onPointerMove = (e: PointerEvent) => this.runtime.handlePointerMove(e);
  private onPointerUp = (e: PointerEvent) => this.runtime.handlePointerUp(e);
  private onPointerCancel = (e: PointerEvent) => this.runtime.handlePointerCancel(e);
  private onPointerLeave = (e: PointerEvent) => this.runtime.handlePointerLeave(e);
  private onLostCapture = (e: PointerEvent) => this.runtime.handleLostPointerCapture(e);
  private onWheel = (e: WheelEvent) => this.runtime.handleWheel(e);
}
```

---

### 4. tool-registry.ts (Self-Constructing Singletons)

**Purpose:** Single module that constructs and exports all tool singletons

**Key Principle:** Tools construct THEMSELVES at module import time. CanvasRuntime imports this module but does NOT own tool construction.

**Structure:**
```typescript
import { DrawingTool } from '@/lib/tools/DrawingTool';
import { EraserTool } from '@/lib/tools/EraserTool';
import { TextTool } from '@/lib/tools/TextTool';
import { PanTool } from '@/lib/tools/PanTool';
import { SelectTool } from '@/lib/tools/SelectTool';
import { useDeviceUIStore, type Tool as ToolId } from '@/stores/device-ui-store';

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
type PointerTool = DrawingTool | EraserTool | TextTool | PanTool | SelectTool;

const toolMap = new Map<string, PointerTool>([
  ['pen', drawingTool],
  ['highlighter', drawingTool],
  ['shape', drawingTool],
  ['eraser', eraserTool],
  ['text', textTool],
  ['pan', panTool],
  ['select', selectTool],
]);

// ===========================================
// HELPERS
// ===========================================

/** Get tool by ID */
export function getToolById(toolId: string): PointerTool | undefined {
  return toolMap.get(toolId);
}

/** Get currently active tool from device-ui-store */
export function getCurrentTool(): PointerTool | undefined {
  const { activeTool } = useDeviceUIStore.getState();
  return toolMap.get(activeTool);
}

/** Get the preview from the currently active tool */
export function getActivePreview(): PreviewData | null {
  const tool = getCurrentTool();
  return tool?.getPreview() ?? null;
}

// ===========================================
// DIRECT EXPORTS for special access
// ===========================================

/** Export panTool directly for MMB pan handling */
export { panTool };

/** Export all tools for testing/debugging */
export const allTools = { drawingTool, eraserTool, textTool, panTool, selectTool };
```

---

### 5. RenderLoop.ts (Zero Dependencies)

**Current State:** Has dependencies via config object:
- `stageRef: RefObject<CanvasStageHandle>` - needs canvas
- `getSnapshot: () => Snapshot`
- `getGates: () => GateStatus`
- `onStats?: callback`
- `isMobile?: () => boolean`

**End Goal:** Zero callback/getter dependencies - everything read from modules

**New Config:**
```typescript
export interface RenderLoopConfig {
  // TBD: Either stageRef OR direct context injection
  // Decision pending - but NO imperative handle methods either way
  //stageRef?: RefObject<{ getCanvasElement(): HTMLCanvasElement | null }>;
  // OR
  // getContext: () => CanvasRenderingContext2D | null;

}
```

> **TBD:** Whether to pass stageRef or inject context directly is undetermined. Either way, NO imperative handle methods will be used - only canvas element access. The viewport/canvas size is already available imperatively from camera-store (`cssWidth`, `cssHeight`, `dpr`).

**What RenderLoop reads from modules:**
- Snapshot: `getActiveRoomDoc().currentSnapshot`
- Gates: `getActiveRoomDoc().getGateStatus()`
- View/Viewport: `useCameraStore.getState()` (already doing this - includes canvas size)
- Mobile check: `isMobile()` from camera-store (if throttling needed - reads imperatively, no callback)

**Key Changes:**
1. Remove `getSnapshot` - read from `getActiveRoomDoc().currentSnapshot`
2. Remove `getGates` - read from `getActiveRoomDoc().getGateStatus()`
3. Remove `isMobile` callback - if throttling needed, read imperatively from camera-store
4. Canvas access TBD (stageRef vs context injection) - no imperative handle either way

---

### 6. OverlayRenderLoop.ts (Zero Dependencies)

**Current State:** Has dependencies:
- `stage: { withContext, clear }`
- `getView?: () => ViewTransform` (deprecated)
- `getViewport?: () => {...}` (deprecated)
- `getGates: () => {...}`
- `getPresence: () => PresenceView`
- `getSnapshot: () => Snapshot`
- `drawPresence: callback`

**End Goal:** Zero callback/getter dependencies - everything read from modules

**New Config:**
```typescript
export interface OverlayLoopConfig {
  // TBD: Either stageRef OR direct context injection (same decision as RenderLoop)
  // Decision pending - but NO imperative handle methods either way
 // stageRef?: RefObject<{ getCanvasElement(): HTMLCanvasElement | null }>;
  // OR
  // getContext: () => CanvasRenderingContext2D | null;
  // clear: () => void;

  // TBD: Preview provider - may be self-managing within overlay loop
  // getPreview?: () => PreviewData | null;
}
```

> **TBD:** Preview provider may become self-managing within OverlayRenderLoop instead of being passed in. Decision pending. If self-managing, it would import from tool-registry and call `getActivePreview()` directly.

**What OverlayRenderLoop reads from modules:**
- View/Viewport: `getViewTransform()`, `getViewportInfo()` from camera-store (includes canvas size)
- Snapshot: `getActiveRoomDoc().currentSnapshot`
- Gates: `getActiveRoomDoc().getGateStatus()`
- Presence: `getActiveRoomDoc().currentSnapshot.presence`
- Preview: TBD - either passed in or self-managed via `getActivePreview()` from tool-registry

**drawPresence:** Move the presence drawing logic INTO OverlayRenderLoop or into a separate `layers/presence.ts` module. It currently receives a callback that calls `drawPresenceOverlays()` - just call that directly.

---

### 7. Module Stubs (Keep Separate)

The existing module stubs are well-designed and should be KEPT:

| Module | Purpose | Status |
|--------|---------|--------|
| `room-runtime.ts` | `getActiveRoomDoc()` for Y.Doc access | KEEP - set by Canvas.tsx |
| `cursor-manager.ts` | `applyCursor()` / `setCursorOverride()` | KEEP |
| `invalidation-helpers.ts` | `invalidateOverlay()` / `invalidateWorld()` | KEEP - set by CanvasRuntime |
| `editor-host-registry.ts` | `getEditorHost()` for TextTool | KEEP - set by Canvas.tsx |
| `camera-store.ts` | Canvas element, transforms, viewport, mobile detection | KEEP |

**Note:** invalidation-helpers registration moves from Canvas.tsx to CanvasRuntime since CanvasRuntime now owns the render loops.

**Mobile Detection Pattern (camera-store):**
Add `isMobile()` function to camera-store following same pattern as `applyCursor()` in cursor-manager:
- Set once when `setCanvasElement()` is called (check user agent / maxTouchPoints at registration time)
- Module-level boolean cached - no callback needed
- RenderLoop can read imperatively for throttling if needed
- Canvas.tsx does NOT gate on mobile - remove all mobile guards

---

## Things to REMOVE

### From Canvas.tsx

| Item | Why Remove |
|------|------------|
| `mmbPanRef` | Unified into PanTool singleton |
| `suppressToolPreviewRef` | Legacy eraser CSS cursor workaround - no longer needed |
| `lastMouseClientRef` | Move to CanvasRuntime if still needed for eraser seeding |
| `activeToolRef` | Not needed - read from store |
| `toolRef` | Tools are singletons in registry |
| `renderLoopRef` / `overlayLoopRef` | Moved to CanvasRuntime |
| `zoomAnimatorRef` | Moved to CanvasRuntime |
| All event handlers | Moved to InputManager/CanvasRuntime |
| `useImperativeHandle` / `CanvasHandle` | REMOVE ENTIRELY |
| `isMobile()` helper | Remove mobile checks |
| `roomDoc.updateActivity()` calls | Useless UX per EXPLICIT_INSTRUCTIONS |

### From CanvasStage.tsx

| Item | Why Remove |
|------|------------|
| `onResize` prop | Viewport updates go directly to camera-store |
| `useImperativeHandle` | Keep only `getCanvasElement()`, remove rest |

### Mobile Checks (Remove Throughout)

```typescript
// REMOVE all instances of:
const isMobile = /Android|webOS|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
                 navigator.maxTouchPoints > 1;
if (isMobile) return;
```

Mobile support will be added later with proper touch handling. For now, remove these guards that block development iteration.

### Activity Updates In Canvas.tsx (Remove)

```typescript
// REMOVE all instances in Canvas.tsx of:
roomDoc.updateActivity('drawing');
roomDoc.updateActivity('idle');
roomDoc.updateActivity('typing');
```

Per EXPLICIT_INSTRUCTIONS: "the room doc update activity is utterly useless UX and bloat."
**keep presence data as is, just ignore updating activity right now**
---

## MMB Pan Unification

### Current State (Duplicated Logic)

**Canvas.tsx has separate mmbPanRef:**
```typescript
const mmbPanRef = useRef<{
  active: boolean;
  pointerId: number | null;
  lastClient: { x: number; y: number } | null;
}>({ active: false, pointerId: null, lastClient: null });
```

**Plus identical pan math:**
```typescript
// In Canvas.tsx MMB handler
const { scale, pan } = useCameraStore.getState();
const newPan = {
  x: pan.x - dx / scale,
  y: pan.y - dy / scale,
};
useCameraStore.getState().setPan(newPan);
```

**PanTool has the same logic:**
```typescript
// In PanTool.updatePan()
const { scale, pan, setPan } = useCameraStore.getState();
setPan({
  x: pan.x - dx / scale,
  y: pan.y - dy / scale,
});
```

### End Goal (Unified)

Since tools are singletons, PanTool ALWAYS exists. MMB pan simply uses PanTool directly:

```typescript
// CanvasRuntime.handlePointerDown()
if (e.button === 1) {
  // Just use the panTool singleton!
  if (!panTool.canBegin()) return;

  canvas.setPointerCapture(e.pointerId);
  panTool.begin(e.pointerId, worldX, worldY, e.clientX, e.clientY);
  return;
}

// CanvasRuntime.handlePointerMove()
if (panTool.isActive() && panTool.getPointerId() === e.pointerId) {
  panTool.updatePan(e.clientX, e.clientY);
  return;
}

// CanvasRuntime.handlePointerUp()
if (panTool.isActive() && panTool.getPointerId() === e.pointerId) {
  canvas.releasePointerCapture(e.pointerId);
  panTool.end();
  return;
}
```

**No separate mmbPanRef needed!** PanTool.isActive() tells us if ANY pan is in progress (MMB or dedicated tool).

---

## DPR/Resize Observer Logic

### Decision: To be determined
**We'll decide later, at the time of creation of this document it's unknown**

---

## Implementation Phases

### Phase 2A: Create tool-registry.ts

1. Create `client/src/canvas/tool-registry.ts`
2. Move tool imports from Canvas.tsx
3. Create singleton instances at module level
4. Add lookup helpers (`getCurrentTool`, `getToolById`)
5. Export `panTool` for MMB handling
6. Update Canvas.tsx imports

### Phase 2B: Create CanvasRuntime Shell

1. Create `client/src/canvas/CanvasRuntime.ts`
2. Implement `start()` and `stop()` methods
3. Create RenderLoop/OverlayRenderLoop in `start()`
4. Create ZoomAnimator
5. Import tool-registry (not construct tools)
6. Canvas.tsx creates runtime but doesn't use it yet

### Phase 2C: Create InputManager.ts

1. Create `client/src/canvas/InputManager.ts`
2. Implement attach/detach for event listeners
3. Forward raw events to CanvasRuntime
4. CanvasRuntime creates InputManager in `start()`

### Phase 2D: Move Event Handling to CanvasRuntime

1. Add `handlePointerDown/Move/Up/Cancel/Leave/LostCapture` methods
2. Add `handleWheel` method
3. Copy coordinate conversion logic
4. Implement tool dispatch with getCurrentTool()
5. Implement MMB pan with panTool singleton
6. Remove mmbPanRef entirely
7. TBD: Add `getPreview()` method if OverlayRenderLoop doesn't self-manage

### Phase 2E: Update RenderLoop Dependencies

1. Remove `getSnapshot` - read from `getActiveRoomDoc().currentSnapshot`
2. Remove `getGates` - read from `getActiveRoomDoc().getGateStatus()`
3. Remove `isMobile` callback - add `isMobile()` to camera-store instead
4. TBD: Simplify canvas access (stageRef vs context injection)

### Phase 2F: Update OverlayRenderLoop Dependencies

1. Remove deprecated getView/getViewport
2. Remove getGates, getPresence, getSnapshot - read from modules
3. Move drawPresence logic inline or to separate module
4. TBD: Either accept `getPreview` from CanvasRuntime OR self-manage via tool-registry

### Phase 2G: Canvas.tsx Cleanup

1. Remove all event handlers
2. Remove tool construction logic
3. Remove mmbPanRef, suppressToolPreviewRef
4. Remove useImperativeHandle/CanvasHandle
5. Remove mobile checks
6. Remove activity updates
7. Remove unused refs
8. Should be ~100-150 lines

### Phase 2H: CanvasStage Cleanup

1. Remove `onResize` prop
2. Simplify imperative handle (keep only `getCanvasElement` if needed)

---

## File Changes Summary

### New Files

| File | Purpose |
|------|---------|
| `client/src/canvas/CanvasRuntime.ts` | Central orchestrator |
| `client/src/canvas/InputManager.ts` | Dumb DOM event layer |
| `client/src/canvas/tool-registry.ts` | Self-constructing tool singletons |

### Modified Files

| File | Changes |
|------|---------|
| `Canvas.tsx` | Thin wrapper (~100 lines) |
| `CanvasStage.tsx` | Remove onResize, simplify handle |
| `RenderLoop.ts` | Zero deps, read from modules |
| `OverlayRenderLoop.ts` | Zero deps, accept getPreview |

### Deleted Code

- `CanvasHandle` interface
- `mmbPanRef` and all MMB state tracking
- `suppressToolPreviewRef`
- `isMobile()` checks throughout
- `roomDoc.updateActivity()` calls
- ~600 lines from Canvas.tsx

---

## Success Criteria

1. **Canvas.tsx < 150 lines** - thin React wrapper only
2. **CanvasRuntime owns all imperative logic** - single "brain"
3. **Tools are true singletons** - never constructed/destroyed on tool switch
4. **InputManager is DUMB** - only forwards raw events
5. **RenderLoops have zero callback/getter dependencies** - read imperatively from modules
6. **MMB pan uses PanTool directly** - no duplicate state
7. **No mobile guards in Canvas.tsx** - mobile detection moves to camera-store
8. **No activity updates in Canvas.tsx** - removed useless UX
9. **No CanvasHandle** - removed React imperative escape hatch
10. **All tests pass** - `npm run typecheck`

### TBD Decisions (To Be Determined During Implementation)

| Decision | Options | Notes |
|----------|---------|-------|
| Canvas access in RenderLoops | stageRef vs context injection | No imperative handle either way |
| Preview provider | CanvasRuntime provides vs OverlayRenderLoop self-manages | Self-manage would use tool-registry |
| onStats callback | Keep vs remove | Low priority, can keep if useful |

---

## References

- `EXPLICIT_INSTRUCTIONS.MD` - Source of truth for requirements
- `REFACTOR_STATE.md` - Progress tracking
- `CLAUDE.md` - Codebase documentation
