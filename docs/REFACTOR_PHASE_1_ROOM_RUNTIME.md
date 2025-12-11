# Phase 1: Room Runtime Module & Foundation

## Overview

This document details the first phase of the Canvas architecture refactor. The goal is to establish a **module-level room context** that decouples tools, render loops, and other imperative code from React lifecycle management.

**Phase 1 Focus:** Create the foundational `room-runtime.ts` module, cursor manager, and invalidation helpers that all subsequent phases depend on.

---

## Current State Analysis

### Canvas.tsx Pain Points (849 lines)

The current `Canvas.tsx` is a "god component" that:

1. **Manages 10+ useRefs** for ephemeral state:
   - `toolRef` - current tool instance
   - `lastMouseClientRef` - last mouse position for tool seeding
   - `mmbPanRef` - middle mouse button pan state
   - `cursorOverrideRef` - cursor override during gestures
   - `suppressToolPreviewRef` - hide preview during MMB pan
   - `activeToolRef` - mirrors activeTool for stable closures
   - `renderLoopRef`, `overlayLoopRef`, `zoomAnimatorRef`
   - `snapshotRef`, `baseStageRef`, `overlayStageRef`, `editorHostRef`

2. **Creates/destroys tools on every `activeTool` change** (lines 308-495):
   - Giant if-else branching per tool type
   - Each tool constructor receives different callback combinations
   - Cleanup tears down pointer capture, clears preview provider

3. **Duplicates MMB pan logic** (separate from PanTool):
   - Lines 513-534: MMB pointer down handling
   - Lines 582-598: MMB pointer move (pan calculation)
   - Lines 627-640, 657-666, 684-691: MMB cleanup in up/cancel/lost

4. **Passes callbacks everywhere**:
   - `() => overlayLoopRef.current?.invalidateAll()` - to tools
   - `applyCursor` - to PanTool, SelectTool
   - `setCursorOverride` - to PanTool, SelectTool
   - `invalidateWorld` - to SelectTool
   - `getEditorHost` - to TextTool

5. **Uses `useImperativeHandle`** for a `CanvasHandle` that should be removed:
   - `screenToWorld`, `worldToClient` - already in camera-store
   - `invalidateWorld` - should be a global helper
   - `setPreviewProvider` - internal implementation detail

### Tool Constructor Signatures (Current)

| Tool | Constructor Arguments |
|------|----------------------|
| `DrawingTool` | `(room, toolType, userId, onInvalidate, requestOverlayFrame, opts?)` |
| `EraserTool` | `(room, onInvalidate)` |
| `SelectTool` | `(room, opts: {invalidateWorld, invalidateOverlay, applyCursor, setCursorOverride})` |
| `TextTool` | `(room, config, userId, canvasHandle, onInvalidate)` |
| `PanTool` | `(onInvalidateOverlay, applyCursor, setCursorOverride)` |

**Problem:** 5 different constructor patterns, all receiving React-bound callbacks or roomDoc via props.

### What Already Works Well

1. **camera-store.ts** - Perfect pattern to follow:
   - Module-level `canvasElement` with `setCanvasElement()`/`getCanvasElement()`
   - Pure transform functions that read from store synchronously
   - RenderLoop/OverlayRenderLoop already subscribe for self-invalidation

2. **userProfileManager** - Module singleton pattern:
   - `userProfileManager.getIdentity().userId` accessible anywhere
   - No React dependency

3. **device-ui-store** - Already used imperatively:
   - Tools read settings via `useDeviceUIStore.getState()` at `begin()` time
   - DrawingTool freezes settings at gesture start

---

## Phase 1 Deliverables

### 1. `room-runtime.ts` - Module-Level Room Context

**Location:** `client/src/canvas/room-runtime.ts`

```typescript
// room-runtime.ts
import type { RoomId } from '@avlo/shared';
import type { IRoomDocManager } from '@/lib/room-doc-manager';

interface RoomContext {
  roomId: RoomId;
  roomDoc: IRoomDocManager;
}

let activeRoom: RoomContext | null = null;

/**
 * Set the active room context. Called by Canvas.tsx in useLayoutEffect.
 * @param context - Room context or null when unmounting
 */
export function setActiveRoom(context: RoomContext | null): void {
  activeRoom = context;
}

/**
 * Get the active room context. Throws if no room is active.
 * Safe to call from tools, render loops, event handlers - any imperative code.
 */
export function getActiveRoom(): RoomContext {
  if (!activeRoom) {
    throw new Error('getActiveRoom(): no active room - ensure Canvas mounted and setActiveRoom called');
  }
  return activeRoom;
}

/**
 * Get the active room's IRoomDocManager.
 * Convenience wrapper for getActiveRoom().roomDoc
 */
export function getActiveRoomDoc(): IRoomDocManager {
  return getActiveRoom().roomDoc;
}

/**
 * Get the active room's ID.
 * Convenience wrapper for getActiveRoom().roomId
 */
export function getActiveRoomId(): RoomId {
  return getActiveRoom().roomId;
}

/**
 * Check if a room is currently active (for guards/conditionals).
 */
export function hasActiveRoom(): boolean {
  return activeRoom !== null;
}
```

**Key Design Decisions:**
- Throws on missing room (fail-fast, easy debugging)
- Simple, synchronous API
- Matches existing `setCanvasElement()`/`getCanvasElement()` pattern in camera-store

### 2. `cursor-manager.ts` - Centralized Cursor Control

**Location:** `client/src/canvas/cursor-manager.ts`

```typescript
// cursor-manager.ts
import { getCanvasElement } from '@/stores/camera-store';
import { useDeviceUIStore } from '@/stores/device-ui-store';

/** Manual cursor override (e.g., 'grabbing' during pan) */
let override: string | null = null;

/**
 * Set a cursor override that takes priority over tool-based cursor.
 * Pass null to clear override.
 */
export function setCursorOverride(cursor: string | null): void {
  override = cursor;
  applyCursor();
}

/**
 * Get the current cursor override (for debugging/inspection).
 */
export function getCursorOverride(): string | null {
  return override;
}

/**
 * Compute the appropriate cursor based on active tool.
 */
function computeBaseCursor(): string {
  const { activeTool } = useDeviceUIStore.getState();
  switch (activeTool) {
    case 'eraser':
      return 'url("/cursors/avloEraser.cur") 16 16, auto';
    case 'pan':
      return 'grab';
    case 'select':
      return 'default';
    case 'text':
      return 'text';
    default:
      return 'crosshair';
  }
}

/**
 * Apply the current cursor to the canvas element.
 * Priority: override > tool-based cursor
 */
export function applyCursor(): void {
  const canvas = getCanvasElement();
  if (!canvas) return;
  canvas.style.cursor = override ?? computeBaseCursor();
}
```

**Removes from Canvas.tsx:**
- `cursorOverrideRef`
- `applyCursor` callback passed to tools
- `setCursorOverride` callback passed to tools

### 3. `invalidation-helpers.ts` - Global Invalidation Functions

**Location:** `client/src/canvas/invalidation-helpers.ts`

```typescript
// invalidation-helpers.ts
import type { WorldBounds } from '@avlo/shared';

/**
 * Weak references to active render loops.
 * Set by BoardRuntime (Phase 2), used by tools and other imperative code.
 */
let worldInvalidator: ((bounds: WorldBounds) => void) | null = null;
let overlayInvalidator: (() => void) | null = null;

/**
 * Register the world (base canvas) invalidation function.
 * Called by BoardRuntime on start.
 */
export function setWorldInvalidator(fn: ((bounds: WorldBounds) => void) | null): void {
  worldInvalidator = fn;
}

/**
 * Register the overlay canvas invalidation function.
 * Called by BoardRuntime on start.
 */
export function setOverlayInvalidator(fn: (() => void) | null): void {
  overlayInvalidator = fn;
}

/**
 * Invalidate a region of the world canvas (dirty rect).
 * Safe no-op if no runtime is active.
 */
export function invalidateWorld(bounds: WorldBounds): void {
  worldInvalidator?.(bounds);
}

/**
 * Invalidate the entire overlay canvas (full clear, cheap).
 * Safe no-op if no runtime is active.
 */
export function invalidateOverlay(): void {
  overlayInvalidator?.();
}
```

**Removes from Canvas.tsx:**
- `() => overlayLoopRef.current?.invalidateAll()` passed to every tool
- `(bounds) => renderLoopRef.current?.invalidateWorld(bounds)` passed to SelectTool

### 4. `editor-host-registry.ts` - DOM Overlay Host

**Location:** `client/src/canvas/editor-host-registry.ts`

```typescript
// editor-host-registry.ts

/**
 * DOM element that hosts text editors and other overlay elements.
 * Set by Canvas.tsx, read by TextTool.
 */
let editorHost: HTMLDivElement | null = null;

export function setEditorHost(el: HTMLDivElement | null): void {
  editorHost = el;
}

export function getEditorHost(): HTMLDivElement | null {
  return editorHost;
}
```

**Removes from Canvas.tsx:**
- `{ getEditorHost: () => editorHostRef.current }` passed to TextTool

### 5. Wire Canvas.tsx to Room Runtime

**Changes to Canvas.tsx:**

```typescript
// Add import
import { setActiveRoom } from './room-runtime';
import { applyCursor, setCursorOverride } from './cursor-manager';
import { setEditorHost } from './editor-host-registry';
import { setWorldInvalidator, setOverlayInvalidator } from './invalidation-helpers';

// After useRoomDoc hook (line ~52):
const roomDoc = useRoomDoc(roomId);

// NEW: Set active room immediately after acquiring it
useLayoutEffect(() => {
  setActiveRoom({ roomId, roomDoc });
  return () => {
    // Only clear if this Canvas set it (handles race conditions)
    // The getActiveRoom() will throw after this, which is correct
    setActiveRoom(null);
  };
}, [roomId, roomDoc]);

// NEW: Set editor host
useLayoutEffect(() => {
  setEditorHost(editorHostRef.current);
  return () => setEditorHost(null);
}, []);

// MODIFY: RenderLoop setup - register invalidators
useLayoutEffect(() => {
  // ... existing renderLoop creation ...

  // NEW: Register global invalidator
  setWorldInvalidator((bounds) => renderLoopRef.current?.invalidateWorld(bounds));

  return () => {
    setWorldInvalidator(null);
    // ... existing cleanup ...
  };
}, []);

// MODIFY: OverlayRenderLoop setup - register invalidator
useLayoutEffect(() => {
  // ... existing overlayLoop creation ...

  // NEW: Register global invalidator
  setOverlayInvalidator(() => overlayLoopRef.current?.invalidateAll());

  return () => {
    setOverlayInvalidator(null);
    // ... existing cleanup ...
  };
}, [roomDoc]);

// REMOVE: cursorOverrideRef (use cursor-manager instead)
// REMOVE: applyCursor callback (import from cursor-manager)
// KEEP: Everything else for now - Phase 2 will migrate tool creation
```

---

## File Changes Summary

### New Files (4)

| File | Lines | Purpose |
|------|-------|---------|
| `client/src/canvas/room-runtime.ts` | ~50 | Active room context module |
| `client/src/canvas/cursor-manager.ts` | ~45 | Centralized cursor control |
| `client/src/canvas/invalidation-helpers.ts` | ~45 | Global invalidation functions |
| `client/src/canvas/editor-host-registry.ts` | ~15 | DOM overlay host registry |

### Modified Files (1)

| File | Changes |
|------|---------|
| `client/src/canvas/Canvas.tsx` | Add useLayoutEffects to wire runtime modules |

### Deleted Code (in Canvas.tsx)

- `cursorOverrideRef` declaration
- `applyCursor` callback definition
- Local cursor management logic

---

## Timing & Safety Guarantees

### Execution Order

```
1. React render Canvas component
2. ref callbacks fire (sync) → canvasElement set in camera-store
3. useLayoutEffect runs → setActiveRoom({ roomId, roomDoc })
4. useLayoutEffect runs → setEditorHost(editorHostRef.current)
5. useLayoutEffect runs → RenderLoop created, setWorldInvalidator registered
6. useLayoutEffect runs → OverlayRenderLoop created, setOverlayInvalidator registered
7. Browser paints
8. User can interact (pointer events)
```

**Safety:** Any pointer event handler that calls `getActiveRoomDoc()` is guaranteed to succeed because:
- `useLayoutEffect` runs **before paint** and **before user interaction**
- Pointer events cannot fire until the browser has painted at least once

### Error Handling

```typescript
// In a tool's begin() method:
const roomDoc = getActiveRoomDoc(); // THROWS if Canvas unmounted

// This is GOOD! Fail-fast, clear error message:
// "getActiveRoom(): no active room - ensure Canvas mounted and setActiveRoom called"
```

---

## Testing Checklist

### Manual Tests

1. **Room loads correctly:**
   - Navigate to `/room/test123`
   - Verify canvas renders, tools work
   - No console errors about "no active room"

2. **Room switch:**
   - Navigate from `/room/aaa` to `/room/bbb`
   - Verify old room cleans up, new room activates
   - No stale roomDoc references

3. **Tool gestures work:**
   - Draw a stroke (DrawingTool uses roomDoc)
   - Erase an object (EraserTool uses roomDoc)
   - Select/move objects (SelectTool uses roomDoc)

4. **Cursor manager works:**
   - Switch tools → cursor changes
   - MMB pan → cursor shows 'grabbing'
   - Release MMB → cursor returns to tool default

---

## What This Phase Does NOT Do

**Explicitly deferred to Phase 2:**

1. ❌ Move tool construction to a runtime module
2. ❌ Make tools singletons
3. ❌ Remove tool constructor arguments
4. ❌ Move pointer event handling out of Canvas.tsx
5. ❌ Create BoardRuntime class
6. ❌ Remove `useImperativeHandle` / `CanvasHandle`
7. ❌ Change RenderLoop/OverlayRenderLoop config

**Reason:** Phase 1 establishes the **foundation** that Phase 2 builds on. Each module created here is immediately usable but not yet utilized to refactor tools.

---

## Migration Path to Phase 2

After Phase 1, tools can **optionally** start using the new modules:

```typescript
// PanTool.ts - can now import directly
import { invalidateOverlay } from '@/canvas/invalidation-helpers';
import { setCursorOverride, applyCursor } from '@/canvas/cursor-manager';

export class PanTool {
  // Constructor can become zero-arg since it imports everything
  constructor() {}

  begin(...) {
    setCursorOverride('grabbing');
    applyCursor();
  }

  updatePan(...) {
    // ... pan logic ...
    invalidateOverlay();
  }

  end() {
    setCursorOverride(null);
    applyCursor();
  }
}
```

This allows **incremental migration** - tools can be updated one at a time while the system keeps working.

---

## Implementation Order

Execute in this exact order:

1. Create `room-runtime.ts`
2. Create `cursor-manager.ts`
3. Create `invalidation-helpers.ts`
4. Create `editor-host-registry.ts`
5. Modify `Canvas.tsx`:
   - Add imports
   - Add `setActiveRoom` useLayoutEffect
   - Add `setEditorHost` useLayoutEffect
   - Add invalidator registrations to RenderLoop/OverlayRenderLoop effects
   - Remove `cursorOverrideRef` and migrate cursor logic to use cursor-manager
6. Run typecheck: `npm run typecheck`
7. Manual testing

**Estimated Changes:** ~200 new lines, ~30 removed lines, ~20 modified lines

---

## Success Criteria

Phase 1 is complete when:

1. ✅ All 4 new modules exist and export correct interfaces
2. ✅ `Canvas.tsx` wires up the modules in `useLayoutEffect`
3. ✅ `getActiveRoomDoc()` works from any file that imports it
4. ✅ `applyCursor()` from cursor-manager controls the canvas cursor
5. ✅ `invalidateOverlay()` from invalidation-helpers triggers overlay redraws
6. ✅ No runtime errors in console
7. ✅ All existing functionality preserved (drawing, erasing, selecting, text)
8. ✅ `npm run typecheck` passes

---

## Appendix: Full Architecture Vision (for context)

```
┌─────────────────────────────────────────────────────────────────┐
│                        PHASE 1 (This Doc)                       │
│  room-runtime.ts    cursor-manager.ts    invalidation-helpers   │
│  editor-host-registry.ts                                        │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│                        PHASE 2 (Future)                          │
│  BoardRuntime.ts - Imperative runtime that owns:                │
│    - RenderLoop                                                 │
│    - OverlayRenderLoop                                          │
│    - ZoomAnimator                                               │
│    - Pointer event handling                                     │
│    - Tool singleton registry                                    │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│                        PHASE 3 (Future)                          │
│  Tool refactoring - Zero-arg constructors, import everything:   │
│    - getActiveRoomDoc()                                         │
│    - useCameraStore.getState()                                  │
│    - useDeviceUIStore.getState()                                │
│    - setCursorOverride() / applyCursor()                        │
│    - invalidateWorld() / invalidateOverlay()                    │
│    - userProfileManager.getIdentity()                           │
└─────────────────────────────────────────────────────────────────┘
```

---

## References

- `CLAUDE.md` - Codebase architecture documentation
- `PROMPT.MD` - Original LLM conversation with design rationale
- `client/src/stores/camera-store.ts` - Reference implementation of module-level pattern
- `client/src/lib/user-profile-manager.ts` - Reference singleton pattern
