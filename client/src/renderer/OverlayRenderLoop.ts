import type { PresenceView, ViewTransform, Snapshot } from '@avlo/shared';
import type { PreviewData } from '@/lib/tools/types';
import { drawPreview } from './layers/preview';
import { drawDimmedStrokes } from './layers/eraser-dim';

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

  start(config: OverlayLoopConfig) {
    this.config = config;
  }

  stop() {
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = null;
    this.needsFrame = false;
    this.config = null;
  }

  setPreviewProvider(provider: PreviewProvider | null): void {
    this.previewProvider = provider;
    if (provider && provider.getPreview()) {
      this.invalidateAll();
    }
  }

  invalidateAll() {
    if (!this.needsFrame) {
      this.needsFrame = true;
      this.schedule();
    }
  }

  holdPreviewForOneFrame(): void {
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

  private frame() {
    if (!this.config) return;
    const { stage, getView, getViewport, getPresence, getGates, drawPresence, getSnapshot } = this.config;

    // Get viewport first to check if ready
    const vp = getViewport();
    if (vp.cssWidth <= 1 || vp.cssHeight <= 1) return;

    // Always full clear overlay (cheap for preview + presence)
    stage.clear();

    const view = getView();

    // ---------- PASS 1: World-space preview (with world transform) ----------
    const preview = this.previewProvider?.getPreview();

    // Cache the latest preview if we have one
    if (preview) {
      this.cachedPreview = preview;
    }

    // Draw preview if we have one OR if holding cached for one frame
    const previewToDraw = preview || (this.holdPreviewOneFrame && this.cachedPreview);
    if (previewToDraw) {
      stage.withContext((ctx) => {
        // Check preview kind using discriminant
        if (previewToDraw.kind === 'stroke') {
          // Existing stroke preview (world space)
          ctx.save();
          ctx.scale(view.scale, view.scale);
          ctx.translate(-view.pan.x, -view.pan.y);
          drawPreview(ctx, previewToDraw); // Existing preview function
          ctx.restore();

        } else if (previewToDraw.kind === 'eraser') {
          // New eraser preview (two passes)
          const snapshot = getSnapshot(); // Need snapshot for dimming

          // Pass A: Dim hit strokes (world space)
          if (previewToDraw.hitIds.length > 0) {
            ctx.save();
            ctx.scale(view.scale, view.scale);
            ctx.translate(-view.pan.x, -view.pan.y);
            // Import drawDimmedStrokes from new eraser-dim layer
            drawDimmedStrokes(ctx, previewToDraw.hitIds, snapshot, previewToDraw.dimOpacity);
            ctx.restore();
          }

          // Pass B: Draw cursor circle (screen space)
          ctx.save();
          // Apply only DPR, no world transform
          ctx.setTransform(vp.dpr, 0, 0, vp.dpr, 0, 0);

          // Transform cursor position to screen
          const [screenX, screenY] = view.worldToCanvas(
            previewToDraw.circle.cx,
            previewToDraw.circle.cy
          );

          // Draw circle outline
          ctx.strokeStyle = 'rgba(0, 0, 0, 0.8)';
          ctx.lineWidth = 1; // Device pixel for crisp line
          ctx.beginPath();
          ctx.arc(screenX, screenY, previewToDraw.circle.r_px, 0, Math.PI * 2);
          ctx.stroke();

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
  }

  destroy() {
    this.stop();
    this.previewProvider = null;
  }
}