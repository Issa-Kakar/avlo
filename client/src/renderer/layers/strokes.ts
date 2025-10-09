import type { Snapshot, StrokeView, ViewTransform } from '@avlo/shared';
import type { ViewportInfo } from '../types';
import { getStrokeCacheInstance, isStrokeVisible } from '../stroke-builder';

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
    // FREEHAND (PF polygon) → fill
    ctx.fillStyle = stroke.style.color;
    if (renderData.path) {
      ctx.fill(renderData.path);
    } else {
      // Rare test fallback (no Path2D)
      ctx.beginPath();
      const pg = renderData.polygon;
      ctx.moveTo(pg[0], pg[1]);
      for (let i = 2; i < pg.length; i += 2) {
        ctx.lineTo(pg[i], pg[i + 1]);
      }
      ctx.closePath();
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
