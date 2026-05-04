/**
 * Shared Types for Connector Routing System
 */

import type { Dir as SharedDir } from '../accessors';
import type { FrameTuple, Point } from '../types/geometry';
import type { ConnectorType } from '../types/objects';

export type { ConnectorCap, ConnectorType } from '../types/objects';

/** Cardinal direction type (North, East, South, West) */
export type Dir = SharedDir;

/**
 * Edge-based bounds representation for routing.
 *
 * Using edges directly (instead of x,y,w,h) makes routing code cleaner:
 * - Grid lines: `xLines.add(b.left)`
 * - Centerline: `(a.right + b.left) / 2`
 * - Facing checks: `a.right <= b.left`
 */
export interface Bounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Route result with full simplified path. */
export interface RouteResult {
  points: Point[];
}

/**
 * Complete routing context with all spatial analysis pre-computed.
 *
 * Grid construction just reads bounds boundaries from this.
 * A* uses stubs as start/goal positions.
 */
export interface RoutingContext {
  // Endpoint positions (for final path assembly)
  startPos: Point;
  endPos: Point;

  // Dynamic routing bounds (centerline/padding baked in — NOT raw shape bounds)
  startBounds: Bounds;
  endBounds: Bounds;

  // Stub positions - WHERE A* actually starts/ends (ON bounds boundary)
  startStub: Point;
  endStub: Point;

  // Resolved directions
  startDir: Dir;
  endDir: Dir;

  // Raw shape bounds for obstacle checking (NOT the routing bounds)
  obstacles: FrameTuple[];
}

// ============================================================================
// SNAP TYPES
// ============================================================================

/**
 * Shared fields for all snap targets.
 *
 * `position` is the single visual dot + routing endpoint before any offset/pullback.
 * Elbow routing applies `+ directionVector(side) * EDGE_CLEARANCE_W` at resolve time;
 * straight routing applies its own pull-back in `computeStraightRoute`. The snap
 * layer never bakes an offset into `position`.
 */
interface SnapTargetBase {
  /** ID of the shape being snapped to */
  shapeId: string;
  /**
   * Normalized anchor position within shape frame [0-1, 0-1].
   * Shape-agnostic: anchorPoint = [frame.x + a[0]*frame.w, frame.y + a[1]*frame.h]
   */
  normalizedAnchor: Point;
  /** World position of the visual anchor dot + pre-offset routing endpoint. */
  position: Point;
  /** True if cursor is inside the shape. */
  isInside: boolean;
}

/** Snap target for an elbow connector — always edge-anchored (incl. midpoint). */
export interface ElbowSnapTarget extends SnapTargetBase {
  kind: 'elbow';
  /**
   * Gesture-time UI hint — drives the active midpoint highlight + hysteresis.
   * **Not persisted.** Routing re-derives the cardinal at route time via
   * `projectAnchorToEdge`. In steady-state both agree (same projection, same
   * frame); diverging only during in-flight gesture transients.
   */
  side: Dir;
  /** True when snapped to the edge midpoint (for hysteresis + midpoint highlight). */
  isMidpoint: boolean;
}

/** Snap target for a straight connector — edge, edge-midpoint, center, or interior. */
export interface StraightSnapTarget extends SnapTargetBase {
  kind: 'straight';
  /** True = anchor sits inside the shape; false = anchor sits on the edge. */
  interior: boolean;
  /** True when anchored at shape center [0.5, 0.5] — drives the center-dot rendering. */
  isCenter: boolean;
  /** Edge-midpoint side when snapped to one (for midpoint highlight + hysteresis). */
  midpointSide: Dir | null;
}

export type SnapTarget = ElbowSnapTarget | StraightSnapTarget;

/**
 * Context for snap computation.
 */
export interface SnapContext {
  /** Cursor position in world coordinates */
  cursorWorld: Point;
  /** Previous snap target (for hysteresis) */
  prevAttach: SnapTarget | null;
  /** Connector type — drives the per-type branch in `computeSnapForShape`. */
  connectorType: ConnectorType;
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
 * Non-uniform grid structure for A* routing.
 *
 * Grid cells are addressed by index: `cellIdx = yi * xLines.length + xi`.
 * The cell's world position is `(xLines[xi], yLines[yi])`. A* never materializes
 * a `GridCell` object — index + line arrays carry all the info needed.
 */
export interface Grid {
  /** Sorted unique X coordinates */
  xLines: number[];
  /** Sorted unique Y coordinates */
  yLines: number[];
}
