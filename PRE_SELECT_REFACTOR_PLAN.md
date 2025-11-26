# Pre-Select Tool Architecture Refactor Plan

## Executive Summary

This document provides a detailed implementation plan for refactoring the tool architecture **before** implementing the SelectTool. The core change: **decouple tool lifetime from settings changes** by having tools read settings directly from the store at gesture start instead of receiving them as constructor parameters.

**Why this matters for SelectTool:**
- SelectTool must persist selection across settings changes (so user can select objects, then change their color)
- Current architecture destroys/recreates tools when settings change
- This prep work creates the foundation for tools that don't recreate on every settings tweak

---

## Current Architecture Analysis

### Canvas.tsx Tool Effect (Lines 423-640)

The main tool creation effect has these **problematic dependencies**:

```typescript
useEffect(() => {
  // Tool creation logic...
}, [
  roomDoc,
  userId,
  activeTool,
  drawingSettings,      // ❌ PROBLEM: Settings change = tool recreation
  highlighterOpacity,   // ❌ PROBLEM: Settings change = tool recreation
  eraserSize,           // ❌ PROBLEM: Unused but still triggers recreation
  textSize,             // ⚠️ SPECIAL: TextTool has updateConfig() workaround
  shapeVariant,         // ✅ OK: Changes tool behavior (forceSnapKind)
  stageReady,
  screenToWorld,
  worldToClient,
  applyCursor,
]);
```

**Current Flow:**
1. User changes color/size in toolbar → `drawingSettings` object changes
2. Effect runs → destroys current tool → creates new tool with new settings
3. Any in-progress gesture is cancelled

**Target Flow:**
1. User changes color/size in toolbar → store updates
2. Effect does NOT run (settings not in deps)
3. Tool reads settings from store at next `begin()` call

---

### Tool-by-Tool Analysis

#### 1. DrawingTool.ts

**Current State:**
```typescript
// Line 37: Settings stored as class property
private settings: DrawingSettings;

// Lines 67-87: Constructor takes settings parameter
constructor(
  room: IRoomDocManager,
  settings: DrawingSettings,  // ❌ Passed from Canvas.tsx
  toolType: 'pen' | 'highlighter',
  userId: string,
  ...
) {
  this.settings = settings;
  ...
}

// Lines 89-105: resetState() copies settings into config
private resetState(): void {
  this.state = {
    ...
    config: {
      tool: this.toolType,
      color: this.settings.color,      // From constructor param
      size: this.settings.size,        // From constructor param
      opacity: this.settings.opacity ?? ...,
    },
    ...
  };
}

// Lines 257-262: startDrawing() re-freezes from this.settings
this.state = {
  ...
  config: {
    tool: this.toolType,
    color: this.settings.color,        // Still from constructor param
    size: this.settings.size,
    opacity: ...,
  },
  ...
};
```

**Critical Finding - Fill is LIVE:**
```typescript
// Line 374 in getPreview():
fill: (this.settings as any).fill,  // READ LIVE from this.settings

// Line 583 in commitPerfectShapeFromPreview():
if ((this.settings as any).fill) {  // READ LIVE at commit time
  const fillColor = createFillFromStroke(this.state.config.color);
  shapeMap.set('fillColor', fillColor);
}
```

**Why fill is special:** Unlike color/size/opacity which are frozen at gesture start, `fill` is read live. This allows users to toggle fill while previewing a shape. This behavior should be PRESERVED.

---

#### 2. EraserTool.ts

**Current State:**
```typescript
// Lines 22-35: Constructor with UNUSED settings
constructor(
  room: IRoomDocManager,
  _settings: any,    // ❌ UNUSED - marked with underscore
  _userId: string,   // ❌ UNUSED - marked with underscore
  onInvalidate?: () => void,
  _getViewport?: any, // ❌ UNUSED
  getView?: () => ViewTransform,
) {
  // Note: _settings is NEVER used
}

// Lines 4-6: Uses hardcoded values instead
const ERASER_RADIUS_PX = 10;
const ERASER_SLACK_PX = 2.0;
```

**Key Insight:** EraserTool already ignores settings! It uses hardcoded radius. The `eraserSize` in Canvas.tsx is completely useless but still triggers tool recreation.

---

#### 3. TextTool.ts

**Current State:**
```typescript
// Lines 34-40: Constructor with config
constructor(
  private room: any,
  private config: TextToolConfig,  // { size: number; color: string }
  private userId: string,
  private canvasHandle: CanvasHandle,
  private onInvalidate?: () => void,
) {}

// Lines 93-103: Has updateConfig() for hot updates
updateConfig(newConfig: TextToolConfig): void {
  this.config = newConfig;
  if (this.state.editBox) {
    // Update live editor styles
    this.state.editBox.style.fontSize = `${scaledFontSize}px`;
    this.state.editBox.style.color = newConfig.color;
  }
}
```

**Special Case:** Canvas.tsx already has workaround (lines 424-437):
```typescript
if (activeTool === 'text' && toolRef.current?.isActive()) {
  const textTool = toolRef.current as any;
  if ('updateConfig' in textTool) {
    textTool.updateConfig({ size: textSize, color: drawingSettings.color });
    return; // Skip recreation
  }
}
```

---

#### 4. PanTool.ts

**Current State:** Takes no settings - only callbacks. No changes needed.

---

## Implementation Plan

### Phase 1: Clean Up EraserTool (Simplest)

**File:** `client/src/lib/tools/EraserTool.ts`

**Changes:**

1. Remove unused constructor parameters:
```typescript
// BEFORE (Lines 22-29)
constructor(
  room: IRoomDocManager,
  _settings: any,           // Remove
  _userId: string,          // Remove
  onInvalidate?: () => void,
  _getViewport?: any,       // Remove
  getView?: () => ViewTransform,
)

// AFTER
constructor(
  room: IRoomDocManager,
  onInvalidate?: () => void,
  getView?: () => ViewTransform,
)
```

2. Update the constructor body - no changes needed since these params were unused.

**File:** `client/src/canvas/Canvas.tsx`

1. Update EraserTool construction (Lines 468-490):
```typescript
// BEFORE
if (activeTool === 'eraser') {
  const eraserSettings = { size: eraserSize };  // DELETE THIS
  tool = new EraserTool(
    roomDoc,
    eraserSettings,  // Remove
    userId,          // Remove
    () => overlayLoopRef.current?.invalidateAll(),
    () => { ... },   // Remove (unused viewport callback)
    () => viewTransformRef.current,
  );
}

// AFTER
if (activeTool === 'eraser') {
  tool = new EraserTool(
    roomDoc,
    () => overlayLoopRef.current?.invalidateAll(),
    () => viewTransformRef.current,
  );
}
```

2. Remove `eraserSize` from effect dependencies (Line 633):
```typescript
// BEFORE
], [
  ...
  eraserSize,  // DELETE
  ...
]);

// AFTER - eraserSize removed
```

3. Remove `eraserSize` from destructuring (if it was there for this purpose only - check if used elsewhere)

---

### Phase 2: Refactor DrawingTool

**File:** `client/src/lib/tools/DrawingTool.ts`

**Strategy:** Import `useDeviceUIStore` and freeze settings at `begin()` time.

#### Step 2.1: Add Store Import
```typescript
// At top of file, add:
import { useDeviceUIStore } from '@/stores/device-ui-store';
```

#### Step 2.2: Update Constructor Signature
```typescript
// BEFORE (Lines 67-76)
constructor(
  room: IRoomDocManager,
  settings: DrawingSettings,  // Remove this
  toolType: 'pen' | 'highlighter',
  userId: string,
  onInvalidate?: (bounds: [number, number, number, number]) => void,
  requestOverlayFrame?: RequestOverlayFrame,
  getView?: () => ViewTransform,
  opts?: { forceSnapKind?: ForcedSnapKind }
)

// AFTER
constructor(
  room: IRoomDocManager,
  toolType: 'pen' | 'highlighter',
  userId: string,
  onInvalidate?: (bounds: [number, number, number, number]) => void,
  requestOverlayFrame?: RequestOverlayFrame,
  getView?: () => ViewTransform,
  opts?: { forceSnapKind?: ForcedSnapKind }
)
```

#### Step 2.3: Remove Settings Class Property
```typescript
// DELETE Line 37:
private settings: DrawingSettings;
```

#### Step 2.4: Add Helper Method for Frozen Settings
```typescript
// Add new private method:
private getFrozenSettings(): { size: number; color: string; opacity: number } {
  const state = useDeviceUIStore.getState();
  const base = state.drawingSettings;

  return {
    size: base.size,
    color: base.color,
    opacity: this.toolType === 'highlighter'
      ? state.highlighterOpacity
      : (base.opacity ?? 1),
  };
}

// Add helper to read fill flag (live, not frozen)
private getFillEnabled(): boolean {
  return useDeviceUIStore.getState().drawingSettings.fill;
}
```

#### Step 2.5: Update resetState()
```typescript
// BEFORE (Lines 89-105)
private resetState(): void {
  this.state = {
    isDrawing: false,
    pointerId: null,
    points: [],
    config: {
      tool: this.toolType,
      color: this.settings.color,     // ❌ Uses this.settings
      size: this.settings.size,       // ❌ Uses this.settings
      opacity: this.settings.opacity ?? ...,
    },
    startTime: 0,
  };
  ...
}

// AFTER
private resetState(): void {
  // Read current settings from store (will be frozen on begin())
  const settings = this.getFrozenSettings();

  this.state = {
    isDrawing: false,
    pointerId: null,
    points: [],
    config: {
      tool: this.toolType,
      color: settings.color,
      size: settings.size,
      opacity: settings.opacity,
    },
    startTime: 0,
  };
  this.lastBounds = null;
  this.snap = null;
  this.liveCursorWU = null;
}
```

#### Step 2.6: Update startDrawing()
```typescript
// Update lines 247-266 to freeze from store instead of this.settings:
startDrawing(pointerId: number, worldX: number, worldY: number): void {
  if (this.state.isDrawing) return;

  // CRITICAL: Freeze settings from store at gesture start
  const frozen = this.getFrozenSettings();

  this.state = {
    isDrawing: true,
    pointerId,
    points: [[worldX, worldY]],
    config: {
      tool: this.toolType,
      color: frozen.color,
      size: frozen.size,
      opacity: frozen.opacity,
    },
    startTime: Date.now(),
  };
}
```

#### Step 2.7: Update getPreview() - Preserve Live Fill
```typescript
// Line 374 - fill must still be read live:
if (this.snap && this.liveCursorWU) {
  const { color, size } = this.state.config;
  return {
    kind: 'perfectShape',
    shape: this.snap.kind,
    color,
    size,
    opacity: this.state.config.opacity,
    fill: this.getFillEnabled(),  // ✅ Still read live from store
    anchors: { kind: this.snap.kind, ...this.snap.anchors } as any,
    cursor: this.liveCursorWU,
    bbox: null
  };
}
```

#### Step 2.8: Update commitPerfectShapeFromPreview() - Preserve Live Fill
```typescript
// Lines 582-586 - fill must still be read live:
if (this.getFillEnabled()) {  // ✅ Still read live from store
  const fillColor = createFillFromStroke(this.state.config.color);
  shapeMap.set('fillColor', fillColor);
}
```

---

### Phase 3: Update Canvas.tsx Tool Creation

**File:** `client/src/canvas/Canvas.tsx`

#### Step 3.1: Update DrawingTool Creation for Pen/Highlighter (Lines 491-514)
```typescript
// BEFORE
} else if (activeTool === 'pen' || activeTool === 'highlighter') {
  const settings = {
    size: drawingSettings.size,
    color: drawingSettings.color,
    opacity: activeTool === 'highlighter' ? highlighterOpacity : drawingSettings.opacity,
    fill: drawingSettings.fill
  };

  tool = new DrawingTool(
    roomDoc,
    settings,        // Remove this
    activeTool,
    userId,
    ...
  );
}

// AFTER
} else if (activeTool === 'pen' || activeTool === 'highlighter') {
  // Settings are now read from store at begin() time
  tool = new DrawingTool(
    roomDoc,
    activeTool,
    userId,
    (_bounds) => overlayLoopRef.current?.invalidateAll(),
    () => overlayLoopRef.current?.invalidateAll(),
    () => viewTransformRef.current
  );
}
```

#### Step 3.2: Update DrawingTool Creation for Shape (Lines 515-540)
```typescript
// BEFORE
} else if (activeTool === 'shape') {
  const forceSnapKind = ...;
  const settings = {
    size: drawingSettings.size,
    color: drawingSettings.color,
    opacity: drawingSettings.opacity,
    fill: drawingSettings.fill
  };

  tool = new DrawingTool(
    roomDoc,
    settings,      // Remove this
    'pen',
    userId,
    ...
    { forceSnapKind }
  );
}

// AFTER
} else if (activeTool === 'shape') {
  const forceSnapKind =
    shapeVariant === 'rectangle' ? 'rect' :
    shapeVariant === 'ellipse'   ? 'ellipseRect' :
    shapeVariant === 'diamond'   ? 'diamond' :
    shapeVariant === 'arrow'     ? 'arrow' : 'line';

  // Settings are now read from store at begin() time
  tool = new DrawingTool(
    roomDoc,
    'pen',
    userId,
    (_bounds) => overlayLoopRef.current?.invalidateAll(),
    () => overlayLoopRef.current?.invalidateAll(),
    () => viewTransformRef.current,
    { forceSnapKind }
  );
}
```

#### Step 3.3: Update Effect Dependencies (Lines 627-640)
```typescript
// BEFORE
}, [
  roomDoc,
  userId,
  activeTool,
  drawingSettings,       // ❌ DELETE
  highlighterOpacity,    // ❌ DELETE
  eraserSize,            // ❌ DELETE
  textSize,              // Keep for now - TextTool special case
  shapeVariant,          // ✅ KEEP - changes tool behavior
  stageReady,
  screenToWorld,
  worldToClient,
  applyCursor,
]);

// AFTER
}, [
  roomDoc,
  userId,
  activeTool,
  textSize,              // ⚠️ Keep - TextTool needs special handling
  shapeVariant,
  stageReady,
  screenToWorld,
  worldToClient,
  applyCursor,
]);
```

#### Step 3.4: Clean Up Unused Destructuring

Check if these are used elsewhere in Canvas.tsx:
```typescript
// Line 56-63 - may need cleanup
const {
  activeTool,
  drawingSettings,       // May still be needed for TextTool
  highlighterOpacity,    // Can remove if only used for DrawingTool
  eraserSize,            // DELETE - never needed
  textSize,
  shapeVariant
} = useDeviceUIStore();
```

**After analysis:** `drawingSettings.color` is still used for TextTool config (line 432, 545), so keep `drawingSettings` but only use it for TextTool.

---

### Phase 4: TextTool Decision

**Current situation:** TextTool has a working workaround with `updateConfig()`. Two options:

#### Option A: Keep Current Workaround (RECOMMENDED for this phase)
- TextTool already works correctly
- The `updateConfig()` method is specifically designed for live updates during editing
- Keep `textSize` and `drawingSettings.color` in effect deps for this special case
- Refactor later when implementing full select tool (text editing will be in select mode)

#### Option B: Full Refactor (Defer to later)
- Make TextTool import store directly
- Remove `config` constructor param
- Read settings at `begin()` time
- Keep `updateConfig()` for during-edit updates
- More complex, save for SelectTool implementation

**Decision: Option A - minimal changes for now.**

---

## Final Effect Dependencies

After all changes:

```typescript
useEffect(() => {
  // Special handling for text tool config changes during editing
  if (activeTool === 'text' && toolRef.current?.isActive()) {
    const textTool = toolRef.current as any;
    if ('updateConfig' in textTool) {
      textTool.updateConfig({ size: textSize, color: drawingSettings.color });
      return;
    }
  }

  // Tool creation logic...
}, [
  roomDoc,
  userId,
  activeTool,
  textSize,           // Only for TextTool updateConfig
  drawingSettings,    // Only for TextTool updateConfig (reads .color)
  shapeVariant,       // Changes tool behavior (forceSnapKind)
  stageReady,
  screenToWorld,
  worldToClient,
  applyCursor,
]);
```

**Wait!** This still has `drawingSettings` in deps which defeats the purpose. Need to refactor TextTool too OR extract only color.

**Better solution:**
```typescript
// Use narrow selector for TextTool color only
const textColor = useDeviceUIStore(s => s.drawingSettings.color);
const textSize = useDeviceUIStore(s => s.textSize);
const activeTool = useDeviceUIStore(s => s.activeTool);
const shapeVariant = useDeviceUIStore(s => s.shapeVariant);
// Don't destructure drawingSettings object!

// Then in effect:
if (activeTool === 'text' && toolRef.current?.isActive()) {
  const textTool = toolRef.current as any;
  if ('updateConfig' in textTool) {
    textTool.updateConfig({ size: textSize, color: textColor });
    return;
  }
}

// Dependencies:
], [
  roomDoc,
  userId,
  activeTool,
  textSize,        // Only TextTool
  textColor,       // Only TextTool (narrow selector!)
  shapeVariant,
  stageReady,
  screenToWorld,
  worldToClient,
  applyCursor,
]);
```

**This is the cleanest solution** - narrow selectors prevent unnecessary rerenders from other settings changes.

---

## Implementation Checklist

### Phase 1: EraserTool Cleanup
- [ ] Remove `_settings`, `_userId`, `_getViewport` params from EraserTool constructor
- [ ] Update Canvas.tsx EraserTool construction to not pass these params
- [ ] Remove `eraserSize` from Canvas.tsx effect deps
- [ ] Clean up unused imports/destructuring

### Phase 2: DrawingTool Refactor
- [ ] Add `useDeviceUIStore` import to DrawingTool.ts
- [ ] Remove `settings` constructor parameter
- [ ] Remove `this.settings` class property
- [ ] Add `getFrozenSettings()` private method
- [ ] Add `getFillEnabled()` private method (reads live for fill toggle)
- [ ] Update `resetState()` to use `getFrozenSettings()`
- [ ] Update `startDrawing()` to use `getFrozenSettings()`
- [ ] Update `getPreview()` fill to use `getFillEnabled()`
- [ ] Update `commitPerfectShapeFromPreview()` fill to use `getFillEnabled()`

### Phase 3: Canvas.tsx Updates
- [ ] Update pen/highlighter tool creation (remove settings param)
- [ ] Update shape tool creation (remove settings param)
- [ ] Switch from `drawingSettings` object to narrow selectors
- [ ] Add `textColor` narrow selector
- [ ] Update TextTool updateConfig to use `textColor` and `textSize`
- [ ] Update effect dependencies (remove broad settings objects)

### Phase 4: Verification
- [ ] Run TypeScript (`npm run typecheck`)
- [ ] Test pen tool: draw, change color, draw again
- [ ] Test highlighter tool: draw, change size, draw again
- [ ] Test shape tool: draw rectangle, toggle fill during drag, commit
- [ ] Test eraser tool: erase strokes
- [ ] Test text tool: type text, change color while editing, commit
- [ ] Test tool switching: pen → eraser → pen (settings persist)

---

## Code Snippets Reference

### New DrawingTool Constructor
```typescript
constructor(
  room: IRoomDocManager,
  toolType: 'pen' | 'highlighter',
  userId: string,
  onInvalidate?: (bounds: [number, number, number, number]) => void,
  requestOverlayFrame?: RequestOverlayFrame,
  getView?: () => ViewTransform,
  opts?: { forceSnapKind?: ForcedSnapKind }
) {
  this.room = room;
  this.toolType = toolType;
  this.userId = userId;
  this.onInvalidate = onInvalidate;
  this.requestOverlayFrame = requestOverlayFrame;
  this.getView = getView;
  this.opts = opts ?? {};
  this.hold = new HoldDetector(() => this.onHoldFire());
  this.resetState();
}
```

### New Settings Getter Methods
```typescript
private getFrozenSettings(): { size: number; color: string; opacity: number } {
  const state = useDeviceUIStore.getState();
  const base = state.drawingSettings;

  return {
    size: base.size,
    color: base.color,
    opacity: this.toolType === 'highlighter'
      ? state.highlighterOpacity
      : (base.opacity ?? 1),
  };
}

private getFillEnabled(): boolean {
  return useDeviceUIStore.getState().drawingSettings.fill;
}
```

### New EraserTool Constructor
```typescript
constructor(
  room: IRoomDocManager,
  onInvalidate?: () => void,
  getView?: () => ViewTransform,
) {
  this.room = room;
  this.onInvalidate = onInvalidate;
  this.getView = getView;
  this.resetState();
}
```

### Canvas.tsx Narrow Selectors
```typescript
// Replace broad destructuring with narrow selectors
const activeTool = useDeviceUIStore(s => s.activeTool);
const shapeVariant = useDeviceUIStore(s => s.shapeVariant);
const textSize = useDeviceUIStore(s => s.textSize);
const textColor = useDeviceUIStore(s => s.drawingSettings.color);
```

---

## Risks and Mitigations

### Risk 1: Fill Toggle During Shape Preview
**Risk:** Fill toggle might not work during shape preview if we freeze settings.
**Mitigation:** `getFillEnabled()` reads live from store, preserving current behavior.

### Risk 2: Settings Object Reference Equality
**Risk:** Using `drawingSettings` object in deps triggers on ANY change.
**Mitigation:** Use narrow selectors that only change when specific values change.

### Risk 3: TypeScript Errors
**Risk:** Changing constructor signatures breaks existing imports.
**Mitigation:** Update all call sites in same commit.

### Risk 4: Memory Leaks from Store Subscriptions
**Risk:** Tools importing store might leak.
**Mitigation:** Tools use `getState()` (synchronous read), not `subscribe()`. No cleanup needed.

---

## Success Criteria

After implementation:

1. **Settings changes do NOT recreate tools** (except TextTool during editing, which uses updateConfig)
2. **Color/size changes work correctly** - next stroke uses new settings
3. **Fill toggle works during shape preview** - preview updates live
4. **Eraser works with fixed radius** - no settings dependency
5. **TextTool updateConfig still works** - live updates during editing
6. **TypeScript compiles** - no type errors
7. **No runtime errors** - all tools function correctly

---

## Next Steps After This Refactor

Once this prep phase is complete:

1. **Implement SelectionStore** (`client/src/stores/selection-store.ts`)
2. **Implement SelectTool** (`client/src/lib/tools/SelectTool.ts`)
3. **Add SelectTool to Canvas.tsx** tool creation
4. **Wire renderer** to apply transforms from SelectionStore
5. **Add selection preview** to OverlayRenderLoop
6. **Implement toolbar context-aware behavior** for selection

The architecture established here makes SelectTool implementation straightforward because:
- Tools can now import stores directly
- Tool lifetime is decoupled from settings
- Pattern for reading live values (fill) is established
- Narrow selectors prevent spurious rerenders
