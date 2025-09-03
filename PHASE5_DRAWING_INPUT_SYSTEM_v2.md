# Phase 5: Drawing Input System - Implementation Guide

## Executive Summary

Phase 5 implements the core drawing input system for Avlo, enabling users to draw strokes on the canvas. This phase bridges user input to the data layer, creating a complete drawing pipeline from pointer events to committed strokes in Y.Doc.

## CRITICAL FIXES APPLIED (v3 - Final Production Review)

This version addresses ALL critical issues and must-verify gates identified in the final review:

### Previous Fixes Still Applied:

4. **No .current Race Conditions**: Explicit guards prevent accessing undefined refs, useLayoutEffect timing documented
5. **DeviceUI Memoization**: Added useMemo to prevent recreation and included in effect deps for correctness
6. **Comprehensive Cleanup**: Single cleanup function handles all teardown in correct order
7. **Type Import Fixes**: PreviewData imported from shared types module to avoid circular dependencies
8. **No Mid-Gesture Teardown**: Effect doesn't depend on viewTransform, preventing draw cancellation on pan/zoom
9. **Transform Error Handling**: screenToWorld returns null on error, all handlers check for null
10. **Accurate Size Estimation**: Fixed estimateEncodedSize to include realistic CRDT overhead
11. **Scene Ticks Error Handling**: Added error logging for missing scene_ticks (Phase 2 implementation issue)
12. **Preview Transform Context**: Explicitly documented that preview renders INSIDE world transform scope
13. **RenderLoop Validation**: Added check for setPreviewProvider method existence
14. **Dirty Rect Union Strategy**: Clarified that RenderLoop MUST union invalidated regions per frame
15. **World Transform Fix**: Removed incorrect `setTransform(scale,...)` references, using only `save/scale/translate/restore`
16. **Invalidation API Clarity**: Documented that `invalidateWorld()` accepts world-space bounds
17. **Non-null ViewTransform**: Made identity transform default mandatory to prevent deadlock
18. **Budget Enforcement**: Added 128KB re-check after hard downsample
19. **Mobile View-Only**: Added early gate, no preview on mobile, preserved scrolling
20. **Layer Signatures**: Kept existing Phase 4 signatures without augmentedViewport
21. **Scene Ticks Visibility**: Added TODO for toast/banner when metadata missing

**KEY INVARIANTS**:

- RenderLoop MUST be created in Canvas.tsx's useLayoutEffect (runs before useEffect)
- Preview MUST render after world content but INSIDE world transform
- World transforms use `save/scale/translate/restore` NEVER `setTransform`
- `invalidateWorld()` accepts world-space bounds (converts to device pixels internally)
- ViewTransform MUST provide non-null identity default to prevent deadlock
- Mobile detection uses BOTH UA string AND maxTouchPoints for reliability
- Mobile devices get NO preview, NO touch-action changes (preserve scrolling)
- Douglas-Peucker uses ITERATIVE implementation to handle 10k+ points safely
- DrawingTool effect includes `stageReady` dep to ensure initialization
- DrawingTool effect MUST NOT include viewTransform to prevent mid-gesture teardown
- ViewTransform accessed via ref to get latest value without effect re-runs
- CSS MUST NOT globally set touch-action: none (breaks mobile scrolling)
- World units for widths: Strokes and preview use world-space lineWidth (thickness consistent across zoom). This matches both Overview and Phase-4 render rules.
- Budgets and simplification: Commit-time Douglas–Peucker in world units; 128 KB update cap; ≤10k points; retry with ×1.4; hard downsample; re-check 128 KB after downsample.
- Registry pattern: Only access the room via the registry/hook; never instantiate directly. Your spec enforces this and matches Overview’s invariants.

**Key Deliverables:**

- Pointer event handling with proper capture/release
- Live preview rendering during drawing (0.35 opacity, desktop only)
- Tool settings frozen at pointerdown
- RAF-based event coalescing
- Douglas-Peucker simplification with 128KB and 10k point budgets
- Stroke commit with scene assignment
- Mobile view-only enforcement (no preview, preserved scrolling)

## CRITICAL: Transform Separation Contract

### DPR Transform (Device Pixel Ratio)

- **When**: Set ONCE during canvas resize/initialization
- **How**: `ctx.setTransform(dpr, 0, 0, dpr, 0, 0)`
- **Where**: In CanvasStage resize handler only
- **Never**: Do not touch during drawing, do not mix with world transforms

### World Transform

- **When**: Applied each frame during drawing
- **How**:
  ```javascript
  ctx.save(); // Preserves DPR transform
  ctx.scale(view.scale, view.scale);
  ctx.translate(-view.pan.x, -view.pan.y);
  // ... draw world content ...
  ctx.restore(); // Returns to DPR-only state
  ```
- **Never**: Use setTransform (would overwrite DPR)

### Transform Stack During Drawing

1. **Base State**: DPR transform via `setTransform(dpr,0,0,dpr,0,0)`
2. **World Drawing**: Add world transform via `save/scale/translate`
3. **Style Changes**: Additional `save/restore` for colors/opacity
4. **After Frame**: Back to DPR-only state

### Coordinate Space Pipeline

```
Screen (DOM)     →  Canvas (CSS px)  →  Device (physical px)  →  World (logical)
    ↑                    ↑                    ↑                      ↑
clientX/Y      getBoundingClientRect    DPR transform      view.scale/pan
                                       (set once)          (per frame)
```

## Critical Architecture Principles

### 1. Registry Pattern (MANDATORY)

- **NEVER** create RoomDocManager instances directly
- **ALWAYS** use `useRoomDocRegistry(roomId)` hook to get room
- Registry ensures singleton-per-room guarantee (critical for CRDT)

### 2. Coordinate System Clarity

```
Screen Space (DOM) → Canvas Space (CSS pixels) → World Space (Y.Doc)
                 ↑                           ↑
            clientX/Y                  Stored in strokes

clientX/Y from pointer events → subtract canvas rect → divide by scale, add pan → world coordinates
```

### 3. Render Pipeline Order (CRITICAL)

```
Background → Strokes → Shapes → Text → [AUTHORING OVERLAYS] → Presence → HUD
                                              ↑
                                      Preview lives here
```

### 4. Data Flow

```
Pointer Events → DrawingTool (local state) → Preview Provider → RenderLoop
                            ↓
                    On pointer-up only
                            ↓
                    room.mutate() → Y.Doc → Snapshot → UI
```

## Performance Considerations

1. **RAF Coalescing**: Only one RAF callback active per tool
2. **Dirty Rect Inflation**: Always include stroke width in bounds (world units)
3. **Preview Efficiency**: Reuse preview data object when possible
4. **Memory Management**: Cancel RAF and release capture on cleanup
5. **Simplification**: Run at pointer-up, not during gesture
6. **Transform Efficiency**:
   - DPR set once per resize (not per frame)
   - World transform via save/restore (preserves DPR)
   - Minimize transform stack depth

**INITIALIZATION ORDER REQUIREMENT**:
Canvas.tsx MUST create RenderLoop in its useLayoutEffect BEFORE the Phase 5 drawing tool effect runs. The Phase 5 effect waits for `renderLoopRef.current` to exist.

**CRITICAL TIMING**: The drawing tool initialization effect includes the guard:

```typescript
if (!renderLoop || !canvas || !room || !initialTransform) {
  return; // Dependencies not ready yet
}
```

This ensures the effect only runs when core dependencies are ready. ViewTransform is checked for initial availability but NOT included in effect deps to prevent mid-gesture teardown on pan/zoom.

## Prerequisites Verification Checklist

Before implementing Phase 5, verify these components exist from Phases 2-4:

- [ ] `Canvas.tsx` with `renderLoopRef` managing its own RenderLoop instance
  - **CRITICAL**: RenderLoop MUST be created in Canvas.tsx's useLayoutEffect before Phase 5 hooks run
  - Verify: `renderLoopRef.current = new RenderLoop(...)` exists in Canvas's useLayoutEffect
  - **TIMING**: useLayoutEffect runs synchronously before useEffect, ensuring RenderLoop exists
- [ ] `CanvasStage.tsx` exposing `getCanvasElement()` method
- [ ] `ViewTransform` interface and `useViewTransform()` hook
  - If missing, implement minimal version (see Step 8 below)
- [ ] `RenderLoop.ts` with `invalidateWorld()` (accepts world-space bounds) and `setPreviewProvider()` methods
- [ ] Stroke rendering pipeline in `layers/strokes.ts`

## Architecture Integration Points

### Canvas Transform Requirements

```typescript
// Phase 3 Canvas MUST implement this pattern:
class CanvasStage {
  private resizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    // Size the backing store (physical pixels)
    canvas.width = cssWidth * dpr;
    canvas.height = cssHeight * dpr;
    // Set DPR transform ONCE (never touch again during draw)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
}

// RenderLoop MUST NOT use setTransform for world transforms
// Instead use save/scale/translate/restore pattern
```

### Existing Infrastructure We'll Use

```typescript
// 1. RoomDocManager from registry (CRITICAL)
const room = useRoomDocRegistry(roomId);

// 2. Canvas manages RenderLoop (line 136 in Canvas.tsx)
const renderLoopRef = useRef<RenderLoop>();

// 3. ViewTransform for coordinate conversion
const viewTransform = useViewTransform(); // GUARANTEED non-null (uses identity default)
// NOTE: screenToWorld returns null on error for robustness
const screenToWorld = (clientX: number, clientY: number): [number, number] | null => {
  const canvas = stageRef.current?.getCanvasElement();
  if (!canvas || !viewTransform) return null; // Canvas check only (viewTransform always exists)
  const rect = canvas.getBoundingClientRect();
  const canvasX = clientX - rect.left;
  const canvasY = clientY - rect.top;
  return viewTransform.canvasToWorld(canvasX, canvasY);
};

// 4. Canvas element access
const canvas = stageRef.current?.getCanvasElement();

// 5. Invalidation API (CRITICAL: accepts world-space bounds)
renderLoop.invalidateWorld({ minX, minY, maxX, maxY }); // World coordinates
```

### What Phase 5 Must Add

1. `DrawingTool` class to manage drawing state
2. Preview provider integration with RenderLoop
3. Preview rendering layer (drawPreview function)
4. Pointer event handlers with proper coordinate transforms
5. Simplification utilities (Douglas-Peucker implementation)
6. Coordinate transform utilities (screenToWorld, using ViewTransform)

## Step 1: Prepare RenderLoop for Preview Support

### 1.1 Add Preview Provider Property to RenderLoop

```typescript
// client/src/renderer/RenderLoop.ts - Add at class level

import { drawPreview } from './layers/preview';
import type { PreviewData } from '../lib/tools/types'; // Import from types

export interface PreviewProvider {
  getPreview(): PreviewData | null;
}

export class RenderLoop {
  // Add this property
  private previewProvider: PreviewProvider | null = null;

  // Add setter method
  public setPreviewProvider(provider: PreviewProvider | null): void {
    this.previewProvider = provider;
  }

  // In the draw method, add preview rendering in the correct layer order:
  // According to OVERVIEW.MD render order:
  // Background → Strokes → Shapes → Text → [AUTHORING OVERLAYS] → Presence → HUD
  //                                             ↑ Preview goes here
  private draw(): void {
    // ... existing code ...

    // World content layers (keep existing signatures from Phase 4)
    drawStrokes(ctx, snapshot, view);
    drawShapes(ctx, snapshot, view);
    drawText(ctx, snapshot, view);

    // Authoring overlay - preview goes here
    // CRITICAL TRANSFORM STATE: Context has world transform applied!
    // - Transform was applied BEFORE drawStrokes using: ctx.save(); ctx.scale(view.scale, view.scale); ctx.translate(-view.pan.x, -view.pan.y);
    // - Preview points are in world space and will be automatically transformed to canvas space
    // - DO NOT apply additional transforms in drawPreview!
    const preview = this.previewProvider?.getPreview();
    if (preview) {
      drawPreview(ctx, preview); // Draws in world coordinates (transform already applied)
    }

    // Presence and HUD overlays (keep existing signatures)
    drawPresence(ctx, snapshot, view);
    // ... rest of draw code ...
  }
}
```

## Step 2: Create Drawing Tool Types

```typescript
// client/src/lib/tools/types.ts

export interface DrawingToolConfig {
  tool: 'pen' | 'highlighter';
  color: string;
  size: number;
  opacity: number;
}

export interface DrawingState {
  isDrawing: boolean;
  pointerId: number | null;
  points: number[]; // [x,y, x,y, ...] in world coordinates

  // Tool settings frozen at gesture start
  config: DrawingToolConfig;
  startTime: number;
}

// PreviewData is the single source of truth for preview structure
// Used by both DrawingTool and RenderLoop
export interface PreviewData {
  points: ReadonlyArray<number>;
  tool: 'pen' | 'highlighter';
  color: string;
  size: number;
  opacity: number;
  bbox: [number, number, number, number] | null; // Used for dirty rect tracking
}

// Simplified device UI for Phase 5 (no Zustand yet)
export interface DeviceUIState {
  tool: 'pen' | 'highlighter';
  color: string;
  size: number;
  opacity: number;
}
```

## Step 3: Implement Drawing Tool Class

```typescript
// client/src/lib/tools/DrawingTool.ts

import { ulid } from 'ulid';
import * as Y from 'yjs';
import type { IRoomDocManager } from '../room-doc-manager';
import { STROKE_CONFIG, ROOM_CONFIG } from '@avlo/shared';
import { simplifyStroke, calculateBBox, estimateEncodedSize } from './simplification';
import type { DrawingState, PreviewData, DeviceUIState } from './types';

// These constants are imported from @avlo/shared config
// See Step 7 for the values to add to /packages/shared/src/config.ts

export class DrawingTool {
  private state: DrawingState;
  private room: IRoomDocManager; // Use interface, not implementation
  private deviceUI: DeviceUIState;
  private userId: string; // Stable user ID for all strokes from this tool instance

  // RAF coalescing
  private rafId: number | null = null;
  private pendingPoint: [number, number] | null = null;
  private lastBounds: [number, number, number, number] | null = null;

  // Callbacks
  private onInvalidate?: (bounds: [number, number, number, number]) => void;

  constructor(
    room: IRoomDocManager, // Use interface for loose coupling
    deviceUI: DeviceUIState,
    userId: string, // Pass stable ID, not a getter function
    onInvalidate?: (bounds: [number, number, number, number]) => void,
  ) {
    this.room = room;
    this.deviceUI = deviceUI;
    this.userId = userId; // Store the stable ID
    this.onInvalidate = onInvalidate;
    this.resetState();
  }

  private resetState(): void {
    this.state = {
      isDrawing: false,
      pointerId: null,
      points: [],
      config: {
        tool: 'pen',
        color: '#000000',
        size: 4,
        opacity: 1,
      },
      startTime: 0,
    };
    this.lastBounds = null;
  }

  canStartDrawing(): boolean {
    const tool = this.deviceUI.tool;
    return !this.state.isDrawing && (tool === 'pen' || tool === 'highlighter');
  }

  startDrawing(pointerId: number, worldX: number, worldY: number): void {
    if (this.state.isDrawing) return;

    // Freeze tool settings at gesture start (CRITICAL)
    this.state = {
      isDrawing: true,
      pointerId,
      points: [worldX, worldY],
      config: {
        tool: this.deviceUI.tool,
        color: this.deviceUI.color,
        size: this.deviceUI.size,
        opacity:
          this.deviceUI.tool === 'highlighter'
            ? STROKE_CONFIG.HIGHLIGHTER_DEFAULT_OPACITY
            : this.deviceUI.opacity,
      },
      startTime: Date.now(),
    };
  }

  addPoint(worldX: number, worldY: number): void {
    if (!this.state.isDrawing) return;

    // Coalesce to RAF
    this.pendingPoint = [worldX, worldY];

    if (!this.rafId) {
      this.rafId = requestAnimationFrame(() => {
        // Double-check state in case tool was destroyed during RAF
        if (this.pendingPoint && this.state.isDrawing) {
          this.state.points.push(...this.pendingPoint);
          this.updateBounds();
        }
        this.pendingPoint = null;
        this.rafId = null;
      });
    }
  }

  private flushPending(): void {
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    if (this.pendingPoint && this.state.isDrawing) {
      this.state.points.push(...this.pendingPoint);
      this.pendingPoint = null;
    }
  }

  private updateBounds(): void {
    // Calculate bounds WITH stroke width inflation
    const bounds = calculateBBox(this.state.points, this.state.config.size);

    // Invalidate old region first (if exists)
    if (this.lastBounds) {
      this.onInvalidate?.(this.lastBounds);
    }

    // Then invalidate new region
    // CRITICAL: RenderLoop MUST internally union all invalidated regions
    // within a single frame to avoid redundant redraws
    // This is a Phase 3 RenderLoop responsibility, not DrawingTool's
    // DrawingTool can call invalidate multiple times; RenderLoop handles deduplication
    if (bounds) {
      this.onInvalidate?.(bounds);
      this.lastBounds = bounds;
    }
  }

  getPreview(): PreviewData | null {
    if (!this.state.isDrawing || this.state.points.length < 2) {
      return null;
    }

    return {
      points: this.state.points,
      tool: this.state.config.tool,
      color: this.state.config.color,
      size: this.state.config.size,
      opacity: STROKE_CONFIG.CURSOR_PREVIEW_OPACITY, // 0.35
      bbox: this.lastBounds,
    };
  }

  isDrawing(): boolean {
    return this.state.isDrawing;
  }

  getPointerId(): number | null {
    return this.state.pointerId;
  }

  cancelDrawing(): void {
    this.flushPending();
    if (this.lastBounds) {
      this.onInvalidate?.(this.lastBounds);
    }
    this.resetState();
  }

  commitStroke(finalX: number, finalY: number): void {
    if (!this.state.isDrawing) return;

    // CRITICAL: Flush RAF before commit
    this.flushPending();

    // Add final point if different
    const len = this.state.points.length;
    if (len < 2 || this.state.points[len - 2] !== finalX || this.state.points[len - 1] !== finalY) {
      this.state.points.push(finalX, finalY);
    }

    // Validate minimum points
    if (this.state.points.length < 4) {
      this.cancelDrawing();
      return;
    }

    // Store preview bounds before simplification
    const previewBounds = this.lastBounds;

    // Simplify FIRST, then check size
    const { points: simplified } = simplifyStroke(this.state.points, this.state.config.tool);

    // Check if simplification rejected the stroke (empty points means exceeded 128KB budget)
    if (simplified.length === 0) {
      // TODO: Show user toast about stroke being too complex
      this.cancelDrawing();
      return;
    }

    // Check frame size AFTER simplification (2MB transport limit)
    const estimatedSize = estimateEncodedSize(simplified);
    if (estimatedSize > ROOM_CONFIG.MAX_INBOUND_FRAME_BYTES) {
      console.error(
        `Stroke too large for transport: ${estimatedSize} bytes (max: ${ROOM_CONFIG.MAX_INBOUND_FRAME_BYTES})`,
      );
      // TODO: Show user toast about stroke being too complex
      this.cancelDrawing();
      return;
    }

    // Calculate final bbox for the simplified stroke
    const simplifiedBbox = calculateBBox(simplified, this.state.config.size);

    // Commit to Y.Doc
    const strokeId = ulid();
    const userId = this.userId; // Use stable ID stored at construction

    try {
      this.room.mutate((ydoc) => {
        const root = ydoc.getMap('root');
        const strokes = root.get('strokes') as Y.Array<any>;
        const meta = root.get('meta') as Y.Map<any>;

        // Get scene_ticks (MUST be initialized by RoomDocManager in Phase 2)
        const sceneTicks = meta.get('scene_ticks') as Y.Array<number>;
        if (!sceneTicks) {
          // This is a CRITICAL error - scene_ticks MUST be initialized in Phase 2
          console.error('CRITICAL: scene_ticks not initialized - Phase 2 implementation is broken');
          // TODO: Show user toast/banner about room metadata not initialized
          // Surface this error visibly so it's not silent
          return;
        }

        // Scene assigned AT COMMIT TIME
        const currentScene = sceneTicks.length;

        strokes.push([
          {
            id: strokeId,
            tool: this.state.config.tool, // Frozen at start
            color: this.state.config.color, // Frozen at start
            size: this.state.config.size, // Frozen at start
            opacity: this.state.config.opacity, // Frozen at start
            points: simplified, // Plain number[]
            bbox: simplifiedBbox,
            scene: currentScene,
            createdAt: Date.now(),
            userId,
          },
        ]);
      });
    } catch (err) {
      console.error('Failed to commit stroke:', err);
    } finally {
      // CRITICAL: Invalidate BOTH preview bounds AND simplified stroke bounds
      // The preview bounds clear the preview rendering
      // The simplified bounds ensure the new stroke area is redrawn
      if (previewBounds) {
        this.onInvalidate?.(previewBounds);
      }
      if (simplifiedBbox) {
        this.onInvalidate?.(simplifiedBbox);
      }
      this.resetState();
    }
  }

  destroy(): void {
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null; // Ensure idempotent
    }
    this.resetState();
  }
}
```

## Step 4: Create Preview Rendering Layer

```typescript
// client/src/renderer/layers/preview.ts

import type { PreviewData } from '@/lib/tools/types';

/**
 * Draw preview stroke
 * CRITICAL: This is called INSIDE world transform scope
 * The context has the world transform already applied when this is called
 * The preview is drawn as an authoring overlay AFTER world content but BEFORE transform restore
 * Preview points are in world coordinates and will be transformed to canvas automatically
 */
export function drawPreview(ctx: CanvasRenderingContext2D, preview: PreviewData): void {
  if (!preview || preview.points.length < 2) return;

  ctx.save();

  // Apply preview styling
  ctx.strokeStyle = preview.color;
  ctx.lineWidth = preview.size; // World units
  ctx.globalAlpha = preview.opacity; // 0.35 for preview
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // Build path
  ctx.beginPath();
  ctx.moveTo(preview.points[0], preview.points[1]);

  for (let i = 2; i < preview.points.length; i += 2) {
    ctx.lineTo(preview.points[i], preview.points[i + 1]);
  }

  ctx.stroke();
  ctx.restore();
}
```

## Step 5: Integrate Drawing Tool with Canvas

```typescript
// client/src/canvas/Canvas.tsx - Add to existing component

import { useState, useEffect, useLayoutEffect, useCallback, useMemo, useRef } from 'react';
import { ulid } from 'ulid';
import { DrawingTool } from '@/lib/tools/DrawingTool';
import type { DeviceUIState } from '@/lib/tools/types';
import { useRoomDocRegistry } from '@/hooks/useRoomDocRegistry';
import { useViewTransform } from '@/hooks/useViewTransform';

function Canvas({ roomId }: CanvasProps) {
  // CRITICAL: Get room from registry - NEVER instantiate directly
  const room = useRoomDocRegistry(roomId);

  // ... existing code (stageRef, renderLoopRef from Phase 3) ...

  const drawingToolRef = useRef<DrawingTool>();

  // Generate stable user ID (Phase 5 placeholder)
  // IMPORTANT: This will be replaced by proper awareness management in Phase 6
  // For now, we generate a stable ID once per component mount (tab session)
  // We use useState (not useRef) to ensure the ID is created exactly once
  // and remains stable throughout the component lifecycle
  const [userId] = useState(() => {
    // Try to reuse existing ID from sessionStorage for consistency
    let id = sessionStorage.getItem('avlo-user-id');
    if (!id) {
      id = 'user-' + ulid();
      sessionStorage.setItem('avlo-user-id', id);
    }
    return id;
  });

  // Default device UI (Phase 5 - no Zustand yet)
  // IMPORTANT: This is intentionally static for Phase 5
  // When Zustand is added in Phase 7, this will need to be in effect deps
  const deviceUI: DeviceUIState = useMemo(
    () => ({
      tool: 'pen',
      color: '#000000',
      size: 4,
      opacity: 1,
    }),
    [],
  ); // Memoized to prevent recreation

  // Get view transform for coordinate conversions
  const viewTransform = useViewTransform();

  // Store viewTransform in a ref so event handlers always get the latest
  // WITHOUT causing effect re-runs that would cancel drawing mid-gesture
  const viewTransformRef = useRef(viewTransform);
  useLayoutEffect(() => {
    viewTransformRef.current = viewTransform;
  }, [viewTransform]);

  // Convert screen coordinates (DOM event) to world coordinates (Y.Doc space)
  // CRITICAL: This function is stable (no deps) to prevent effect re-runs
  // It reads viewTransform from ref to always use the latest transform
  const screenToWorld = useCallback((clientX: number, clientY: number): [number, number] | null => {
    const canvas = stageRef.current?.getCanvasElement();
    const transform = viewTransformRef.current; // Always get latest transform
    if (!canvas || !transform) {
      console.warn('Cannot convert coordinates: canvas or transform not ready');
      return null; // Signal error to caller
    }

    const rect = canvas.getBoundingClientRect();
    // Screen → Canvas (CSS pixels)
    const canvasX = clientX - rect.left;
    const canvasY = clientY - rect.top;

    // Canvas → World (using ViewTransform)
    return transform.canvasToWorld(canvasX, canvasY);
  }, []); // NO DEPENDENCIES - stable function that reads from refs

  // CRITICAL FIX: Compute stageReady to ensure effect re-runs when stage becomes available
  // This prevents the initialization from silently failing if timing precondition is missed
  const stageReady = !!(renderLoopRef.current && stageRef.current?.getCanvasElement());

  // CRITICAL FIX: Combined initialization and event listener effect
  // This ensures everything is wired up atomically when dependencies are ready
  // IMPORTANT: viewTransform is NOT in dependencies to prevent mid-gesture teardown
  // stageReady IS in dependencies to ensure re-run when stage becomes available
  useEffect(() => {
    // Wait for all required dependencies
    const renderLoop = renderLoopRef.current;
    const canvas = stageRef.current?.getCanvasElement();
    const initialTransform = viewTransformRef.current; // Check initial availability

    // Guard: ensure all required components exist
    // This effect WILL re-run when stageReady changes (once)
    if (!renderLoop || !canvas || !room || !initialTransform) {
      console.debug('DrawingTool waiting for dependencies:', {
        renderLoop: !!renderLoop,
        canvas: !!canvas,
        room: !!room,
        viewTransform: !!initialTransform,
      });
      return; // Dependencies not ready yet, will retry when stageReady changes
    }

    // Validate that RenderLoop supports preview provider BEFORE creating tool
    if (typeof renderLoop.setPreviewProvider !== 'function') {
      console.error(
        'RenderLoop does not support preview provider - Phase 3 implementation missing',
      );
      return; // Exit early before creating tool to prevent memory leak
    }

    // Create drawing tool AFTER validation
    const tool = new DrawingTool(
      room,
      deviceUI,
      userId, // Pass the stable ID value
      (bounds) => {
        // Invalidate with inflated bounds
        renderLoop.invalidateWorld({
          minX: bounds[0],
          minY: bounds[1],
          maxX: bounds[2],
          maxY: bounds[3],
        });
      },
    );

    drawingToolRef.current = tool;

    // Mobile detection for view-only enforcement
    // CRITICAL FIX: Include maxTouchPoints check for iPadOS (reports as "Macintosh")
    //🛠️ Patch snippets (drop-in for your agents)
    //Mobile detection (use everywhere you gate “mobile view-only”)
    //const ua = navigator.userAgent;
    //const isIPadOS = /Macintosh/.test(ua) && navigator.maxTouchPoints > 1;
    //const isMobileUA = /Android|webOS|iPhone|iPad|iPod/i.test(ua) && !/Macintosh/.test(ua);
    //export const isMobile = isIPadOS || isMobileUA;
    //(Replace the existing navigator.maxTouchPoints > 1 clause outside of the iPadOS special-case.)
    const isMobile =
      /Android|webOS|iPhone|iPad|iPod/i.test(navigator.userAgent) || navigator.maxTouchPoints > 1;

    // Set preview provider on RenderLoop (disabled on mobile - no authoring overlays)
    if (!isMobile) {
      renderLoop.setPreviewProvider({
        getPreview: () => tool.getPreview(),
      });
    }

    // EVENT LISTENERS - Attached in same effect to ensure atomicity
    const handlePointerDown = (e: PointerEvent) => {
      // Gate early for mobile view-only (no preview, no capture)
      if (isMobile) return;

      if (!tool.canStartDrawing()) return;

      const worldCoords = screenToWorld(e.clientX, e.clientY);
      if (!worldCoords) return; // Transform failed

      e.preventDefault();
      canvas.setPointerCapture(e.pointerId);

      const [worldX, worldY] = worldCoords;
      tool.startDrawing(e.pointerId, worldX, worldY);
    };

    const handlePointerMove = (e: PointerEvent) => {
      if (!tool.isDrawing()) return;
      if (e.pointerId !== tool.getPointerId()) return;

      const worldCoords = screenToWorld(e.clientX, e.clientY);
      if (!worldCoords) return; // Transform failed, skip this point

      e.preventDefault();
      const [worldX, worldY] = worldCoords;
      tool.addPoint(worldX, worldY);
    };

    const handlePointerUp = (e: PointerEvent) => {
      if (!tool.isDrawing()) return;
      if (e.pointerId !== tool.getPointerId()) return;

      try {
        canvas.releasePointerCapture(e.pointerId);
      } catch {} // Ignore if already released

      const worldCoords = screenToWorld(e.clientX, e.clientY);
      if (!worldCoords) {
        // Can't get final point, cancel the stroke for safety
        console.warn('Failed to get final coordinates, canceling stroke');
        tool.cancelDrawing();
        return;
      }

      const [worldX, worldY] = worldCoords;
      tool.commitStroke(worldX, worldY);
    };

    const handlePointerCancel = (e: PointerEvent) => {
      if (e.pointerId !== tool.getPointerId()) return;

      try {
        canvas.releasePointerCapture(e.pointerId);
      } catch {} // Ignore if already released

      tool.cancelDrawing();
    };

    const handleLostPointerCapture = (e: PointerEvent) => {
      if (e.pointerId !== tool.getPointerId()) return;
      tool.cancelDrawing();
    };

    // Set canvas styles (conditional for mobile)
    if (!isMobile) {
      // Only disable touch on desktop (preserve scrolling on mobile)
      canvas.style.touchAction = 'none';
      canvas.style.cursor = 'crosshair';
    }
    // CRITICAL FIX: Ensure NO global CSS sets touch-action: none on canvas for mobile
    // Check your stylesheets - mobile MUST preserve touch-action: auto for scrolling
    // Note: Canvas CSS size should be set by CanvasStage
    // Physical size (width/height) = CSS size * DPR (handled by CanvasStage)

    // Attach listeners with non-passive flag for preventDefault
    canvas.addEventListener('pointerdown', handlePointerDown, { passive: false });
    canvas.addEventListener('pointermove', handlePointerMove, { passive: false });
    canvas.addEventListener('pointerup', handlePointerUp, { passive: false });
    canvas.addEventListener('pointercancel', handlePointerCancel, { passive: false });
    canvas.addEventListener('lostpointercapture', handleLostPointerCapture, { passive: false });

    // CLEANUP - comprehensive cleanup on any dependency change
    return () => {
      // Cancel any in-progress drawing
      const pointerId = tool.getPointerId();
      if (pointerId !== null) {
        try {
          canvas.releasePointerCapture(pointerId);
        } catch {} // Ignore errors
      }
      tool.cancelDrawing();

      // Remove event listeners
      canvas.removeEventListener('pointerdown', handlePointerDown);
      canvas.removeEventListener('pointermove', handlePointerMove);
      canvas.removeEventListener('pointerup', handlePointerUp);
      canvas.removeEventListener('pointercancel', handlePointerCancel);
      canvas.removeEventListener('lostpointercapture', handleLostPointerCapture);

      // Clean up tool and preview provider
      tool.destroy();
      drawingToolRef.current = undefined;
      renderLoop.setPreviewProvider(null);
    };
  }, [room, userId, deviceUI, stageReady]); // CRITICAL: stageReady ensures re-run, but NO viewTransform to prevent mid-gesture teardown

  // ... rest of component ...
}
```

## Step 6: Implement Simplification Utilities

```typescript
// client/src/lib/tools/simplification.ts

import { STROKE_CONFIG } from '@avlo/shared';

export interface SimplificationResult {
  points: number[];
  simplified: boolean;
  retries: number;
}

export function calculateBBox(
  points: number[],
  strokeSize: number = 0,
): [number, number, number, number] | null {
  if (points.length < 2) return null;

  let minX = points[0];
  let minY = points[1];
  let maxX = points[0];
  let maxY = points[1];

  for (let i = 2; i < points.length; i += 2) {
    minX = Math.min(minX, points[i]);
    maxX = Math.max(maxX, points[i]);
    minY = Math.min(minY, points[i + 1]);
    maxY = Math.max(maxY, points[i + 1]);
  }

  // CRITICAL: Inflate bounds for proper invalidation
  // This is in WORLD units (DPR handled at canvas level)
  const padding = strokeSize * 0.5 + 1;
  return [minX - padding, minY - padding, maxX + padding, maxY + padding];
}

export function estimateEncodedSize(points: number[]): number {
  // Yjs encoding estimate including CRDT overhead
  // points is a flat array [x0,y0,x1,y1,...] where points.length = numCoordinates
  // Each coordinate (number) in the array contributes:
  // - 8 bytes for the float64 value
  // - ~8 bytes for CRDT metadata (item ID, left/right refs, etc.)
  // Total: ~16 bytes per coordinate
  const pointsOverhead = points.length * 16; // points.length is number of coordinates
  const strokeMetadata = 500; // id, tool, color, bbox, etc.
  const updateEnvelope = 1024; // Yjs update wrapper and state vectors
  return pointsOverhead + strokeMetadata + updateEnvelope;
}

export function simplifyStroke(
  points: number[],
  tool: 'pen' | 'highlighter',
): SimplificationResult {
  // Minimum 2 points (4 values) required
  if (points.length < 4) {
    return { points, simplified: false, retries: 0 };
  }

  const baseTol =
    tool === 'pen'
      ? STROKE_CONFIG.PEN_SIMPLIFICATION_TOLERANCE
      : STROKE_CONFIG.HIGHLIGHTER_SIMPLIFICATION_TOLERANCE;

  let tolerance = baseTol;
  let simplified = douglasPeucker(points, tolerance);
  let retries = 0;

  // Check constraints
  const size = estimateEncodedSize(simplified);
  const count = simplified.length / 2;

  if (size > STROKE_CONFIG.MAX_STROKE_UPDATE_BYTES || count > STROKE_CONFIG.MAX_POINTS_PER_STROKE) {
    // One retry with increased tolerance
    tolerance *= STROKE_CONFIG.SIMPLIFICATION_TOLERANCE_MULTIPLIER;

    // Cap highlighter tolerance
    if (tool === 'highlighter') {
      tolerance = Math.min(tolerance, baseTol * STROKE_CONFIG.HIGHLIGHTER_TOLERANCE_MAX_MULTIPLIER);
    }

    simplified = douglasPeucker(points, tolerance);
    retries = 1;

    // Still too big? Hard downsample
    if (simplified.length / 2 > STROKE_CONFIG.MAX_POINTS_PER_STROKE) {
      simplified = hardDownsample(simplified, STROKE_CONFIG.MAX_POINTS_PER_STROKE);
    }

    // CRITICAL: Re-check 128KB budget after downsample
    const finalSize = estimateEncodedSize(simplified);
    if (finalSize > STROKE_CONFIG.MAX_STROKE_UPDATE_BYTES) {
      // Still exceeds budget even after downsample - stroke is too complex
      console.error(
        `Stroke still too large after downsample: ${finalSize} bytes (max: ${STROKE_CONFIG.MAX_STROKE_UPDATE_BYTES})`,
      );
      return { points: [], simplified: false, retries }; // Return empty to signal rejection
    }
  }

  return { points: simplified, simplified: true, retries };
}

function douglasPeucker(points: number[], tolerance: number): number[] {
  if (points.length < 4) return points; // Less than 2 points

  const numPoints = points.length / 2;

  // CRITICAL FIX: Iterative implementation to prevent stack overflow on long strokes
  // Uses explicit stack instead of recursion to handle 10k+ point strokes safely
  const keep = new Uint8Array(numPoints);
  keep[0] = 1; // Always keep first point
  keep[numPoints - 1] = 1; // Always keep last point

  const stack: Array<[number, number]> = [[0, numPoints - 1]];

  while (stack.length > 0) {
    const [startIdx, endIdx] = stack.pop()!;

    if (endIdx - startIdx < 2) continue; // No intermediate points

    // Find point with maximum distance from line segment
    let maxDist = 0;
    let maxIdx = -1;

    const x1 = points[startIdx * 2],
      y1 = points[startIdx * 2 + 1];
    const x2 = points[endIdx * 2],
      y2 = points[endIdx * 2 + 1];

    for (let i = startIdx + 1; i < endIdx; i++) {
      const x = points[i * 2],
        y = points[i * 2 + 1];
      const dist = perpendicularDistance(x, y, x1, y1, x2, y2);
      if (dist > maxDist) {
        maxDist = dist;
        maxIdx = i;
      }
    }

    // If max distance exceeds tolerance, keep the point and recurse
    if (maxDist >= tolerance && maxIdx !== -1) {
      keep[maxIdx] = 1;
      stack.push([startIdx, maxIdx]);
      stack.push([maxIdx, endIdx]);
    }
  }

  // Reconstruct simplified points from keep array
  const result: number[] = [];
  for (let i = 0; i < numPoints; i++) {
    if (keep[i]) {
      result.push(points[i * 2], points[i * 2 + 1]);
    }
  }

  return result;
}

function perpendicularDistance(
  px: number,
  py: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const norm = Math.sqrt(dx * dx + dy * dy);

  if (norm === 0) {
    return Math.sqrt((px - x1) ** 2 + (py - y1) ** 2);
  }

  return Math.abs(dy * px - dx * py + x2 * y1 - y2 * x1) / norm;
}

function hardDownsample(points: number[], maxPoints: number): number[] {
  const numPoints = points.length / 2;
  if (numPoints <= maxPoints) return points;

  const result: number[] = [];
  const step = (numPoints - 1) / (maxPoints - 1);

  for (let i = 0; i < maxPoints - 1; i++) {
    const idx = Math.floor(i * step);
    result.push(points[idx * 2], points[idx * 2 + 1]);
  }

  // Always include the last point
  result.push(points[points.length - 2], points[points.length - 1]);

  return result;
}
```

## Step 7: Mobile View-Only Enforcement

The canonical enforcement happens in `RoomDocManager.mutate()`:

```typescript
// In RoomDocManager implementation (already exists from Phase 2)
mutate(fn: (ydoc: Y.Doc) => void): void {
  // Canonical guards
  if (this.currentSnapshot.meta.readOnly) {
    throw new Error('Room is read-only');
  }

  // Mobile detection with maxTouchPoints for iPadOS reliability
  // CRITICAL FIX: Include maxTouchPoints check as iPadOS reports "Macintosh" UA
  if (/Android|webOS|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
      navigator.maxTouchPoints > 1) {
    throw new Error('Mobile devices are view-only');
  }

  // ... rest of mutate implementation
}
```

For UI feedback:

```typescript
// client/src/components/MobileViewOnlyBanner.tsx
export function MobileViewOnlyBanner() {
  // CRITICAL FIX: Include maxTouchPoints check for iPadOS reliability
  const isMobile = /Android|webOS|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
                   navigator.maxTouchPoints > 1;

  if (!isMobile) return null;

  return (
    <div className="fixed top-0 left-0 right-0 bg-yellow-100 p-2 text-center">
      Mobile devices are view-only. Use desktop to edit.
    </div>
  );
}
```

## Critical Implementation Checklist

### Architecture Compliance

- [ ] Room accessed via `useRoomDocRegistry()` hook (registry pattern)
- [ ] Preview renders as authoring overlay (after world content, before presence, desktop only)
- [ ] Tool settings frozen at pointerdown, never change mid-gesture
- [ ] Scene assigned at commit time using `meta.scene_ticks.length`
- [ ] Points stored as plain `number[]`, never Float32Array
- [ ] Coordinate transforms use ViewTransform with non-null identity default
- [ ] World transforms use save/scale/translate/restore (never setTransform)
- [ ] invalidateWorld() accepts world-space bounds
- [ ] Mobile gets early gate: no preview, no touch-action changes
- [ ] No direct Y.Doc access in UI components

### Event Handling

- [ ] Canvas element tracked via state for proper effect dependencies
- [ ] Pointer capture set on down, released on up/cancel/lost
- [ ] Pointer ID validated to prevent cross-pointer interference
- [ ] RAF flushed before commit to prevent race conditions
- [ ] Cleanup always releases capture and cancels drawing

### Preview System

- [ ] Preview provider set on RenderLoop with proper cleanup
- [ ] Preview opacity fixed at 0.35 (CURSOR_PREVIEW_OPACITY)
- [ ] Bounds inflated by stroke width for proper invalidation
- [ ] Old and new regions both invalidated on update

### Data Integrity

- [ ] Simplification runs BEFORE size checks
- [ ] 128KB budget checked AFTER simplification AND after downsample
- [ ] 2MB transport limit checked as final gate
- [ ] Minimum 2 points validated before commit
- [ ] All mutations go through `room.mutate()` wrapper
- [ ] Guards enforced canonically in mutate(), advisory in UI
- [ ] Empty points from simplifyStroke signals budget rejection

## Common Issues and Solutions

### Issue: Drawing doesn't work

1. Check room from registry: `useRoomDocRegistry(roomId)` returns valid room
2. **Check RenderLoop exists**: `renderLoopRef.current` not null
   - **CRITICAL**: RenderLoop must be created in Canvas.tsx's useLayoutEffect BEFORE Phase 5 effect runs
   - The Phase 5 effect includes guard: `if (!renderLoop) return;`
3. Verify tool initialized: `drawingToolRef.current` exists
4. Check canvas element: `stageRef.current?.getCanvasElement()` returns element
5. Verify preview provider set: Check `setPreviewProvider` was called
6. Ensure coordinate transform works: Log world coordinates from `viewTransform.canvasToWorld()`
7. Check ViewTransform hook: `useViewTransform()` returns valid transform

### Issue: Preview not visible

1. Verify preview renders in authoring overlay position (after world content)
2. Check preview opacity is 0.35
3. Ensure bounds properly inflated with stroke width
4. Verify `drawPreview` function is called in RenderLoop
5. Check preview data has all required fields

### Issue: Events not firing

1. Check `toolReady` and `canvasReady` states are true
2. Verify canvas has `touch-action: none` (desktop only)
3. Ensure listeners attached with `{ passive: false }`
4. Check pointer capture is being set (desktop only)
5. Verify coordinate transforms return valid world coordinates
6. Check mobile gate in handlePointerDown
