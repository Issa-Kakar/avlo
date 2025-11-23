# Changelog: Unified Settings Refactoring Attempt

## Date: 2025-11-23

### Context
Attempted to refactor device-ui-store from individual tool settings to unified global settings where color/size carry over between all tools. This was in response to the requirement that "all the settings should carry over, if you switch from a pen to a shape or vice versa the colors shouldn't switch and sizes shouldn't either".

## Changes Made
      // New helper methods for inspector
      setCurrentToolSize: (size) =>
        set((state) => {
          const t = state.activeTool;

          // Convert S/M/L/XL to pixel values
          let mappedSize = typeof size === 'number' ? size : 10;
          if (typeof size === 'string') {
            const sizeMap: Record<string, number> = {
              S: t === 'text' ? 20 : 10,
              M: t === 'text' ? 30 : 14,
              L: t === 'text' ? 40 : 18,
              XL: t === 'text' ? 50 : 22,
            };
            mappedSize = sizeMap[size] || 10;
          }

          // Type guards for proper typing
          const isTextSize = (s: number): s is TextSizePreset => [20, 30, 40, 50].includes(s);
          const isNormalSize = (s: number): s is SizePreset => [10, 14, 18, 22].includes(s);

          if (t === 'pen' && isNormalSize(mappedSize))
            return { pen: { ...state.pen, size: mappedSize } };
          if (t === 'highlighter' && isNormalSize(mappedSize))
            return { highlighter: { ...state.highlighter, size: mappedSize } };
          if (t === 'eraser' && isNormalSize(mappedSize))
            return { eraser: { ...state.eraser, size: mappedSize } };
          if (t === 'text' && isTextSize(mappedSize))
            return { text: { ...state.text, size: mappedSize } };
          if (t === 'shape' && isNormalSize(mappedSize))
            return {
              shape: { ...state.shape, settings: { ...state.shape.settings, size: mappedSize } },
            };
          return {};
        }),

      setCurrentToolColor: (color) =>
        set((state) => {
          const t = state.activeTool;
          if (t === 'eraser' || t === 'pan' || t === 'select' || t === 'image') return {};

          if (t === 'pen') return { pen: { ...state.pen, color } };
          if (t === 'highlighter') return { highlighter: { ...state.highlighter, color } };
          if (t === 'text') return { text: { ...state.text, color } };
          if (t === 'shape')
            return {
              shape: { ...state.shape, settings: { ...state.shape.settings, color } },
            };
          return {};
        }),

          shape: {
            variant: settings.variant ?? state.shape.variant,
            settings: {
              ...state.shape.settings,
              ...(settings.size !== undefined && { size: settings.size }),
              ...(settings.color !== undefined && { color: settings.color }),
              ...(settings.opacity !== undefined && { opacity: settings.opacity }),
            },
          },
        })),
  pen: { size: SizePreset; color: string; opacity?: number };
  highlighter: { size: SizePreset; color: string; opacity?: number };
  eraser: { size: SizePreset }; // Use SizePreset like other tools
  text: { size: TextSizePreset; color: string };
  shape: {
    variant: ShapeVariant;
    settings: { size: SizePreset; color: string; opacity?: number };
  };
  setPenSettings: (
    settings: Partial<{ size: SizePreset; color: string; opacity?: number }>,
  ) => void;
  setHighlighterSettings: (
    settings: Partial<{ size: SizePreset; color: string; opacity?: number }>,
  ) => void;
  setTextSettings: (settings: Partial<{ size: TextSizePreset; color: string }>) => void;
  setShapeSettings: (
    settings: Partial<
      { variant: ShapeVariant } & { size: SizePreset; color: string; opacity?: number }
    >,
  ) => void;
  // New helper methods for inspector
  setCurrentToolSize: (size: number | string) => void;
  setCurrentToolColor: (color: string) => void;

### 1. device-ui-store.ts - Major Refactoring (INCOMPLETE)

#### Interfaces Changed
- **REMOVED:** `export interface ToolSettings` (was at line 11)
- **ADDED:** `export interface DrawingSettings` (lines 11-17)
  ```typescript
  export interface DrawingSettings {
    size: SizePreset;
    color: string;
    opacity: number;
    fill: boolean;  // Whether fill is enabled (only affects shapes)
  }
  ```

#### State Structure Changed (lines 19-38)
- **REMOVED:** Individual tool settings objects:
  - `pen: { size: SizePreset; color: string; opacity?: number }`
  - `highlighter: { size: SizePreset; color: string; opacity?: number }`
  - `eraser: { size: SizePreset }`
  - `text: { size: TextSizePreset; color: string }`
  - `shape: { variant: ShapeVariant; settings: { size: SizePreset; color: string; opacity?: number } }`

- **ADDED:** Unified settings structure:
  - `drawingSettings: DrawingSettings` - Global settings all tools share
  - `highlighterOpacity: number` - Highlighter-specific opacity override
  - `eraserSize: SizePreset` - Eraser-specific size
  - `textSize: TextSizePreset` - Text-specific size scale
  - `shapeVariant: ShapeVariant` - Which shape is selected

#### Actions Changed (lines 53-80)
- **REMOVED:** Old per-tool setters:
  - `setPenSettings`
  - `setHighlighterSettings`
  - `setEraserSize` (old signature)
  - `setTextSettings`
  - `setShapeSettings`
  - `setCurrentToolSize`
  - `setCurrentToolColor`
  - `setFillEnabledUI`

- **ADDED:** New unified setters:
  - `setDrawingSettings: (settings: Partial<DrawingSettings>) => void`
  - `setDrawingSize: (size: SizePreset) => void`
  - `setDrawingColor: (color: string) => void`
  - `setDrawingOpacity: (opacity: number) => void`
  - `setFillEnabled: (enabled: boolean) => void`
  - `setHighlighterOpacity: (opacity: number) => void`
  - `setEraserSize: (size: SizePreset) => void` (new signature)
  - `setTextSize: (size: TextSizePreset) => void`
  - `setShapeVariant: (variant: ShapeVariant) => void`
  - `getCurrentToolSettings: () => { size: number; color: string; opacity: number; fill?: boolean }`

#### Implementation Changed (lines 82-227)
- **CHANGED:** Default state initialization (lines 85-124)
  - Added unified `drawingSettings` with defaults
  - Added tool-specific overrides with defaults
  - **BUG:** Kept `fillEnabledUI: false` at line 85 (duplicate of drawingSettings.fill)

- **ADDED:** New action implementations (lines 127-207)
  - All unified setters implemented
  - `getCurrentToolSettings` helper that returns appropriate settings based on active tool
    - Returns base unified settings
    - Overrides with tool-specific values (highlighter opacity, eraser size, text size)
    - Removes fill for pen tool

#### Migration Changed (lines 229-320)
- **CHANGED:** localStorage key from `'avlo.toolbar.v2'` to `'avlo.toolbar.v3'`
- **CHANGED:** version from 3 to 4
- **ADDED:** Migration logic to convert old per-tool settings to unified settings

### 2. Canvas.tsx - Partial Updates (BREAKING)

#### Line 59-66: Changed Store Destructuring
- **BEFORE:**
  ```typescript
  const { activeTool, pen, highlighter, eraser, text, shape } = useDeviceUIStore();
  ```
- **AFTER:**
  ```typescript
  const {
    activeTool,
    drawingSettings,
    highlighterOpacity,
    eraserSize,
    textSize,
    shapeVariant
  } = useDeviceUIStore();
  ```

#### Lines 439-444: Updated Text Tool Config Update
- **BEFORE:**
  ```typescript
  textTool.updateConfig(text);
  ```
- **AFTER:**
  ```typescript
  const textConfig = {
    size: textSize,
    color: drawingSettings.color
  };
  textTool.updateConfig(textConfig);
  ```

#### Lines 478-500: Updated Eraser Tool Initialization
- **BEFORE:**
  ```typescript
  tool = new EraserTool(
    roomDoc,
    eraser, // Direct from store
    userId,
    ...
  ```
- **AFTER:**
  ```typescript
  const eraserSettings = { size: eraserSize };
  tool = new EraserTool(
    roomDoc,
    eraserSettings,
    userId,
    ...
  ```

#### Lines 501-508: Updated Pen/Highlighter Tool Initialization
- **BEFORE:**
  ```typescript
  const settings = activeTool === 'pen' ? pen : highlighter;
  ```
- **AFTER:**
  ```typescript
  const settings = {
    size: drawingSettings.size,
    color: drawingSettings.color,
    opacity: activeTool === 'highlighter' ? highlighterOpacity : drawingSettings.opacity,
    fill: drawingSettings.fill  // Include fill for perfect shape recognition
  };
  ```

#### Lines 525-539: Updated Shape Tool Initialization
- **BEFORE:**
  ```typescript
  const variant = shape?.variant ?? 'rectangle';
  const forceSnapKind =
    variant === 'rectangle' ? 'rect' : ...

  const fillEnabled = useDeviceUIStore.getState().fillEnabledUI;
  const settings = {
    ...(shape?.settings ?? pen),
    fill: fillEnabled
  };
  ```
- **AFTER:**
  ```typescript
  const forceSnapKind =
    shapeVariant === 'rectangle' ? 'rect' : ...

  const settings = {
    size: drawingSettings.size,
    color: drawingSettings.color,
    opacity: drawingSettings.opacity,
    fill: drawingSettings.fill
  };
  ```

#### Lines 551-567: Updated Text Tool Initialization
- **BEFORE:**
  ```typescript
  tool = new TextTool(
    roomDoc,
    text, // From Zustand store
    userId,
    ...
  ```
- **AFTER:**
  ```typescript
  const textSettings = {
    size: textSize,
    color: drawingSettings.color
  };
  tool = new TextTool(
    roomDoc,
    textSettings,
    userId,
    ...
  ```

#### Lines 637-649: **BUG - Unchanged Dependencies**
- useEffect still references non-existent variables: `pen`, `highlighter`, `eraser`, `text`, `shape`
- This causes TypeScript errors and will cause runtime crashes

### 3. Files NOT Updated (Breaking Changes)

#### ToolPanel.tsx - COMPLETELY BROKEN
- Still expects old store structure with `pen`, `highlighter`, `eraser`, `text`, `shape` properties
- Calls non-existent methods: `setShapeSettings`, `setCurrentToolSize`, `setCurrentToolColor`, `setFillEnabledUI`

#### DrawingTool.ts - TYPE ERROR
- Line 8: Still imports `ToolSettings` which no longer exists
- Line 536: Has to use `(this.settings as any).fill` due to missing type

## Critical Issues Created

1. **Type Errors:**
   - `ToolSettings` export removed but still imported by DrawingTool.ts
   - Canvas.tsx references non-existent store properties in useEffect dependencies

2. **Duplicate State:**
   - Both `fillEnabledUI` and `drawingSettings.fill` exist in store
   - Unclear which should be authoritative

3. **Incomplete Migration:**
   - ToolPanel.tsx not updated to new store structure
   - Canvas.tsx useEffect dependencies not updated
   - Other components may also be broken

4. **Runtime Crashes:**
   - Canvas.tsx useEffect will crash when dependencies are evaluated
   - ToolPanel.tsx will crash when trying to access non-existent properties

## Recommendation

This refactoring attempt is incomplete and has introduced breaking changes. The system is currently in an unstable state. Options:

1. **Complete the migration:** Fix all consumers of the store to use new structure
2. **Revert changes:** Return to the previous working state
3. **Hybrid approach:** Keep unified settings concept but maintain backward compatibility

The unified settings concept is correct for the requirement, but the implementation needs to be completed properly with all consumers updated.