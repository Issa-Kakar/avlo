import { drawBackground, drawObjects } from './layers';
import { FRAME_CONFIG } from './types';
import { useCameraStore, getVisibleWorldBounds, isMobile } from '@/stores/camera-store';
import { getBaseContext, applyPendingResize } from '@/canvas/SurfaceManager';
import { getCurrentSnapshot } from '@/canvas/room-runtime';
import type { WorldBounds, ViewTransform } from '@avlo/shared';
import { manageImageViewport } from '@/lib/image/image-manager';

const NATIVE_RAF = true; // true = vsync (no throttle), false = 60fps cap

// Dirty rect constants
const MAX_RECTS = 16;
const AA_MARGIN = 2; // device pixels
const AREA_RATIO = 0.33;
const COALESCE_SNAP = 2; // device pixels

export class RenderLoop {
  private started = false;
  private cameraUnsubscribe: (() => void) | null = null;

  // Inline dirty rect state (zero-allocation buffer)
  private readonly dirtyBuf = new Float64Array(MAX_RECTS * 4); // [minX,minY,maxX,maxY,...]
  private dirtyCount = 0;
  private fullClear = false;
  private canvasW = 0;
  private canvasH = 0;

  // Independent resize detection (not reliant on applyPendingResize return value)
  private lastCanvasW = 0;
  private lastCanvasH = 0;

  // Scheduling
  private rafId: number | null = null;
  private needsFrame = false;
  private urgent = false;
  private lastFrameTime = 0;
  private throttleTimeout: ReturnType<typeof setTimeout> | null = null;
  private nativeRafUntil = 0; // Bypass 60fps throttle until this timestamp (post-resize font warmup)

  // Visibility
  private isHidden = false;
  private hiddenIntervalId: number | null = null;

  constructor() {
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.handleVisibilityChange);
    }
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.lastFrameTime = performance.now();

    // Initialize canvas dimensions
    const { cssWidth, cssHeight, dpr } = useCameraStore.getState();
    this.canvasW = Math.round(cssWidth * dpr);
    this.canvasH = Math.round(cssHeight * dpr);
    this.lastCanvasW = this.canvasW;
    this.lastCanvasH = this.canvasH;

    // Any camera change → full clear + schedule frame
    this.cameraUnsubscribe = useCameraStore.subscribe(
      (state) => ({
        scale: state.scale,
        panX: state.pan.x,
        panY: state.pan.y,
        cssWidth: state.cssWidth,
        cssHeight: state.cssHeight,
        dpr: state.dpr,
      }),
      (curr) => {
        this.canvasW = Math.round(curr.cssWidth * curr.dpr);
        this.canvasH = Math.round(curr.cssHeight * curr.dpr);
        this.fullClear = true;
        this.dirtyCount = 0;
        this.markDirty();
      },
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

    if (document.hidden) this.startHiddenLoop();
  }

  stop(): void {
    this.cameraUnsubscribe?.();
    this.cameraUnsubscribe = null;

    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    if (this.hiddenIntervalId !== null) {
      clearInterval(this.hiddenIntervalId);
      this.hiddenIntervalId = null;
    }
    if (this.throttleTimeout !== null) {
      clearTimeout(this.throttleTimeout);
      this.throttleTimeout = null;
    }

    this.started = false;
    this.dirtyCount = 0;
    this.fullClear = false;
    this.needsFrame = false;
    this.urgent = false;
    this.lastFrameTime = 0;
    this.nativeRafUntil = 0;
    this.lastCanvasW = 0;
    this.lastCanvasH = 0;
  }

  destroy(): void {
    this.cameraUnsubscribe?.();
    this.cameraUnsubscribe = null;
    this.stop();
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.handleVisibilityChange);
    }
  }

  // =============================================
  // PUBLIC API
  // =============================================

  /** Add a world-space dirty rect. BBox must already include stroke width. */
  invalidateWorld(bounds: WorldBounds): void {
    if (!this.started || this.fullClear) return;

    const { scale, pan, dpr } = useCameraStore.getState();

    // World → device pixels with AA margin (no MAX_WORLD_LINE_WIDTH - bbox includes stroke)
    const i = this.dirtyCount * 4;
    this.dirtyBuf[i] = Math.floor((bounds.minX - pan.x) * scale * dpr - AA_MARGIN);
    this.dirtyBuf[i + 1] = Math.floor((bounds.minY - pan.y) * scale * dpr - AA_MARGIN);
    this.dirtyBuf[i + 2] = Math.ceil((bounds.maxX - pan.x) * scale * dpr + AA_MARGIN);
    this.dirtyBuf[i + 3] = Math.ceil((bounds.maxY - pan.y) * scale * dpr + AA_MARGIN);
    this.dirtyCount++;

    // Check promotion — coalesce before giving up on dirty rects
    if (this.dirtyCount >= MAX_RECTS) {
      this.coalesce();
      if (this.dirtyCount >= MAX_RECTS) {
        this.fullClear = true;
        this.dirtyCount = 0;
      }
    } else {
      this.checkAreaPromotion();
    }

    this.markDirty();
  }

  /** Force full clear on next frame. */
  invalidateAll(): void {
    this.fullClear = true;
    this.dirtyCount = 0;
    this.markDirty();
  }

  // =============================================
  // SCHEDULING
  // =============================================

  private markDirty(): void {
    if (!this.started) return;
    this.needsFrame = true;
    this.urgent = true;
    if (this.throttleTimeout !== null) {
      clearTimeout(this.throttleTimeout);
      this.throttleTimeout = null;
    }
    this.scheduleFrame();
  }

  private scheduleFrame(): void {
    if (!this.started || this.isHidden || this.rafId !== null) return;

    if (!NATIVE_RAF && !this.urgent && performance.now() >= this.nativeRafUntil) {
      const targetMs = 1000 / (isMobile() ? FRAME_CONFIG.MOBILE_FPS : FRAME_CONFIG.TARGET_FPS);
      const elapsed = performance.now() - this.lastFrameTime;
      if (elapsed < targetMs) {
        this.throttleTimeout = setTimeout(() => {
          this.throttleTimeout = null;
          this.scheduleFrame();
        }, targetMs - elapsed);
        return;
      }
    }

    this.rafId = requestAnimationFrame(() => {
      this.rafId = null;
      this.tick();
      if (this.needsFrame) {
        this.urgent = false;
        this.scheduleFrame();
      }
    });
  }

  // =============================================
  // MAIN TICK
  // =============================================

  private tick(): void {
    if (!this.started) return;
    this.lastFrameTime = performance.now();
    this.needsFrame = false;

    // 1. Get context
    const ctx = getBaseContext();
    if (!ctx) return;

    // 2. Apply pending resize + detect canvas dimension change independently
    applyPendingResize();
    if (ctx.canvas.width !== this.lastCanvasW || ctx.canvas.height !== this.lastCanvasH) {
      this.lastCanvasW = ctx.canvas.width;
      this.lastCanvasH = ctx.canvas.height;
      this.fullClear = true;
      this.dirtyCount = 0;
      // Render at native rAF (bypass 60fps throttle) for 150ms after context reset.
      // Continuous full redraws give the GPU multiple frames to warm font caches.
      this.nativeRafUntil = performance.now() + 150;
    }

    // 3. Read camera state (single read for entire frame)
    const { scale, pan, dpr, cssWidth, cssHeight } = useCameraStore.getState();
    if (cssWidth <= 0 || cssHeight <= 0) return;
    if (!isFinite(scale) || scale <= 0 || !isFinite(pan.x) || !isFinite(pan.y)) return;

    const pixelW = Math.round(cssWidth * dpr);
    const pixelH = Math.round(cssHeight * dpr);
    this.canvasW = pixelW;
    this.canvasH = pixelH;

    // 4. Read snapshot
    const snapshot = getCurrentSnapshot();

    // 5. Viewport-driven image management (decode visible, evict off-viewport, mip selection)
    manageImageViewport();

    // 6. Coalesce overlapping dirty rects
    if (this.dirtyCount > 1) this.coalesce();

    // 7. Determine clear mode
    const hasDirty = this.dirtyCount > 0;
    if (!this.fullClear && !hasDirty) return; // Nothing to do

    // 8. CLEAR PASS (identity transform)
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (this.fullClear) {
      ctx.clearRect(0, 0, pixelW, pixelH);
    } else {
      const buf = this.dirtyBuf;
      for (let i = 0; i < this.dirtyCount; i++) {
        const off = i * 4;
        ctx.clearRect(buf[off], buf[off + 1], buf[off + 2] - buf[off], buf[off + 3] - buf[off + 1]);
      }
    }
    ctx.restore();

    // 9. DRAW PASS (world transform)
    ctx.save();
    const s = dpr * scale;
    ctx.setTransform(s, 0, 0, s, -pan.x * s, -pan.y * s);

    const visibleBounds = getVisibleWorldBounds();

    // Build clip region from dirty rects (device px → world coords)
    let clipWorldRects: WorldBounds[] | undefined;
    if (!this.fullClear && hasDirty) {
      clipWorldRects = [];
      const invS = 1 / (scale * dpr);
      const buf = this.dirtyBuf;

      ctx.save();
      ctx.beginPath();
      for (let i = 0; i < this.dirtyCount; i++) {
        const off = i * 4;
        const wMinX = buf[off] * invS + pan.x;
        const wMinY = buf[off + 1] * invS + pan.y;
        const wMaxX = buf[off + 2] * invS + pan.x;
        const wMaxY = buf[off + 3] * invS + pan.y;
        ctx.rect(wMinX, wMinY, wMaxX - wMinX, wMaxY - wMinY);
        clipWorldRects.push({ minX: wMinX, minY: wMinY, maxX: wMaxX, maxY: wMaxY });
      }
      ctx.clip();
    }

    // Construct view transform inline (avoids second getState call)
    const view: ViewTransform = {
      worldToCanvas: (x, y) => [(x - pan.x) * scale, (y - pan.y) * scale],
      canvasToWorld: (x, y) => {
        const safeS = Math.max(1e-6, scale);
        return [x / safeS + pan.x, y / safeS + pan.y];
      },
      scale,
      pan,
    };

    const viewport = {
      pixelWidth: pixelW,
      pixelHeight: pixelH,
      cssWidth,
      cssHeight,
      dpr,
      visibleWorldBounds: visibleBounds,
      clipWorldRects,
    };

    drawBackground(ctx, snapshot, view, viewport);
    drawObjects(ctx, snapshot, view, viewport);

    if (clipWorldRects) ctx.restore();
    ctx.restore();

    // 10. Reset dirty state
    this.dirtyCount = 0;
    this.fullClear = false;

    // 11. Native rAF window: keep redrawing for GPU font cache warmup
    if (performance.now() < this.nativeRafUntil) {
      this.fullClear = true;
      this.needsFrame = true;
    }
  }

  // =============================================
  // COALESCE (in-place on buffer, O(n^2) with swap-remove)
  // =============================================

  private coalesce(): void {
    const buf = this.dirtyBuf;
    let count = this.dirtyCount;
    let merged = true;

    while (merged) {
      merged = false;
      for (let i = 0; i < count && !merged; i++) {
        const ai = i * 4;
        for (let j = i + 1; j < count; j++) {
          const bj = j * 4;
          // Check overlap with snap margin
          if (
            buf[ai] <= buf[bj + 2] + COALESCE_SNAP &&
            buf[ai + 2] >= buf[bj] - COALESCE_SNAP &&
            buf[ai + 1] <= buf[bj + 3] + COALESCE_SNAP &&
            buf[ai + 3] >= buf[bj + 1] - COALESCE_SNAP
          ) {
            // Merge j into i (expand bounds)
            if (buf[bj] < buf[ai]) buf[ai] = buf[bj];
            if (buf[bj + 1] < buf[ai + 1]) buf[ai + 1] = buf[bj + 1];
            if (buf[bj + 2] > buf[ai + 2]) buf[ai + 2] = buf[bj + 2];
            if (buf[bj + 3] > buf[ai + 3]) buf[ai + 3] = buf[bj + 3];
            // Swap-remove j
            count--;
            if (j < count) {
              const li = count * 4;
              buf[bj] = buf[li];
              buf[bj + 1] = buf[li + 1];
              buf[bj + 2] = buf[li + 2];
              buf[bj + 3] = buf[li + 3];
            }
            merged = true;
            break;
          }
        }
      }
    }

    this.dirtyCount = count;
    this.checkAreaPromotion();
  }

  private checkAreaPromotion(): void {
    if (this.dirtyCount === 0 || this.canvasW === 0 || this.canvasH === 0) return;
    const buf = this.dirtyBuf;
    let totalArea = 0;
    for (let i = 0; i < this.dirtyCount; i++) {
      const off = i * 4;
      totalArea += (buf[off + 2] - buf[off]) * (buf[off + 3] - buf[off + 1]);
    }
    if (totalArea / (this.canvasW * this.canvasH) > AREA_RATIO) {
      this.fullClear = true;
      this.dirtyCount = 0;
    }
  }

  // =============================================
  // VISIBILITY
  // =============================================

  private handleVisibilityChange = (): void => {
    this.isHidden = document.hidden;
    if (this.isHidden) {
      if (this.rafId !== null) {
        cancelAnimationFrame(this.rafId);
        this.rafId = null;
      }
      if (this.needsFrame) this.startHiddenLoop();
    } else {
      if (this.hiddenIntervalId !== null) {
        clearInterval(this.hiddenIntervalId);
        this.hiddenIntervalId = null;
      }
      if (this.needsFrame) this.scheduleFrame();
    }
  };

  private startHiddenLoop(): void {
    if (this.hiddenIntervalId || !this.started) return;
    this.hiddenIntervalId = window.setInterval(() => {
      if (this.started && this.needsFrame) {
        this.tick();
      } else if (!this.started && this.hiddenIntervalId !== null) {
        clearInterval(this.hiddenIntervalId);
        this.hiddenIntervalId = null;
      }
    }, 1000 / FRAME_CONFIG.HIDDEN_FPS);
  }
}
