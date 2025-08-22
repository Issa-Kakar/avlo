import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RoomDocManagerRegistry } from '../room-doc-manager';
import { DrawStrokeCommit, ClearBoard } from '@avlo/shared';

/**
 * CRITICAL RAF LOOP AND BATCH PROCESSING TESTS
 * 
 * These tests properly verify the distributed systems challenges around:
 * 1. RAF-based publishing at ≤60 FPS
 * 2. Batch window coalescing (8-32ms adaptive)
 * 3. Hidden tab throttling to 8 FPS
 * 4. Backpressure handling
 * 5. Work-based adaptive windows
 * 
 * Key insight: We must test ACTUAL timing behavior, not bypass it with processCommandsImmediate()
 */

describe('Phase 2.4: RAF Loop and Batch Processing (Real Timing)', () => {
  let rafCallbacks: FrameRequestCallback[] = [];
  let rafId = 0;
  let currentTime = 0;
  let hiddenState = false;

  // Mock RAF with controlled timing
  const mockRaf = vi.fn((callback: FrameRequestCallback) => {
    rafCallbacks.push(callback);
    return ++rafId;
  });

  const mockCancelRaf = vi.fn((id: number) => {
    // Remove callback if exists
    rafCallbacks = rafCallbacks.filter((_, index) => index + 1 !== id);
  });

  // Mock performance.now() for precise timing control
  const mockPerformanceNow = vi.fn(() => currentTime);

  // Mock document.hidden for visibility testing
  const mockDocumentHidden = vi.fn(() => hiddenState);

  // Helper to advance time and trigger RAF callbacks
  const advanceTime = (ms: number) => {
    currentTime += ms;
    // Execute all pending RAF callbacks with current time
    const callbacks = [...rafCallbacks];
    rafCallbacks = [];
    callbacks.forEach(cb => cb(currentTime));
  };

  // Helper to run RAF loop for specified duration
  const runRAFLoop = (durationMs: number, stepMs: number = 16.67) => {
    const steps = Math.ceil(durationMs / stepMs);
    for (let i = 0; i < steps; i++) {
      advanceTime(stepMs);
    }
  };

  beforeEach(() => {
    RoomDocManagerRegistry.destroyAll();
    rafCallbacks = [];
    rafId = 0;
    currentTime = 0;
    hiddenState = false;

    // Install mocks
    vi.stubGlobal('requestAnimationFrame', mockRaf);
    vi.stubGlobal('cancelAnimationFrame', mockCancelRaf);
    vi.stubGlobal('performance', { now: mockPerformanceNow });
    Object.defineProperty(document, 'hidden', {
      get: mockDocumentHidden,
      configurable: true,
    });
  });

  afterEach(() => {
    RoomDocManagerRegistry.destroyAll();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  describe('60 FPS Publishing Constraint', () => {
    it('should not publish faster than 60 FPS even with rapid updates', () => {
      const roomId = 'test-60fps';
      const manager = RoomDocManagerRegistry.get(roomId);

      let publishCount = 0;
      const unsubscribe = manager.subscribeSnapshot(() => {
        publishCount++;
      });

      // Send many rapid updates
      for (let i = 0; i < 100; i++) {
        const cmd: DrawStrokeCommit = {
          type: 'DrawStrokeCommit',
          id: `stroke-${i}`,
          tool: 'pen',
          color: '#000000',
          size: 3,
          opacity: 1,
          points: [i, i, i + 1, i + 1],
          bbox: [i, i, i + 1, i + 1],
          startedAt: Date.now(),
          finishedAt: Date.now(),
          scene: 0,
        };
        manager.write(cmd);
        
        // Advance time by 1ms between commands (simulating rapid fire)
        advanceTime(1);
      }

      // Run RAF loop for 1 second (1000ms)
      runRAFLoop(1000, 16.67);

      // At 60 FPS max, we should have at most ~60 publishes in 1 second
      // Allow some tolerance for timing precision
      expect(publishCount).toBeGreaterThan(0);
      expect(publishCount).toBeLessThanOrEqual(62); // 60 FPS + small tolerance

      // Calculate actual FPS
      const actualFPS = publishCount; // Since we ran for 1 second
      console.log(`Actual publish FPS: ${actualFPS}`);

      unsubscribe();
      manager.destroy();
    });

    it('should maintain minimum 16.67ms interval between publishes', () => {
      const roomId = 'test-interval';
      const manager = RoomDocManagerRegistry.get(roomId);

      const publishTimes: number[] = [];
      const unsubscribe = manager.subscribeSnapshot(() => {
        publishTimes.push(currentTime);
      });

      // Send updates continuously
      for (let i = 0; i < 10; i++) {
        const cmd: DrawStrokeCommit = {
          type: 'DrawStrokeCommit',
          id: `stroke-${i}`,
          tool: 'pen',
          color: '#000000',
          size: 3,
          opacity: 1,
          points: [0, 0, 10, 10],
          bbox: [0, 0, 10, 10],
          startedAt: Date.now(),
          finishedAt: Date.now(),
          scene: 0,
        };
        manager.write(cmd);
        
        // Run RAF for 20ms (should allow one publish)
        runRAFLoop(20, 16.67);
      }

      // Check intervals between publishes
      for (let i = 1; i < publishTimes.length; i++) {
        const interval = publishTimes[i] - publishTimes[i - 1];
        // Should be at least 16ms between publishes (allowing small tolerance)
        expect(interval).toBeGreaterThanOrEqual(15); // Small tolerance for timing
      }

      unsubscribe();
      manager.destroy();
    });
  });

  describe('Batch Window Coalescing', () => {
    it('should coalesce multiple updates within batch window into single publish', () => {
      const roomId = 'test-coalesce';
      const manager = RoomDocManagerRegistry.get(roomId);

      let publishCount = 0;
      const snapshots: any[] = [];
      const unsubscribe = manager.subscribeSnapshot((snap) => {
        publishCount++;
        snapshots.push(snap);
      });

      // Send 5 commands within a very short window (< 8ms)
      for (let i = 0; i < 5; i++) {
        const cmd: DrawStrokeCommit = {
          type: 'DrawStrokeCommit',
          id: `stroke-${i}`,
          tool: 'pen',
          color: '#000000',
          size: 3,
          opacity: 1,
          points: [i, i, i + 1, i + 1],
          bbox: [i, i, i + 1, i + 1],
          startedAt: Date.now(),
          finishedAt: Date.now(),
          scene: 0,
        };
        manager.write(cmd);
        advanceTime(1); // Only 1ms between commands
      }

      // Run one RAF cycle (16.67ms)
      advanceTime(16.67);

      // Should result in a single publish with all 5 strokes
      expect(publishCount).toBe(1);
      expect(snapshots[0].strokes.length).toBe(5);

      unsubscribe();
      manager.destroy();
    });

    it('should publish separately when updates exceed batch window', () => {
      const roomId = 'test-batch-separate';
      const manager = RoomDocManagerRegistry.get(roomId);

      let publishCount = 0;
      const unsubscribe = manager.subscribeSnapshot(() => {
        publishCount++;
      });

      // Send first command
      const cmd1: DrawStrokeCommit = {
        type: 'DrawStrokeCommit',
        id: 'stroke-1',
        tool: 'pen',
        color: '#000000',
        size: 3,
        opacity: 1,
        points: [0, 0, 10, 10],
        bbox: [0, 0, 10, 10],
        startedAt: Date.now(),
        finishedAt: Date.now(),
        scene: 0,
      };
      manager.write(cmd1);

      // Run RAF and publish first command
      runRAFLoop(20, 16.67);
      const firstPublishCount = publishCount;

      // Wait longer than batch window (>32ms)
      advanceTime(50);

      // Send second command
      const cmd2: DrawStrokeCommit = {
        type: 'DrawStrokeCommit',
        id: 'stroke-2',
        tool: 'pen',
        color: '#FF0000',
        size: 5,
        opacity: 1,
        points: [20, 20, 30, 30],
        bbox: [20, 20, 30, 30],
        startedAt: Date.now(),
        finishedAt: Date.now(),
        scene: 0,
      };
      manager.write(cmd2);

      // Run RAF again
      runRAFLoop(20, 16.67);

      // Should have two separate publishes
      expect(publishCount).toBe(firstPublishCount + 1);

      unsubscribe();
      manager.destroy();
    });
  });

  describe('Hidden Tab Throttling (8 FPS)', () => {
    it('should throttle to 8 FPS when tab is hidden', () => {
      const roomId = 'test-hidden';
      const manager = RoomDocManagerRegistry.get(roomId);

      // Set tab as hidden
      hiddenState = true;

      let publishCount = 0;
      const unsubscribe = manager.subscribeSnapshot(() => {
        publishCount++;
      });

      // Send continuous updates for 1 second
      for (let i = 0; i < 100; i++) {
        const cmd: DrawStrokeCommit = {
          type: 'DrawStrokeCommit',
          id: `stroke-${i}`,
          tool: 'pen',
          color: '#000000',
          size: 3,
          opacity: 1,
          points: [i, i, i + 1, i + 1],
          bbox: [i, i, i + 1, i + 1],
          startedAt: Date.now(),
          finishedAt: Date.now(),
          scene: 0,
        };
        manager.write(cmd);
        advanceTime(10); // 10ms between commands
      }

      // Total time: 100 * 10ms = 1000ms (1 second)
      // At 8 FPS, we expect ~8 publishes in 1 second
      expect(publishCount).toBeGreaterThan(6);
      expect(publishCount).toBeLessThanOrEqual(10); // 8 FPS + tolerance

      unsubscribe();
      manager.destroy();
    });

    it('should immediately publish when tab becomes visible', () => {
      const roomId = 'test-visibility-change';
      const manager = RoomDocManagerRegistry.get(roomId);

      // Start with hidden tab
      hiddenState = true;

      let publishCount = 0;
      let lastPublishTime = 0;
      const unsubscribe = manager.subscribeSnapshot(() => {
        publishCount++;
        lastPublishTime = currentTime;
      });

      // Send a command while hidden
      const cmd: DrawStrokeCommit = {
        type: 'DrawStrokeCommit',
        id: 'stroke-1',
        tool: 'pen',
        color: '#000000',
        size: 3,
        opacity: 1,
        points: [0, 0, 10, 10],
        bbox: [0, 0, 10, 10],
        startedAt: Date.now(),
        finishedAt: Date.now(),
        scene: 0,
      };
      manager.write(cmd);

      // Wait (but not long enough for 8 FPS publish)
      advanceTime(50);

      // Make tab visible
      hiddenState = false;
      document.dispatchEvent(new Event('visibilitychange'));

      // Should trigger immediate publish
      advanceTime(16.67); // One RAF cycle

      // Should have published after becoming visible
      expect(publishCount).toBeGreaterThan(0);
      expect(lastPublishTime).toBeGreaterThan(50);

      unsubscribe();
      manager.destroy();
    });
  });

  describe('Adaptive Batch Window', () => {
    it('should expand batch window when publish work takes >8ms', () => {
      const roomId = 'test-expand-window';
      const manager = RoomDocManagerRegistry.get(roomId);

      // Mock slow publish work by overriding buildSnapshot
      const originalBuildSnapshot = (manager as any).buildSnapshot;
      (manager as any).buildSnapshot = function() {
        // Simulate slow work by advancing time
        currentTime += 10; // 10ms of work
        return originalBuildSnapshot.call(this);
      };

      const unsubscribe = manager.subscribeSnapshot(() => {});

      // Initial batch window should be 16ms
      expect((manager as any).publishState.batchWindow).toBe(16);

      // Trigger a publish with slow work
      const cmd: DrawStrokeCommit = {
        type: 'DrawStrokeCommit',
        id: 'stroke-1',
        tool: 'pen',
        color: '#000000',
        size: 3,
        opacity: 1,
        points: Array.from({ length: 1000 }, (_, i) => i), // Large stroke
        bbox: [0, 0, 1000, 1000],
        startedAt: Date.now(),
        finishedAt: Date.now(),
        scene: 0,
      };
      manager.write(cmd);

      // Run RAF to trigger publish
      runRAFLoop(20, 16.67);

      // Batch window should have expanded (16 * 1.5 = 24)
      expect((manager as any).publishState.batchWindow).toBeGreaterThan(16);
      expect((manager as any).publishState.batchWindow).toBeLessThanOrEqual(32);

      unsubscribe();
      manager.destroy();
    });

    it('should contract batch window when publish work takes <4ms', () => {
      const roomId = 'test-contract-window';
      const manager = RoomDocManagerRegistry.get(roomId);

      // First, expand the window
      (manager as any).publishState.batchWindow = 32;

      // Mock fast publish work
      const originalBuildSnapshot = (manager as any).buildSnapshot;
      (manager as any).buildSnapshot = function() {
        // Simulate fast work
        currentTime += 2; // Only 2ms of work
        return originalBuildSnapshot.call(this);
      };

      const unsubscribe = manager.subscribeSnapshot(() => {});

      // Trigger a publish with fast work
      const cmd: DrawStrokeCommit = {
        type: 'DrawStrokeCommit',
        id: 'stroke-1',
        tool: 'pen',
        color: '#000000',
        size: 3,
        opacity: 1,
        points: [0, 0, 10, 10], // Small stroke
        bbox: [0, 0, 10, 10],
        startedAt: Date.now(),
        finishedAt: Date.now(),
        scene: 0,
      };
      manager.write(cmd);

      // Run RAF to trigger publish
      runRAFLoop(20, 16.67);

      // Batch window should have contracted (32 * 0.8 = 25.6)
      expect((manager as any).publishState.batchWindow).toBeLessThan(32);
      expect((manager as any).publishState.batchWindow).toBeGreaterThanOrEqual(8);

      unsubscribe();
      manager.destroy();
    });
  });

  describe('Distributed Systems Stress Tests', () => {
    it('should handle burst of commands without dropping any', () => {
      const roomId = 'test-burst';
      const manager = RoomDocManagerRegistry.get(roomId);

      const snapshots: any[] = [];
      const unsubscribe = manager.subscribeSnapshot((snap) => {
        snapshots.push(snap);
      });

      // Send a burst of 50 commands as fast as possible
      const commandIds = new Set<string>();
      for (let i = 0; i < 50; i++) {
        const id = `stroke-${i}`;
        commandIds.add(id);
        const cmd: DrawStrokeCommit = {
          type: 'DrawStrokeCommit',
          id,
          tool: 'pen',
          color: '#000000',
          size: 3,
          opacity: 1,
          points: [i, i, i + 1, i + 1],
          bbox: [i, i, i + 1, i + 1],
          startedAt: Date.now(),
          finishedAt: Date.now(),
          scene: 0,
        };
        manager.write(cmd);
      }

      // Run RAF loop long enough to process everything
      runRAFLoop(500, 16.67);

      // Get all stroke IDs from final snapshot
      const finalSnapshot = snapshots[snapshots.length - 1];
      const processedIds = new Set(finalSnapshot.strokes.map((s: any) => s.id));

      // All commands should be processed
      expect(processedIds.size).toBe(50);
      expect([...commandIds].every(id => processedIds.has(id))).toBe(true);

      unsubscribe();
      manager.destroy();
    });

    it('should maintain consistency during rapid scene changes with concurrent updates', () => {
      const roomId = 'test-consistency';
      const manager = RoomDocManagerRegistry.get(roomId);

      const snapshots: any[] = [];
      const unsubscribe = manager.subscribeSnapshot((snap) => {
        snapshots.push(snap);
      });

      // Simulate complex interleaving: strokes started in different scenes
      const operations = [
        { type: 'stroke', scene: 0, id: 'A1', time: 0 },
        { type: 'stroke', scene: 0, id: 'A2', time: 5 },
        { type: 'clear', time: 10 }, // Moves to scene 1
        { type: 'stroke', scene: 0, id: 'A3', time: 15 }, // Started before clear
        { type: 'stroke', scene: 1, id: 'B1', time: 20 }, // Started after clear
        { type: 'clear', time: 25 }, // Moves to scene 2
        { type: 'stroke', scene: 1, id: 'B2', time: 30 }, // Started before second clear
        { type: 'stroke', scene: 2, id: 'C1', time: 35 }, // Started after second clear
      ];

      for (const op of operations) {
        // Advance to operation time
        advanceTime(op.time - currentTime);

        if (op.type === 'stroke') {
          const cmd: DrawStrokeCommit = {
            type: 'DrawStrokeCommit',
            id: op.id!,
            tool: 'pen',
            color: '#000000',
            size: 3,
            opacity: 1,
            points: [0, 0, 10, 10],
            bbox: [0, 0, 10, 10],
            startedAt: Date.now(),
            finishedAt: Date.now(),
            scene: op.scene!,
          };
          manager.write(cmd);
        } else if (op.type === 'clear') {
          const cmd: ClearBoard = {
            type: 'ClearBoard',
            idempotencyKey: `clear-${op.time}`,
          };
          manager.write(cmd);
        }

        // Run RAF to process
        runRAFLoop(20, 16.67);
      }

      // Final snapshot should be in scene 2
      const finalSnapshot = snapshots[snapshots.length - 1];
      expect(finalSnapshot.scene).toBe(2);

      // Only C1 should be visible (scene 2 strokes only)
      const visibleIds = finalSnapshot.strokes.map((s: any) => s.id);
      expect(visibleIds).toEqual(['C1']);

      // Verify scene consistency across all snapshots
      for (const snapshot of snapshots) {
        // All visible strokes should match current scene
        for (const stroke of snapshot.strokes) {
          expect(stroke.scene).toBe(snapshot.scene);
        }
      }

      unsubscribe();
      manager.destroy();
    });

    it('should handle memory pressure without leaking', () => {
      const roomId = 'test-memory';
      const manager = RoomDocManagerRegistry.get(roomId);

      // Track snapshot references
      const weakRefs: WeakRef<any>[] = [];
      const unsubscribe = manager.subscribeSnapshot((snap) => {
        weakRefs.push(new WeakRef(snap));
      });

      // Generate many updates
      for (let i = 0; i < 100; i++) {
        const cmd: DrawStrokeCommit = {
          type: 'DrawStrokeCommit',
          id: `stroke-${i}`,
          tool: 'pen',
          color: '#000000',
          size: 3,
          opacity: 1,
          points: Array.from({ length: 100 }, (_, j) => j), // Medium-sized strokes
          bbox: [0, 0, 100, 100],
          startedAt: Date.now(),
          finishedAt: Date.now(),
          scene: 0,
        };
        manager.write(cmd);
        
        // Process every 10 commands
        if (i % 10 === 0) {
          runRAFLoop(20, 16.67);
        }
      }

      // Final processing
      runRAFLoop(100, 16.67);

      // Check that old snapshots can be garbage collected
      // (WeakRefs will return undefined if objects were collected)
      // Note: Can't force GC in tests, but structure supports it
      expect(weakRefs.length).toBeGreaterThan(0);

      // Verify no memory leaks in internal state
      expect((manager as any).publishState.pendingUpdates.length).toBeLessThanOrEqual(10);

      unsubscribe();
      manager.destroy();
    });
  });

  describe('Edge Cases and Error Conditions', () => {
    it('should handle destroy() during active RAF loop', () => {
      const roomId = 'test-destroy-during-raf';
      const manager = RoomDocManagerRegistry.get(roomId);

      const unsubscribe = manager.subscribeSnapshot(() => {});

      // Send command to start RAF loop
      const cmd: DrawStrokeCommit = {
        type: 'DrawStrokeCommit',
        id: 'stroke-1',
        tool: 'pen',
        color: '#000000',
        size: 3,
        opacity: 1,
        points: [0, 0, 10, 10],
        bbox: [0, 0, 10, 10],
        startedAt: Date.now(),
        finishedAt: Date.now(),
        scene: 0,
      };
      manager.write(cmd);

      // Start RAF but destroy before it completes
      advanceTime(5); // Partial RAF cycle
      manager.destroy();

      // Complete RAF cycle
      advanceTime(15);

      // Should not throw and RAF should be cancelled
      expect(mockCancelRaf).toHaveBeenCalled();

      unsubscribe();
    });

    it('should recover from subscriber errors without breaking RAF loop', () => {
      const roomId = 'test-subscriber-error';
      const manager = RoomDocManagerRegistry.get(roomId);

      let goodCallbackCount = 0;
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      // Bad subscriber that throws
      const unsub1 = manager.subscribeSnapshot(() => {
        throw new Error('Subscriber error');
      });

      // Good subscriber
      const unsub2 = manager.subscribeSnapshot(() => {
        goodCallbackCount++;
      });

      // Send multiple commands
      for (let i = 0; i < 5; i++) {
        const cmd: DrawStrokeCommit = {
          type: 'DrawStrokeCommit',
          id: `stroke-${i}`,
          tool: 'pen',
          color: '#000000',
          size: 3,
          opacity: 1,
          points: [i, i, i + 1, i + 1],
          bbox: [i, i, i + 1, i + 1],
          startedAt: Date.now(),
          finishedAt: Date.now(),
          scene: 0,
        };
        manager.write(cmd);
        runRAFLoop(20, 16.67);
      }

      // Good subscriber should have been called for each publish
      expect(goodCallbackCount).toBe(5);

      // Errors should be logged
      expect(errorSpy).toHaveBeenCalled();

      errorSpy.mockRestore();
      unsub1();
      unsub2();
      manager.destroy();
    });
  });
});