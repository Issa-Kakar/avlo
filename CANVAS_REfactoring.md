# Canvas.tsx Refactoring Audit

**Date**: 2025-10-30
**Current Size**: 1,063 lines
**Target Size**: 500-650 lines (40-50% reduction)
**Risk Level**: Managed incremental approach

---

## Executive Summary

Canvas.tsx is the central orchestrator for the whiteboard rendering system. It manages:
- Two canvas stages (base + overlay) with separate render loops
- Tool lifecycle (pen/highlighter/eraser/text/pan/shape)
- Pointer event handling with MMB pan support
- Coordinate transforms and viewport management
- Snapshot diffing and cache invalidation

**Core Problem**: Too many concerns in one file, making it harder to maintain and understand.

**Solution**: Extract pure functions and self-contained logic into separate modules while keeping the orchestration in Canvas.tsx.

---

## Current Architecture Analysis

### File Structure Breakdown

| Section | Lines | Complexity | Extraction Difficulty |
|---------|-------|------------|----------------------|
| Helper functions (bbox, diff) | 97 | Medium | ✅ **EASY** |
| State/refs setup | 48 | Low | ⚠️ Keep in Canvas |
| Snapshot subscription | 50 | Medium | ⚠️ Keep in Canvas |
| Base render loop init | 91 | High | 🔶 **MEDIUM** |
| Overlay render loop init | 49 | Medium | 🔶 **MEDIUM** |
| Tool lifecycle effect | 200 | **Very High** | 🔶 **MEDIUM** |
| Event listeners effect | 267 | **Very High** | 🔴 **HARD** |
| Other effects | ~60 | Low-Medium | ✅ **EASY** |
| Imperative handle | 21 | Low | ⚠️ Keep in Canvas |
| JSX render | 31 | Low | ⚠️ Keep in Canvas |

### Critical Dependencies to Preserve

**DO NOT BREAK**:
1. **Initialization Order**: IDB → WS → Render Loops → Tools → Events
2. **Ref-based State**: Prevents 60 FPS React re-renders (performance critical)
3. **Closure Dependencies**: Event handlers need access to refs for stability
4. **Effect Dependency Arrays**: Carefully tuned to prevent re-runs during gestures
5. **MMB Pan State**: Shared across multiple handlers

---

## Refactoring Strategy: 4-Phase Approach

### Phase 1: Low-Hanging Fruit ✅ (Low Risk, High Impact)

**Goal**: Extract pure functions and simple utilities
**Effort**: 2-3 hours
**Risk**: Very Low
**Lines Saved**: ~150

#### 1.1 Extract Snapshot Diffing Logic

**Current**: Lines 28-124 in Canvas.tsx
**Target**: `client/src/canvas/internal/snapshot-diff.ts`

```typescript
// New file: canvas/internal/snapshot-diff.ts
import type { Snapshot } from '@avlo/shared';

export interface WorldBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface DiffResult {
  dirty: WorldBounds[];
  evictIds: string[];
}

// Extract bboxEquals helper
export function bboxEquals(a: number[], b: number[]): boolean {
  const eps = 1e-3;
  return (
    Math.abs(a[0] - b[0]) < eps &&
    Math.abs(a[1] - b[1]) < eps &&
    Math.abs(a[2] - b[2]) < eps &&
    Math.abs(a[3] - b[3]) < eps
  );
}

// Extract stylesEqual helper
export function stylesEqual(
  a: { color: string; size: number; opacity: number },
  b: { color: string; size: number; opacity: number },
): boolean {
  return a.color === b.color && a.size === b.size && a.opacity === b.opacity;
}

// Extract bboxToBounds helper
export function bboxToBounds(b: [number, number, number, number]): WorldBounds {
  return { minX: b[0], minY: b[1], maxX: b[2], maxY: b[3] };
}

// Main diffing function (pure, testable)
export function diffBoundsAndEvicts(prev: Snapshot, next: Snapshot): DiffResult {
  // ... existing implementation (60 lines)
}
```

**Benefits**:
- Testable in isolation
- Clear input/output contract
- No side effects
- Can be used by other components

**Usage in Canvas.tsx**:
```typescript
import { diffBoundsAndEvicts } from './internal/snapshot-diff';

// In snapshot subscription effect:
const { dirty, evictIds } = diffBoundsAndEvicts(prevSnapshot, newSnapshot);
```

---

#### 1.2 Extract Device Detection

**Current**: Inline checks scattered throughout Canvas.tsx
**Target**: `client/src/canvas/internal/device-detection.ts`

```typescript
// New file: canvas/internal/device-detection.ts

/**
 * Detect if the current device is mobile/touch-capable
 * Uses both user agent and touch points for iPadOS detection
 */
export function isMobileDevice(): boolean {
  return (
    /Android|webOS|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
    navigator.maxTouchPoints > 1
  );
}

/**
 * Check if reduced motion is preferred
 */
export function prefersReducedMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}

/**
 * Detect if viewport is mobile-sized
 */
export function isMobileViewport(): boolean {
  return window.matchMedia?.('(max-width: 768px)').matches ?? false;
}

/**
 * Comprehensive mobile check (used for FPS throttling)
 */
export function shouldThrottleFPS(): boolean {
  return (
    isMobileDevice() ||
    isMobileViewport() ||
    prefersReducedMotion()
  );
}
```

**Replace 4 inline checks** with single import:
```typescript
import { isMobileDevice, shouldThrottleFPS } from './internal/device-detection';
```

---

#### 1.3 Create Coordinate Transform Hook

**Current**: Lines 272-305 (screenToWorld, worldToClient)
**Target**: `client/src/canvas/hooks/useCoordinateTransform.ts`

```typescript
// New file: canvas/hooks/useCoordinateTransform.ts
import { useCallback, useRef, type RefObject } from 'react';
import type { ViewTransform } from '@avlo/shared';
import type { CanvasStageHandle } from '../CanvasStage';

export interface CoordinateTransform {
  screenToWorld: (clientX: number, clientY: number) => [number, number] | null;
  worldToClient: (worldX: number, worldY: number) => [number, number];
}

export function useCoordinateTransform(
  stageRef: RefObject<CanvasStageHandle>,
  viewTransformRef: React.MutableRefObject<ViewTransform>,
): CoordinateTransform {

  const screenToWorld = useCallback((clientX: number, clientY: number): [number, number] | null => {
    const canvas = stageRef.current?.getCanvasElement();
    const transform = viewTransformRef.current;
    if (!canvas || !transform) {
      console.warn('Cannot convert coordinates: canvas or transform not ready');
      return null;
    }

    const rect = canvas.getBoundingClientRect();
    const canvasX = clientX - rect.left;
    const canvasY = clientY - rect.top;
    return transform.canvasToWorld(canvasX, canvasY);
  }, []); // Stable - reads from refs

  const worldToClient = useCallback((worldX: number, worldY: number): [number, number] => {
    const stage = stageRef.current;
    const vt = viewTransformRef.current;
    if (!stage || !vt) return [worldX, worldY];

    const [canvasX, canvasY] = vt.worldToCanvas(worldX, worldY);
    const rect = stage.getBounds();
    return [canvasX + rect.left, canvasY + rect.top];
  }, []); // Stable - reads from refs

  return { screenToWorld, worldToClient };
}
```

**Usage in Canvas.tsx**:
```typescript
const { screenToWorld, worldToClient } = useCoordinateTransform(
  baseStageRef,
  viewTransformRef
);
```

**Benefits**:
- Encapsulates coordinate transform logic
- Testable hook
- Clear interface
- Can add more transform utilities later

---

#### 1.4 Extract Cursor Management

**Current**: Lines 309-331 (applyCursor + cursorOverrideRef)
**Target**: `client/src/canvas/hooks/useCursorManager.ts`

```typescript
// New file: canvas/hooks/useCursorManager.ts
import { useCallback, useRef, type RefObject } from 'react';
import type { CanvasStageHandle } from '../CanvasStage';
import type { Tool } from '@/stores/device-ui-store';

export interface CursorManager {
  applyCursor: () => void;
  setOverride: (cursor: string | null) => void;
  clearOverride: () => void;
}

export function useCursorManager(
  stageRef: RefObject<CanvasStageHandle>,
  activeToolRef: React.MutableRefObject<Tool>,
): CursorManager {
  const overrideRef = useRef<string | null>(null);

  const applyCursor = useCallback(() => {
    const canvas = stageRef.current?.getCanvasElement();
    if (!canvas) return;

    // Priority 1: Explicit override (e.g., MMB dragging)
    if (overrideRef.current) {
      canvas.style.cursor = overrideRef.current;
      return;
    }

    // Priority 2: Tool-based default
    const currentTool = activeToolRef.current;
    switch (currentTool) {
      case 'eraser':
        canvas.style.cursor = 'none'; // Overlay draws ring
        break;
      case 'pan':
        canvas.style.cursor = 'grab'; // Open hand idle
        break;
      default:
        canvas.style.cursor = 'crosshair';
    }
  }, []); // Stable - reads from refs

  const setOverride = useCallback((cursor: string | null) => {
    overrideRef.current = cursor;
    applyCursor();
  }, [applyCursor]);

  const clearOverride = useCallback(() => {
    overrideRef.current = null;
    applyCursor();
  }, [applyCursor]);

  return { applyCursor, setOverride, clearOverride };
}
```

**Usage in Canvas.tsx**:
```typescript
const cursorManager = useCursorManager(baseStageRef, activeToolRef);

// Replace cursorOverrideRef.current = 'grabbing' with:
cursorManager.setOverride('grabbing');

// Replace applyCursor() calls with:
cursorManager.applyCursor();
```

---

#### 1.5 Extract Resize Handlers

**Current**: Lines 334-347 (handleBaseResize, handleOverlayResize)
**Target**: `client/src/canvas/internal/resize-handlers.ts`

```typescript
// New file: canvas/internal/resize-handlers.ts
import type { ResizeInfo } from '../CanvasStage';
import type { RenderLoop } from '@/renderer/RenderLoop';
import type { OverlayRenderLoop } from '@/renderer/OverlayRenderLoop';

export function createBaseResizeHandler(
  setCanvasSize: (info: ResizeInfo) => void,
  canvasSizeRef: React.MutableRefObject<ResizeInfo | null>,
  renderLoopRef: React.MutableRefObject<RenderLoop | null>,
) {
  return (info: ResizeInfo) => {
    setCanvasSize(info);
    canvasSizeRef.current = info;
    renderLoopRef.current?.setResizeInfo({
      width: info.pixelWidth,
      height: info.pixelHeight,
      dpr: info.dpr,
    });
  };
}

export function createOverlayResizeHandler(
  overlayLoopRef: React.MutableRefObject<OverlayRenderLoop | null>,
) {
  return (_info: ResizeInfo) => {
    overlayLoopRef.current?.invalidateAll();
  };
}
```

**Usage in Canvas.tsx**:
```typescript
import { createBaseResizeHandler, createOverlayResizeHandler } from './internal/resize-handlers';

const handleBaseResize = useMemo(
  () => createBaseResizeHandler(setCanvasSize, canvasSizeRef, renderLoopRef),
  []
);
const handleOverlayResize = useMemo(
  () => createOverlayResizeHandler(overlayLoopRef),
  []
);
```

---

### Phase 1 Summary

**Changes**:
- 5 new files created
- ~150 lines moved out of Canvas.tsx
- All extractions are pure or self-contained
- Zero risk to existing functionality

**New File Structure**:
```
canvas/
├── Canvas.tsx (900 lines, -163)
├── internal/
│   ├── snapshot-diff.ts (+97 lines) ✨ NEW
│   ├── device-detection.ts (+40 lines) ✨ NEW
│   └── resize-handlers.ts (+26 lines) ✨ NEW
├── hooks/
│   ├── useCoordinateTransform.ts (+35 lines) ✨ NEW
│   └── useCursorManager.ts (+52 lines) ✨ NEW
```

**Testing**:
- Run type check: `npm run typecheck`
- Manual testing: All tools, zoom, pan, resize
- No behavioral changes expected

---

## Phase 2: Tool Management 🔶 (Medium Risk, High Value)

**Goal**: Simplify tool lifecycle effect
**Effort**: 4-6 hours
**Risk**: Medium (requires careful testing)
**Lines Saved**: ~100-150

### 2.1 Extract Tool Factory

**Current**: Lines 556-642 (tool creation branching logic)
**Target**: `client/src/canvas/internal/tool-factory.ts`

```typescript
// New file: canvas/internal/tool-factory.ts
import { DrawingTool } from '@/lib/tools/DrawingTool';
import { EraserTool } from '@/lib/tools/EraserTool';
import { TextTool } from '@/lib/tools/TextTool';
import { PanTool } from '@/lib/tools/PanTool';
import type { IRoomDocManager } from '@/lib/room-doc-manager';
import type { ViewTransform } from '@avlo/shared';
import type { Tool, ToolSettings, ShapeVariant } from '@/stores/device-ui-store';
import type { ResizeInfo } from '../CanvasStage';

export interface ToolFactoryContext {
  roomDoc: IRoomDocManager;
  userId: string;
  overlayLoopRef: React.MutableRefObject<any>;
  canvasSizeRef: React.MutableRefObject<ResizeInfo | null>;
  viewTransformRef: React.MutableRefObject<ViewTransform>;
  editorHostRef: React.RefObject<HTMLDivElement>;
  worldToClient: (x: number, y: number) => [number, number];
  applyCursor: () => void;
  setOverride: (cursor: string | null) => void;
}

export interface ToolConfig {
  activeTool: Tool;
  pen: ToolSettings;
  highlighter: ToolSettings;
  eraser: { size: number };
  text: { size: number; color: string };
  shape: { variant: ShapeVariant; settings: ToolSettings };
}

type PointerTool = DrawingTool | EraserTool | TextTool | PanTool;

export function createToolInstance(
  config: ToolConfig,
  context: ToolFactoryContext,
): PointerTool | null {
  const {
    roomDoc,
    userId,
    overlayLoopRef,
    canvasSizeRef,
    viewTransformRef,
    editorHostRef,
    worldToClient,
    applyCursor,
    setOverride,
  } = context;

  const { activeTool, pen, highlighter, eraser, text, shape } = config;

  // Eraser tool
  if (activeTool === 'eraser') {
    return new EraserTool(
      roomDoc,
      eraser,
      userId,
      () => overlayLoopRef.current?.invalidateAll(),
      () => {
        const size = canvasSizeRef.current;
        if (size) {
          return { cssWidth: size.cssWidth, cssHeight: size.cssHeight, dpr: size.dpr };
        }
        return { cssWidth: 1, cssHeight: 1, dpr: 1 };
      },
      () => viewTransformRef.current,
    );
  }

  // Drawing tools (pen/highlighter)
  if (activeTool === 'pen' || activeTool === 'highlighter') {
    const settings = activeTool === 'pen' ? pen : highlighter;
    return new DrawingTool(
      roomDoc,
      settings,
      activeTool,
      userId,
      (_bounds) => overlayLoopRef.current?.invalidateAll(),
      () => overlayLoopRef.current?.invalidateAll(),
      () => viewTransformRef.current,
    );
  }

  // Shape tool
  if (activeTool === 'shape') {
    const variant = shape?.variant ?? 'rectangle';
    const forceSnapKind =
      variant === 'rectangle' ? 'rect' :
      variant === 'ellipse'   ? 'ellipseRect' :
      variant === 'arrow'     ? 'arrow' : 'line';

    const settings = shape?.settings ?? pen;
    return new DrawingTool(
      roomDoc,
      settings,
      'pen',
      userId,
      (_bounds) => overlayLoopRef.current?.invalidateAll(),
      () => overlayLoopRef.current?.invalidateAll(),
      () => viewTransformRef.current,
      { forceSnapKind },
    );
  }

  // Text tool
  if (activeTool === 'text') {
    return new TextTool(
      roomDoc,
      text,
      userId,
      {
        worldToClient,
        getView: () => viewTransformRef.current,
        getEditorHost: () => editorHostRef.current,
      },
      () => overlayLoopRef.current?.invalidateAll(),
    );
  }

  // Pan tool
  if (activeTool === 'pan') {
    return new PanTool(
      () => viewTransformRef.current,
      (pan) => context.setPanRef.current?.(pan),
      () => overlayLoopRef.current?.invalidateAll(),
      applyCursor,
      setOverride,
    );
  }

  return null;
}
```

**Benefits**:
- Single source of truth for tool creation
- Testable in isolation
- Clear parameter contract
- Easier to add new tools

---

### 2.2 Extract Preview Provider Setup

**Target**: `client/src/canvas/internal/tool-preview-setup.ts`

```typescript
// New file: canvas/internal/tool-preview-setup.ts
import type { OverlayRenderLoop } from '@/renderer/OverlayRenderLoop';
import type { DrawingTool } from '@/lib/tools/DrawingTool';
import type { EraserTool } from '@/lib/tools/EraserTool';
import type { TextTool } from '@/lib/tools/TextTool';
import type { PanTool } from '@/lib/tools/PanTool';

type PointerTool = DrawingTool | EraserTool | TextTool | PanTool;

export function setupToolPreview(
  tool: PointerTool | null,
  overlayLoop: OverlayRenderLoop | null,
  suppressPreviewRef: React.MutableRefObject<boolean>,
  isMobile: boolean,
): void {
  if (!tool || !overlayLoop || isMobile) {
    overlayLoop?.setPreviewProvider(null);
    return;
  }

  overlayLoop.setPreviewProvider({
    getPreview: () => {
      if (suppressPreviewRef.current) return null;
      return tool.getPreview() || null;
    },
  });
}
```

---

### 2.3 Refactored Tool Lifecycle Effect

**After Phase 2, the tool effect becomes**:

```typescript
// In Canvas.tsx - MUCH simpler!
useEffect(() => {
  // Special handling for text tool config updates
  if (activeTool === 'text' && toolRef.current?.isActive()) {
    const textTool = toolRef.current as any;
    if ('updateConfig' in textTool) {
      textTool.updateConfig(text);
      return;
    }
  }

  // Wait for required dependencies
  if (!renderLoopRef.current || !baseStageRef.current?.getCanvasElement() || !roomDoc) {
    return;
  }

  const isMobile = isMobileDevice();

  // Create tool using factory
  const tool = createToolInstance(
    { activeTool, pen, highlighter, eraser, text, shape },
    {
      roomDoc,
      userId,
      overlayLoopRef,
      canvasSizeRef,
      viewTransformRef,
      editorHostRef,
      worldToClient,
      applyCursor: cursorManager.applyCursor,
      setOverride: cursorManager.setOverride,
    },
  );

  if (!tool) return;

  toolRef.current = tool;

  // Setup preview
  setupToolPreview(
    tool,
    overlayLoopRef.current,
    suppressToolPreviewRef,
    isMobile,
  );

  // Update cursor
  cursorManager.clearOverride();
  cursorManager.applyCursor();

  // Seed eraser preview if needed
  if (!isMobile && activeTool === 'eraser' && lastMouseClientRef.current) {
    const { x, y } = lastMouseClientRef.current;
    const world = screenToWorld(x, y);
    if (world) tool.move(world[0], world[1]);
  }

  // Canvas setup
  if (!isMobile) {
    const canvas = baseStageRef.current?.getCanvasElement();
    if (canvas) canvas.style.touchAction = 'none';
  }

  // Cleanup
  return () => {
    const pointerId = tool?.getPointerId();
    if (pointerId !== null) {
      try {
        baseStageRef.current?.getCanvasElement()?.releasePointerCapture(pointerId);
      } catch {}
    }
    tool?.cancel();
    tool?.destroy();
    toolRef.current = undefined;
    overlayLoopRef.current?.setPreviewProvider(null);

    if (mmbPanRef.current.active) {
      mmbPanRef.current = { active: false, pointerId: null, lastClient: null };
      cursorManager.clearOverride();
      suppressToolPreviewRef.current = false;
    }
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
  worldToClient,
  cursorManager,
]);
```

**Reduction**: ~200 lines → ~70 lines (65% smaller)

---

### Phase 2 Summary

**Changes**:
- 2 new files created
- Tool effect reduced by ~130 lines
- Factory pattern enables easier testing
- Clear separation of concerns

**New Files**:
```
canvas/internal/
├── tool-factory.ts (+120 lines) ✨ NEW
└── tool-preview-setup.ts (+25 lines) ✨ NEW
```

**Testing Requirements**:
- Test all tool switches
- Test tool seeding (eraser preview)
- Test text tool config updates
- Test mobile gating
- Test cleanup on unmount

---

## Phase 3: Event Handler Organization 🔴 (High Complexity)

**Goal**: Organize event handlers without breaking closure dependencies
**Effort**: 6-8 hours
**Risk**: High (heavy closure dependencies)
**Lines Saved**: ~50-100 (through better organization, not removal)

### Strategy: Extract Handlers as Functions (NOT Hooks)

**Key Insight**: Event handlers have heavy closure dependencies (refs, callbacks). Don't try to extract into hooks. Instead:
1. Extract handler functions to separate file
2. Pass all dependencies as parameters
3. Keep them called from Canvas.tsx effect

---

### 3.1 Extract Pointer Event Handlers

**Target**: `client/src/canvas/internal/pointer-handlers.ts`

```typescript
// New file: canvas/internal/pointer-handlers.ts
import type { IRoomDocManager } from '@/lib/room-doc-manager';
import type { Tool } from '@/stores/device-ui-store';
import type { CanvasStageHandle } from '../CanvasStage';
import type { DrawingTool } from '@/lib/tools/DrawingTool';

export interface PointerHandlerContext {
  baseStageRef: React.RefObject<CanvasStageHandle>;
  overlayLoopRef: React.MutableRefObject<any>;
  toolRef: React.MutableRefObject<any>;
  activeToolRef: React.MutableRefObject<Tool>;
  mmbPanRef: React.MutableRefObject<{
    active: boolean;
    pointerId: number | null;
    lastClient: { x: number; y: number } | null;
  }>;
  viewTransformRef: React.MutableRefObject<any>;
  setPanRef: React.MutableRefObject<any>;
  lastMouseClientRef: React.MutableRefObject<{ x: number; y: number } | null>;
  suppressToolPreviewRef: React.MutableRefObject<boolean>;
  roomDoc: IRoomDocManager;
  screenToWorld: (x: number, y: number) => [number, number] | null;
  applyCursor: () => void;
  setOverride: (cursor: string | null) => void;
  clearOverride: () => void;
}

export function createPointerDownHandler(ctx: PointerHandlerContext) {
  return (e: PointerEvent) => {
    const isMobile = /Android|webOS|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
                     navigator.maxTouchPoints > 1;
    if (isMobile) return;

    // MMB ephemeral pan
    if (e.button === 1) {
      e.preventDefault();
      if (ctx.toolRef.current?.isActive()) return;

      const canvas = ctx.baseStageRef.current?.getCanvasElement();
      if (!canvas) return;
      canvas.setPointerCapture(e.pointerId);

      ctx.mmbPanRef.current = {
        active: true,
        pointerId: e.pointerId,
        lastClient: { x: e.clientX, y: e.clientY },
      };

      ctx.setOverride('grabbing');
      ctx.suppressToolPreviewRef.current = true;
      ctx.applyCursor();
      ctx.overlayLoopRef.current?.invalidateAll();
      return;
    }

    // Normal tools (left button)
    if (e.button !== 0) return;

    const tool = ctx.toolRef.current;
    if (!tool?.canBegin()) return;

    const worldCoords = ctx.screenToWorld(e.clientX, e.clientY);
    if (!worldCoords) return;

    e.preventDefault();
    const captureCanvas = ctx.baseStageRef.current?.getCanvasElement();
    if (captureCanvas) {
      captureCanvas.setPointerCapture(e.pointerId);
    }

    // Pan tool gets client coords
    if (ctx.activeToolRef.current === 'pan' && 'begin' in tool) {
      (tool as any).begin(e.pointerId, worldCoords[0], worldCoords[1], e.clientX, e.clientY);
    } else {
      tool.begin(e.pointerId, worldCoords[0], worldCoords[1]);
    }

    // Update activity
    if (ctx.activeToolRef.current !== 'pan') {
      ctx.roomDoc.updateActivity('drawing');
    }
  };
}

export function createPointerMoveHandler(ctx: PointerHandlerContext) {
  return (e: PointerEvent) => {
    // Track for tool seeding
    ctx.lastMouseClientRef.current = { x: e.clientX, y: e.clientY };

    const isMobile = /Android|webOS|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
                     navigator.maxTouchPoints > 1;

    // Update presence
    if (!isMobile) {
      const world = ctx.screenToWorld(e.clientX, e.clientY);
      if (world) {
        ctx.roomDoc.updateCursor(world[0], world[1]);
      }
    }

    // MMB pan
    if (ctx.mmbPanRef.current.active && e.pointerId === ctx.mmbPanRef.current.pointerId) {
      const last = ctx.mmbPanRef.current.lastClient!;
      const dx = e.clientX - last.x;
      const dy = e.clientY - last.y;
      ctx.mmbPanRef.current.lastClient = { x: e.clientX, y: e.clientY };

      const view = ctx.viewTransformRef.current;
      if (view && ctx.setPanRef.current) {
        const newPan = {
          x: view.pan.x - dx / view.scale,
          y: view.pan.y - dy / view.scale,
        };
        ctx.setPanRef.current(newPan);
      }

      ctx.overlayLoopRef.current?.invalidateAll();
      return;
    }

    // Pan tool drag
    const tool = ctx.toolRef.current;
    if (tool && ctx.activeToolRef.current === 'pan' && 'updatePan' in tool) {
      (tool as any).updatePan(e.clientX, e.clientY);
      if (tool.isActive()) return;
    }

    // Normal tool hover
    if (!isMobile && tool) {
      const world = ctx.screenToWorld(e.clientX, e.clientY);
      if (world) {
        tool.move(world[0], world[1]);
      }
    }
  };
}

export function createPointerUpHandler(ctx: PointerHandlerContext) {
  return (e: PointerEvent) => {
    // Handle MMB release
    if (ctx.mmbPanRef.current.active && e.pointerId === ctx.mmbPanRef.current.pointerId) {
      try {
        ctx.baseStageRef.current?.getCanvasElement()?.releasePointerCapture(e.pointerId);
      } catch {}

      ctx.mmbPanRef.current = { active: false, pointerId: null, lastClient: null };
      ctx.clearOverride();
      ctx.suppressToolPreviewRef.current = false;
      ctx.applyCursor();
      ctx.overlayLoopRef.current?.invalidateAll();
      return;
    }

    // Normal tool end
    const tool = ctx.toolRef.current;
    if (!tool?.isActive() || e.pointerId !== tool.getPointerId()) return;

    try {
      ctx.baseStageRef.current?.getCanvasElement()?.releasePointerCapture(e.pointerId);
    } catch {}

    const world = ctx.screenToWorld(e.clientX, e.clientY);
    tool.end(world?.[0], world?.[1]);
    ctx.roomDoc.updateActivity('idle');
  };
}

// Similar exports for: createPointerCancelHandler, createLostPointerCaptureHandler,
// createPointerLeaveHandler, createWheelHandler
```

---

### 3.2 Refactored Event Listener Effect

**After Phase 3**:

```typescript
// In Canvas.tsx
useEffect(() => {
  const canvas = baseStageRef.current?.getCanvasElement();
  if (!canvas || !stageReady) return;

  // Create handler context
  const ctx: PointerHandlerContext = {
    baseStageRef,
    overlayLoopRef,
    toolRef,
    activeToolRef,
    mmbPanRef,
    viewTransformRef,
    setPanRef,
    lastMouseClientRef,
    suppressToolPreviewRef,
    roomDoc,
    screenToWorld,
    applyCursor: cursorManager.applyCursor,
    setOverride: cursorManager.setOverride,
    clearOverride: cursorManager.clearOverride,
  };

  // Create handlers
  const handlePointerDown = createPointerDownHandler(ctx);
  const handlePointerMove = createPointerMoveHandler(ctx);
  const handlePointerUp = createPointerUpHandler(ctx);
  const handlePointerCancel = createPointerCancelHandler(ctx);
  const handleLostPointerCapture = createLostPointerCaptureHandler(ctx);
  const handlePointerLeave = createPointerLeaveHandler(ctx);
  const handleWheel = createWheelHandler(ctx, zoomAnimatorRef);

  // Attach listeners
  canvas.addEventListener('pointerdown', handlePointerDown, { passive: false });
  canvas.addEventListener('pointermove', handlePointerMove, { passive: false });
  canvas.addEventListener('pointerup', handlePointerUp, { passive: false });
  canvas.addEventListener('pointercancel', handlePointerCancel, { passive: false });
  canvas.addEventListener('lostpointercapture', handleLostPointerCapture, { passive: false });
  canvas.addEventListener('pointerleave', handlePointerLeave, { passive: false });
  canvas.addEventListener('wheel', handleWheel, { passive: false });

  return () => {
    canvas.removeEventListener('pointerdown', handlePointerDown);
    canvas.removeEventListener('pointermove', handlePointerMove);
    canvas.removeEventListener('pointerup', handlePointerUp);
    canvas.removeEventListener('pointercancel', handlePointerCancel);
    canvas.removeEventListener('lostpointercapture', handleLostPointerCapture);
    canvas.removeEventListener('pointerleave', handlePointerLeave);
    canvas.removeEventListener('wheel', handleWheel);
  };
}, [stageReady, cursorManager, roomDoc, screenToWorld]);
```

**Reduction**: ~267 lines → ~40 lines (85% smaller in Canvas.tsx)

---

### Phase 3 Summary

**Benefits**:
- Event handler logic moved to dedicated file
- Easier to understand each handler in isolation
- Canvas.tsx becomes more readable
- Still maintains closure dependencies via context parameter

**Risks**:
- Breaking closure dependencies
- Timing issues with ref updates
- Harder to debug across file boundaries

**Mitigation**:
- Extensive testing of all pointer interactions
- Keep context type strict
- Add comprehensive JSDoc comments

---

## Phase 4: Optional Advanced Refactors ⚠️ (Consider Carefully)

### 4.1 Extract Render Loop Initialization (Optional)

**Risk**: Very High - Critical initialization order
**Reward**: Medium - ~140 lines saved
**Recommendation**: Only if Canvas.tsx is still too large after Phases 1-3

This could be extracted to `useRenderLoops` hook, but requires:
- Perfect preservation of initialization order
- Gate status handling
- Timeout fallback logic
- Comprehensive testing

**Decision**: Defer until needed. Phase 1-3 should be sufficient.

---

### 4.2 Split Canvas.tsx into Multiple Components (Not Recommended)

**Alternative considered**: Split into:
- `Canvas.tsx` (orchestrator, 100 lines)
- `CanvasInternal.tsx` (implementation, 400 lines)

**Why NOT recommended**:
- Adds complexity without clear benefit
- Props drilling for many refs
- Harder to understand the full picture
- Initialization order becomes unclear

**Decision**: Keep as single component. Phases 1-3 provide sufficient clarity.

---

## Final Target Architecture

### After All Phases

```
canvas/
├── Canvas.tsx (450-550 lines) ⬅️ Core orchestrator
│   ├── State/refs setup (~50 lines)
│   ├── Snapshot subscription (~50 lines)
│   ├── Render loop init (~140 lines) [could be extracted in Phase 4]
│   ├── Tool lifecycle (~70 lines) [down from 200]
│   ├── Event listeners (~40 lines) [down from 267]
│   ├── Other effects (~60 lines)
│   ├── Imperative handle (~21 lines)
│   └── JSX render (~31 lines)
│
├── internal/
│   ├── transforms.ts (existing)
│   ├── context2d.ts (existing)
│   ├── snapshot-diff.ts (+97 lines) ✨ NEW
│   ├── device-detection.ts (+40 lines) ✨ NEW
│   ├── resize-handlers.ts (+26 lines) ✨ NEW
│   ├── tool-factory.ts (+120 lines) ✨ NEW
│   ├── tool-preview-setup.ts (+25 lines) ✨ NEW
│   └── pointer-handlers.ts (+300 lines) ✨ NEW
│
├── hooks/
│   ├── useCoordinateTransform.ts (+35 lines) ✨ NEW
│   └── useCursorManager.ts (+52 lines) ✨ NEW
│
└── animation/
    └── ZoomAnimator.ts (existing)
```

**Total Reduction**: 1,063 → 450-550 lines (48-58% reduction)

---

## Implementation Plan

### Week 1: Phase 1 (Low Risk)
- **Day 1**: Extract snapshot-diff.ts + device-detection.ts
- **Day 2**: Create hooks (useCoordinateTransform, useCursorManager)
- **Day 3**: Extract resize-handlers.ts
- **Day 4**: Testing & validation
- **Day 5**: Buffer for fixes

### Week 2: Phase 2 (Medium Risk)
- **Day 1**: Create tool-factory.ts
- **Day 2**: Create tool-preview-setup.ts
- **Day 3**: Refactor tool lifecycle effect
- **Day 4**: Testing all tool transitions
- **Day 5**: Buffer for fixes

### Week 3: Phase 3 (High Risk)
- **Day 1-2**: Create pointer-handlers.ts with all handlers
- **Day 3**: Refactor event listener effect
- **Day 4-5**: Comprehensive testing of all pointer interactions

**Total Effort**: 3 weeks for full refactor (Phases 1-3)
**Conservative Estimate**: 4 weeks with buffer time

---

## Testing Checklist

### Phase 1 Testing
- [ ] Type check passes
- [ ] Snapshot diffing works correctly
- [ ] Mobile detection accurate
- [ ] Coordinate transforms match previous behavior
- [ ] Cursor changes work correctly
- [ ] Resize handlers trigger re-renders

### Phase 2 Testing
- [ ] All tools create successfully
- [ ] Tool switching works smoothly
- [ ] Preview provider setup correct
- [ ] Text tool config updates work
- [ ] Eraser preview seeding works
- [ ] Mobile gating prevents tool usage
- [ ] Cleanup runs on unmount

### Phase 3 Testing
- [ ] All pointer events fire correctly
- [ ] MMB pan works smoothly
- [ ] Tool gestures don't interfere with MMB
- [ ] Wheel zoom works
- [ ] Pointer capture/release works
- [ ] Presence updates correctly
- [ ] Mobile scrolling not blocked

---

## Risk Mitigation

### Critical Preservation Requirements

1. **Initialization Order**: NEVER change the order of:
   - Render loop setup → Tool creation → Event listeners

2. **Ref-based State**: Keep refs for performance-critical state:
   - snapshotRef (60 FPS updates)
   - viewTransformRef (read in handlers)
   - toolRef (stable across re-renders)

3. **Effect Dependencies**: Carefully maintain dependency arrays:
   - Tool effect: Must re-run on tool config changes
   - Event listener effect: Must NOT re-run on viewTransform changes
   - Snapshot subscription: Stable (roomDoc only)

4. **Closure Stability**: Event handlers must use refs, not props:
   - screenToWorld reads viewTransformRef
   - applyCursor reads activeToolRef
   - All handlers read latest refs

---

## Long-term Maintenance

### Adding New Tools

**Before refactor**: Add branching logic in Canvas.tsx tool effect
**After refactor**: Add case to `tool-factory.ts` only

### Adding New Pointer Events

**Before refactor**: Add handler in 267-line effect
**After refactor**: Add function to `pointer-handlers.ts` and wire in Canvas.tsx

### Debugging Issues

**Before refactor**: Search through 1,063 line file
**After refactor**: Jump to relevant module based on error

---

## Alternatives Considered

### Alternative 1: Component Splitting
**Idea**: Split into `<Canvas>` and `<CanvasInternal>`
**Verdict**: ❌ Rejected - Adds complexity without clear benefit

### Alternative 2: Class Component
**Idea**: Convert to class with instance methods
**Verdict**: ❌ Rejected - Goes against React best practices

### Alternative 3: State Machine
**Idea**: Use XState for tool/gesture state management
**Verdict**: ❌ Rejected - Overkill for current complexity

### Alternative 4: Do Nothing
**Idea**: Keep Canvas.tsx as-is
**Verdict**: ❌ Not viable - Will only get worse over time

---

## Success Metrics

### Quantitative
- [ ] Canvas.tsx reduced to 450-550 lines (48-58% reduction)
- [ ] 8 new focused modules created
- [ ] 0 behavioral regressions
- [ ] Type safety maintained (100%)

### Qualitative
- [ ] Easier for AI agents to understand context
- [ ] Faster to locate specific functionality
- [ ] Simpler to add new tools
- [ ] Better separation of concerns
- [ ] More testable units

---

## Conclusion

Canvas.tsx is complex **by necessity** - it's the central orchestrator for a sophisticated rendering system. The goal is not to eliminate complexity, but to **organize it better**.

**Recommended Approach**:
1. Start with Phase 1 (low risk, high value)
2. Validate thoroughly
3. Proceed to Phase 2 only after Phase 1 succeeds
4. Consider Phase 3 if still needed
5. Phase 4 is optional - only if absolutely necessary

**Key Principle**: Extract what can be extracted, document what must stay complex.

---

## Questions for Discussion

1. Should we proceed with all 3 phases, or stop after Phase 2?
2. Is the tool factory pattern the right abstraction?
3. Should event handlers stay as functions, or try hooks?
4. Any concerns about the proposed file structure?
5. What's the priority: AI readability or human maintainability?

---

**End of Audit**
