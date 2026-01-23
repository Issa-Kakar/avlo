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
  Frame,
  FrameTuple,
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

// Connector utilities
export {
  // Midpoint calculation
  getShapeTypeMidpoints,
  // Direction helpers
  oppositeDir,
  isHorizontal,
  isVertical,
  directionVector,
  // Bounds conversion
  toBounds,
  pointBounds,
  isPointBounds,
  // Path utilities
  simplifyOrthogonal,
  computeSignature,
  // Direction resolution for free endpoints
  resolveFreeStartDir,
  computeFreeEndDir,
  inferDragDirection,
  // Anchor helpers
  applyAnchorToFrame,
  getEndpointEdgePosition,
} from './connector-utils';

// Snapping
export {
  findBestSnapTarget,
  computeSnapForShape,
  findNearestEdgePoint,
} from './snap';

// Routing
export { computeAStarRoute } from './routing-astar';
export { createRoutingContext, buildSimpleGrid } from './routing-context';
export type { RerouteResult } from './reroute-connector';
export { rerouteConnector } from './reroute-connector';

// Path building (for cache and preview)
export type {
  ConnectorPaths,
  ConnectorPathParams,
  EndTrimInfo,
  ArrowGeometry,
} from './connector-paths';
export {
  buildConnectorPaths,
  buildRoundedPolylinePath,
  buildArrowPath,
  computeArrowGeometry,
  computeScaledArrowDimensions,
  computeEndTrimInfo,
  ARROW_ROUNDING_LINE_WIDTH,
} from './connector-paths';

// Lookup utilities (reverse map from shapes to connectors)
export {
  initConnectorLookup,
  hydrateConnectorLookup,
  clearConnectorLookup,
  processConnectorAdded,
  processConnectorUpdated,
  processConnectorDeleted,
  processShapeDeleted,
  getConnectorsForShape,
  hasConnectorLookup,
} from './connector-lookup';
