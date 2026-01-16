/**
 * Connector Tool Module
 *
 * Re-exports all connector-related utilities for easy importing.
 *
 * @module lib/connectors
 */

// Types (all from types.ts)
export type {
  Dir,
  ShapeFrame,
  AABB,
  Bounds,
  Terminal,
  RouteResult,
  RoutingContext,
  Grid,
  GridCell,
  Centerlines,
  AStarNode,
  SnapTarget,
  SnapContext,
} from './types';

// Constants
export {
  SNAP_CONFIG,
  ROUTING_CONFIG,
  COST_CONFIG,
  EDGE_CLEARANCE_W,
  pxToWorld,
  computeApproachOffset,
  computeArrowLength,
} from './constants';

// Connector utilities (renamed from shape-utils)
export {
  getShapeFrame,
  getMidpoints,
  getEdgePosition,
  oppositeDir,
  isHorizontal,
  isVertical,
  directionVector,
  toBounds,
  pointBounds,
  isPointBounds,
  // Path utilities
  simplifyOrthogonal,
  computeSignature,
  // Direction helpers
  resolveFreeStartDir,
  computeFreeEndDir,
  inferDragDirection,
} from './connector-utils';

// Snapping
export {
  findBestSnapTarget,
  computeSnapForShape,
  pointInsideShape,
  getShapeMidpoints,
  findNearestEdgePoint,
  getConnectorEndpoint,
} from './snap';

// Routing
export { computeRoute, computeAStarRoute } from './routing-astar';
export { createRoutingContext, buildSimpleGrid } from './routing-context';
