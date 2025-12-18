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
  /** Last known cursor position - used to add points every frame */
  private lastActivePosition: { x: number; y: number } | null = null;
  /** Timestamp from last update() - used by render() for consistent timing */
  private lastUpdateTime = 0;

  /**
   * Called by EraserTool.begin() to start trail capture.
   */
  start(): void {
    this.active = true;
    this.points = [];
    this.lastActivePosition = null;
  }

  /**
   * Called by EraserTool.move() to update cursor position.
   * Actual point addition happens in update() every frame (matching old behavior).
   */
  addPoint(screenX: number, screenY: number, _now: number): void {
    if (!this.active) return;
    // Only update position - point addition happens in update()
    this.lastActivePosition = { x: screenX, y: screenY };
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
   * AnimationJob.update() - decay old points and add fresh point at cursor.
   * Called every frame by AnimationController.
   *
   * IMPORTANT: This matches the old updateEraserTrail() behavior where a point
   * was added EVERY FRAME (since TRAIL_MIN_DIST_PX=0 meant dist>=0 was always true).
   * Adding points every frame ensures all points have similar recent timestamps,
   * avoiding the "tadpole effect" where older points have different pressure.
   */
  update(now: number, _deltaMs: number): boolean {
    // Store timestamp for render() to use (ensures consistent timing)
    this.lastUpdateTime = now;

    // Remove expired points first
    this.points = this.points.filter((p) => now - p.t <= TRAIL_LIFETIME_MS);

    // While active, add a fresh point at cursor position EVERY FRAME.
    // This is the key fix - old code added a point every frame in the render loop.
    // Without this, points age unevenly causing the "tadpole" pulsing effect.
    if (this.active && this.lastActivePosition) {
      this.points.push({
        x: this.lastActivePosition.x,
        y: this.lastActivePosition.y,
        t: now,
      });

      // Limit points (matches old behavior)
      if (this.points.length > TRAIL_MAX_POINTS) {
        this.points.shift();
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

    // Use timestamp from update() for consistent timing (old code used same `now` for both)
    const now = this.lastUpdateTime;

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
    this.lastUpdateTime = 0;
  }
}
