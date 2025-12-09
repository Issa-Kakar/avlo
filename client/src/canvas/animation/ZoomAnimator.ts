import { clampScale } from '../internal/transforms';
import { useCameraStore } from '@/stores/camera-store';

/**
 * ZoomAnimator - Smooth animated zoom/pan transitions
 *
 * Reads and writes directly to the camera store (no callback parameters).
 * Uses setScaleAndPan() for atomic updates during animation.
 */
export class ZoomAnimator {
  private active = false;
  private rafId: number | null = null;
  private targetScale = 1;
  private targetPan = { x: 0, y: 0 };
  private lastTime = 0;

  /**
   * No constructor parameters needed - reads/writes directly to camera store.
   */
  constructor() {}

  /**
   * Animate to target scale and pan position.
   * Uses exponential approach with ~120ms half-life for smooth feel.
   */
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

    // Read current state from camera store
    const { scale: currentScale, pan: currentPan } = useCameraStore.getState();

    // Exponential approach (~120ms half-life)
    const ZOOM_DAMPING = 18;
    const alpha = 1 - Math.exp(-ZOOM_DAMPING * dt);

    const newScale = currentScale + (this.targetScale - currentScale) * alpha;
    const newPan = {
      x: currentPan.x + (this.targetPan.x - currentPan.x) * alpha,
      y: currentPan.y + (this.targetPan.y - currentPan.y) * alpha,
    };

    // Atomic update to camera store
    useCameraStore.getState().setScaleAndPan(newScale, newPan);

    // Check convergence
    const scaleClose = Math.abs(newScale - this.targetScale) / this.targetScale < 0.001;
    const panClose = Math.hypot(newPan.x - this.targetPan.x, newPan.y - this.targetPan.y) < 0.01;

    if (!scaleClose || !panClose) {
      this.rafId = requestAnimationFrame(this.tick);
    } else {
      // Snap to exact target values on convergence
      useCameraStore.getState().setScaleAndPan(this.targetScale, this.targetPan);
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