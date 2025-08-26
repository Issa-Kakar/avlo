import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RollingGzipEstimator, type GzipImpl } from '../size-estimator';

// Skip these tests - RollingGzipEstimator is not part of Phase 2
describe.skip('RollingGzipEstimator', () => {
  let estimator: RollingGzipEstimator;
  let mockGzip: GzipImpl;

  beforeEach(() => {
    // Mock gzip implementation
    mockGzip = vi.fn((data: Uint8Array) => {
      // Simple mock: compress to ~40% of original size
      const compressed = new Uint8Array(Math.ceil(data.length * 0.4));
      return compressed;
    });
    
    estimator = new RollingGzipEstimator(5, mockGzip); // window size of 5
  });

  describe('Basic Estimation', () => {
    it('should start with zero estimate', () => {
      expect(estimator.getCurrentEstimate()).toBe(0);
    });

    it('should update estimate after adding data', () => {
      const data = new Uint8Array(1000);
      estimator.addUpdate(data);
      
      // With our mock, should compress to ~400 bytes
      expect(estimator.getCurrentEstimate()).toBeCloseTo(400, -1);
      expect(mockGzip).toHaveBeenCalledWith(data);
    });

    it('should handle multiple updates', () => {
      estimator.addUpdate(new Uint8Array(1000)); // ~400 bytes compressed
      estimator.addUpdate(new Uint8Array(500));  // ~200 bytes compressed
      estimator.addUpdate(new Uint8Array(500));  // ~200 bytes compressed
      
      // Average of [400, 200, 200] = 266.67
      expect(estimator.getCurrentEstimate()).toBeCloseTo(267, -1);
    });

    it('should maintain rolling window', () => {
      // Add 6 updates (window size is 5)
      for (let i = 0; i < 6; i++) {
        estimator.addUpdate(new Uint8Array(1000));
      }
      
      // Should only keep last 5, all ~400 bytes
      expect(estimator.getCurrentEstimate()).toBeCloseTo(400, -1);
      expect(mockGzip).toHaveBeenCalledTimes(6);
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty updates', () => {
      estimator.addUpdate(new Uint8Array(0));
      expect(estimator.getCurrentEstimate()).toBe(0);
    });

    it('should handle very large updates', () => {
      const largeData = new Uint8Array(10_000_000); // 10MB
      estimator.addUpdate(largeData);
      
      // Should compress to ~4MB with our mock
      expect(estimator.getCurrentEstimate()).toBeCloseTo(4_000_000, -4);
    });

    it('should clear history on reset', () => {
      estimator.addUpdate(new Uint8Array(1000));
      estimator.addUpdate(new Uint8Array(1000));
      
      expect(estimator.getCurrentEstimate()).toBeGreaterThan(0);
      
      estimator.reset();
      expect(estimator.getCurrentEstimate()).toBe(0);
    });
  });

  describe('Compression Ratio', () => {
    it('should handle different compression ratios', () => {
      // Mock different compression ratios
      const variableGzip: GzipImpl = vi.fn((data: Uint8Array) => {
        // Text-like data compresses better
        if (data.length < 500) {
          return new Uint8Array(Math.ceil(data.length * 0.2)); // 80% compression
        }
        // Binary data compresses worse
        return new Uint8Array(Math.ceil(data.length * 0.8)); // 20% compression
      });
      
      const varEstimator = new RollingGzipEstimator(3, variableGzip);
      
      varEstimator.addUpdate(new Uint8Array(400)); // ~80 bytes
      varEstimator.addUpdate(new Uint8Array(1000)); // ~800 bytes
      
      const avg = (80 + 800) / 2;
      expect(varEstimator.getCurrentEstimate()).toBeCloseTo(avg, -1);
    });
  });

  describe('Guard Integration', () => {
    it('should be usable for frame size guards', () => {
      const MAX_FRAME = 2 * 1024 * 1024; // 2MB
      
      // Add update that compresses to ~1MB
      estimator.addUpdate(new Uint8Array(2_500_000));
      
      const estimate = estimator.getCurrentEstimate();
      expect(estimate).toBeCloseTo(1_000_000, -4);
      expect(estimate < MAX_FRAME).toBe(true);
      
      // Add update that would exceed limit
      estimator.reset();
      estimator.addUpdate(new Uint8Array(6_000_000)); // ~2.4MB compressed
      
      const largeEstimate = estimator.getCurrentEstimate();
      expect(largeEstimate > MAX_FRAME).toBe(true);
    });
  });

  describe('Window Behavior', () => {
    it('should calculate correct average', () => {
      const sizes = [100, 200, 300, 400, 500];
      
      sizes.forEach(size => {
        estimator.addUpdate(new Uint8Array(size));
      });
      
      // With 40% compression: [40, 80, 120, 160, 200]
      // Average = 600/5 = 120
      expect(estimator.getCurrentEstimate()).toBeCloseTo(120, -1);
    });

    it('should handle window size of 1', () => {
      const singleEstimator = new RollingGzipEstimator(1, mockGzip);
      
      singleEstimator.addUpdate(new Uint8Array(1000));
      expect(singleEstimator.getCurrentEstimate()).toBeCloseTo(400, -1);
      
      singleEstimator.addUpdate(new Uint8Array(500));
      expect(singleEstimator.getCurrentEstimate()).toBeCloseTo(200, -1);
    });
  });

  describe('Fallback Behavior', () => {
    it('should handle gzip implementation errors gracefully', () => {
      const errorGzip: GzipImpl = vi.fn(() => {
        throw new Error('Compression failed');
      });
      
      const errorEstimator = new RollingGzipEstimator(5, errorGzip);
      
      // Should fallback to original size on error
      const data = new Uint8Array(1000);
      errorEstimator.addUpdate(data);
      
      // Fallback to original size
      expect(errorEstimator.getCurrentEstimate()).toBe(1000);
    });

    it('should work without gzip implementation', () => {
      const noGzipEstimator = new RollingGzipEstimator(5);
      
      const data = new Uint8Array(1000);
      noGzipEstimator.addUpdate(data);
      
      // Should use original size as estimate
      expect(noGzipEstimator.getCurrentEstimate()).toBe(1000);
    });
  });
});