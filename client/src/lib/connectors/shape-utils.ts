/**
 * Shape Utilities for Connector Snapping
 *
 * Provides frame extraction, midpoint calculation, and edge position helpers.
 * Designed to work with ObjectHandle from the snapshot.
 *
 * @module lib/connectors/shape-utils
 */

import type { ObjectHandle } from '@avlo/shared';

/** Cardinal direction type (North, East, South, West) */
export type Dir = 'N' | 'E' | 'S' | 'W';

/** Shape frame (x, y, width, height) */
export interface ShapeFrame {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Extract frame from shape handle.
 * Works with 'shape' and 'text' object kinds.
 *
 * @param handle - Object handle from snapshot
 * @returns ShapeFrame or null if not a shape/text or no frame
 */
export function getShapeFrame(handle: ObjectHandle): ShapeFrame | null {
  if (handle.kind !== 'shape' && handle.kind !== 'text') return null;
  const frame = handle.y.get('frame') as [number, number, number, number] | undefined;
  if (!frame) return null;
  return { x: frame[0], y: frame[1], w: frame[2], h: frame[3] };
}

/**
 * Get midpoint positions for all 4 edges.
 * For all shape types (rect, ellipse, diamond), midpoints are at frame edge centers.
 *
 * @param frame - Shape frame
 * @returns Record mapping each direction to its midpoint [x, y]
 */
export function getMidpoints(frame: ShapeFrame): Record<Dir, [number, number]> {
  return {
    N: [frame.x + frame.w / 2, frame.y],
    E: [frame.x + frame.w, frame.y + frame.h / 2],
    S: [frame.x + frame.w / 2, frame.y + frame.h],
    W: [frame.x, frame.y + frame.h / 2],
  };
}

/**
 * Get position along edge for given t (0-1).
 *
 * @param frame - Shape frame
 * @param side - Which edge (N/E/S/W)
 * @param t - Position along edge (0 = start, 0.5 = midpoint, 1 = end)
 * @returns World coordinates [x, y]
 */
export function getEdgePosition(frame: ShapeFrame, side: Dir, t: number): [number, number] {
  const clampedT = Math.max(0, Math.min(1, t));
  switch (side) {
    case 'N':
      return [frame.x + frame.w * clampedT, frame.y];
    case 'S':
      return [frame.x + frame.w * clampedT, frame.y + frame.h];
    case 'W':
      return [frame.x, frame.y + frame.h * clampedT];
    case 'E':
      return [frame.x + frame.w, frame.y + frame.h * clampedT];
  }
}

/**
 * Get outward direction vector for a side.
 * Used for jetty computation in routing.
 *
 * @param side - Edge side
 * @returns Unit vector [dx, dy] pointing outward
 */
export function getOutwardVector(side: Dir): [number, number] {
  switch (side) {
    case 'N':
      return [0, -1];
    case 'S':
      return [0, 1];
    case 'W':
      return [-1, 0];
    case 'E':
      return [1, 0];
  }
}

/**
 * Get opposite direction.
 *
 * @param dir - Input direction
 * @returns Opposite direction
 */
export function oppositeDir(dir: Dir): Dir {
  const map: Record<Dir, Dir> = { N: 'S', S: 'N', E: 'W', W: 'E' };
  return map[dir];
}

/**
 * Check if a direction is horizontal (E or W).
 *
 * @param dir - Direction to check
 * @returns true if horizontal
 */
export function isHorizontal(dir: Dir): boolean {
  return dir === 'E' || dir === 'W';
}

/**
 * Check if a direction is vertical (N or S).
 *
 * @param dir - Direction to check
 * @returns true if vertical
 */
export function isVertical(dir: Dir): boolean {
  return dir === 'N' || dir === 'S';
}
