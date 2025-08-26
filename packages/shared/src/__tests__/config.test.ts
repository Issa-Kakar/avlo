import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { 
  ROOM_CONFIG, 
  STROKE_CONFIG, 
  TEXT_CONFIG,
  isRoomReadOnly,
  isRoomWarning,
  calculateAwarenessInterval
} from '../config';

describe('Configuration', () => {
  describe('Config Values', () => {
    it('should have correct default room config values', () => {
      expect(ROOM_CONFIG.ROOM_TTL_DAYS).toBe(14);
      expect(ROOM_CONFIG.ROOM_SIZE_WARNING_BYTES).toBe(13 * 1024 * 1024);
      expect(ROOM_CONFIG.ROOM_SIZE_READONLY_BYTES).toBe(15 * 1024 * 1024);
      expect(ROOM_CONFIG.MAX_CLIENTS_PER_ROOM).toBe(105);
      expect(ROOM_CONFIG.MAX_INBOUND_FRAME_BYTES).toBe(2 * 1024 * 1024);
    });

    it('should have correct stroke config values', () => {
      expect(STROKE_CONFIG.MAX_POINTS_PER_STROKE).toBe(10_000);
      expect(STROKE_CONFIG.MAX_TOTAL_STROKES).toBe(5_000);
      expect(STROKE_CONFIG.SIMPLIFY_TOLERANCE_PEN).toBe(0.8);
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
    describe('isRoomReadOnly', () => {
      it('should return true when size >= 15MB', () => {
        expect(isRoomReadOnly(15 * 1024 * 1024)).toBe(true);
        expect(isRoomReadOnly(16 * 1024 * 1024)).toBe(true);
      });

      it('should return false when size < 15MB', () => {
        expect(isRoomReadOnly(14 * 1024 * 1024)).toBe(false);
        expect(isRoomReadOnly(0)).toBe(false);
      });

      it('should handle undefined size', () => {
        expect(isRoomReadOnly(undefined)).toBe(false);
      });
    });

    describe('isRoomWarning', () => {
      it('should return true when size >= 13MB', () => {
        expect(isRoomWarning(13 * 1024 * 1024)).toBe(true);
        expect(isRoomWarning(14 * 1024 * 1024)).toBe(true);
      });

      it('should return false when size < 13MB', () => {
        expect(isRoomWarning(12 * 1024 * 1024)).toBe(false);
        expect(isRoomWarning(0)).toBe(false);
      });
    });

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

  describe('Environment Overrides', () => {
    const originalEnv = process.env;

    beforeEach(() => {
      // Reset modules to test environment overrides
      process.env = { ...originalEnv };
    });

    afterEach(() => {
      process.env = originalEnv;
    });

    it('should respect environment variable overrides', () => {
      // Note: Environment overrides would be tested if the config module
      // supports runtime env reading. Currently config is static.
      // This test documents expected behavior for future implementation.
      expect(ROOM_CONFIG.ROOM_TTL_DAYS).toBeTypeOf('number');
    });
  });
});