/**
 * Geometry module exports
 */

// Shape recognition & fitting
export * from './types';
export * from './fit-circle';
export * from './fit-obb';
export * from './geometry-helpers';

// Bounds utilities
export * from './bounds';

// Transform utilities
export {
  type ObjectHandleForScale,
  computeUniformScaleNoThreshold,
  computePreservedPosition,
  computeStrokeTranslation,
  type TransformForBounds,
  applyTransformToBounds,
  type ScaleTransformState,
  computeScaleFactors,
  applyTransformToFrame,
  applyUniformScaleToPoints,
  applyUniformScaleToFrame,
} from './transform';

// Hit testing
export {
  getDiamondVertices,
  pointToSegmentDistance,
  pointInRect,
  pointInWorldRect,
  pointInDiamond,
  strokeHitTest,
  circleRectIntersect,
  rectsIntersect,
  segmentsIntersect,
  segmentIntersectsRect,
  polylineIntersectsRect,
  ellipseIntersectsRect,
  diamondIntersectsRect,
  computePolylineArea,
  pointInsideShape,
  shapeEdgeHitTest,
  HANDLE_HIT_PX,
  hitTestHandle,
  objectIntersectsRect,
} from './hit-testing';