import { applyPendingResize, getOverlayContext } from '@/runtime/SurfaceManager';
import { subscribeCamera, useCameraStore } from '@/stores/camera-store';
import { useDeviceUIStore } from '@/stores/device-ui-store';
import { CursorAnimationJob, destroyAnimationController, EraserTrailAnimation, getAnimationController } from './animation';
import { drawToolPreview } from './layers/tool-preview';

export class OverlayRenderLoop {
  private started = false;
  private rafId: number | null = null;
  private cameraUnsubscribe: (() => void) | null = null;
  private toolUnsubscribe: (() => void) | null = null;

  // Independent resize detection
  private lastCanvasW = 0;
  private lastCanvasH = 0;

  start(): void {
    if (this.started) return;
    this.started = true;

    // Register animation jobs + wire push-based invalidation
    const controller = getAnimationController();
    controller.register(new EraserTrailAnimation());
    controller.register(new CursorAnimationJob());
    controller.setInvalidator(() => this.invalidateAll());

    // Subscribe to camera store — any change invalidates overlay
    this.cameraUnsubscribe = subscribeCamera(() => this.invalidateAll());

    // Evict any live preview when tool switches
    let lastTool = useDeviceUIStore.getState().activeTool;
    this.toolUnsubscribe = useDeviceUIStore.subscribe((state) => {
      if (state.activeTool !== lastTool) {
        lastTool = state.activeTool;
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

    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.started = false;
    this.lastCanvasW = 0;
    this.lastCanvasH = 0;
  }

  // Single-flag gate: rafId tracks "frame pending." started-guarded so pre-mount
  // invalidations (BC-delivered awareness/Y updates fire before Canvas mounts
  // when another tab is already open) can't pollute state.
  invalidateAll(): void {
    if (!this.started || this.rafId !== null) return;
    this.rafId = requestAnimationFrame(this.tick);
  }

  private tick = (): void => {
    this.rafId = null;
    if (!this.started) return;
    this.frame();
  };

  private frame(): void {
    applyPendingResize();

    const ctx = getOverlayContext();
    if (!ctx) return;

    // Resize detected → request another render. rafId was just cleared in tick,
    // so invalidateAll queues a fresh frame without fighting the gate.
    if (ctx.canvas.width !== this.lastCanvasW || ctx.canvas.height !== this.lastCanvasH) {
      this.lastCanvasW = ctx.canvas.width;
      this.lastCanvasH = ctx.canvas.height;
      this.invalidateAll();
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
