import { clampScale } from '../internal/transforms';

export class ZoomAnimator {
  private active = false;
  private rafId: number | null = null;
  private targetScale = 1;
  private targetPan = { x: 0, y: 0 };
  private lastTime = 0;

  constructor(
    private getView: () => { scale: number; pan: { x: number; y: number } },
    private setScale: (scale: number) => void,
    private setPan: (pan: { x: number; y: number }) => void,
  ) {}

  to(targetScale: number, targetPan: { x: number; y: number }) {
    this.targetScale = clampScale(targetScale);
    this.targetPan = targetPan;

    if (!this.active) {
      this.active = true;
      this.lastTime = performance.now();
      this.rafId = requestAnimationFrame(this.tick);
    }
  }

  private tick = (now: number) => {
    const dt = Math.min(0.05, (now - this.lastTime) / 1000);
    this.lastTime = now;

    const v = this.getView();

    // Exponential approach (~120ms half-life)
    const ZOOM_DAMPING = 18;
    const alpha = 1 - Math.exp(-ZOOM_DAMPING * dt);

    const scale = v.scale + (this.targetScale - v.scale) * alpha;
    const pan = {
      x: v.pan.x + (this.targetPan.x - v.pan.x) * alpha,
      y: v.pan.y + (this.targetPan.y - v.pan.y) * alpha,
    };

    this.setScale(scale);
    this.setPan(pan);

    // Check convergence
    const scaleClose = Math.abs(scale - this.targetScale) / this.targetScale < 0.001;
    const panClose = Math.hypot(pan.x - this.targetPan.x, pan.y - this.targetPan.y) < 0.01;

    if (!scaleClose || !panClose) {
      this.rafId = requestAnimationFrame(this.tick);
    } else {
      this.setScale(this.targetScale);
      this.setPan(this.targetPan);
      this.active = false;
      this.rafId = null;
    }
  };

  destroy() {
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.active = false;
  }
}