/**
 * WebGPU grid backend — the preferred path. One long-lived module-level `GPUDevice` (created
 * lazily on first enable, shared across room navigations for instant re-init), a full-screen
 * triangle + analytic dot shader, and a single 32-byte uniform. On-demand rendering: a fresh
 * `getCurrentTexture()` each frame, cleared to transparent, one `draw(3)`, submit. No work when
 * the camera is static (the loop only calls render on a real change).
 *
 * @module renderer/grid/grid-webgpu-backend
 */

import gridShader from './grid.wgsl?raw';
import type { GridBackend } from './grid-backend';
import { GRID } from './grid-params';

// One device for the whole app. Survives backend destroy() (room unmount) so a later room mount
// or grid re-enable skips the ~10ms adapter/device handshake. Nulled only on a non-'destroyed'
// device loss, after which the next getGridDevice() rebuilds it.
let sharedDevice: GPUDevice | null = null;
let devicePromise: Promise<GPUDevice | null> | null = null;

async function createDevice(): Promise<GPUDevice | null> {
  if (!navigator.gpu) return null;
  let adapter: GPUAdapter | null = null;
  try {
    adapter = await navigator.gpu.requestAdapter();
  } catch {
    adapter = null;
  }
  if (!adapter) return null;

  let device: GPUDevice;
  try {
    device = await adapter.requestDevice();
  } catch {
    return null;
  }

  device.lost.then((info) => {
    // 'destroyed' = we called device.destroy() (intentional). Anything else is a real loss
    // (GPU reset, driver crash) → drop the singleton so the loop rebuilds the backend.
    if (info.reason !== 'destroyed') {
      console.warn('[grid] WebGPU device lost — will rebuild:', info.message);
      if (sharedDevice === device) sharedDevice = null;
    }
  });
  device.addEventListener('uncapturederror', (event) => {
    console.error('[grid] WebGPU uncaptured error:', (event as GPUUncapturedErrorEvent).error);
  });

  sharedDevice = device;
  return device;
}

async function getGridDevice(): Promise<GPUDevice | null> {
  if (sharedDevice) return sharedDevice;
  if (devicePromise) return devicePromise; // coalesce concurrent callers
  devicePromise = createDevice();
  const device = await devicePromise;
  devicePromise = null; // clear so a null (transient failure) or a later loss can retry
  return device;
}

class WebGPUGridBackend implements GridBackend {
  readonly kind = 'webgpu' as const;
  readonly maxDim: number;
  private readonly uni = new Float32Array(8); // [panX, panY, scale, dpr, r, g, b, alphaMax]
  private configured = false;

  constructor(
    private readonly device: GPUDevice,
    private readonly ctx: GPUCanvasContext,
    private readonly format: GPUTextureFormat,
    private readonly pipeline: GPURenderPipeline,
    private readonly buffer: GPUBuffer,
    private readonly bindGroup: GPUBindGroup,
  ) {
    this.maxDim = device.limits.maxTextureDimension2D;
  }

  private ensureConfigured(): void {
    if (this.configured) return;
    // The drawing buffer tracks canvas.width/height automatically — configure once, never on
    // resize. Re-runs only after an unconfigure() (grid toggled off then on).
    this.ctx.configure({ device: this.device, format: this.format, alphaMode: 'premultiplied' });
    this.configured = true;
  }

  render(panX: number, panY: number, scale: number, dpr: number): void {
    this.ensureConfigured();

    const u = this.uni;
    u[0] = panX;
    u[1] = panY;
    u[2] = scale;
    u[3] = dpr;
    u[4] = GRID.colorRgb[0];
    u[5] = GRID.colorRgb[1];
    u[6] = GRID.colorRgb[2];
    u[7] = GRID.alphaMax;
    this.device.queue.writeBuffer(this.buffer, 0, u);

    const view = this.ctx.getCurrentTexture().createView();
    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } }],
    });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.draw(3);
    pass.end();
    this.device.queue.submit([encoder.finish()]);
  }

  unconfigure(): void {
    if (!this.configured) return;
    this.ctx.unconfigure(); // releases the swapchain textures
    this.configured = false;
  }

  destroy(): void {
    this.unconfigure();
    this.buffer.destroy();
    // sharedDevice is deliberately kept alive for a fast re-init on the next room/enable.
  }

  isLost(): boolean {
    return sharedDevice === null || this.device !== sharedDevice;
  }
}

/**
 * Build the WebGPU backend for `canvas`, or `null` if WebGPU is unavailable/unusable. The canvas
 * context is claimed LAST — device, shader, pipeline and buffers are all built first — so any
 * failure (no adapter, WGSL compile error) leaves the canvas untouched for the Canvas2D fallback
 * (a canvas is permanently locked to its first getContext() type).
 */
export async function createWebGPUGridBackend(canvas: HTMLCanvasElement): Promise<GridBackend | null> {
  const device = await getGridDevice();
  if (!device) return null;

  const constants: Record<string, number> = {
    BASE: GRID.bandRatio,
    MIN_PX: GRID.minPxCss,
    DOT_R: GRID.dotRadiusCss,
    DOT_R_MAX: GRID.dotRadiusMaxCss,
    BASE_SP: GRID.baseSpacing,
  };
  const format = navigator.gpu.getPreferredCanvasFormat();
  const module = device.createShaderModule({ code: gridShader });

  let pipeline: GPURenderPipeline;
  try {
    pipeline = await device.createRenderPipelineAsync({
      layout: 'auto',
      vertex: { module, entryPoint: 'vs' },
      // No blend: the full-screen triangle writes each pixel once with premultiplied output.
      fragment: { module, entryPoint: 'fs', constants, targets: [{ format }] },
      primitive: { topology: 'triangle-list' },
    });
  } catch (err) {
    console.error('[grid] WebGPU pipeline creation failed — falling back to Canvas2D:', err);
    return null; // canvas untouched → 2D fallback still works
  }

  const buffer = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [{ binding: 0, resource: { buffer } }],
  });

  const ctx = canvas.getContext('webgpu'); // claim the canvas — everything above succeeded
  if (!ctx) {
    buffer.destroy();
    return null;
  }

  return new WebGPUGridBackend(device, ctx, format, pipeline, buffer, bindGroup);
}
