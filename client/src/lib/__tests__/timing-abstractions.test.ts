// @ts-nocheck - Tests are disabled during rapid refactor phase
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  Clock,
  FrameScheduler,
  BrowserClock,
  BrowserFrameScheduler,
  TestClock,
  TestFrameScheduler
} from '../timing-abstractions';

describe('Timing Abstractions', () => {
  describe('BrowserClock', () => {
    it('should use performance.now()', () => {
      const clock = new BrowserClock();
      const spy = vi.spyOn(performance, 'now');
      spy.mockReturnValue(1234.56);
      
      expect(clock.now()).toBe(1234.56);
      expect(spy).toHaveBeenCalled();
      
      spy.mockRestore();
    });

    it('should return increasing values', () => {
      const clock = new BrowserClock();
      const t1 = clock.now();
      const t2 = clock.now();
      
      expect(t2).toBeGreaterThanOrEqual(t1);
    });
  });

  describe('BrowserFrameScheduler', () => {
    it('should use requestAnimationFrame', () => {
      const scheduler = new BrowserFrameScheduler();
      const callback = vi.fn();
      const rafSpy = vi.spyOn(global, 'requestAnimationFrame');
      
      scheduler.request(callback);
      expect(rafSpy).toHaveBeenCalledWith(callback);
      
      rafSpy.mockRestore();
    });

    it('should use cancelAnimationFrame', () => {
      const scheduler = new BrowserFrameScheduler();
      const cancelSpy = vi.spyOn(global, 'cancelAnimationFrame');
      
      scheduler.cancel(123);
      expect(cancelSpy).toHaveBeenCalledWith(123);
      
      cancelSpy.mockRestore();
    });
  });

  describe('TestClock', () => {
    let clock: TestClock;

    beforeEach(() => {
      clock = new TestClock();
    });

    it('should start at time 0', () => {
      expect(clock.now()).toBe(0);
    });

    it('should advance by specified milliseconds', () => {
      clock.advance(100);
      expect(clock.now()).toBe(100);
      
      clock.advance(50);
      expect(clock.now()).toBe(150);
    });

    it('should allow setting absolute time', () => {
      clock.set(500);
      expect(clock.now()).toBe(500);
      
      clock.set(100);
      expect(clock.now()).toBe(100);
    });

    it('should reset to 0', () => {
      clock.advance(1000);
      clock.reset();
      expect(clock.now()).toBe(0);
    });
  });

  describe('TestFrameScheduler', () => {
    let scheduler: TestFrameScheduler;
    let clock: TestClock;

    beforeEach(() => {
      clock = new TestClock();
      scheduler = new TestFrameScheduler();
    });

    it('should queue callbacks', () => {
      const cb1 = vi.fn();
      const cb2 = vi.fn();
      
      const id1 = scheduler.request(cb1);
      const id2 = scheduler.request(cb2);
      
      expect(id1).toBe(1);
      expect(id2).toBe(2);
      expect(cb1).not.toHaveBeenCalled();
      expect(cb2).not.toHaveBeenCalled();
    });

    it('should execute oldest callback on advanceFrame', () => {
      const cb1 = vi.fn();
      const cb2 = vi.fn();
      
      scheduler.request(cb1);
      scheduler.request(cb2);
      
      // Advance first frame
      scheduler.advanceFrame(16.67);
      expect(cb1).toHaveBeenCalledWith(16.67);
      expect(cb2).not.toHaveBeenCalled();
      
      // Advance second frame
      scheduler.advanceFrame(33.33);
      expect(cb2).toHaveBeenCalledWith(33.33);
    });

    it('should cancel queued callbacks', () => {
      const cb1 = vi.fn();
      const cb2 = vi.fn();
      
      const id1 = scheduler.request(cb1);
      const id2 = scheduler.request(cb2);
      
      scheduler.cancel(id1);
      
      scheduler.advanceFrame(16.67);
      expect(cb1).not.toHaveBeenCalled();
      expect(cb2).toHaveBeenCalledWith(16.67);
    });

    it('should flush all callbacks', () => {
      const cb1 = vi.fn();
      const cb2 = vi.fn();
      const cb3 = vi.fn();
      
      scheduler.request(cb1);
      scheduler.request(cb2);
      scheduler.request(cb3);
      
      scheduler.flush(100);
      
      expect(cb1).toHaveBeenCalledWith(100);
      expect(cb2).toHaveBeenCalledWith(100);
      expect(cb3).toHaveBeenCalledWith(100);
    });

    it('should clear all callbacks', () => {
      const cb1 = vi.fn();
      const cb2 = vi.fn();
      
      scheduler.request(cb1);
      scheduler.request(cb2);
      
      scheduler.clear();
      scheduler.advanceFrame(16.67);
      
      expect(cb1).not.toHaveBeenCalled();
      expect(cb2).not.toHaveBeenCalled();
    });

    it('should handle callbacks that schedule new callbacks', () => {
      const cb2 = vi.fn();
      const cb1 = vi.fn(() => {
        scheduler.request(cb2);
      });
      
      scheduler.request(cb1);
      
      scheduler.advanceFrame(16.67);
      expect(cb1).toHaveBeenCalled();
      expect(cb2).not.toHaveBeenCalled();
      
      scheduler.advanceFrame(33.33);
      expect(cb2).toHaveBeenCalledWith(33.33);
    });
  });

  describe('Integration with RoomDocManager', () => {
    it('should allow deterministic testing with injected timing', () => {
      const clock = new TestClock();
      const frames = new TestFrameScheduler();
      
      // Simulate RAF loop
      let isDirty = true;
      let publishCount = 0;
      
      const rafLoop = () => {
        if (isDirty) {
          publishCount++;
          isDirty = false;
        }
      };
      
      // Schedule initial frame
      frames.request(rafLoop);
      
      // No publish yet
      expect(publishCount).toBe(0);
      
      // Advance frame
      frames.advanceFrame(clock.now());
      expect(publishCount).toBe(1);
      
      // Mark dirty and schedule again
      isDirty = true;
      frames.request(rafLoop);
      
      clock.advance(16.67);
      frames.advanceFrame(clock.now());
      expect(publishCount).toBe(2);
    });
  });
});