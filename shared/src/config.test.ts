import { describe, it, expect } from 'vitest';
import CONFIG, {
  ROOM_CONFIG,
  STROKE_CONFIG,
  calculateAwarenessInterval,
  applyJitter,
  isRoomSizeWarning,
  isRoomReadOnly,
  getRoomSizePercentage,
} from '../config';

describe('Config Module', () => {
  describe('Config Constants', () => {
    it('should have correct default values', () => {
      expect(ROOM_CONFIG.ROOM_TTL_DAYS).toBe(14);
      expect(ROOM_CONFIG.ROOM_SIZE_WARNING_BYTES).toBe(8 * 1024 * 1024);
      expect(ROOM_CONFIG.ROOM_SIZE_READONLY_BYTES).toBe(10 * 1024 * 1024);
      expect(ROOM_CONFIG.MAX_CLIENTS_PER_ROOM).toBe(105);

      expect(STROKE_CONFIG.MAX_POINTS_PER_STROKE).toBe(10_000);
      expect(STROKE_CONFIG.MAX_TOTAL_STROKES).toBe(5_000);
    });

    it('should export CONFIG default object', () => {
      expect(CONFIG.ROOM).toBe(ROOM_CONFIG);
      expect(CONFIG.STROKE).toBe(STROKE_CONFIG);
    });
  });

  describe('Utility Functions', () => {
    describe('calculateAwarenessInterval', () => {
      it('should return base interval for low peer counts', () => {
        expect(calculateAwarenessInterval(5)).toBe(50);
        expect(calculateAwarenessInterval(10)).toBe(50);
      });

      it('should increase interval for higher peer counts', () => {
        const interval20 = calculateAwarenessInterval(20);
        expect(interval20).toBeGreaterThan(50);
        expect(interval20).toBeLessThanOrEqual(150);
      });

      it('should cap at max interval', () => {
        expect(calculateAwarenessInterval(100)).toBe(150);
      });
    });

    describe('applyJitter', () => {
      it('should apply jitter within range', () => {
        const value = 1000;
        const jitterFactor = 0.2;

        // Test multiple times since it's random
        for (let i = 0; i < 10; i++) {
          const result = applyJitter(value, jitterFactor);
          expect(result).toBeGreaterThanOrEqual(value * (1 - jitterFactor));
          expect(result).toBeLessThanOrEqual(value * (1 + jitterFactor));
        }
      });
    });

    describe('Room Size Functions', () => {
      it('should detect warning threshold', () => {
        expect(isRoomSizeWarning(7 * 1024 * 1024)).toBe(false);
        expect(isRoomSizeWarning(8 * 1024 * 1024)).toBe(true);
        expect(isRoomSizeWarning(9 * 1024 * 1024)).toBe(true);
      });

      it('should detect read-only threshold', () => {
        expect(isRoomReadOnly(9 * 1024 * 1024)).toBe(false);
        expect(isRoomReadOnly(10 * 1024 * 1024)).toBe(true);
        expect(isRoomReadOnly(11 * 1024 * 1024)).toBe(true);
      });

      it('should calculate size percentage correctly', () => {
        expect(getRoomSizePercentage(0)).toBe(0);
        expect(getRoomSizePercentage(5 * 1024 * 1024)).toBe(50);
        expect(getRoomSizePercentage(10 * 1024 * 1024)).toBe(100);
        expect(getRoomSizePercentage(20 * 1024 * 1024)).toBe(100); // Capped at 100
      });
    });
  });

  describe('Config Immutability', () => {
    it('should freeze config objects in development', () => {
      if (process.env.NODE_ENV !== 'production') {
        expect(Object.isFrozen(ROOM_CONFIG)).toBe(true);
        expect(Object.isFrozen(STROKE_CONFIG)).toBe(true);
      }
    });
  });
});
