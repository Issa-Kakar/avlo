/**
 * GridRenderLoop — orchestrates the third (WebGPU/Canvas2D) canvas that renders the dot grid
 * BELOW all content. Mirrors OverlayRenderLoop's lifecycle shape but is standalone: it owns its
 * own canvas sizing (including the unique 0×0-when-off behavior that drops the backing store) and
 * an on-demand rAF, and it reads the shared camera transform directly.
 *
 * Memory: nothing is allocated until the first enable — no getContext, no adapter, no device. The
 * backend is created lazily on the first frame where `gridEnabled` is true; toggling off releases
 * the swapchain (backend.unconfigure) and drops the backing store to 0×0, keeping the lightweight
 * device resident for an instant re-toggle.
 *
 * @module renderer/grid/GridRenderLoop
 */

import { subscribeCamera, useCameraStore } from '@/stores/camera-store';
import { selectGridEnabled, useDeviceUIStore } from '@/stores/device-ui-store';
import { createGridBackend, type GridBackend } from './grid-backend';
import { reducePanPhase } from './grid-params';

// requestAnimationFrame is paused in hidden tabs; a scheduled grid frame then falls back to this
// timer so a real change (camera/toggle) still repaints and never leaves a stuck pending flag.
const HIDDEN_FRAME_MS = 250;

export class GridRenderLoop {
  private started = false;
  private rafId: number | null = null;
  private timerId: ReturnType<typeof setTimeout> | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private backend: GridBackend | null = null;
  private backendKind: 'webgpu' | '2d' | null = null;
  private backendPending = false;
  private cameraUnsub: (() => void) | null = null;
  private gridUnsub: (() => void) | null = null;
  private readonly reducedPan: [number, number] = [0, 0];

  start(canvas: HTMLCanvasElement): void {
    if (this.started) return;
    this.started = true;
    this.canvas = canvas;

    // Pan/zoom/resize/DPR and grid on/off are the only repaint triggers. Both just schedule a
    // frame; frame() decides enable vs disable. (When off, the scheduled frame is a cheap no-op.)
    this.cameraUnsub = subscribeCamera(this.schedule);
    this.gridUnsub = useDeviceUIStore.subscribe(selectGridEnabled, this.schedule);
    document.addEventListener('visibilitychange', this.onVisibilityChange);

    // Always run one frame: enabled → first render; disabled → drop the backing store from the
    // HTML canvas default (300×150) to 0×0. The off-frame allocates nothing (no getContext/device).
    this.schedule();
  }

  stop(): void {
    this.cameraUnsub?.();
    this.cameraUnsub = null;
    this.gridUnsub?.();
    this.gridUnsub = null;
    document.removeEventListener('visibilitychange', this.onVisibilityChange);

    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    if (this.timerId !== null) {
      clearTimeout(this.timerId);
      this.timerId = null;
    }

    this.backend?.destroy();
    this.backend = null;
    this.backendKind = null;
    // backendPending is intentionally NOT reset — an in-flight init resolves against a null
    // canvas / mismatched canvas and self-destructs (see frame()), so it can't leak or double-init.

    if (this.canvas) {
      this.canvas.width = 0;
      this.canvas.height = 0;
    }
    this.canvas = null;
    this.started = false;
  }

  // Single-flag gate: rafId/timerId track "frame pending." started-guarded so pre-mount camera
  // updates can't schedule work before start(). rAF when visible; a timer when hidden (rAF is
  // paused in background tabs — without the fallback a scheduled frame would stick until return).
  private schedule = (): void => {
    if (!this.started || this.rafId !== null || this.timerId !== null) return;
    if (typeof document !== 'undefined' && document.hidden) {
      this.timerId = setTimeout(this.pump, HIDDEN_FRAME_MS);
    } else {
      this.rafId = requestAnimationFrame(this.pump);
    }
  };

  private pump = (): void => {
    this.rafId = null;
    this.timerId = null;
    if (this.started) this.frame();
  };

  // Re-pick rAF vs timer for a pending frame across the transition, and ALWAYS repaint when the
  // tab becomes visible — a backgrounded tab may have had its canvas backing store evicted, which
  // would otherwise leave the grid blank until the next camera move.
  private onVisibilityChange = (): void => {
    const pending = this.rafId !== null || this.timerId !== null;
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    if (this.timerId !== null) {
      clearTimeout(this.timerId);
      this.timerId = null;
    }
    if (pending || !document.hidden) this.schedule();
  };

  private frame(): void {
    const canvas = this.canvas;
    if (!canvas) return;

    const enabled = useDeviceUIStore.getState().gridEnabled;
    if (!enabled) {
      // Release the swapchain + drop the backing store — near-zero memory while off. The backend
      // instance is kept for an instant re-toggle (reconfigures on the next enabled frame).
      this.backend?.unconfigure();
      if (canvas.width !== 0 || canvas.height !== 0) {
        canvas.width = 0;
        canvas.height = 0;
      }
      return;
    }

    // Lazy backend init — the first place anything (context/adapter/device) is allocated. On a
    // post-device-loss rebuild the canvas is already locked to 'webgpu', so restrict to WebGPU
    // (a 2D fallback on that canvas is impossible); createGridBackend then returns null if WebGPU
    // is momentarily unavailable, and we retry on the next camera/toggle event instead of spinning.
    if (!this.backend) {
      if (!this.backendPending) {
        this.backendPending = true;
        createGridBackend(canvas, this.backendKind === 'webgpu')
          .then((backend) => {
            this.backendPending = false;
            // Commit only if we're still the live loop on the same canvas; otherwise the loop was
            // stopped or remounted (new room) while awaiting — discard this backend. A null backend
            // (WebGPU-only rebuild, still unavailable) also falls to the discard branch.
            if (backend && this.started && this.canvas === canvas) {
              this.backend = backend;
              this.backendKind = backend.kind;
              this.schedule();
            } else {
              backend?.destroy();
            }
          })
          .catch((err) => {
            this.backendPending = false;
            // No reschedule: a hard failure (even Canvas2D refused) shouldn't spin. The next
            // camera move or toggle naturally retries.
            console.error('[grid] backend init failed:', err);
          });
      }
      return;
    }

    // GPU device lost → tear down and rebuild on the next frame.
    if (this.backend.isLost()) {
      this.backend.destroy();
      this.backend = null;
      this.schedule();
      return;
    }

    const { scale, pan, dpr, cssWidth, cssHeight } = useCameraStore.getState();
    if (cssWidth <= 1 || cssHeight <= 1) return;

    // Backing store = round(css × dpr), clamped to the backend's max dimension. The camera dpr is
    // already SurfaceManager-clamped to 16384; this second clamp only bites when WebGPU's
    // maxTextureDimension2D is smaller. Scaling both axes by the same factor (→ effective dpr)
    // keeps the CSS-stretched grid perfectly world-aligned with the base canvas.
    const maxDim = this.backend.maxDim;
    let dw = Math.round(cssWidth * dpr);
    let dh = Math.round(cssHeight * dpr);
    let effDpr = dpr;
    const k = Math.min(1, maxDim / dw, maxDim / dh);
    if (k < 1) {
      dw = Math.floor(dw * k);
      dh = Math.floor(dh * k);
      effDpr = dpr * k;
    }
    if (canvas.width !== dw || canvas.height !== dh) {
      canvas.width = dw;
      canvas.height = dh;
    }

    reducePanPhase(pan.x, pan.y, scale, this.reducedPan);
    this.backend.render(this.reducedPan[0], this.reducedPan[1], scale, effDpr);
  }
}

/** Module-level singleton — started/stopped by CanvasRuntime. */
export const gridLoop = new GridRenderLoop();
