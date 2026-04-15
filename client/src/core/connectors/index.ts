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
  ConnectorType,
  ConnectorCap,
} from './types';
export { isAnchorInterior } from './types';

// Constants
export {
  SNAP_CONFIG,
  ROUTING_CONFIG,
  COST_CONFIG,
  EDGE_CLEARANCE_W,
  GUIDE_CONFIG,
  getSnapRadiiWorld,
  getAnchorDotMetricsWorld,
  getGuideMetricsWorld,
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
  // Direction resolution for free endpoints
  resolveFreeStartDir,
  computeFreeEndDir,
  inferDragDirection,
  computeSliverEscape,
  // Anchor helpers
  getEndpointEdgePosition,
  // Straight connector edge intersection
  computeShapeEdgeIntersection,
} from './connector-utils';

// Anchor math atoms (single home for anchor <-> point math)
export { anchorFramePoint, anchorOffsetPoint, sideFromAnchor, isSameShape } from './anchor-atoms';

// Snapping
export { findBestSnapTarget, computeSnapForShape, findNearestEdgePoint } from './snap';

// Routing
export { computeAStarRoute } from './routing-astar';
export { createRoutingContext, buildSimpleGrid } from './routing-context';
export type { RerouteResult, NewRouteResult } from './reroute-connector';
export { rerouteConnector, routeNewConnector } from './reroute-connector';

// Path building (for cache and preview)
export type { ConnectorPaths, ConnectorPathParams, EndTrimInfo, ArrowGeometry } from './connector-paths';
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
