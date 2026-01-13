/**
 * Connector Tool Module
 *
 * Re-exports all connector-related utilities for easy importing.
 *
 * @module lib/connectors
 */

// Constants
export {
  SNAP_CONFIG,
  ROUTING_CONFIG,
  COST_CONFIG,
  pxToWorld,
  computeApproachOffset,
  computeJettyOffset,
  computeArrowLength,
} from './constants';

// Shape utilities
export {
  type Dir,
  type ShapeFrame,
  type Bounds,
  getShapeFrame,
  getMidpoints,
  getEdgePosition,
  getOutwardVector,
  oppositeDir,
  isHorizontal,
  isVertical,
  toBounds,
  pointBounds,
  isPointBounds,
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
  type Terminal,
  computeRoute,
  inferDragDirection,
  resolveFreeStartDir,
  computeFreeEndDir,
} from './routing';

// Routing context (new architecture)
export { type RoutingContext, createRoutingContext } from './routing-context';
export { buildSimpleGrid } from './routing-grid-simple';
