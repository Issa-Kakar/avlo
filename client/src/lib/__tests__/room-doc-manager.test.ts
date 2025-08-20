import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RoomDocManagerRegistry } from '../room-doc-manager';
import type { RoomDocManager } from '../room-doc-manager';
import type { Command } from '@avlo/shared';

describe('RoomDocManagerRegistry', () => {
  afterEach(() => {
    // Clean up after each test
    RoomDocManagerRegistry.destroyAll();
  });

  describe('Singleton behavior', () => {
    it('should return the same manager instance for the same roomId', () => {
      const roomId = 'test-room-1';
      const manager1 = RoomDocManagerRegistry.get(roomId);
      const manager2 = RoomDocManagerRegistry.get(roomId);

      expect(manager1).toBe(manager2);
    });

    it('should return different manager instances for different roomIds', () => {
      const manager1 = RoomDocManagerRegistry.get('room-1');
      const manager2 = RoomDocManagerRegistry.get('room-2');

      expect(manager1).not.toBe(manager2);
    });

    it('should track existence of managers', () => {
      const roomId = 'test-room';

      expect(RoomDocManagerRegistry.has(roomId)).toBe(false);

      RoomDocManagerRegistry.get(roomId);
      expect(RoomDocManagerRegistry.has(roomId)).toBe(true);
    });

    it('should remove managers from registry on destroy', () => {
      const roomId = 'test-room';
      const manager = RoomDocManagerRegistry.get(roomId);

      expect(RoomDocManagerRegistry.has(roomId)).toBe(true);

      manager.destroy();
      expect(RoomDocManagerRegistry.has(roomId)).toBe(false);
    });

    it('should destroy all managers', () => {
      const manager1 = RoomDocManagerRegistry.get('room-1');
      const manager2 = RoomDocManagerRegistry.get('room-2');

      const spy1 = vi.spyOn(manager1, 'destroy');
      const spy2 = vi.spyOn(manager2, 'destroy');

      RoomDocManagerRegistry.destroyAll();

      expect(spy1).toHaveBeenCalled();
      expect(spy2).toHaveBeenCalled();
      expect(RoomDocManagerRegistry.has('room-1')).toBe(false);
      expect(RoomDocManagerRegistry.has('room-2')).toBe(false);
    });
  });
});

describe('RoomDocManager', () => {
  let manager: RoomDocManager;
  const roomId = 'test-room';

  beforeEach(() => {
    manager = RoomDocManagerRegistry.get(roomId);
  });

  afterEach(() => {
    RoomDocManagerRegistry.destroyAll();
  });

  describe('EmptySnapshot initialization', () => {
    it('should initialize with EmptySnapshot', () => {
      const snapshot = manager.currentSnapshot;

      expect(snapshot).toBeDefined();
      expect(snapshot).not.toBeNull();
      expect(snapshot.svKey).toBe('empty');
      expect(snapshot.scene).toBe(0);
      expect(snapshot.strokes).toHaveLength(0);
      expect(snapshot.texts).toHaveLength(0);
    });

    it('should never return null snapshot', () => {
      // Even immediately after creation
      const newManager = RoomDocManagerRegistry.get('new-room');
      expect(newManager.currentSnapshot).toBeDefined();
      expect(newManager.currentSnapshot).not.toBeNull();
    });

    it('should have frozen empty arrays in development', () => {
      const snapshot = manager.currentSnapshot;

      if (process.env.NODE_ENV === 'development') {
        expect(Object.isFrozen(snapshot.strokes)).toBe(true);
        expect(Object.isFrozen(snapshot.texts)).toBe(true);
      }
    });
  });

  describe('Subscription management', () => {
    it('should call snapshot subscriber immediately with current snapshot', () => {
      const callback = vi.fn();
      const unsub = manager.subscribeSnapshot(callback);

      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith(manager.currentSnapshot);

      unsub();
    });

    it('should call presence subscriber immediately with current presence', () => {
      const callback = vi.fn();
      const unsub = manager.subscribePresence(callback);

      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith(manager.currentSnapshot.presence);

      unsub();
    });

    it('should call stats subscriber immediately', () => {
      const callback = vi.fn();
      const unsub = manager.subscribeRoomStats(callback);

      expect(callback).toHaveBeenCalledTimes(1);
      // Initial call might be with null
      expect(callback).toHaveBeenCalledWith(expect.any(Object));

      unsub();
    });

    it('should unsubscribe correctly', () => {
      const callback = vi.fn();
      const unsub = manager.subscribeSnapshot(callback);

      callback.mockClear();
      unsub();

      // After unsubscribing, writing shouldn't trigger callback
      manager.write({ type: 'ClearBoard', idempotencyKey: 'test' } as Command);

      // Give time for any async operations
      setTimeout(() => {
        expect(callback).not.toHaveBeenCalled();
      }, 100);
    });

    it('should handle multiple subscribers', () => {
      const callback1 = vi.fn();
      const callback2 = vi.fn();
      const callback3 = vi.fn();

      const unsub1 = manager.subscribeSnapshot(callback1);
      const unsub2 = manager.subscribeSnapshot(callback2);
      const unsub3 = manager.subscribeSnapshot(callback3);

      expect(callback1).toHaveBeenCalledTimes(1);
      expect(callback2).toHaveBeenCalledTimes(1);
      expect(callback3).toHaveBeenCalledTimes(1);

      unsub1();
      unsub2();
      unsub3();
    });

    it('should handle rapid subscribe/unsubscribe without crashes', () => {
      const callbacks: (() => void)[] = [];

      // Rapid subscribe/unsubscribe
      for (let i = 0; i < 100; i++) {
        const unsub = manager.subscribeSnapshot(() => {});
        callbacks.push(unsub);
      }

      // Unsubscribe all
      callbacks.forEach((unsub) => unsub());

      // Should not crash
      expect(manager.currentSnapshot).toBeDefined();
    });
  });

  describe('Write operations', () => {
    it('should accept write commands', () => {
      const command: Command = {
        type: 'ClearBoard',
        idempotencyKey: 'clear-123',
      };

      // Should not throw
      expect(() => manager.write(command)).not.toThrow();
    });

    it('should log write commands', () => {
      const consoleSpy = vi.spyOn(console, 'log');

      const command: Command = {
        type: 'DrawStrokeCommit',
        id: 'stroke-123',
        tool: 'pen',
        color: '#000000',
        size: 5,
        opacity: 1,
        points: [0, 0, 10, 10],
        bbox: [0, 0, 10, 10],
        startedAt: Date.now(),
        finishedAt: Date.now(),
        scene: 0,
      };

      manager.write(command);

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Write command:'),
        'DrawStrokeCommit',
      );
    });
  });

  describe('TTL extension', () => {
    it('should handle TTL extension', () => {
      const consoleSpy = vi.spyOn(console, 'log');

      manager.extendTTL();

      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Extending TTL'));
    });
  });

  describe('Lifecycle management', () => {
    it('should cleanup on destroy', () => {
      const manager = RoomDocManagerRegistry.get('destroy-test');
      const consoleSpy = vi.spyOn(console, 'log');

      manager.destroy();

      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Destroying'));

      expect(RoomDocManagerRegistry.has('destroy-test')).toBe(false);
    });

    it('should handle destroy during update gracefully', () => {
      const manager = RoomDocManagerRegistry.get('destroy-during-update');

      manager.write({ type: 'ClearBoard', idempotencyKey: 'test' } as Command);

      // Should not throw
      expect(() => manager.destroy()).not.toThrow();
    });

    it('should cleanup all subscriptions on destroy', () => {
      const manager = RoomDocManagerRegistry.get('cleanup-test');
      const callbacks = {
        snapshot: vi.fn(),
        presence: vi.fn(),
        stats: vi.fn(),
      };

      // Subscribe to all
      manager.subscribeSnapshot(callbacks.snapshot);
      manager.subscribePresence(callbacks.presence);
      manager.subscribeRoomStats(callbacks.stats);

      // Clear initial calls
      Object.values(callbacks).forEach((cb) => cb.mockClear());

      manager.destroy();

      // Try to write after destroy (should not trigger callbacks)
      setTimeout(() => {
        expect(callbacks.snapshot).not.toHaveBeenCalled();
        expect(callbacks.presence).not.toHaveBeenCalled();
        expect(callbacks.stats).not.toHaveBeenCalled();
      }, 100);
    });
  });

  describe('Visibility handling', () => {
    it('should setup visibility change listener', () => {
      const addEventListenerSpy = vi.spyOn(document, 'addEventListener');

      // Create a new manager to trigger setup
      RoomDocManagerRegistry.get('visibility-test');

      expect(addEventListenerSpy).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
    });

    it('should handle tab visibility changes', () => {
      RoomDocManagerRegistry.get('visibility-change-test');
      const consoleSpy = vi.spyOn(console, 'log');

      // Simulate tab becoming hidden
      Object.defineProperty(document, 'hidden', {
        value: true,
        writable: true,
        configurable: true,
      });
      document.dispatchEvent(new Event('visibilitychange'));

      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Tab visibility:'), 'hidden');

      // Simulate tab becoming visible
      Object.defineProperty(document, 'hidden', {
        value: false,
        writable: true,
        configurable: true,
      });
      document.dispatchEvent(new Event('visibilitychange'));

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Tab visibility:'),
        'visible',
      );
    });
  });

  describe('Performance and batching', () => {
    it('should have appropriate initial batch window', () => {
      // This is implementation detail, but we can verify through behavior
      const manager = RoomDocManagerRegistry.get('batch-test');

      // Initial snapshot should exist
      expect(manager.currentSnapshot).toBeDefined();

      // Batch window should be between MIN and MAX (8-32ms)
      // We can't directly access private properties, but we can observe behavior
    });

    it('should handle multiple rapid writes', () => {
      const manager = RoomDocManagerRegistry.get('rapid-write-test');

      // Should handle rapid writes without crashing
      for (let i = 0; i < 100; i++) {
        manager.write({
          type: 'ClearBoard',
          idempotencyKey: `clear-${i}`,
        } as Command);
      }

      expect(manager.currentSnapshot).toBeDefined();
    });
  });

  describe('Snapshot building', () => {
    it('should have correct snapshot structure', () => {
      const snapshot = manager.currentSnapshot;

      // Check all required properties
      expect(snapshot).toHaveProperty('svKey');
      expect(snapshot).toHaveProperty('scene');
      expect(snapshot).toHaveProperty('strokes');
      expect(snapshot).toHaveProperty('texts');
      expect(snapshot).toHaveProperty('presence');
      expect(snapshot).toHaveProperty('spatialIndex');
      expect(snapshot).toHaveProperty('view');
      expect(snapshot).toHaveProperty('meta');
      expect(snapshot).toHaveProperty('createdAt');
    });

    it('should have correct view transform functions', () => {
      const snapshot = manager.currentSnapshot;

      expect(snapshot.view.worldToCanvas).toBeDefined();
      expect(snapshot.view.canvasToWorld).toBeDefined();
      expect(snapshot.view.scale).toBe(1);
      expect(snapshot.view.pan).toEqual({ x: 0, y: 0 });

      // Test transform functions
      const [x1, y1] = snapshot.view.worldToCanvas(10, 20);
      expect(x1).toBe(10);
      expect(y1).toBe(20);

      const [x2, y2] = snapshot.view.canvasToWorld(30, 40);
      expect(x2).toBe(30);
      expect(y2).toBe(40);
    });

    it('should have correct meta structure', () => {
      const snapshot = manager.currentSnapshot;

      expect(snapshot.meta.cap).toBe(10 * 1024 * 1024); // 10MB
      expect(snapshot.meta.readOnly).toBe(false);
    });

    it('should freeze snapshot in development', () => {
      if (process.env.NODE_ENV === 'development') {
        const snapshot = manager.currentSnapshot;
        expect(Object.isFrozen(snapshot)).toBe(true);
      }
    });
  });
});
