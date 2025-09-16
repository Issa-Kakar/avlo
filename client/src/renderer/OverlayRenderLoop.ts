import type { PresenceView, ViewTransform } from '@avlo/shared';
import type { PreviewData } from '@/lib/tools/types';
import { drawPreview } from './layers/preview';

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
    const { stage, getView, getViewport, getPresence, getGates, drawPresence } = this.config;

    // Get viewport first to check if ready
    const vp = getViewport();
    if (vp.cssWidth <= 1 || vp.cssHeight <= 1) return;

    // Always full clear overlay (cheap for preview + presence)
    stage.clear();

    const view = getView();

    // ---------- PASS 1: World-space preview (with world transform) ----------
    const preview = this.previewProvider?.getPreview();
    if (preview) {
      stage.withContext((ctx) => {
        // Apply world transform for preview rendering
        ctx.save();
        ctx.scale(view.scale, view.scale);
        ctx.translate(-view.pan.x, -view.pan.y);

        // Draw preview in world coordinates
        drawPreview(ctx, preview);

        ctx.restore();
      });
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