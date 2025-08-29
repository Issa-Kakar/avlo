import { describe, it, expect, beforeEach } from 'vitest';
import { DirtyRectTracker } from '../DirtyRectTracker';
import { DIRTY_RECT_CONFIG } from '../types';

describe('DirtyRectTracker', () => {
  let tracker: DirtyRectTracker;

  beforeEach(() => {
    tracker = new DirtyRectTracker();
    tracker.setCanvasSize(800, 600);
  });

  describe('coalescing', () => {
    it('should merge overlapping rectangles', () => {
      tracker.invalidateCanvasPixels({ x: 0, y: 0, width: 100, height: 100 });
      tracker.invalidateCanvasPixels({ x: 50, y: 50, width: 100, height: 100 });
      tracker.coalesce();

      const instructions = tracker.getClearInstructions();
      expect(instructions.type).toBe('dirty');
      expect(instructions.rects).toHaveLength(1);

      // Should be union of both rects plus margins
      const rect = instructions.rects![0];
      expect(rect.width).toBeGreaterThanOrEqual(150);
    });

    it('should apply AA margin to all rectangles', () => {
      tracker.invalidateCanvasPixels({ x: 100, y: 100, width: 50, height: 50 });

      const instructions = tracker.getClearInstructions();
      expect(instructions.type).toBe('dirty');
      expect(instructions.rects).toHaveLength(1);

      const rect = instructions.rects![0];
      const totalMargin = DIRTY_RECT_CONFIG.AA_MARGIN + DIRTY_RECT_CONFIG.MAX_WORLD_LINE_WIDTH; // scale=1 in test
      expect(rect.x).toBeLessThanOrEqual(100 - totalMargin);
      expect(rect.y).toBeLessThanOrEqual(100 - totalMargin);
      expect(rect.width).toBeGreaterThanOrEqual(50 + 2 * totalMargin);
      expect(rect.height).toBeGreaterThanOrEqual(50 + 2 * totalMargin);
    });
  });

  describe('promotion rules', () => {
    it('should promote to full clear when rect count exceeds threshold', () => {
      for (let i = 0; i < DIRTY_RECT_CONFIG.MAX_RECT_COUNT + 1; i++) {
        tracker.invalidateCanvasPixels({
          x: i * 10,
          y: i * 10,
          width: 5,
          height: 5,
        });
      }

      const instructions = tracker.getClearInstructions();
      expect(instructions.type).toBe('full');
    });

    it('should promote to full clear when area ratio exceeds threshold', () => {
      // Create a large rectangle covering > 33% of canvas
      const largeWidth = 800 * 0.6;
      const largeHeight = 600 * 0.6;
      tracker.invalidateCanvasPixels({
        x: 0,
        y: 0,
        width: largeWidth,
        height: largeHeight,
      });

      const instructions = tracker.getClearInstructions();
      expect(instructions.type).toBe('full');
    });
  });

  describe('transform changes', () => {
    it('should force full clear on transform change', () => {
      const transform1 = { scale: 1, pan: { x: 0, y: 0 } };
      const transform2 = { scale: 2, pan: { x: 0, y: 0 } };

      tracker.notifyTransformChange(transform1);
      tracker.invalidateCanvasPixels({ x: 0, y: 0, width: 100, height: 100 });

      let instructions = tracker.getClearInstructions();
      expect(instructions.type).toBe('dirty');

      tracker.reset();
      tracker.notifyTransformChange(transform2);

      instructions = tracker.getClearInstructions();
      expect(instructions.type).toBe('full');
    });

    it('should clear queued rects on transform change', () => {
      tracker.invalidateCanvasPixels({ x: 0, y: 0, width: 100, height: 100 });
      tracker.notifyTransformChange({ scale: 2, pan: { x: 10, y: 10 } });

      const instructions = tracker.getClearInstructions();
      expect(instructions.type).toBe('full');
      expect(instructions.rects).toBeUndefined();
    });
  });

  describe('world to canvas conversion', () => {
    it('should correctly convert world bounds to canvas pixels', () => {
      const viewTransform = {
        scale: 2,
        pan: { x: 10, y: 20 },
        worldToCanvas: (x: number, y: number): [number, number] => [(x - 10) * 2, (y - 20) * 2],
        canvasToWorld: (x: number, y: number): [number, number] => [x / 2 + 10, y / 2 + 20],
      };
      const worldBounds = { minX: 50, minY: 60, maxX: 100, maxY: 110 };

      tracker.invalidateWorldBounds(worldBounds, viewTransform);

      const instructions = tracker.getClearInstructions();
      expect(instructions.type).toBe('dirty');
      expect(instructions.rects).toHaveLength(1);

      // Verify conversion math: canvas = (world - pan) * scale
      // minX: (50 - 10) * 2 = 80
      // minY: (60 - 20) * 2 = 80
      const rect = instructions.rects![0];
      const margin =
        DIRTY_RECT_CONFIG.AA_MARGIN + DIRTY_RECT_CONFIG.MAX_WORLD_LINE_WIDTH * viewTransform.scale;
      expect(rect.x).toBeCloseTo(80 - margin, 0);
      expect(rect.y).toBeCloseTo(80 - margin, 0);
    });
  });
});
