import { DirtyRectTracker } from './DirtyRectTracker';
import {
  FrameStats,
  FRAME_CONFIG,
  InvalidationReason,
  WorldBounds,
  DirtyClipRegion,
  type CSSPixelRect,
} from './types';
import {
  drawBackground,
  drawObjects,
} from './layers';
import {
  useCameraStore,
  getViewTransform,
  getViewportInfo,
  getVisibleWorldBounds,
  isMobile,
} from '@/stores/camera-store';
import { getBaseContext } from '@/canvas/SurfaceManager';
import { getCurrentDocSnapshot } from '@/canvas/room-runtime';

export class RenderLoop {
  private started = false;
  private dirtyTracker = new DirtyRectTracker();
  private cameraUnsubscribe: (() => void) | null = null;
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

  /**
   * Start the render loop.
   * All dependencies are read from module registries - no config needed.
   */
  start(): void {
    if (this.started) {
      console.warn('RenderLoop already started');
      return;
    }

    this.started = true;
    this.lastFrameTime = performance.now();

    // Get initial viewport for tracker sizing from camera store
    const viewport = getViewportInfo();
    this.dirtyTracker.setCanvasSize(viewport.pixelWidth, viewport.pixelHeight, viewport.dpr);

    // Initialize dirty tracker with current transform state
    const initialView = getViewTransform();
    this.dirtyTracker.notifyTransformChange(initialView);

    // Subscribe to camera store for self-invalidation on viewport/transform changes
    // This eliminates the need for Canvas.tsx to be a middleman
    this.cameraUnsubscribe = useCameraStore.subscribe(
      // Selector: extract all relevant camera state
      (state) => ({
        scale: state.scale,
        panX: state.pan.x,
        panY: state.pan.y,
        cssWidth: state.cssWidth,
        cssHeight: state.cssHeight,
        dpr: state.dpr,
      }),
      // Callback: runs when selected values change
      (curr, prev) => {
        // Viewport changed -> update canvas size and full clear
        if (curr.cssWidth !== prev.cssWidth || curr.cssHeight !== prev.cssHeight || curr.dpr !== prev.dpr) {
          const pixelWidth = Math.round(curr.cssWidth * curr.dpr);
          const pixelHeight = Math.round(curr.cssHeight * curr.dpr);
          this.dirtyTracker.setCanvasSize(pixelWidth, pixelHeight, curr.dpr);
          this.dirtyTracker.invalidateAll('geometry-change');
          this.markDirty();
          return; // Full clear handles everything
        }

        // Transform changed -> notify tracker for full clear and schedule frame
        if (curr.scale !== prev.scale || curr.panX !== prev.panX || curr.panY !== prev.panY) {
          this.dirtyTracker.notifyTransformChange({
            scale: curr.scale,
            pan: { x: curr.panX, y: curr.panY }
          });
          this.markDirty();
        }
      },
      {
        equalityFn: (a, b) =>
          a.scale === b.scale &&
          a.panX === b.panX &&
          a.panY === b.panY &&
          a.cssWidth === b.cssWidth &&
          a.cssHeight === b.cssHeight &&
          a.dpr === b.dpr,
      }
    );

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
    // Cancel camera store subscription first
    this.cameraUnsubscribe?.();
    this.cameraUnsubscribe = null;

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
    this.started = false;
    this.dirtyTracker.reset();
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
    if (this.hiddenIntervalId || !this.started) return;

    const intervalMs = 1000 / FRAME_CONFIG.HIDDEN_FPS;
    this.hiddenIntervalId = window.setInterval(() => {
      // Safety check - might have been stopped
      if (this.started && this.needsFrame) {
        this.tick();
      } else if (!this.started && this.hiddenIntervalId !== null) {
        // Clean up interval if stopped
        clearInterval(this.hiddenIntervalId);
        this.hiddenIntervalId = null;
      }
    }, intervalMs);
  }

  // EVENT-DRIVEN: Schedule frame only when needed
  private scheduleFrameIfNeeded(): void {
    if (!this.started || this.isHidden || this.rafId !== null) return;

    // Check if we should throttle FPS on mobile (isMobile from camera-store)
    const targetFPS = isMobile() ? FRAME_CONFIG.MOBILE_FPS : FRAME_CONFIG.TARGET_FPS;
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
    if (!this.started) return;

    const startTime = performance.now();
    this.lastFrameTime = startTime;

    // Clear the needsFrame flag - will be set again if new work arrives
    this.needsFrame = false;
    this.framesSinceInvalidation++; // Increment frame counter

    // Skip frame if previous was over budget
    if (this.skipNextFrame) {
      this.skipNextFrame = false;
      this.frameStats.skippedCount++;
      return;
    }

    // Get context from registry (replaces stageRef.current)
    const ctx = getBaseContext();
    if (!ctx) return;

    // Read view and viewport from camera store
    const view = getViewTransform();
    // Read snapshot from room-runtime (replaces getSnapshot callback)
    const snapshot = getCurrentDocSnapshot();
    const viewport = getViewportInfo();

    // Early exit if viewport is not yet sized
    if (viewport.cssWidth <= 0 || viewport.cssHeight <= 0) {
      return;
    }

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

    // Transform changes are handled by the camera store subscription callback
    // which calls dirtyTracker.notifyTransformChange() before marking dirty

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
      // Check if any translucent stroke intersects the viewport
      // TODO: Re-implement translucency check with Y.Map objects in Phase 6
      let hasTranslucentInView = false;

      if (snapshot.spatialIndex) {
        const visibleBounds = getVisibleWorldBounds();
        // Use spatial query for efficiency
        const visibleObjects = snapshot.spatialIndex.query({
          minX: visibleBounds.minX,
          minY: visibleBounds.minY,
          maxX: visibleBounds.maxX,
          maxY: visibleBounds.maxY,
        });
        hasTranslucentInView = visibleObjects.some(
          (entry) => {
            const handle = snapshot.objectsById.get(entry.id);
            return handle && handle.y.get('opacity') < 1;
          }
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
    ctx.save();
    // Reset to identity for clearing
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
    ctx.restore();

    // Draw pass 1: World content (world transform)
    ctx.save();
    // Apply explicit world transform: DPR × scale × translate combined
    const { dpr } = viewport;
    ctx.setTransform(
      dpr * view.scale, 0,
      0, dpr * view.scale,
      -view.pan.x * dpr * view.scale,
      -view.pan.y * dpr * view.scale
    );

    // Calculate visible world bounds for culling (reads from camera store)
    const visibleBounds = getVisibleWorldBounds();

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

      // Create clipping path for all dirty regions in world space
      ctx.save();
      ctx.beginPath();
      for (const worldRect of clipRegion.worldRects) {
        ctx.rect(
          worldRect.minX,
          worldRect.minY,
          worldRect.maxX - worldRect.minX,
          worldRect.maxY - worldRect.minY
        );
      }
      ctx.clip();
    }

    const augmentedViewport = {
      ...viewport,
      visibleWorldBounds: visibleBounds,
      clipRegion, // Pass dirty regions for spatial queries
    };

    // Draw world layers
    drawBackground(ctx, snapshot, view, augmentedViewport);
    drawObjects(ctx, snapshot, view, augmentedViewport);

    // Restore clipping state
    if (clipRegion) {
      ctx.restore();
    }
    ctx.restore();

    // Reset dirty tracker for next frame
    this.dirtyTracker.reset();

    // Update frame stats
    const frameDuration = performance.now() - startTime;
    this.updateStats(frameDuration);

    // Check if we should skip next frame
    if (frameDuration > FRAME_CONFIG.SKIP_THRESHOLD_MS) {
      this.skipNextFrame = true;
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
    if (!this.started) return;
    // Read view from camera store
    const view = getViewTransform();
    this.dirtyTracker.invalidateWorldBounds(bounds, view);
    this.markDirty();
  }

  invalidateCanvas(rect: CSSPixelRect): void {
    if (!this.started) return;
    // Read view and viewport from camera store
    const { scale } = useCameraStore.getState();
    const viewport = getViewportInfo();
    // Pass CSS pixel rect - dirtyTracker converts to device pixels internally
    this.dirtyTracker.invalidateCanvasPixels(rect, scale, viewport.dpr);
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
    // Safety check - don't schedule if not started
    if (!this.started) return;

    if (!this.needsFrame) {
      this.needsFrame = true;
      this.framesSinceInvalidation = 0; // Reset counter for new invalidation
      this.scheduleFrameIfNeeded();
    }
  }

  // Cleanup
  destroy(): void {
    // Ensure subscription is cleaned up (stop() also does this, but be explicit)
    this.cameraUnsubscribe?.();
    this.cameraUnsubscribe = null;
    this.stop();
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.handleVisibilityChange);
    }
  }
}
