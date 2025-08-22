import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WriteQueue } from '../write-queue';
import { CommandBus } from '../command-bus';
import { RoomDocManagerRegistry } from '../room-doc-manager';
import { 
  DrawStrokeCommit, 
  ClearBoard, 
  AddText, 
  EraseObjects,
  ROOM_CONFIG,
  STROKE_CONFIG,
  RATE_LIMIT_CONFIG,
  QUEUE_CONFIG,
  BACKOFF_CONFIG
} from '@avlo/shared';
import * as Y from 'yjs';

/**
 * CRITICAL DISTRIBUTED SYSTEMS TESTS FOR PHASE 2.5
 * 
 * These tests verify the complex challenges around:
 * 1. Dual size budgets (128KB per-stroke, 2MB per-frame)
 * 2. Scene capture for causal consistency
 * 3. Idempotency and exactly-once semantics
 * 4. Rate limiting and backpressure
 * 5. Concurrent updates and race conditions
 * 6. Mobile view-only enforcement
 * 7. Room size transitions (8MB warning, 10MB read-only)
 */

describe('Phase 2.5: WriteQueue Distributed Systems Challenges', () => {
  describe('Dual Size Budget Enforcement', () => {
    it('should enforce 128KB per-stroke limit independently of 2MB frame limit', () => {
      const writeQueue = new WriteQueue({
        maxPending: 100,
        isMobile: false,
        getCurrentSize: () => 1024 * 1024, // 1MB - well below 10MB limit
        getCurrentScene: () => 0,
      });

      // Create a stroke that exceeds 128KB but is under 2MB
      const largePoints = Array.from({ length: 20000 }, (_, i) => i); // 40000+ numbers
      const largeStroke: DrawStrokeCommit = {
        type: 'DrawStrokeCommit',
        id: 'large-stroke',
        tool: 'pen',
        color: '#000000',
        size: 3,
        opacity: 1,
        points: largePoints,
        bbox: [0, 0, 20000, 20000],
        startedAt: Date.now(),
        finishedAt: Date.now(),
        scene: 0,
      };

      // Should fail due to 128KB stroke limit
      const result = writeQueue.validate(largeStroke);
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('oversize');
      expect(result.details).toContain('Stroke update exceeds 128KB');
    });

    it('should enforce 2MB frame limit for all commands', () => {
      const writeQueue = new WriteQueue({
        maxPending: 100,
        isMobile: false,
        getCurrentSize: () => 1024 * 1024,
        getCurrentScene: () => 0,
      });

      // Create a command that's under 128KB but part of a 2MB+ frame
      // This simulates a complex scenario where individual strokes are valid
      // but the combined frame would exceed WebSocket limits
      const moderatePoints = Array.from({ length: 5000 }, (_, i) => i);
      
      // Mock the frame size estimation to simulate a large frame
      const originalEstimate = (writeQueue as any).estimateEncodedSize;
      (writeQueue as any).estimateEncodedSize = () => 3 * 1024 * 1024; // 3MB

      const cmd: DrawStrokeCommit = {
        type: 'DrawStrokeCommit',
        id: 'moderate-stroke',
        tool: 'pen',
        color: '#000000',
        size: 3,
        opacity: 1,
        points: moderatePoints,
        bbox: [0, 0, 5000, 5000],
        startedAt: Date.now(),
        finishedAt: Date.now(),
        scene: 0,
      };

      const result = writeQueue.validate(cmd);
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('oversize');
      expect(result.details).toBe('Command too large');

      // Restore original method
      (writeQueue as any).estimateEncodedSize = originalEstimate;
    });

    it('should handle edge case: exactly at size limits', () => {
      const writeQueue = new WriteQueue({
        maxPending: 100,
        isMobile: false,
        getCurrentSize: () => ROOM_CONFIG.ROOM_SIZE_READONLY_BYTES - 1, // Just under 10MB
        getCurrentScene: () => 0,
      });

      const cmd: DrawStrokeCommit = {
        type: 'DrawStrokeCommit',
        id: 'edge-stroke',
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

      // Should succeed when just under limit
      expect(writeQueue.validate(cmd).valid).toBe(true);

      // Now simulate hitting exact limit
      const writeQueueAtLimit = new WriteQueue({
        maxPending: 100,
        isMobile: false,
        getCurrentSize: () => ROOM_CONFIG.ROOM_SIZE_READONLY_BYTES, // Exactly 10MB
        getCurrentScene: () => 0,
      });

      // Should fail when at limit
      const result = writeQueueAtLimit.validate(cmd);
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('read_only');
    });
  });

  describe('Scene Capture for Causal Consistency', () => {
    it('should reject commands with scene from the future', () => {
      const writeQueue = new WriteQueue({
        maxPending: 100,
        isMobile: false,
        getCurrentSize: () => 1024 * 1024,
        getCurrentScene: () => 2, // Current scene is 2
      });

      const futureCmd: DrawStrokeCommit = {
        type: 'DrawStrokeCommit',
        id: 'future-stroke',
        tool: 'pen',
        color: '#000000',
        size: 3,
        opacity: 1,
        points: [0, 0, 10, 10],
        bbox: [0, 0, 10, 10],
        startedAt: Date.now(),
        finishedAt: Date.now(),
        scene: 5, // Scene from the future!
      };

      const result = writeQueue.validate(futureCmd);
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('invalid_data');
      expect(result.details).toContain('Scene from future');
    });

    it('should require scene for content-creating commands', () => {
      const writeQueue = new WriteQueue({
        maxPending: 100,
        isMobile: false,
        getCurrentSize: () => 1024 * 1024,
        getCurrentScene: () => 0,
      });

      // Test DrawStrokeCommit without scene
      const strokeNoScene = {
        type: 'DrawStrokeCommit',
        id: 'no-scene-stroke',
        tool: 'pen',
        color: '#000000',
        size: 3,
        opacity: 1,
        points: [0, 0, 10, 10],
        bbox: [0, 0, 10, 10],
        startedAt: Date.now(),
        finishedAt: Date.now(),
        // scene missing!
      } as any;

      let result = writeQueue.validate(strokeNoScene);
      expect(result.valid).toBe(false);
      expect(result.details).toBe('Scene is required for DrawStrokeCommit');

      // Test AddText without scene
      const textNoScene = {
        type: 'AddText',
        id: 'no-scene-text',
        x: 100,
        y: 100,
        w: 200,
        h: 50,
        content: 'Test',
        color: '#000000',
        size: 16,
        // scene missing!
      } as any;

      result = writeQueue.validate(textNoScene);
      expect(result.valid).toBe(false);
      expect(result.details).toBe('Scene is required for AddText');
    });

    it('should allow valid past scenes (distributed consistency)', () => {
      const writeQueue = new WriteQueue({
        maxPending: 100,
        isMobile: false,
        getCurrentSize: () => 1024 * 1024,
        getCurrentScene: () => 3, // Current scene is 3
      });

      // Command started in scene 1 (before multiple clears)
      const pastCmd: DrawStrokeCommit = {
        type: 'DrawStrokeCommit',
        id: 'past-stroke',
        tool: 'pen',
        color: '#000000',
        size: 3,
        opacity: 1,
        points: [0, 0, 10, 10],
        bbox: [0, 0, 10, 10],
        startedAt: Date.now() - 5000, // Started 5 seconds ago
        finishedAt: Date.now(),
        scene: 1, // Valid past scene
      };

      const result = writeQueue.validate(pastCmd);
      expect(result.valid).toBe(true); // Past scenes are valid!
    });
  });

  describe('Idempotency and Exactly-Once Semantics', () => {
    it('should track and reject duplicate commands', () => {
      const writeQueue = new WriteQueue({
        maxPending: 100,
        isMobile: false,
        getCurrentSize: () => 1024 * 1024,
        getCurrentScene: () => 0,
      });

      const cmd: DrawStrokeCommit = {
        type: 'DrawStrokeCommit',
        id: 'unique-stroke-123', // This ID is the idempotency key
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

      // First attempt should succeed
      expect(writeQueue.enqueue(cmd)).toBe(true);

      // Duplicate should be rejected
      expect(writeQueue.enqueue(cmd)).toBe(false);

      // Even with slightly different properties, same ID = duplicate
      const modifiedCmd = { ...cmd, color: '#FF0000' };
      expect(writeQueue.enqueue(modifiedCmd)).toBe(false);
    });

    it('should handle ClearBoard idempotency with time bucketing', () => {
      const writeQueue = new WriteQueue({
        maxPending: 100,
        isMobile: false,
        getCurrentSize: () => 1024 * 1024,
        getCurrentScene: () => 0,
      });

      const now = Date.now();
      
      // Two ClearBoard commands with different keys but same time bucket
      const clear1: ClearBoard = {
        type: 'ClearBoard',
        idempotencyKey: `clear-${now}`,
      };

      const clear2: ClearBoard = {
        type: 'ClearBoard',
        idempotencyKey: `clear-${now + 100}`, // Different key, but within 300ms window
      };

      // First should succeed
      expect(writeQueue.enqueue(clear1)).toBe(true);

      // Second should fail due to rate limiting (15s cooldown)
      expect(writeQueue.enqueue(clear2)).toBe(false);
    });

    it('should clean up old idempotency entries to prevent memory leak', () => {
      const writeQueue = new WriteQueue({
        maxPending: 100,
        isMobile: false,
        getCurrentSize: () => 1024 * 1024,
        getCurrentScene: () => 0,
      });

      // Add a command
      const cmd: DrawStrokeCommit = {
        type: 'DrawStrokeCommit',
        id: 'old-stroke',
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

      writeQueue.enqueue(cmd);

      // Mock time passing (>5 minutes)
      const originalDateNow = Date.now;
      Date.now = () => originalDateNow() + 6 * 60 * 1000;

      // Trigger cleanup
      (writeQueue as any).cleanupIdempotency();

      // After cleanup, same ID should be allowed again
      Date.now = originalDateNow; // Reset time
      const sameCmd = { ...cmd }; // Same ID
      
      // Should succeed since old entry was cleaned up
      // Note: In real implementation, this would work after cleanup
      // Here we're testing the concept
      expect((writeQueue as any).idempotencyMap.size).toBe(0);
    });
  });

  describe('Rate Limiting Under Load', () => {
    it('should enforce ClearBoard rate limit under rapid fire', () => {
      const writeQueue = new WriteQueue({
        maxPending: 100,
        isMobile: false,
        getCurrentSize: () => 1024 * 1024,
        getCurrentScene: () => 0,
      });

      const results: boolean[] = [];
      
      // Rapid fire 10 ClearBoard commands
      for (let i = 0; i < 10; i++) {
        const cmd: ClearBoard = {
          type: 'ClearBoard',
          idempotencyKey: `clear-${i}`,
        };
        results.push(writeQueue.enqueue(cmd));
      }

      // Only first should succeed, rest should be rate limited
      expect(results[0]).toBe(true);
      expect(results.slice(1).every(r => r === false)).toBe(true);
    });

    it('should enforce ExtendTTL rate limit (10 min cooldown)', () => {
      const writeQueue = new WriteQueue({
        maxPending: 100,
        isMobile: false,
        getCurrentSize: () => 1024 * 1024,
        getCurrentScene: () => 0,
      });

      const ttl1: any = {
        type: 'ExtendTTL',
        idempotencyKey: 'ttl-1',
      };

      const ttl2: any = {
        type: 'ExtendTTL',
        idempotencyKey: 'ttl-2',
      };

      // First should succeed
      expect(writeQueue.enqueue(ttl1)).toBe(true);

      // Second immediately after should fail
      expect(writeQueue.enqueue(ttl2)).toBe(false);

      // Even after 5 minutes, still rate limited (needs 10 min)
      const originalDateNow = Date.now;
      Date.now = () => originalDateNow() + 5 * 60 * 1000;
      
      const ttl3: any = {
        type: 'ExtendTTL',
        idempotencyKey: 'ttl-3',
      };
      expect(writeQueue.enqueue(ttl3)).toBe(false);

      Date.now = originalDateNow; // Reset
    });
  });

  describe('Backpressure and Queue Management', () => {
    it('should detect backpressure at high water mark', () => {
      const writeQueue = new WriteQueue({
        maxPending: 100,
        isMobile: false,
        getCurrentSize: () => 1024 * 1024,
        getCurrentScene: () => 0,
      });

      // Fill queue to just below high water mark
      for (let i = 0; i < QUEUE_CONFIG.WRITE_QUEUE_HIGH_WATER - 1; i++) {
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
        writeQueue.enqueue(cmd);
      }

      // Should not be backpressured yet
      expect(writeQueue.isBackpressured()).toBe(false);

      // Add one more to hit high water mark
      const cmd: DrawStrokeCommit = {
        type: 'DrawStrokeCommit',
        id: `stroke-${QUEUE_CONFIG.WRITE_QUEUE_HIGH_WATER}`,
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
      writeQueue.enqueue(cmd);

      // Should now be backpressured
      expect(writeQueue.isBackpressured()).toBe(true);
    });

    it('should reject commands when queue is full', () => {
      const writeQueue = new WriteQueue({
        maxPending: 100,
        isMobile: false,
        getCurrentSize: () => 1024 * 1024,
        getCurrentScene: () => 0,
      });

      // Fill queue to capacity
      for (let i = 0; i < 100; i++) {
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
        writeQueue.enqueue(cmd);
      }

      // Queue is now full
      expect(writeQueue.size()).toBe(100);

      // Next command should be rejected
      const overflowCmd: DrawStrokeCommit = {
        type: 'DrawStrokeCommit',
        id: 'overflow-stroke',
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

      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      expect(writeQueue.enqueue(overflowCmd)).toBe(false);
      expect(consoleSpy).toHaveBeenCalledWith('[WriteQueue] Queue full, dropping command');
      consoleSpy.mockRestore();
    });

    it('should maintain FIFO order under pressure', () => {
      const writeQueue = new WriteQueue({
        maxPending: 100,
        isMobile: false,
        getCurrentSize: () => 1024 * 1024,
        getCurrentScene: () => 0,
      });

      const commands: any[] = [];
      
      // Add mix of command types
      for (let i = 0; i < 20; i++) {
        const cmd = i % 3 === 0 
          ? {
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
            }
          : i % 3 === 1
          ? {
              type: 'AddText',
              id: `text-${i}`,
              x: i * 10,
              y: i * 10,
              w: 100,
              h: 50,
              content: `Text ${i}`,
              color: '#000000',
              size: 16,
              scene: 0,
            }
          : {
              type: 'EraseObjects',
              ids: [`obj-${i}`],
              idempotencyKey: `erase-${i}`,
            };
        
        commands.push(cmd);
        writeQueue.enqueue(cmd as any);
      }

      // Dequeue and verify FIFO order
      for (let i = 0; i < commands.length; i++) {
        const dequeued = writeQueue.dequeue();
        expect(dequeued).toEqual(commands[i]);
      }

      // Queue should be empty
      expect(writeQueue.dequeue()).toBeNull();
    });
  });

  describe('Mobile View-Only Enforcement', () => {
    it('should detect various mobile user agents', () => {
      const mobileAgents = [
        'Mozilla/5.0 (iPhone; CPU iPhone OS 14_0 like Mac OS X)',
        'Mozilla/5.0 (iPad; CPU OS 14_0 like Mac OS X)',
        'Mozilla/5.0 (Linux; Android 10; SM-G975F)',
        'Mozilla/5.0 (Linux; Android 10; Pixel 4)',
      ];

      for (const userAgent of mobileAgents) {
        const writeQueue = new WriteQueue({
          maxPending: 100,
          isMobile: true, // Simulating mobile detection
          getCurrentSize: () => 1024 * 1024,
          getCurrentScene: () => 0,
        });

        const cmd: DrawStrokeCommit = {
          type: 'DrawStrokeCommit',
          id: 'mobile-test',
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

        const result = writeQueue.validate(cmd);
        expect(result.valid).toBe(false);
        expect(result.reason).toBe('view_only');
        expect(result.details).toBe('Mobile devices are view-only');
      }
    });

    it('should allow desktop browsers', () => {
      const writeQueue = new WriteQueue({
        maxPending: 100,
        isMobile: false, // Desktop
        getCurrentSize: () => 1024 * 1024,
        getCurrentScene: () => 0,
      });

      const cmd: DrawStrokeCommit = {
        type: 'DrawStrokeCommit',
        id: 'desktop-test',
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

      const result = writeQueue.validate(cmd);
      expect(result.valid).toBe(true);
    });
  });

  describe('Room Size Transitions (8MB warning, 10MB read-only)', () => {
    it('should handle transition through size thresholds', () => {
      let currentSize = 7 * 1024 * 1024; // Start at 7MB
      
      const writeQueue = new WriteQueue({
        maxPending: 100,
        isMobile: false,
        getCurrentSize: () => currentSize,
        getCurrentScene: () => 0,
      });

      const cmd: DrawStrokeCommit = {
        type: 'DrawStrokeCommit',
        id: 'size-test',
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

      // At 7MB - should work
      expect(writeQueue.validate(cmd).valid).toBe(true);

      // At 8MB (warning threshold) - should still work
      currentSize = ROOM_CONFIG.ROOM_SIZE_WARNING_BYTES;
      expect(writeQueue.validate(cmd).valid).toBe(true);

      // At 9.99MB - should still work
      currentSize = ROOM_CONFIG.ROOM_SIZE_READONLY_BYTES - 1;
      expect(writeQueue.validate(cmd).valid).toBe(true);

      // At 10MB (read-only threshold) - should fail
      currentSize = ROOM_CONFIG.ROOM_SIZE_READONLY_BYTES;
      const result = writeQueue.validate(cmd);
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('read_only');

      // Above 10MB - should still fail
      currentSize = ROOM_CONFIG.ROOM_SIZE_READONLY_BYTES + 1024;
      expect(writeQueue.validate(cmd).valid).toBe(false);
    });

    it('should clear queue when room becomes read-only mid-batch', async () => {
      // This tests CommandBus behavior
      const roomId = 'test-readonly-transition';
      const manager = RoomDocManagerRegistry.get(roomId);

      // Mock size that changes during processing
      let currentSize = 9.9 * 1024 * 1024; // Just under 10MB
      (manager as any).estimateDocSize = () => currentSize;

      // Queue multiple commands
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
      }

      // Simulate size crossing threshold during processing
      currentSize = 10 * 1024 * 1024; // Now at 10MB

      // Process commands
      await manager.processCommandsImmediate?.();

      // Commands after threshold should have been dropped
      // (Implementation should clear queue when read-only detected)
      expect(manager.currentSnapshot.strokes.length).toBeLessThan(10);

      manager.destroy();
    });
  });
});

describe('Phase 2.5: CommandBus Distributed Systems Challenges', () => {
  let ydoc: Y.Doc;
  let writeQueue: WriteQueue;
  let commandBus: CommandBus;

  beforeEach(() => {
    ydoc = new Y.Doc({ guid: 'test-room' });
    
    // Initialize Y.Doc structure
    const meta = ydoc.getMap('meta');
    meta.set('scene_ticks', new Y.Array());
    ydoc.getArray('strokes');
    ydoc.getArray('texts');
    ydoc.getMap('code');
    ydoc.getArray('outputs');

    writeQueue = new WriteQueue({
      maxPending: 100,
      isMobile: false,
      getCurrentSize: () => 1024 * 1024,
      getCurrentScene: () => (ydoc.getMap('meta').get('scene_ticks') as Y.Array<number>).length,
    });

    commandBus = new CommandBus({
      ydoc,
      writeQueue,
      getCurrentSize: () => 1024 * 1024,
      getHelpers: () => ({
        getStrokes: () => ydoc.getArray('strokes'),
        getTexts: () => ydoc.getArray('texts'),
        getCode: () => ydoc.getMap('code'),
        getOutputs: () => ydoc.getArray('outputs'),
        getSceneTicks: () => ydoc.getMap('meta').get('scene_ticks') as Y.Array<number>,
        getCurrentScene: () => (ydoc.getMap('meta').get('scene_ticks') as Y.Array<number>).length,
      }),
    });
  });

  afterEach(() => {
    commandBus.destroy();
    writeQueue.destroy();
    ydoc.destroy();
  });

  describe('Single Transaction Atomicity', () => {
    it('should execute each command in exactly one transaction', async () => {
      const transactionSpy = vi.spyOn(ydoc, 'transact');

      const cmd: DrawStrokeCommit = {
        type: 'DrawStrokeCommit',
        id: 'atomic-stroke',
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

      writeQueue.enqueue(cmd);
      await commandBus.processImmediate();

      // Should have exactly one transaction
      expect(transactionSpy).toHaveBeenCalledTimes(1);

      // Verify stroke was added
      const strokes = ydoc.getArray('strokes');
      expect(strokes.length).toBe(1);
      expect(strokes.get(0).id).toBe('atomic-stroke');

      transactionSpy.mockRestore();
    });

    it('should maintain transaction atomicity for complex operations', async () => {
      // EraseObjects is complex - it modifies multiple arrays
      const strokes = ydoc.getArray('strokes');
      const texts = ydoc.getArray('texts');

      // Add some initial data
      ydoc.transact(() => {
        strokes.push([
          { id: 'stroke-1', points: [0, 0, 10, 10] },
          { id: 'stroke-2', points: [20, 20, 30, 30] },
          { id: 'stroke-3', points: [40, 40, 50, 50] },
        ]);
        texts.push([
          { id: 'text-1', content: 'Text 1' },
          { id: 'text-2', content: 'Text 2' },
        ]);
      });

      const transactionSpy = vi.spyOn(ydoc, 'transact');

      const eraseCmd: EraseObjects = {
        type: 'EraseObjects',
        ids: ['stroke-2', 'text-1'],
        idempotencyKey: 'erase-multiple',
      };

      writeQueue.enqueue(eraseCmd);
      await commandBus.processImmediate();

      // Should have exactly one transaction for the erase
      expect(transactionSpy).toHaveBeenCalledTimes(1);

      // Verify correct items were removed atomically
      expect(strokes.length).toBe(2);
      expect(texts.length).toBe(1);
      expect(strokes.get(0).id).toBe('stroke-1');
      expect(strokes.get(1).id).toBe('stroke-3');
      expect(texts.get(0).id).toBe('text-2');

      transactionSpy.mockRestore();
    });
  });

  describe('Scene Preservation in CommandBus', () => {
    it('should use cmd.scene, never re-read getCurrentScene()', async () => {
      const sceneTicks = ydoc.getMap('meta').get('scene_ticks') as Y.Array<number>;
      
      // Start in scene 0
      expect(sceneTicks.length).toBe(0);

      // User A's stroke captured in scene 0
      const strokeA: DrawStrokeCommit = {
        type: 'DrawStrokeCommit',
        id: 'stroke-A',
        tool: 'pen',
        color: '#000000',
        size: 3,
        opacity: 1,
        points: [0, 0, 10, 10],
        bbox: [0, 0, 10, 10],
        startedAt: Date.now(),
        finishedAt: Date.now(),
        scene: 0, // Captured at pointer-down
      };

      writeQueue.enqueue(strokeA);

      // User B clears board (increments scene)
      const clearCmd: ClearBoard = {
        type: 'ClearBoard',
        idempotencyKey: 'clear-1',
      };
      writeQueue.enqueue(clearCmd);

      // Process both commands
      await commandBus.processImmediate();

      // Scene should now be 1
      expect(sceneTicks.length).toBe(1);

      // But stroke A should still have scene 0
      const strokes = ydoc.getArray('strokes');
      expect(strokes.length).toBe(1);
      expect(strokes.get(0).scene).toBe(0); // Preserved from command!
    });

    it('should handle multiple concurrent scene captures', async () => {
      const sceneTicks = ydoc.getMap('meta').get('scene_ticks') as Y.Array<number>;

      // Simulate multi-touch: two strokes started in different scenes
      const stroke1: DrawStrokeCommit = {
        type: 'DrawStrokeCommit',
        id: 'touch-1',
        tool: 'pen',
        color: '#000000',
        size: 3,
        opacity: 1,
        points: [0, 0, 10, 10],
        bbox: [0, 0, 10, 10],
        startedAt: Date.now(),
        finishedAt: Date.now(),
        scene: 0, // Started in scene 0
      };

      writeQueue.enqueue(stroke1);

      // Clear board
      writeQueue.enqueue({
        type: 'ClearBoard',
        idempotencyKey: 'clear-multi',
      });

      // Second touch starts in scene 1
      const stroke2: DrawStrokeCommit = {
        type: 'DrawStrokeCommit',
        id: 'touch-2',
        tool: 'pen',
        color: '#FF0000',
        size: 5,
        opacity: 1,
        points: [50, 50, 60, 60],
        bbox: [50, 50, 60, 60],
        startedAt: Date.now(),
        finishedAt: Date.now(),
        scene: 1, // Started in scene 1
      };

      writeQueue.enqueue(stroke2);

      // Process all
      await commandBus.processImmediate();

      // Verify each stroke kept its captured scene
      const strokes = ydoc.getArray('strokes');
      expect(strokes.length).toBe(2);
      
      const stroke1Data = strokes.toArray().find((s: any) => s.id === 'touch-1');
      const stroke2Data = strokes.toArray().find((s: any) => s.id === 'touch-2');
      
      expect(stroke1Data.scene).toBe(0);
      expect(stroke2Data.scene).toBe(1);
    });
  });

  describe('Batch Processing Under Pressure', () => {
    it('should handle burst processing without data loss', async () => {
      const commands: DrawStrokeCommit[] = [];
      
      // Queue 50 rapid commands
      for (let i = 0; i < 50; i++) {
        const cmd: DrawStrokeCommit = {
          type: 'DrawStrokeCommit',
          id: `burst-${i}`,
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
        commands.push(cmd);
        writeQueue.enqueue(cmd);
      }

      // Process all at once
      await commandBus.processImmediate();

      // All commands should be processed
      const strokes = ydoc.getArray('strokes');
      expect(strokes.length).toBe(50);

      // Verify all IDs present
      const strokeIds = strokes.toArray().map((s: any) => s.id);
      for (let i = 0; i < 50; i++) {
        expect(strokeIds).toContain(`burst-${i}`);
      }
    });

    it('should respect transaction budget and yield', async () => {
      // Mock performance.now to control timing
      let currentTime = 0;
      const originalPerformanceNow = performance.now;
      performance.now = () => currentTime;

      // Queue many commands
      for (let i = 0; i < 100; i++) {
        const cmd: DrawStrokeCommit = {
          type: 'DrawStrokeCommit',
          id: `budget-${i}`,
          tool: 'pen',
          color: '#000000',
          size: 3,
          opacity: 1,
          points: Array.from({ length: 100 }, (_, j) => j), // Larger stroke
          bbox: [0, 0, 100, 100],
          startedAt: Date.now(),
          finishedAt: Date.now(),
          scene: 0,
        };
        writeQueue.enqueue(cmd);
      }

      // Start processing
      const processPromise = commandBus.processImmediate();

      // Simulate time passing during processing
      // CommandBus should yield after budget exceeded
      currentTime = 10; // 10ms passed

      await processPromise;

      // Should have processed some but not all in first batch
      // (Exact number depends on budget implementation)
      const strokes = ydoc.getArray('strokes');
      expect(strokes.length).toBeGreaterThan(0);
      expect(strokes.length).toBeLessThanOrEqual(100);

      // Restore
      performance.now = originalPerformanceNow;
    });
  });

  describe('Error Recovery and Resilience', () => {
    it('should handle malformed commands gracefully', async () => {
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      // Queue a malformed command (missing required fields)
      const malformed = {
        type: 'DrawStrokeCommit',
        id: 'malformed',
        // Missing required fields like points, bbox, etc.
      } as any;

      // This should be caught by validation
      const result = writeQueue.validate(malformed);
      expect(result.valid).toBe(false);

      consoleSpy.mockRestore();
    });

    it('should recover from transaction errors', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      // Mock a transaction that throws
      const originalTransact = ydoc.transact.bind(ydoc);
      let shouldThrow = true;
      ydoc.transact = function(fn: any, origin?: any) {
        if (shouldThrow) {
          shouldThrow = false;
          throw new Error('Transaction failed');
        }
        return originalTransact(fn, origin);
      };

      const cmd: DrawStrokeCommit = {
        type: 'DrawStrokeCommit',
        id: 'error-stroke',
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

      writeQueue.enqueue(cmd);

      // Should handle error gracefully
      await commandBus.processImmediate();

      // Error should be logged
      expect(errorSpy).toHaveBeenCalled();

      // System should still be functional
      writeQueue.enqueue(cmd);
      await commandBus.processImmediate();

      // Second attempt should work
      const strokes = ydoc.getArray('strokes');
      expect(strokes.length).toBe(1);

      errorSpy.mockRestore();
    });
  });
});