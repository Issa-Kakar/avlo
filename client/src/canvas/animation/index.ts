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
export {
  animateZoom,
  zoomIn,
  zoomOut,
  zoomTo,
  animateZoomReset,
  animateToFit,
  cancelZoom,
} from './ZoomAnimator';
