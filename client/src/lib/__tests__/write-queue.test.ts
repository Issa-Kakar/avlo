import { describe, it, expect, beforeEach } from 'vitest';
import { WriteQueue } from '../write-queue';
import { DrawStrokeCommit, ClearBoard, ExtendTTL, AddText } from '@avlo/shared';

describe('WriteQueue', () => {
  let writeQueue: WriteQueue;

  beforeEach(() => {
    writeQueue = new WriteQueue({
      maxPending: 100,
      isMobile: false,
      getCurrentSize: () => 1024 * 1024, // 1MB - well below limit
      getCurrentScene: () => 0,
    });
  });

  describe('validation', () => {
    it('should reject mobile writes', () => {
      const mobileQueue = new WriteQueue({
        maxPending: 100,
        isMobile: true,
        getCurrentSize: () => 0,
        getCurrentScene: () => 0,
      });

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

      const result = mobileQueue.validate(cmd);
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('view_only');
      expect(result.details).toBe('Mobile devices are view-only');
    });

    it('should reject when room is read-only', () => {
      const readOnlyQueue = new WriteQueue({
        maxPending: 100,
        isMobile: false,
        getCurrentSize: () => 10 * 1024 * 1024, // 10MB - at limit
        getCurrentScene: () => 0,
      });

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

      const result = readOnlyQueue.validate(cmd);
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('read_only');
      expect(result.details).toBe('Room size limit exceeded');
    });

    it('should enforce idempotency', () => {
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

      // First command should succeed
      expect(writeQueue.enqueue(cmd)).toBe(true);
      
      // Duplicate command should fail
      expect(writeQueue.enqueue(cmd)).toBe(false);
    });

    it('should rate limit ClearBoard', () => {
      const cmd1: ClearBoard = {
        type: 'ClearBoard',
        idempotencyKey: 'clear-1',
      };

      const cmd2: ClearBoard = {
        type: 'ClearBoard',
        idempotencyKey: 'clear-2',
      };

      // First clear should succeed
      expect(writeQueue.enqueue(cmd1)).toBe(true);
      
      // Second clear immediately after should fail (rate limited)
      expect(writeQueue.enqueue(cmd2)).toBe(false);
    });

    it('should rate limit ExtendTTL', () => {
      const cmd1: ExtendTTL = {
        type: 'ExtendTTL',
        idempotencyKey: 'ttl-1',
      };

      const cmd2: ExtendTTL = {
        type: 'ExtendTTL',
        idempotencyKey: 'ttl-2',
      };

      // First extend should succeed
      expect(writeQueue.enqueue(cmd1)).toBe(true);
      
      // Second extend immediately after should fail (rate limited)
      expect(writeQueue.enqueue(cmd2)).toBe(false);
    });

    it('should validate scene is not from the future', () => {
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
        scene: 5, // Scene from the future (current is 0)
      };

      const result = writeQueue.validate(cmd);
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('invalid_data');
      expect(result.details).toContain('Scene from future');
    });

    it('should require scene for DrawStrokeCommit', () => {
      const cmd = {
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
        // scene missing
      } as any;

      const result = writeQueue.validate(cmd);
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('invalid_data');
      expect(result.details).toBe('Scene is required for DrawStrokeCommit');
    });

    it('should require scene for AddText', () => {
      const cmd = {
        type: 'AddText',
        id: 'text-1',
        x: 100,
        y: 100,
        w: 200,
        h: 50,
        content: 'Test text',
        color: '#000000',
        size: 16,
        // scene missing
      } as any;

      const result = writeQueue.validate(cmd);
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('invalid_data');
      expect(result.details).toBe('Scene is required for AddText');
    });
  });

  describe('queue operations', () => {
    it('should handle backpressure', () => {
      // Fill queue to near capacity (80 is high water mark)
      for (let i = 0; i < 75; i++) {
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

      expect(writeQueue.isBackpressured()).toBe(false);

      // Add more to trigger backpressure
      for (let i = 75; i < 85; i++) {
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

      expect(writeQueue.isBackpressured()).toBe(true);
    });

    it('should dequeue in FIFO order', () => {
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

      const cmd2: AddText = {
        type: 'AddText',
        id: 'text-1',
        x: 100,
        y: 100,
        w: 200,
        h: 50,
        content: 'Test text',
        color: '#000000',
        size: 16,
        scene: 0,
      };

      writeQueue.enqueue(cmd1);
      writeQueue.enqueue(cmd2);

      expect(writeQueue.dequeue()).toEqual(cmd1);
      expect(writeQueue.dequeue()).toEqual(cmd2);
      expect(writeQueue.dequeue()).toBeNull();
    });
  });

  describe('cleanup', () => {
    it('should clear queue on destroy', () => {
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

      writeQueue.enqueue(cmd);
      expect(writeQueue.size()).toBe(1);

      writeQueue.destroy();
      expect(writeQueue.size()).toBe(0);
    });
  });
});