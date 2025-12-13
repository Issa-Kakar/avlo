# Canvas Runtime Refactor - State & Progress

**Last Updated:** Phase 2E/2F Complete (Canvas.tsx Simplified to ~164 lines)

---

## Progress Summary

| Phase | Description | Status |
|-------|-------------|--------|
| 1.0 | Runtime Modules (room-runtime, cursor-manager, etc.) | ✅ Complete |
| 1.1 | CanvasStage pointer target fix | ✅ Complete |
| 1.5 | All tools zero-arg constructors | ✅ Complete |
| 1.6 | Explicit transforms in render loops | ✅ Complete |
| 2A | Eliminate CanvasStage & Imperative Handle | ✅ Complete |
| 2B-prereq | PointerTool interface + tool updates | ✅ Complete |
| 2B | Tool Registry & Preview Coupling | ✅ Complete |
| 2C | CanvasRuntime.ts shell created | ✅ Complete |
| 2D | InputManager.ts shell created | ✅ Complete |
| 2E | Wire CanvasRuntime into Canvas.tsx | ✅ Complete |
| 2F | Simplify Canvas.tsx (~164 lines) | ✅ Complete |

---

## Master Architecture Document

**📋 See [CANVAS_RUNTIME_END_GOAL.md](./CANVAS_RUNTIME_END_GOAL.md)** for:
- Complete end-state architecture vision
- CanvasRuntime class specification
- Tool singleton pattern
- MMB pan unification strategy
- etc.

---

## Phase 2B Prerequisites ✅ COMPLETE

**Goal:** Prepare tools and render loops for the full runtime transition by creating a unified PointerTool interface and updating all tools to implement it.

### What Was Done

#### 1. Created `PointerTool` Interface

**Location:** `client/src/lib/tools/types.ts`

Unified interface for all tools that handle pointer gestures:

```typescript
export interface PointerTool {
  canBegin(): boolean;
  begin(pointerId: number, worldX: number, worldY: number): void;
  move(worldX: number, worldY: number): void;
  end(worldX?: number, worldY?: number): void;
  cancel(): void;
  isActive(): boolean;
  getPointerId(): number | null;
  getPreview(): PreviewData | null;
  onPointerLeave(): void;   // NEW: Called when pointer leaves canvas
  onViewChange(): void;     // NEW: Called when view transform changes
  destroy(): void;
}
```

#### 2. Updated RenderLoop - Truly Zero-Arg

**Before:**
```typescript
export interface RenderLoopConfig {
  _placeholder?: never;
}
start(config: RenderLoopConfig = {}): void
```

**After:**
```typescript
// No config interface - removed entirely
start(): void  // No arguments!
```

- Removed `RenderLoopConfig` interface
- Changed internal `this.config` to `this.started` boolean
- Updated all guards from `if (!this.config)` to `if (!this.started)`

#### 3. Updated OverlayRenderLoop - Truly Zero-Arg

Same changes as RenderLoop:
- Removed `OverlayLoopConfig` interface
- Changed `this.config` to `this.started` boolean
- `start()` now takes no arguments

#### 4. Updated SelectTool - Hover in move()

**Key change:** Hover cursor detection moved INTO `move()` method:

```typescript
move(worldX: number, worldY: number): void {
  switch (this.phase) {
    case 'idle': {
      // Handle hover cursor when not in a gesture
      this.handleHoverCursor(worldX, worldY);
      break;
    }
    // ... other phases
  }
}
```

- Added `case 'idle':` to `move()` switch statement
- Added private `handleHoverCursor()` method
- Renamed `clearHover()` → `onPointerLeave()`
- Removed public `updateHoverCursor()` (no longer needed)

#### 5. Updated EraserTool

- Renamed `clearHover()` → `onPointerLeave()`
- Kept existing `onViewChange()` (re-computes hit test)

#### 6. Updated DrawingTool

Added no-op implementations:
```typescript
onPointerLeave(): void {
  // DrawingTool has no hover state to clear
}

onViewChange(): void {
  // DrawingTool doesn't need to reposition on view change
}
```

#### 7. Updated PanTool

Added no-op implementations:
```typescript
onPointerLeave(): void {
  // PanTool has no hover state to clear
}

onViewChange(): void {
  // PanTool doesn't need to reposition on view change
  // (it's driving the view change!)
}
```

#### 8. Updated TextTool

Added no-op:
```typescript
onPointerLeave(): void {
  // TextTool has no hover state to clear
  // DOM editor handles its own focus/blur
}
```

(TextTool already had `onViewChange()` for DOM repositioning)

#### 9. Added Helpers to room-runtime.ts

```typescript
export function updatePresenceCursor(worldX: number, worldY: number): void {
  getActiveRoomDoc().updateCursor(worldX, worldY);
}

export function clearPresenceCursor(): void {
  getActiveRoomDoc().updateCursor(undefined, undefined);
}
```

#### 10. Added Helpers to camera-store.ts

```typescript
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

#### 11. Updated Canvas.tsx

- Removed special case for `SelectTool.updateHoverCursor()` (now in `move()`)
- Changed `clearHover` calls to `onPointerLeave` calls

### Files Modified

```
client/src/lib/tools/types.ts          - Added PointerTool interface
client/src/renderer/RenderLoop.ts      - Removed config, truly zero-arg start()
client/src/renderer/OverlayRenderLoop.ts - Removed config, truly zero-arg start()
client/src/lib/tools/SelectTool.ts     - Hover in move(), onPointerLeave
client/src/lib/tools/EraserTool.ts     - Renamed clearHover → onPointerLeave
client/src/lib/tools/DrawingTool.ts    - Added onPointerLeave, onViewChange no-ops
client/src/lib/tools/PanTool.ts        - Added onPointerLeave, onViewChange no-ops
client/src/lib/tools/TextTool.ts       - Added onPointerLeave no-op
client/src/canvas/room-runtime.ts      - Added presence cursor helpers
client/src/stores/camera-store.ts      - Added capturePointer, releasePointer
client/src/canvas/Canvas.tsx           - Updated to use onPointerLeave
```

### Known Issues (Tests Outdated)

The following test files have outdated code and will be removed:
- `RenderLoop.test.ts` - Still passes config to `start()`
- `Canvas.test.tsx` - Unused React import

These tests are outdated and will be deleted as part of test cleanup.

### Success Criteria ✅

1. ✅ `PointerTool` interface created in types.ts
2. ✅ All tools have `onPointerLeave()` method
3. ✅ All tools have `onViewChange()` method
4. ✅ SelectTool hover cursor moved into `move()` - no external special case
5. ✅ RenderLoop.start() takes no arguments
6. ✅ OverlayRenderLoop.start() takes no arguments
7. ✅ Presence cursor helpers added to room-runtime
8. ✅ Pointer capture helpers added to camera-store
9. ✅ Canvas.tsx updated to use `onPointerLeave` instead of `clearHover`

---

## Phase 2B: Tool Registry & CanvasRuntime Shell ✅ COMPLETE

**Goal:** Create tool-registry.ts with self-constructing singletons, update OverlayRenderLoop to self-manage preview, create CanvasRuntime and InputManager shells.

### What Was Done

#### 1. Created `tool-registry.ts`

**Location:** `client/src/canvas/tool-registry.ts`

Module that creates and exports tool singletons at module load time:

```typescript
// Singletons - constructed at module load
const drawingTool = new DrawingTool();
const eraserTool = new EraserTool();
const textTool = new TextTool();
const panTool = new PanTool();
const selectTool = new SelectTool();

// Helpers
export function getCurrentTool(): PointerTool | undefined;
export function getToolById(toolId: ToolId): PointerTool | undefined;
export function getActivePreview(): PreviewData | null;
export function canStartMMBPan(): boolean;

// Direct export for MMB pan
export { panTool };
```

#### 2. Rewrote `PanTool.ts` - World Coordinate Interface

**Key change:** PanTool now receives world coordinates like all other tools and converts to screen internally for delta calculation.

Key insight: `worldToCanvas(screenToWorld(S)) = S` always! Even when pan changes mid-gesture, converting world→screen gives the correct screen position.

```typescript
export class PanTool implements PointerTool {
  private lastScreen: [number, number] | null = null;

  begin(pointerId: number, worldX: number, worldY: number): void {
    // Convert world to screen and store
    this.lastScreen = worldToCanvas(worldX, worldY);
    // ...
  }

  move(worldX: number, worldY: number): void {
    // Convert world to screen for accurate delta
    const currentScreen = worldToCanvas(worldX, worldY);
    const dx = currentScreen[0] - this.lastScreen[0];
    const dy = currentScreen[1] - this.lastScreen[1];
    // ...
  }
}
```

- Removed `updatePan(clientX, clientY)` method
- No more clientX/clientY parameters in begin()
- Unified interface - no special casing needed

#### 3. Added `implements PointerTool` to All Tools

All tools now explicitly implement the PointerTool interface:
- `DrawingTool implements PointerTool`
- `EraserTool implements PointerTool`
- `TextTool implements PointerTool`
- `PanTool implements PointerTool`
- `SelectTool implements PointerTool`

#### 4. Updated `OverlayRenderLoop.ts` - Self-Managed Preview

**Key changes:**
- Removed `setPreviewProvider()` method and `PreviewProvider` interface
- Removed `previewProvider` field
- Now reads preview directly from tool-registry via `getActivePreview()`
- Subscribes to device-ui-store for tool changes to clear cached preview

```typescript
// Before (external provider)
const preview = this.previewProvider?.getPreview();

// After (self-managed via tool-registry)
const preview = getActivePreview();
```

#### 5. Created `InputManager.ts` Shell

**Location:** `client/src/canvas/InputManager.ts`

Dumb DOM event forwarder - only attaches/detaches listeners and forwards raw events to CanvasRuntime:

```typescript
export class InputManager {
  constructor(private runtime: CanvasRuntime) {}
  attach(): void;
  detach(): void;
  // Forwards: pointerdown, pointermove, pointerup, pointercancel,
  //           pointerleave, lostpointercapture, wheel
}
```

#### 6. Created `CanvasRuntime.ts` Shell

**Location:** `client/src/canvas/CanvasRuntime.ts`

The "brain" of the canvas system - shell with full event handler implementations:

```typescript
export class CanvasRuntime {
  start(config: RuntimeConfig): void;
  stop(): void;

  // Event handlers (called by InputManager)
  handlePointerDown(e: PointerEvent): void;
  handlePointerMove(e: PointerEvent): void;
  handlePointerUp(e: PointerEvent): void;
  handlePointerCancel(e: PointerEvent): void;
  handlePointerLeave(e: PointerEvent): void;
  handleLostPointerCapture(e: PointerEvent): void;
  handleWheel(e: WheelEvent): void;
}
```

Features:
- Uses `getCurrentTool()` and `panTool` from tool-registry
- MMB pan via `canStartMMBPan()` helper
- Coordinates converted via `screenToWorld()`
- Presence cursor updates via room-runtime helpers
- Wheel zoom via ZoomAnimator

#### 7. Updated `Canvas.tsx`

- Removed `setPreviewProvider()` calls (now self-managed)
- OverlayRenderLoop preview coupling removed

### Files Modified

```
client/src/canvas/tool-registry.ts      - NEW: Tool singletons
client/src/canvas/InputManager.ts       - NEW: Dumb event forwarder
client/src/canvas/CanvasRuntime.ts      - NEW: Central orchestrator shell
client/src/lib/tools/PanTool.ts         - Rewritten with world coords
client/src/lib/tools/DrawingTool.ts     - Added implements PointerTool
client/src/lib/tools/EraserTool.ts      - Added implements PointerTool
client/src/lib/tools/TextTool.ts        - Added implements PointerTool
client/src/lib/tools/SelectTool.ts      - Added implements PointerTool
client/src/renderer/OverlayRenderLoop.ts - Self-managed preview
client/src/canvas/Canvas.tsx            - Removed setPreviewProvider calls
```

### Success Criteria ✅

1. ✅ `tool-registry.ts` created with self-constructing singletons
2. ✅ All tools `implements PointerTool`
3. ✅ PanTool uses world coords (converts to screen internally)
4. ✅ OverlayRenderLoop self-manages preview via `getActivePreview()`
5. ✅ `InputManager.ts` created (dumb event forwarder)
6. ✅ `CanvasRuntime.ts` created with full event handler implementations
7. ✅ `canStartMMBPan()` helper for gesture blocking
8. ✅ All typecheck passes

---

## Phase 2E/2F: Canvas.tsx Simplified ✅ COMPLETE

**Goal:** Wire CanvasRuntime into Canvas.tsx and remove all duplicated logic.

### What Was Done

#### 1. Rewrote Canvas.tsx (~164 lines, down from ~730)

Canvas.tsx is now a thin React wrapper that only:
- Mounts DOM elements (canvases + editor host div)
- Sets room context via `setActiveRoom()`
- Sets editor host via `setEditorHost()`
- Subscribes to snapshots for dirty rect invalidation
- Creates/destroys CanvasRuntime on mount/unmount
- Updates cursor on tool switch

#### 2. Removed from Canvas.tsx

| Removed | Why |
|---------|-----|
| Tool construction | Tools are singletons in tool-registry |
| Event handlers | Moved to InputManager/CanvasRuntime |
| `mmbPanRef` | Unified in panTool singleton |
| `suppressToolPreviewRef` | No longer needed |
| `activeToolRef` | Not needed - read from store |
| `toolRef` | Tools are singletons |
| `lastMouseClientRef` | Legacy eraser seeding removed |
| `snapshotRef` | Not needed |
| Render loop creation | CanvasRuntime owns these |
| SurfaceManager creation | CanvasRuntime owns this |
| Context registration | CanvasRuntime does this |
| Camera subscription | CanvasRuntime handles tool view changes |

#### 3. Added `holdPreviewForOneFrame()` to invalidation-helpers.ts

```typescript
export function setHoldPreviewFn(fn: (() => void) | null): void;
export function holdPreviewForOneFrame(): void;
```

Called during snapshot subscription to prevent preview flash on commit.

#### 4. Updated CanvasRuntime to register holdPreviewFn

```typescript
setHoldPreviewFn(() => this.overlayLoop?.holdPreviewForOneFrame());
```

### Files Modified

```
client/src/canvas/Canvas.tsx             - Simplified to ~164 lines
client/src/canvas/CanvasRuntime.ts       - Registers holdPreviewFn
client/src/canvas/invalidation-helpers.ts - Added holdPreviewForOneFrame
```

### Success Criteria ✅

1. ✅ Canvas.tsx < 200 lines (164 lines achieved)
2. ✅ No tool construction in Canvas.tsx
3. ✅ No event handlers in Canvas.tsx
4. ✅ CanvasRuntime orchestrates everything
5. ✅ Tools are true singletons via tool-registry
6. ✅ All typecheck passes

---

## Phase 2A: CanvasStage Elimination ✅ COMPLETE

(Previous documentation preserved below for reference)

**Goal:** Delete `CanvasStage.tsx` and React imperative handles, create SurfaceManager for resize/DPR logic, update render loops to read from module registries.

### What Was Done

#### 1. Created `SurfaceManager.ts`

**Location:** `client/src/canvas/SurfaceManager.ts`

Imperative class that handles resize observation and DPR changes. Will be owned by CanvasRuntime in future phases.

```typescript
export class SurfaceManager {
  private container: HTMLElement;
  private baseCanvas: HTMLCanvasElement;
  private overlayCanvas: HTMLCanvasElement;
  private resizeObserver: ResizeObserver | null = null;
  private dprCleanup: (() => void) | null = null;
  private currentDpr = window.devicePixelRatio || 1;

  constructor(container, baseCanvas, overlayCanvas) { ... }

  start(): void {
    // Single ResizeObserver on container (not individual canvases)
    // DPR change listener with recursive re-setup
    // Triggers initial sizing
  }

  stop(): void { ... }

  private updateCanvasSize(cssWidth, cssHeight, dpr): void {
    // CRITICAL FIX: Compute effective DPR when dimensions are clamped
    // This fixes bug where camera store received raw DPR but canvas was clamped
    const effectiveDpr = Math.min(pixelW / cssWidth, pixelH / cssHeight);

    // Only set if changed (setting dimensions clears canvas!)
    // Update camera store with EFFECTIVE DPR
    useCameraStore.getState().setViewport(cssWidth, cssHeight, effectiveDpr);
  }

  private setupDprListener(): () => void { ... }
}
```

**Key improvements:**
- Single ResizeObserver on container (not per-canvas)
- **Fixes effective DPR bug** - computes actual DPR when clamped to MAX_CANVAS_DIMENSION
- Recursive DPR listener re-setup for device changes
- Atomic update of both canvases

#### 2. Created `canvas-context-registry.ts`

**Location:** `client/src/canvas/canvas-context-registry.ts`

Module-level storage for canvas 2D contexts, following same pattern as room-runtime.ts and cursor-manager.ts.

```typescript
let baseCtx: CanvasRenderingContext2D | null = null;
let overlayCtx: CanvasRenderingContext2D | null = null;

export function setBaseContext(ctx: CanvasRenderingContext2D | null): void;
export function setOverlayContext(ctx: CanvasRenderingContext2D | null): void;
export function getBaseContext(): CanvasRenderingContext2D | null;
export function getOverlayContext(): CanvasRenderingContext2D | null;
```

#### 3. Extended `room-runtime.ts`

Added convenience wrappers for render loops to read snapshot and gates directly:

```typescript
export type GateStatus = ReturnType<IRoomDocManager['getGateStatus']>;

export function getCurrentSnapshot(): Snapshot {
  return getActiveRoomDoc().currentSnapshot;
}

export function getGateStatus(): GateStatus {
  return getActiveRoomDoc().getGateStatus();
}
```

#### 4. Added `isMobile()` to `camera-store.ts`

```typescript
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

#### 5-7. Updated Render Loops and Canvas.tsx

(See previous documentation - render loops now read from modules, Canvas.tsx uses raw canvas elements)

#### 8. Deleted Files

- `client/src/canvas/CanvasStage.tsx` - **DELETED**
- `client/src/canvas/internal/context2d.ts` - **DELETED**
- `client/src/canvas/__tests__/CanvasStage.test.tsx` - **DELETED**

---

## Completed Phases (Summary)

### Phase 1: Runtime Modules (Foundation)

Created 4 new modules in `client/src/canvas/`:

| Module | Purpose | Status |
|--------|---------|--------|
| `room-runtime.ts` | `getActiveRoomDoc()` for imperative room access | ✅ Wired in Canvas.tsx |
| `invalidation-helpers.ts` | `invalidateOverlay()` / `invalidateWorld()` | ✅ Wired in Canvas.tsx |
| `cursor-manager.ts` | `applyCursor()` / `setCursorOverride()` | ✅ Wired in Canvas.tsx |
| `editor-host-registry.ts` | `getEditorHost()` for TextTool DOM | ✅ Wired in Canvas.tsx |

### Phase 1.5: All Tools Zero-Arg ✅

| Tool | Constructor Args | Status |
|------|-----------------|--------|
| `DrawingTool` | Zero-arg | ✅ Complete |
| `EraserTool` | Zero-arg | ✅ Complete |
| `TextTool` | Zero-arg | ✅ Complete |
| `PanTool` | Zero-arg | ✅ Complete |
| `SelectTool` | Zero-arg | ✅ Complete |

### Phase 1.6: Explicit Transforms ✅

All render loop passes now use explicit `ctx.setTransform()` with full DPR × scale × translate matrix combined. No more implicit DPR from CanvasStage.

---

## Current State: Canvas.tsx

**After Phase 2E/2F (CURRENT):**
- Thin React wrapper (~164 lines)
- Creates CanvasRuntime which owns everything
- Sets room context and editor host
- Subscribes to snapshots for dirty rects
- Updates cursor on tool switch

**Canvas.tsx now ONLY does:**
- Mount DOM elements (canvases + editor host)
- Set room context (`setActiveRoom`)
- Set editor host (`setEditorHost`)
- Dirty rect invalidation (snapshot subscription)
- Cursor update on tool switch (`applyCursor`)

**Everything else moved to CanvasRuntime:**
- Tool dispatch (via tool-registry singletons)
- Event handling (via InputManager)
- Render loop management
- SurfaceManager ownership
- Camera subscription for tool view changes

---

## Architecture Diagram (Current State)

```
Canvas.tsx (~164 lines) - THIN REACT WRAPPER
├── Mounts raw <canvas> elements + editor host div
├── Sets room context (setActiveRoom)
├── Sets editor host (setEditorHost)
├── Creates CanvasRuntime
├── Subscribes to snapshots (dirty rects)
└── Updates cursor on tool switch

                │
                ▼

CanvasRuntime.ts (THE BRAIN)
├── Creates SurfaceManager (resize/DPR)
├── Creates RenderLoop + OverlayRenderLoop
├── Creates ZoomAnimator
├── Creates InputManager (event listener attachment)
├── Handles all pointer events
├── Dispatches to tools via tool-registry
├── MMB pan via panTool singleton
└── Camera subscription for tool view changes

                │
                ▼

InputManager.ts (DUMB DOM LAYER)
└── Forwards raw events to CanvasRuntime

                │
                ▼

tool-registry.ts (SELF-CONSTRUCTING SINGLETONS)
├── drawingTool   - pen, highlighter, shape
├── eraserTool
├── textTool
├── panTool       - MMB pan + dedicated tool
└── selectTool

Module Registries (Imperative Access)
├── room-runtime.ts        → getActiveRoomDoc(), updatePresenceCursor(), clearPresenceCursor()
├── canvas-context-registry.ts → getBaseContext(), getOverlayContext()
├── camera-store.ts        → transforms, viewport, capturePointer(), releasePointer()
├── cursor-manager.ts      → applyCursor(), setCursorOverride()
├── invalidation-helpers.ts → invalidateWorld(), invalidateOverlay(), holdPreviewForOneFrame()
└── editor-host-registry.ts → getEditorHost()
```

---

## Test Commands

```bash
npm run typecheck  # From project root 
```
