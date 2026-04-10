/**
 * Bounds Utilities
 *
 * WorldBounds manipulation and computation:
 * - Union (combining bounds)
 * - Transform (translate, scale)
 * - Construction (from points, frames)
 * - Accessors (center, width, height)
 * - Uniform scale bounds computation
 * - Raw geometry bounds extraction from ObjectHandle
 */

import type { WorldBounds, FrameTuple, BBoxTuple, Point } from '../types/geometry';
import type { ObjectHandle } from '../types/objects';
import { getFrame, getPoints } from '../accessors';
import { getTextFrame } from '../text/text-system';
import { getCodeFrame } from '../code/code-system';

// ============================================================================
// BBOX TUPLE HELPERS
// ============================================================================

/** Expand bbox in-place to include the given extents. */
export function expandBBox(b: BBoxTuple, minX: number, minY: number, maxX: number, maxY: number): void {
  b[0] = Math.min(b[0], minX);
  b[1] = Math.min(b[1], minY);
  b[2] = Math.max(b[2], maxX);
  b[3] = Math.max(b[3], maxY);
}

export const unionBBox = (a: BBoxTuple, b: BBoxTuple): BBoxTuple => [
  Math.min(a[0], b[0]),
  Math.min(a[1], b[1]),
  Math.max(a[2], b[2]),
  Math.max(a[3], b[3]),
];

export const expandBBoxEnvelope = (env: BBoxTuple | null, b: BBoxTuple): BBoxTuple => (env ? unionBBox(env, b) : b);

export const scaleBBoxAround = (b: BBoxTuple, o: Point, sx: number, sy: number): BBoxTuple => {
  const x1 = o[0] + (b[0] - o[0]) * sx,
    y1 = o[1] + (b[1] - o[1]) * sy;
  const x2 = o[0] + (b[2] - o[0]) * sx,
    y2 = o[1] + (b[3] - o[1]) * sy;
  return [Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2)];
};

export const pointsToBBox = (p1: Point, p2: Point): BBoxTuple => [
  Math.min(p1[0], p2[0]),
  Math.min(p1[1], p2[1]),
  Math.max(p1[0], p2[0]),
  Math.max(p1[1], p2[1]),
];

export const translateBBox = (b: BBoxTuple, dx: number, dy: number): BBoxTuple => [b[0] + dx, b[1] + dy, b[2] + dx, b[3] + dy];

// Tuple helpers moved from scale-system.ts (geometry primitives, not scale-specific)
export const frameToBbox = (f: FrameTuple): BBoxTuple => [f[0], f[1], f[0] + f[2], f[1] + f[3]];

export function frameToBboxMut(f: FrameTuple, out: BBoxTuple): void {
  out[0] = f[0];
  out[1] = f[1];
  out[2] = f[0] + f[2];
  out[3] = f[1] + f[3];
}

export function copyBbox(src: BBoxTuple, dst: BBoxTuple): void {
  dst[0] = src[0];
  dst[1] = src[1];
  dst[2] = src[2];
  dst[3] = src[3];
}

export const bboxCenter = (b: BBoxTuple): Point => [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
export const bboxSize = (b: BBoxTuple): [number, number] => [b[2] - b[0], b[3] - b[1]];
export const frameCenter = (f: FrameTuple): Point => [f[0] + f[2] / 2, f[1] + f[3] / 2];

// ============================================================================
// UNION HELPERS
// ============================================================================

/**
 * Union two bounds into one encompassing box.
 */
export function unionBounds(a: WorldBounds, b: WorldBounds): WorldBounds {
  return {
    minX: Math.min(a.minX, b.minX),
    minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX),
    maxY: Math.max(a.maxY, b.maxY),
  };
}

/**
 * Expand envelope with new bounds (accumulator pattern - never shrinks).
 * Returns new bounds if envelope is null, otherwise unions.
 */
export function expandEnvelope(envelope: WorldBounds | null, bounds: WorldBounds): WorldBounds {
  return envelope ? unionBounds(envelope, bounds) : bounds;
}

// ============================================================================
// TRANSFORM HELPERS
// ============================================================================

/**
 * Translate bounds by offset.
 */
export function translateBounds(bounds: WorldBounds, dx: number, dy: number): WorldBounds {
  return {
    minX: bounds.minX + dx,
    minY: bounds.minY + dy,
    maxX: bounds.maxX + dx,
    maxY: bounds.maxY + dy,
  };
}

/**
 * Scale bounds around origin with automatic normalization for negative scales.
 */
export function scaleBoundsAround(bounds: WorldBounds, origin: [number, number], scaleX: number, scaleY: number): WorldBounds {
  const [ox, oy] = origin;
  const x1 = ox + (bounds.minX - ox) * scaleX;
  const y1 = oy + (bounds.minY - oy) * scaleY;
  const x2 = ox + (bounds.maxX - ox) * scaleX;
  const y2 = oy + (bounds.maxY - oy) * scaleY;
  // Normalize for negative scale (flip handling)
  return {
    minX: Math.min(x1, x2),
    minY: Math.min(y1, y2),
    maxX: Math.max(x1, x2),
    maxY: Math.max(y1, y2),
  };
}

// ============================================================================
// CONSTRUCTION HELPERS
// ============================================================================

/**
 * Create bounds from two corner points (for marquee rectangles).
 */
export function pointsToWorldBounds(p1: [number, number], p2: [number, number]): WorldBounds {
  return {
    minX: Math.min(p1[0], p2[0]),
    minY: Math.min(p1[1], p2[1]),
    maxX: Math.max(p1[0], p2[0]),
    maxY: Math.max(p1[1], p2[1]),
  };
}

/**
 * Convert FrameTuple [x, y, w, h] directly to WorldBounds.
 */
export function frameTupleToWorldBounds(frame: FrameTuple): WorldBounds {
  return {
    minX: frame[0],
    minY: frame[1],
    maxX: frame[0] + frame[2],
    maxY: frame[1] + frame[3],
  };
}

// ============================================================================
// ACCESSOR HELPERS
// ============================================================================

/**
 * Get center point of bounds.
 */
export function boundsCenter(bounds: WorldBounds): [number, number] {
  return [(bounds.minX + bounds.maxX) / 2, (bounds.minY + bounds.maxY) / 2];
}

/**
 * Get width of bounds.
 */
export function boundsWidth(bounds: WorldBounds): number {
  return bounds.maxX - bounds.minX;
}

/**
 * Get height of bounds.
 */
export function boundsHeight(bounds: WorldBounds): number {
  return bounds.maxY - bounds.minY;
}

/**
 * Expand bounds by uniform padding.
 */
export function expandBounds(bounds: WorldBounds, padding: number): WorldBounds {
  return {
    minX: bounds.minX - padding,
    minY: bounds.minY - padding,
    maxX: bounds.maxX + padding,
    maxY: bounds.maxY + padding,
  };
}

// ============================================================================
// RAW GEOMETRY BOUNDS
// ============================================================================

/**
 * Compute geometry-based bounds for a set of objects.
 * Unlike bbox (which includes stroke padding), this extracts raw geometry:
 * - Shapes/text: raw frame [x, y, w, h]
 * - Strokes/connectors: raw points min/max (no width inflation)
 *
 * Used for scale origin computation to prevent anchor sliding.
 */
export function computeRawGeometryBounds(handles: Iterable<ObjectHandle>): BBoxTuple | null {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;

  for (const handle of handles) {
    // Notes + bookmarks: use bbox (includes shadow) — handles are at bbox positions
    if (handle.kind === 'note' || handle.kind === 'bookmark') {
      const [minX_, minY_, maxX_, maxY_] = handle.bbox;
      minX = Math.min(minX, minX_);
      minY = Math.min(minY, minY_);
      maxX = Math.max(maxX, maxX_);
      maxY = Math.max(maxY, maxY_);
      continue;
    }
    if (handle.kind === 'shape' || handle.kind === 'image' || handle.kind === 'text' || handle.kind === 'code') {
      const frame =
        handle.kind === 'text' ? getTextFrame(handle.id) : handle.kind === 'code' ? getCodeFrame(handle.id) : getFrame(handle.y);
      if (!frame) continue;
      const [x, y, w, h] = frame;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x + w);
      maxY = Math.max(maxY, y + h);
    } else {
      const points = getPoints(handle.y);
      for (const [px, py] of points) {
        minX = Math.min(minX, px);
        minY = Math.min(minY, py);
        maxX = Math.max(maxX, px);
        maxY = Math.max(maxY, py);
      }
    }
  }

  if (!isFinite(minX)) return null;
  return [minX, minY, maxX, maxY];
}

// ============================================================================
// INTERSECTION TEST
// ============================================================================

export function boundsIntersect(
  a: { minX: number; minY: number; maxX: number; maxY: number },
  b: { minX: number; minY: number; maxX: number; maxY: number },
): boolean {
  return !(a.maxX < b.minX || a.minX > b.maxX || a.maxY < b.minY || a.minY > b.maxY);
}
