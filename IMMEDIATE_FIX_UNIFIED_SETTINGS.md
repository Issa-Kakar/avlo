# Immediate Fix for Unified Settings Size Bug

## Quick Fix (Apply These Changes Now)

### 1. Fix ToolPanel.tsx getCurrentSettings()
**File**: `/client/src/pages/components/ToolPanel.tsx`

Replace lines 62-77:
```typescript
// Get current settings based on active tool
const getCurrentSettings = () => {
  const store = useDeviceUIStore.getState();
  const base = store.drawingSettings;

  switch (activeTool) {
    case 'text':
      // Use textSize for text tool
      return { ...base, size: store.textSize };
    case 'eraser':
      // Use eraserSize for eraser tool
      return { ...base, size: store.eraserSize };
    case 'highlighter':
      // Use highlighter opacity override
      return { ...base, opacity: store.highlighterOpacity };
    default:
      // Pen, shape, etc use base settings
      return base;
  }
};
```

### 2. Fix ToolPanel.tsx handleSizeChange

After line 44, add:
```typescript
// Handle size changes based on active tool
const handleSizeChange = (size: number) => {
  const store = useDeviceUIStore.getState();

  switch (activeTool) {
    case 'text':
      // Text uses different size scale
      store.setTextSize(size as TextSizePreset);
      break;
    case 'eraser':
      // Eraser has its own size
      store.setEraserSize(size as SizePreset);
      break;
    default:
      // Pen, highlighter, shapes use drawing size
      store.setDrawingSize(size as SizePreset);
  }
};
```

### 3. Update Inspector Props

Replace line 245:
```typescript
// OLD:
onSizeChange={(size: number) => setDrawingSize(size as SizePreset)}

// NEW:
onSizeChange={handleSizeChange}
```

### 4. Add Type Validation to Store

**File**: `/client/src/stores/device-ui-store.ts`

Replace setDrawingSize (lines 135-138):
```typescript
setDrawingSize: (size) => {
  // Validate size is actually a SizePreset
  if (![10, 14, 18, 22].includes(size)) {
    console.error(`Invalid SizePreset: ${size}. Expected 10, 14, 18, or 22`);
    return;
  }
  set((state) => ({
    drawingSettings: { ...state.drawingSettings, size },
  }));
},
```

### 5. Remove Duplicate Fill State

**File**: `/client/src/stores/device-ui-store.ts`

Remove line 85:
```typescript
// DELETE THIS LINE:
fillEnabledUI: false, // Default fill state for shapes
```

### 6. Fix Fill Toggle in ToolPanel

**File**: `/client/src/pages/components/ToolPanel.tsx`

Update line 247:
```typescript
// OLD:
onFillToggle={() => setFillEnabled(!drawingSettings.fill)}

// KEEP AS IS - this is correct!
```

## Complete Fixed ToolPanel.tsx (lines 28-250)

Here's the complete working version with all fixes:

```typescript
export function ToolPanel({ onToast, onUndo, onRedo }: ToolPanelProps) {
  const {
    activeTool,
    drawingSettings,
    setFillEnabled,
    setDrawingSize,
    setTextSize,
    setEraserSize,
    shapeVariant,
    textSize,
    eraserSize,
    highlighterOpacity,
    fixedColors,
    recentColors,
    isColorPopoverOpen,
    setActiveTool,
    setDrawingColor,
    addRecentColor,
    setColorPopoverOpen,
    setShapeVariant,
  } = useDeviceUIStore();

  const popoverRef = useRef<HTMLDivElement>(null);

  // Handle size changes based on active tool
  const handleSizeChange = (size: number) => {
    switch (activeTool) {
      case 'text':
        setTextSize(size as TextSizePreset);
        break;
      case 'eraser':
        setEraserSize(size as SizePreset);
        break;
      default:
        setDrawingSize(size as SizePreset);
    }
  };

  // Determine if inspector should show
  const showInspector = ['pen', 'highlighter', 'text', 'select', 'shape'].includes(
    activeTool,
  );
  const showColors = !['eraser', 'pan', 'image'].includes(activeTool);
  const showSizes = !['pan', 'image'].includes(activeTool);
  const showFillToggle =
    activeTool === 'shape' ||
    activeTool === 'pen' ||
    activeTool === 'highlighter' ||
    activeTool === 'select';

  // Get current settings based on active tool
  const getCurrentSettings = () => {
    const base = drawingSettings;

    switch (activeTool) {
      case 'text':
        return { ...base, size: textSize };
      case 'eraser':
        return { ...base, size: eraserSize };
      case 'highlighter':
        return { ...base, opacity: highlighterOpacity };
      default:
        return base;
    }
  };

  const currentSettings = getCurrentSettings();

  // Size presets
  const getSizePresets = () => {
    if (activeTool === 'text') return [20, 30, 40, 50];
    return [10, 14, 18, 22]; // Same for pen, highlighter, eraser, shapes
  };

  const sizePresets = getSizePresets();
  const sizeLabels = ['S', 'M', 'L', 'XL'];

  // ... rest of component stays the same until Inspector ...

  {showInspector && (
    <Inspector
      fillEnabled={drawingSettings.fill}
      drawingSettings={drawingSettings}
      showColors={showColors}
      showSizes={showSizes}
      showFillToggle={showFillToggle}
      fixedColors={fixedColors}
      recentColors={recentColors}
      sizePresets={sizePresets}
      sizeLabels={sizeLabels}
      currentColor={currentSettings.color}
      currentSize={currentSettings.size}
      isColorPopoverOpen={isColorPopoverOpen}
      popoverRef={popoverRef}
      onColorChange={setDrawingColor}
      onSizeChange={handleSizeChange}  // Use the new handler!
      onColorPopoverToggle={() => setColorPopoverOpen(!isColorPopoverOpen)}
      onFillToggle={() => setFillEnabled(!drawingSettings.fill)}
      addRecentColor={(color: string) => addRecentColor(color)}
    />
  )}
```

## Verification Steps

After applying these fixes:

1. **Test Pen Tool**:
   - Select pen
   - Click S → Should be thin (10px)
   - Click XL → Should be thick (22px)
   - Size indicator should show active selection

2. **Test Text Tool**:
   - Select text
   - Click S → Should be small text (20px)
   - Click XL → Should be large text (50px)
   - Size indicator should show active selection

3. **Test Tool Switching**:
   - Set pen to S (10px)
   - Switch to text → Should show M as active (30px is closest)
   - Set text to XL (50px)
   - Switch back to pen → Should still be S (10px)

4. **Test Colors Carry Over**:
   - Set pen to red
   - Switch to text → Should be red
   - Switch to shape → Should be red

## Why This Fixes The Problem

1. **Size Corruption Fixed**: Each tool now calls its own setter (setTextSize, setEraserSize, setDrawingSize)
2. **Type Safety Restored**: No more casting TextSizePreset to SizePreset
3. **UI State Correct**: getCurrentSettings returns proper size for each tool
4. **Active Indicator Works**: currentSize now matches the preset values

## Notes

- This is a minimal fix that preserves the current architecture
- A cleaner long-term solution would use discriminated unions or normalized size levels
- The Canvas.tsx file is already correct and doesn't need changes
- The store's getCurrentToolSettings() method could replace the local getCurrentSettings() function