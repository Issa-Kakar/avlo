# Phase 3.3: Render Loop Foundation Implementation Instructions

## 🎯 OBJECTIVE

Implement a production-ready EVENT-DRIVEN animation frame render loop with dirty-rectangle tracking, frame metrics, and layer pipeline skeleton. This builds upon the completed CanvasStage (3.1) and ViewTransform system (3.2) to create the core rendering engine that only runs frames when there's work to do.

### Critical Coordinate Space Clarification

- **World space**: Document coordinates (strokes, text positions)
- **CSS pixels**: Browser layout units, what view transforms return
- **Device pixels**: CSS pixels × DPR, used for canvas backing store and clearing
- **DPR applied ONCE**: CanvasStage sets initial transform(dpr,0,0,dpr,0,0)
- **View transforms**: Work in CSS pixels only, never include DPR

## 📋 PREREQUISITES VERIFICATION

Before starting, verify these components from Phases 3.1-3.2 are working:

### Phase 3.1 (CanvasStage) ✅

- `/client/src/canvas/CanvasStage.tsx` - DPR-aware canvas with ResizeObserver
- `/client/src/canvas/internal/context2d.ts` - Context configuration helpers
- Canvas properly sizes to container with device pixel ratio handling
- `setTransform(dpr, 0, 0, dpr, 0, 0)` applied once on resize

### Phase 3.2 (ViewTransform) ✅

- `/client/src/canvas/ViewTransformContext.tsx` - React context for pan/zoom state
- `/client/src/canvas/Canvas.tsx` - Integration component with test grid
- `/client/src/canvas/internal/transforms.ts` - Coordinate conversion utilities
- Transform math: `canvas = (world - pan) × scale`
- `screenToWorld()` and `worldToClient()` working correctly

### Current Integration Points

- `Canvas.tsx` already uses `useRoomSnapshot()` hook - returns immutable snapshots
- Grid test rendering proves transforms work
- CanvasStage exposes `withContext()` and `clear()` methods via ref

## 🚀 DELIVERABLES

### 1. Core Files to Create

#### `/client/src/renderer/types.ts`

```typescript
// Frame performance metrics
export interface FrameStats {
  frameCount: number;
  avgMs: number; // Exponential moving average
  fps: number; // Exponential moving average
  overBudgetCount: number;
  skippedCount: number;
  lastClearType: 'full' | 'dirty' | 'none';
  rectCount: number;
}

// Viewport information
export interface ViewportInfo {
  pixelWidth: number; // Device pixels
  pixelHeight: number; // Device pixels
  cssWidth: number; // CSS pixels
  cssHeight: number; // CSS pixels
  dpr: number;
  visibleWorldBounds?: { minX: number; minY: number; maxX: number; maxY: number };
}

// Invalidation types
export type InvalidationReason =
  | 'transform-change'
  | 'dirty-overflow'
  | 'geometry-change'
  | 'content-change';

// Rectangles in different coordinate spaces
export interface DevicePixelRect {
  x: number; // Device pixels (CSS * DPR) - used for canvas clearing operations
  y: number; // Device pixels (CSS * DPR) - used for canvas clearing operations
  width: number; // Device pixels (CSS * DPR) - used for canvas clearing operations
  height: number; // Device pixels (CSS * DPR) - used for canvas clearing operations
}

export interface CSSPixelRect {
  x: number; // CSS pixels (before DPR) - used for API inputs
  y: number; // CSS pixels (before DPR) - used for API inputs
  width: number; // CSS pixels (before DPR) - used for API inputs
  height: number; // CSS pixels (before DPR) - used for API inputs
}

export interface WorldBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

// Thresholds
export const DIRTY_RECT_CONFIG = {
  MAX_RECT_COUNT: 64,
  MAX_AREA_RATIO: 0.33,
  AA_MARGIN: 1, // Antialiasing margin in device pixels
  MAX_WORLD_LINE_WIDTH: 50, // Maximum expected stroke size in world units (from config)
  COALESCE_SNAP: 2, // Grid snap for better merging
} as const;

export const FRAME_CONFIG = {
  TARGET_FPS: 60,
  TARGET_MS: 16.6,
  HIDDEN_FPS: 8,
  MOBILE_FPS: 30,
  SKIP_THRESHOLD_MS: 20, // Skip next frame if previous > 20ms
} as const;
```

#### `/client/src/renderer/DirtyRectTracker.ts`

```typescript
import { DevicePixelRect, WorldBounds, InvalidationReason, DIRTY_RECT_CONFIG } from './types';
import type { ViewTransform } from '@avlo/shared';

export class DirtyRectTracker {
  private rects: DevicePixelRect[] = [];
  private fullClearRequired = false;
  private lastTransform: { scale: number; pan: { x: number; y: number } } | null = null;
  private canvasSize = { width: 0, height: 0 }; // Device pixels
  private dpr = 1; // Store DPR for conversions

  constructor() {}

  // Set canvas dimensions for area ratio calculations (device pixels)
  setCanvasSize(width: number, height: number, dpr = 1): void {
    this.canvasSize = { width, height };
    this.dpr = dpr;
  }

  // Notify of transform change - forces full clear
  notifyTransformChange(newTransform: { scale: number; pan: { x: number; y: number } }): void {
    if (
      !this.lastTransform ||
      this.lastTransform.scale !== newTransform.scale ||
      this.lastTransform.pan.x !== newTransform.pan.x ||
      this.lastTransform.pan.y !== newTransform.pan.y
    ) {
      this.fullClearRequired = true;
      this.rects = [];
      this.lastTransform = { ...newTransform, pan: { ...newTransform.pan } };
    }
  }

  // Add world-space invalidation
  invalidateWorldBounds(bounds: WorldBounds, viewTransform: ViewTransform): void {
    // Use canonical transform helper for consistency
    // CRITICAL: worldToCanvas returns CSS pixels, NOT device pixels
    // Transform: (world - pan) * scale = CSS pixels
    const [minCanvasX, minCanvasY] = viewTransform.worldToCanvas(bounds.minX, bounds.minY);
    const [maxCanvasX, maxCanvasY] = viewTransform.worldToCanvas(bounds.maxX, bounds.maxY);

    // Pass CSS pixel rect to invalidateCanvasPixels (which converts to device pixels internally)
    this.invalidateCanvasPixels(
      {
        x: minCanvasX,
        y: minCanvasY,
        width: maxCanvasX - minCanvasX,
        height: maxCanvasY - minCanvasY,
      },
      viewTransform.scale,
      this.dpr,
    );
  }

  // Add CSS-pixel invalidation (takes CSS pixels, converts to device pixels internally)
  invalidateCanvasPixels(
    rect: { x: number; y: number; width: number; height: number },
    scale = 1,
    dpr = 1,
  ): void {
    if (this.fullClearRequired) return; // Already clearing everything

    // Convert CSS pixels to device pixels for clearing
    const deviceRect = {
      x: rect.x * dpr,
      y: rect.y * dpr,
      width: rect.width * dpr,
      height: rect.height * dpr,
    };

    // Scale-aware stroke margin in device pixels: worst-case is maxLineWidth * scale * dpr
    const strokeMargin = DIRTY_RECT_CONFIG.MAX_WORLD_LINE_WIDTH * scale * dpr;
    const totalMargin = DIRTY_RECT_CONFIG.AA_MARGIN + strokeMargin;

    // Apply margins for AA and stroke expansion (in device pixels)
    const inflated = {
      x: Math.floor(deviceRect.x - totalMargin),
      y: Math.floor(deviceRect.y - totalMargin),
      width: Math.ceil(deviceRect.width + 2 * totalMargin),
      height: Math.ceil(deviceRect.height + 2 * totalMargin),
    };

    // Snap to grid for better coalescing
    inflated.x =
      Math.floor(inflated.x / DIRTY_RECT_CONFIG.COALESCE_SNAP) * DIRTY_RECT_CONFIG.COALESCE_SNAP;
    inflated.y =
      Math.floor(inflated.y / DIRTY_RECT_CONFIG.COALESCE_SNAP) * DIRTY_RECT_CONFIG.COALESCE_SNAP;

    this.rects.push(inflated);
    this.checkPromotion();
  }

  // Force full clear
  invalidateAll(reason: InvalidationReason): void {
    this.fullClearRequired = true;
    this.rects = [];
  }

  // Check if we should promote to full clear
  private checkPromotion(): void {
    if (this.rects.length > DIRTY_RECT_CONFIG.MAX_RECT_COUNT) {
      this.fullClearRequired = true;
      this.rects = [];
      return;
    }

    // Calculate union area ratio
    const union = this.calculateUnion();
    if (union) {
      const unionArea = union.width * union.height;
      const canvasArea = this.canvasSize.width * this.canvasSize.height;
      if (canvasArea > 0 && unionArea / canvasArea > DIRTY_RECT_CONFIG.MAX_AREA_RATIO) {
        this.fullClearRequired = true;
        this.rects = [];
      }
    }
  }

  // Calculate union of all rects
  private calculateUnion(): DevicePixelRect | null {
    if (this.rects.length === 0) return null;

    let minX = Infinity,
      minY = Infinity;
    let maxX = -Infinity,
      maxY = -Infinity;

    for (const rect of this.rects) {
      minX = Math.min(minX, rect.x);
      minY = Math.min(minY, rect.y);
      maxX = Math.max(maxX, rect.x + rect.width);
      maxY = Math.max(maxY, rect.y + rect.height);
    }

    return {
      x: minX,
      y: minY,
      width: maxX - minX,
      height: maxY - minY,
    };
  }

  // Coalesce overlapping/adjacent rectangles
  coalesce(): void {
    if (this.fullClearRequired || this.rects.length <= 1) return;

    // Simple coalescing: merge overlapping rects
    const merged: DevicePixelRect[] = [];
    const used = new Set<number>();

    for (let i = 0; i < this.rects.length; i++) {
      if (used.has(i)) continue;

      let current = { ...this.rects[i] };
      used.add(i);

      // Try to merge with other rects
      let didMerge = true;
      while (didMerge) {
        didMerge = false;
        for (let j = 0; j < this.rects.length; j++) {
          if (used.has(j)) continue;

          const other = this.rects[j];
          if (this.rectsOverlap(current, other)) {
            // Merge
            const minX = Math.min(current.x, other.x);
            const minY = Math.min(current.y, other.y);
            const maxX = Math.max(current.x + current.width, other.x + other.width);
            const maxY = Math.max(current.y + current.height, other.y + other.height);

            current = {
              x: minX,
              y: minY,
              width: maxX - minX,
              height: maxY - minY,
            };

            used.add(j);
            didMerge = true;
          }
        }
      }

      merged.push(current);
    }

    this.rects = merged;
    this.checkPromotion();
  }

  // Check if two rectangles overlap or are adjacent
  private rectsOverlap(a: DevicePixelRect, b: DevicePixelRect): boolean {
    const margin = DIRTY_RECT_CONFIG.COALESCE_SNAP; // Allow adjacent rects to merge
    return !(
      a.x > b.x + b.width + margin ||
      b.x > a.x + a.width + margin ||
      a.y > b.y + b.height + margin ||
      b.y > a.y + a.height + margin
    );
  }

  // Get clear instructions
  getClearInstructions(): { type: 'full' | 'dirty' | 'none'; rects?: DevicePixelRect[] } {
    if (this.fullClearRequired) {
      return { type: 'full' };
    }

    if (this.rects.length === 0) {
      return { type: 'none' };
    }

    return { type: 'dirty', rects: [...this.rects] };
  }

  // Reset after frame
  reset(): void {
    this.rects = [];
    this.fullClearRequired = false;
  }
}
```

#### `/client/src/renderer/RenderLoop.ts`

```typescript
import type { Snapshot, ViewTransform } from '@avlo/shared';
import type { CanvasStageHandle } from '../canvas/CanvasStage';
import { DirtyRectTracker } from './DirtyRectTracker';
import {
  FrameStats,
  ViewportInfo,
  FRAME_CONFIG,
  InvalidationReason,
  WorldBounds,
  DevicePixelRect,
} from './types';
import {
  drawBackground,
  drawStrokes,
  drawShapes,
  drawText,
  drawAuthoringOverlays,
  drawPresenceOverlays,
  drawHUD,
} from './layers';
import { getVisibleWorldBounds } from '../canvas/internal/transforms';

export interface RenderLoopConfig {
  stageRef: React.RefObject<CanvasStageHandle>;
  getView: () => ViewTransform;
  getSnapshot: () => Snapshot;
  getViewport: () => ViewportInfo;
  onStats?: (stats: FrameStats) => void;
  isMobile?: () => boolean; // For mobile FPS throttling
}

export class RenderLoop {
  private config: RenderLoopConfig | null = null;
  private dirtyTracker = new DirtyRectTracker();
  private frameStats: FrameStats = {
    frameCount: 0,
    avgMs: 0,
    fps: 60,
    overBudgetCount: 0,
    skippedCount: 0,
    lastClearType: 'none',
    rectCount: 0,
  };

  private rafId: number | null = null;
  private lastFrameTime = 0;
  private lastView: ViewTransform | null = null;
  private skipNextFrame = false;
  private isHidden = false;
  private hiddenIntervalId: number | null = null; // Browser timer returns number, not NodeJS.Timeout
  private needsFrame = false; // EVENT-DRIVEN: Only schedule when dirty

  constructor() {
    // Listen for visibility changes
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.handleVisibilityChange);
    }
  }

  // Start the render loop
  start(config: RenderLoopConfig): void {
    if (this.config) {
      console.warn('RenderLoop already started');
      return;
    }

    this.config = config;
    this.lastFrameTime = performance.now();

    // Get initial viewport for tracker sizing
    const viewport = config.getViewport();
    this.dirtyTracker.setCanvasSize(viewport.pixelWidth, viewport.pixelHeight, viewport.dpr);

    // EVENT-DRIVEN: Don't schedule frame on start - wait for invalidation
    // Only start hidden loop if already hidden
    if (document.hidden) {
      this.startHiddenLoop();
    }

    // Stats are published opportunistically at the end of rendered frames only
    // This maintains true zero idle CPU - no timers when nothing is dirty
  }

  // Stop the render loop
  stop(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }

    if (this.hiddenIntervalId !== null) {
      clearInterval(this.hiddenIntervalId);
      this.hiddenIntervalId = null;
    }

    this.config = null;
    this.dirtyTracker.reset();
    this.lastView = null;
    this.needsFrame = false;
  }

  // Handle visibility change
  private handleVisibilityChange = (): void => {
    this.isHidden = document.hidden;

    if (this.isHidden) {
      // Switch to low FPS timer if we have pending work
      if (this.rafId !== null) {
        cancelAnimationFrame(this.rafId);
        this.rafId = null;
      }
      if (this.needsFrame) {
        this.startHiddenLoop();
      }
    } else {
      // Switch back to rAF if we have pending work
      if (this.hiddenIntervalId !== null) {
        clearInterval(this.hiddenIntervalId);
        this.hiddenIntervalId = null;
      }
      if (this.needsFrame) {
        this.scheduleFrameIfNeeded();
      }
    }
  };

  // Low FPS loop for hidden tabs
  private startHiddenLoop(): void {
    if (this.hiddenIntervalId || !this.config) return;

    const intervalMs = 1000 / FRAME_CONFIG.HIDDEN_FPS;
    this.hiddenIntervalId = window.setInterval(() => {
      if (this.needsFrame) {
        this.tick();
      }
    }, intervalMs);
  }

  // EVENT-DRIVEN: Schedule frame only when needed
  private scheduleFrameIfNeeded(): void {
    if (!this.config || this.isHidden || this.rafId !== null) return;

    // Check if we should throttle FPS on mobile
    const targetFPS = this.config.isMobile?.() ? FRAME_CONFIG.MOBILE_FPS : FRAME_CONFIG.TARGET_FPS;
    const targetMs = 1000 / targetFPS;

    // NEVER throttle the first frame after invalidation for instant response
    // Only throttle subsequent frames while still dirty
    const now = performance.now();
    const elapsed = now - this.lastFrameTime;
    const isFirstFrameAfterInvalidation =
      this.frameStats.frameCount === 0 || this.dirtyTracker.getClearInstructions().type !== 'none';

    if (!isFirstFrameAfterInvalidation && elapsed < targetMs) {
      // Schedule for the remaining time (only for subsequent frames)
      window.setTimeout(() => this.scheduleFrameIfNeeded(), targetMs - elapsed);
      return;
    }

    this.rafId = requestAnimationFrame(() => {
      this.rafId = null;
      this.tick();
      // Only schedule next frame if still dirty after this frame
      if (this.needsFrame) {
        this.scheduleFrameIfNeeded();
      }
    });
  }

  // Main render tick
  private tick(): void {
    if (!this.config) return;

    const startTime = performance.now();
    this.lastFrameTime = startTime;
    const { stageRef, getView, getSnapshot, getViewport } = this.config;

    // Clear the needsFrame flag - will be set again if new work arrives
    this.needsFrame = false;

    // Skip frame if previous was over budget
    if (this.skipNextFrame) {
      this.skipNextFrame = false;
      this.frameStats.skippedCount++;
      return;
    }

    // Get current state
    const stage = stageRef.current;
    if (!stage) return;

    const view = getView();
    const snapshot = getSnapshot();
    const viewport = getViewport();

    // Update dirty tracker canvas size if changed
    this.dirtyTracker.setCanvasSize(viewport.pixelWidth, viewport.pixelHeight, viewport.dpr);

    // Check for transform change
    if (this.lastView) {
      this.dirtyTracker.notifyTransformChange(view);
    }
    this.lastView = view;

    // Coalesce dirty rectangles
    this.dirtyTracker.coalesce();
    const clearInstructions = this.dirtyTracker.getClearInstructions();

    // Early exit if nothing to do
    if (clearInstructions.type === 'none' && this.frameStats.frameCount > 0) {
      this.frameStats.lastClearType = 'none';
      this.frameStats.rectCount = 0; // Reset rect count on no-op
      return;
    }

    // Clear pass (identity transform)
    stage.withContext((ctx) => {
      // Save current transform
      ctx.save();

      // Reset to identity for clearing (DPR already applied by CanvasStage)
      ctx.setTransform(1, 0, 0, 1, 0, 0);

      if (clearInstructions.type === 'full') {
        // Full clear
        ctx.clearRect(0, 0, viewport.pixelWidth, viewport.pixelHeight);
        this.frameStats.lastClearType = 'full';
        this.frameStats.rectCount = 0; // Reset rect count on full clear
      } else if (clearInstructions.type === 'dirty' && clearInstructions.rects) {
        // Dirty rectangle clears
        for (const rect of clearInstructions.rects) {
          ctx.clearRect(rect.x, rect.y, rect.width, rect.height);
        }
        this.frameStats.lastClearType = 'dirty';
        this.frameStats.rectCount = clearInstructions.rects.length;
      }

      // Restore transform
      ctx.restore();
    });

    // Draw pass (world transform)
    stage.withContext((ctx) => {
      // Apply world transform: scale first, then translate
      ctx.scale(view.scale, view.scale);
      ctx.translate(-view.pan.x, -view.pan.y);

      // Calculate visible world bounds for culling
      // IMPORTANT: getVisibleWorldBounds expects CSS pixels for viewport dimensions
      // The transform math (world - pan) * scale operates in CSS coordinate space
      const visibleBounds = getVisibleWorldBounds(
        viewport.cssWidth, // CSS pixels (not device pixels)
        viewport.cssHeight, // CSS pixels (not device pixels)
        view.scale,
        view.pan,
      );

      const augmentedViewport = {
        ...viewport,
        visibleWorldBounds: visibleBounds,
      };

      // Draw layers in canonical order
      // LINE WIDTH POLICY:
      // - World content (strokes): ctx.lineWidth = style.size (world units)
      // - Hairlines/HUD: ctx.lineWidth = 1 / view.scale (targets ~1 CSS pixel, becomes DPR device pixels)
      // DPR is already applied by CanvasStage via initial setTransform(dpr, 0, 0, dpr, 0, 0)

      drawBackground(ctx, snapshot, view, augmentedViewport);
      drawStrokes(ctx, snapshot, view, augmentedViewport); // Phase 4: actual stroke rendering
      drawShapes(ctx, snapshot, view, augmentedViewport); // Future: stamps/shapes
      drawText(ctx, snapshot, view, augmentedViewport); // Phase 11: text blocks
      drawAuthoringOverlays(ctx, snapshot, view, augmentedViewport); // Future: selection/handles
      drawPresenceOverlays(ctx, snapshot, view, augmentedViewport); // Phase 8: cursors (with gates)
      drawHUD(ctx, snapshot, view, augmentedViewport); // Future: minimap, toasts (never exported)
    });

    // Reset dirty tracker for next frame
    this.dirtyTracker.reset();

    // Update frame stats
    const frameDuration = performance.now() - startTime;
    this.updateStats(frameDuration);

    // Check if we should skip next frame
    if (frameDuration > FRAME_CONFIG.SKIP_THRESHOLD_MS) {
      this.skipNextFrame = true;
    }

    // Notify stats listener
    if (this.config.onStats) {
      this.config.onStats(this.frameStats);
    }
  }

  // Update frame statistics
  private updateStats(frameDuration: number): void {
    this.frameStats.frameCount++;

    // Exponential moving average
    const alpha = 0.1;
    this.frameStats.avgMs = this.frameStats.avgMs * (1 - alpha) + frameDuration * alpha;

    // Calculate FPS
    if (this.frameStats.avgMs > 0) {
      this.frameStats.fps = 1000 / this.frameStats.avgMs;
    }

    // Track budget overruns
    if (frameDuration > FRAME_CONFIG.TARGET_MS) {
      this.frameStats.overBudgetCount++;
    }
  }

  // Public invalidation APIs - EVENT-DRIVEN: These trigger frame scheduling
  invalidateWorld(bounds: WorldBounds): void {
    if (!this.config) return;
    const view = this.config.getView();
    this.dirtyTracker.invalidateWorldBounds(bounds, view);
    this.markDirty();
  }

  invalidateCanvas(rect: CSSPixelRect): void {
    if (!this.config) return;
    const view = this.config.getView();
    const viewport = this.config.getViewport();
    // Pass CSS pixel rect - dirtyTracker converts to device pixels internally
    this.dirtyTracker.invalidateCanvasPixels(rect, view.scale, viewport.dpr);
    this.markDirty();
  }

  invalidateAll(reason: InvalidationReason): void {
    this.dirtyTracker.invalidateAll(reason);
    this.markDirty();
  }

  setResizeInfo(info: { width: number; height: number; dpr: number }): void {
    // Resize always triggers full clear (width/height are device pixels)
    this.dirtyTracker.setCanvasSize(info.width, info.height, info.dpr);
    this.dirtyTracker.invalidateAll('geometry-change');
    this.markDirty();
  }

  // EVENT-DRIVEN: Mark dirty and schedule frame if needed
  private markDirty(): void {
    if (!this.needsFrame) {
      this.needsFrame = true;
      this.scheduleFrameIfNeeded();
    }
  }

  // Cleanup
  destroy(): void {
    this.stop();
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.handleVisibilityChange);
    }
  }
}
```

#### `/client/src/renderer/layers/index.ts`

```typescript
import type { Snapshot, ViewTransform } from '@avlo/shared';
import type { ViewportInfo } from '../types';

// Layer function signatures - all are stubs in Phase 3.3

export function drawBackground(
  ctx: CanvasRenderingContext2D,
  snapshot: Snapshot,
  view: ViewTransform,
  viewport: ViewportInfo,
): void {
  // Phase 3.3: Stub only
  if (process.env.NODE_ENV === 'development' && process.env.DEBUG_RENDER_LAYERS) {
    console.log('[Layer] Background');
  }
}

export function drawStrokes(
  ctx: CanvasRenderingContext2D,
  snapshot: Snapshot,
  view: ViewTransform,
  viewport: ViewportInfo,
): void {
  // Phase 4: Will implement actual stroke rendering
  if (process.env.NODE_ENV === 'development' && process.env.DEBUG_RENDER_LAYERS) {
    console.log('[Layer] Strokes', snapshot.strokes.length);
  }
}

export function drawShapes(
  ctx: CanvasRenderingContext2D,
  snapshot: Snapshot,
  view: ViewTransform,
  viewport: ViewportInfo,
): void {
  // Future phase: Stamps and shapes
  if (process.env.NODE_ENV === 'development' && process.env.DEBUG_RENDER_LAYERS) {
    console.log('[Layer] Shapes');
  }
}

export function drawText(
  ctx: CanvasRenderingContext2D,
  snapshot: Snapshot,
  view: ViewTransform,
  viewport: ViewportInfo,
): void {
  // Phase 11: Text rendering
  if (process.env.NODE_ENV === 'development' && process.env.DEBUG_RENDER_LAYERS) {
    console.log('[Layer] Text', snapshot.texts.length);
  }
}

export function drawAuthoringOverlays(
  ctx: CanvasRenderingContext2D,
  snapshot: Snapshot,
  view: ViewTransform,
  viewport: ViewportInfo,
): void {
  // Future: Selection boxes, handles, text cursor
  if (process.env.NODE_ENV === 'development' && process.env.DEBUG_RENDER_LAYERS) {
    console.log('[Layer] Authoring Overlays');
  }
}

export function drawPresenceOverlays(
  ctx: CanvasRenderingContext2D,
  snapshot: Snapshot,
  view: ViewTransform,
  viewport: ViewportInfo,
): void {
  // Phase 8: Cursors and trails
  // CRITICAL GATE CHECK: Only render when BOTH gates are open
  // - G_AWARENESS_READY: Ensures awareness channel is live (WS or RTC)
  // - G_FIRST_SNAPSHOT: Ensures we have valid doc data to render against
  // Without both, show "Presence degraded" indicator but NO cursors

  if (process.env.NODE_ENV === 'development' && process.env.DEBUG_RENDER_LAYERS) {
    console.log('[Layer] Presence Overlays');
  }

  // TODO Phase 8: Implement gate checks
  // const gateManager = /* get gate manager instance */;
  // if (!gateManager.isOpen('G_AWARENESS_READY') || !gateManager.isOpen('G_FIRST_SNAPSHOT')) {
  //   return; // Skip rendering cursors
  // }
}

export function drawHUD(
  ctx: CanvasRenderingContext2D,
  snapshot: Snapshot,
  view: ViewTransform,
  viewport: ViewportInfo,
): void {
  // Future: Minimap, toasts, update prompts
  // Note: Never included in export
  if (process.env.NODE_ENV === 'development' && process.env.DEBUG_RENDER_LAYERS) {
    console.log('[Layer] HUD');
  }
}
```

### 2. Update Existing Files

#### `/client/src/canvas/Canvas.tsx` - Integrate RenderLoop

```typescript
// ADD these imports at the top
import { RenderLoop } from '../renderer/RenderLoop';
import type { ViewportInfo } from '../renderer/types';
import { createEmptySnapshot } from '@avlo/shared';
import { useRoomDoc } from '../hooks/use-room-doc'; // Already exists from Phase 2

// ADD at top of Canvas component (with other hooks):
const roomDoc = useRoomDoc(roomId); // MUST be called at top level, not inside useEffect
const renderLoopRef = useRef<RenderLoop | null>(null);

// PERFORMANCE OPTIMIZATION: Store in ref to avoid React re-renders
// We use the public subscription API (same as useRoomSnapshot hook) but store the result in a ref
// instead of state to prevent React render storms at 60+ FPS. This maintains the architectural
// boundary - we're still consuming immutable snapshots through the public API, just optimizing
// how we store them to avoid unnecessary React work.
const snapshotRef = useRef<Snapshot>(createEmptySnapshot()); // Initialize with empty snapshot
const viewTransformRef = useRef<ViewTransform>(viewTransform); // Store latest transform

// Keep view transform ref updated (no re-render)
useEffect(() => {
  viewTransformRef.current = viewTransform;
}, [viewTransform]);

// Subscribe to snapshots via public API (stores in ref to avoid re-renders)
useEffect(() => {
  // Subscribe through public API and write to ref (not state)
  const unsubscribe = roomDoc.subscribeSnapshot((newSnapshot) => {
    const prevSvKey = snapshotRef.current.svKey;

    // IMPORTANT: DO NOT modify the snapshot - it must remain immutable
    // Phase 3 contract: snapshot.view remains identity transform - read view from UI instead
    snapshotRef.current = newSnapshot;

    // Invalidate render loop if content changed
    if (renderLoopRef.current && newSnapshot.svKey !== prevSvKey) {
      renderLoopRef.current.invalidateAll('content-change');
    }
  });

  // Set initial snapshot
  snapshotRef.current = roomDoc.currentSnapshot;

  return unsubscribe;
}, [roomDoc]); // Depend on roomDoc from hook

// Helper to detect mobile (Phase 3.3 FPS throttling)
const isMobile = useCallback(() => {
  return (
    /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) ||
    window.matchMedia?.('(max-width: 768px)').matches ||
    window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  );
}, []);

// ADD render loop initialization (stable, doesn't restart on transform changes)
useEffect(() => {
  if (!stageRef.current) return;

  const renderLoop = new RenderLoop();
  renderLoopRef.current = renderLoop;

  renderLoop.start({
    stageRef,
    getView: () => viewTransformRef.current, // Read from UI state ref, NOT from snapshot.view
    getSnapshot: () => snapshotRef.current, // snapshot.view remains identity in Phase 3
    getViewport: (): ViewportInfo => {
      const bounds = stageRef.current?.getBounds();
      if (!bounds) {
        return {
          pixelWidth: 0,
          pixelHeight: 0,
          cssWidth: 0,
          cssHeight: 0,
          dpr: window.devicePixelRatio || 1,
        };
      }
      return {
        pixelWidth: bounds.width * (window.devicePixelRatio || 1),
        pixelHeight: bounds.height * (window.devicePixelRatio || 1),
        cssWidth: bounds.width,
        cssHeight: bounds.height,
        dpr: window.devicePixelRatio || 1,
      };
    },
    isMobile, // For FPS throttling
    onStats:
      process.env.NODE_ENV === 'development'
        ? (stats) => {
            // Log frame stats in dev (every 60 frames)
            if (stats.frameCount % 60 === 0) {
              console.log('[RenderLoop Stats]', {
                fps: stats.fps.toFixed(1),
                avgMs: stats.avgMs.toFixed(2),
                overBudget: stats.overBudgetCount,
                skipped: stats.skippedCount,
                lastClear: stats.lastClearType,
              });
            }
          }
        : undefined,
  });

  // Trigger initial render ONLY if we have content
  if (snapshotRef.current.svKey !== createEmptySnapshot().svKey) {
    renderLoop.invalidateAll('content-change');
  }

  return () => {
    renderLoop.stop();
    renderLoop.destroy();
    renderLoopRef.current = null;
  };
}, []); // NO DEPENDENCIES - stable render loop lifecycle

// ADD resize handler
const handleResize = useCallback((info: ResizeInfo) => {
  setCanvasSize(info); // Your existing logic

  // Notify render loop
  renderLoopRef.current?.setResizeInfo({
    width: info.pixelWidth,
    height: info.pixelHeight,
    dpr: info.dpr,
  });
}, []);

// ADD transform change detection (separate from lifecycle)
useEffect(() => {
  // Trigger a frame when transform changes
  // The DirtyRectTracker.notifyTransformChange() in tick() will detect the change
  // and automatically promote to full clear - we just need to trigger the frame
  renderLoopRef.current?.invalidateCanvas({ x: 0, y: 0, width: 1, height: 1 });
}, [viewTransform.scale, viewTransform.pan.x, viewTransform.pan.y]);

// UPDATE the CanvasStage props
// <CanvasStage ref={stageRef} className={className} onResize={handleResize} />

// REMOVE the test grid rendering code from Phase 3.2 (lines 66-105 in current Canvas.tsx)
```

### 3. Testing Files to Create

#### `/client/src/renderer/__tests__/test-helpers.ts` - SnapshotSource Abstraction

```typescript
import { vi } from 'vitest';
import type { Snapshot, PresenceView, ViewTransform } from '@avlo/shared';
import { createEmptySnapshot } from '@avlo/shared';

/**
 * SnapshotSource abstraction for testing render loop without real RDM
 * This allows Phase 3.3 tests to be independent of the registry/RDM complexity
 * Real integration testing happens in Phase 5
 */
export interface SnapshotSource {
  subscribeSnapshot(cb: (snap: Snapshot) => void): () => void;
  getLatestSnapshot(): Snapshot;
}

/**
 * Test implementation of SnapshotSource
 */
export class TestSnapshotSource implements SnapshotSource {
  private snapshot: Snapshot = createEmptySnapshot();
  private subscribers = new Set<(snap: Snapshot) => void>();

  subscribeSnapshot(cb: (snap: Snapshot) => void): () => void {
    this.subscribers.add(cb);
    return () => this.subscribers.delete(cb);
  }

  getLatestSnapshot(): Snapshot {
    return this.snapshot;
  }

  // Test method to emit a new snapshot
  emit(snapshot: Snapshot): void {
    this.snapshot = snapshot;
    this.subscribers.forEach((cb) => cb(snapshot));
  }

  // Test method to update just the content (changes svKey)
  updateContent(strokes: any[] = [], texts: any[] = []): void {
    const newSnapshot: Snapshot = {
      ...this.snapshot,
      strokes,
      texts,
      svKey: Math.random().toString(36), // Generate new svKey to simulate content change
    };
    this.emit(newSnapshot);
  }

  // Test method to update just the presence (doesn't change svKey)
  updatePresence(presence: PresenceView): void {
    const newSnapshot: Snapshot = {
      ...this.snapshot,
      presence,
    };
    this.emit(newSnapshot);
  }

  // Note: ViewTransform is passed separately in Phase 3, not through snapshot.view
}

/**
 * Test scheduler for deterministic frame control
 */
export class TestFrameScheduler {
  private callbacks: Array<() => void> = [];
  private nextId = 1;

  requestAnimationFrame(callback: () => void): number {
    const id = this.nextId++;
    this.callbacks.push(callback);
    return id;
  }

  cancelAnimationFrame(_id: number): void {
    // In real implementation, remove callback by id
    // For simplicity, we'll clear on tick
  }

  tick(): void {
    const cbs = [...this.callbacks];
    this.callbacks = [];
    cbs.forEach((cb) => cb());
  }

  tickMultiple(count: number): void {
    for (let i = 0; i < count; i++) {
      this.tick();
    }
  }
}

/**
 * Mock Canvas Context for render testing
 */
export function createMockContext(): CanvasRenderingContext2D {
  return {
    save: vi.fn(),
    restore: vi.fn(),
    scale: vi.fn(),
    translate: vi.fn(),
    setTransform: vi.fn(),
    clearRect: vi.fn(),
    fillRect: vi.fn(),
    strokeRect: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    fill: vi.fn(),
    canvas: {
      width: 800,
      height: 600,
    } as HTMLCanvasElement,
  } as any;
}

/**
 * Mock CanvasStageHandle for testing
 */
export function createMockStage(ctx: CanvasRenderingContext2D): any {
  return {
    withContext: vi.fn((callback) => callback(ctx)),
    clear: vi.fn(),
    getBounds: vi.fn(() => ({ width: 800, height: 600, x: 0, y: 0 })),
  };
}
```

#### `/client/src/renderer/__tests__/DirtyRectTracker.test.ts`

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { DirtyRectTracker } from '../DirtyRectTracker';
import { DIRTY_RECT_CONFIG } from '../types';

describe('DirtyRectTracker', () => {
  let tracker: DirtyRectTracker;

  beforeEach(() => {
    tracker = new DirtyRectTracker();
    tracker.setCanvasSize(800, 600);
  });

  describe('coalescing', () => {
    it('should merge overlapping rectangles', () => {
      tracker.invalidateCanvasPixels({ x: 0, y: 0, width: 100, height: 100 });
      tracker.invalidateCanvasPixels({ x: 50, y: 50, width: 100, height: 100 });
      tracker.coalesce();

      const instructions = tracker.getClearInstructions();
      expect(instructions.type).toBe('dirty');
      expect(instructions.rects).toHaveLength(1);

      // Should be union of both rects plus margins
      const rect = instructions.rects![0];
      const margin = DIRTY_RECT_CONFIG.AA_MARGIN + DIRTY_RECT_CONFIG.MAX_WORLD_LINE_WIDTH; // scale=1 in test
      expect(rect.width).toBeGreaterThanOrEqual(150);
    });

    it('should apply AA margin to all rectangles', () => {
      tracker.invalidateCanvasPixels({ x: 100, y: 100, width: 50, height: 50 });

      const instructions = tracker.getClearInstructions();
      expect(instructions.type).toBe('dirty');
      expect(instructions.rects).toHaveLength(1);

      const rect = instructions.rects![0];
      const totalMargin = DIRTY_RECT_CONFIG.AA_MARGIN + DIRTY_RECT_CONFIG.MAX_WORLD_LINE_WIDTH; // scale=1 in test
      expect(rect.x).toBeLessThanOrEqual(100 - totalMargin);
      expect(rect.y).toBeLessThanOrEqual(100 - totalMargin);
      expect(rect.width).toBeGreaterThanOrEqual(50 + 2 * totalMargin);
      expect(rect.height).toBeGreaterThanOrEqual(50 + 2 * totalMargin);
    });
  });

  describe('promotion rules', () => {
    it('should promote to full clear when rect count exceeds threshold', () => {
      for (let i = 0; i < DIRTY_RECT_CONFIG.MAX_RECT_COUNT + 1; i++) {
        tracker.invalidateCanvasPixels({
          x: i * 10,
          y: i * 10,
          width: 5,
          height: 5,
        });
      }

      const instructions = tracker.getClearInstructions();
      expect(instructions.type).toBe('full');
    });

    it('should promote to full clear when area ratio exceeds threshold', () => {
      // Create a large rectangle covering > 33% of canvas
      const largeWidth = 800 * 0.6;
      const largeHeight = 600 * 0.6;
      tracker.invalidateCanvasPixels({
        x: 0,
        y: 0,
        width: largeWidth,
        height: largeHeight,
      });

      const instructions = tracker.getClearInstructions();
      expect(instructions.type).toBe('full');
    });
  });

  describe('transform changes', () => {
    it('should force full clear on transform change', () => {
      const transform1 = { scale: 1, pan: { x: 0, y: 0 } };
      const transform2 = { scale: 2, pan: { x: 0, y: 0 } };

      tracker.notifyTransformChange(transform1);
      tracker.invalidateCanvasPixels({ x: 0, y: 0, width: 100, height: 100 });

      let instructions = tracker.getClearInstructions();
      expect(instructions.type).toBe('dirty');

      tracker.reset();
      tracker.notifyTransformChange(transform2);

      instructions = tracker.getClearInstructions();
      expect(instructions.type).toBe('full');
    });

    it('should clear queued rects on transform change', () => {
      tracker.invalidateCanvasPixels({ x: 0, y: 0, width: 100, height: 100 });
      tracker.notifyTransformChange({ scale: 2, pan: { x: 10, y: 10 } });

      const instructions = tracker.getClearInstructions();
      expect(instructions.type).toBe('full');
      expect(instructions.rects).toBeUndefined();
    });
  });

  describe('world to canvas conversion', () => {
    it('should correctly convert world bounds to canvas pixels', () => {
      const viewTransform = { scale: 2, pan: { x: 10, y: 20 } };
      const worldBounds = { minX: 50, minY: 60, maxX: 100, maxY: 110 };

      tracker.invalidateWorldBounds(worldBounds, viewTransform);

      const instructions = tracker.getClearInstructions();
      expect(instructions.type).toBe('dirty');
      expect(instructions.rects).toHaveLength(1);

      // Verify conversion math: canvas = (world - pan) * scale
      // minX: (50 - 10) * 2 = 80
      // minY: (60 - 20) * 2 = 80
      const rect = instructions.rects![0];
      const margin =
        DIRTY_RECT_CONFIG.AA_MARGIN + DIRTY_RECT_CONFIG.MAX_WORLD_LINE_WIDTH * viewTransform.scale;
      expect(rect.x).toBeCloseTo(80 - margin, 0);
      expect(rect.y).toBeCloseTo(80 - margin, 0);
    });
  });
});
```

#### `/client/src/renderer/__tests__/RenderLoop.test.ts`

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RenderLoop } from '../RenderLoop';
import type { ViewTransform } from '@avlo/shared';
import { createEmptySnapshot } from '@avlo/shared';
import {
  TestSnapshotSource,
  TestFrameScheduler,
  createMockContext,
  createMockStage,
} from './test-helpers';

describe('RenderLoop', () => {
  let renderLoop: RenderLoop;
  let snapshotSource: TestSnapshotSource;
  let frameScheduler: TestFrameScheduler;
  let mockCtx: CanvasRenderingContext2D;
  let mockStage: any;
  let currentView: ViewTransform;

  beforeEach(() => {
    // Use fake timers for deterministic testing
    vi.useFakeTimers();

    // Setup test dependencies
    snapshotSource = new TestSnapshotSource();
    frameScheduler = new TestFrameScheduler();
    mockCtx = createMockContext();
    mockStage = createMockStage(mockCtx);
    // ViewTransform is passed separately from UI state, not from snapshot.view in Phase 3
    currentView = {
      scale: 1,
      pan: { x: 0, y: 0 },
      worldToCanvas: vi.fn(),
      canvasToWorld: vi.fn(),
    } as any;

    // Mock requestAnimationFrame with our test scheduler
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) =>
      frameScheduler.requestAnimationFrame(cb),
    );
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) =>
      frameScheduler.cancelAnimationFrame(id),
    );

    renderLoop = new RenderLoop();
  });

  afterEach(() => {
    renderLoop.destroy();
    vi.clearAllTimers();
    vi.restoreAllMocks();
  });

  describe('event-driven behavior', () => {
    it('should NOT schedule frames when idle (no invalidation)', () => {
      const config = {
        stageRef: { current: mockStage },
        getView: () => currentView,
        getSnapshot: () => snapshotSource.getLatestSnapshot(),
        getViewport: () => ({
          pixelWidth: 800,
          pixelHeight: 600,
          cssWidth: 800,
          cssHeight: 600,
          dpr: 1,
        }),
      };

      renderLoop.start(config);

      // Advance multiple ticks without invalidation
      frameScheduler.tickMultiple(5);

      // Should NOT have called any render methods
      expect(mockCtx.clearRect).not.toHaveBeenCalled();
      expect(mockCtx.scale).not.toHaveBeenCalled();
    });

    it('should schedule exactly one frame per invalidation', () => {
      const config = {
        stageRef: { current: mockStage },
        getView: () => currentView,
        getSnapshot: () => snapshotSource.getLatestSnapshot(),
        getViewport: () => ({
          pixelWidth: 800,
          pixelHeight: 600,
          cssWidth: 800,
          cssHeight: 600,
          dpr: 1,
        }),
      };

      renderLoop.start(config);

      // Invalidate once
      renderLoop.invalidateAll('content-change');

      // Process the scheduled frame
      frameScheduler.tick();

      // Should have rendered exactly once
      expect(mockCtx.clearRect).toHaveBeenCalledTimes(1);

      // Advance more ticks - should not render again
      frameScheduler.tickMultiple(3);
      expect(mockCtx.clearRect).toHaveBeenCalledTimes(1);
    });

    it('should coalesce multiple invalidations into one frame', () => {
      const config = {
        stageRef: { current: mockStage },
        getView: () => currentView,
        getSnapshot: () => snapshotSource.getLatestSnapshot(),
        getViewport: () => ({
          pixelWidth: 800,
          pixelHeight: 600,
          cssWidth: 800,
          cssHeight: 600,
          dpr: 1,
        }),
      };

      renderLoop.start(config);

      // Multiple invalidations before frame
      renderLoop.invalidateAll('content-change');
      renderLoop.invalidateCanvas({ x: 10, y: 10, width: 50, height: 50 });
      renderLoop.invalidateWorld({ minX: 0, minY: 0, maxX: 100, maxY: 100 });

      // Process the scheduled frame
      frameScheduler.tick();

      // Should have rendered exactly once despite 3 invalidations
      expect(mockCtx.clearRect).toHaveBeenCalledTimes(1);
    });
  });

  describe('transform changes', () => {
    it('should trigger full clear when scale changes', () => {
      // ViewTransform comes from UI state, not snapshot
      let currentView = { scale: 1, pan: { x: 0, y: 0 } };

      const config = {
        stageRef: { current: mockStage },
        getView: () => currentView as ViewTransform, // UI state, not snapshot.view
        getSnapshot: () => createEmptySnapshot(), // snapshot.view remains identity
        getViewport: () => ({
          pixelWidth: 800,
          pixelHeight: 600,
          cssWidth: 800,
          cssHeight: 600,
          dpr: 1,
        }),
      };

      renderLoop.start(config);

      // First frame with initial transform
      renderLoop.invalidateCanvas({ x: 10, y: 10, width: 50, height: 50 });
      frameScheduler.tick();

      // Change transform
      currentView = { scale: 2, pan: { x: 0, y: 0 } };
      renderLoop.invalidateCanvas({ x: 100, y: 100, width: 50, height: 50 });
      frameScheduler.tick();

      // Should have done a full clear (entire canvas)
      expect(mockCtx.clearRect).toHaveBeenCalledWith(0, 0, 800, 600);
    });

    it('should trigger full clear when pan changes', () => {
      let currentView = { scale: 1, pan: { x: 0, y: 0 } };

      const config = {
        stageRef: { current: mockStage },
        getView: () => currentView as ViewTransform,
        getSnapshot: () => createEmptySnapshot(),
        getViewport: () => ({
          pixelWidth: 800,
          pixelHeight: 600,
          cssWidth: 800,
          cssHeight: 600,
          dpr: 1,
        }),
      };

      renderLoop.start(config);

      // First frame
      renderLoop.invalidateCanvas({ x: 10, y: 10, width: 50, height: 50 });
      frameScheduler.tick();

      // Change pan
      currentView = { scale: 1, pan: { x: 100, y: 50 } };
      renderLoop.invalidateCanvas({ x: 20, y: 20, width: 50, height: 50 });
      frameScheduler.tick();

      // Should trigger full clear
      expect(mockCtx.clearRect).toHaveBeenCalledWith(0, 0, 800, 600);
    });
  });

  describe('no-op optimization', () => {
    it('should not render when no dirty rects and transform unchanged', () => {
      const config = {
        stageRef: { current: mockStage },
        getView: () => ({ scale: 1, pan: { x: 0, y: 0 } }) as ViewTransform,
        getSnapshot: () => createEmptySnapshot(),
        getViewport: () => ({
          pixelWidth: 800,
          pixelHeight: 600,
          cssWidth: 800,
          cssHeight: 600,
          dpr: 1,
        }),
      };

      renderLoop.start(config);

      // First frame to establish baseline
      renderLoop.invalidateAll('content-change');
      frameScheduler.tick();
      const initialClearCount = mockCtx.clearRect.mock.calls.length;

      // Try to tick again with no new invalidations
      frameScheduler.tick();

      // Should not have called clear again
      expect(mockCtx.clearRect.mock.calls.length).toBe(initialClearCount);
    });
  });

  describe('world transform order', () => {
    it('should apply scale before translate', () => {
      const config = {
        stageRef: { current: mockStage },
        getView: () => ({ scale: 2, pan: { x: 10, y: 20 } }) as ViewTransform,
        getSnapshot: () => createEmptySnapshot(),
        getViewport: () => ({
          pixelWidth: 800,
          pixelHeight: 600,
          cssWidth: 800,
          cssHeight: 600,
          dpr: 1,
        }),
      };

      renderLoop.start(config);
      renderLoop.invalidateAll('content-change');
      frameScheduler.tick();

      // Verify transform order
      const scaleCalls = mockCtx.scale.mock.calls;
      const translateCalls = mockCtx.translate.mock.calls;

      expect(scaleCalls.length).toBeGreaterThan(0);
      expect(translateCalls.length).toBeGreaterThan(0);

      // Scale should be called with (2, 2)
      expect(scaleCalls[0]).toEqual([2, 2]);

      // Translate should be called with negative pan
      expect(translateCalls[0]).toEqual([-10, -20]);
    });
  });

  describe('identity clear transform', () => {
    it('should use identity transform for clearing', () => {
      const config = {
        stageRef: { current: mockStage },
        getView: () => ({ scale: 2, pan: { x: 100, y: 100 } }) as ViewTransform,
        getSnapshot: () => createEmptySnapshot(),
        getViewport: () => ({
          pixelWidth: 800,
          pixelHeight: 600,
          cssWidth: 800,
          cssHeight: 600,
          dpr: 1,
        }),
      };

      renderLoop.start(config);
      renderLoop.invalidateAll('content-change');
      frameScheduler.tick();

      // Should set identity transform before clear
      expect(mockCtx.setTransform).toHaveBeenCalledWith(1, 0, 0, 1, 0, 0);
      expect(mockCtx.clearRect).toHaveBeenCalled();
    });
  });
});
```

## 🔧 IMPLEMENTATION STEPS

### Step 1: Create Type Definitions

1. Create `/client/src/renderer/types.ts` with all interfaces and constants
2. Export frame/viewport types for use by other modules
3. Ensure types align with existing `@avlo/shared` types

### Step 2: Implement DirtyRectTracker

1. Create `/client/src/renderer/DirtyRectTracker.ts`
2. Implement rect storage, coalescing, and promotion logic
3. Handle world-to-canvas conversion using ViewTransform math
4. Apply AA margin and stroke expansion margins
5. Write focused, targeted and pragmatic unit tests

### Step 3: Create Layer Stubs

1. Create `/client/src/renderer/layers/index.ts`
2. Export all layer functions with empty implementations
3. Add debug logging behind environment flag
4. Document which phase will implement each layer

### Step 4: Implement RenderLoop

1. Create `/client/src/renderer/RenderLoop.ts`
2. Implement rAF scheduling and hidden tab degradation
3. Add frame timing and skip logic
4. Wire up dirty tracker and clear/draw passes
5. Ensure proper transform application order

### Step 5: Integrate with Canvas Component

1. Update `/client/src/canvas/Canvas.tsx`
2. Create RenderLoop instance on mount
3. Store snapshot in ref (not state) to avoid re-renders
4. Wire resize and snapshot change invalidations
5. Remove test grid code from Phase 3.2

### Step 6: Write Tests

1. Unit tests for DirtyRectTracker coalescing/promotion
2. Integration tests for RenderLoop orchestration
3. Verify transform policies and clear behavior
4. Test frame skipping and no-op optimization

## ⚠️ CRITICAL RULES TO FOLLOW

### Event-Driven Architecture (NEW - MUST FOLLOW)

1. **NO continuous rAF loop** - Only schedule frames when invalidated
2. **Idle = zero CPU** - No frames, no timers, no checks when nothing is dirty
3. **Coalesce invalidations** - Multiple invalidations before frame = one render
4. **Schedule via markDirty()** - All invalidation APIs must call this

### Phase 3 Contract (IMPORTANT)

1. **Snapshot.view remains identity transform** - Do not read view from snapshot in Phase 3
2. **Read ViewTransform from UI state** - Pass separately to render loop, not from snapshot
3. **Never mutate snapshots** - They are immutable; store in ref to avoid React re-renders

### Transform Policies

1. **DPR is applied ONCE by CanvasStage** - Never multiply DPR in view transforms
2. **View transforms work in CSS pixels** - worldToCanvas/canvasToWorld return CSS pixels
3. **Clear at identity**: Always `setTransform(1,0,0,1,0,0)` before clearing (works in device pixels)
4. **Draw with world transform**: `scale(scale, scale)` then `translate(-pan.x, -pan.y)` (CSS units)
5. **Transform change = full clear**: Any scale/pan change invalidates entire canvas

### Architecture Boundaries

1. **NO Yjs imports in renderer** - Only consume immutable snapshots
2. **Snapshot in ref, not state** - Avoid React re-render storms via direct subscription
3. **Do not mutate snapshots** - Pass ViewTransform separately; snapshot.view remains identity in Phase 3
4. **Maintain layer order** - Background → Strokes → Text → Overlays → Presence → HUD
5. **Stable render loop** - DO NOT restart loop on transform changes

### Performance Rules

1. **60 FPS target** (16.6ms budget) - 30 FPS on mobile/battery saver
2. **Skip frame if previous > 20ms**
3. **Hidden tab degrades to 8 FPS**
4. **No work when idle** (achieved via event-driven architecture)

### Critical Implementation Fixes (from code review)

1. **Render loop lifecycle**: Must NOT depend on viewTransform - use refs for latest values
2. **Timer types**: Use `number | null` for browser timers, not `NodeJS.Timeout`
3. **Snapshot subscription**: Use public API but store in ref (not state) to avoid re-renders
4. **Transform updates**: Separate effect for invalidation, don't tear down loop
5. **Presence gates**: Must check BOTH G_AWARENESS_READY AND G_FIRST_SNAPSHOT
6. **DPR handling**: View transforms return CSS pixels; convert to device pixels for clearing
7. **Snapshot immutability**: Never modify published snapshots; pass ViewTransform separately from UI state

## 🧪 TESTING CHECKLIST

### Unit Tests (DirtyRectTracker)

- [ ] Coalescing merges overlapping rects
- [ ] AA margin applied correctly (1px all sides)
- [ ] Promotion when rect count > 64
- [ ] Promotion when area ratio > 0.33
- [ ] Transform change forces full clear
- [ ] World to canvas conversion math correct

### Event-Driven Tests (RenderLoop - CRITICAL)

- [ ] NO frames scheduled when idle (zero rAF calls)
- [ ] Exactly one frame per invalidation
- [ ] Multiple invalidations coalesce to one frame
- [ ] Frame scheduled immediately on first invalidation
- [ ] No additional frames after render completes (unless re-invalidated)

### Integration Tests (RenderLoop)

- [ ] Starts and stops cleanly
- [ ] No rAF leaks on unmount
- [ ] Transform change triggers full clear
- [ ] Frame skip when over budget
- [ ] Identity transform for clears
- [ ] World transform order (scale then translate)
- [ ] Hidden tab switches to low FPS timer
- [ ] Mobile detection triggers 30 FPS throttle

### Canvas Adapter Tests (Phase 3.3)

- [ ] Uses ref-based snapshot subscription (not React state)
- [ ] ViewTransform passed separately (snapshot.view remains identity)
- [ ] No React re-renders on snapshot changes
- [ ] Stable render loop (doesn't restart on transform)
- [ ] Uses SnapshotSource abstraction (not real RDM)

### Manual Verification

- [ ] Resize container → one full clear, no artifacts
- [ ] Zoom/pan → full clear each change
- [ ] Hidden tab → FPS drops to 8, restores on visible
- [ ] Console shows frame stats in dev mode
- [ ] No visual artifacts or ghost images

## 📁 EXPECTED FILE STRUCTURE

```
client/src/
├── renderer/
│   ├── types.ts                 # Frame stats, viewport, thresholds
│   ├── DirtyRectTracker.ts     # Invalidation and coalescing engine
│   ├── RenderLoop.ts            # Main orchestrator
│   ├── layers/
│   │   └── index.ts            # Layer function stubs
│   └── __tests__/
│       ├── DirtyRectTracker.test.ts
│       └── RenderLoop.test.ts
└── canvas/
    └── Canvas.tsx              # UPDATED with RenderLoop integration
```

## 🎬 ACCEPTANCE CRITERIA

1. **Render loop operational**: Starts on mount, stops on unmount, no leaks
2. **Dirty rect system working**: Coalesces, promotes, handles transforms
3. **Performance targets met**: 60 FPS steady state, appropriate degradation
4. **Layer pipeline ready**: Stubs in place for Phase 4 stroke rendering
5. **Tests passing**: All unit and integration tests green
6. **Architecture clean**: No Yjs imports, proper boundaries maintained

## 🚨 COMMON PITFALLS TO AVOID

1. **DON'T use continuous rAF** - Wastes CPU when idle; use event-driven scheduling
2. **DON'T mix DPR with view transforms** - View transforms work in CSS pixels only
3. **DON'T clear under non-identity transform** - Leaves ghost images
4. **DON'T keep dirty rects across transform change** - Causes incorrect clears
5. **DON'T store snapshot in React state** - Causes re-render storms (use ref)
6. **DON'T import Yjs in renderer** - Violates architecture boundary
7. **DON'T forget to cleanup** - Cancel rAF, clear timers, unsubscribe
8. **DON'T restart render loop on pan/zoom** - Tears down state unnecessarily (use refs)
9. **DON'T use NodeJS.Timeout in browser** - Use `number` for timer IDs
10. **DON'T modify published snapshots** - They must remain immutable
11. **DON'T render presence without gates** - Check both awareness AND first snapshot
12. **DON'T forget DPR conversion** - CSS pixels → device pixels for clearing
13. **DON'T test real RDM in Phase 3.3** - Use SnapshotSource abstraction
14. **DON'T read view from snapshot.view** - In Phase 3, pass ViewTransform separately from UI state

## 📝 NOTES FOR NEXT PHASES

- **Phase 4** will implement actual stroke rendering in `drawStrokes()`
- **Phase 5** will add pointer input and preview layers
- **Phase 6** will integrate RBush for spatial queries
- **Phase 8** will implement presence overlays with gate checks
- **Phase 14** will add export logic (excludes overlays/HUD)

## ✅ SUCCESS METRICS

- **ZERO idle CPU usage** - No frames scheduled when nothing is dirty
- **Event-driven scheduling** - Frames only on invalidation, not continuous
- **60 FPS when active** (30 FPS on mobile) - Consistent performance
- **Instant response** - First frame scheduled immediately on invalidation
- **No React re-renders** - Ref-based subscriptions working correctly
- **Transform changes feel responsive** - Full clear with no artifacts
- **Tests prove event-driven** - Idle tests show zero rAF calls
- **ViewTransform properly separated** - Passed from UI state, not from snapshot.view
- **Zero console errors or warnings**
- **Code passes all linting rules** including no-restricted-imports
- **Tests provide >80% coverage** with SnapshotSource abstraction
