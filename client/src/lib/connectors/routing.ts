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
 * - Generous padding ensures arrows and approach points fit
 *
 * @module lib/connectors/routing
 */

import { computeZRoute, inferDragDirection, type Terminal, type RouteResult } from './routing-zroute';
import { computeAStarRoute } from './routing-astar';

// Re-export types
export type { RouteResult, Terminal };

/**
 * Compute route between two terminals.
 *
 * Dispatches to appropriate routing algorithm:
 * - Z-routing when endpoint is free (not snapped to shape)
 * - A* routing when endpoint is snapped (needs obstacle avoidance)
 *
 * @param from - Start terminal
 * @param to - End terminal
 * @param _prevSignature - Previous route signature (unused in new implementation)
 * @param strokeWidth - Connector stroke width (affects routing offsets)
 * @returns Route result with path and signature
 */
export function computeRoute(
  from: Terminal,
  to: Terminal,
  _prevSignature: string | null,
  strokeWidth: number
): RouteResult {
  // Two-mode routing dispatch
  if (!to.isAnchored) {
    // Free cursor - use simple Z-routing (no obstacle avoidance needed)
    return computeZRoute(from, to, strokeWidth);
  } else {
    // Snapped to shape - use A* Manhattan routing (obstacle avoidance)
    return computeAStarRoute(from, to, strokeWidth);
  }
}

// Re-export inferDragDirection for ConnectorTool
export { inferDragDirection };
