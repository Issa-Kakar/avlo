import { describe, it, expect } from 'vitest';
import { buildStrokeRenderData, isStrokeVisible } from '../../stroke-builder/path-builder';
import type { StrokeView } from '@avlo/shared';

describe('Path Builder', () => {
  describe('buildStrokeRenderData', () => {
    it('should handle empty points array', () => {
      const stroke: StrokeView = {
        id: 'test-1',
        points: [],
        polyline: null,
        style: { color: '#000', size: 2, opacity: 1, tool: 'pen' },
        bbox: [0, 0, 0, 0],
        scene: 0,
        createdAt: Date.now(),
        userId: 'test-user',
      };

      const result = buildStrokeRenderData(stroke);

      expect(result.pointCount).toBe(0);
      expect(result.polyline.length).toBe(0);
      expect(result.bounds).toEqual({ x: 0, y: 0, width: 0, height: 0 });
    });

    it('should build path from points array', () => {
      const stroke: StrokeView = {
        id: 'test-2',
        points: [100, 100, 150, 150, 200, 100], // 3 points
        polyline: null,
        style: { color: '#000', size: 2, opacity: 1, tool: 'pen' },
        bbox: [100, 100, 200, 150],
        scene: 0,
        createdAt: Date.now(),
        userId: 'test-user',
      };

      const result = buildStrokeRenderData(stroke);

      expect(result.pointCount).toBe(3);
      expect(result.polyline.length).toBe(6); // 3 points * 2 coords
      expect(result.polyline[0]).toBe(100);
      expect(result.polyline[1]).toBe(100);
      expect(result.polyline[4]).toBe(200);
      expect(result.polyline[5]).toBe(100);
    });

    it('should handle multiple points correctly', () => {
      const stroke: StrokeView = {
        id: 'test-3',
        points: [100, 100, 150, 150, 200, 100], // 3 points in standard format
        polyline: null,
        style: { color: '#000', size: 2, opacity: 1, tool: 'pen' },
        bbox: [100, 100, 200, 150],
        scene: 0,
        createdAt: Date.now(),
        userId: 'test-user',
      };

      const result = buildStrokeRenderData(stroke);

      expect(result.pointCount).toBe(3);
      expect(result.polyline.length).toBe(6); // 3 points * 2 coords
    });

    it('should handle points array with even length', () => {
      const stroke: StrokeView = {
        id: 'test-even-length',
        points: [100, 100, 200, 200, 300, 300], // 3 points
        polyline: null,
        style: { color: '#000', size: 2, opacity: 1, tool: 'pen' },
        bbox: [100, 100, 300, 300],
        scene: 0,
        createdAt: Date.now(),
        userId: 'test-user',
      };

      const result = buildStrokeRenderData(stroke);

      expect(result.pointCount).toBe(3); // 6 values / 2 = 3 points
    });

    it('should handle longer stroke paths', () => {
      const stroke: StrokeView = {
        id: 'test-long-stroke',
        points: [100, 100, 150, 150, 200, 200, 250, 250, 300, 300, 350, 250, 400, 200],
        polyline: null,
        style: { color: '#000', size: 2, opacity: 1, tool: 'pen' },
        bbox: [100, 100, 400, 300],
        scene: 0,
        createdAt: Date.now(),
        userId: 'test-user',
      };

      const result = buildStrokeRenderData(stroke);

      expect(result.pointCount).toBe(7); // 14 values / 2 = 7 points
      expect(result.polyline.length).toBe(14);
    });

    it('should calculate correct bounds', () => {
      const stroke: StrokeView = {
        id: 'test-4',
        points: [50, 75, 200, 25, 100, 150, 25, 100],
        polyline: null,
        style: { color: '#000', size: 2, opacity: 1, tool: 'pen' },
        bbox: [25, 25, 200, 150],
        scene: 0,
        createdAt: Date.now(),
        userId: 'test-user',
      };

      const result = buildStrokeRenderData(stroke);

      // Using plain object bounds, not DOMRect
      expect(result.bounds.x).toBe(25);
      expect(result.bounds.y).toBe(25);
      expect(result.bounds.width).toBe(175); // 200 - 25
      expect(result.bounds.height).toBe(125); // 150 - 25
    });

    it('should handle single point stroke', () => {
      const stroke: StrokeView = {
        id: 'test-single',
        points: [100, 100],
        polyline: null,
        style: { color: '#000', size: 2, opacity: 1, tool: 'pen' },
        bbox: [100, 100, 100, 100],
        scene: 0,
        createdAt: Date.now(),
        userId: 'test-user',
      };

      const result = buildStrokeRenderData(stroke);

      expect(result.pointCount).toBe(1);
      expect(result.polyline.length).toBe(2);
      expect(result.bounds).toEqual({ x: 100, y: 100, width: 0, height: 0 });
    });

    it('should handle Path2D not being available in test environment', () => {
      const stroke: StrokeView = {
        id: 'test-no-path2d',
        points: [100, 100, 200, 200],
        polyline: null,
        style: { color: '#000', size: 2, opacity: 1, tool: 'pen' },
        bbox: [100, 100, 200, 200],
        scene: 0,
        createdAt: Date.now(),
        userId: 'test-user',
      };

      const result = buildStrokeRenderData(stroke);

      // In Node/Vitest, Path2D won't exist
      expect(result.path).toBe(null);
      expect(result.polyline).toBeDefined();
      expect(result.polyline.length).toBe(4);
    });
  });

  describe('isStrokeVisible', () => {
    const stroke: StrokeView = {
      id: 'test-vis',
      points: [100, 100, 200, 200],
      polyline: null,
      style: { color: '#000', size: 10, opacity: 1, tool: 'pen' }, // Size 10 for testing inflation
      bbox: [100, 100, 200, 200],
      scene: 0,
      createdAt: Date.now(),
      userId: 'test-user',
    };

    it('should return true for stroke fully in viewport', () => {
      const viewport = { minX: 0, minY: 0, maxX: 300, maxY: 300 };
      expect(isStrokeVisible(stroke, viewport)).toBe(true);
    });

    it('should return false for stroke completely outside viewport', () => {
      const viewport = { minX: 300, minY: 300, maxX: 400, maxY: 400 };
      expect(isStrokeVisible(stroke, viewport)).toBe(false);
    });

    it('should return true for stroke partially in viewport', () => {
      const viewport = { minX: 150, minY: 150, maxX: 300, maxY: 300 };
      expect(isStrokeVisible(stroke, viewport)).toBe(true);
    });

    it('should account for stroke width inflation when checking visibility', () => {
      // Viewport just outside the bbox but within stroke width
      const viewport = { minX: 206, minY: 206, maxX: 300, maxY: 300 };
      // Stroke bbox is [100, 100, 200, 200] with size 10
      // Half width is 5, so inflated bbox is [95, 95, 205, 205]
      // Viewport starts at 206, which is just outside inflated bbox
      expect(isStrokeVisible(stroke, viewport)).toBe(false);

      // Now viewport at edge of inflated bbox
      const viewport2 = { minX: 205, minY: 205, maxX: 300, maxY: 300 };
      expect(isStrokeVisible(stroke, viewport2)).toBe(true);
    });

    it('should handle strokes at viewport edges correctly', () => {
      const edgeStroke: StrokeView = {
        id: 'edge-stroke',
        points: [0, 0, 10, 10],
        polyline: null,
        style: { color: '#000', size: 4, opacity: 1, tool: 'pen' },
        bbox: [0, 0, 10, 10],
        scene: 0,
        createdAt: Date.now(),
        userId: 'test-user',
      };

      // Viewport that starts right at the stroke
      const viewport = { minX: 0, minY: 0, maxX: 100, maxY: 100 };
      expect(isStrokeVisible(edgeStroke, viewport)).toBe(true);

      // Viewport that starts just after the inflated stroke
      const viewport2 = { minX: 13, minY: 13, maxX: 100, maxY: 100 };
      // Inflated bbox is [-2, -2, 12, 12] with halfWidth=2
      expect(isStrokeVisible(edgeStroke, viewport2)).toBe(false);
    });
  });
});
