# UI Architecture Refactor Guide - Phase 7 Cleanup

## Overview

This guide details a comprehensive UI refactor to fix critical UX issues and prepare the architecture for future phases (8-17). The refactor focuses on clarity, removing redundancy, and establishing patterns that will scale.

## Critical Issues to Fix (Verified Through Codebase Investigation)

### 1. 🔴 CRITICAL: Editor Panel Cannot Be Re-Expanded

**Problem**: Toggle button is inside the panel at `EditorPanel.tsx:18`. When collapsed (translateX(100%)), the button becomes inaccessible.
**Location**: `/client/src/pages/components/EditorPanel.tsx`
**Impact**: Users are permanently stuck without code editor access.

### 2. 🔴 CRITICAL: Zoom Controls Are Completely Broken

**Problem**: ZoomControls (`ZoomControls.tsx:9`) uses `useDeviceUIStore()` zoom field (0.25-2.0) instead of `useViewTransform()` from ViewTransformContext (0.1-10).
**Locations**:

- Broken: `/client/src/pages/components/ZoomControls.tsx`
- Should use: `/client/src/canvas/ViewTransformContext.tsx`
  **Impact**: Zoom UI buttons have zero effect on actual canvas scale. Also missing wheel zoom implementation.

### 3. 🟡 HIGH: Triple DeviceUIState Confusion

**Problem**: Three different `DeviceUIState` interfaces causing confusion:

1. `/packages/shared/src/types/device-state.ts:11` - Has `toolbar` sub-object
2. `/client/src/stores/device-ui-store.ts:12` - Flat structure with tool settings
3. `/client/src/lib/tools/types.ts:37` - Simplified for DrawingTool only
   **Impact**: Extreme confusion, especially when adding new tools.

### 4. 🟡 HIGH: CanvasPane Redundancy

**Problem**: CanvasPane (`CanvasPane.tsx`) creates canvas ref that doesn't exist, duplicates DPR/resize logic that Canvas/CanvasStage already handle internally.
**Location**: `/client/src/pages/components/CanvasPane.tsx`
**Impact**: Unnecessary complexity, potentially conflicting resize observers.

## Execution Order

Execute these changes in the following order to maintain a working application:

## Phase 1: Fix Critical UX Issues

### 1.1 Fix Editor Panel Collapse/Expand

**File**: `client/src/pages/components/EditorPanel.tsx`

**Current Problem**: Toggle button is inside the panel at line 18-22, becomes inaccessible when collapsed.

**Solution A: Add Floating Expand Tab (Recommended)**

```tsx
// Add OUTSIDE the collapsible panel div
export function EditorPanel({ className = '' }: EditorPanelProps) {
  const { editorCollapsed, toggleEditor } = useDeviceUIStore();

  return (
    <>
      {/* Persistent expand tab - OUTSIDE the panel */}
      {editorCollapsed && (
        <button className="editor-expand-tab" onClick={toggleEditor} aria-label="Expand editor">
          <svg className="icon icon-sm" viewBox="0 0 24 24">
            <path d="M15 19l-7-7 7-7" />
          </svg>
          <span className="vertical-text">Editor</span>
        </button>
      )}

      {/* The actual panel */}
      <div className={`editor-panel ${editorCollapsed ? 'collapsed' : ''} ${className}`}>
        {/* ... existing content ... */}
      </div>
    </>
  );
}
```

**Add to RoomPage.css** after line 629:

```css
.editor-expand-tab {
  position: fixed;
  right: 0;
  top: 50%;
  transform: translateY(-50%);
  width: 24px;
  height: 80px;
  background: var(--surface-elevated);
  border: 1px solid var(--border-light);
  border-right: none;
  border-radius: var(--radius-md) 0 0 var(--radius-md);
  cursor: pointer;
  z-index: 20; /* Between tool panel (10) and color dock (50) */
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  box-shadow: var(--shadow-md);
}

.vertical-text {
  writing-mode: vertical-rl;
  font-size: var(--text-xs);
  text-transform: uppercase;
  letter-spacing: 1px;
  color: var(--text-secondary);
}
```

### 1.2 Fix Zoom Controls

**File**: `client/src/pages/components/ZoomControls.tsx`

**Replace entire file contents**:

```tsx
import React from 'react';
import { useViewTransform } from '../../canvas/ViewTransformContext';
import { PERFORMANCE_CONFIG } from '@avlo/shared';

interface ZoomControlsProps {
  className?: string;
}

export function ZoomControls({ className = '' }: ZoomControlsProps) {
  const { viewState, setScale, resetView } = useViewTransform();

  const handleZoomIn = () => {
    const newScale = Math.min(viewState.scale * 1.2, PERFORMANCE_CONFIG.MAX_ZOOM);
    setScale(newScale);
  };

  const handleZoomOut = () => {
    const newScale = Math.max(viewState.scale / 1.2, PERFORMANCE_CONFIG.MIN_ZOOM);
    setScale(newScale);
  };

  const handleZoomReset = () => {
    resetView();
  };

  const zoomPercentage = Math.round(viewState.scale * 100);

  return (
    <div className={`floating-controls ${className}`}>
      <div className="zoom-controls">
        <button
          className="zoom-btn"
          onClick={handleZoomOut}
          disabled={viewState.scale <= PERFORMANCE_CONFIG.MIN_ZOOM}
          aria-label="Zoom out"
          title="Zoom Out"
        >
          <svg className="icon icon-sm" viewBox="0 0 24 24">
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </button>

        <button
          className="zoom-label"
          onClick={handleZoomReset}
          title="Reset zoom to 100%"
          style={{ cursor: 'pointer' }}
          aria-label={`Current zoom: ${zoomPercentage}%. Click to reset.`}
        >
          {zoomPercentage}%
        </button>

        <button
          className="zoom-btn"
          onClick={handleZoomIn}
          disabled={viewState.scale >= PERFORMANCE_CONFIG.MAX_ZOOM}
          aria-label="Zoom in"
          title="Zoom In"
        >
          <svg className="icon icon-sm" viewBox="0 0 24 24">
            <line x1="5" y1="12" x2="19" y2="12" />
            <line x1="12" y1="5" x2="12" y2="19" />
          </svg>
        </button>
      </div>
    </div>
  );
}
```

**Remove zoom from DeviceUIStore**:

```tsx
// In client/src/stores/device-ui-store.ts
// DELETE these lines:
// - Line 21: zoom: number;
// - Line 38: setZoom: (zoom: number) => void;
// - Line 64: zoom: 1.0,
// - Line 95: setZoom: (zoom) => set({ zoom: Math.max(0.25, Math.min(2.0, zoom)) }),
```

**Remove zoom from keyboard shortcuts**:

```tsx
// In client/src/hooks/useKeyboardShortcuts.ts
// DELETE line 17: const { setActiveTool, zoom, setZoom } = useDeviceUIStore();
// CHANGE to: const { setActiveTool } = useDeviceUIStore();
// DELETE zoom +/- shortcut handling (if present)
```

## Phase 2: Clean Up Type Confusion

### 2.1 Remove Legacy Shared Types

**Delete File**: `packages/shared/src/types/device-state.ts` (contains unused duplicate interfaces)

**Update**: `packages/shared/src/index.ts`

```ts
// Remove the line that exports device-state
// DELETE: export * from './types/device-state';
```

````

## Phase 3: Remove Component Redundancy

### 3.1 Eliminate CanvasPane

**Why**: CanvasPane creates a canvas ref that doesn't exist and duplicates resize logic that Canvas/CanvasStage already handle.

**File**: `client/src/pages/RoomPage.tsx`

**Replace lines 96-108** (the CanvasPane usage):
```tsx
// DELETE line 15:
import { CanvasPane } from './components/CanvasPane';

// ADD line 15:
import { Canvas } from '../canvas/Canvas';

// REPLACE lines 96-108 with:
<div className="workspace">
  <div className="canvas-container">
    <div className="canvas-grid" />
    <Canvas roomId={roomId} className="canvas" />

    {/* Floating UI elements */}
    <ToolPanel onToast={showToast} />
    <ColorSizeDock />
    <Minimap />
    <ZoomControls />
  </div>

  <EditorPanel />
</div>
````

**Delete File**: `client/src/pages/components/CanvasPane.tsx`

#

### 5.1 Reorganize Component Structure

**Current Issue**: All components are under `pages/components/` despite only having one page.

```bash
# Create better structure:
mkdir -p client/src/components/ui
mkdir -p client/src/components/workspace
mkdir -p client/src/components/room

# Move components to appropriate locations:
# ui/ - Generic reusable UI components
# workspace/ - Canvas workspace specific components
# room/ - Room page specific components
```

### 5.2 Update Import Paths

After moving files, update imports in `RoomPage.tsx` and other files accordingly.

## Z-Index Hierarchy Documentation

Based on investigation, the current z-index layers are:

| Component         | Z-Index | Location         | Purpose                         |
| ----------------- | ------- | ---------------- | ------------------------------- |
| Canvas Base       | 1       | Canvas.tsx:678   | Base canvas for strokes         |
| Canvas Overlay    | 2       | Canvas.tsx:687   | Preview and presence            |
| Tool Panel        | 10      | RoomPage.css:309 | Floating draggable toolbar      |
| Minimap           | 15      | RoomPage.css:789 | Corner minimap                  |
| Editor Expand Tab | 20      | (new)            | Always accessible expand button |
| Color/Size Dock   | 50      | RoomPage.css:394 | Bottom center dock              |
| Toast             | 200     | RoomPage.css:869 | Notification toasts             |
