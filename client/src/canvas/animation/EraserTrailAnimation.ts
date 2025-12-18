/**
 * EraserTrailAnimation - Eraser trail visual effect
 *
 * Renders a smooth, fading trail behind the eraser cursor.
 * Trail is in screen space (follows cursor visually, stable during pan/zoom).
 *
 * Lifecycle:
 * - EraserTool.begin() → start()
 * - EraserTool.move() → addPoint()
 * - EraserTool.end() → stop() (trail decays naturally)
 *
 * @module canvas/animation/EraserTrailAnimation
 */

import type { AnimationJob } from './AnimationController';
import type { ViewTransform } from '@avlo/shared';
import type { ViewportInfo } from '@/renderer/types';
import { getStroke } from 'perfect-freehand';
import { getSvgPathFromStroke } from '@/renderer/types';

// Configuration
const TRAIL_LIFETIME_MS = 200;
const TRAIL_MAX_POINTS = 10;
const TRAIL_BASE_WIDTH_PX = 14;
const TRAIL_BASE_ALPHA = 0.35;

interface TrailPoint {
  x: number; // CSS pixels (screen space)
  y: number; // CSS pixels (screen space)
  t: number; // timestamp
}

export class EraserTrailAnimation implements AnimationJob {
  readonly id = 'eraser-trail';

  private points: TrailPoint[] = [];
  private active = false;
  /** Last known cursor position - used to keep dot alive while stationary */
  private lastActivePosition: { x: number; y: number } | null = null;

  /**
   * Called by EraserTool.begin() to start trail capture.
   */
  start(): void {
    this.active = true;
    this.points = [];
    this.lastActivePosition = null;
  }

  /**
   * Called by EraserTool.move() to add a point.
   * Points are in screen space (CSS pixels).
   * Always adds a new point (matching old TRAIL_MIN_DIST_PX = 0 behavior).
   */
  addPoint(screenX: number, screenY: number, now: number): void {
    if (!this.active) return;

    // Track last position for keep-alive during stationary periods
    this.lastActivePosition = { x: screenX, y: screenY };

    // Always push a new point (old code had dist >= 0 which is always true)
    this.points.push({ x: screenX, y: screenY, t: now });

    // Limit points
    if (this.points.length > TRAIL_MAX_POINTS) {
      this.points.shift();
    }
  }

  /**
   * Called by EraserTool.end() to stop trail capture.
   * Trail continues to decay until all points expire.
   */
  stop(): void {
    this.active = false;
    this.lastActivePosition = null;
    // Don't clear points - let them decay naturally
  }

  /**
   * AnimationJob.update() - decay old points and maintain cursor dot.
   * Called every frame by AnimationController.
   */
  update(now: number, _deltaMs: number): boolean {
    // Remove expired points
    this.points = this.points.filter((p) => now - p.t <= TRAIL_LIFETIME_MS);

    // While active, ensure we always have at least 2 points at the cursor
    // position so the dot renders even when stationary (render needs 2+ points)
    if (this.active && this.lastActivePosition) {
      while (this.points.length < 2) {
        this.points.push({
          x: this.lastActivePosition.x,
          y: this.lastActivePosition.y,
          t: now,
        });
      }
    }

    // Return true if we still have points (need more frames)
    return this.points.length > 0;
  }

  /**
   * AnimationJob.render() - draw trail in screen space.
   * Context is already in screen space (DPR transform applied by caller).
   */
  render(
    ctx: CanvasRenderingContext2D,
    _viewport: ViewportInfo,
    _view: ViewTransform
  ): void {
    if (this.points.length < 2) return;

    const now = performance.now();

    // Map to perfect-freehand points with age-based pressure
    const pfPoints = this.points.map((p) => {
      const age = Math.max(0, Math.min(1, (now - p.t) / TRAIL_LIFETIME_MS));
      const strength = 1 - age;
      const eased = 1 - (1 - strength) * (1 - strength); // easeOutQuad
      return [p.x, p.y, eased] as [number, number, number];
    });

    const outline = getStroke(pfPoints, {
      size: TRAIL_BASE_WIDTH_PX,
      thinning: 0.5,
      smoothing: 0.7,
      streamline: 0.4,
      simulatePressure: true,
      easing: (t: number) => -t * t + 2 * t,
      start: {
        easing: (t: number) => t,
        cap: true,
      },
      end: {
        cap: true,
        easing: (t: number) => t,
        taper: 0,
      },
    });

    if (!outline.length) return;

    const path = new Path2D(getSvgPathFromStroke(outline, false));

    // Render in screen space (DPR transform already applied by overlay loop)
    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = TRAIL_BASE_ALPHA;
    ctx.fillStyle = 'rgb(140, 140, 140)';
    ctx.fill(path);
    ctx.restore();
  }

  /**
   * AnimationJob.isActive() - trail has visual content to render.
   */
  isActive(): boolean {
    return this.active || this.points.length > 0;
  }

  /**
   * AnimationJob.destroy() - clean up.
   */
  destroy(): void {
    this.points = [];
    this.active = false;
    this.lastActivePosition = null;
  }
}
