import type { Snapshot, ViewTransform } from '@avlo/shared';
import { CANVAS_STYLE_CONFIG as Cfg } from '@avlo/shared';
import type { ViewportInfo } from '../types';
import type { GateStatus } from '@/hooks/use-connection-gates';
import { drawCursors } from './presence-cursors';

// Re-export the actual implementation
export { drawStrokes, clearStrokeCache } from './strokes';

// Import new implementations
export { drawText } from './text';

// NEW: ID-keyed geometry cache eviction (used by Canvas on bbox changes/removals)
import { getStrokeCacheInstance } from '../stroke-builder/stroke-cache';

export function invalidateStrokeCacheByIds(ids: Iterable<string>) {
  getStrokeCacheInstance().invalidateMany(ids);
}

// Helper functions for adaptive grid
function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

function invLerp(a: number, b: number, v: number) {
  return Math.max(0, Math.min(1, (v - a) / (b - a)));
}

// Piecewise opacity curve
function gridAlpha(scale: number): number {
  if (scale <= Cfg.GRID_SWITCH_TO_40_AT) {
    // 0.25x → 0.5x
    const t = invLerp(Cfg.GRID_HIDE_BELOW, Cfg.GRID_SWITCH_TO_40_AT, Math.max(scale, Cfg.GRID_HIDE_BELOW));
    return lerp(Cfg.GRID_OPACITY_AT_025X, Cfg.GRID_OPACITY_AT_05X, t);
  }
  if (scale <= 1) {
    const t = invLerp(Cfg.GRID_SWITCH_TO_40_AT, 1, scale);
    return lerp(Cfg.GRID_OPACITY_AT_05X, Cfg.GRID_OPACITY_AT_1X, t);
  }
  if (scale <= Cfg.GRID_SWITCH_TO_10_AT) {
    const t = invLerp(1, Cfg.GRID_SWITCH_TO_10_AT, scale);
    return lerp(Cfg.GRID_OPACITY_AT_1X, Cfg.GRID_OPACITY_AT_2X, t);
  }
  return Cfg.GRID_OPACITY_AT_2X;
}

function drawDotLayer(
  ctx: CanvasRenderingContext2D,
  spacing: number,
  view: ViewTransform,
  viewport: ViewportInfo,
  radiusPx: number,
  alpha: number,
) {
  if (alpha <= 0) return;

  // Optional dot growth above 1x with cap
  const px = Cfg.GRID_DOT_SCALE_ABOVE_1X
    ? Math.min(radiusPx * Math.sqrt(Math.max(1, view.scale)), Cfg.GRID_DOT_RADIUS_CAP_PX)
    : radiusPx;

  const rWorld = px / view.scale;

  const [minWX, minWY] = view.canvasToWorld(0, 0);
  const [maxWX, maxWY] = view.canvasToWorld(viewport.cssWidth, viewport.cssHeight);

  const startX = Math.floor(minWX / spacing) * spacing;
  const startY = Math.floor(minWY / spacing) * spacing;
  const endX = Math.ceil(maxWX / spacing) * spacing;
  const endY = Math.ceil(maxWY / spacing) * spacing;

  // NO transform application here - the world transform is already applied by RenderLoop!
  // We draw directly in the already-transformed context
  ctx.save();
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = Cfg.GRID_COLOR;
  ctx.globalAlpha = alpha;

  // ✅ FIX: Use immediate-mode path on the context (no Path2D)
  // This avoids the browser/driver bug with Path2D + thousands of tiny arcs
  ctx.beginPath();
  for (let x = startX; x <= endX; x += spacing) {
    for (let y = startY; y <= endY; y += spacing) {
      // Start a new subpath for each dot to avoid connectors
      ctx.moveTo(x + rWorld, y);
      ctx.arc(x, y, rWorld, 0, Math.PI * 2);
    }
  }
  ctx.fill();
  ctx.restore();
}

export function drawBackground(
  ctx: CanvasRenderingContext2D,
  _snapshot: Snapshot,
  view: ViewTransform,
  viewport: ViewportInfo,
): void {
  // IMPORTANT: This function is called with the world transform already applied by RenderLoop
  // We need to temporarily reset it for the solid background, then work in world space for dots

  // Step 1: Draw solid background at IDENTITY in DEVICE pixels
  // ✅ This exactly matches the clear pass in RenderLoop (lines 326-327) to prevent seams
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0); // Identity transform
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  ctx.fillStyle = Cfg.BACKGROUND_COLOR;
  ctx.fillRect(0, 0, viewport.pixelWidth, viewport.pixelHeight); // Device pixels, not CSS pixels
  ctx.restore();
  // After restore(), we're back to the world transform that RenderLoop applied

  // Step 2: Draw dots in world space (transform already applied)
  // Early exit if grid is disabled
  if (!Cfg.GRID_ENABLED) return;

  const s = view.scale;
  const baseAlpha = gridAlpha(s);
  const dotRadiusPx = Cfg.GRID_DOT_RADIUS_PX;

  // Early-out below hide threshold, but fade in/out across a small band
  const b025 = Cfg.GRID_BAND_NEAR_025;
  if (s < Cfg.GRID_HIDE_BELOW - b025) return;
  if (s < Cfg.GRID_HIDE_BELOW + b025) {
    const t = invLerp(Cfg.GRID_HIDE_BELOW - b025, Cfg.GRID_HIDE_BELOW + b025, s);
    drawDotLayer(ctx, Cfg.GRID_SPACING_BIG_40, view, viewport, dotRadiusPx, baseAlpha * t);
    return;
  }

  // 40px ↔ 20px near 0.5x
  const b05 = Cfg.GRID_BAND_NEAR_05;
  if (s < Cfg.GRID_SWITCH_TO_40_AT - b05) {
    drawDotLayer(ctx, Cfg.GRID_SPACING_BIG_40, view, viewport, dotRadiusPx, baseAlpha);
    return;
  }
  if (s < Cfg.GRID_SWITCH_TO_40_AT + b05) {
    const t = invLerp(Cfg.GRID_SWITCH_TO_40_AT - b05, Cfg.GRID_SWITCH_TO_40_AT + b05, s);
    drawDotLayer(ctx, Cfg.GRID_SPACING_BIG_40, view, viewport, dotRadiusPx, baseAlpha * (1 - t));
    drawDotLayer(ctx, Cfg.GRID_SPACING_BASE_20, view, viewport, dotRadiusPx, baseAlpha * t);
    return;
  }

  // 20px ↔ 10px near 2x
  const b2 = Cfg.GRID_BAND_NEAR_2;
  if (s < Cfg.GRID_SWITCH_TO_10_AT - b2) {
    drawDotLayer(ctx, Cfg.GRID_SPACING_BASE_20, view, viewport, dotRadiusPx, baseAlpha);
    return;
  }
  if (s < Cfg.GRID_SWITCH_TO_10_AT + b2) {
    const t = invLerp(Cfg.GRID_SWITCH_TO_10_AT - b2, Cfg.GRID_SWITCH_TO_10_AT + b2, s);
    drawDotLayer(ctx, Cfg.GRID_SPACING_BASE_20, view, viewport, dotRadiusPx, baseAlpha * (1 - t));
    drawDotLayer(ctx, Cfg.GRID_SPACING_SUB_10, view, viewport, dotRadiusPx, baseAlpha * t);
    return;
  }

  // ≥ 2x
  drawDotLayer(ctx, Cfg.GRID_SPACING_SUB_10, view, viewport, dotRadiusPx, baseAlpha);
}

export function drawShapes(
  _ctx: CanvasRenderingContext2D,
  _snapshot: Snapshot,
  _view: ViewTransform,
  _viewport: ViewportInfo,
): void {
  // Placeholder for future shape rendering
  // Stamps have been removed in favor of perfect shapes
}

// drawText is now imported from './text'

export function drawAuthoringOverlays(
  _ctx: CanvasRenderingContext2D,
  _snapshot: Snapshot,
  _view: ViewTransform,
  _viewport: ViewportInfo,
): void {
  // Future: Selection boxes, handles, text cursor
  if (import.meta.env.DEV && import.meta.env.VITE_DEBUG_RENDER_LAYERS) {
    // eslint-disable-next-line no-console
    console.log('[Layer] Authoring Overlays');
  }
}

export function drawPresenceOverlays(
  ctx: CanvasRenderingContext2D,
  snapshot: Snapshot,
  view: ViewTransform,
  _viewport: ViewportInfo,
  gates: GateStatus,
): void {
  // Phase 7: Cursors and trails implementation
  // CRITICAL GATE CHECK: Only render when BOTH gates are open
  // - G_AWARENESS_READY: Ensures awareness channel is live (WS or RTC)
  // - G_FIRST_SNAPSHOT: Ensures we have valid doc data to render against
  // Without both, cursors are hidden immediately

  if (import.meta.env.DEV && import.meta.env.VITE_DEBUG_RENDER_LAYERS) {
    // eslint-disable-next-line no-console
    console.log('[Layer] Presence Overlays', {
      awarenessReady: gates.awarenessReady,
      firstSnapshot: gates.firstSnapshot,
      userCount: snapshot.presence.users.size,
    });
  }

  // Draw cursors with trails (Phase 7)
  drawCursors(ctx, snapshot.presence, view, {
    awarenessReady: gates.awarenessReady,
    firstSnapshot: gates.firstSnapshot,
  });
}

export function drawHUD(
  _ctx: CanvasRenderingContext2D,
  _snapshot: Snapshot,
  _view: ViewTransform,
  _viewport: ViewportInfo,
): void {
  // Future: Minimap, toasts, update prompts
  // Note: Never included in export
  if (import.meta.env.DEV && import.meta.env.VITE_DEBUG_RENDER_LAYERS) {
    // eslint-disable-next-line no-console
    console.log('[Layer] HUD');
  }
}
