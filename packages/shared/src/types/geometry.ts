/**
 * Shared Geometry Types
 *
 * Consolidated type definitions for coordinates, bounds, and frames.
 * These types eliminate duplication across the codebase.
 *
 * @module types/geometry
 */

// ============================================================================
// TUPLE TYPES (for Y.Map storage)
// ============================================================================

/**
 * Bounding box tuple [minX, minY, maxX, maxY].
 * Used in ObjectHandle.bbox and spatial index queries.
 */
export type BBoxTuple = [minX: number, minY: number, maxX: number, maxY: number];

/**
 * Frame tuple [x, y, w, h].
 * Used for shape and text frames in Y.Map storage.
 */
export type FrameTuple = [x: number, y: number, w: number, h: number];

// ============================================================================
// OBJECT REPRESENTATIONS
// ============================================================================

/**
 * World bounds in minX/minY/maxX/maxY format.
 * Used for dirty rects, selection bounds, and spatial queries.
 */
export interface WorldBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/**
 * Frame in x/y/w/h format.
 * Used for shape frames, text frames, and AABB calculations.
 */
export interface Frame {
  x: number;
  y: number;
  w: number;
  h: number;
}

// ============================================================================
// CONVERTERS
// ============================================================================

/**
 * Convert FrameTuple [x, y, w, h] to Frame object.
 */
export function tupleToFrame(t: FrameTuple): Frame {
  return { x: t[0], y: t[1], w: t[2], h: t[3] };
}

/**
 * Convert Frame object to FrameTuple [x, y, w, h].
 */
export function frameToTuple(f: Frame): FrameTuple {
  return [f.x, f.y, f.w, f.h];
}

/**
 * Convert Frame to WorldBounds.
 */
export function frameToWorldBounds(f: Frame): WorldBounds {
  return {
    minX: f.x,
    minY: f.y,
    maxX: f.x + f.w,
    maxY: f.y + f.h,
  };
}

/**
 * Convert BBoxTuple to WorldBounds.
 */
export function bboxTupleToWorldBounds(b: BBoxTuple): WorldBounds {
  return {
    minX: b[0],
    minY: b[1],
    maxX: b[2],
    maxY: b[3],
  };
}

/**
 * Convert WorldBounds to BBoxTuple.
 */
export function worldBoundsToBBoxTuple(b: WorldBounds): BBoxTuple {
  return [b.minX, b.minY, b.maxX, b.maxY];
}

/**
 * Convert WorldBounds to Frame (w/h derived from extent).
 */
export function worldBoundsToFrame(b: WorldBounds): Frame {
  return {
    x: b.minX,
    y: b.minY,
    w: b.maxX - b.minX,
    h: b.maxY - b.minY,
  };
}

/**
 * AABB intersection test: FrameTuple [x, y, w, h] vs WorldBounds.
 */
export function frameTupleIntersectsBounds(frame: FrameTuple, bounds: WorldBounds): boolean {
  return (
    frame[0] < bounds.maxX &&
    frame[0] + frame[2] > bounds.minX &&
    frame[1] < bounds.maxY &&
    frame[1] + frame[3] > bounds.minY
  );
}
