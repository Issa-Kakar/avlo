/**
 * Grid backend contract + the pick-best factory. Two interchangeable implementations sit behind
 * `GridBackend`: WebGPU (preferred — analytic shader, LOD crossfade) and Canvas2D (fallback —
 * createPattern tiles, hard band switch). The GridRenderLoop owns canvas sizing and the on/off
 * lifecycle; a backend only draws the current camera into whatever size the loop set.
 *
 * @module renderer/grid/grid-backend
 */

import { createCanvas2DGridBackend } from './grid-2d-backend';
import { createWebGPUGridBackend } from './grid-webgpu-backend';

export interface GridBackend {
  /** Which context this backend claimed on the canvas. A canvas is permanently locked to its
   * first getContext() type, so the loop must rebuild the SAME kind after a device loss. */
  readonly kind: 'webgpu' | '2d';
  /** Max backing-store dimension the backend can render (WebGPU: device limit; 2D: canvas cap). */
  readonly maxDim: number;
  /**
   * Draw the grid for the given camera. `panX/panY` are phase-reduced world coords (see
   * `reducePanPhase`); `dpr` is the effective device-pixel-ratio after the loop's size clamp.
   * The canvas backing store is already sized by the loop before this is called.
   */
  render(panX: number, panY: number, scale: number, dpr: number): void;
  /** Release the GPU swapchain / cached tiles (grid toggled off) — cheap re-enable, no full teardown. */
  unconfigure(): void;
  /** Full teardown (room unmount). WebGPU keeps its module-level device for fast re-init. */
  destroy(): void;
  /** True once the underlying GPU device is lost — the loop rebuilds the backend. Always false for 2D. */
  isLost(): boolean;
}

/**
 * Build the best available backend for `canvas`. Tries WebGPU (capability-probed WITHOUT
 * consuming the canvas context, so a failed probe leaves the canvas free for 2D); falls back
 * to Canvas2D otherwise.
 *
 * `webgpuOnly` is set by the loop when rebuilding after a device loss: the canvas is ALREADY
 * locked to the 'webgpu' context, so a Canvas2D fallback on it is impossible (getContext('2d')
 * would return null). In that case we return null (loop keeps retrying WebGPU on later events)
 * rather than claiming a doomed 2D context. First-build (webgpuOnly=false) only rejects in the
 * impossible case that even a fresh 2D context is refused.
 */
export async function createGridBackend(canvas: HTMLCanvasElement, webgpuOnly = false): Promise<GridBackend | null> {
  const webgpu = await createWebGPUGridBackend(canvas);
  if (webgpu) return webgpu;
  if (webgpuOnly) return null;
  return createCanvas2DGridBackend(canvas);
}
