/**
 * EraserTrailAnimation - Eraser trail visual effect
 *
 * Screen-space fading trail behind the eraser cursor.
 * Lifecycle: EraserTool.begin() → start(), .move() → addPoint(), .end() → stop()
 *
 * @module canvas/animation/EraserTrailAnimation
 */

import type { AnimationJob } from './AnimationController';
import { useCameraStore } from '@/stores/camera-store';
import { getStroke } from 'perfect-freehand';
import { getSvgPathFromStroke } from '@/renderer/types';

const TRAIL_LIFETIME_MS = 200;
const TRAIL_MAX_POINTS = 10;
const TRAIL_BASE_WIDTH_PX = 14;
const TRAIL_BASE_ALPHA = 0.35;

interface TrailPoint {
  x: number; // CSS pixels (screen space)
  y: number;
  t: number;
}

export class EraserTrailAnimation implements AnimationJob {
  readonly id = 'eraser-trail';

  private points: TrailPoint[] = [];
  private active = false;
  private lastActivePosition: { x: number; y: number } | null = null;

  start(): void {
    this.active = true;
    this.points = [];
    this.lastActivePosition = null;
  }

  addPoint(screenX: number, screenY: number, _now: number): void {
    if (!this.active) return;
    this.lastActivePosition = { x: screenX, y: screenY };
  }

  stop(): void {
    this.active = false;
    this.lastActivePosition = null;
  }

  frame(ctx: CanvasRenderingContext2D, now: number, _dt: number): boolean {
    // Decay old points
    this.points = this.points.filter((p) => now - p.t <= TRAIL_LIFETIME_MS);

    // Add point every frame while active (prevents tadpole effect)
    if (this.active && this.lastActivePosition) {
      this.points.push({
        x: this.lastActivePosition.x,
        y: this.lastActivePosition.y,
        t: now,
      });
      if (this.points.length > TRAIL_MAX_POINTS) {
        this.points.shift();
      }
    }

    // Render
    if (this.points.length >= 2) {
      const { dpr } = useCameraStore.getState();

      const pfPoints = this.points.map((p) => {
        const age = Math.max(0, Math.min(1, (now - p.t) / TRAIL_LIFETIME_MS));
        const strength = 1 - age;
        const eased = 1 - (1 - strength) * (1 - strength);
        return [p.x, p.y, eased] as [number, number, number];
      });

      const outline = getStroke(pfPoints, {
        size: TRAIL_BASE_WIDTH_PX,
        thinning: 0.5,
        smoothing: 0.7,
        streamline: 0.4,
        simulatePressure: true,
        easing: (t: number) => -t * t + 2 * t,
        start: { easing: (t: number) => t, cap: true },
        end: { cap: true, easing: (t: number) => t, taper: 0 },
      });

      if (outline.length) {
        const path = new Path2D(getSvgPathFromStroke(outline, false));
        ctx.save();
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = TRAIL_BASE_ALPHA;
        ctx.fillStyle = 'rgb(140, 140, 140)';
        ctx.fill(path);
        ctx.restore();
      }
    }

    return this.active || this.points.length > 0;
  }

  destroy(): void {
    this.points = [];
    this.active = false;
    this.lastActivePosition = null;
  }
}
