import { describe, it, expect, beforeEach } from 'vitest';
import { DirtyRectTracker } from '../DirtyRectTracker';
import { DIRTY_RECT_CONFIG } from '../types';
import { createTestViewTransform } from './test-helpers';

describe('DirtyRectTracker', () => {
  let tracker: DirtyRectTracker;

  beforeEach(() => {
    tracker = new DirtyRectTracker();
    tracker.setCanvasSize(800, 600, 1); // Simple DPR=1 for tests
  });

  describe('basic operations', () => {
    it('should start with no dirty rects', () => {
      const instructions = tracker.getClearInstructions();
      expect(instructions.type).toBe('none');
    });

    it('should track a single dirty rect', () => {
      tracker.invalidateCanvasPixels({ x: 10, y: 10, width: 100, height: 100 });

      const instructions = tracker.getClearInstructions();
      expect(instructions.type).toBe('dirty');
      expect(instructions.rects).toHaveLength(1);
    });

    it('should reset after calling reset()', () => {
      tracker.invalidateCanvasPixels({ x: 0, y: 0, width: 100, height: 100 });
      tracker.reset();

      const instructions = tracker.getClearInstructions();
      expect(instructions.type).toBe('none');
    });
  });

  describe('coalescing', () => {
    it('should merge overlapping rectangles', () => {
      // Two overlapping rects
      tracker.invalidateCanvasPixels({ x: 0, y: 0, width: 100, height: 100 });
      tracker.invalidateCanvasPixels({ x: 50, y: 50, width: 100, height: 100 });
      tracker.coalesce();

      const instructions = tracker.getClearInstructions();
      expect(instructions.type).toBe('dirty');
      expect(instructions.rects).toHaveLength(1); // Should be merged

      // Verify the merged rect covers both areas (with margins)
      const rect = instructions.rects![0];
      expect(rect.width).toBeGreaterThanOrEqual(150);
      expect(rect.height).toBeGreaterThanOrEqual(150);
    });

    it('should not merge non-overlapping rectangles', () => {
      // Two non-overlapping rects with sufficient gap
      tracker.invalidateCanvasPixels({ x: 0, y: 0, width: 50, height: 50 });
      tracker.invalidateCanvasPixels({ x: 200, y: 200, width: 50, height: 50 });
      tracker.coalesce();

      const instructions = tracker.getClearInstructions();
      expect(instructions.type).toBe('dirty');
      expect(instructions.rects).toHaveLength(2); // Should remain separate
    });
  });

  describe('promotion to full clear', () => {
    it('should promote when rect count exceeds threshold', () => {
      // Add more rects than the max allowed
      for (let i = 0; i <= DIRTY_RECT_CONFIG.MAX_RECT_COUNT; i++) {
        tracker.invalidateCanvasPixels({
          x: i * 5,
          y: i * 5,
          width: 2,
          height: 2,
        });
      }

      const instructions = tracker.getClearInstructions();
      expect(instructions.type).toBe('full');
      expect(instructions.rects).toBeUndefined();
    });

    it('should promote when area ratio exceeds threshold', () => {
      // Create a rect covering more than 33% of canvas
      const largeRect = {
        x: 0,
        y: 0,
        width: 600, // 75% of 800
        height: 450, // 75% of 600
      };
      tracker.invalidateCanvasPixels(largeRect);

      const instructions = tracker.getClearInstructions();
      expect(instructions.type).toBe('full');
    });

    it('should force full clear with invalidateAll()', () => {
      tracker.invalidateCanvasPixels({ x: 10, y: 10, width: 20, height: 20 });
      tracker.invalidateAll('content-change');

      const instructions = tracker.getClearInstructions();
      expect(instructions.type).toBe('full');
    });
  });

  describe('transform changes', () => {
    it('should not force full clear on first transform notification', () => {
      const transform = { scale: 1, pan: { x: 0, y: 0 } };
      tracker.notifyTransformChange(transform);

      const instructions = tracker.getClearInstructions();
      expect(instructions.type).toBe('none'); // No change from initial state
    });

    it('should force full clear when scale changes', () => {
      // Set initial transform
      tracker.notifyTransformChange({ scale: 1, pan: { x: 0, y: 0 } });
      tracker.reset(); // Clear any pending state

      // Add a dirty rect
      tracker.invalidateCanvasPixels({ x: 10, y: 10, width: 50, height: 50 });

      // Change scale
      tracker.notifyTransformChange({ scale: 2, pan: { x: 0, y: 0 } });

      const instructions = tracker.getClearInstructions();
      expect(instructions.type).toBe('full');
    });

    it('should force full clear when pan changes', () => {
      // Set initial transform
      tracker.notifyTransformChange({ scale: 1, pan: { x: 0, y: 0 } });
      tracker.reset();

      // Add a dirty rect
      tracker.invalidateCanvasPixels({ x: 10, y: 10, width: 50, height: 50 });

      // Change pan
      tracker.notifyTransformChange({ scale: 1, pan: { x: 100, y: 50 } });

      const instructions = tracker.getClearInstructions();
      expect(instructions.type).toBe('full');
    });
  });

  describe('world to canvas conversion', () => {
    it('should convert world bounds to canvas pixels correctly', () => {
      const viewTransform = createTestViewTransform(2, 10, 20); // scale=2, pan=(10,20)
      const worldBounds = { minX: 50, minY: 60, maxX: 100, maxY: 110 };

      tracker.invalidateWorldBounds(worldBounds, viewTransform);

      const instructions = tracker.getClearInstructions();
      expect(instructions.type).toBe('dirty');
      expect(instructions.rects).toHaveLength(1);

      // Canvas coords should be (world - pan) * scale
      // minX: (50 - 10) * 2 = 80
      // minY: (60 - 20) * 2 = 80
      // width: 50 * 2 = 100
      // height: 50 * 2 = 100
      const rect = instructions.rects![0];

      // Account for margins added by invalidateCanvasPixels
      const margin = DIRTY_RECT_CONFIG.AA_MARGIN + DIRTY_RECT_CONFIG.MAX_WORLD_LINE_WIDTH * 2;
      expect(rect.x).toBeLessThanOrEqual(80);
      expect(rect.y).toBeLessThanOrEqual(80);
      expect(rect.width).toBeGreaterThanOrEqual(100);
      expect(rect.height).toBeGreaterThanOrEqual(100);
    });

    it('should handle invalid scale by forcing full clear', () => {
      const invalidTransform = createTestViewTransform(0, 0, 0); // scale=0 is invalid
      const worldBounds = { minX: 0, minY: 0, maxX: 100, maxY: 100 };

      tracker.invalidateWorldBounds(worldBounds, invalidTransform);

      const instructions = tracker.getClearInstructions();
      expect(instructions.type).toBe('full'); // Should force full clear for safety
    });
  });

  describe('margin application', () => {
    it('should apply AA margin and stroke margin to rectangles', () => {
      const scale = 1;
      tracker.invalidateCanvasPixels({ x: 100, y: 100, width: 50, height: 50 }, scale);

      const instructions = tracker.getClearInstructions();
      const rect = instructions.rects![0];

      // Total margin = AA_MARGIN + (MAX_WORLD_LINE_WIDTH * scale)
      const expectedMargin = DIRTY_RECT_CONFIG.AA_MARGIN + DIRTY_RECT_CONFIG.MAX_WORLD_LINE_WIDTH;

      // Rect should be expanded by margin on all sides
      expect(rect.x).toBeLessThan(100);
      expect(rect.y).toBeLessThan(100);
      expect(rect.width).toBeGreaterThan(50);
      expect(rect.height).toBeGreaterThan(50);
    });
  });
});
