/**
 * Connector Routing - Main Entry Point
 *
 * Two-mode routing dispatch:
 * 1. Z-routing for free cursor (simple 3-segment HVH/VHV path)
 * 2. A* Manhattan routing for snapped endpoints (obstacle avoidance)
 *
 * DESIGN PRINCIPLES:
 * - Obstacle elimination, not post-hoc filtering
 * - Grid cells overlapping obstacles are BLOCKED during construction
 * - A* never visits blocked cells (valid by construction)
 * - Generous padding ensures arrows and jetties fit
 *
 * @module lib/connectors/routing
 */

import { computeZRoute, inferDragDirection, type Terminal, type RouteResult } from './routing-zroute';
import { computeAStarRoute } from './routing-astar';
import type { Dir } from './shape-utils';

/**
 * Legacy RouteEndpoint interface for backward compatibility.
 * Converts to Terminal internally.
 */
export interface RouteEndpoint {
  pos: [number, number];
  dir: Dir;
  isAttached: boolean;
  shapeBounds?: { x: number; y: number; w: number; h: number };
}

// Re-export types
export type { RouteResult, Terminal };

/**
 * Convert legacy RouteEndpoint to Terminal.
 */
function endpointToTerminal(endpoint: RouteEndpoint): Terminal {
  return {
    kind: endpoint.isAttached ? 'shape' : 'world',
    position: endpoint.pos,
    outwardDir: endpoint.dir,
    shapeBounds: endpoint.shapeBounds,
    // Note: shapeId, shapeSide, shapeT not available from RouteEndpoint
    // These are only used for CommitConnector, not routing
  };
}

/**
 * Compute route between two endpoints.
 *
 * Dispatches to appropriate routing algorithm:
 * - Z-routing when endpoint is free (not snapped to shape)
 * - A* routing when endpoint is snapped (needs obstacle avoidance)
 *
 * @param from - Start endpoint
 * @param to - End endpoint
 * @param _prevSignature - Previous route signature (unused in new implementation)
 * @param strokeWidth - Connector stroke width (affects routing offsets)
 * @returns Route result with path and signature
 */
export function computeRoute(
  from: RouteEndpoint,
  to: RouteEndpoint,
  _prevSignature: string | null,
  strokeWidth: number
): RouteResult {
  const fromTerm = endpointToTerminal(from);
  const toTerm = endpointToTerminal(to);

  // Two-mode routing dispatch
  if (!to.isAttached) {
    // Free cursor - use simple Z-routing (no obstacle avoidance needed)
    return computeZRoute(fromTerm, toTerm, strokeWidth);
  } else {
    // Snapped to shape - use A* Manhattan routing (obstacle avoidance)
    return computeAStarRoute(fromTerm, toTerm, strokeWidth);
  }
}

/**
 * Compute route using Terminal interface directly.
 *
 * This is the preferred interface for new code.
 *
 * @param from - Start terminal
 * @param to - End terminal
 * @param strokeWidth - Connector stroke width (affects routing offsets)
 * @returns Route result with path and signature
 */
export function computeRouteFromTerminals(from: Terminal, to: Terminal, strokeWidth: number): RouteResult {
  if (to.kind === 'world') {
    return computeZRoute(from, to, strokeWidth);
  } else {
    return computeAStarRoute(from, to, strokeWidth);
  }
}

// Re-export inferDragDirection for ConnectorTool
export { inferDragDirection };
