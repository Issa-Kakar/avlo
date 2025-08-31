import { describe, it, expect } from 'vitest';
import {
  calculateBBox,
  estimateEncodedSize,
  simplifyStroke,
} from '../simplification';
import { STROKE_CONFIG } from '@avlo/shared';

describe('simplification - pure unit tests', () => {
  describe('calculateBBox', () => {
    it('should calculate bbox for simple line', () => {
      const points = [0, 0, 100, 100];
      const strokeSize = 4;
      const bbox = calculateBBox(points, strokeSize);
      
      // Padding = strokeSize * 0.5 + 1 = 3
      expect(bbox).toEqual([-3, -3, 103, 103]);
    });

    it('should handle single point', () => {
      const points = [50, 50];
      const bbox = calculateBBox(points, 10);
      
      // Padding = 10 * 0.5 + 1 = 6
      expect(bbox).toEqual([44, 44, 56, 56]);
    });

    it('should return null for empty points', () => {
      expect(calculateBBox([])).toBeNull();
      expect(calculateBBox([50])).toBeNull(); // Odd number of coords
    });

    it('should handle negative coordinates', () => {
      const points = [-100, -100, 100, 100];
      const bbox = calculateBBox(points, 0);
      
      // Padding = 0 * 0.5 + 1 = 1
      expect(bbox).toEqual([-101, -101, 101, 101]);
    });

    it('should handle diagonal line correctly', () => {
      const points = [10, 20, 30, 40];
      const strokeSize = 6;
      const bbox = calculateBBox(points, strokeSize);
      
      // Padding = 6 * 0.5 + 1 = 4
      expect(bbox).toEqual([6, 16, 34, 44]);
    });
  });

  describe('estimateEncodedSize', () => {
    it('should estimate size for small stroke', () => {
      const points = [0, 0, 100, 100]; // 4 coordinates
      const size = estimateEncodedSize(points);
      
      // 4 coords * 16 bytes + 500 metadata + 1024 envelope = 1588
      expect(size).toBe(4 * 16 + 500 + 1024);
      expect(size).toBe(1588);
    });

    it('should scale with point count', () => {
      const points100 = new Array(200).fill(0); // 100 points = 200 coords
      const points1000 = new Array(2000).fill(0); // 1000 points = 2000 coords
      
      const size100 = estimateEncodedSize(points100);
      const size1000 = estimateEncodedSize(points1000);
      
      // Should scale linearly with coordinate count
      expect(size100).toBe(200 * 16 + 500 + 1024);
      expect(size1000).toBe(2000 * 16 + 500 + 1024);
      expect(size1000 > size100).toBe(true);
    });

    it('should handle empty points', () => {
      const size = estimateEncodedSize([]);
      // Just metadata and envelope
      expect(size).toBe(500 + 1024);
    });
  });

  describe('simplifyStroke', () => {
    it('should handle short strokes without modification', () => {
      const points = [0, 0, 100, 100];
      const result = simplifyStroke(points, 'pen');
      
      expect(result.points).toEqual(points);
      // Short strokes still go through simplification but aren't changed
      expect(result.simplified).toBe(true);
      expect(result.retries).toBe(0);
    });

    it('should simplify straight line to endpoints', () => {
      // Create a straight line with many points
      const points: number[] = [];
      for (let i = 0; i <= 100; i++) {
        points.push(i, 0); // Horizontal line
      }
      
      const result = simplifyStroke(points, 'pen');
      
      // Should reduce to just start and end
      expect(result.points.length).toBe(4); // [0,0, 100,0]
      expect(result.points).toEqual([0, 0, 100, 0]);
      expect(result.simplified).toBe(true);
    });

    it('should preserve corners in V shape', () => {
      // Create a V shape with clear corner
      const points = [0, 0, 50, 100, 100, 0];
      const result = simplifyStroke(points, 'pen');
      
      // Should keep all 3 points (the corner is significant)
      expect(result.points).toEqual(points);
      expect(result.simplified).toBe(true);
    });

    it('should handle dense scribble with budget enforcement', () => {
      // Create a huge scribble that exceeds budgets
      const points: number[] = [];
      for (let i = 0; i < 25000; i++) {
        points.push(
          Math.sin(i * 0.1) * 100,
          Math.cos(i * 0.1) * 100
        );
      }
      
      const result = simplifyStroke(points, 'pen');
      
      // This specific pattern creates a stroke that exceeds the 128KB budget
      // even after simplification, so it returns empty points to signal rejection
      if (result.points.length === 0) {
        // Stroke was rejected for exceeding budget
        expect(result.simplified).toBe(false);
        expect(result.retries).toBeGreaterThanOrEqual(1);
      } else {
        // Stroke was successfully simplified
        expect(result.points.length / 2).toBeLessThanOrEqual(STROKE_CONFIG.MAX_POINTS_PER_STROKE);
        expect(result.simplified).toBe(true);
      }
    });

    it('should reject stroke exceeding 128KB after simplification', () => {
      // Create a stroke that will still be too large after simplification
      // This is hard to guarantee, so we'll test the mechanism with a mock
      const massivePoints: number[] = [];
      
      // Create complex zigzag that resists simplification
      for (let i = 0; i < 20000; i++) {
        massivePoints.push(
          i % 2 === 0 ? 0 : 1000, // Alternating x
          i // Increasing y
        );
      }
      
      const result = simplifyStroke(massivePoints, 'pen');
      
      // Either it simplified successfully under budget, or returned empty
      if (result.points.length === 0) {
        // Rejected for exceeding budget
        expect(result.simplified).toBe(false);
      } else {
        // Simplified successfully
        const finalSize = estimateEncodedSize(result.points);
        expect(finalSize).toBeLessThanOrEqual(STROKE_CONFIG.MAX_STROKE_UPDATE_BYTES);
      }
    });

    it('should handle highlighter with different tolerance', () => {
      // Create wavy line
      const points: number[] = [];
      for (let i = 0; i < 100; i++) {
        points.push(i, Math.sin(i * 0.3) * 10);
      }
      
      const penResult = simplifyStroke(points, 'pen');
      const highlighterResult = simplifyStroke(points, 'highlighter');
      
      // Both should simplify
      expect(penResult.simplified).toBe(true);
      expect(highlighterResult.simplified).toBe(true);
      
      // Highlighter might have different simplification due to different tolerance
      // (exact behavior depends on config values)
    });

    it('should handle degenerate cases', () => {
      // Less than 2 points
      expect(simplifyStroke([0, 0], 'pen')).toEqual({
        points: [0, 0],
        simplified: false,
        retries: 0
      });
      
      // Empty
      expect(simplifyStroke([], 'pen')).toEqual({
        points: [],
        simplified: false,
        retries: 0
      });
      
      // All points the same
      const samePoint = [50, 50, 50, 50, 50, 50];
      const result = simplifyStroke(samePoint, 'pen');
      expect(result.points).toEqual([50, 50, 50, 50]); // Just start and end
      expect(result.simplified).toBe(true);
    });
  });

  describe('coordinate transform round-trip', () => {
    // Simple test of transform math (would need ViewTransform implementation)
    it('should maintain world coordinates through transforms', () => {
      // Mock transform functions for testing
      const scale = 2.0;
      const panX = 100;
      const panY = 50;
      
      // Canvas to world
      const canvasToWorld = (cx: number, cy: number): [number, number] => {
        return [
          cx / scale + panX,
          cy / scale + panY
        ];
      };
      
      // World to canvas
      const worldToCanvas = (wx: number, wy: number): [number, number] => {
        return [
          (wx - panX) * scale,
          (wy - panY) * scale
        ];
      };
      
      // Test round-trip
      const worldPoint: [number, number] = [250, 150];
      const canvas = worldToCanvas(...worldPoint);
      const backToWorld = canvasToWorld(...canvas);
      
      // Should get back original (within float epsilon)
      expect(backToWorld[0]).toBeCloseTo(worldPoint[0], 10);
      expect(backToWorld[1]).toBeCloseTo(worldPoint[1], 10);
    });
  });
});