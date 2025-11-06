# Canvas.tsx Refactoring Plan

## Executive Summary
Canvas.tsx has grown to 1064 lines and handles multiple responsibilities. This document provides a detailed, safe refactoring plan to extract cursor management and tool lifecycle logic while preserving all critical functionality.

## Current State Analysis

### File Metrics
- **Lines:** 1064
- **Primary Responsibilities:** 8 major areas
- **Dependencies:** 22 imports
- **Refs Used:** 17 different refs
- **Effects:** 7 useEffect/useLayoutEffect hooks
- **Event Handlers:** 7 pointer/wheel handlers

### Responsibility Breakdown

#### 1. **KEEP IN CANVAS** - Core Lifecycle & Event Management
- Component mounting/unmounting
- Canvas stage references (baseStageRef, overlayStageRef)
- Event listener attachment/cleanup
- Render loop initialization
- Snapshot subscription and diffing
- Cache invalidation logic

#### 2. **EXTRACTABLE** - Cursor Management (~150 lines)
- Cursor style logic (applyCursor function)
- Cursor override management (MMB pan cursor)
- Tool-based cursor determination
- Last mouse position tracking
- Presence cursor updates

#### 3. **EXTRACTABLE** - Tool Factory (~200 lines)
- Tool instantiation based on activeTool
- Tool configuration gathering
- Preview provider setup
- Tool lifecycle management
- Tool-specific initialization

#### 4. **KEEP IN CANVAS** - Critical Integration Points
- View transform management
- Coordinate transformations
- Pointer event handling
- MMB pan logic
- Wheel zoom handling

## Extraction Plan: Phase 1 - CursorManager

### Overview
Extract cursor management into a dedicated class that encapsulates all cursor-related state and logic.

### New File: `/client/src/canvas/managers/CursorManager.ts`
```typescript
export interface CursorManagerConfig {
  getCanvasElement: () => HTMLCanvasElement | null;
  getActiveTool: () => string;
  updatePresenceCursor: (x?: number, y?: number) => void;
}

export class CursorManager {
  private cursorOverride: string | null = null;
  private lastMouseClient: { x: number; y: number } | null = null;
  private suppressToolPreview = false;

  constructor(private config: CursorManagerConfig) {}

  // Core cursor methods
  applyCursor(): void {
    const canvas = this.config.getCanvasElement();
    if (!canvas) return;

    // Priority 1: Explicit override (MMB dragging)
    if (this.cursorOverride) {
      canvas.style.cursor = this.cursorOverride;
      return;
    }

    // Priority 2: Tool-based default
    const currentTool = this.config.getActiveTool();
    switch (currentTool) {
      case 'eraser':
        canvas.style.cursor = 'none';
        break;
      case 'pan':
        canvas.style.cursor = 'grab';
        break;
      default:
        canvas.style.cursor = 'crosshair';
    }
  }

  setCursorOverride(cursor: string | null): void {
    this.cursorOverride = cursor;
    this.applyCursor();
  }

  trackMousePosition(clientX: number, clientY: number): void {
    this.lastMouseClient = { x: clientX, y: clientY };
  }

  getLastMousePosition(): { x: number; y: number } | null {
    return this.lastMouseClient;
  }

  setSuppressToolPreview(suppress: boolean): void {
    this.suppressToolPreview = suppress;
  }

  getSuppressToolPreview(): boolean {
    return this.suppressToolPreview;
  }

  updatePresenceCursor(worldX?: number, worldY?: number): void {
    this.config.updatePresenceCursor(worldX, worldY);
  }

  clearPresenceCursor(): void {
    this.config.updatePresenceCursor(undefined, undefined);
  }
}
```

### Integration Changes in Canvas.tsx
```typescript
// Replace refs with CursorManager
const cursorManager = useMemo(() => new CursorManager({
  getCanvasElement: () => baseStageRef.current?.getCanvasElement() ?? null,
  getActiveTool: () => activeToolRef.current,
  updatePresenceCursor: (x, y) => roomDoc.updateCursor(x, y)
}), [roomDoc]);

// Update event handlers to use cursorManager
const handlePointerMove = (e: PointerEvent) => {
  cursorManager.trackMousePosition(e.clientX, e.clientY);
  // ... rest of handler
};

// Update MMB pan to use cursorManager
cursorManager.setCursorOverride('grabbing');
cursorManager.setSuppressToolPreview(true);
```

## Extraction Plan: Phase 2 - ToolFactory

### Overview
Extract tool creation and lifecycle management into a factory pattern that handles tool instantiation and configuration.

### New File: `/client/src/canvas/managers/ToolFactory.ts`
```typescript
import { DrawingTool } from '@/lib/tools/DrawingTool';
import { EraserTool } from '@/lib/tools/EraserTool';
import { TextTool } from '@/lib/tools/TextTool';
import { PanTool } from '@/lib/tools/PanTool';
import type { IRoomDocManager } from '@/lib/room-doc-manager';
import type { ViewTransform } from '@avlo/shared';
import type { ToolSettings, ShapeSettings } from '@/stores/device-ui-store';

export type PointerTool = DrawingTool | EraserTool | TextTool | PanTool;

export interface ToolFactoryConfig {
  roomDoc: IRoomDocManager;
  userId: string;
  getViewTransform: () => ViewTransform;
  getCanvasSize: () => { cssWidth: number; cssHeight: number; dpr: number } | null;
  worldToClient: (worldX: number, worldY: number) => [number, number];
  getEditorHost: () => HTMLDivElement | null;
  invalidateOverlay: () => void;
  applyCursor: () => void;
  setCursorOverride: (cursor: string | null) => void;
}

export interface ToolConfig {
  activeTool: string;
  pen: ToolSettings;
  highlighter: ToolSettings;
  eraser: { size: number };
  text: { size: number; color: string };
  shape: { variant: string; settings: ToolSettings };
}

export class ToolFactory {
  private currentTool: PointerTool | null = null;

  constructor(private config: ToolFactoryConfig) {}

  createTool(toolConfig: ToolConfig): PointerTool | null {
    // Cleanup existing tool
    this.destroyCurrentTool();

    const { activeTool } = toolConfig;
    let tool: PointerTool | null = null;

    switch (activeTool) {
      case 'eraser':
        tool = this.createEraserTool(toolConfig.eraser);
        break;

      case 'pen':
      case 'highlighter':
        tool = this.createDrawingTool(
          activeTool,
          activeTool === 'pen' ? toolConfig.pen : toolConfig.highlighter
        );
        break;

      case 'shape':
        tool = this.createShapeTool(toolConfig.shape, toolConfig.pen);
        break;

      case 'text':
        tool = this.createTextTool(toolConfig.text);
        break;

      case 'pan':
        tool = this.createPanTool();
        break;
    }

    this.currentTool = tool;
    return tool;
  }

  private createEraserTool(eraserConfig: { size: number }): EraserTool {
    return new EraserTool(
      this.config.roomDoc,
      eraserConfig,
      this.config.userId,
      this.config.invalidateOverlay,
      () => this.config.getCanvasSize() || { cssWidth: 1, cssHeight: 1, dpr: 1 },
      this.config.getViewTransform
    );
  }

  private createDrawingTool(
    toolType: 'pen' | 'highlighter',
    settings: ToolSettings
  ): DrawingTool {
    return new DrawingTool(
      this.config.roomDoc,
      settings,
      toolType,
      this.config.userId,
      (_bounds) => this.config.invalidateOverlay(),
      this.config.invalidateOverlay,
      this.config.getViewTransform
    );
  }

  private createShapeTool(
    shapeConfig: { variant: string; settings: ToolSettings },
    fallbackSettings: ToolSettings
  ): DrawingTool {
    const variant = shapeConfig.variant ?? 'rectangle';
    const forceSnapKind =
      variant === 'rectangle' ? 'rect' :
      variant === 'ellipse'   ? 'ellipseRect' :
      variant === 'arrow'     ? 'arrow' : 'line';

    const settings = shapeConfig.settings ?? fallbackSettings;

    return new DrawingTool(
      this.config.roomDoc,
      settings,
      'pen',
      this.config.userId,
      (_bounds) => this.config.invalidateOverlay(),
      this.config.invalidateOverlay,
      this.config.getViewTransform,
      { forceSnapKind }
    );
  }

  private createTextTool(textConfig: { size: number; color: string }): TextTool {
    return new TextTool(
      this.config.roomDoc,
      textConfig,
      this.config.userId,
      {
        worldToClient: this.config.worldToClient,
        getView: this.config.getViewTransform,
        getEditorHost: this.config.getEditorHost,
      },
      this.config.invalidateOverlay
    );
  }

  private createPanTool(): PanTool {
    return new PanTool(
      this.config.getViewTransform,
      (pan) => {
        // This will need to be passed in config
        // setPanRef.current?.(pan)
      },
      this.config.invalidateOverlay,
      this.config.applyCursor,
      this.config.setCursorOverride
    );
  }

  getCurrentTool(): PointerTool | null {
    return this.currentTool;
  }

  destroyCurrentTool(): void {
    if (this.currentTool) {
      this.currentTool.cancel();
      this.currentTool.destroy();
      this.currentTool = null;
    }
  }

  seedToolPreview(screenToWorld: (x: number, y: number) => [number, number] | null, mousePos: { x: number; y: number }): void {
    if (!this.currentTool || !mousePos) return;

    const world = screenToWorld(mousePos.x, mousePos.y);
    if (world && 'move' in this.currentTool) {
      this.currentTool.move(world[0], world[1]);
    }
  }
}
```

### Integration Changes in Canvas.tsx
```typescript
// Create tool factory
const toolFactory = useMemo(() => new ToolFactory({
  roomDoc,
  userId,
  getViewTransform: () => viewTransformRef.current,
  getCanvasSize: () => canvasSizeRef.current,
  worldToClient,
  getEditorHost: () => editorHostRef.current,
  invalidateOverlay: () => overlayLoopRef.current?.invalidateAll(),
  applyCursor: () => cursorManager.applyCursor(),
  setCursorOverride: (cursor) => cursorManager.setCursorOverride(cursor),
}), [roomDoc, userId, worldToClient, cursorManager]);

// Replace tool creation logic
useEffect(() => {
  // Special handling for text tool config changes
  const currentTool = toolFactory.getCurrentTool();
  if (activeTool === 'text' && currentTool?.isActive()) {
    const textTool = currentTool as any;
    if ('updateConfig' in textTool) {
      textTool.updateConfig(text);
      return;
    }
  }

  // Create new tool
  const tool = toolFactory.createTool({
    activeTool,
    pen,
    highlighter,
    eraser,
    text,
    shape,
  });

  if (!tool) return;

  // Set preview provider
  if (!isMobile && overlayLoopRef.current) {
    overlayLoopRef.current.setPreviewProvider({
      getPreview: () => {
        if (cursorManager.getSuppressToolPreview()) return null;
        return tool?.getPreview() || null;
      },
    });
  }

  // Update cursor
  cursorManager.applyCursor();

  // Seed tool preview for keyboard shortcuts
  if (!isMobile && activeTool === 'eraser') {
    const mousePos = cursorManager.getLastMousePosition();
    if (mousePos) {
      toolFactory.seedToolPreview(screenToWorld, mousePos);
    }
  }

  return () => {
    toolFactory.destroyCurrentTool();
    overlayLoopRef.current?.setPreviewProvider(null);
  };
}, [/* dependencies */]);
```

## Implementation Strategy

### Phase 1: CursorManager (Low Risk)
1. **Create CursorManager class** with all cursor logic
2. **Add unit tests** for CursorManager
3. **Integrate into Canvas.tsx** replacing refs one by one
4. **Test all cursor transitions** (tool changes, MMB pan, etc.)
5. **Verify presence cursor updates** still work

### Phase 2: ToolFactory (Medium Risk)
1. **Create ToolFactory class** with tool creation logic
2. **Add comprehensive tests** for each tool type
3. **Gradually migrate tool creation** from Canvas.tsx
4. **Test tool switching** extensively
5. **Verify preview providers** work correctly
6. **Test tool seeding** for keyboard shortcuts

### Phase 3: Documentation & Cleanup
1. **Add JSDoc comments** to all public methods
2. **Create navigation comments** in Canvas.tsx
3. **Update CLAUDE.md** with new architecture
4. **Remove obsolete comments**
5. **Optimize imports**

## Benefits

### Immediate Benefits
- **Reduced file size:** Canvas.tsx from 1064 → ~700 lines
- **Better testability:** Isolated units with clear interfaces
- **Improved navigation:** Logical separation of concerns
- **Easier debugging:** Clear boundaries between systems

### Future Benefits
- **Easier tool additions:** Just add to ToolFactory
- **Cursor customization:** Centralized cursor logic
- **Performance optimization:** Can optimize managers independently
- **Code reuse:** Managers can be used in other contexts

## Risk Mitigation

### Testing Strategy
1. **Unit tests first:** Test managers in isolation
2. **Integration tests:** Test with mock Canvas environment
3. **E2E tests:** Full user flows with all tools
4. **Performance tests:** Ensure no regression in frame rate
5. **Memory tests:** Check for leaks in tool lifecycle

### Rollback Plan
1. Keep original code in version control
2. Implement behind feature flag if needed
3. A/B test with subset of users
4. Monitor error rates and performance metrics
5. Have quick rollback procedure ready

## Migration Checklist

### Pre-Migration
- [ ] Create comprehensive test suite for current behavior
- [ ] Document current cursor states and transitions
- [ ] Document tool lifecycle and state machines
- [ ] Measure current performance baseline
- [ ] Create feature branch `refactor/canvas-managers`

### CursorManager Migration
- [ ] Create CursorManager class
- [ ] Write unit tests for CursorManager
- [ ] Replace cursorOverrideRef with CursorManager
- [ ] Replace lastMouseClientRef with CursorManager
- [ ] Replace suppressToolPreviewRef with CursorManager
- [ ] Update all event handlers
- [ ] Test all cursor transitions
- [ ] Test presence updates

### ToolFactory Migration
- [ ] Create ToolFactory class
- [ ] Write unit tests for ToolFactory
- [ ] Migrate DrawingTool creation
- [ ] Migrate EraserTool creation
- [ ] Migrate TextTool creation
- [ ] Migrate PanTool creation
- [ ] Migrate shape tool creation
- [ ] Test tool switching
- [ ] Test preview providers
- [ ] Test tool seeding

### Post-Migration
- [ ] Run full test suite
- [ ] Performance profiling
- [ ] Memory leak detection
- [ ] Update documentation
- [ ] Code review
- [ ] Staged rollout
- [ ] Monitor metrics

## File Structure After Refactor

```
/client/src/canvas/
├── Canvas.tsx                    (~700 lines)
├── CanvasStage.tsx               (unchanged)
├── ViewTransformContext.tsx      (unchanged)
├── managers/
│   ├── CursorManager.ts          (~150 lines)
│   ├── ToolFactory.ts            (~250 lines)
│   └── __tests__/
│       ├── CursorManager.test.ts
│       └── ToolFactory.test.ts
├── internal/
│   └── transforms.ts             (unchanged)
└── animation/
    └── ZoomAnimator.ts           (unchanged)
```

## Success Metrics

### Quantitative
- File size reduction: 35%
- Test coverage: >90%
- No performance regression (60 FPS maintained)
- Zero memory leaks
- Build time unchanged

### Qualitative
- Easier to navigate and understand
- Clear separation of concerns
- Better developer experience
- Easier to add new tools
- Reduced cognitive load

## Notes and Warnings

### Critical Dependencies
1. **View Transform Refs:** Must remain in Canvas.tsx for stability
2. **Event Handlers:** Keep in Canvas.tsx to maintain event flow
3. **Render Loops:** Tightly coupled to Canvas lifecycle
4. **Snapshot Diffing:** Core to rendering, keep in Canvas.tsx

### Gotchas to Avoid
1. **Stale Closures:** Use refs for values that change frequently
2. **Event Handler Teardown:** Ensure proper cleanup
3. **Tool State:** Must be properly reset on tool switch
4. **Preview Suppression:** Critical for MMB pan behavior
5. **Mobile Detection:** Must remain consistent across refactor

## Timeline Estimate

### Conservative Estimate
- **CursorManager:** 2-3 days (including tests)
- **ToolFactory:** 3-4 days (including tests)
- **Integration & Testing:** 2-3 days
- **Documentation:** 1 day
- **Total:** 8-11 days

### Optimistic Estimate
- **CursorManager:** 1 day
- **ToolFactory:** 2 days
- **Integration & Testing:** 1 day
- **Documentation:** 0.5 days
- **Total:** 4.5 days

## Conclusion

This refactoring plan provides a safe, incremental approach to reducing Canvas.tsx complexity while preserving all critical functionality. The extraction of CursorManager and ToolFactory will significantly improve code organization without risking core canvas behavior.

The key to success is maintaining the existing event flow and lifecycle management in Canvas.tsx while extracting the business logic into dedicated managers. This approach minimizes risk while maximizing benefits.