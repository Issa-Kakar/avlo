/**
 * AnimationController - Centralized animation job manager
 *
 * Manages all time-based animations (eraser trail, presence cursors, future transitions).
 * Decouples animation state updates from the overlay render loop.
 *
 * Pattern:
 * - OverlayRenderLoop calls tick() + render() each frame
 * - Animation jobs update their state in tick()
 * - Animation jobs draw their visuals in render()
 * - hasActiveAnimations() tells the render loop whether to continue animating
 *
 * @module canvas/animation/AnimationController
 */

import type { ViewTransform } from '@avlo/shared';
import type { ViewportInfo } from '@/renderer/types';

/**
 * Animation job interface - implemented by each animation type.
 * Jobs manage their own state and rendering.
 */
export interface AnimationJob {
  /** Unique identifier for this job */
  readonly id: string;

  /**
   * Update animation state.
   * Called every frame by AnimationController.tick().
   * @param now - Current timestamp (performance.now())
   * @param deltaMs - Time since last tick in milliseconds
   * @returns true if animation should continue, false if completed
   */
  update(now: number, deltaMs: number): boolean;

  /**
   * Render current animation state to canvas.
   * Called every frame by AnimationController.render().
   * Context is in screen space (DPR transform already applied).
   */
  render(
    ctx: CanvasRenderingContext2D,
    viewport: ViewportInfo,
    view: ViewTransform
  ): void;

  /**
   * Check if animation has work to do.
   * Used to determine if render loop should continue.
   */
  isActive(): boolean;

  /** Clean up resources */
  destroy(): void;
}

/**
 * Centralized animation job manager.
 * Singleton pattern - access via getAnimationController().
 */
class AnimationController {
  private jobs = new Map<string, AnimationJob>();
  private lastTickTime = 0;

  /**
   * Register an animation job.
   * Jobs are identified by their id property.
   */
  register(job: AnimationJob): void {
    this.jobs.set(job.id, job);
  }

  /**
   * Unregister and destroy a job.
   */
  unregister(id: string): void {
    const job = this.jobs.get(id);
    if (job) {
      job.destroy();
      this.jobs.delete(id);
    }
  }

  /**
   * Get a registered job by ID.
   * Use type parameter to get correct type.
   */
  get<T extends AnimationJob>(id: string): T | undefined {
    return this.jobs.get(id) as T | undefined;
  }

  /**
   * Tick all animations - called from OverlayRenderLoop.frame().
   * Updates animation state (decay trails, interpolate positions, etc.)
   */
  tick(now: number): void {
    const deltaMs = this.lastTickTime > 0 ? now - this.lastTickTime : 0;
    this.lastTickTime = now;

    for (const job of this.jobs.values()) {
      job.update(now, deltaMs);
    }
  }

  /**
   * Render all active animations - called from OverlayRenderLoop.frame().
   * Context should be in screen space (DPR transform applied).
   */
  render(
    ctx: CanvasRenderingContext2D,
    viewport: ViewportInfo,
    view: ViewTransform
  ): void {
    for (const job of this.jobs.values()) {
      if (job.isActive()) {
        job.render(ctx, viewport, view);
      }
    }
  }

  /**
   * Check if any animations need continued frames.
   * Used by OverlayRenderLoop to self-invalidate.
   */
  hasActiveAnimations(): boolean {
    for (const job of this.jobs.values()) {
      if (job.isActive()) return true;
    }
    return false;
  }

  /**
   * Destroy all jobs and reset state.
   */
  destroy(): void {
    for (const job of this.jobs.values()) {
      job.destroy();
    }
    this.jobs.clear();
    this.lastTickTime = 0;
  }
}

// Module-level singleton
let controller: AnimationController | null = null;

/**
 * Get the animation controller singleton.
 * Creates one if it doesn't exist.
 */
export function getAnimationController(): AnimationController {
  if (!controller) {
    controller = new AnimationController();
  }
  return controller;
}

/**
 * Destroy the animation controller singleton.
 * Called on canvas unmount.
 */
export function destroyAnimationController(): void {
  controller?.destroy();
  controller = null;
}
