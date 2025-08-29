import type { RefObject } from 'react';
import type { Snapshot, ViewTransform } from '@avlo/shared';
import type { CanvasStageHandle } from '../canvas/CanvasStage';
import { DirtyRectTracker } from './DirtyRectTracker';
import {
  FrameStats,
  ViewportInfo,
  FRAME_CONFIG,
  InvalidationReason,
  WorldBounds,
  CSSPixelRect,
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
  stageRef: RefObject<CanvasStageHandle>;
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
