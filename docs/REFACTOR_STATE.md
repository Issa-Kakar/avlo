# Canvas Runtime Refactor - State & Architecture

**Last Updated:** Phase 2 Complete - Core refactor done, cursor-manager self-subscribing

---

## Progress Summary

| Phase | Description | Status |
|-------|-------------|--------|
| 1.0 | Runtime Modules (room-runtime, cursor-manager, etc.) | ✅ Complete |
| 1.5 | All tools zero-arg constructors | ✅ Complete |
| 1.6 | Explicit transforms in render loops | ✅ Complete |
| 2A | Eliminate CanvasStage & Imperative Handle | ✅ Complete |
| 2B | Tool Registry, PointerTool interface, Preview Coupling | ✅ Complete |
| 2C-2G | CanvasRuntime, InputManager, Canvas.tsx simplification | ✅ Complete |
| 2H | Cursor-manager self-subscription | ✅ Complete |

---

## Architecture Overview

```
Canvas.tsx (~105 lines) - THIN REACT WRAPPER
│   Only does: mount DOM, set room context, set editor host, create runtime
│
├── setActiveRoom(roomId, roomDoc)     → room-runtime.ts
├── setEditorHost(div)                 → editor-host-registry.ts
└── new CanvasRuntime().start()
                │
                ▼
CanvasRuntime.ts (~280 lines) - THE BRAIN
│   Owns all subsystems, handles events, manages subscriptions
│
├── SurfaceManager        - resize/DPR observation
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
├── canvas-context-registry.ts → getBaseContext(), getOverlayContext()
├── camera-store.ts           → transforms, viewport, pointer capture
├── cursor-manager.ts         → applyCursor(), setCursorOverride()
│                               └─ SELF-SUBSCRIBES to device-ui-store
├── invalidation-helpers.ts   → invalidateWorld(), invalidateOverlay()
└── editor-host-registry.ts   → getEditorHost() for TextTool
```

---

## Core Files

### Canvas.tsx (~105 lines)
**Purpose:** Minimal React wrapper that bridges React lifecycle to imperative runtime.

**Responsibilities:**
- Renders 3 DOM elements: base canvas, overlay canvas, editor host div
- Sets room context via `setActiveRoom()` (tools need `getActiveRoomDoc()`)
- Sets editor host via `setEditorHost()` (TextTool mounts DOM here)
- Creates/destroys CanvasRuntime on mount/unmount

**Does NOT do:** Event handling, tool logic, subscriptions, cursor management.

---

### CanvasRuntime.ts (~280 lines)
**Purpose:** Central orchestrator - the "brain" of the canvas system.

**Initialization (`start()`):**
1. Get 2D contexts, register in `canvas-context-registry`
2. Register canvas element in `camera-store` (for coordinate transforms)
3. Call `applyCursor()` once for initial cursor based on persisted tool
4. Create SurfaceManager → starts resize/DPR observation
5. Create RenderLoop + OverlayRenderLoop → register invalidators
6. Create ZoomAnimator
7. Create InputManager → attaches DOM event listeners
8. Subscribe to camera-store → calls `tool.onViewChange()` on pan/zoom
9. Subscribe to snapshots → dirty rect invalidation + cache eviction

**Event Handling:**
- `handlePointerDown`: MMB (button 1) → `panTool.begin()`, LMB (button 0) → `getCurrentTool().begin()`
- `handlePointerMove`: Update presence cursor, forward to active tool's `move()`
- `handlePointerUp`: Release pointer capture, call tool's `end()`
- `handleWheel`: Calculate zoom transform, animate via ZoomAnimator

**MMB Pan:** Uses `panTool` singleton directly. `canStartMMBPan()` blocks if another gesture is active.

---

### InputManager.ts (~70 lines)
**Purpose:** Dumb DOM event forwarder. Zero intelligence.

**Pattern:** Attach listeners on `attach()`, forward raw events to CanvasRuntime methods, detach on `detach()`.

**Events forwarded:** pointerdown, pointermove, pointerup, pointercancel, pointerleave, lostpointercapture, wheel

**Does NOT do:** Coordinate conversion, tool selection, state tracking, gesture blocking.

---

### SurfaceManager.ts (~120 lines)
**Purpose:** Imperative resize and DPR handling for dual-canvas setup.

**Key Features:**
- Single ResizeObserver on container (not individual canvases)
- DPR change listener with recursive re-setup for device switches
- Computes **effective DPR** when dimensions are clamped to MAX_CANVAS_DIMENSION
- Updates camera-store viewport which triggers render loop invalidation

**Critical Fix:** When canvas dimensions are clamped, the effective DPR differs from `window.devicePixelRatio`. Camera-store receives the effective value so transforms are correct.

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

These modules provide imperative access to values that would otherwise require React context or prop drilling. Pattern: module-level variable + getter/setter functions.

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

### canvas-context-registry.ts (~44 lines)
**Purpose:** 2D rendering contexts for render loops.

**Set by:** CanvasRuntime.start() via `setBaseContext()`, `setOverlayContext()`

**Exports:** `getBaseContext()`, `getOverlayContext()` → CanvasRenderingContext2D | null

---

### editor-host-registry.ts (~33 lines)
**Purpose:** DOM element for TextTool to mount editors.

**Set by:** Canvas.tsx via `setEditorHost(div)`

**Exports:** `getEditorHost()` → HTMLDivElement | null

---

### cursor-manager.ts (~79 lines)
**Purpose:** Centralized cursor control with priority system.

**Priority:** Manual override (e.g., 'grabbing' during pan) > Tool-based cursor

**Cursor Mapping:**
- `eraser` → custom cursor URL
- `pan` → 'grab'
- `select` → 'default'
- `text` → 'text'
- default → 'crosshair'

**Self-Subscribes:** At module load, subscribes to `device-ui-store`. When `activeTool` changes, calls `applyCursor()`. CanvasRuntime only calls `applyCursor()` once at startup for initial cursor.

**Exports:**
- `applyCursor()` → apply current cursor to canvas element
- `setCursorOverride(cursor)` → set manual override (pass null to clear)

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
   ├─ useLayoutEffect: setEditorHost(div)
   └─ useLayoutEffect: new CanvasRuntime().start()
                         │
2. CanvasRuntime.start()
   │
   ├─ Get 2D contexts → setBaseContext(), setOverlayContext()
   ├─ setCanvasElement(baseCanvas)  // for coordinate transforms
   ├─ applyCursor()                 // initial cursor from persisted tool
   │
   ├─ SurfaceManager.start()
   │   └─ ResizeObserver + DPR listener → updates camera-store
   │
   ├─ RenderLoop.start() + setWorldInvalidator()
   ├─ OverlayRenderLoop.start() + setOverlayInvalidator()
   │
   ├─ InputManager.attach()  // DOM listeners now active
   │
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

## Next Focus: Module Consolidation

The refactor is functionally complete. Future work explores consolidating helper modules.

### Options to Explore

**1. RenderController Pattern**
- SurfaceManager → `RenderController` that owns both RenderLoops
- Centralizes: snapshot subscription, dirty rect invalidation, camera subscription
- Since loops are zero-dependency, could inject ctx at render time
- RenderLoops could become true singletons (one per app, not per room)

**2. Cursor-Manager → device-ui-store**
- Cursor logic is derived from `activeTool`
- Could merge into device-ui-store as a computed/derived value
- Store already owns tool state

**3. DOM Registry Merge**
- `canvas-context-registry.ts` + `editor-host-registry.ts` → `dom-registry.ts`
- Both are simple "store a DOM reference" patterns

**4. Direct Invalidation Export**
- Circular deps only matter if values read at import time
- Runtime calls (inside functions) can reference anything
- Could export render loop refs directly, tools import and call

### Key Constraint
- `tool-registry` creates tools at module load (before CanvasRuntime exists)
- Circular deps are only problematic if values are read at import time
- Runtime calls can reference anything - the indirection may be unnecessary

---

## Test Commands

```bash
npm run typecheck  # From project root
```
