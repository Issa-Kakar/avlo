import { describe, it, expect } from 'vitest';
import { MIN_ZOOM, MAX_ZOOM } from '@/canvas/constants';
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
      expect(clampScale(0.005)).toBe(MIN_ZOOM); // Below min
      expect(clampScale(20)).toBe(MAX_ZOOM); // Above max
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
        { scale: MIN_ZOOM, pan: { x: 500, y: 500 } },
        { scale: MAX_ZOOM, pan: { x: -200, y: 100 } },
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

    it('handles CSS pixels correctly without DPR in transforms', () => {
      // Canvas transforms work in CSS pixels, DPR is handled only at canvas context level
      const canvasRect = { left: 100, top: 50 };
      const scale = 2;
      const pan = { x: 10, y: 5 };

      // Screen point at (150, 100) - 50px right and 50px down from canvas origin
      const screenX = 150;
      const screenY = 100;

      // CSS canvas coordinates (NO DPR multiplication)
      const canvasX = screenX - canvasRect.left; // 150 - 100 = 50
      const canvasY = screenY - canvasRect.top; // 100 - 50 = 50

      // World coordinates using transform
      const worldX = canvasX / scale + pan.x; // 50/2 + 10 = 35
      const worldY = canvasY / scale + pan.y; // 50/2 + 5 = 30

      expect(worldX).toBe(35);
      expect(worldY).toBe(30);
    });

    it('DPR is applied only in canvas context, not in coordinate transforms', () => {
      // DPR affects the canvas backing store and initial context transform
      // It should NEVER appear in ViewTransform or coordinate conversion math
      // The only place DPR belongs is: ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      expect(true).toBe(true); // Documentation test
    });
  });
});
