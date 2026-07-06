/**
 * EraserTrailAnimation - Eraser trail visual effect
 *
 * Screen-space fading trail behind the eraser cursor.
 * Lifecycle: EraserTool.begin() → start(), .move() → addPoint(), .end() → stop()
 *
 * @module canvas/animation/EraserTrailAnimation
 */

import { useCameraStore } from '@/stores/camera-store';
import { clamp01 } from '@/utils/math';
import { traceEraserTrail } from '../freehand';
import type { AnimationJob } from './AnimationController';

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
        const age = clamp01((now - p.t) / TRAIL_LIFETIME_MS);
        const strength = 1 - age;
        const eased = 1 - (1 - strength) * (1 - strength);
        return [p.x, p.y, eased] as [number, number, number];
      });

      ctx.save();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = TRAIL_BASE_ALPHA;
      ctx.fillStyle = 'rgb(140, 140, 140)';
      ctx.beginPath();
      traceEraserTrail(ctx, pfPoints, TRAIL_BASE_WIDTH_PX);
      ctx.fill();
      ctx.restore();
    }

    return this.active || this.points.length > 0;
  }

  destroy(): void {
    this.points = [];
    this.active = false;
    this.lastActivePosition = null;
  }
}
