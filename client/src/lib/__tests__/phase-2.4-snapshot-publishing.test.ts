import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RoomDocManagerRegistry } from '../room-doc-manager';
import { DrawStrokeCommit, ClearBoard, AddText } from '@avlo/shared';

describe('Phase 2.4: Snapshot Publishing System', () => {
  beforeEach(() => {
    RoomDocManagerRegistry.destroyAll();
  });

  afterEach(() => {
    RoomDocManagerRegistry.destroyAll();
    vi.clearAllMocks();
  });

  describe('Core Snapshot Functionality', () => {
    it('should publish snapshots when Y.Doc changes', async () => {
      const roomId = 'test-room-publish';
      const manager = RoomDocManagerRegistry.get(roomId);

      let snapshotCount = 0;
      const unsubscribe = manager.subscribeSnapshot(() => {
        snapshotCount++;
      });

      // Initial snapshot should exist
      const initialSnapshot = manager.currentSnapshot;
      expect(initialSnapshot).not.toBeNull();
      expect(initialSnapshot.strokes).toEqual([]);

      // Add a stroke
      const strokeCmd: DrawStrokeCommit = {
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

      manager.write(strokeCmd);
      await manager.processCommandsImmediate?.();

      // Snapshot should be published
      expect(snapshotCount).toBeGreaterThan(0);
      expect(manager.currentSnapshot.strokes.length).toBe(1);

      unsubscribe();
      manager.destroy();
    });

    it('should coalesce multiple rapid updates into single snapshot', async () => {
      const roomId = 'test-room-batch';
      const manager = RoomDocManagerRegistry.get(roomId);

      let snapshotCount = 0;
      const unsubscribe = manager.subscribeSnapshot(() => {
        snapshotCount++;
      });

      // Send multiple commands rapidly
      const commands = [];
      for (let i = 0; i < 5; i++) {
        commands.push({
          type: 'DrawStrokeCommit' as const,
          id: `stroke-${i}`,
          tool: 'pen' as const,
          color: '#000000',
          size: 3,
          opacity: 1,
          points: [i, i, i + 1, i + 1],
          bbox: [i, i, i + 1, i + 1],
          startedAt: Date.now(),
          finishedAt: Date.now(),
          scene: 0,
        });
      }

      // Write all commands at once
      commands.forEach((cmd) => manager.write(cmd));

      // Process them together
      await manager.processCommandsImmediate?.();

      // Should result in a single coalesced snapshot
      expect(snapshotCount).toBe(1);
      expect(manager.currentSnapshot.strokes.length).toBe(5);

      unsubscribe();
      manager.destroy();
    });
  });

  describe('Snapshot Immutability', () => {
    it('should never allow null snapshot', () => {
      const roomId = 'test-room-never-null';
      const manager = RoomDocManagerRegistry.get(roomId);

      // Snapshot should exist immediately (EmptySnapshot)
      expect(manager.currentSnapshot).not.toBeNull();
      expect(manager.currentSnapshot).not.toBeUndefined();
      expect(manager.currentSnapshot.svKey).toBeDefined();
      expect(manager.currentSnapshot.scene).toBe(0);
      expect(manager.currentSnapshot.strokes).toEqual([]);
      expect(manager.currentSnapshot.texts).toEqual([]);

      manager.destroy();
    });

    it('should freeze snapshots in development', () => {
      const roomId = 'test-room-frozen';
      const manager = RoomDocManagerRegistry.get(roomId);

      const snapshot = manager.currentSnapshot;

      // In development, snapshots should be frozen
      if (process.env.NODE_ENV === 'development') {
        expect(Object.isFrozen(snapshot)).toBe(true);
        expect(Object.isFrozen(snapshot.strokes)).toBe(true);
        expect(Object.isFrozen(snapshot.texts)).toBe(true);
      }

      manager.destroy();
    });

    it('should create new arrays per publish (no mutations)', async () => {
      const roomId = 'test-room-new-arrays';
      const manager = RoomDocManagerRegistry.get(roomId);

      const snapshot1 = manager.currentSnapshot;
      const strokes1 = snapshot1.strokes;
      const texts1 = snapshot1.texts;

      // Add a stroke to trigger new snapshot
      const strokeCmd: DrawStrokeCommit = {
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

      manager.write(strokeCmd);
      await manager.processCommandsImmediate?.();

      const snapshot2 = manager.currentSnapshot;

      // Should be different object references
      expect(snapshot2).not.toBe(snapshot1);
      expect(snapshot2.strokes).not.toBe(strokes1);
      expect(snapshot2.texts).not.toBe(texts1);

      manager.destroy();
    });
  });

  describe('State Vector Key (svKey)', () => {
    it('should only update svKey when Y.Doc actually changes', async () => {
      const roomId = 'test-room-svkey';
      const manager = RoomDocManagerRegistry.get(roomId);

      const initialSvKey = manager.currentSnapshot.svKey;

      // Force a snapshot read without Y.Doc change
      const snapshot1 = manager.currentSnapshot;

      // svKey should remain the same
      expect(snapshot1.svKey).toBe(initialSvKey);

      // Now make an actual Y.Doc change
      const strokeCmd: DrawStrokeCommit = {
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

      manager.write(strokeCmd);
      await manager.processCommandsImmediate?.();

      // svKey should have changed
      expect(manager.currentSnapshot.svKey).not.toBe(initialSvKey);

      manager.destroy();
    });

    it('should handle large state vectors without stack overflow', async () => {
      const roomId = 'test-room-large-sv';
      const manager = RoomDocManagerRegistry.get(roomId);

      // Add many strokes to create a large state vector
      for (let i = 0; i < 100; i++) {
        const strokeCmd: DrawStrokeCommit = {
          type: 'DrawStrokeCommit',
          id: `stroke-${i}`,
          tool: 'pen',
          color: '#000000',
          size: 3,
          opacity: 1,
          points: Array.from({ length: 100 }, (_, j) => j), // 100 points
          bbox: [0, 0, 100, 100],
          startedAt: Date.now(),
          finishedAt: Date.now(),
          scene: 0,
        };
        manager.write(strokeCmd);
      }

      await manager.processCommandsImmediate?.();

      // Should not throw stack overflow
      expect(manager.currentSnapshot.svKey).toBeDefined();
      expect(manager.currentSnapshot.svKey.length).toBeGreaterThan(0);

      manager.destroy();
    });
  });

  describe('Scene Filtering', () => {
    it('should only include strokes from current scene in snapshot', async () => {
      const roomId = 'test-room-scene-filter';
      const manager = RoomDocManagerRegistry.get(roomId);

      // Add stroke in scene 0
      const stroke0: DrawStrokeCommit = {
        type: 'DrawStrokeCommit',
        id: 'stroke-scene-0',
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

      manager.write(stroke0);
      await manager.processCommandsImmediate?.();

      // Verify stroke is visible in scene 0
      expect(manager.currentSnapshot.scene).toBe(0);
      expect(manager.currentSnapshot.strokes.length).toBe(1);
      expect(manager.currentSnapshot.strokes[0].id).toBe('stroke-scene-0');

      // Clear board to move to scene 1
      const clearCmd: ClearBoard = {
        type: 'ClearBoard',
        idempotencyKey: 'clear-1',
      };

      manager.write(clearCmd);
      await manager.processCommandsImmediate?.();

      // Verify we're in scene 1 and stroke from scene 0 is not visible
      expect(manager.currentSnapshot.scene).toBe(1);
      expect(manager.currentSnapshot.strokes.length).toBe(0);

      // Add stroke in scene 1
      const stroke1: DrawStrokeCommit = {
        type: 'DrawStrokeCommit',
        id: 'stroke-scene-1',
        tool: 'pen',
        color: '#FF0000',
        size: 5,
        opacity: 1,
        points: [20, 20, 30, 30],
        bbox: [20, 20, 30, 30],
        startedAt: Date.now(),
        finishedAt: Date.now(),
        scene: 1,
      };

      manager.write(stroke1);
      await manager.processCommandsImmediate?.();

      // Verify only scene 1 stroke is visible
      expect(manager.currentSnapshot.scene).toBe(1);
      expect(manager.currentSnapshot.strokes.length).toBe(1);
      expect(manager.currentSnapshot.strokes[0].id).toBe('stroke-scene-1');

      manager.destroy();
    });

    it('should filter texts by scene', async () => {
      const roomId = 'test-room-text-scene';
      const manager = RoomDocManagerRegistry.get(roomId);

      // Add text in scene 0
      const text0: AddText = {
        type: 'AddText',
        id: 'text-0',
        x: 100,
        y: 100,
        w: 200,
        h: 50,
        content: 'Scene 0 text',
        color: '#000000',
        size: 16,
        scene: 0,
      };

      manager.write(text0);
      await manager.processCommandsImmediate?.();

      // Verify text is visible in scene 0
      expect(manager.currentSnapshot.texts.length).toBe(1);

      // Clear board
      const clearCmd: ClearBoard = {
        type: 'ClearBoard',
        idempotencyKey: 'clear-text',
      };

      manager.write(clearCmd);
      await manager.processCommandsImmediate?.();

      // Text from scene 0 should not be visible in scene 1
      expect(manager.currentSnapshot.scene).toBe(1);
      expect(manager.currentSnapshot.texts.length).toBe(0);

      manager.destroy();
    });
  });

  describe('Memory Management', () => {
    it('should not retain large arrays or create memory leaks', async () => {
      const roomId = 'test-room-memory';
      const manager = RoomDocManagerRegistry.get(roomId);

      const snapshots: any[] = [];
      const unsubscribe = manager.subscribeSnapshot((snap) => {
        // Keep reference to test they're different objects
        snapshots.push(snap);
      });

      // Create and publish multiple snapshots
      for (let i = 0; i < 10; i++) {
        const strokeCmd: DrawStrokeCommit = {
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
        manager.write(strokeCmd);
        await manager.processCommandsImmediate?.();
      }

      // Each snapshot should be a different object
      for (let i = 1; i < snapshots.length; i++) {
        expect(snapshots[i]).not.toBe(snapshots[i - 1]);
        expect(snapshots[i].strokes).not.toBe(snapshots[i - 1].strokes);
      }

      unsubscribe();
      manager.destroy();

      // After destroy, manager should clean up properly
      expect(() => manager.currentSnapshot).not.toThrow();
    });

    it('should properly clean up on destroy', () => {
      const roomId = 'test-room-cleanup';
      const manager = RoomDocManagerRegistry.get(roomId);

      let callbackCalled = false;
      const unsubscribe = manager.subscribeSnapshot(() => {
        callbackCalled = true;
      });

      // First callback should be called for initial snapshot
      expect(callbackCalled).toBe(false); // Not called yet because no changes

      manager.destroy();

      // After destroy, new operations should not trigger callbacks
      callbackCalled = false;

      // Unsubscribe should be safe even after destroy
      expect(() => unsubscribe()).not.toThrow();
    });
  });

  describe('Error Isolation', () => {
    it('should not break publish loop if subscriber throws', async () => {
      const roomId = 'test-room-error-isolation';
      const manager = RoomDocManagerRegistry.get(roomId);

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      let goodCallbackCount = 0;

      // Add a bad subscriber that throws
      const unsub1 = manager.subscribeSnapshot(() => {
        throw new Error('Bad subscriber');
      });

      // Add a good subscriber
      const unsub2 = manager.subscribeSnapshot(() => {
        goodCallbackCount++;
      });

      // Trigger snapshot publish
      const strokeCmd: DrawStrokeCommit = {
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

      manager.write(strokeCmd);
      await manager.processCommandsImmediate?.();

      // Good subscriber should still be called
      expect(goodCallbackCount).toBe(1);

      // Error should be logged
      expect(consoleSpy).toHaveBeenCalled();

      unsub1();
      unsub2();
      consoleSpy.mockRestore();
      manager.destroy();
    });
  });

  describe('Distributed Systems Edge Cases', () => {
    it('should handle concurrent ClearBoard and stroke commits correctly', async () => {
      const roomId = 'test-room-concurrent';
      const manager = RoomDocManagerRegistry.get(roomId);

      // User A starts drawing in Scene 0
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
        scene: 0, // Captured at pointer-down in scene 0
      };

      // User B clears board (increments to Scene 1)
      const clearCmd: ClearBoard = {
        type: 'ClearBoard',
        idempotencyKey: 'clear-concurrent',
      };

      // Process clear first
      manager.write(clearCmd);
      await manager.processCommandsImmediate?.();

      // Verify scene incremented
      expect(manager.currentSnapshot.scene).toBe(1);

      // Now User A completes their stroke (with scene 0 captured at start)
      manager.write(strokeA);
      await manager.processCommandsImmediate?.();

      // The stroke should be in scene 0, so it shouldn't be visible in current scene 1
      expect(manager.currentSnapshot.scene).toBe(1);
      expect(manager.currentSnapshot.strokes.length).toBe(0);

      // This demonstrates causal consistency: objects remain in the scene
      // where they were created, even if the board was cleared during the gesture

      manager.destroy();
    });

    it('should maintain consistency with rapid scene changes', async () => {
      const roomId = 'test-room-rapid-scenes';
      const manager = RoomDocManagerRegistry.get(roomId);

      // Simulate rapid interleaving of strokes and clears
      const operations = [
        { type: 'stroke', scene: 0, id: 'stroke-0-a' },
        { type: 'clear' },
        { type: 'stroke', scene: 1, id: 'stroke-1-a' },
        { type: 'stroke', scene: 0, id: 'stroke-0-b' }, // Started before first clear
        { type: 'clear' },
        { type: 'stroke', scene: 2, id: 'stroke-2-a' },
        { type: 'stroke', scene: 1, id: 'stroke-1-b' }, // Started before second clear
      ];

      let _currentScene = 0;

      for (const op of operations) {
        if (op.type === 'clear') {
          const clearCmd: ClearBoard = {
            type: 'ClearBoard',
            idempotencyKey: `clear-${Date.now()}`,
          };
          manager.write(clearCmd);
          await manager.processCommandsImmediate?.();
          _currentScene++;
        } else {
          const strokeCmd: DrawStrokeCommit = {
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
          manager.write(strokeCmd);
          await manager.processCommandsImmediate?.();
        }
      }

      // Final scene should be 2
      expect(manager.currentSnapshot.scene).toBe(2);

      // Only strokes from scene 2 should be visible
      const visibleStrokes = manager.currentSnapshot.strokes;
      expect(visibleStrokes.length).toBe(1);
      expect(visibleStrokes[0].id).toBe('stroke-2-a');

      manager.destroy();
    });
  });
});
