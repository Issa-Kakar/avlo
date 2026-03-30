/**
 * AnimationController - Centralized animation job manager
 *
 * Push-based invalidation: jobs return true from frame() to request more frames,
 * controller calls invalidate() to schedule the next overlay render.
 *
 * @module canvas/animation/AnimationController
 */

/**
 * Animation job interface - implemented by each animation type.
 * frame() merges update + render into a single call.
 */
export interface AnimationJob {
  readonly id: string;

  /**
   * Update state + render. Returns true if the job needs another frame.
   * Each job handles its own coordinate space (save/restore + setTransform).
   */
  frame(ctx: CanvasRenderingContext2D, now: number, dt: number): boolean;

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
  private invalidate: (() => void) | null = null;

  /** Wire the overlay loop's invalidateAll — called once at startup. */
  setInvalidator(fn: () => void): void {
    this.invalidate = fn;
  }

  /** Register an animation job. */
  register(job: AnimationJob): void {
    this.jobs.set(job.id, job);
  }

  /** Unregister and destroy a job. */
  unregister(id: string): void {
    const job = this.jobs.get(id);
    if (job) {
      job.destroy();
      this.jobs.delete(id);
    }
  }

  /** Get a registered job by ID. */
  get<T extends AnimationJob>(id: string): T | undefined {
    return this.jobs.get(id) as T | undefined;
  }

  /**
   * Run all jobs. Self-invalidates if any job needs more frames.
   * Called from OverlayRenderLoop.frame().
   */
  run(ctx: CanvasRenderingContext2D, now: number): void {
    const dt = this.lastTickTime > 0 ? now - this.lastTickTime : 0;
    this.lastTickTime = now;

    let needsMore = false;
    for (const job of this.jobs.values()) {
      if (job.frame(ctx, now, dt)) needsMore = true;
    }

    if (needsMore) this.invalidate?.();
  }

  /** Destroy all jobs and reset state. */
  destroy(): void {
    for (const job of this.jobs.values()) {
      job.destroy();
    }
    this.jobs.clear();
    this.lastTickTime = 0;
    this.invalidate = null;
  }
}

// Module-level singleton
let controller: AnimationController | null = null;

/** Get the animation controller singleton. Creates one if it doesn't exist. */
export function getAnimationController(): AnimationController {
  if (!controller) {
    controller = new AnimationController();
  }
  return controller;
}

/** Destroy the animation controller singleton. Called on canvas unmount. */
export function destroyAnimationController(): void {
  controller?.destroy();
  controller = null;
}
