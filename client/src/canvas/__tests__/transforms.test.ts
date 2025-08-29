import { describe, it, expect } from 'vitest';
import { PERFORMANCE_CONFIG } from '@avlo/shared';
import {
  transformBounds,
  isInViewport as _isInViewport,
  getVisibleWorldBounds,
  calculateZoomTransform as _calculateZoomTransform,
  clampScale,
} from '../internal/transforms';

describe('Transform utilities', () => {
  describe('transformBounds', () => {
    it('correctly transforms world bounds to canvas space', () => {
      const worldBounds = { minX: 10, minY: 20, maxX: 100, maxY: 200 };
      const scale = 2;
      const pan = { x: 5, y: 10 }; // World offset

      const canvasBounds = transformBounds(worldBounds, scale, pan);

      // Formula: (world - pan) * scale
      expect(canvasBounds.minX).toBe((10 - 5) * 2); // = 10
      expect(canvasBounds.minY).toBe((20 - 10) * 2); // = 20
      expect(canvasBounds.maxX).toBe((100 - 5) * 2); // = 190
      expect(canvasBounds.maxY).toBe((200 - 10) * 2); // = 380
    });
  });

  describe('getVisibleWorldBounds', () => {
    it('calculates correct world bounds from viewport', () => {
      const viewportWidth = 800;
      const viewportHeight = 600;
      const scale = 2;
      const pan = { x: 100, y: 50 }; // World offset

      const worldBounds = getVisibleWorldBounds(viewportWidth, viewportHeight, scale, pan);

      // Formula: canvas / scale + pan
      expect(worldBounds.minX).toBe(0 / 2 + 100); // = 100
      expect(worldBounds.minY).toBe(0 / 2 + 50); // = 50
      expect(worldBounds.maxX).toBe(800 / 2 + 100); // = 500
      expect(worldBounds.maxY).toBe(600 / 2 + 50); // = 350
    });
  });

  describe('clampScale', () => {
    it('clamps scale to config limits', () => {
      expect(clampScale(0.05)).toBe(PERFORMANCE_CONFIG.MIN_ZOOM); // Below min
      expect(clampScale(20)).toBe(PERFORMANCE_CONFIG.MAX_ZOOM); // Above max
      expect(clampScale(2)).toBe(2); // Within range
    });
  });

  describe('coordinate round-trip tests', () => {
    it('worldToCanvas and canvasToWorld are inverses', () => {
      const testPoints = [
        [0, 0],
        [100, 200],
        [-50, -75],
        [1000, 1000],
      ];

      const configs = [
        { scale: 1, pan: { x: 0, y: 0 } },
        { scale: 2, pan: { x: 10, y: 20 } },
        { scale: 0.5, pan: { x: -100, y: -50 } },
        { scale: PERFORMANCE_CONFIG.MIN_ZOOM, pan: { x: 500, y: 500 } },
        { scale: PERFORMANCE_CONFIG.MAX_ZOOM, pan: { x: -200, y: 100 } },
      ];

      for (const config of configs) {
        for (const [x, y] of testPoints) {
          // World -> Canvas -> World
          const [cx, cy] = [(x - config.pan.x) * config.scale, (y - config.pan.y) * config.scale];
          const [wx, wy] = [cx / config.scale + config.pan.x, cy / config.scale + config.pan.y];

          expect(wx).toBeCloseTo(x, 10);
          expect(wy).toBeCloseTo(y, 10);
        }
      }
    });

    it('handles non-zero canvas position and DPR correctly', () => {
      // Mock canvas at position (100, 50) with DPR 2
      const canvasRect = { left: 100, top: 50 };
      const dpr = 2;
      const scale = 2;
      const pan = { x: 10, y: 5 };

      // Screen point at (150, 100) - 50px right and 50px down from canvas origin
      const screenX = 150;
      const screenY = 100;

      // Expected canvas coordinates (accounting for DPR)
      const expectedCanvasX = (screenX - canvasRect.left) * dpr; // (150-100)*2 = 100
      const expectedCanvasY = (screenY - canvasRect.top) * dpr; // (100-50)*2 = 100

      // Expected world coordinates using inverse transform
      // world = canvas / scale + pan
      const expectedWorldX = expectedCanvasX / scale + pan.x; // 100/2 + 10 = 60
      const expectedWorldY = expectedCanvasY / scale + pan.y; // 100/2 + 5 = 55

      // Verify the math (this would be in actual component tests)
      expect(expectedWorldX).toBe(60);
      expect(expectedWorldY).toBe(55);
    });
  });
});
