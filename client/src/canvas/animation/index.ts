/**
 * Animation module exports
 *
 * Provides centralized animation management for the canvas.
 */

export {
  getAnimationController,
  destroyAnimationController,
  type AnimationJob,
} from './AnimationController';

export { EraserTrailAnimation } from './EraserTrailAnimation';
export { ZoomAnimator } from './ZoomAnimator';
