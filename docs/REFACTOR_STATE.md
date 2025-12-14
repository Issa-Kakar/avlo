# Canvas Runtime Refactor - State & Architecture

**Last Updated:** Phase 3 Complete - Module consolidation done

---

## Progress Summary

| Phase | Description | Status |
|-------|-------------|--------|
| 1.0 | Runtime Modules (room-runtime, etc.) | ✅ Complete |
| 1.5 | All tools zero-arg constructors | ✅ Complete |
| 1.6 | Explicit transforms in render loops | ✅ Complete |
| 2A | Eliminate CanvasStage & Imperative Handle | ✅ Complete |
| 2B | Tool Registry, PointerTool interface, Preview Coupling | ✅ Complete |
| 2C-2G | CanvasRuntime, InputManager, Canvas.tsx simplification | ✅ Complete |
| 2H | Cursor-manager self-subscription | ✅ Complete |
| 3.0 | Module Consolidation | ✅ Complete |

### Phase 3 Consolidation Summary

**Files Deleted (3):**
- `cursor-manager.ts` → merged into `device-ui-store.ts`
- `canvas-context-registry.ts` → merged into `SurfaceManager.ts`
- `editor-host-registry.ts` → merged into `SurfaceManager.ts`

**Result:** 10 canvas files → 7 files

---

## Architecture Overview

```
Canvas.tsx (~95 lines) - THIN REACT WRAPPER
│   Only does: mount DOM, set room context, create runtime
│
├── setActiveRoom(roomId, roomDoc)     → room-runtime.ts
└── new CanvasRuntime().start({ container, baseCanvas, overlayCanvas, editorHost })
                │
                ▼
CanvasRuntime.ts (~280 lines) - THE BRAIN
│   Owns all subsystems, handles events, manages subscriptions
│
├── SurfaceManager        - ALL DOM refs + resize/DPR observation
│   ├── baseCtx, overlayCtx (module-level)
│   ├── editorHost (module-level)
│   ├── setCanvasElement() → camera-store
│   └── applyCursor() → device-ui-store
│
├── RenderLoop            - base canvas 60fps, dirty rect optimization
├── OverlayRenderLoop     - preview + presence, full clear each frame
├── ZoomAnimator          - smooth zoom transitions
├── InputManager          - dumb DOM event forwarder
│
├── Subscriptions:
│   ├── camera-store      → tool.onViewChange() on pan/zoom
│   └── snapshot          → dirty rect invalidation, cache eviction
│
└── Event Handlers:
    ├── handlePointerDown → tool dispatch or MMB pan
    ├── handlePointerMove → presence cursor + tool.move()
    ├── handlePointerUp   → tool.end()
    ├── handleWheel       → zoom via ZoomAnimator
    └── handlePointerLeave → clear presence, tool.onPointerLeave()

                │
                ▼
tool-registry.ts - SELF-CONSTRUCTING SINGLETONS
│   Tools created at module load, persist for app lifetime
│
├── drawingTool  (handles: pen, highlighter, shape)
├── eraserTool
├── textTool
├── panTool      (used by both dedicated mode AND MMB)
└── selectTool

                │
                ▼
Module Registries - IMPERATIVE ACCESS PATTERNS
├── room-runtime.ts           → getActiveRoomDoc(), presence helpers
├── camera-store.ts           → transforms, viewport, pointer capture, canvas element
├── device-ui-store.ts        → tool state, cursor management (applyCursor, setCursorOverride)
├── SurfaceManager.ts         → getBaseContext(), getOverlayContext(), getEditorHost()
└── invalidation-helpers.ts   → invalidateWorld(), invalidateOverlay()
```

---

## Core Files

### Canvas.tsx (~95 lines)
**Purpose:** Minimal React wrapper that bridges React lifecycle to imperative runtime.

**Responsibilities:**
- Renders 3 DOM elements: base canvas, overlay canvas, editor host div
- Sets room context via `setActiveRoom()` (tools need `getActiveRoomDoc()`)
- Creates/destroys CanvasRuntime on mount/unmount, passing all 4 DOM refs

**Does NOT do:** Event handling, tool logic, subscriptions, cursor management, editor host setup.

---

### CanvasRuntime.ts (~280 lines)
**Purpose:** Central orchestrator - the "brain" of the canvas system.

**RuntimeConfig:**
```typescript
interface RuntimeConfig {
  container: HTMLElement;
  baseCanvas: HTMLCanvasElement;
  overlayCanvas: HTMLCanvasElement;
  editorHost: HTMLDivElement;
}
```

**Initialization (`start()`):**
1. Create SurfaceManager with all 4 DOM refs
2. SurfaceManager.start() handles:
   - Getting and storing 2D contexts
   - Setting editor host for TextTool
   - Setting canvas element for coordinate transforms
   - Applying initial cursor
   - Starting resize/DPR observation
3. Create RenderLoop + OverlayRenderLoop → register invalidators
4. Create ZoomAnimator
5. Create InputManager → attaches DOM event listeners
6. Subscribe to camera-store → calls `tool.onViewChange()` on pan/zoom
7. Subscribe to snapshots → dirty rect invalidation + cache eviction

**Event Handling:**
- `handlePointerDown`: MMB (button 1) → `panTool.begin()`, LMB (button 0) → `getCurrentTool().begin()`
- `handlePointerMove`: Update presence cursor, forward to active tool's `move()`
- `handlePointerUp`: Release pointer capture, call tool's `end()`
- `handleWheel`: Calculate zoom transform, animate via ZoomAnimator

**MMB Pan:** Uses `panTool` singleton directly. `canStartMMBPan()` blocks if another gesture is active.

---

### SurfaceManager.ts (~170 lines)
**Purpose:** Single owner of all canvas-related DOM refs + resize/DPR handling.

**Module-Level Refs (set by start(), cleared by stop()):**
```typescript
let baseCtx: CanvasRenderingContext2D | null = null;
let overlayCtx: CanvasRenderingContext2D | null = null;
let editorHost: HTMLDivElement | null = null;
```

**Exports:**
- `getBaseContext()` → 2D context for base canvas (used by RenderLoop)
- `getOverlayContext()` → 2D context for overlay canvas (used by OverlayRenderLoop)
- `getEditorHost()` → DOM element for TextTool editor mounting
- `setEditorHost()` → setter (only used internally now)

**start() Flow:**
1. Get and store 2D contexts
2. Set editor host
3. `setCanvasElement(baseCanvas)` → camera-store (for coordinate transforms)
4. `applyCursor()` → device-ui-store (initial cursor from persisted tool)
5. Start ResizeObserver on container
6. Start DPR change listener

**stop() Flow:**
1. Disconnect ResizeObserver
2. Clear DPR listener
3. Clear all module-level refs (baseCtx, overlayCtx, editorHost)
4. `setCanvasElement(null)`

**Critical Fix:** When canvas dimensions are clamped to MAX_CANVAS_DIMENSION, computes **effective DPR** so camera-store transforms remain correct.

---

### InputManager.ts (~70 lines)
**Purpose:** Dumb DOM event forwarder. Zero intelligence.

**Pattern:** Attach listeners on `attach()`, forward raw events to CanvasRuntime methods, detach on `detach()`.

**Events forwarded:** pointerdown, pointermove, pointerup, pointercancel, pointerleave, lostpointercapture, wheel

**Does NOT do:** Coordinate conversion, tool selection, state tracking, gesture blocking.

---

### tool-registry.ts (~107 lines)
**Purpose:** Self-constructing tool singletons + lookup helpers.

**Singletons (created at module load):**
```typescript
const drawingTool = new DrawingTool();  // handles pen, highlighter, shape
const eraserTool = new EraserTool();
const textTool = new TextTool();
const panTool = new PanTool();
const selectTool = new SelectTool();
```

**Helpers:**
- `getCurrentTool()` → reads `activeTool` from device-ui-store, returns tool instance
- `getToolById(id)` → direct lookup by tool ID
- `getActivePreview()` → gets preview from current tool (used by OverlayRenderLoop)
- `canStartMMBPan()` → returns false if panTool active OR another tool is mid-gesture

**Key Insight:** Tools are never destroyed/recreated on tool switch. `'pen'`, `'highlighter'`, `'shape'` all map to the same DrawingTool instance.

---

## Module Registries

These modules provide imperative access to values that would otherwise require React context or prop drilling.

### room-runtime.ts (~107 lines)
**Purpose:** Active room context for tools and render loops.

**Set by:** Canvas.tsx via `setActiveRoom({ roomId, roomDoc })`

**Exports:**
- `getActiveRoomDoc()` → IRoomDocManager (throws if no room)
- `getCurrentSnapshot()` → current Y.Doc snapshot
- `getGateStatus()` → initialization gates (idbReady, wsConnected, etc.)
- `updatePresenceCursor(worldX, worldY)` → update cursor in awareness
- `clearPresenceCursor()` → clear cursor when pointer leaves

---

### camera-store.ts (~350 lines)
**Purpose:** Centralized camera/viewport state + coordinate transforms.

**State:**
```typescript
interface CameraState {
  scale: number;
  pan: { x: number; y: number };
  cssWidth: number;
  cssHeight: number;
  dpr: number;
}
```

**Module-Level Canvas Reference:**
- `setCanvasElement(el)` → called by SurfaceManager.start()
- `getCanvasElement()` → raw element access
- `getCanvasRect()` → bounding rect for coordinate conversion
- `capturePointer(id)` / `releasePointer(id)` → pointer capture helpers

**Transform Functions:**
- `worldToCanvas(x, y)` → world to CSS pixels
- `canvasToWorld(x, y)` → CSS pixels to world
- `screenToCanvas(clientX, clientY)` → client coords to canvas-relative
- `screenToWorld(clientX, clientY)` → client coords to world
- `worldToClient(x, y)` → world to client coords
- `getVisibleWorldBounds()` → viewport in world coords

---

### device-ui-store.ts (~370 lines)
**Purpose:** Toolbar state, drawing settings, and cursor management.

**Cursor State (added in Phase 3):**
```typescript
cursorOverride: string | null;  // e.g., 'grabbing' during pan
setCursorOverride: (cursor: string | null) => void;
```

**Cursor Functions (module-level, after store):**
```typescript
// Compute cursor based on active tool
function computeBaseCursor(): string {
  switch (activeTool) {
    case 'eraser': return 'url("/cursors/avloEraser.cur") 16 16, auto';
    case 'pan': return 'grab';
    case 'select': return 'default';
    case 'text': return 'text';
    default: return 'crosshair';
  }
}

// Apply cursor to canvas element (priority: override > tool-based)
export function applyCursor(): void;
```

**Self-Subscription:** At module load, subscribes to itself. When `activeTool` changes, calls `applyCursor()`. This means cursor updates automatically on tool switch.

**Exports:**
- `applyCursor()` → apply current cursor to canvas element
- `setCursorOverride(cursor)` → set manual override (pass null to clear)

**Used by:**
- `SurfaceManager.start()` → calls `applyCursor()` for initial cursor
- `PanTool` → calls `setCursorOverride('grabbing')` / `setCursorOverride(null)`
- `SelectTool` → calls `setCursorOverride()` for resize cursors

---

### invalidation-helpers.ts (~68 lines)
**Purpose:** Break circular dependencies for render loop invalidation.

**Problem:** Tools need to call `invalidateOverlay()`, but:
- tool-registry imports tools
- CanvasRuntime imports tool-registry
- If tools imported CanvasRuntime → CIRCULAR

**Solution:** Setter/getter pattern. CanvasRuntime registers functions, tools call them.

**Set by:** CanvasRuntime.start() registers:
- `setWorldInvalidator(fn)` → for `invalidateWorld(bounds)`
- `setOverlayInvalidator(fn)` → for `invalidateOverlay()`
- `setHoldPreviewFn(fn)` → for `holdPreviewForOneFrame()`

**Used by:** Tools and other imperative code call `invalidateWorld()`, `invalidateOverlay()`.

---

## PointerTool Interface

All tools implement this unified interface (defined in `lib/tools/types.ts`):

```typescript
interface PointerTool {
  canBegin(): boolean;                              // Can start new gesture?
  begin(pointerId, worldX, worldY): void;           // Start gesture
  move(worldX, worldY): void;                       // Update (also hover when idle)
  end(worldX?, worldY?): void;                      // Complete gesture
  cancel(): void;                                   // Abort without commit
  isActive(): boolean;                              // Gesture in progress?
  getPointerId(): number | null;                    // Active pointer ID
  getPreview(): PreviewData | null;                 // For overlay rendering
  onPointerLeave(): void;                           // Clear hover state
  onViewChange(): void;                             // React to pan/zoom
  destroy(): void;                                  // Cleanup
}
```

**Key Design:** All tools receive **world coordinates**. Tools that need screen coords (like PanTool) convert internally via `worldToCanvas()`.

---

## Initialization Flow

```
1. Canvas.tsx mounts
   │
   ├─ useLayoutEffect: setActiveRoom({ roomId, roomDoc })
   └─ useLayoutEffect: new CanvasRuntime().start({ all 4 refs })
                         │
2. CanvasRuntime.start()
   │
   └─ SurfaceManager(container, baseCanvas, overlayCanvas, editorHost)
      │
3. SurfaceManager.start()
   │
   ├─ Get 2D contexts → store in module-level baseCtx, overlayCtx
   ├─ Set editorHost module-level ref
   ├─ setCanvasElement(baseCanvas) → camera-store
   ├─ applyCursor() → device-ui-store (initial cursor)
   └─ ResizeObserver + DPR listener → updates camera-store viewport
   │
4. Back in CanvasRuntime.start()
   │
   ├─ RenderLoop.start() + setWorldInvalidator()
   ├─ OverlayRenderLoop.start() + setOverlayInvalidator()
   ├─ ZoomAnimator creation
   ├─ InputManager.attach()  // DOM listeners now active
   ├─ camera-store.subscribe() → tool.onViewChange()
   └─ roomDoc.subscribeSnapshot() → dirty rects + cache eviction
```

---

## Data Flow: Pointer Event → Render

```
1. User moves pointer
   │
2. InputManager forwards raw PointerEvent to CanvasRuntime
   │
3. CanvasRuntime.handlePointerMove():
   ├─ screenToWorld(clientX, clientY)
   ├─ updatePresenceCursor(worldX, worldY)
   └─ getCurrentTool().move(worldX, worldY)
         │
4. Tool updates internal state, calls invalidateOverlay()
   │
5. OverlayRenderLoop (next frame):
   ├─ getActivePreview() from tool-registry
   ├─ Renders preview to overlay canvas
   └─ Renders presence cursors
```

---

## File Summary (canvas/ folder)

| File | Lines | Purpose |
|------|-------|---------|
| Canvas.tsx | ~95 | React wrapper - mounts DOM, sets room, creates runtime |
| CanvasRuntime.ts | ~280 | Central orchestrator - events, subscriptions |
| SurfaceManager.ts | ~170 | DOM refs (contexts, editorHost) + resize/DPR |
| InputManager.ts | ~70 | Dumb DOM event forwarder |
| tool-registry.ts | ~107 | Tool singletons + lookup helpers |
| room-runtime.ts | ~107 | Active room context |
| invalidation-helpers.ts | ~68 | Circular dep breaker for invalidation |

**Total:** 7 files, ~900 lines

**Deleted in Phase 3:**
- ~~cursor-manager.ts~~ → device-ui-store.ts
- ~~canvas-context-registry.ts~~ → SurfaceManager.ts
- ~~editor-host-registry.ts~~ → SurfaceManager.ts

---

## Future Considerations

### Potential Further Consolidation

**1. RenderController Pattern**
- SurfaceManager could own both RenderLoops
- Centralizes: snapshot subscription, dirty rect invalidation, camera subscription
- RenderLoops could become true singletons (one per app, not per room)

**2. Direct Invalidation Export**
- Circular deps only matter if values read at import time
- Runtime calls (inside functions) can reference anything
- Could export render loop refs directly from SurfaceManager

### Key Constraint
- `tool-registry` creates tools at module load (before CanvasRuntime exists)
- Circular deps are only problematic if values are read at import time
- Runtime calls can reference anything - the indirection in invalidation-helpers may be unnecessary

---

## Test Commands

```bash
npm run typecheck  # From project root
```
