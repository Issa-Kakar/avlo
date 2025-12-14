# Canvas Module Consolidation Plan

**Goal:** Reduce helper file sprawl now that Canvas.tsx is a thin React wrapper and all logic lives in imperative CanvasRuntime and its subsystems.

---

## Current State Analysis

### File Inventory (canvas/ folder)

| File | Lines | Purpose | Dependencies |
|------|-------|---------|--------------|
| Canvas.tsx | 105 | React wrapper | room-runtime, editor-host-registry, CanvasRuntime |
| CanvasRuntime.ts | 295 | Orchestrator | Everything |
| SurfaceManager.ts | 120 | Resize/DPR | camera-store |
| InputManager.ts | 70 | DOM events | camera-store |
| cursor-manager.ts | 79 | Cursor control | camera-store, device-ui-store |
| canvas-context-registry.ts | 44 | Ctx storage | None |
| editor-host-registry.ts | 33 | Host storage | None |
| invalidation-helpers.ts | 68 | Decouple loops | None |
| room-runtime.ts | 107 | Room context | IRoomDocManager |
| tool-registry.ts | 107 | Tool singletons | device-ui-store, tools |

**Total:** 10 files, ~1028 lines

### Current Setup Flow

```
Canvas.tsx mounts
├─ setActiveRoom()           → room-runtime.ts
├─ setEditorHost()           → editor-host-registry.ts
└─ runtime.start()           → CanvasRuntime.ts
   ├─ getContext(), set*Context()  → canvas-context-registry.ts
   ├─ setCanvasElement()           → camera-store.ts
   ├─ applyCursor()                → cursor-manager.ts
   └─ SurfaceManager.start()       → SurfaceManager.ts
```

---

## Consolidation Strategy

### 1. Merge cursor-manager → device-ui-store

**Rationale:**
- Cursor is derived entirely from `activeTool`
- cursor-manager already self-subscribes to device-ui-store
- device-ui-store already owns tool state
- Makes the store the single source of truth for cursor

**Changes to device-ui-store.ts:**

Add state:
```typescript
cursorOverride: string | null;  // e.g., 'grabbing' during pan
```

Add action:
```typescript
setCursorOverride: (cursor: string | null) => void;
```

Add internal cursor logic (at module level, after store creation):
```typescript
// Cursor derivation (moved from cursor-manager)
function computeBaseCursor(): string {
  const { activeTool } = useDeviceUIStore.getState();
  switch (activeTool) {
    case 'eraser': return 'url("/cursors/avloEraser.cur") 16 16, auto';
    case 'pan': return 'grab';
    case 'select': return 'default';
    case 'text': return 'text';
    default: return 'crosshair';
  }
}

export function applyCursor(): void {
  const canvas = getCanvasElement();
  if (!canvas) return;
  const override = useDeviceUIStore.getState().cursorOverride;
  canvas.style.cursor = override ?? computeBaseCursor();
}

// Self-subscription for tool changes
useDeviceUIStore.subscribe(
  (state, prev) => {
    if (state.activeTool !== prev.activeTool) applyCursor();
  }
);
```

**Delete:** `canvas/cursor-manager.ts`

**Update imports in:**
- CanvasRuntime.ts: `import { applyCursor } from '@/stores/device-ui-store'`
- PanTool.ts: `import { useDeviceUIStore } from '@/stores/device-ui-store'` + `useDeviceUIStore.getState().setCursorOverride(...)`

---

### 2. Merge DOM registries INTO SurfaceManager.ts

**Rationale:**
- SurfaceManager already receives canvas refs and manages their sizing
- Contexts are derived from those canvases - same ownership domain
- No need for separate dom-refs.ts file - just export directly from SurfaceManager
- Single owner pattern: whoever sets something also exports its getter

**Changes to SurfaceManager.ts:**

Add module-level refs and exports:
```typescript
// ============================================
// MODULE-LEVEL DOM REFS
// ============================================

let baseCtx: CanvasRenderingContext2D | null = null;
let overlayCtx: CanvasRenderingContext2D | null = null;
let editorHost: HTMLDivElement | null = null;

/** Get base canvas 2D context. Returns null if not mounted. */
export function getBaseContext(): CanvasRenderingContext2D | null {
  return baseCtx;
}

/** Get overlay canvas 2D context. Returns null if not mounted. */
export function getOverlayContext(): CanvasRenderingContext2D | null {
  return overlayCtx;
}

/** Get editor host div. Returns null if not mounted. */
export function getEditorHost(): HTMLDivElement | null {
  return editorHost;
}

/** Set editor host div. Called by CanvasRuntime.start(). */
export function setEditorHost(el: HTMLDivElement | null): void {
  editorHost = el;
}

// ============================================
// CLASS
// ============================================

export class SurfaceManager {
  // ... existing fields ...

  start(): void {
    // Get and store contexts
    const base = this.baseCanvas.getContext('2d', { willReadFrequently: false });
    const overlay = this.overlayCanvas.getContext('2d', { willReadFrequently: false });
    if (!base || !overlay) throw new Error('Failed to get 2D contexts');
    baseCtx = base;
    overlayCtx = overlay;

    // ... existing resize/DPR logic ...
  }

  stop(): void {
    // Clear contexts
    baseCtx = null;
    overlayCtx = null;

    // ... existing cleanup ...
  }
}
```

**Delete:**
- `canvas/canvas-context-registry.ts`
- `canvas/editor-host-registry.ts`

**Update imports in:**
- RenderLoop.ts: `import { getBaseContext } from '@/canvas/SurfaceManager'`
- OverlayRenderLoop.ts: `import { getOverlayContext } from '@/canvas/SurfaceManager'`
- TextTool.ts: `import { getEditorHost } from '@/canvas/SurfaceManager'`
- CanvasRuntime.ts: `import { setEditorHost } from '@/canvas/SurfaceManager'`
- Canvas.tsx: Remove editor-host-registry import

**No circular dependency issues:**
- RenderLoop/OverlayRenderLoop import from SurfaceManager ✓
- SurfaceManager does NOT import from render loops ✓
- TextTool imports from SurfaceManager ✓
- SurfaceManager does NOT import from tools ✓

---

### 3. Pass editorHost through RuntimeConfig

**Rationale:**
- Canvas.tsx currently calls `setEditorHost()` separately
- Should be passed to runtime.start() for unified setup
- All DOM setup happens in one place

**Changes to Canvas.tsx:**

```diff
- import { setEditorHost } from './editor-host-registry';

- // 2. Set editor host for TextTool DOM access
- useLayoutEffect(() => {
-   setEditorHost(editorHostRef.current);
-   return () => setEditorHost(null);
- }, []);

  // Create and start CanvasRuntime
  useLayoutEffect(() => {
    const container = containerRef.current;
    const baseCanvas = baseCanvasRef.current;
    const overlayCanvas = overlayCanvasRef.current;
-   if (!container || !baseCanvas || !overlayCanvas) return;
+   const editorHost = editorHostRef.current;
+   if (!container || !baseCanvas || !overlayCanvas || !editorHost) return;

    const runtime = new CanvasRuntime();
    runtimeRef.current = runtime;
-   runtime.start({ container, baseCanvas, overlayCanvas });
+   runtime.start({ container, baseCanvas, overlayCanvas, editorHost });

    return () => {
      runtime.stop();
      runtimeRef.current = null;
    };
  }, []);
```

**Changes to CanvasRuntime.ts:**

```typescript
import { setEditorHost } from './SurfaceManager';

export interface RuntimeConfig {
  container: HTMLElement;
  baseCanvas: HTMLCanvasElement;
  overlayCanvas: HTMLCanvasElement;
  editorHost: HTMLDivElement;
}

start(config: RuntimeConfig): void {
  const { container, baseCanvas, overlayCanvas, editorHost } = config;

  // Set editor host for TextTool
  setEditorHost(editorHost);

  // Set canvas element for coordinate transforms
  setCanvasElement(baseCanvas);

  // Apply initial cursor
  applyCursor();

  // Surface manager sets contexts + handles resize
  this.surfaceManager = new SurfaceManager(container, baseCanvas, overlayCanvas);
  this.surfaceManager.start();

  // ... rest of setup ...
}

stop(): void {
  // ... existing cleanup ...

  // Clear editor host
  setEditorHost(null);
  setCanvasElement(null);
}
```

---

## Final Architecture

### Files After Consolidation

| File | Lines | Change |
|------|-------|--------|
| Canvas.tsx | ~90 | Simplified (one less useLayoutEffect, one less import) |
| CanvasRuntime.ts | ~275 | Cleaner (context setup removed, editorHost via config) |
| SurfaceManager.ts | ~160 | +contexts +editorHost (owns all canvas DOM refs) |
| InputManager.ts | 70 | Unchanged |
| invalidation-helpers.ts | 68 | Unchanged |
| room-runtime.ts | 107 | Unchanged |
| tool-registry.ts | 107 | Unchanged |
| device-ui-store.ts | ~350 | +cursor logic |

**Deleted:**
- ~~cursor-manager.ts~~ (→ device-ui-store)
- ~~canvas-context-registry.ts~~ (→ SurfaceManager.ts)
- ~~editor-host-registry.ts~~ (→ SurfaceManager.ts)

**Net:** 10 files → 7 files (-3 files)

### New Setup Flow

```
Canvas.tsx mounts
├─ setActiveRoom()                         → room-runtime.ts
└─ runtime.start({ all 4 refs })           → CanvasRuntime.ts
   ├─ setEditorHost()                      → SurfaceManager.ts (module)
   ├─ setCanvasElement()                   → camera-store.ts
   ├─ applyCursor()                        → device-ui-store.ts
   └─ SurfaceManager.start()               → SurfaceManager.ts (class)
      ├─ Sets baseCtx, overlayCtx          → module-level refs
      └─ ResizeObserver + DPR listener
```

### Dependency Graph After

```
device-ui-store.ts
├─ imports: camera-store (for getCanvasElement in applyCursor)
└─ exports: applyCursor, setCursorOverride, all existing store stuff

SurfaceManager.ts
├─ imports: camera-store (for setViewport)
├─ owns: baseCtx, overlayCtx, editorHost (module-level)
└─ exports: getBaseContext, getOverlayContext, getEditorHost, setEditorHost, class

CanvasRuntime.ts
├─ imports: SurfaceManager, device-ui-store, camera-store, ...
└─ orchestrates everything

RenderLoop.ts / OverlayRenderLoop.ts
├─ imports: SurfaceManager (for getBaseContext/getOverlayContext)
└─ imports: camera-store, room-runtime (unchanged)

TextTool.ts
├─ imports: SurfaceManager (for getEditorHost)
└─ (unchanged otherwise)
```

---

## Implementation Order

1. **Merge DOM refs into SurfaceManager**
   - Add module-level refs and getters/setters to SurfaceManager.ts
   - Move context setup into start(), cleanup into stop()
   - Update imports in RenderLoop, OverlayRenderLoop, TextTool
   - Delete canvas-context-registry.ts, editor-host-registry.ts

2. **Move cursor logic to device-ui-store**
   - Add cursorOverride state + setCursorOverride action
   - Move computeBaseCursor + applyCursor functions
   - Add self-subscription for tool changes
   - Update imports in CanvasRuntime, PanTool
   - Delete cursor-manager.ts

3. **Update RuntimeConfig to include editorHost**
   - Add editorHost to RuntimeConfig interface
   - Update Canvas.tsx to pass editorHost
   - Remove separate useLayoutEffect from Canvas.tsx
   - CanvasRuntime.start() calls setEditorHost()

4. **Run typecheck**
   - `npm run typecheck` from root

---

## Not Consolidating (And Why)

### invalidation-helpers.ts
Keeps its own file because:
- Breaks circular dependency: tools → ... → CanvasRuntime
- Tools call `invalidateOverlay()` but can't import CanvasRuntime directly
- Pattern is clean and minimal

### room-runtime.ts
Keeps its own file because:
- Distinct responsibility (room context, not canvas/DOM)
- Used by many files (tools, render loops, runtime)
- Complex enough to warrant its own module

### tool-registry.ts
Keeps its own file because:
- Self-constructs singletons at module load
- Provides getCurrentTool(), getActivePreview() helpers
- Central to the tool system

### camera-store.ts
Stays in stores/ because:
- Is a Zustand store (not a simple registry)
- Canvas element ref is for transforms + pointer capture
- Has complex state + actions

---

## Risk Assessment

| Change | Risk | Mitigation |
|--------|------|------------|
| Cursor in device-ui-store | Low | Same logic, different location |
| DOM refs in SurfaceManager | Very Low | Single owner, no behavior change |
| editorHost in RuntimeConfig | Low | Cleaner API, same behavior |

All changes are pure refactoring with no behavior changes.
