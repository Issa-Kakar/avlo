import { drawToolPreview, clearPreviewCache } from './layers/tool-preview';
import { useCameraStore } from '@/stores/camera-store';
import { getOverlayContext, applyPendingResize } from '@/runtime/SurfaceManager';
import { useDeviceUIStore } from '@/stores/device-ui-store';
import { getAnimationController, destroyAnimationController, EraserTrailAnimation, CursorAnimationJob } from './animation';

export class OverlayRenderLoop {
  private started = false;
  private rafId: number | null = null;
  private needsFrame = false;
  private cameraUnsubscribe: (() => void) | null = null;
  private toolUnsubscribe: (() => void) | null = null;

  // Independent resize detection
  private lastCanvasW = 0;
  private lastCanvasH = 0;

  start(): void {
    this.started = true;

    // Register animation jobs + wire push-based invalidation
    const controller = getAnimationController();
    controller.register(new EraserTrailAnimation());
    controller.register(new CursorAnimationJob());
    controller.setInvalidator(() => this.invalidateAll());

    // Subscribe to camera store — any change invalidates overlay
    this.cameraUnsubscribe = useCameraStore.subscribe(
      (state) => ({
        scale: state.scale,
        panX: state.pan.x,
        panY: state.pan.y,
        cssWidth: state.cssWidth,
        cssHeight: state.cssHeight,
        dpr: state.dpr,
      }),
      () => this.invalidateAll(),
      {
        equalityFn: (a, b) =>
          a.scale === b.scale &&
          a.panX === b.panX &&
          a.panY === b.panY &&
          a.cssWidth === b.cssWidth &&
          a.cssHeight === b.cssHeight &&
          a.dpr === b.dpr,
      },
    );

    // Clear cached preview when tool switches
    let lastTool = useDeviceUIStore.getState().activeTool;
    this.toolUnsubscribe = useDeviceUIStore.subscribe((state) => {
      if (state.activeTool !== lastTool) {
        lastTool = state.activeTool;
        clearPreviewCache();
        this.invalidateAll();
      }
    });
  }

  stop(): void {
    this.cameraUnsubscribe?.();
    this.cameraUnsubscribe = null;
    this.toolUnsubscribe?.();
    this.toolUnsubscribe = null;

    destroyAnimationController();

    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = null;
    this.needsFrame = false;
    this.started = false;
    this.lastCanvasW = 0;
    this.lastCanvasH = 0;
  }

  invalidateAll() {
    if (!this.needsFrame) {
      this.needsFrame = true;
      this.schedule();
    }
  }

  private schedule(): void {
    if (this.rafId || !this.started) return;
    this.rafId = requestAnimationFrame(() => {
      this.rafId = null;
      this.needsFrame = false;
      this.frame();
    });
  }

  private frame(): void {
    if (!this.started) return;
    applyPendingResize();

    const ctx = getOverlayContext();
    if (!ctx) return;

    // Detect canvas resize → schedule re-render
    if (ctx.canvas.width !== this.lastCanvasW || ctx.canvas.height !== this.lastCanvasH) {
      this.lastCanvasW = ctx.canvas.width;
      this.lastCanvasH = ctx.canvas.height;
      requestAnimationFrame(() => {
        if (this.started) this.invalidateAll();
      });
    }

    const { scale, pan, dpr, cssWidth, cssHeight } = useCameraStore.getState();
    if (cssWidth <= 1 || cssHeight <= 1) return;

    const now = performance.now();

    // Full clear
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cssWidth * dpr, cssHeight * dpr);
    ctx.restore();

    // World transform — applied ONCE for all world-space previews
    ctx.save();
    ctx.setTransform(dpr * scale, 0, 0, dpr * scale, -pan.x * dpr * scale, -pan.y * dpr * scale);
    drawToolPreview(ctx);
    ctx.restore();

    // Screen-space layers (each handles own DPR transform)
    getAnimationController().run(ctx, now);
  }
}

/** Module-level singleton — started/stopped by CanvasRuntime */
export const overlayLoop = new OverlayRenderLoop();

// =============================================
// MODULE-LEVEL INVALIDATION WRAPPERS
// =============================================

/** Invalidate the entire overlay canvas. Safe no-op before start(). */
export function invalidateOverlay(): void {
  overlayLoop.invalidateAll();
}

/** Hold preview for one frame during snapshot transitions. */
export { holdPreviewForOneFrame } from './layers/tool-preview';
