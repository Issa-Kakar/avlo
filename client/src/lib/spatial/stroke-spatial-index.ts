import { UniformGrid } from './uniform-grid';
import type { SpatialIndex, StrokeView } from '@avlo/shared';

/**
 * StrokeSpatialIndex - Implements the SpatialIndex interface for strokes
 * Uses UniformGrid for efficient spatial queries
 */
export class StrokeSpatialIndex implements SpatialIndex {
  private grid: UniformGrid<StrokeView>;
  private allStrokes: ReadonlyArray<StrokeView>;

  constructor(strokes: ReadonlyArray<StrokeView>, cellSize: number = 128) {
    this.grid = new UniformGrid<StrokeView>(cellSize);
    this.allStrokes = strokes;

    // Build the index
    for (const stroke of strokes) {
      if (stroke.bbox && stroke.bbox.length === 4) {
        // Include stroke half-width in the bbox for accurate hit-testing
        const halfWidth = (stroke.style?.size ?? 1) / 2;
        const inflatedBbox: [number, number, number, number] = [
          stroke.bbox[0] - halfWidth,
          stroke.bbox[1] - halfWidth,
          stroke.bbox[2] + halfWidth,
          stroke.bbox[3] + halfWidth,
        ];
        this.grid.insert(stroke, inflatedBbox);
      }
    }
  }

  /**
   * Query strokes within a radius of a point
   */
  queryCircle(cx: number, cy: number, radius: number): ReadonlyArray<StrokeView> {
    return this.grid.query(cx, cy, radius);
  }

  /**
   * Query strokes within a rectangular region
   */
  queryRect(minX: number, minY: number, maxX: number, maxY: number): ReadonlyArray<StrokeView> {
    return this.grid.queryRect(minX, minY, maxX, maxY);
  }

  /**
   * Get all strokes (fallback for when spatial index isn't helpful)
   */
  getAllStrokes(): ReadonlyArray<StrokeView> {
    return this.allStrokes;
  }

  /**
   * Get statistics about the spatial index (for debugging/optimization)
   */
  getStats() {
    return this.grid.getStats();
  }
}
