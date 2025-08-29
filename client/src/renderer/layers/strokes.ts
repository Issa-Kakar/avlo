import type { Snapshot, StrokeView, ViewTransform } from '@avlo/shared';
import type { ViewportInfo } from '../types';
import { StrokeRenderCache, isStrokeVisible } from '../stroke-builder';

// Module-level cache persists across frames
const strokeCache = new StrokeRenderCache(1000);

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

  // Filter and render strokes
  const strokes = snapshot.strokes;
  let renderedCount = 0;
  let culledCount = 0;

  for (const stroke of strokes) {
    // Scene filtering already done in snapshot
    // Just check visibility
    if (!isStrokeVisible(stroke, visibleBounds)) {
      culledCount++;
      continue;
    }

    // Apply LOD: Skip tiny strokes (< 2px diagonal in screen space)
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
      `[Strokes] Rendered ${renderedCount}/${strokes.length} strokes (${culledCount} culled)`,
    );
  }
}

/**
 * Renders a single stroke.
 * Handles tool-specific rendering (pen vs highlighter).
 */
function renderStroke(
  ctx: CanvasRenderingContext2D,
  stroke: StrokeView,
  _viewTransform: ViewTransform,
): void {
  // Get or build render data
  const renderData = strokeCache.getOrBuild(stroke);

  if (renderData.pointCount < 2) {
    return; // Need at least 2 points for a line
  }

  // Save context state for this stroke
  ctx.save();

  // Apply stroke style
  ctx.strokeStyle = stroke.style.color;
  ctx.lineWidth = stroke.style.size; // World units - transform handles scaling
  ctx.globalAlpha = stroke.style.opacity;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // Tool-specific adjustments
  if (stroke.style.tool === 'highlighter') {
    // Highlighter uses normal blending at lower opacity
    // Default opacity is typically 0.25
    ctx.globalCompositeOperation = 'source-over';
  }

  // Stroke the path (with fallback for test environments)
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

  // Restore context state
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
