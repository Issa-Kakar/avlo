# Complete Stamp Removal Guide

## Executive Summary

This guide provides step-by-step instructions to completely remove the stamps implementation from the Avlo codebase and replace it with a placeholder Selection/Lasso tool in the UI (without implementing actual lasso functionality).

## Part 1: Complete File Deletions

### Delete these files entirely:

1. **`/client/src/lib/tools/StampTool.ts`**
   - Complete StampTool class implementation (128 lines)
   - Command: `rm /home/issak/dev/avlo/client/src/lib/tools/StampTool.ts`

2. **`/client/src/renderer/layers/stamps.ts`**
   - Stamp rendering layer with STAMP_PATHS and drawStamps function (109 lines)
   - Command: `rm /home/issak/dev/avlo/client/src/renderer/layers/stamps.ts`

## Part 2: File Modifications

### 2.1 Canvas Component (`/client/src/canvas/Canvas.tsx`)

**Remove lines:**

- Line 15: Remove import: `import { StampTool } from '@/lib/tools/StampTool';`
- Line 20: Change `type PointerTool = DrawingTool | EraserTool | TextTool | StampTool | null;`
  to: `type PointerTool = DrawingTool | EraserTool | TextTool | null;`
- Line 161: Remove `stamp` from destructuring:
  ```typescript
  const { pen, highlighter, text, eraser, stamp } = useDeviceUIStore((state) => ({
  ```
  Change to:
  ```typescript
  const { pen, highlighter, text, eraser } = useDeviceUIStore((state) => ({
  ```
- Lines 532-536: Remove stamp tool instantiation:
  ```typescript
  } else if (activeTool === 'stamp') {
    tool = new StampTool(roomDoc, stamp, userId, () =>
      overlayLoopRef.current?.invalidateAll(),
    );
  }
  ```
- Line 681: Remove `stamp` from dependencies array

### 2.2 Device UI Store (`/client/src/stores/device-ui-store.ts`)

**Changes:**

- Line 4: Change `Tool` type from:

  ```typescript
  export type Tool = 'pointer' | 'pen' | 'highlighter' | 'eraser' | 'text' | 'stamp' | 'select';
  ```

  to:

  ```typescript
  export type Tool = 'pointer' | 'pen' | 'highlighter' | 'eraser' | 'text' | 'select';
  ```

- Lines 19-23: **REPLACE** stamp object with selection object:

  ```typescript
  // Remove:
  stamp: {
    selected: 'circle' | 'square' | 'triangle' | 'star' | 'heart';
    scale: number;
    color?: string;
  };

  // Add:
  selection: {
    // Placeholder for future lasso implementation
    enabled: boolean;
  };
  ```

- Lines 42-48: **REPLACE** setStampSettings with setSelectionSettings:

  ```typescript
  // Remove:
  setStampSettings: (settings: Partial<DeviceUIState['stamp']>) => void;

  // Add:
  setSelectionSettings: (settings: Partial<DeviceUIState['selection']>) => void;
  ```

- Line 73: **REPLACE** stamp defaults with selection defaults:

  ```typescript
  // Remove:
  stamp: { selected: 'circle', scale: 1.0, color: '#666666' },

  // Add:
  selection: { enabled: false },
  ```

- Lines 105-107: **REPLACE** setStampSettings implementation:

  ```typescript
  // Remove:
  setStampSettings: (settings) =>
    set((state) => ({ stamp: { ...state.stamp, ...settings } })),

  // Add:
  setSelectionSettings: (settings) =>
    set((state) => ({ selection: { ...state.selection, ...settings } })),
  ```

### 2.3 Tool Panel (`/client/src/pages/components/ToolPanel.tsx`)

**Changes:**

- Line 35: Remove `stamp` from destructuring
- Line 38: Remove `setStampSettings` from destructuring
- Lines 156-158: Update tool click handler condition from:

  ```typescript
  if (tool !== 'stamp' && tool !== 'select') {
  ```

  to:

  ```typescript
  if (tool !== 'select') {
  ```

- Lines 236-259: **REPLACE** stamp tool button with selection tool button:

  ```tsx
  // Remove stamp button and replace with:
  <Tooltip content="Selection Tool (V)" side="right">
    <button
      className={cn('tool-btn', activeTool === 'select' && 'active')}
      onClick={() => handleToolSelect('select')}
      aria-label="Selection Tool"
      aria-pressed={activeTool === 'select'}
    >
      <svg
        className="tool-icon"
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      >
        {/* Lasso selection icon */}
        <path
          d="M 4 4 L 10 4 L 10 10 M 10 10 L 16 10 L 16 16 M 16 16 L 10 16 L 10 20 L 4 20 L 4 4"
          strokeDasharray="2 2"
        />
      </svg>
    </button>
  </Tooltip>
  ```

- Lines 301-331: **REMOVE** entire stamp settings panel:
  ```tsx
  // Delete this entire block:
  {
    activeTool === 'stamp' && (
      <div className="stamp-picker">{/* ... all stamp picker content ... */}</div>
    );
  }
  ```

### 2.4 Type Definitions (`/client/src/lib/tools/types.ts`)

**Remove:**

- Lines 61-71: Delete entire `StampPreview` interface
- Line 77: Update `PreviewData` union type from:
  ```typescript
  export type PreviewData = StrokePreview | EraserPreview | TextPreview | StampPreview;
  ```
  to:
  ```typescript
  export type PreviewData = StrokePreview | EraserPreview | TextPreview;
  ```

### 2.5 Render Layers Index (`/client/src/renderer/layers/index.ts`)

**Changes:**

- Line 11: Remove import: `import { drawStamps } from './stamps';`
- Lines 34-35: Remove `drawStamps` call from `drawShapes` function

### 2.6 Overlay Render Loop (`/client/src/renderer/OverlayRenderLoop.ts`)

**Remove:**

- Lines 184-242: Delete entire stamp preview rendering block:
  ```typescript
  } else if (previewToDraw.kind === 'stamp') {
    // ... entire stamp preview rendering ...
  }
  ```

### 2.7 Eraser Tool (`/client/src/lib/tools/EraserTool.ts`)

**Remove:**

- Lines 214-233: Delete special stamp hit-testing logic:
  ```typescript
  // Special handling for stamps (which use a single point, not segments)
  if ((stroke as any).tool === 'stamp') {
    // ... entire stamp collision detection ...
    continue; // Skip segment test
  }
  ```

### 2.8 CSS Styles (`/client/src/index.css`)

**Remove all stamp-related CSS classes:**

```css
/* Delete these entire blocks: */
.stamp-picker { ... }
.stamp-btn { ... }
.stamp-btn:hover { ... }
.stamp-btn.active { ... }
```

### 2.9 Shared Types (`/packages/shared/src/types/snapshot.ts`)

**Change:**

- Line 35: Update `StrokeView` interface from:
  ```typescript
  tool: 'pen' | 'highlighter' | 'stamp';
  ```
  to:
  ```typescript
  tool: 'pen' | 'highlighter';
  ```

## Part 3: Documentation Updates

### 3.1 OVERVIEW.MD Updates

Search and remove all references to stamps:

1. **Section 3 (Scope)**: Remove stamps from the "In" list
2. **Section 4 (Data Models)**: Remove any stamp-related types or fields
3. **Section 6 (Functional Requirements)**: Remove stamp tool from whiteboard tools
4. **Critical note at line 819-821**: Remove the deprecated stamps note

### 3.2 condensed_implementation.md Updates

Remove all stamp references:

1. **Phase 9 Section**:
   - Update title to only mention Text Tool
   - Remove Section 9.2 (Stamps — deprecation & removal plan) entirely
   - Remove stamps from integration contracts (Section 9.3)
   - Update any references to "Text & Stamps Tools" to just "Text Tool"

2. **Remove stamp mentions from**:
   - Tool types
   - Preview types
   - Rendering pipelines
   - UI integration sections

## Part 4: Verification Checklist

After completing all removals, verify:

- [ ] No files contain `StampTool` imports
- [ ] No files contain `drawStamps` function calls
- [ ] No files contain `StampPreview` type references
- [ ] No files contain `stampType` field references
- [ ] No files contain `tool: 'stamp'` references
- [ ] No CSS classes with `.stamp-` prefix remain
- [ ] Tool panel shows Selection/Lasso tool instead of Stamps
- [ ] Keyboard shortcut 'V' still works for Selection tool
- [ ] Device UI store has `select` instead of `stamp` state
- [ ] Build compiles without TypeScript errors
- [ ] Application runs without console errors

## Part 5: Git Commit

After all changes are complete, commit with:

```bash
git add -A
git commit -m "refactor: remove stamps implementation and replace with selection tool placeholder

- Deleted StampTool.ts and stamps.ts rendering layer
- Removed all stamp-related types, state, and UI components
- Replaced stamp tool with selection/lasso placeholder in toolbar
- Cleaned up eraser special handling for stamps
- Updated documentation to remove all stamp references
- Maintained keyboard shortcut (V) for selection tool"
```

## Notes

- The Selection/Lasso tool is added as a **placeholder only** - no actual lasso functionality is implemented
- The 'V' keyboard shortcut already maps to 'select' tool and will continue working
- No server-side changes required (server is tool-agnostic)
- All stamps stored in existing rooms will no longer render but won't cause errors
