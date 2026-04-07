import { useCameraStore, worldToCanvas } from '@/stores/camera-store';
import { setCursorOverride } from '@/stores/device-ui-store';
import { invalidateOverlay } from '@/renderer/OverlayRenderLoop';
import type { PointerTool, PreviewData } from './types';

// --- Momentum constants ---
const FRICTION = 4; // Decay rate (half-life ~173ms)
const MIN_COAST_SPEED = 100; // Screen px/s — below this don't start coasting
const STOP_SPEED = 60; // Screen px/s — ~1px/frame at 60fps, cuts floaty tail
const SAMPLE_WINDOW_MS = 80; // Recent samples for velocity calc
const MAX_SAMPLES = 8; // Buffer cap
const MAX_COAST_DT = 0.05; // 50ms cap per frame (prevents teleporting on tab switch)
const PAUSE_THRESHOLD_MS = 50; // Gap since last move event → user stopped before release
const MIN_COAST_DISP = 40; // Screen px — short displacement dampens coast proportionally
const MAX_COAST_VELOCITY = 3000; // Screen px/s — cap prevents extreme flings

export class PanTool implements PointerTool {
  private pointerId: number | null = null;
  private lastScreen: [number, number] | null = null;

  // Momentum state
  private samples: Array<{ x: number; y: number; t: number }> = [];
  private coastVx = 0;
  private coastVy = 0;
  private coastRafId: number | null = null;
  private coastLastTime = 0;

  constructor() {}

  canBegin(): boolean {
    return this.pointerId === null;
  }

  begin(pointerId: number, worldX: number, worldY: number): void {
    this.cancelCoast();
    this.pointerId = pointerId;
    this.lastScreen = worldToCanvas(worldX, worldY);
    this.samples.length = 0;
    setCursorOverride('grabbing');
    invalidateOverlay();
  }

  move(worldX: number, worldY: number): void {
    if (!this.lastScreen) return;

    const currentScreen = worldToCanvas(worldX, worldY);
    const dx = currentScreen[0] - this.lastScreen[0];
    const dy = currentScreen[1] - this.lastScreen[1];
    this.lastScreen = currentScreen;

    // Track screen position for velocity calculation
    const now = performance.now();
    this.samples.push({ x: currentScreen[0], y: currentScreen[1], t: now });
    while (this.samples.length > MAX_SAMPLES || (this.samples.length > 1 && now - this.samples[0].t > SAMPLE_WINDOW_MS)) {
      this.samples.shift();
    }

    const { scale, pan, setPan } = useCameraStore.getState();
    setPan({
      x: pan.x - dx / scale,
      y: pan.y - dy / scale,
    });
    invalidateOverlay();
  }

  end(_worldX?: number, _worldY?: number): void {
    // Pause detection: if no pointer event for PAUSE_THRESHOLD_MS before release,
    // user intentionally stopped — don't coast. Browsers only fire pointermove
    // when the pointer actually moves, so a gap = the pointer was stationary.
    const now = performance.now();
    const lastSampleTime = this.samples.length > 0 ? this.samples[this.samples.length - 1].t : 0;

    let velocity: { vx: number; vy: number };
    if (now - lastSampleTime > PAUSE_THRESHOLD_MS) {
      velocity = { vx: 0, vy: 0 };
    } else {
      velocity = this.computeReleaseVelocity();
    }

    this.pointerId = null;
    this.lastScreen = null;
    this.samples.length = 0;
    setCursorOverride(null);
    invalidateOverlay();

    const speed = Math.hypot(velocity.vx, velocity.vy);
    if (speed > MIN_COAST_SPEED) {
      this.startCoast(velocity.vx, velocity.vy);
    }
  }

  cancel(): void {
    this.cancelCoast();
    this.pointerId = null;
    this.lastScreen = null;
    this.samples.length = 0;
    setCursorOverride(null);
    invalidateOverlay();
  }

  isActive(): boolean {
    return this.pointerId !== null;
  }

  getPointerId(): number | null {
    return this.pointerId;
  }

  getPreview(): PreviewData | null {
    return null;
  }

  onPointerLeave(): void {}

  onViewChange(): void {}

  destroy(): void {
    this.cancelCoast();
    this.cancel();
  }

  // --- Momentum ---

  cancelCoast(): void {
    if (this.coastRafId !== null) {
      cancelAnimationFrame(this.coastRafId);
      this.coastRafId = null;
    }
  }

  private computeReleaseVelocity(): { vx: number; vy: number } {
    if (this.samples.length < 2) return { vx: 0, vy: 0 };

    const last = this.samples[this.samples.length - 1];
    const first = this.samples[0];

    // Stillness check: if the last few samples show the pointer barely moving,
    // user decelerated to a stop — don't coast even if earlier samples were fast.
    const recentIdx = Math.max(0, this.samples.length - 3);
    const recent = this.samples[recentIdx];
    const recentDt = (last.t - recent.t) / 1000;
    if (recentDt > 0.001) {
      const recentSpeed = Math.hypot(last.x - recent.x, last.y - recent.y) / recentDt;
      if (recentSpeed < MIN_COAST_SPEED) return { vx: 0, vy: 0 };
    }

    // Window velocity (first → last)
    const dt = (last.t - first.t) / 1000;
    if (dt < 0.001) return { vx: 0, vy: 0 };

    let vx = (last.x - first.x) / dt;
    let vy = (last.y - first.y) / dt;

    // Displacement dampening: a short jerk (tiny total movement) shouldn't
    // produce a proportional coast. Scale velocity by displacement ratio.
    const disp = Math.hypot(last.x - first.x, last.y - first.y);
    const dispFactor = Math.min(disp / MIN_COAST_DISP, 1);
    vx *= dispFactor;
    vy *= dispFactor;

    // Cap extreme velocities
    const speed = Math.hypot(vx, vy);
    if (speed > MAX_COAST_VELOCITY) {
      const cap = MAX_COAST_VELOCITY / speed;
      vx *= cap;
      vy *= cap;
    }

    return { vx, vy };
  }

  private startCoast(vx: number, vy: number): void {
    this.coastVx = vx;
    this.coastVy = vy;
    this.coastLastTime = performance.now();
    this.coastRafId = requestAnimationFrame(this.coastTick);
  }

  private coastTick = (): void => {
    const now = performance.now();
    const dt = Math.min((now - this.coastLastTime) / 1000, MAX_COAST_DT);
    this.coastLastTime = now;

    // Exponential friction decay (frame-rate independent)
    const decay = Math.exp(-FRICTION * dt);
    this.coastVx *= decay;
    this.coastVy *= decay;

    // Convert screen velocity to world pan delta
    const { scale, pan, setPan } = useCameraStore.getState();
    setPan({
      x: pan.x - (this.coastVx * dt) / scale,
      y: pan.y - (this.coastVy * dt) / scale,
    });

    const speed = Math.hypot(this.coastVx, this.coastVy);
    if (speed > STOP_SPEED) {
      this.coastRafId = requestAnimationFrame(this.coastTick);
    } else {
      this.coastRafId = null;
    }
  };
}
