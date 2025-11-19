import type { Snapshot, StrokeView, ViewTransform } from '@avlo/shared';
import type { ViewportInfo } from '../types';
import { getStrokeCacheInstance,  } from '../stroke-builder';

// Use shared singleton cache for stroke rendering
const strokeCache = getStrokeCacheInstance();

// Track scene for cache invalidation
let lastScene = -1;

/**
 * Draws all strokes from the snapshot.
 * Called by RenderLoop in the canonical layer order.
 *
 * Context state on entry (guaranteed by RenderLoop):
 * - World transform already applied: ctx.scale(view.scale, view.scale); ctx.translate(-view.pan.x, -view.pan.y)
 * - DPR already set by CanvasStage via initial setTransform(dpr,0,0,dpr,0,0)
 * - globalAlpha = 1.0
 * - Default composite operation
 * - Each layer wrapped in save/restore by RenderLoop
 *
 * CRITICAL: This operates on immutable snapshot data.
 * Float32Arrays are built at render time, never stored.
 */
export function drawStrokes(
  ctx: CanvasRenderingContext2D,
  snapshot: Snapshot,
  viewTransform: ViewTransform,
  viewport: ViewportInfo,
): void {
  // Clear cache on scene change
  if (snapshot.scene !== lastScene) {
    strokeCache.clear();
    lastScene = snapshot.scene;
  }

  // Calculate visible world bounds for culling
  const visibleBounds = getVisibleWorldBounds(viewTransform, viewport);

  // Use spatial index for efficient querying
  let candidateStrokes: ReadonlyArray<StrokeView>;

  if (snapshot.spatialIndex) {
    if (viewport.clipRegion?.worldRects) {
      // OPTIMIZATION: Query each dirty rect and union results
      const strokeSet = new Set<StrokeView>();

      for (const rect of viewport.clipRegion.worldRects) {
        const results = snapshot.spatialIndex.queryRect(
          rect.minX,
          rect.minY,
          rect.maxX,
          rect.maxY,
        );
        for (const stroke of results) {
          strokeSet.add(stroke);
        }
      }

      candidateStrokes = Array.from(strokeSet);
    } else {
      // Full viewport query
      candidateStrokes = snapshot.spatialIndex.queryRect(
        visibleBounds.minX,
        visibleBounds.minY,
        visibleBounds.maxX,
        visibleBounds.maxY,
      );
    }
  } else {
    // Fallback to all strokes
    candidateStrokes = snapshot.strokes;
  }

  // ========== CRITICAL FIX: Sort by ULID for deterministic draw order ==========
  // WHY: RBush query order is non-deterministic across:
  //   - Different tabs (tree shape differs based on insertion order)
  //   - Refresh (hydration order may differ from incremental builds)
  //   - Viewport changes (query bounding box affects traversal)
  //
  // SOLUTION: ULID (stroke.id) provides:
  //   - Lexicographic total ordering (monotonic time-based)
  //   - Globally consistent across all clients
  //   - Independent of RBush internal structure
  //
  // COST: O(K log K) where K = visible strokes (cheap because K << N)
  //
  // RESULT: Same z-order on all tabs, regardless of:
  //   - When they joined
  //   - How they zoomed/panned
  //   - Whether they refreshed
  const sortedCandidates = [...candidateStrokes].sort((a, b) => {
    // Lexicographic comparison (ULID is time-ordered string)
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  let renderedCount = 0;
  let culledCount = 0;

  // Draw in ULID order (oldest first → newest on top)
  for (const stroke of sortedCandidates) {
    // LOD check still needed (spatial query is coarse)
    if (shouldSkipLOD(stroke, viewTransform)) {
      culledCount++;
      continue;
    }

    renderStroke(ctx, stroke, viewTransform);
    renderedCount++;
  }

  // Development logging
  // CRITICAL: Use import.meta.env.DEV for Vite compatibility
  if (import.meta.env.DEV && import.meta.env.VITE_DEBUG_RENDER_LAYERS && renderedCount > 0) {
    // eslint-disable-next-line no-console
    console.debug(
      `[Strokes] Rendered ${renderedCount}/${sortedCandidates.length} candidates (${culledCount} LOD culled)`,
    );
  }
}

/**
 * Renders a single stroke.
 * Branches on stroke.kind to use different geometry pipelines:
 * - Freehand (PF polygon) → fill
 * - Shapes (polyline) → stroke
 *
 * Note: viewTransform is passed for consistency but not used here since
 * RenderLoop has already applied the world transform to the context.
 */
function renderStroke(
  ctx: CanvasRenderingContext2D,
  stroke: StrokeView,
  _viewTransform: ViewTransform,
): void {
  // Get or build render data (cache selects geometry based on stroke.kind)
  const renderData = strokeCache.getOrBuild(stroke);

  if (renderData.pointCount < 2) {
    return; // Need at least 2 points for a line
  }

  ctx.save();
  ctx.globalAlpha = stroke.style.opacity;

  if (renderData.kind === 'polygon') {
    // FREEHAND (PF polygon) → fill with default nonzero rule (no closing)
    ctx.fillStyle = stroke.style.color;
    if (renderData.path) {
      // Use default nonzero fill rule for open PF outlines
      ctx.fill(renderData.path);
    } else {
      // Rare test fallback (no Path2D)
      ctx.beginPath();
      const pg = renderData.polygon;
      ctx.moveTo(pg[0], pg[1]);
      for (let i = 2; i < pg.length; i += 2) {
        ctx.lineTo(pg[i], pg[i + 1]);
      }
      // CRITICAL: Do NOT closePath() - PF already provides complete outline
      ctx.fill();
    }
  } else {
    // SHAPES (polyline) → stroke
    ctx.strokeStyle = stroke.style.color;
    ctx.lineWidth = stroke.style.size;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    if (stroke.style.tool === 'highlighter') {
      ctx.globalCompositeOperation = 'source-over';
    }

    if (renderData.path) {
      ctx.stroke(renderData.path);
    } else {
      // Fallback when Path2D not available (tests)
      ctx.beginPath();
      const pl = renderData.polyline;
      ctx.moveTo(pl[0], pl[1]);
      for (let i = 2; i < pl.length; i += 2) {
        ctx.lineTo(pl[i], pl[i + 1]);
      }
      ctx.stroke();
    }
  }

  ctx.restore();
}

/**
 * LOD check: Skip strokes that are too small in screen space.
 * Returns true if stroke should be skipped.
 */
function shouldSkipLOD(stroke: StrokeView, viewTransform: ViewTransform): boolean {
  const [minX, minY, maxX, maxY] = stroke.bbox;
  const diagonal = Math.sqrt((maxX - minX) ** 2 + (maxY - minY) ** 2);
  const screenDiagonal = diagonal * viewTransform.scale;

  // Skip if less than 2 CSS pixels
  return screenDiagonal < 2;
}

/**
 * Calculate visible world bounds for culling.
 * Converts viewport to world coordinates.
 *
 * CRITICAL: Uses CSS pixels from viewport, not device pixels.
 * The ViewTransform operates in CSS coordinate space.
 * ViewportInfo provides both:
 * - pixelWidth/pixelHeight: Device pixels for canvas operations
 * - cssWidth/cssHeight: CSS pixels for coordinate transforms
 */
function getVisibleWorldBounds(
  viewTransform: ViewTransform,
  viewport: ViewportInfo,
): { minX: number; minY: number; maxX: number; maxY: number } {
  // Convert viewport corners to world space using CSS pixels (NOT device pixels)
  const [minX, minY] = viewTransform.canvasToWorld(0, 0);
  const [maxX, maxY] = viewTransform.canvasToWorld(viewport.cssWidth, viewport.cssHeight);

  // Add small margin for strokes partially in view
  const margin = 50 / viewTransform.scale; // 50px margin in world units

  return {
    minX: minX - margin,
    minY: minY - margin,
    maxX: maxX + margin,
    maxY: maxY + margin,
  };
}

/**
 * Clear the stroke cache.
 * Called on cleanup or major state changes.
 */
export function clearStrokeCache(): void {
  strokeCache.clear();
  lastScene = -1;
}

// Export for testing
export function getStrokeCacheSize(): number {
  return strokeCache.size;
}


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
      const hasTranslucentInView = snapshot.strokes.some(
        (stroke) => stroke.style.opacity < 1 && boxesIntersect(visibleBounds, stroke.bbox),
      );

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

      const augmentedViewport = {
        ...viewport,
        visibleWorldBounds: visibleBounds,
      };

      // Draw world layers only
      // LINE WIDTH POLICY:
      // - World content (strokes): ctx.lineWidth = style.size (world units)
      // - Hairlines/HUD: ctx.lineWidth = 1 / view.scale (targets ~1 CSS pixel, becomes DPR device pixels)
      // DPR is already applied by CanvasStage via initial setTransform(dpr, 0, 0, dpr, 0, 0)

      drawBackground(ctx, snapshot, view, augmentedViewport);
      drawStrokes(ctx, snapshot, view, augmentedViewport); // Phase 4: actual stroke rendering
      drawShapes(ctx, snapshot, view, augmentedViewport); // NO LONGER IMPLEMENTED: stamps/shapes, DORMANT PLACEHOLDER
      drawText(ctx, snapshot, view, augmentedViewport); // Phase 11: text blocks

      // Authoring overlay - for future selection/handles
      drawAuthoringOverlays(ctx, snapshot, view, augmentedViewport);

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


import React, { useRef, useCallback, useState, useEffect, useLayoutEffect } from 'react';
import { createEmptySnapshot } from '@avlo/shared';
import type { RoomId, Snapshot, ViewTransform } from '@avlo/shared';
import { ulid } from 'ulid';
import { CanvasStage, type CanvasStageHandle, type ResizeInfo } from './CanvasStage';
import { useRoomDoc } from '../hooks/use-room-doc';
import { useViewTransform } from './ViewTransformContext';
import { RenderLoop } from '../renderer/RenderLoop';
import { OverlayRenderLoop } from '../renderer/OverlayRenderLoop';
import type { ViewportInfo } from '../renderer/types';
import {
  clearStrokeCache,
  drawPresenceOverlays,
  invalidateStrokeCacheByIds, // NEW: for cache eviction on geometry changes
} from '../renderer/layers';
import { DrawingTool } from '@/lib/tools/DrawingTool';
import { EraserTool } from '@/lib/tools/EraserTool';
import { TextTool } from '@/lib/tools/TextTool';
import { PanTool } from '@/lib/tools/PanTool';
import { useDeviceUIStore } from '@/stores/device-ui-store';
import { calculateZoomTransform } from './internal/transforms';
import { ZoomAnimator } from './animation/ZoomAnimator';

// Unified interface for all pointer tools
type PointerTool = DrawingTool | EraserTool | TextTool | PanTool;

// Epsilon equality for floating point comparison
function bboxEquals(a: number[], b: number[]): boolean {
  const eps = 1e-3;
  return (
    Math.abs(a[0] - b[0]) < eps &&
    Math.abs(a[1] - b[1]) < eps &&
    Math.abs(a[2] - b[2]) < eps &&
    Math.abs(a[3] - b[3]) < eps
  );
}

interface WorldBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

// Helper to check if styles are equal
function stylesEqual(
  a: { color: string; size: number; opacity: number },
  b: { color: string; size: number; opacity: number },
): boolean {
  return a.color === b.color && a.size === b.size && a.opacity === b.opacity;
}

// Helper to convert bbox array to WorldBounds
function bboxToBounds(b: [number, number, number, number]): WorldBounds {
  return { minX: b[0], minY: b[1], maxX: b[2], maxY: b[3] };
}

// Result type for diff operation
type EvictId = string;
type DiffResult = {
  dirty: WorldBounds[];
  evictIds: EvictId[];
};

function diffBoundsAndEvicts(prev: Snapshot, next: Snapshot): DiffResult {
  const prevSt = new Map(prev.strokes.map((s) => [s.id, s]));
  const nextSt = new Map(next.strokes.map((s) => [s.id, s]));
  const dirty: WorldBounds[] = [];
  const evict = new Set<string>();

  // Added / modified strokes
  for (const [id, n] of nextSt) {
    const p = prevSt.get(id);
    if (!p) {
      // Added: repaint only (cache had no entry)
      dirty.push(bboxToBounds(n.bbox));
      continue;
    }

    const bboxChanged = !bboxEquals(p.bbox, n.bbox);
    const styleChanged = !stylesEqual(p.style, n.style);

    if (bboxChanged) {
      // Geometry changed → evict, and repaint old+new footprint
      evict.add(id);
      dirty.push(bboxToBounds(p.bbox));
      dirty.push(bboxToBounds(n.bbox));
    } else if (styleChanged) {
      // Style only → repaint, no eviction (cache handles variants)
      dirty.push(bboxToBounds(n.bbox));
    }
  }

  // Removed strokes
  for (const [id, p] of prevSt) {
    if (!nextSt.has(id)) {
      evict.add(id);
      dirty.push(bboxToBounds(p.bbox));
    }
  }

  // --- Text blocks ---
  const prevTxt = new Map(prev.texts.map((t) => [t.id, t]));
  const nextTxt = new Map(next.texts.map((t) => [t.id, t]));

  for (const [id, n] of nextTxt) {
    const p = prevTxt.get(id);
    const rectChanged = !p || p.x !== n.x || p.y !== n.y || p.w !== n.w || p.h !== n.h;
    const styleOrContentChanged =
      !!p && (p.color !== n.color || p.size !== n.size || p.content !== n.content);
    if (rectChanged || styleOrContentChanged) {
      dirty.push({ minX: n.x, minY: n.y, maxX: n.x + n.w, maxY: n.y + n.h });
      if (p && rectChanged)
        dirty.push({ minX: p.x, minY: p.y, maxX: p.x + p.w, maxY: p.y + p.h });
    }
  }
  for (const [id, p] of prevTxt) {
    if (!nextTxt.has(id)) {
      dirty.push({ minX: p.x, minY: p.y, maxX: p.x + p.w, maxY: p.y + p.h });
    }
  }

  return { dirty, evictIds: [...evict] };
}

export interface CanvasProps {
  roomId: RoomId;
  className?: string;
}

export interface CanvasHandle {
  screenToWorld: (clientX: number, clientY: number) => [number, number];
  worldToClient: (worldX: number, worldY: number) => [number, number];
  invalidateWorld: (bounds: { minX: number; minY: number; maxX: number; maxY: number }) => void;
  setPreviewProvider: (provider: () => any) => void;
}

/**
 * Canvas component that integrates rendering with coordinate transforms.
 * Bridges between the low-level CanvasStage and high-level room data.
 *
 * Phase 3.3: Now uses RenderLoop with event-driven architecture
 * Phase 3.4: Fixed DPR handling in coordinate transforms
 */
export const Canvas = React.forwardRef<CanvasHandle, CanvasProps>(({ roomId, className }, ref) => {
  // Replace single stageRef with two stages
  const baseStageRef = useRef<CanvasStageHandle>(null);
  const overlayStageRef = useRef<CanvasStageHandle>(null);
  const editorHostRef = useRef<HTMLDivElement>(null); // NEW: DOM overlay for text
  const roomDoc = useRoomDoc(roomId); // MUST be called at top level, not inside useEffect
  const { transform: viewTransform, setScale, setPan } = useViewTransform();
  const toolRef = useRef<PointerTool>();
  const lastMouseClientRef = useRef<{ x: number; y: number } | null>(null); // Track last mouse position for tool seeding
  const [_canvasSize, setCanvasSize] = useState<ResizeInfo | null>(null);
  const canvasSizeRef = useRef<ResizeInfo | null>(null); // For access in closures
  const renderLoopRef = useRef<RenderLoop | null>(null); // existing
  const overlayLoopRef = useRef<OverlayRenderLoop | null>(null); // new

  // Get toolbar state from Zustand store - MUST come before activeToolRef initialization
  // Phase 9: Updated to use new store structure
  const { activeTool, pen, highlighter, eraser, text, shape } = useDeviceUIStore();

  // Add setter and tool refs for stable callbacks (Step 1.1)
  const setScaleRef = useRef<(scale: number) => void>();
  const setPanRef = useRef<(pan: { x: number; y: number }) => void>();
  const activeToolRef = useRef<string>(activeTool); // Track current tool for stable cursor

  // Step 3.1: Add state refs for MMB pan
  // Tracks ephemeral MMB pan without touching Zustand
  const mmbPanRef = useRef<{
    active: boolean;
    pointerId: number | null;
    lastClient: { x: number; y: number } | null;
  }>({ active: false, pointerId: null, lastClient: null });

  // Cursor override that beats the tool's base cursor
  const cursorOverrideRef = useRef<string | null>(null);

  // Suppress tool preview during MMB pan (hides eraser ring)
  const suppressToolPreviewRef = useRef(false);

  // Zoom animator for smooth transitions
  const zoomAnimatorRef = useRef<ZoomAnimator | null>(null);

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

  // PERFORMANCE OPTIMIZATION: Store in ref to avoid React re-renders
  // We use the public subscription API (same as useRoomSnapshot hook) but store the result in a ref
  // instead of state to prevent React render storms at 60+ FPS. This maintains the architectural
  // boundary - we're still consuming immutable snapshots through the public API, just optimizing
  // how we store them to avoid unnecessary React work.
  const snapshotRef = useRef<Snapshot>(createEmptySnapshot()); // Initialize with empty snapshot
  const viewTransformRef = useRef<ViewTransform>(viewTransform); // Store latest transform

  // Keep view transform ref updated (no re-render)
  // Use useLayoutEffect to ensure ref is updated before drawing tool effect reads it
  // Step 1.3: Update refs in layout effect
  useLayoutEffect(() => {
    viewTransformRef.current = viewTransform;
    setScaleRef.current = setScale;
    setPanRef.current = setPan;
    activeToolRef.current = activeTool; // Keep tool ref in sync
  }, [viewTransform, setScale, setPan, activeTool]);

  // Subscribe to snapshots via public API (stores in ref to avoid re-renders)
  // 3C: Update snapshot subscription to check docVersion
  useEffect(() => {
    let lastDocVersion = -1;

    const unsubscribe = roomDoc.subscribeSnapshot((newSnapshot) => {
      const prevSnapshot = snapshotRef.current;
      snapshotRef.current = newSnapshot;

      if (!renderLoopRef.current || !overlayLoopRef.current) return;

      // Check if scene changed (requires full clear on both)
      if (!prevSnapshot || prevSnapshot.scene !== newSnapshot.scene) {
        renderLoopRef.current.invalidateAll('scene-change');
        overlayLoopRef.current.invalidateAll();
        lastDocVersion = newSnapshot.docVersion;
        return;
      }

      // Check if document content changed (not just presence)
      // CRITICAL: docVersion increments on Y.Doc changes, NOT on presence changes
      if (newSnapshot.docVersion !== lastDocVersion) {
        lastDocVersion = newSnapshot.docVersion;

        // Hold preview for one frame to prevent flash on commit
        overlayLoopRef.current.holdPreviewForOneFrame();

        // Use bbox diffing for targeted invalidation with cache eviction
        const { dirty, evictIds } = diffBoundsAndEvicts(prevSnapshot, newSnapshot);

        // Evict geometry for ids whose geometry footprint changed or were removed
        if (evictIds.length) {
          invalidateStrokeCacheByIds(evictIds);
        }

        // Repaint everything that changed style or geometry, additions/removals, etc.
        // (DirtyRectTracker will coalesce or promote to full clear if appropriate.)
        for (const b of dirty) {
          renderLoopRef.current.invalidateWorld(b);
        }

        overlayLoopRef.current.invalidateAll(); // Also update overlay for new doc
      } else {
        // Presence-only change - update overlay only
        overlayLoopRef.current.invalidateAll();
      }
    });

    snapshotRef.current = roomDoc.currentSnapshot;
    lastDocVersion = roomDoc.currentSnapshot.docVersion;

    return unsubscribe;
  }, [roomDoc]); // Depend on roomDoc from hook