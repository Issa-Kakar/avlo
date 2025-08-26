import { describe, it, expect, beforeEach, vi } from 'vitest';
import { UpdateRing } from '../ring-buffer';
import { TestClock } from '../timing-abstractions';

describe('UpdateRing', () => {
  let ring: UpdateRing;
  let clock: TestClock;

  beforeEach(() => {
    clock = new TestClock();
    ring = new UpdateRing(4, 100, clock); // capacity=4, windowMs=100
  });

  describe('Basic Operations', () => {
    it('should add updates to the buffer', () => {
      const update1 = new Uint8Array([1, 2, 3]);
      const update2 = new Uint8Array([4, 5, 6]);
      
      ring.add(update1);
      ring.add(update2);
      
      expect(ring.size()).toBe(2);
    });

    it('should respect capacity limit', () => {
      // Add 5 updates to buffer with capacity 4
      for (let i = 0; i < 5; i++) {
        ring.add(new Uint8Array([i]));
      }
      
      expect(ring.size()).toBe(4); // Should cap at 4
    });

    it('should wrap around when full (ring buffer behavior)', () => {
      const updates = [
        new Uint8Array([1]),
        new Uint8Array([2]),
        new Uint8Array([3]),
        new Uint8Array([4]),
        new Uint8Array([5]), // This should overwrite first
      ];
      
      updates.forEach(u => ring.add(u));
      
      const coalesced = ring.coalesce();
      
      // Should contain updates 2,3,4,5 (first one overwritten)
      expect(coalesced).toEqual(new Uint8Array([2, 3, 4, 5]));
    });

    it('should clear the buffer', () => {
      ring.add(new Uint8Array([1, 2, 3]));
      ring.add(new Uint8Array([4, 5, 6]));
      
      ring.clear();
      expect(ring.size()).toBe(0);
      expect(ring.isEmpty()).toBe(true);
    });
  });

  describe('Time Window Behavior', () => {
    it('should drop old updates outside time window', () => {
      ring.add(new Uint8Array([1]));
      clock.advance(50);
      ring.add(new Uint8Array([2]));
      clock.advance(60); // Total: 110ms, first update now outside 100ms window
      
      const coalesced = ring.coalesce();
      
      // First update should be dropped (older than 100ms)
      expect(coalesced).toEqual(new Uint8Array([2]));
    });

    it('should keep all updates within time window', () => {
      ring.add(new Uint8Array([1]));
      clock.advance(30);
      ring.add(new Uint8Array([2]));
      clock.advance(30);
      ring.add(new Uint8Array([3]));
      // Total: 60ms, all within 100ms window
      
      const coalesced = ring.coalesce();
      expect(coalesced).toEqual(new Uint8Array([1, 2, 3]));
    });

    it('should handle rapid updates within window', () => {
      // Simulate rapid updates
      for (let i = 0; i < 10; i++) {
        ring.add(new Uint8Array([i]));
        clock.advance(5); // 5ms between updates
      }
      
      const coalesced = ring.coalesce();
      
      // Only last 4 should be kept (capacity limit)
      expect(coalesced.length).toBe(4);
      expect(Array.from(coalesced)).toEqual([6, 7, 8, 9]);
    });
  });

  describe('Coalesce Operation', () => {
    it('should concatenate all valid updates', () => {
      ring.add(new Uint8Array([1, 2]));
      ring.add(new Uint8Array([3, 4]));
      ring.add(new Uint8Array([5, 6]));
      
      const result = ring.coalesce();
      expect(result).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6]));
    });

    it('should return empty array when buffer is empty', () => {
      const result = ring.coalesce();
      expect(result).toEqual(new Uint8Array(0));
    });

    it('should clear buffer after coalesce if clearAfter=true', () => {
      ring.add(new Uint8Array([1, 2, 3]));
      
      const result = ring.coalesce(true);
      expect(result).toEqual(new Uint8Array([1, 2, 3]));
      expect(ring.isEmpty()).toBe(true);
    });

    it('should preserve buffer if clearAfter=false', () => {
      ring.add(new Uint8Array([1, 2, 3]));
      
      const result = ring.coalesce(false);
      expect(result).toEqual(new Uint8Array([1, 2, 3]));
      expect(ring.isEmpty()).toBe(false);
      expect(ring.size()).toBe(1);
    });
  });

  describe('Edge Cases', () => {
    it('should handle zero capacity gracefully', () => {
      const zeroRing = new UpdateRing(0, 100, clock);
      zeroRing.add(new Uint8Array([1, 2, 3]));
      
      expect(zeroRing.size()).toBe(0);
      expect(zeroRing.coalesce()).toEqual(new Uint8Array(0));
    });

    it('should handle very large updates', () => {
      const largeUpdate = new Uint8Array(10000);
      largeUpdate.fill(42);
      
      ring.add(largeUpdate);
      const result = ring.coalesce();
      
      expect(result.length).toBe(10000);
      expect(result[0]).toBe(42);
      expect(result[9999]).toBe(42);
    });

    it('should handle immediate expiry', () => {
      const shortRing = new UpdateRing(4, 0, clock); // 0ms window
      shortRing.add(new Uint8Array([1]));
      
      clock.advance(1); // Any time advance expires it
      const result = shortRing.coalesce();
      
      expect(result).toEqual(new Uint8Array(0));
    });
  });
});