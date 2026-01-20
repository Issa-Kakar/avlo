/**
 * Shared Types for Connector Routing System
 *
 * This file contains all shared type definitions used across the connector
 * routing modules. Consolidating types here reduces duplication and makes
 * imports cleaner.
 *
 * @module lib/connectors/types
 */

import type { Frame, Dir as SharedDir } from '@avlo/shared';

// Re-export from shared for convenience
export type { Frame, StoredAnchor } from '@avlo/shared';

// ============================================================================
// DIRECTION & GEOMETRY TYPES
// ============================================================================

/** Cardinal direction type (North, East, South, West) */
export type Dir = SharedDir;

/**
 * Shape frame / AABB (x, y, width, height)
 * @deprecated Use Frame from @avlo/shared instead
 */
export type ShapeFrame = Frame;

/**
 * AABB for spatial calculations (compatible with Frame)
 * @deprecated Use Frame from @avlo/shared instead
 */
export type AABB = Frame;

/**
 * Edge-based bounds representation for routing AABBs.
 *
 * Using edges directly (instead of x,y,w,h) makes routing code cleaner:
 * - Grid lines: `xLines.add(b.left)` vs `xLines.add(b.x)`
 * - Centerline: `(a.right + b.left) / 2` vs `(a.x + a.w + b.x) / 2`
 * - Facing checks: `a.right <= b.left` vs `a.x + a.w <= b.x`
 */
export interface Bounds {
  left: number;   // minX
  top: number;    // minY
  right: number;  // maxX
  bottom: number; // maxY
}

// ============================================================================
// TERMINAL & ROUTING TYPES
// ============================================================================

/**
 * Terminal describes an endpoint for routing.
 *
 * This is THE canonical endpoint type for all routing operations.
 * Use `isAnchored` instead of `kind: 'world'|'shape'`.
 */
export interface Terminal {
  position: [number, number];
  /**
   * Direction the jetty extends from this point.
   * For shape-attached: same as the side we're on (away from shape).
   * For free: direction toward other endpoint.
   */
  outwardDir: Dir;
  /** True if snapped to a shape edge */
  isAnchored: boolean;
  /** True if this endpoint has an arrow cap (affects offset) */
  hasCap: boolean;
  /** Shape bounds for obstacle blocking (when isAnchored=true) */
  shapeBounds?: AABB;
  /**
   * Normalized anchor position within shape frame [0-1, 0-1].
   * Shape-agnostic: newPos = [frame.x + anchor[0] * frame.w, frame.y + anchor[1] * frame.h]
   */
  normalizedAnchor?: [number, number];
}

/**
 * Route result with full path and signature.
 */
export interface RouteResult {
  points: [number, number][];
  signature: string;
}

/**
 * Complete routing context with all spatial analysis pre-computed.
 *
 * Grid construction just reads AABB boundaries from this.
 * A* uses stubs as start/goal positions.
 *
 * Note: Does NOT store Terminal objects - only the 7 primitives needed for routing.
 */
export interface RoutingContext {
  // Endpoint positions (for final path assembly)
  startPos: [number, number];
  endPos: [number, number];

  // Dynamic routing bounds (centerline/padding baked in)
  // These are NOT raw shape bounds - they're the routing AABBs
  startBounds: Bounds;
  endBounds: Bounds;

  // Stub positions - WHERE A* actually starts/ends (ON bounds boundary)
  startStub: [number, number];
  endStub: [number, number];

  // Resolved directions
  startDir: Dir;
  endDir: Dir;

  // Raw shape bounds for obstacle checking (NOT the routing bounds)
  obstacles: AABB[];
}

// ============================================================================
// SNAP TYPES
// ============================================================================

/**
 * Snap target returned by the snapping system.
 */
export interface SnapTarget {
  /** ID of the shape being snapped to */
  shapeId: string;
  /** Which edge (N/E/S/W) */
  side: Dir;
  /**
   * Normalized anchor position within shape frame [0-1, 0-1].
   * Shape-agnostic: position = [frame.x + anchor[0] * frame.w, frame.y + anchor[1] * frame.h]
   */
  normalizedAnchor: [number, number];
  /** True if snapped to exact midpoint */
  isMidpoint: boolean;
  /** World coordinates of snap point WITH offset applied (for routing) */
  position: [number, number];
  /** World coordinates of snap point on shape edge (for dot rendering) */
  edgePosition: [number, number];
  /** True if cursor is inside the shape */
  isInside: boolean;
}

/**
 * Context for snap computation.
 */
export interface SnapContext {
  /** Cursor position in world coordinates */
  cursorWorld: [number, number];
  /** Current zoom scale */
  scale: number;
  /** Previous snap target (for hysteresis) */
  prevAttach: SnapTarget | null;
}

// ============================================================================
// CENTERLINE & GRID TYPES
// ============================================================================

/**
 * Centerlines between two shapes (if they exist).
 * Computed from RAW bounds - no padding.
 */
export interface Centerlines {
  /** Vertical centerline X coordinate (if X gap exists) */
  x: number | null;
  /** Horizontal centerline Y coordinate (if Y gap exists) */
  y: number | null;
}

/**
 * Grid cell with position and blocking state.
 */
export interface GridCell {
  /** World X coordinate */
  x: number;
  /** World Y coordinate */
  y: number;
  /** Grid index X */
  xi: number;
  /** Grid index Y */
  yi: number;
  /** True if inside obstacle + padding (not routable) */
  blocked: boolean;
}

/**
 * Non-uniform grid structure for A* routing.
 */
export interface Grid {
  /** 2D cell array [yi][xi] */
  cells: GridCell[][];
  /** Sorted unique X coordinates */
  xLines: number[];
  /** Sorted unique Y coordinates */
  yLines: number[];
}

// ============================================================================
// A* ALGORITHM TYPES
// ============================================================================

/**
 * A* node for priority queue.
 */
export interface AStarNode {
  /** Grid cell this node represents */
  cell: GridCell;
  /** Cost from start */
  g: number;
  /** Heuristic to goal */
  h: number;
  /** f = g + h */
  f: number;
  /** Parent node for path reconstruction */
  parent: AStarNode | null;
  /** Direction we arrived from (for bend penalty) */
  arrivalDir: Dir | null;
}
