/**
 * HoldDetector - Detects when the pointer dwells in roughly the same position for a period of time
 *
 * Fires a callback after a specified dwell time (default 600ms) if the pointer
 * hasn't moved more than a jitter threshold (default 6px in screen space).
 *
 * Used by DrawingTool to trigger perfect shape recognition when the user
 * intentionally pauses during drawing.
 */
export class HoldDetector {
  private timerId: number | null = null;
  private lastPos: { x: number; y: number } | null = null;

  constructor(
    private onFire: () => void,
    private dwellMs = 600,
    private jitterPx = 6  // Screen space threshold
  ) {}

  start(screenPos: { x: number; y: number }) {
    this.cancel();
    this.lastPos = screenPos;
    this.timerId = window.setTimeout(this.onFire, this.dwellMs);
  }

  move(screenPos: { x: number; y: number }) {
    if (!this.lastPos) return;

    const dist = Math.hypot(
      screenPos.x - this.lastPos.x,
      screenPos.y - this.lastPos.y
    );

    if (dist > this.jitterPx) {
      // Movement exceeded jitter - reset timer
      this.lastPos = screenPos;
      if (this.timerId) clearTimeout(this.timerId);
      this.timerId = window.setTimeout(this.onFire, this.dwellMs);
    }
    // If within jitter, timer continues unchanged
  }

  cancel() {
    if (this.timerId) {
      clearTimeout(this.timerId);
      this.timerId = null;
    }
    this.lastPos = null;
  }
}