import type { PresenceView, ViewTransform, Snapshot } from '@avlo/shared';
import type { PreviewData } from '@/lib/tools/types';
import { drawPreview, } from './layers/preview';
import { drawDimmedStrokes } from './layers/eraser-dim';
import { drawPerfectShapePreview } from './layers/perfect-shape-preview';
import { getStroke } from 'perfect-freehand';
import { getSvgPathFromStroke } from './stroke-builder/pf-svg';

// Eraser Trail configuration
interface EraserTrailPoint {
  x: number; // CSS pixels
  y: number; // CSS pixels
  t: number; // timestamp
}
const TRAIL_LIFETIME_MS = 200;
const TRAIL_MIN_DIST_PX = 0;
const TRAIL_MAX_POINTS = 10;
const TRAIL_BASE_WIDTH_PX = 14;
const TRAIL_BASE_ALPHA = 0.35;
export interface PreviewProvider {
  getPreview(): PreviewData | null;
}

export interface OverlayLoopConfig {
  stage: {
    withContext: (fn: (ctx: CanvasRenderingContext2D) => void) => void;
    clear: () => void;
  };
  getView: () => ViewTransform;
  getViewport: () => { cssWidth: number; cssHeight: number; dpr: number };
  getGates: () => { awarenessReady: boolean; firstSnapshot: boolean };
  getPresence: () => PresenceView;
  getSnapshot: () => Snapshot; // Added for eraser dimming
  drawPresence: (
    ctx: CanvasRenderingContext2D,
    presence: PresenceView,
    view: ViewTransform,
    viewport: { cssWidth: number; cssHeight: number; dpr: number },
  ) => void;
}

export class OverlayRenderLoop {
  private config: OverlayLoopConfig | null = null;
  private rafId: number | null = null;
  private needsFrame = false;
  private previewProvider: PreviewProvider | null = null;
  private cachedPreview: PreviewData | null = null;
  private holdPreviewOneFrame = false;
  private eraserTrail: EraserTrailPoint[] | null = null;

  start(config: OverlayLoopConfig) {
    this.config = config;
    this.eraserTrail = [];
  }

  stop() {
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = null;
    this.needsFrame = false;
    this.config = null;
  }

  setPreviewProvider(provider: PreviewProvider | null): void {
    this.previewProvider = provider;
    // Always invalidate to ensure preview updates or clears
    this.invalidateAll();

    // Clear cached preview when provider is removed
    if (!provider) {
      this.cachedPreview = null;
      this.holdPreviewOneFrame = false;
    }
  }

  invalidateAll() {
    if (!this.needsFrame) {
      this.needsFrame = true;
      this.schedule();
    }
  }

  holdPreviewForOneFrame(): void {
    if (this.previewProvider?.getPreview()?.kind === 'eraser') return;
    this.holdPreviewOneFrame = true;
    this.invalidateAll(); // Ensure we draw a frame
  }

  private schedule() {
    if (this.rafId || !this.config) return;
    this.rafId = requestAnimationFrame(() => {
      this.rafId = null;
      this.needsFrame = false;
      this.frame();
    });
  }

  private updateEraserTrail(screenX: number, screenY: number, now: number): void {
    // Remove old points
    this.eraserTrail = this.eraserTrail?.filter(p => now - p.t <= TRAIL_LIFETIME_MS) ?? [];

    const last = this.eraserTrail[this.eraserTrail.length - 1];
    if (!last) {
      this.eraserTrail.push({ x: screenX, y: screenY, t: now });
      return;
    }

    const dx = screenX - last.x;
    const dy = screenY - last.y;
    const dist = Math.hypot(dx, dy);

    if (dist >= TRAIL_MIN_DIST_PX) {
      this.eraserTrail.push({ x: screenX, y: screenY, t: now });
    } else {
      // Keep dot alive when stationary
      last.x = screenX;
      last.y = screenY;
      last.t = now;
    }

    // Limit points
    if (this.eraserTrail.length > TRAIL_MAX_POINTS) {
      this.eraserTrail.splice(0, this.eraserTrail.length - TRAIL_MAX_POINTS);
    }
  }

  private hasEraserTrail(): boolean {
    return !!(this.eraserTrail && this.eraserTrail.length > 0);
  }

  private decayEraserTrail(now: number): void {
    if (!this.eraserTrail || this.eraserTrail.length === 0) return;
    this.eraserTrail = this.eraserTrail.filter(p => now - p.t <= TRAIL_LIFETIME_MS);
  }

  private drawEraserTrail(ctx: CanvasRenderingContext2D, now: number, _dpr: number): void {
    if (!this.eraserTrail || this.eraserTrail.length < 2) return;

    // Map to perfect-freehand points with age-based pressure
    const pfPoints = this.eraserTrail.map((p) => {
      const age = Math.max(0, Math.min(1, (now - p.t) / TRAIL_LIFETIME_MS));
      const strength = 1 - age;
      const eased = 1 - (1 - strength) * (1 - strength); // easeOutQuad
      return [p.x, p.y, eased] as [number, number, number];
    });

    const outline = getStroke(pfPoints, {

      size: TRAIL_BASE_WIDTH_PX,
      thinning: 0.5,
      smoothing: 0.7,
      streamline: 0.40,
      simulatePressure:true,
      easing: (t: number) => -t * t + 2 * t,
      start: {
        easing: (t: number) => t,
        cap: true,
      },
      end: {
        // easing: (t: number) => t,
        cap: true,
        easing: (t: number) => t,
        taper: 0
      },
    });
    if (!outline.length) return;

    const path = new Path2D(getSvgPathFromStroke(outline, false));

    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = TRAIL_BASE_ALPHA;
    ctx.fillStyle = 'rgb(140, 140, 140)';
    ctx.fill(path);
    ctx.restore();
  }

  private frame() {
    if (!this.config) return;
    const { stage, getView, getViewport, getPresence, getGates, drawPresence, getSnapshot } =
      this.config;

    // Get viewport first to check if ready
    const vp = getViewport();
    if (vp.cssWidth <= 1 || vp.cssHeight <= 1) return;

    // Always full clear overlay (cheap for preview + presence)
    stage.clear();

    const view = getView();

    // ---------- PASS 1: World-space preview (with world transform) ----------
    const preview = this.previewProvider?.getPreview();
    const now = performance.now();
    // Cache the latest preview if we have one
    if (preview && preview.kind !== 'eraser') {
      this.cachedPreview = preview;
    }
    // Draw preview if we have one OR if holding cached for one frame
    const usingCached =
    !preview && this.holdPreviewOneFrame && this.cachedPreview;
    const previewToDraw = preview || (usingCached && this.cachedPreview) || null;

  if (previewToDraw && previewToDraw.kind === 'eraser') {
    const [screenX, screenY] = view.worldToCanvas(
      previewToDraw.circle.cx,
      previewToDraw.circle.cy,
    );
    this.updateEraserTrail(screenX, screenY, now);
  } else {
    this.decayEraserTrail(now);
  }
    if (previewToDraw) {
      stage.withContext((ctx) => {
        // Check preview kind using discriminant
        if (previewToDraw?.kind === 'stroke') {
          // Existing stroke preview (world space)
          ctx.save();
          ctx.scale(view.scale, view.scale);
          ctx.translate(-view.pan.x, -view.pan.y);
          drawPreview(ctx, previewToDraw); // Existing preview function
          ctx.restore();

        } else if (previewToDraw?.kind === 'eraser') {
          // New eraser preview (two passes)
          const snapshot = getSnapshot();
          
          // Pass A: World-space dimming
          if (previewToDraw.hitIds.length > 0) {
            ctx.save();
            ctx.scale(view.scale, view.scale);
            ctx.translate(-view.pan.x, -view.pan.y);
            drawDimmedStrokes(ctx, previewToDraw.hitIds, snapshot, previewToDraw.dimOpacity);
            ctx.restore();
          }

          // Pass B: Screen-space trail (no cursor ring)
          ctx.save();
          ctx.setTransform(vp.dpr, 0, 0, vp.dpr, 0, 0);
          this.drawEraserTrail(ctx, now, vp.dpr);
          ctx.restore();

        } else if (previewToDraw?.kind === 'text') {
          // Text preview (world space)
          ctx.save();
          ctx.scale(view.scale, view.scale);
          ctx.translate(-view.pan.x, -view.pan.y);

          // Draw placement box with dashed outline
          ctx.strokeStyle = previewToDraw.isPlacing
            ? 'rgba(59, 130, 246, 0.5)'
            : 'rgba(0, 0, 0, 0.3)';
          ctx.lineWidth = 2 / view.scale; // Keep consistent visual thickness
          ctx.setLineDash([4, 4]);
          ctx.strokeRect(
            previewToDraw.box.x,
            previewToDraw.box.y,
            previewToDraw.box.w,
            previewToDraw.box.h,
          );

          // Optional: Draw placement crosshair
          if (previewToDraw.isPlacing) {
            ctx.strokeStyle = 'rgba(59, 130, 246, 0.3)';
            ctx.lineWidth = 1 / view.scale;
            ctx.setLineDash([]);
            // Vertical line
            ctx.beginPath();
            ctx.moveTo(previewToDraw.box.x, previewToDraw.box.y - 5);
            ctx.lineTo(previewToDraw.box.x, previewToDraw.box.y + 5);
            ctx.stroke();
            // Horizontal line
            ctx.beginPath();
            ctx.moveTo(previewToDraw.box.x - 5, previewToDraw.box.y);
            ctx.lineTo(previewToDraw.box.x + 5, previewToDraw.box.y);
            ctx.stroke();
          }

          ctx.restore();
        } else if (previewToDraw?.kind === 'perfectShape') {
          // Perfect shape preview (world space)
          ctx.save();
          ctx.scale(view.scale, view.scale);
          ctx.translate(-view.pan.x, -view.pan.y);
          drawPerfectShapePreview(ctx, previewToDraw);
          ctx.restore();

        } else if (previewToDraw?.kind === 'selection') {
          // Selection preview (world space for bounds, screen space for handle sizing)
          ctx.save();
          ctx.scale(view.scale, view.scale);
          ctx.translate(-view.pan.x, -view.pan.y);

          // Draw marquee rect if active (dashed, light blue fill)
          if (previewToDraw.marqueeRect) {
            const { minX, minY, maxX, maxY } = previewToDraw.marqueeRect;
            ctx.fillStyle = 'rgba(59, 130, 246, 0.08)';
            ctx.fillRect(minX, minY, maxX - minX, maxY - minY);
            ctx.strokeStyle = 'rgba(59, 130, 246, 0.6)';
            ctx.lineWidth = 1 / view.scale;
            ctx.setLineDash([4 / view.scale, 4 / view.scale]);
            ctx.strokeRect(minX, minY, maxX - minX, maxY - minY);
            ctx.setLineDash([]);
          }

          // Draw selection bounds and handles (skip during active transform)
          if (previewToDraw.selectionBounds && !previewToDraw.isTransforming) {
            const { minX, minY, maxX, maxY } = previewToDraw.selectionBounds;

            // Selection box stroke
            ctx.strokeStyle = 'rgba(59, 130, 246, 1)';
            ctx.lineWidth = 1.5 / view.scale;
            ctx.strokeRect(minX, minY, maxX - minX, maxY - minY);

            // Corner handles (8px screen size, scaled to world)
            if (previewToDraw.handles) {
              const handleSize = 8 / view.scale;
              ctx.fillStyle = 'white';
              ctx.strokeStyle = 'rgba(59, 130, 246, 1)';
              ctx.lineWidth = 1.5 / view.scale;

              for (const h of previewToDraw.handles) {
                ctx.fillRect(
                  h.x - handleSize / 2,
                  h.y - handleSize / 2,
                  handleSize,
                  handleSize
                );
                ctx.strokeRect(
                  h.x - handleSize / 2,
                  h.y - handleSize / 2,
                  handleSize,
                  handleSize
                );
              }
            }
          }

          ctx.restore();
        }
      });

      // Clear the hold flag and cache after drawing the held frame
      if (this.holdPreviewOneFrame && !preview) {
        this.holdPreviewOneFrame = false;
        this.cachedPreview = null;
      }
    }

    // ---------- PASS 2: Screen-space presence (DPR only) ----------
    const gates = getGates();
    if (gates.awarenessReady && gates.firstSnapshot) {
      const presence = getPresence();
      stage.withContext((ctx) => {
        drawPresence(ctx, presence, view, vp);
      });
    }
    if (this.hasEraserTrail()) this.invalidateAll();
  }

  // Keep animating if trail exists

  destroy() {
    this.stop();
    this.previewProvider = null;
  }
}