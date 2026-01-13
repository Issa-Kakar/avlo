/**
 * Simplified Grid Construction for A* Routing
 *
 * DESIGN PHILOSOPHY:
 * - Grid lines come DIRECTLY from routing context AABBs
 * - NO cell blocking logic - A* handles obstacles via segment intersection
 * - Grid construction is trivial: add AABB edges + stub perpendicular lines
 *
 * This is dramatically simpler than the legacy routing-grid.ts because
 * all the centerline/facing-side intelligence is in routing-context.ts.
 *
 * @module lib/connectors/routing-grid-simple
 */

import type { RoutingContext } from './routing-context';
import { getGridLinesFromContext } from './routing-context';

// Re-export Grid interfaces from legacy grid file (same structure)
export type { Grid, GridCell } from './routing-grid';

// Re-export helper functions (they work unchanged)
export { findNearestCell, findNearestIndex, getNeighbors } from './routing-grid';

// Import Grid type for internal use
import type { Grid, GridCell } from './routing-grid';

/**
 * Build a simple grid from routing context.
 *
 * Grid construction is trivial because routing context already has:
 * - Dynamic AABBs with centerline/padding baked in
 * - Stub positions on AABB boundaries
 *
 * We just:
 * 1. Add all AABB boundary lines
 * 2. Add stub perpendicular lines
 * 3. Dedupe and sort
 * 4. Create cells (NO blocking)
 *
 * @param ctx - Routing context with pre-computed AABBs and stubs
 * @returns Grid for A* routing
 */
export function buildSimpleGrid(ctx: RoutingContext): Grid {
  // Get grid lines from context (handles AABB edges + stub perpendiculars)
  const { xLines, yLines } = getGridLinesFromContext(ctx);

  // Dedupe and sort
  const xSorted = [...xLines].sort((a, b) => a - b);
  const ySorted = [...yLines].sort((a, b) => a - b);

  // Create cell grid (NO blocking - A* handles obstacles via segment checks)
  return createCellGridSimple(xSorted, ySorted);
}

/**
 * Create a simple cell grid without blocking.
 *
 * Unlike the legacy createCellGrid, this does NOT:
 * - Block cells inside obstacles (A* checks segments)
 * - Block facing side cells (centerlines are baked into AABBs)
 *
 * Cells are just intersections of grid lines.
 *
 * @param xLines - Sorted unique X coordinates
 * @param yLines - Sorted unique Y coordinates
 * @returns Grid structure
 */
function createCellGridSimple(xLines: number[], yLines: number[]): Grid {
  const cells: GridCell[][] = [];

  for (let yi = 0; yi < yLines.length; yi++) {
    cells[yi] = [];
    for (let xi = 0; xi < xLines.length; xi++) {
      cells[yi][xi] = {
        x: xLines[xi],
        y: yLines[yi],
        xi,
        yi,
        blocked: false, // NO blocking - A* handles obstacles
      };
    }
  }

  return { cells, xLines, yLines };
}
