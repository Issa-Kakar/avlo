# Zoom/Pan Implementation Investigation Report

## Executive Summary

The zoom/pan implementation is experiencing critical stability issues due to a **fundamental architectural flaw**: the main `useEffect` that manages tools and event listeners is re-running during zoom/pan operations, causing mid-gesture teardown of the entire input surface. This manifests as cursor flickering, lost pointer capture, broken gestures, and eraser ring disappearing during zoom.

## Core Problem: The Unstable `useEffect` Monster

### Location
**File**: `/home/issak/dev/avlo/client/src/canvas/Canvas.tsx`
**Lines**: 638-1087 (449 lines!)
**Dependencies**: Lines 1073-1087

### The Smoking Gun
```typescript
// Current dependency array (PROBLEMATIC):
}, [
  roomDoc,
  userId,
  activeTool,
  pen,
  highlighter,
  eraser,
  text,
  stageReady,
  screenToWorld,    // ✓ Stable (no deps)
  worldToClient,    // ❌ UNSTABLE - recreated on every transform change!
  setCursorMode,    // ❌ UNSTABLE - recreated when updateCanvasCursor changes
  setScale,         // ✓ Stable (from context with empty deps)
  setPan,           // ✓ Stable (from context with empty deps)
]);
```

## Root Cause Analysis

### 1. The `worldToClient` Function Instability
**Location**: Line 316-331

```typescript
const worldToClient = useCallback(
  (worldX: number, worldY: number): [number, number] => {
    // ... implementation ...
  },
  [viewTransform], // ❌ THIS IS THE KILLER!
);
```

**Problem**:
- `worldToClient` depends on `viewTransform` object
- Every zoom/pan creates a new `viewTransform` object (even though values might be same)
- New `worldToClient` function → triggers useEffect re-run → TEARDOWN EVERYTHING

**Impact Chain**:
1. User scrolls wheel to zoom
2. `viewTransform` updates
3. `worldToClient` function recreated
4. Big `useEffect` sees dependency change
5. Cleanup runs:
   - Clears cursor debounce timer (cursor stuck in pulse mode!)
   - Releases pointer capture
   - Destroys tool
   - Clears preview provider
   - Removes all event listeners
6. Effect re-runs, recreates everything
7. But gesture is already broken!

### 2. The `setCursorMode` Function Instability
**Location**: Lines 161-194

```typescript
const updateCanvasCursor = useCallback((mode: CursorMode) => {
  // ... implementation ...
}, [activeTool]); // Changes when tool changes

const setCursorMode = useCallback((mode: CursorMode, color?: string) => {
  // ... implementation ...
}, [updateCanvasCursor]); // Cascades the instability!
```

**Problem**:
- `updateCanvasCursor` depends on `activeTool`
- `setCursorMode` depends on `updateCanvasCursor`
- Any tool change → new `setCursorMode` → useEffect re-runs

### 3. The 180ms Timer Cancellation Bug
**Location**: Lines 977-986 (wheel handler) & 1034-1036 (cleanup)

**Symptom**: First zoom shows gray ring that sticks around

**What happens**:
1. Wheel event sets pulse mode: `setCursorMode('zoom-in-pulse')`
2. Sets 180ms timer to revert: `setTimeout(() => setCursorMode(getToolImpliedCursor()), 180)`
3. During those 180ms, transform changes trigger effect re-run
4. Cleanup cancels the timer: `window.clearTimeout(cursorDebounceRef.current)`
5. Cursor never reverts from pulse mode!

### 4. HUD Position Not Seeded
**Location**: Lines 934-936

**Symptom**: MMB pan shows ring at top-left corner initially

**Problem**:
- HUD position only updates on `pointermove`: `setHudPosition({ x: e.clientX, y: e.clientY })`
- If you MMB click without moving first, HUD renders at default (0,0)
- Looks like cursor jumps to top-left

### 5. Helper Functions Defined Inside useEffect
**Location**: Lines 938-943

```typescript
const getToolImpliedCursor = () => {
  if (activeTool === 'pan') return 'pan-idle';
  return 'tool-cursor';
};
```

**Problem**:
- Function recreated on every effect run
- Can't be memoized outside due to closure over `activeTool`
- But doesn't actually need to be inside the effect!

## Additional Design Issues

### 1. PanTool vs MMB Pan Conflict
When PanTool is active AND user does MMB:
- Both try to handle the pan gesture
- MMB pan is supposed to be "transient" but PanTool is already active
- Cursor state becomes confused (pan-idle → pan-active → pan-active?)
- Who wins? Currently MMB takes precedence (line 780 checks MMB before tool)

### 2. State Management Split
Cursor state is split between:
- React state (`cursorMode`, `pulseKey`, `pulseColor`, `hudPosition`)
- Refs (`cursorDebounceRef`)
- Tool internal state (PanTool's `setCursorMode` calls)

This makes it hard to reason about cursor state transitions.

### 3. Zoom During Active Gesture
Currently no guard against zooming while drawing/erasing (only guards against zoom during MMB pan).
The guide suggested adding: `if (toolRef.current?.isActive()) return;` but it's not implemented.

## Comprehensive Solution

### Phase 1: Surgical Fix (Minimal Changes)
As suggested in PROMPT.MD but with corrections:

1. **Fix the dependency array**:
```typescript
// Remove unstable functions from deps
}, [
  roomDoc,
  userId,
  activeTool,
  pen,
  highlighter,
  eraser,
  text,
  stageReady,
  // REMOVE: screenToWorld, worldToClient, setCursorMode, setScale, setPan
]);
```

2. **Make `worldToClient` stable**:
```typescript
// Option A: Remove viewTransform from deps and read from ref
const worldToClient = useCallback(
  (worldX: number, worldY: number): [number, number] => {
    const transform = viewTransformRef.current; // Read from ref!
    if (!baseStageRef.current || !transform) return [worldX, worldY];

    const [canvasX, canvasY] = transform.worldToCanvas(worldX, worldY);
    const rect = baseStageRef.current.getBounds();
    return [canvasX + rect.left, canvasY + rect.top];
  },
  [] // Empty deps - stable function
);
```

3. **Seed HUD position**:
```typescript
// In handleWheel (after preventDefault)
setHudPosition({ x: e.clientX, y: e.clientY });

// In handlePointerDown (at the top)
setHudPosition({ x: e.clientX, y: e.clientY });
```

4. **Optional: Block zoom during active tool**:
```typescript
// In handleWheel (after MMB guard)
if (toolRef.current?.isActive()) return;
```

### Phase 2: Proper Architecture (Recommended)

1. **Split the monster useEffect**:
```typescript
// Effect 1: Mount-once event listeners
useEffect(() => {
  const canvas = baseStageRef.current?.getCanvasElement();
  if (!canvas || !renderLoopRef.current) return;

  // Define ALL handlers here (they read from refs, not closures)
  const handlePointerDown = (e: PointerEvent) => {
    // Read everything from refs: toolRef, viewTransformRef, etc.
  };

  // Attach listeners
  canvas.addEventListener('pointerdown', handlePointerDown, { passive: false });
  // ... etc

  return () => {
    // Remove listeners only
  };
}, [stageReady]); // Only re-run when stage becomes available

// Effect 2: Tool lifecycle
useEffect(() => {
  if (!roomDoc || !stageReady) return;

  // Create tool based on activeTool
  // Set preview provider
  // Update cursor style

  return () => {
    // Destroy tool only
  };
}, [roomDoc, activeTool, pen, highlighter, eraser, text, stageReady]);
```

2. **Use refs for cursor state**:
```typescript
const cursorModeRef = useRef<CursorMode>('tool-cursor');
const cursorHudRef = useRef<CursorHudHandle>(null);

// No React state for cursor - update HUD imperatively
const setCursorMode = (mode: CursorMode, color?: string) => {
  cursorModeRef.current = mode;
  updateCanvasCursorStyle(mode); // Direct DOM update
  cursorHudRef.current?.setMode(mode, color); // Imperative API
};
```

3. **Move helper functions outside**:
```typescript
// Outside component or memoized with proper deps
const getToolImpliedCursor = (activeTool: string): CursorMode => {
  if (activeTool === 'pan') return 'pan-idle';
  return 'tool-cursor';
};
```

## Testing Verification

After implementing fixes, verify:

### ✓ Cursor Stability
- [ ] Wheel zoom: Tool cursor stays visible throughout
- [ ] First zoom: Pulse ring disappears after 180ms
- [ ] MMB pan: Cursor hides during drag, returns on release
- [ ] No cursor flicker during any operation

### ✓ Gesture Integrity
- [ ] Can zoom while drawing (stroke continues)
- [ ] Can zoom while erasing (erase continues)
- [ ] MMB pan during any tool doesn't break the tool
- [ ] Rapid wheel events don't cause drift

### ✓ HUD Behavior
- [ ] HUD appears at correct position immediately
- [ ] No jumping to top-left corner
- [ ] Pulse animations play smoothly
- [ ] Correct cursor mode after all transitions

### ✓ Performance
- [ ] No excessive re-renders during zoom/pan
- [ ] Smooth 60fps during animations
- [ ] No memory leaks from recreated closures

## Critical Warnings

1. **DO NOT** add `viewTransform` to any event handler effect deps
2. **DO NOT** define helper functions inside effects unless necessary
3. **DO NOT** mix React state with imperative DOM updates for high-frequency changes
4. **ALWAYS** read transform from refs in event handlers
5. **ALWAYS** seed positions before showing positional UI elements

## Conclusion

The root cause is clear: **unstable function references in the giant useEffect's dependency array cause mid-gesture teardown during zoom/pan**. The primary culprit is `worldToClient` depending on `viewTransform`.

The surgical fix (remove unstable deps, read from refs) will solve the immediate problems. The architectural refactor (split effects, use refs for cursor state) will make the system robust and maintainable long-term.

The implementation guide was architecturally sound, but the actual implementation deviated by:
1. Adding transform-dependent functions to effect deps
2. Not seeding HUD position
3. Not splitting tool lifecycle from event listeners
4. Using React state for high-frequency cursor updates

Fix these deviations and the zoom/pan system will work flawlessly.