/**
 * Connector Tool Module
 *
 * Re-exports all connector-related utilities for easy importing.
 *
 * @module lib/connectors
 */

// Constants
export { SNAP_CONFIG, ROUTING_CONFIG, pxToWorld } from './constants';

// Shape utilities
export {
  type Dir,
  type ShapeFrame,
  getShapeFrame,
  getMidpoints,
  getEdgePosition,
  getOutwardVector,
  oppositeDir,
  isHorizontal,
  isVertical,
} from './shape-utils';

// Snapping system
export {
  type SnapTarget,
  type SnapContext,
  findBestSnapTarget,
  computeSnapForShape,
  pointInsideShape,
  getShapeMidpoints,
  findNearestEdgePoint,
} from './snap';

// Routing algorithm
export {
  type RouteResult,
  type RouteEndpoint,
  computeRoute,
  inferDragDirection,
} from './routing';
