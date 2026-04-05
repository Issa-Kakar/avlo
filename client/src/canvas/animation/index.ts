/**
 * Animation module exports
 */

export {
  getAnimationController,
  destroyAnimationController,
  type AnimationJob,
} from './AnimationController';

export { EraserTrailAnimation } from './EraserTrailAnimation';
export { CursorAnimationJob } from './CursorAnimationJob';
export {
  animateZoom,
  zoomIn,
  zoomOut,
  zoomTo,
  animateZoomReset,
  animateToFit,
  cancelZoom,
} from './ZoomAnimator';
