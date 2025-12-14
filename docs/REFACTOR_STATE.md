# Canvas Runtime Refactor - State & Progress

**Last Updated:** Phase 2 Complete - Core refactor done, cursor-manager self-subscribing

---

## Progress Summary

| Phase | Description | Status |
|-------|-------------|--------|
| 1.0 | Runtime Modules (room-runtime, cursor-manager, etc.) | ✅ Complete |
| 1.1 | CanvasStage pointer target fix | ✅ Complete |
| 1.5 | All tools zero-arg constructors | ✅ Complete |
| 1.6 | Explicit transforms in render loops | ✅ Complete |
| 2A | Eliminate CanvasStage & Imperative Handle | ✅ Complete |
| 2B | Tool Registry, PointerTool interface, Preview Coupling | ✅ Complete |
| 2C-2G | CanvasRuntime, InputManager, Canvas.tsx simplification | ✅ Complete |
| 2H | Cursor-manager self-subscription | ✅ Complete |

---

## Current Architecture

```
Canvas.tsx (~105 lines) - MINIMAL REACT WRAPPER
├── Mounts raw <canvas> elements + editor host div
├── Sets room context (setActiveRoom) ← needs useRoomDoc() hook
├── Sets editor host (setEditorHost)
└── Creates/destroys CanvasRuntime
    (NO subscriptions!)

                │
                ▼

CanvasRuntime.ts (THE BRAIN) - ~280 lines
├── Creates SurfaceManager (resize/DPR)
├── Creates RenderLoop + OverlayRenderLoop
├── Creates ZoomAnimator
├── Creates InputManager (event listener attachment)
├── Handles all pointer events
├── Dispatches to tools via tool-registry
├── MMB pan via panTool singleton
├── Calls applyCursor() once at startup (initial cursor)
├── Camera subscription for tool view changes
└── Snapshot subscription for dirty rects + cache eviction

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
├── room-runtime.ts          → getActiveRoomDoc(), presence helpers
├── canvas-context-registry.ts → getBaseContext(), getOverlayContext()
├── camera-store.ts          → transforms, viewport, pointer capture
├── cursor-manager.ts        → applyCursor(), setCursorOverride()
│                              ↳ SELF-SUBSCRIBES to device-ui-store for tool changes
├── invalidation-helpers.ts  → invalidateWorld(), invalidateOverlay()
└── editor-host-registry.ts  → getEditorHost()
```

---

## Key Design Decisions

### 1. RenderLoops are Zero-Dependency

Both `RenderLoop` and `OverlayRenderLoop` take zero arguments to `start()`. They read everything they need from module registries:
- Contexts from `canvas-context-registry.ts`
- Snapshot/gates from `room-runtime.ts`
- Viewport from `camera-store.ts`
- Preview from `tool-registry.ts` (OverlayRenderLoop self-manages via `getActivePreview()`)

### 2. Tools are True Singletons

All tools are constructed once at module load time in `tool-registry.ts`. They implement the unified `PointerTool` interface and are never destroyed/recreated on tool switch.

### 3. Cursor-Manager Self-Subscribes

The cursor-manager module subscribes to `device-ui-store` at module initialization time. When `activeTool` changes, it automatically calls `applyCursor()`. CanvasRuntime only needs to call `applyCursor()` once at startup to set the initial cursor based on persisted tool state.

### 4. Module Registries for Imperative Access

Several small modules provide getter/setter patterns for imperative access:
- `room-runtime.ts` - Active room context
- `canvas-context-registry.ts` - 2D rendering contexts
- `editor-host-registry.ts` - TextTool DOM host
- `cursor-manager.ts` - Cursor state + tool subscription
- `invalidation-helpers.ts` - Render loop invalidation callbacks

---

## Next Focus: Module Consolidation

The refactor is functionally complete. The next phase explores consolidating the 5+ small helper modules into fewer, more cohesive units.

### Options to Explore

**1. RenderController Pattern**
- SurfaceManager could become a `RenderController` that:
  - Owns both RenderLoops
  - Handles snapshot subscription + dirty rect invalidation
  - Handles camera subscription for transform updates
  - Centralizes all render coordination
- Since loops are zero-dependency, we could inject ctx at render time
- RenderLoops could be true singletons (one per app, not per room)

**2. Cursor-Manager → device-ui-store**
- Cursor logic directly relates to `activeTool` state
- Could merge cursor computation into device-ui-store
- The store already owns tool state, cursor is just derived

**3. Context Injection for Singletons**
- Since RenderLoops take zero deps, we could make them singletons
- Inject room's ctx at render time instead of at construction
- No circular import issues since calls happen at runtime

**4. DOM Registry Merge**
- `canvas-context-registry.ts` + `editor-host-registry.ts` → `dom-registry.ts`
- Both are simple "store a DOM reference" patterns

**5. Invalidation via Direct Export**
- Circular deps wouldn't matter if imports only used at runtime
- Could potentially export render loop refs directly from a module
- Tools could import and call directly instead of through helper

### Constraints to Consider

- Zustand stores are singletons, easy to subscribe from anywhere
- tool-registry creates tools at module load (before CanvasRuntime exists)
- Circular deps are only problematic if values are read at import time
- Runtime calls (inside functions) can reference anything

---

## Files Overview

### Core Runtime Files

| File | Lines | Purpose |
|------|-------|---------|
| `Canvas.tsx` | ~105 | Thin React wrapper, mounts DOM, creates runtime |
| `CanvasRuntime.ts` | ~280 | Central orchestrator, event handling, subscriptions |
| `InputManager.ts` | ~50 | Dumb event forwarder to CanvasRuntime |
| `SurfaceManager.ts` | ~100 | Resize/DPR observation |
| `tool-registry.ts` | ~60 | Tool singletons + lookup helpers |

### Module Registries

| File | Purpose |
|------|---------|
| `room-runtime.ts` | Active room context, presence helpers |
| `canvas-context-registry.ts` | 2D context getters/setters |
| `editor-host-registry.ts` | TextTool DOM host |
| `cursor-manager.ts` | Cursor state + tool change subscription |
| `invalidation-helpers.ts` | Render loop invalidation callbacks |

### Render Loops

| File | Purpose |
|------|---------|
| `RenderLoop.ts` | Base canvas 60fps loop, dirty rect optimization |
| `OverlayRenderLoop.ts` | Preview + presence, self-manages preview via tool-registry |

---

## Test Commands

```bash
npm run typecheck  # From project root
```
