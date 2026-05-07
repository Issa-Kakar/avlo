/**
 * HoldDetector — fires `onFire` after `DEFAULT_DWELL_MS` if the pointer hasn't
 * moved more than `jitterPx` (screen units). Pointer-event lifecycle, not
 * recognition. DrawingTool wires this to the $P recognizer for shape snap.
 */

const DEFAULT_DWELL_MS = 550;
const DEFAULT_JITTER_PX = 6;

export class HoldDetector {
  private timerId: number | null = null;
  private lastX = 0;
  private lastY = 0;
  private armed = false;

  constructor(
    private readonly onFire: () => void,
    private readonly dwellMs = DEFAULT_DWELL_MS,
    private readonly jitterPx = DEFAULT_JITTER_PX,
  ) {}

  start(screenPos: { x: number; y: number }): void {
    this.cancel();
    this.lastX = screenPos.x;
    this.lastY = screenPos.y;
    this.armed = true;
    this.timerId = window.setTimeout(this.onFire, this.dwellMs);
  }

  move(screenPos: { x: number; y: number }): void {
    if (!this.armed) return;
    const dx = screenPos.x - this.lastX;
    const dy = screenPos.y - this.lastY;
    if (dx * dx + dy * dy <= this.jitterPx * this.jitterPx) return;
    this.lastX = screenPos.x;
    this.lastY = screenPos.y;
    if (this.timerId !== null) clearTimeout(this.timerId);
    this.timerId = window.setTimeout(this.onFire, this.dwellMs);
  }

  cancel(): void {
    if (this.timerId !== null) {
      clearTimeout(this.timerId);
      this.timerId = null;
    }
    this.armed = false;
  }
}
