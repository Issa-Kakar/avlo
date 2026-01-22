/**
 * Bounds Helper Functions
 *
 * Pure functions for WorldBounds manipulation including:
 * - Union (combining bounds)
 * - Transform (translate, scale)
 * - Construction (from points, frames)
 * - Accessors (center, width, height)
 * - Uniform scale bounds computation
 * - Raw geometry bounds extraction
 */

import type { WorldBounds, FrameTuple, ObjectHandle } from '@avlo/shared';
import { getFrame, getPoints } from '@avlo/shared';
import {
  computeUniformScaleNoThreshold,
  computePreservedPosition,
} from './transform';

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
export function expandEnvelope(
  envelope: WorldBounds | null,
  bounds: WorldBounds
): WorldBounds {
  return envelope ? unionBounds(envelope, bounds) : bounds;
}

// ============================================================================
// TRANSFORM HELPERS
// ============================================================================

/**
 * Translate bounds by offset.
 */
export function translateBounds(
  bounds: WorldBounds,
  dx: number,
  dy: number
): WorldBounds {
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
export function scaleBoundsAround(
  bounds: WorldBounds,
  origin: [number, number],
  scaleX: number,
  scaleY: number
): WorldBounds {
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
export function pointsToWorldBounds(
  p1: [number, number],
  p2: [number, number]
): WorldBounds {
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
// UNIFORM SCALE BOUNDS (moved from scale-transform.ts)
// ============================================================================

/**
 * Compute bounds after uniform scale with position preservation.
 * Used for dirty rect invalidation during scale transforms.
 *
 * @param bbox - Object bbox as WorldBounds
 * @param originBounds - Selection bounds before transform
 * @param origin - Scale origin point
 * @param scaleX - Raw X scale factor
 * @param scaleY - Raw Y scale factor
 * @returns Transformed bounds
 */
export function computeUniformScaleBounds(
  bbox: WorldBounds,
  originBounds: WorldBounds,
  origin: [number, number],
  scaleX: number,
  scaleY: number
): WorldBounds {
  const cx = (bbox.minX + bbox.maxX) / 2;
  const cy = (bbox.minY + bbox.maxY) / 2;
  const halfW = (bbox.maxX - bbox.minX) / 2;
  const halfH = (bbox.maxY - bbox.minY) / 2;

  const uniformScale = computeUniformScaleNoThreshold(scaleX, scaleY);
  const absScale = Math.abs(uniformScale);

  const [newCx, newCy] = computePreservedPosition(cx, cy, originBounds, origin, uniformScale);

  return {
    minX: newCx - halfW * absScale,
    minY: newCy - halfH * absScale,
    maxX: newCx + halfW * absScale,
    maxY: newCy + halfH * absScale,
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
export function computeRawGeometryBounds(
  handles: Iterable<ObjectHandle>
): WorldBounds | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

  for (const handle of handles) {
    if (handle.kind === 'shape' || handle.kind === 'text') {
      const frame = getFrame(handle.y);
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
  return { minX, minY, maxX, maxY };
}
