import { describe, it, expect } from 'vitest';
import {
  STROKE_CONFIG,
  TEXT_CONFIG,
  calculateAwarenessInterval
} from '../config';

describe('Configuration', () => {
  describe('Config Values', () => {
    it('should have correct stroke config values', () => {
      expect(STROKE_CONFIG.MAX_POINTS_PER_STROKE).toBe(10_000);
      expect(STROKE_CONFIG.MAX_TOTAL_STROKES).toBe(5_000);
      expect(STROKE_CONFIG.SIMPLIFY_TOLERANCE_PEN).toBe(0.0); // Updated default
      expect(STROKE_CONFIG.SIMPLIFY_TOLERANCE_HIGHLIGHTER).toBe(0.5);
      expect(STROKE_CONFIG.MAX_ENCODED_UPDATE_BYTES).toBe(128 * 1024);
    });

    it('should have correct text config values', () => {
      expect(TEXT_CONFIG.MAX_TEXT_LENGTH).toBe(500);
      expect(TEXT_CONFIG.MAX_CODE_BODY_BYTES).toBe(200 * 1024);
      expect(TEXT_CONFIG.MAX_OUTPUT_BYTES_PER_RUN).toBe(10 * 1024);
      expect(TEXT_CONFIG.MAX_OUTPUTS_COUNT).toBe(10);
      expect(TEXT_CONFIG.MAX_TOTAL_OUTPUT_BYTES).toBe(128 * 1024);
    });
  });

  describe('Utility Functions', () => {
    describe('calculateAwarenessInterval', () => {
      it('should return base interval for small peer counts', () => {
        expect(calculateAwarenessInterval(5)).toBe(50);
        expect(calculateAwarenessInterval(10)).toBe(50);
      });

      it('should scale up for larger peer counts', () => {
        expect(calculateAwarenessInterval(20)).toBe(75); // 50 * (1 + (20-10)/20)
        expect(calculateAwarenessInterval(30)).toBe(100); // 50 * (1 + (30-10)/20)
      });

      it('should cap at maximum interval', () => {
        expect(calculateAwarenessInterval(60)).toBe(150);
        expect(calculateAwarenessInterval(100)).toBe(150);
      });
    });
  });
});