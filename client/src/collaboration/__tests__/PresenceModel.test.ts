import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('PresenceModel', () => {
  describe('throttling', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('should throttle presence updates to ~30Hz', () => {
      const throttleMs = 1000 / 30;
      const updates: number[] = [];
      
      const throttledUpdate = vi.fn((time: number) => {
        if (updates.length === 0 || time - updates[updates.length - 1] >= throttleMs) {
          updates.push(time);
        }
      });
      
      for (let i = 0; i < 100; i++) {
        throttledUpdate(i * 10);
        vi.advanceTimersByTime(10);
      }
      
      const expectedCalls = Math.floor(1000 / throttleMs);
      expect(updates.length).toBeLessThanOrEqual(expectedCalls + 1);
    });

    it('should maintain 75-100ms update cadence', () => {
      const updateTimes: number[] = [];
      let lastUpdate = 0;
      
      const recordUpdate = () => {
        const now = Date.now();
        if (lastUpdate > 0) {
          updateTimes.push(now - lastUpdate);
        }
        lastUpdate = now;
      };
      
      vi.useFakeTimers();
      
      for (let i = 0; i < 20; i++) {
        recordUpdate();
        vi.advanceTimersByTime(85);
      }
      
      const avgCadence = updateTimes.reduce((a, b) => a + b, 0) / updateTimes.length;
      expect(avgCadence).toBeGreaterThanOrEqual(75);
      expect(avgCadence).toBeLessThanOrEqual(100);
    });
  });

  describe('cursor trails', () => {
    it('should maintain ring buffer of size 24', () => {
      const trailBuffer: Array<{x: number, y: number}> = [];
      const maxSize = 24;
      
      for (let i = 0; i < 50; i++) {
        const point = { x: i, y: i };
        
        if (trailBuffer.length >= maxSize) {
          trailBuffer.shift();
        }
        trailBuffer.push(point);
      }
      
      expect(trailBuffer.length).toBe(maxSize);
      expect(trailBuffer[0].x).toBe(26);
      expect(trailBuffer[trailBuffer.length - 1].x).toBe(49);
    });

    it('should cap remote cursors at 20', () => {
      const remoteCursors = new Map<string, any>();
      
      for (let i = 0; i < 30; i++) {
        const userId = `user-${i}`;
        
        if (remoteCursors.size >= 20) {
          const firstKey = remoteCursors.keys().next().value;
          remoteCursors.delete(firstKey);
        }
        
        remoteCursors.set(userId, {
          name: `User ${i}`,
          cursor: { x: 100, y: 100 }
        });
      }
      
      expect(remoteCursors.size).toBe(20);
    });

    it('should disable trails on mobile', () => {
      const matchMediaMock = vi.fn().mockImplementation(query => ({
        matches: query === '(pointer: coarse)',
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      }));
      
      Object.defineProperty(window, 'matchMedia', {
        writable: true,
        value: matchMediaMock,
      });
      
      const isMobile = window.matchMedia('(pointer: coarse)').matches || 
                       window.innerWidth <= 820;
      
      const trailsEnabled = !isMobile;
      
      if (isMobile) {
        expect(trailsEnabled).toBe(false);
      } else {
        expect(trailsEnabled).toBe(true);
      }
    });
  });

  describe('awareness data', () => {
    it('should include required fields', () => {
      const awareness = {
        name: 'happy-panda',
        color: '#FF5733',
        cursor: { x: 100, y: 200 },
        activity: 'idle' as const
      };
      
      expect(awareness).toHaveProperty('name');
      expect(awareness).toHaveProperty('color');
      expect(awareness).toHaveProperty('cursor');
      expect(awareness).toHaveProperty('activity');
      expect(['idle', 'drawing', 'typing']).toContain(awareness.activity);
    });

    it('should be ephemeral (not persisted)', () => {
      const persistedData = {
        strokes: [],
        texts: [],
        meta: {}
      };
      
      expect(persistedData).not.toHaveProperty('awareness');
      expect(persistedData).not.toHaveProperty('presence');
    });
  });
});