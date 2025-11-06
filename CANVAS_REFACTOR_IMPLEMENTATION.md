# Canvas.tsx Refactoring Implementation Guide

## Step-by-Step Extraction Instructions

This document provides detailed, line-by-line instructions for safely extracting CursorManager and ToolFactory from Canvas.tsx.

## Part 1: CursorManager Extraction

### Step 1.1: Create the CursorManager Class
Create new file: `/client/src/canvas/managers/CursorManager.ts`

```typescript
/**
 * CursorManager handles all cursor-related state and logic for the canvas.
 * This includes cursor styles, overrides for special modes (MMB pan),
 * presence cursor tracking, and tool preview suppression.
 */
export interface CursorManagerConfig {
  /** Get the canvas element for cursor style application */
  getCanvasElement: () => HTMLCanvasElement | null;
  /** Get the currently active tool name */
  getActiveTool: () => string;
  /** Update presence cursor in room (Yjs awareness) */
  updatePresenceCursor: (x?: number, y?: number) => void;
}

export class CursorManager {
  private cursorOverride: string | null = null;
  private lastMouseClient: { x: number; y: number } | null = null;
  private suppressToolPreview = false;

  constructor(private config: CursorManagerConfig) {}

  /**
   * Apply the appropriate cursor style to the canvas element
   * Priority: Override > Tool-specific > Default
   */
  applyCursor(): void {
    const canvas = this.config.getCanvasElement();
    if (!canvas) return;

    // Priority 1: Explicit override (e.g., MMB dragging)
    if (this.cursorOverride) {
      canvas.style.cursor = this.cursorOverride;
      return;
    }

    // Priority 2: Tool-based cursor
    const currentTool = this.config.getActiveTool();
    switch (currentTool) {
      case 'eraser':
        canvas.style.cursor = 'none'; // Overlay draws ring
        break;
      case 'pan':
        canvas.style.cursor = 'grab'; // Open hand when idle
        break;
      default:
        canvas.style.cursor = 'crosshair';
    }
  }

  /**
   * Set a cursor override (e.g., 'grabbing' during MMB pan)
   * This takes priority over tool-based cursors
   */
  setCursorOverride(cursor: string | null): void {
    this.cursorOverride = cursor;
    this.applyCursor();
  }

  /**
   * Track the last known mouse position (for tool seeding on keyboard shortcuts)
   */
  trackMousePosition(clientX: number, clientY: number): void {
    this.lastMouseClient = { x: clientX, y: clientY };
  }

  /**
   * Get the last tracked mouse position
   */
  getLastMousePosition(): { x: number; y: number } | null {
    return this.lastMouseClient;
  }

  /**
   * Control tool preview visibility (suppressed during MMB pan)
   */
  setSuppressToolPreview(suppress: boolean): void {
    this.suppressToolPreview = suppress;
  }

  getSuppressToolPreview(): boolean {
    return this.suppressToolPreview;
  }

  /**
   * Update presence cursor position (delegated to room)
   */
  updatePresenceCursor(worldX?: number, worldY?: number): void {
    this.config.updatePresenceCursor(worldX, worldY);
  }

  /**
   * Clear presence cursor (user left canvas)
   */
  clearPresenceCursor(): void {
    this.config.updatePresenceCursor(undefined, undefined);
  }

  /**
   * Reset all overrides (useful for cleanup)
   */
  reset(): void {
    this.cursorOverride = null;
    this.suppressToolPreview = false;
    this.applyCursor();
  }
}
```

### Step 1.2: Update Canvas.tsx Imports
```typescript
// Add to imports section
import { CursorManager } from './managers/CursorManager';
```

### Step 1.3: Replace Refs with CursorManager Instance

**REMOVE these lines (around lines 153-178):**
```typescript
const lastMouseClientRef = useRef<{ x: number; y: number } | null>(null);
const cursorOverrideRef = useRef<string | null>(null);
const suppressToolPreviewRef = useRef(false);
```

**ADD this instead (after line 186):**
```typescript
// Create cursor manager with stable config
const cursorManager = useMemo(() => new CursorManager({
  getCanvasElement: () => baseStageRef.current?.getCanvasElement() ?? null,
  getActiveTool: () => activeToolRef.current,
  updatePresenceCursor: (x, y) => roomDoc.updateCursor(x, y)
}), [roomDoc]);

// Store in ref for access in event handlers
const cursorManagerRef = useRef(cursorManager);
useLayoutEffect(() => {
  cursorManagerRef.current = cursorManager;
}, [cursorManager]);
```

### Step 1.4: Remove Old applyCursor Function

**REMOVE lines 309-331** (the entire applyCursor function)

### Step 1.5: Update Tool Creation Effect

**REPLACE lines 638-639:**
```typescript
// OLD:
applyCursor,
(cursor) => { cursorOverrideRef.current = cursor; }

// NEW:
() => cursorManager.applyCursor(),
(cursor) => cursorManager.setCursorOverride(cursor)
```

**REPLACE lines 649-654:**
```typescript
// OLD:
overlayLoopRef.current.setPreviewProvider({
  getPreview: () => {
    if (suppressToolPreviewRef.current) return null;
    return tool?.getPreview() || null;
  },
});

// NEW:
overlayLoopRef.current.setPreviewProvider({
  getPreview: () => {
    if (cursorManager.getSuppressToolPreview()) return null;
    return tool?.getPreview() || null;
  },
});
```

**REPLACE lines 659-660:**
```typescript
// OLD:
cursorOverrideRef.current = null;
applyCursor();

// NEW:
cursorManager.reset();
```

**REPLACE lines 663-668:**
```typescript
// OLD:
if (!isMobile && activeTool === 'eraser' && lastMouseClientRef.current) {
  const { x, y } = lastMouseClientRef.current;
  const world = screenToWorld(x, y);
  if (world) {
    tool.move(world[0], world[1]);
  }
}

// NEW:
if (!isMobile && activeTool === 'eraser') {
  const mousePos = cursorManager.getLastMousePosition();
  if (mousePos) {
    const world = screenToWorld(mousePos.x, mousePos.y);
    if (world) {
      tool.move(world[0], world[1]);
    }
  }
}
```

**REPLACE lines 701-702:**
```typescript
// OLD:
cursorOverrideRef.current = null;
suppressToolPreviewRef.current = false;

// NEW:
cursorManager.reset();
```

### Step 1.6: Update Event Handlers

**In handlePointerDown (lines 750-753):**
```typescript
// OLD:
cursorOverrideRef.current = 'grabbing';
suppressToolPreviewRef.current = true;
applyCursor();

// NEW:
cursorManager.setCursorOverride('grabbing');
cursorManager.setSuppressToolPreview(true);
```

**In handlePointerMove (line 788):**
```typescript
// OLD:
lastMouseClientRef.current = { x: e.clientX, y: e.clientY };

// NEW:
cursorManager.trackMousePosition(e.clientX, e.clientY);
```

**In handlePointerMove (line 798):**
```typescript
// OLD:
roomDoc.updateCursor(world[0], world[1]);

// NEW:
cursorManager.updatePresenceCursor(world[0], world[1]);
```

**In handlePointerUp (lines 852-854):**
```typescript
// OLD:
cursorOverrideRef.current = null;
suppressToolPreviewRef.current = false;
applyCursor();

// NEW:
cursorManager.reset();
```

**Similar replacements in handlePointerCancel and handleLostPointerCapture**

**In handlePointerLeave (line 921):**
```typescript
// OLD:
roomDoc.updateCursor(undefined, undefined);

// NEW:
cursorManager.clearPresenceCursor();
```

### Step 1.7: Update Dependencies

**UPDATE effect dependencies (line 717):**
```typescript
// OLD:
}, [
  roomDoc,
  userId,
  activeTool,
  pen,
  highlighter,
  eraser,
  text,
  shape,
  stageReady,
  screenToWorld,
  worldToClient,
  applyCursor, // Remove this
]);

// NEW:
}, [
  roomDoc,
  userId,
  activeTool,
  pen,
  highlighter,
  eraser,
  text,
  shape,
  stageReady,
  screenToWorld,
  worldToClient,
  cursorManager, // Add this
]);
```

**UPDATE effect dependencies (line 988):**
```typescript
// OLD:
}, [stageReady, applyCursor, roomDoc, screenToWorld]);

// NEW:
}, [stageReady, cursorManager, roomDoc, screenToWorld]);
```

## Part 2: ToolFactory Extraction

### Step 2.1: Create Common Tool Interface
Create new file: `/client/src/canvas/managers/PointerTool.ts`

```typescript
/**
 * Common interface for all pointer-based tools
 * This allows Canvas.tsx to handle all tools polymorphically
 */
export interface PointerTool {
  /** Check if tool can begin a new gesture */
  canBegin(): boolean;

  /** Start a new gesture with the pointer */
  begin(pointerId: number, worldX: number, worldY: number): void;

  /** Update position during gesture or hover */
  move(worldX: number, worldY: number): void;

  /** Complete the current gesture */
  end(worldX?: number, worldY?: number): void;

  /** Cancel the current gesture */
  cancel(): void;

  /** Check if tool is currently active (mid-gesture) */
  isActive(): boolean;

  /** Get the pointer ID if active */
  getPointerId(): number | null;

  /** Get preview data for overlay rendering */
  getPreview(): any;

  /** Clean up tool resources */
  destroy(): void;

  /** Clear hover state (optional) */
  clearHover?(): void;

  /** Update configuration (optional, for TextTool) */
  updateConfig?(config: any): void;

  /** Handle view changes (optional, for TextTool) */
  onViewChange?(): void;
}
```

### Step 2.2: Create ToolFactory Class
Create new file: `/client/src/canvas/managers/ToolFactory.ts`

```typescript
import { DrawingTool } from '@/lib/tools/DrawingTool';
import { EraserTool } from '@/lib/tools/EraserTool';
import { TextTool } from '@/lib/tools/TextTool';
import { PanTool } from '@/lib/tools/PanTool';
import type { IRoomDocManager } from '@/lib/room-doc-manager';
import type { ViewTransform } from '@avlo/shared';
import type { ToolSettings } from '@/stores/device-ui-store';
import type { PointerTool } from './PointerTool';

/**
 * Configuration required to create tools
 */
export interface ToolFactoryDependencies {
  roomDoc: IRoomDocManager;
  userId: string;
  getViewTransform: () => ViewTransform;
  getCanvasSize: () => { cssWidth: number; cssHeight: number; dpr: number } | null;
  worldToClient: (worldX: number, worldY: number) => [number, number];
  getEditorHost: () => HTMLDivElement | null;
  invalidateOverlay: () => void;
  setPan: (pan: { x: number; y: number }) => void;
  applyCursor: () => void;
  setCursorOverride: (cursor: string | null) => void;
}

/**
 * Tool configuration from Zustand store
 */
export interface ToolConfiguration {
  activeTool: string;
  pen: ToolSettings;
  highlighter: ToolSettings;
  eraser: { size: number };
  text: { size: number; color: string };
  shape?: { variant?: string; settings?: ToolSettings };
}

/**
 * ToolFactory handles creation and lifecycle of canvas tools.
 * It encapsulates tool instantiation logic and dependency injection.
 */
export class ToolFactory {
  private currentTool: PointerTool | null = null;
  private overlayProvider: { getPreview: () => any } | null = null;

  constructor(private deps: ToolFactoryDependencies) {}

  /**
   * Create a new tool based on configuration
   * Automatically destroys the previous tool
   */
  createTool(config: ToolConfiguration): PointerTool | null {
    // Special case: Text tool config update without recreation
    if (config.activeTool === 'text' && this.currentTool?.isActive()) {
      const textTool = this.currentTool as any;
      if ('updateConfig' in textTool) {
        textTool.updateConfig(config.text);
        return this.currentTool; // Return existing tool
      }
    }

    // Cleanup existing tool
    this.destroyCurrentTool();

    let tool: PointerTool | null = null;

    switch (config.activeTool) {
      case 'eraser':
        tool = this.createEraserTool(config.eraser);
        break;

      case 'pen':
        tool = this.createDrawingTool('pen', config.pen);
        break;

      case 'highlighter':
        tool = this.createDrawingTool('highlighter', config.highlighter);
        break;

      case 'shape':
        tool = this.createShapeTool(config.shape, config.pen);
        break;

      case 'text':
        tool = this.createTextTool(config.text);
        break;

      case 'pan':
        tool = this.createPanTool();
        break;

      default:
        console.warn(`Unknown tool: ${config.activeTool}`);
        return null;
    }

    this.currentTool = tool;
    return tool;
  }

  /**
   * Get the currently active tool
   */
  getCurrentTool(): PointerTool | null {
    return this.currentTool;
  }

  /**
   * Create a preview provider for the overlay render loop
   */
  createPreviewProvider(suppressPreview: () => boolean): { getPreview: () => any } {
    return {
      getPreview: () => {
        if (suppressPreview()) return null;
        return this.currentTool?.getPreview() || null;
      }
    };
  }

  /**
   * Seed tool with position (for keyboard shortcuts)
   */
  seedToolPosition(worldX: number, worldY: number): void {
    if (this.currentTool && 'move' in this.currentTool) {
      this.currentTool.move(worldX, worldY);
    }
  }

  /**
   * Notify tool of view changes
   */
  notifyViewChange(): void {
    const tool = this.currentTool as any;
    if (tool && 'onViewChange' in tool) {
      tool.onViewChange();
    }
  }

  /**
   * Clean up current tool
   */
  destroyCurrentTool(): void {
    if (this.currentTool) {
      // Release pointer capture if active
      const pointerId = this.currentTool.getPointerId();
      if (pointerId !== null) {
        // This will be handled by Canvas
      }

      this.currentTool.cancel();
      this.currentTool.destroy();
      this.currentTool = null;
    }
  }

  // Private creation methods
  private createEraserTool(config: { size: number }): EraserTool {
    return new EraserTool(
      this.deps.roomDoc,
      config,
      this.deps.userId,
      this.deps.invalidateOverlay,
      () => this.deps.getCanvasSize() || { cssWidth: 1, cssHeight: 1, dpr: 1 },
      this.deps.getViewTransform
    );
  }

  private createDrawingTool(
    toolType: 'pen' | 'highlighter',
    settings: ToolSettings
  ): DrawingTool {
    return new DrawingTool(
      this.deps.roomDoc,
      settings,
      toolType,
      this.deps.userId,
      (_bounds) => this.deps.invalidateOverlay(),
      this.deps.invalidateOverlay,
      this.deps.getViewTransform
    );
  }

  private createShapeTool(
    shapeConfig?: { variant?: string; settings?: ToolSettings },
    fallbackSettings?: ToolSettings
  ): DrawingTool {
    const variant = shapeConfig?.variant ?? 'rectangle';
    const forceSnapKind =
      variant === 'rectangle' ? 'rect' :
      variant === 'ellipse'   ? 'ellipseRect' :
      variant === 'arrow'     ? 'arrow' : 'line';

    const settings = shapeConfig?.settings ?? fallbackSettings ?? {
      color: '#000000',
      size: 2,
      opacity: 1
    };

    return new DrawingTool(
      this.deps.roomDoc,
      settings,
      'pen', // Shape tool uses pen mechanics
      this.deps.userId,
      (_bounds) => this.deps.invalidateOverlay(),
      this.deps.invalidateOverlay,
      this.deps.getViewTransform,
      { forceSnapKind }
    );
  }

  private createTextTool(config: { size: number; color: string }): TextTool {
    return new TextTool(
      this.deps.roomDoc,
      config,
      this.deps.userId,
      {
        worldToClient: this.deps.worldToClient,
        getView: this.deps.getViewTransform,
        getEditorHost: this.deps.getEditorHost,
      },
      this.deps.invalidateOverlay
    );
  }

  private createPanTool(): PanTool {
    return new PanTool(
      this.deps.getViewTransform,
      this.deps.setPan,
      this.deps.invalidateOverlay,
      this.deps.applyCursor,
      this.deps.setCursorOverride
    );
  }
}
```

### Step 2.3: Update Canvas.tsx to Use ToolFactory

**Add to imports:**
```typescript
import { ToolFactory } from './managers/ToolFactory';
```

**Add after CursorManager creation (around line 195):**
```typescript
// Create tool factory with all dependencies
const toolFactory = useMemo(() => new ToolFactory({
  roomDoc,
  userId,
  getViewTransform: () => viewTransformRef.current,
  getCanvasSize: () => canvasSizeRef.current,
  worldToClient,
  getEditorHost: () => editorHostRef.current,
  invalidateOverlay: () => overlayLoopRef.current?.invalidateAll(),
  setPan: (pan) => setPanRef.current?.(pan),
  applyCursor: () => cursorManager.applyCursor(),
  setCursorOverride: (cursor) => cursorManager.setCursorOverride(cursor),
}), [roomDoc, userId, worldToClient, cursorManager]);

// Store in ref for event handlers
const toolFactoryRef = useRef(toolFactory);
useLayoutEffect(() => {
  toolFactoryRef.current = toolFactory;
}, [toolFactory]);
```

**REPLACE the entire tool creation effect (lines 518-718):**
```typescript
// Tool lifecycle management
useEffect(() => {
  // Wait for dependencies
  const renderLoop = renderLoopRef.current;
  const canvas = baseStageRef.current?.getCanvasElement();
  const initialTransform = viewTransformRef.current;

  if (!renderLoop || !canvas || !roomDoc || !initialTransform) {
    if (import.meta.env.DEV) {
      console.debug('Tool waiting for dependencies');
    }
    return;
  }

  // Mobile detection
  const isMobile =
    /Android|webOS|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
    navigator.maxTouchPoints > 1;

  // Create tool through factory
  const tool = toolFactory.createTool({
    activeTool,
    pen,
    highlighter,
    eraser,
    text,
    shape,
  });

  if (!tool) return;

  // Set up preview provider for overlay
  if (!isMobile && overlayLoopRef.current) {
    const provider = toolFactory.createPreviewProvider(
      () => cursorManager.getSuppressToolPreview()
    );
    overlayLoopRef.current.setPreviewProvider(provider);
  }

  // Update cursor
  cursorManager.reset();

  // Seed eraser preview for keyboard shortcuts
  if (!isMobile && activeTool === 'eraser') {
    const mousePos = cursorManager.getLastMousePosition();
    if (mousePos) {
      const world = screenToWorld(mousePos.x, mousePos.y);
      if (world) {
        toolFactory.seedToolPosition(world[0], world[1]);
      }
    }
  }

  // Canvas styles
  if (!isMobile) {
    canvas.style.touchAction = 'none';
  }

  // Cleanup
  return () => {
    const tool = toolFactory.getCurrentTool();
    if (tool) {
      const pointerId = tool.getPointerId();
      if (pointerId !== null) {
        try {
          canvas.releasePointerCapture(pointerId);
        } catch {
          // Already released
        }
      }
    }

    toolFactory.destroyCurrentTool();
    overlayLoopRef.current?.setPreviewProvider(null);
    cursorManager.reset();
  };
}, [
  roomDoc,
  userId,
  activeTool,
  pen,
  highlighter,
  eraser,
  text,
  shape,
  stageReady,
  screenToWorld,
  toolFactory,
  cursorManager,
]);
```

**Update event handlers to use toolFactory:**

In all event handlers, replace `toolRef.current` with `toolFactoryRef.current.getCurrentTool()`:

```typescript
// Example in handlePointerDown:
const tool = toolFactoryRef.current.getCurrentTool();
if (!tool?.canBegin()) return;

// Example in handlePointerMove:
const tool = toolFactoryRef.current.getCurrentTool();
if (tool && activeToolRef.current === 'pan' && 'updatePan' in tool) {
  // ... pan logic
}
```

**Update view change effect (line 999):**
```typescript
// OLD:
if (toolRef.current && 'onViewChange' in toolRef.current) {
  (toolRef.current as any).onViewChange();
}

// NEW:
toolFactory.notifyViewChange();
```

## Part 3: Final Cleanup

### Step 3.1: Remove Old Type Definition
**REMOVE line 25:**
```typescript
type PointerTool = DrawingTool | EraserTool | TextTool | PanTool;
```

### Step 3.2: Remove toolRef
**REMOVE line 152:**
```typescript
const toolRef = useRef<PointerTool>();
```

### Step 3.3: Add Navigation Comments
Add these comments at the top of Canvas.tsx after imports:

```typescript
/**
 * Canvas.tsx - Main canvas component orchestrating rendering and interaction
 *
 * Responsibilities:
 * - Canvas lifecycle management (mount/unmount)
 * - Event handling (pointer, wheel)
 * - Render loop coordination
 * - Snapshot subscription and diffing
 * - View transform management
 *
 * Delegated to managers:
 * - Cursor management → CursorManager
 * - Tool lifecycle → ToolFactory
 *
 * @see ./managers/CursorManager.ts - Cursor state and styling
 * @see ./managers/ToolFactory.ts - Tool creation and lifecycle
 */
```

## Testing Checklist

### CursorManager Tests
- [ ] Cursor changes correctly when switching tools
- [ ] MMB pan shows 'grabbing' cursor
- [ ] Eraser tool hides cursor (shows overlay ring)
- [ ] Pan tool shows 'grab' cursor
- [ ] Cursor override works during MMB
- [ ] Tool preview suppression during MMB
- [ ] Last mouse position tracking for shortcuts
- [ ] Presence cursor updates work

### ToolFactory Tests
- [ ] All tools create successfully
- [ ] Tool switching cleans up previous tool
- [ ] Text tool config updates without recreation
- [ ] Shape tool variants work correctly
- [ ] Preview providers set up correctly
- [ ] Tool seeding works for keyboard shortcuts
- [ ] View change notifications propagate
- [ ] Tool destruction releases resources

### Integration Tests
- [ ] Drawing works with all tools
- [ ] Eraser removes strokes correctly
- [ ] Text tool creates text blocks
- [ ] Pan tool moves viewport
- [ ] Shape tool creates shapes
- [ ] MMB pan works alongside tools
- [ ] Keyboard shortcuts work
- [ ] Mobile detection prevents editing
- [ ] Memory leaks checked
- [ ] Performance unchanged

## Common Issues and Solutions

### Issue 1: Stale Closures
**Symptom:** Tool or cursor using old values
**Solution:** Ensure refs are updated in useLayoutEffect

### Issue 2: Event Handler Not Working
**Symptom:** Clicks/moves not registering
**Solution:** Check that event handlers use the Ref versions of managers

### Issue 3: Cursor Not Updating
**Symptom:** Cursor stuck on wrong style
**Solution:** Verify applyCursor is called after state changes

### Issue 4: Tool Not Creating
**Symptom:** Tool is null after creation
**Solution:** Check all dependencies are passed to factory

### Issue 5: Preview Not Showing
**Symptom:** No preview on overlay
**Solution:** Verify preview provider is set and not suppressed

## Rollback Instructions

If issues arise, rollback is straightforward:

1. **Git revert the commit**
2. **Or manually:**
   - Delete `/client/src/canvas/managers/` folder
   - Restore Canvas.tsx from version control
   - Remove new imports
   - Restore old refs and functions

## Summary

This implementation guide provides exact, line-by-line instructions for extracting CursorManager and ToolFactory from Canvas.tsx. Follow each step carefully, test thoroughly after each phase, and maintain the ability to rollback if needed.

The refactoring maintains all existing functionality while improving code organization and testability. The key is preserving the exact same behavior while moving the implementation to dedicated managers.