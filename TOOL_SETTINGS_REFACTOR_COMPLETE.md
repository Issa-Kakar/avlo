# Tool Settings Refactor - Complete

**Date:** 2025-11-26
**Branch:** `feature/select-tool`
**Purpose:** Decouple tool lifetime from settings changes in preparation for SelectTool

---

## Summary

This refactor changes how tools (DrawingTool, EraserTool) receive their settings. Previously, settings were passed as constructor parameters, causing tools to be destroyed and recreated whenever the user changed color, size, or fill. Now tools read settings directly from the Zustand store at gesture start (`begin()` time), allowing:

1. **Tool persistence** - Tools survive settings changes
2. **SelectTool foundation** - Future SelectTool can persist selection while user changes settings
3. **Cleaner architecture** - Removes dead code and unused parameters

---

## Changes by File

### 1. `client/src/lib/tools/DrawingTool.ts`

**Removed:**
- `private settings: DrawingSettings` class property
- `settings` constructor parameter

**Added:**
- Import: `import { useDeviceUIStore } from '@/stores/device-ui-store';`
- Helper method `getFrozenSettings()` - reads and freezes color/size/opacity at gesture start:
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
  ```
- Helper method `getFillEnabled()` - reads fill LIVE (not frozen) to allow toggling during preview:
  ```typescript
  private getFillEnabled(): boolean {
    return useDeviceUIStore.getState().drawingSettings.fill;
  }
  ```

**Updated:**
- `resetState()` - now calls `getFrozenSettings()` instead of reading `this.settings`
- `startDrawing()` - freezes settings from store at gesture start
- `getPreview()` - uses `getFillEnabled()` for live fill toggle
- `commitPerfectShapeFromPreview()` - uses `getFillEnabled()` at commit time

**New Constructor Signature:**
```typescript
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

### 2. `client/src/lib/tools/EraserTool.ts`

**Removed (3 unused parameters):**
- `_settings: any` - eraser uses fixed 10px radius
- `_userId: string` - not needed for erasing
- `_getViewport?: any` - unused viewport callback

**New Constructor Signature:**
```typescript
constructor(
  room: IRoomDocManager,
  onInvalidate?: () => void,
  getView?: () => ViewTransform,
)
```

### 3. `client/src/canvas/Canvas.tsx`

**Changed from object destructuring to narrow selectors:**
```typescript
// BEFORE (caused rerenders on ANY setting change)
const { activeTool, drawingSettings, highlighterOpacity, eraserSize, ... } = useDeviceUIStore();

// AFTER (only rerenders when specific values change)
const activeTool = useDeviceUIStore(s => s.activeTool);
const shapeVariant = useDeviceUIStore(s => s.shapeVariant);
const textSize = useDeviceUIStore(s => s.textSize);
const textColor = useDeviceUIStore(s => s.drawingSettings.color);
```

**Tool creation updated:**
```typescript
// EraserTool - no settings needed
tool = new EraserTool(
  roomDoc,
  () => overlayLoopRef.current?.invalidateAll(),
  () => viewTransformRef.current,
);

// DrawingTool - settings read from store at begin() time
tool = new DrawingTool(
  roomDoc,
  activeTool, // 'pen' or 'highlighter'
  userId,
  (_bounds) => overlayLoopRef.current?.invalidateAll(),
  () => overlayLoopRef.current?.invalidateAll(),
  () => viewTransformRef.current
);
```

**Effect dependencies cleaned:**
```typescript
useEffect(() => {
  // Tool creation logic...
}, [
  roomDoc,
  userId,
  activeTool,
  textSize,      // Only for TextTool updateConfig
  textColor,     // Only for TextTool updateConfig (narrow selector)
  shapeVariant,  // Changes tool behavior (forceSnapKind)
  stageReady,
  screenToWorld,
  worldToClient,
  applyCursor,
]);
// NOTE: drawingSettings, highlighterOpacity REMOVED
// DrawingTool/EraserTool read from store at begin() time
```

### 4. `client/src/stores/device-ui-store.ts`

**Removed (dead code):**
- `eraserSize: SizePreset` - eraser uses fixed 10px radius
- `setEraserSize()` action
- `select: { enabled: boolean }` placeholder - will be separate store
- `setSelectSettings()` action

**Updated:**
- `getCurrentToolSettings()` - removed eraser case
- Migration function - removed eraserSize and select migration

### 5. `client/src/pages/components/ToolPanel.tsx`

**Removed:**
- `setEraserSize` from store destructuring
- Eraser case from `handleSizeChange()`
- Eraser case from `getCurrentSettings()`
- 'select' from `showInspector` condition (select tool will handle its own UI)

---

## Key Design Decisions

### Frozen vs Live Settings

| Setting | Read When | Why |
|---------|-----------|-----|
| `color` | Frozen at `begin()` | Color shouldn't change mid-stroke |
| `size` | Frozen at `begin()` | Size shouldn't change mid-stroke |
| `opacity` | Frozen at `begin()` | Opacity shouldn't change mid-stroke |
| `fill` | **LIVE** (every frame) | User can toggle fill during shape preview |

### Why Narrow Selectors?

```typescript
// BAD: Object reference changes on ANY property change
const { drawingSettings } = useDeviceUIStore();
// → Effect reruns when size, color, opacity, OR fill changes

// GOOD: Only rerenders when specific value changes
const textColor = useDeviceUIStore(s => s.drawingSettings.color);
// → Effect only reruns when color changes
```

### TextTool Special Case

TextTool kept existing workaround with `updateConfig()` for live editing updates:
```typescript
if (activeTool === 'text' && toolRef.current?.isActive()) {
  const textTool = toolRef.current as any;
  if ('updateConfig' in textTool) {
    textTool.updateConfig({ size: textSize, color: textColor });
    return; // Skip recreation, just update config
  }
}
```
Note: TextTool will be replaced entirely in a future update.

---

## Testing Checklist

- [x] TypeScript compiles (`npm run typecheck`)
- [ ] Pen tool: draw, change color, draw again (new stroke uses new color)
- [ ] Highlighter: draw, change size, draw again (new stroke uses new size)
- [ ] Shape tool: draw rectangle, toggle fill during drag, commit (fill applies)
- [ ] Eraser: erase strokes (fixed 10px radius)
- [ ] Text tool: type text, change color while editing (color updates live)
- [ ] Tool switching: pen → eraser → pen (settings persist)

---

## Next Steps

This refactor establishes the foundation for:

1. **SelectTool Implementation**
   - Create `client/src/stores/selection-store.ts` (transient Zustand store)
   - Implement `client/src/lib/tools/SelectTool.ts`
   - Selection persists across settings changes
   - User can select objects, then change their color/size

2. **Selection Rendering**
   - Add selection preview to OverlayRenderLoop
   - Implement transform handles (resize, rotate)
   - Wire renderer to apply transforms from SelectionStore

---

## Architecture Pattern

Tools now follow this pattern:

```typescript
class SomeTool {
  constructor(room, onInvalidate, ...) {
    // NO settings parameter
  }

  begin(pointerId, worldX, worldY) {
    // FREEZE settings at gesture start
    const settings = useDeviceUIStore.getState();
    this.frozenColor = settings.drawingSettings.color;
    this.frozenSize = settings.drawingSettings.size;
    // ...
  }

  getPreview() {
    // Use frozen settings for preview
    // EXCEPTION: fill is read LIVE for toggle during preview
    return {
      color: this.frozenColor,
      fill: useDeviceUIStore.getState().drawingSettings.fill,
    };
  }
}
```

This pattern allows:
- Tool instances to persist across settings changes
- Settings to be frozen at gesture start (no mid-stroke changes)
- Specific settings (like fill) to be read live when needed
