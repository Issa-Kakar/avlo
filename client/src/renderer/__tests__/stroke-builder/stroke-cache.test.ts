import { describe, it, expect, beforeEach } from 'vitest';
import { StrokeRenderCache } from '../../stroke-builder/stroke-cache';
import type { StrokeView } from '@avlo/shared';

describe('StrokeRenderCache', () => {
  let cache: StrokeRenderCache;

  const createTestStroke = (id: string, points?: number[]): StrokeView => ({
    id,
    points: points || [100, 100, 200, 200],
    polyline: null,
    style: { color: '#000', size: 2, opacity: 1, tool: 'pen' },
    bbox: [100, 100, 200, 200],
    scene: 0,
    createdAt: Date.now(),
    userId: 'test-user',
  });

  beforeEach(() => {
    cache = new StrokeRenderCache(3); // Small cache for testing
  });

  describe('basic caching', () => {
    it('should cache render data by stroke ID', () => {
      const stroke = createTestStroke('stroke-1');

      const data1 = cache.getOrBuild(stroke);
      const data2 = cache.getOrBuild(stroke);

      expect(data1).toBe(data2); // Same reference - cached
      expect(cache.size).toBe(1);
    });

    it('should build different render data for different strokes', () => {
      const stroke1 = createTestStroke('stroke-1', [0, 0, 100, 100]);
      const stroke2 = createTestStroke('stroke-2', [200, 200, 300, 300]);

      const data1 = cache.getOrBuild(stroke1);
      const data2 = cache.getOrBuild(stroke2);

      expect(data1).not.toBe(data2);
      expect(data1.polyline[0]).toBe(0);
      expect(data2.polyline[0]).toBe(200);
      expect(cache.size).toBe(2);
    });

    it('should reuse cache even if stroke object reference changes', () => {
      const stroke1 = createTestStroke('stroke-1');
      const data1 = cache.getOrBuild(stroke1);

      // Same ID but different object reference
      const stroke2 = createTestStroke('stroke-1');
      const data2 = cache.getOrBuild(stroke2);

      expect(data1).toBe(data2); // Should use cached data
      expect(cache.size).toBe(1);
    });
  });

  describe('FIFO eviction', () => {
    it('should evict oldest entry when cache is full', () => {
      const stroke1 = createTestStroke('stroke-1');
      const stroke2 = createTestStroke('stroke-2');
      const stroke3 = createTestStroke('stroke-3');
      const stroke4 = createTestStroke('stroke-4');

      // Fill cache to capacity
      const data1 = cache.getOrBuild(stroke1);
      cache.getOrBuild(stroke2);
      cache.getOrBuild(stroke3);
      expect(cache.size).toBe(3);

      // Add one more - should evict stroke-1 (oldest)
      cache.getOrBuild(stroke4);
      expect(cache.size).toBe(3);

      // Stroke 1 should need rebuilding (was evicted)
      const data1New = cache.getOrBuild(stroke1);
      expect(data1New).not.toBe(data1); // Different reference - was rebuilt
      expect(cache.size).toBe(3); // Still at capacity (stroke-2 was evicted)
    });

    it('should maintain FIFO order across multiple evictions', () => {
      // Add strokes 1-3
      cache.getOrBuild(createTestStroke('stroke-1'));
      cache.getOrBuild(createTestStroke('stroke-2'));
      cache.getOrBuild(createTestStroke('stroke-3'));

      // Add 4 (evicts 1)
      cache.getOrBuild(createTestStroke('stroke-4'));

      // Add 5 (evicts 2)
      cache.getOrBuild(createTestStroke('stroke-5'));

      // Check that 3, 4, 5 are still cached
      const stroke3 = createTestStroke('stroke-3');
      const stroke4 = createTestStroke('stroke-4');
      const stroke5 = createTestStroke('stroke-5');

      const data3 = cache.getOrBuild(stroke3);
      const _data4 = cache.getOrBuild(stroke4);
      const _data5 = cache.getOrBuild(stroke5);

      // Accessing cached items shouldn't change size
      expect(cache.size).toBe(3);

      // Now add stroke-6, should evict stroke-3 (oldest of current set)
      cache.getOrBuild(createTestStroke('stroke-6'));

      // stroke-3 should need rebuilding
      const data3New = cache.getOrBuild(stroke3);
      expect(data3New).not.toBe(data3); // Was evicted and rebuilt
    });

    it('should handle cache size of 1 correctly', () => {
      const smallCache = new StrokeRenderCache(1);

      const stroke1 = createTestStroke('stroke-1');
      const stroke2 = createTestStroke('stroke-2');

      smallCache.getOrBuild(stroke1);
      expect(smallCache.size).toBe(1);

      smallCache.getOrBuild(stroke2);
      expect(smallCache.size).toBe(1); // Still 1, stroke-1 evicted

      // stroke-1 should be evicted
      const _data1New = smallCache.getOrBuild(stroke1);
      expect(smallCache.size).toBe(1); // stroke-2 now evicted
    });
  });

  describe('invalidation', () => {
    it('should invalidate specific stroke', () => {
      const stroke = createTestStroke('stroke-1');

      const data1 = cache.getOrBuild(stroke);
      expect(cache.size).toBe(1);

      cache.invalidate('stroke-1');
      expect(cache.size).toBe(0);

      // Should rebuild on next access
      const data2 = cache.getOrBuild(stroke);
      expect(data2).not.toBe(data1); // Different reference - was rebuilt
    });

    it('should handle invalidating non-existent stroke gracefully', () => {
      cache.getOrBuild(createTestStroke('stroke-1'));
      expect(cache.size).toBe(1);

      cache.invalidate('non-existent');
      expect(cache.size).toBe(1); // No change
    });

    it('should allow selective invalidation', () => {
      const stroke1 = createTestStroke('stroke-1');
      const stroke2 = createTestStroke('stroke-2');
      const stroke3 = createTestStroke('stroke-3');

      const data1 = cache.getOrBuild(stroke1);
      const data2 = cache.getOrBuild(stroke2);
      const data3 = cache.getOrBuild(stroke3);
      expect(cache.size).toBe(3);

      // Invalidate only stroke-2
      cache.invalidate('stroke-2');
      expect(cache.size).toBe(2);

      // stroke-1 and stroke-3 should still be cached
      expect(cache.getOrBuild(stroke1)).toBe(data1);
      expect(cache.getOrBuild(stroke3)).toBe(data3);

      // stroke-2 should be rebuilt
      expect(cache.getOrBuild(stroke2)).not.toBe(data2);
    });
  });

  describe('clear', () => {
    it('should clear entire cache', () => {
      cache.getOrBuild(createTestStroke('stroke-1'));
      cache.getOrBuild(createTestStroke('stroke-2'));
      expect(cache.size).toBe(2);

      cache.clear();
      expect(cache.size).toBe(0);
    });

    it('should require rebuilding all strokes after clear', () => {
      const stroke1 = createTestStroke('stroke-1');
      const stroke2 = createTestStroke('stroke-2');

      const data1 = cache.getOrBuild(stroke1);
      const data2 = cache.getOrBuild(stroke2);

      cache.clear();

      const data1New = cache.getOrBuild(stroke1);
      const data2New = cache.getOrBuild(stroke2);

      expect(data1New).not.toBe(data1);
      expect(data2New).not.toBe(data2);
    });

    it('should work correctly after clear', () => {
      cache.getOrBuild(createTestStroke('stroke-1'));
      cache.clear();

      // Cache should work normally after clear
      const stroke = createTestStroke('stroke-2');
      const data1 = cache.getOrBuild(stroke);
      const data2 = cache.getOrBuild(stroke);

      expect(data1).toBe(data2); // Should be cached
      expect(cache.size).toBe(1);
    });
  });

  describe('default size', () => {
    it('should default to 1000 max size', () => {
      const defaultCache = new StrokeRenderCache();

      // Add many strokes
      for (let i = 0; i < 1000; i++) {
        defaultCache.getOrBuild(createTestStroke(`stroke-${i}`));
      }
      expect(defaultCache.size).toBe(1000);

      // Add one more
      defaultCache.getOrBuild(createTestStroke('stroke-1000'));
      expect(defaultCache.size).toBe(1000); // Still at max
    });
  });

  describe('edge cases', () => {
    it('should handle empty points in stroke', () => {
      const emptyStroke = createTestStroke('empty', []);
      const data = cache.getOrBuild(emptyStroke);

      expect(data.pointCount).toBe(0);
      expect(data.polyline.length).toBe(0);
      expect(cache.size).toBe(1);
    });

    it('should handle cache operations in sequence', () => {
      const stroke1 = createTestStroke('stroke-1');

      // Build, invalidate, rebuild, clear, rebuild
      const data1 = cache.getOrBuild(stroke1);
      cache.invalidate('stroke-1');
      const data2 = cache.getOrBuild(stroke1);
      cache.clear();
      const data3 = cache.getOrBuild(stroke1);

      // All should be different references
      expect(data1).not.toBe(data2);
      expect(data2).not.toBe(data3);
      expect(data1).not.toBe(data3);
    });

    it('should handle rapid add/remove cycles', () => {
      const stroke = createTestStroke('stroke-1');

      for (let i = 0; i < 10; i++) {
        cache.getOrBuild(stroke);
        cache.invalidate('stroke-1');
      }

      expect(cache.size).toBe(0);

      // Should still work after cycles
      const data = cache.getOrBuild(stroke);
      expect(data).toBeDefined();
      expect(cache.size).toBe(1);
    });
  });
});
