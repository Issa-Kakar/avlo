import type { RefObject } from 'react';
import type { Snapshot, ViewTransform } from '@avlo/shared';
import type { CanvasStageHandle } from '../canvas/CanvasStage';
import type { GateStatus } from '@/hooks/use-connection-gates';
import { DirtyRectTracker } from './DirtyRectTracker';
import {
  FrameStats,
  ViewportInfo,
  FRAME_CONFIG,
  InvalidationReason,
  WorldBounds,
  type CSSPixelRect,
} from './types';
import {
  drawBackground,
  drawStrokes,
  drawShapes,
  drawText,
  drawAuthoringOverlays,
  drawHUD,
} from './layers';
import { getVisibleWorldBounds } from '../canvas/internal/transforms';

// Helper function to check if two bounding boxes intersect
function boxesIntersect(
  box1: { minX: number; minY: number; maxX: number; maxY: number },
  box2: [number, number, number, number], // [minX, minY, maxX, maxY]
): boolean {
  return !(
    box1.maxX < box2[0] || // box1 is left of box2
    box1.minX > box2[2] || // box1 is right of box2
    box1.maxY < box2[1] || // box1 is above box2
    box1.minY > box2[3]    // box1 is below box2
  );
}

export interface RenderLoopConfig {
  stageRef: RefObject<CanvasStageHandle>;
  getView: () => ViewTransform;
  getSnapshot: () => Snapshot;
  getViewport: () => ViewportInfo;
  getGates: () => GateStatus; // Phase 7: Gate status for presence rendering
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
  private lastTransformState: { scale: number; pan: { x: number; y: number } } | null = null;
  private lastRenderedScene = -1; // Track scene changes for full clear
  private skipNextFrame = false;
  private isHidden = false;
  private hiddenIntervalId: number | null = null; // Browser timer returns number, not NodeJS.Timeout
  private needsFrame = false; // EVENT-DRIVEN: Only schedule when dirty
  private framesSinceInvalidation = 0; // Count frames since last invalidation

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
    // Clear any pending animation frames first
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }

    // Clear any hidden tab intervals
    if (this.hiddenIntervalId !== null) {
      clearInterval(this.hiddenIntervalId);
      this.hiddenIntervalId = null;
    }

    // Reset all state
    this.config = null;
    this.dirtyTracker.reset();
    this.lastTransformState = null;
    this.lastRenderedScene = -1; // Reset scene tracking
    this.needsFrame = false;
    this.framesSinceInvalidation = 0;
    this.skipNextFrame = false;
    this.lastFrameTime = 0;

    // Reset frame stats to initial state
    this.frameStats = {
      frameCount: 0,
      avgMs: 0,
      fps: 60,
      overBudgetCount: 0,
      skippedCount: 0,
      lastClearType: 'none',
      rectCount: 0,
    };
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
      // Safety check - config might have been cleared if stopped
      if (this.config && this.needsFrame) {
        this.tick();
      } else if (!this.config && this.hiddenIntervalId !== null) {
        // Clean up interval if config was cleared
        clearInterval(this.hiddenIntervalId);
        this.hiddenIntervalId = null;
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

    // Don't throttle the first frame (framesSinceInvalidation === 0)
    // Only apply FPS throttling to subsequent continuous frames
    if (this.framesSinceInvalidation > 0 && elapsed < targetMs) {
      // We've rendered recently and need to respect FPS cap
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
    this.framesSinceInvalidation++; // Increment frame counter

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

    // Validate view transform to prevent rendering issues
    if (
      !view ||
      !isFinite(view.scale) ||
      view.scale <= 0 ||
      !isFinite(view.pan.x) ||
      !isFinite(view.pan.y)
    ) {
      console.error('[RenderLoop] Invalid view transform:', view);
      // Force full clear and return early - invalid transform can't be rendered
      this.dirtyTracker.invalidateAll('transform-change');
      return;
    }

    // Update dirty tracker canvas size if changed
    this.dirtyTracker.setCanvasSize(viewport.pixelWidth, viewport.pixelHeight, viewport.dpr);

    // Check for scene change FIRST - this triggers full clear
    if (snapshot.scene !== this.lastRenderedScene) {
      // Scene changed - forcing full clear
      this.dirtyTracker.invalidateAll('scene-change');
      this.lastRenderedScene = snapshot.scene;
    }

    // Check for transform change only if it might have changed
    // This avoids calling notifyTransformChange on every frame unnecessarily
    if (
      !this.lastTransformState ||
      this.lastTransformState.scale !== view.scale ||
      this.lastTransformState.pan.x !== view.pan.x ||
      this.lastTransformState.pan.y !== view.pan.y
    ) {
      this.dirtyTracker.notifyTransformChange(view);
      // Store only the values we need for comparison (not functions)
      this.lastTransformState = {
        scale: view.scale,
        pan: { x: view.pan.x, y: view.pan.y },
      };
    }

    // Get clear instructions early to check if we need to do anything
    let clearInstructions = this.dirtyTracker.getClearInstructions();

    // Coalesce dirty rectangles only if we have dirty rects (not full clear or none)
    if (
      clearInstructions.type === 'dirty' &&
      clearInstructions.rects &&
      clearInstructions.rects.length > 1
    ) {
      this.dirtyTracker.coalesce();
      // Get updated instructions after coalescing
      clearInstructions = this.dirtyTracker.getClearInstructions();
    }

    // Check if we have translucent strokes in view that require full clear
    // This prevents alpha accumulation artifacts when using dirty rect optimization
    if (clearInstructions.type === 'dirty') {
      // Calculate visible bounds early for the translucent check
      const visibleBounds = getVisibleWorldBounds(
        viewport.cssWidth,
        viewport.cssHeight,
        view.scale,
        view.pan,
      );

      // Check if any translucent stroke intersects the viewport
      let hasTranslucentInView = false;

      if (snapshot.spatialIndex) {
        // Use spatial query for efficiency
        const visibleStrokes = snapshot.spatialIndex.queryRect(
          visibleBounds.minX,
          visibleBounds.minY,
          visibleBounds.maxX,
          visibleBounds.maxY,
        );
        hasTranslucentInView = visibleStrokes.some(
          (stroke) => stroke.style.opacity < 1
        );
      } else {
        // Fallback to linear scan
        hasTranslucentInView = snapshot.strokes.some(
          (stroke) => stroke.style.opacity < 1 && boxesIntersect(visibleBounds, stroke.bbox),
        );
      }

      // Promote to full clear if we have translucent content visible
      if (hasTranslucentInView) {
        this.dirtyTracker.invalidateAll('content-change');
        clearInstructions = this.dirtyTracker.getClearInstructions();
      }
    }

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
        // Full clear in device pixels
        ctx.clearRect(0, 0, viewport.pixelWidth, viewport.pixelHeight);
        this.frameStats.lastClearType = 'full';
        this.frameStats.rectCount = 0; // Reset rect count on full clear
      } else if (clearInstructions.type === 'dirty' && clearInstructions.rects) {
        // Dirty rectangle clears - rects are already in device pixels
        for (const rect of clearInstructions.rects) {
          ctx.clearRect(rect.x, rect.y, rect.width, rect.height);
        }
        this.frameStats.lastClearType = 'dirty';
        this.frameStats.rectCount = clearInstructions.rects.length;
      }

      // Restore transform
      ctx.restore();
    });

    // Draw pass 1: World content (world transform)
    stage.withContext((ctx) => {
      // Apply world transform: scale first, then translate
      // Note: withContext starts with the base DPR transform from CanvasStage
      // The operations below compose with it: DPR × scale × translate
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

      // CRITICAL: Apply clipping if we have dirty rects
      let clipRegion: DirtyClipRegion | undefined;
      if (clearInstructions.type === 'dirty' && clearInstructions.rects) {
        // Convert device pixel rects to world coordinates for clipping
        clipRegion = {
          worldRects: clearInstructions.rects.map(rect => {
            // Convert device pixels → CSS pixels → world
            const cssX = rect.x / viewport.dpr;
            const cssY = rect.y / viewport.dpr;
            const cssW = rect.width / viewport.dpr;
            const cssH = rect.height / viewport.dpr;

            const [worldX1, worldY1] = view.canvasToWorld(cssX, cssY);
            const [worldX2, worldY2] = view.canvasToWorld(cssX + cssW, cssY + cssH);

            return {
              minX: worldX1,
              minY: worldY1,
              maxX: worldX2,
              maxY: worldY2,
            };
          })
        };

        // Create clipping path for all dirty regions
        ctx.save();
        ctx.beginPath();
        for (const rect of clearInstructions.rects) {
          // Clip in device pixels (transform already applied)
          const x = rect.x / viewport.dpr / view.scale + view.pan.x;
          const y = rect.y / viewport.dpr / view.scale + view.pan.y;
          const w = rect.width / viewport.dpr / view.scale;
          const h = rect.height / viewport.dpr / view.scale;
          ctx.rect(x, y, w, h);
        }
        ctx.clip();
      }

      const augmentedViewport = {
        ...viewport,
        visibleWorldBounds: visibleBounds,
        clipRegion, // NEW: Pass dirty regions for spatial queries
      };

      // Draw world layers only
      // LINE WIDTH POLICY:
      // - World content (strokes): ctx.lineWidth = style.size (world units)
      // - Hairlines/HUD: ctx.lineWidth = 1 / view.scale (targets ~1 CSS pixel, becomes DPR device pixels)
      // DPR is already applied by CanvasStage via initial setTransform(dpr, 0, 0, dpr, 0, 0)

      drawBackground(ctx, snapshot, view, augmentedViewport);
      drawStrokes(ctx, snapshot, view, augmentedViewport); // Phase 4: actual stroke rendering (shapes commit as a stroke)
      drawShapes(ctx, snapshot, view, augmentedViewport); // NO LONGER IMPLEMENTED: stamps/shapes, DORMANT PLACEHOLDER
      drawText(ctx, snapshot, view, augmentedViewport); // Phase 11: text blocks

      // Authoring overlay - for future selection/handles
      drawAuthoringOverlays(ctx, snapshot, view, augmentedViewport);

      // Restore clipping state
      if (clipRegion) {
        ctx.restore();
      }

      // ⛔️ Preview moved to overlay canvas - no longer drawn here
    });

    // Draw pass 2: HUD only (screen space with DPR only)
    stage.withContext((ctx) => {
      const augmentedViewport = {
        ...viewport,
        visibleWorldBounds: getVisibleWorldBounds(
          viewport.cssWidth,
          viewport.cssHeight,
          view.scale,
          view.pan,
        ),
      };

      // ⛔️ Presence moved to overlay canvas - no longer drawn here

      // Keep HUD on base canvas
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
    // Safety check - don't schedule if config is null (stopped)
    if (!this.config) return;

    if (!this.needsFrame) {
      this.needsFrame = true;
      this.framesSinceInvalidation = 0; // Reset counter for new invalidation
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
