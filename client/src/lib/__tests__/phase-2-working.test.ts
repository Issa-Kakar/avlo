import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RoomDocManagerRegistry } from '../room-doc-manager';
import type { DrawStrokeCommit, AddText, ClearBoard } from '@avlo/shared';

describe('Phase 2.4 & 2.5 Working Tests', () => {
  beforeEach(() => {
    // Don't use fake timers - we'll use processCommandsImmediate instead
    RoomDocManagerRegistry.destroyAll();
  });

  afterEach(() => {
    RoomDocManagerRegistry.destroyAll();
  });

  it('should process DrawStrokeCommit command through WriteQueue and CommandBus', async () => {
    const roomId = 'test-room-draw';
    const manager = RoomDocManagerRegistry.get(roomId);

    // Initial state
    expect(manager.currentSnapshot.strokes.length).toBe(0);

    // Create command
    const strokeCmd: DrawStrokeCommit = {
      type: 'DrawStrokeCommit',
      id: 'stroke-1',
      tool: 'pen',
      color: '#000000',
      size: 3,
      opacity: 1,
      points: [0, 0, 10, 10, 20, 20],
      bbox: [0, 0, 20, 20],
      startedAt: Date.now(),
      finishedAt: Date.now(),
      scene: 0,
    };

    // Write command
    manager.write(strokeCmd);

    // Process commands immediately for testing
    await manager.processCommandsImmediate?.();

    // Check snapshot was updated
    const snapshot = manager.currentSnapshot;
    expect(snapshot.strokes.length).toBe(1);
    expect(snapshot.strokes[0].id).toBe('stroke-1');
    expect(snapshot.strokes[0].scene).toBe(0);

    // Clean up
    manager.destroy();
  });

  it('should handle AddText command', async () => {
    const roomId = 'test-room-text';
    const manager = RoomDocManagerRegistry.get(roomId);

    const textCmd: AddText = {
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

    manager.write(textCmd);
    await manager.processCommandsImmediate?.();

    const snapshot = manager.currentSnapshot;
    expect(snapshot.texts.length).toBe(1);
    expect(snapshot.texts[0].id).toBe('text-1');
    expect(snapshot.texts[0].scene).toBe(0);

    manager.destroy();
  });

  it('should handle ClearBoard by incrementing scene', async () => {
    const roomId = 'test-room-clear';
    const manager = RoomDocManagerRegistry.get(roomId);

    // Add initial stroke
    const strokeCmd: DrawStrokeCommit = {
      type: 'DrawStrokeCommit',
      id: 'stroke-before-clear',
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

    expect(manager.currentSnapshot.scene).toBe(0);
    expect(manager.currentSnapshot.strokes.length).toBe(1);

    // Clear board
    const clearCmd: ClearBoard = {
      type: 'ClearBoard',
      idempotencyKey: `clear-${Date.now()}`,
    };

    manager.write(clearCmd);
    await manager.processCommandsImmediate?.();

    // Scene should increment, strokes from scene 0 should be hidden
    expect(manager.currentSnapshot.scene).toBe(1);
    expect(manager.currentSnapshot.strokes.length).toBe(0);

    // Add new stroke in scene 1
    const strokeCmd2: DrawStrokeCommit = {
      type: 'DrawStrokeCommit',
      id: 'stroke-after-clear',
      tool: 'pen',
      color: '#ff0000',
      size: 5,
      opacity: 1,
      points: [50, 50, 60, 60],
      bbox: [50, 50, 60, 60],
      startedAt: Date.now(),
      finishedAt: Date.now(),
      scene: 1,
    };

    manager.write(strokeCmd2);
    await manager.processCommandsImmediate?.();

    expect(manager.currentSnapshot.strokes.length).toBe(1);
    expect(manager.currentSnapshot.strokes[0].id).toBe('stroke-after-clear');
    expect(manager.currentSnapshot.strokes[0].scene).toBe(1);

    manager.destroy();
  });

  it('should enforce mobile view-only restriction', () => {
    // Mock mobile detection
    const originalNavigator = global.navigator;
    const originalWindow = global.window;

    Object.defineProperty(global, 'navigator', {
      value: { userAgent: 'iPhone' },
      writable: true,
      configurable: true,
    });
    Object.defineProperty(global, 'window', {
      value: {
        navigator: { userAgent: 'iPhone' },
        ontouchstart: null,
        innerWidth: 375,
      },
      writable: true,
      configurable: true,
    });

    const roomId = 'test-room-mobile';
    const manager = RoomDocManagerRegistry.get(roomId);

    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const strokeCmd: DrawStrokeCommit = {
      type: 'DrawStrokeCommit',
      id: 'stroke-mobile',
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

    // Command should be rejected
    expect(consoleSpy).toHaveBeenCalledWith(
      '[RoomDocManager] Command rejected:',
      'DrawStrokeCommit',
    );

    consoleSpy.mockRestore();
    manager.destroy();

    // Restore original navigator and window
    Object.defineProperty(global, 'navigator', {
      value: originalNavigator,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(global, 'window', {
      value: originalWindow,
      writable: true,
      configurable: true,
    });
  });

  it('should preserve scene across concurrent ClearBoard (causal consistency)', async () => {
    const roomId = 'test-room-causal';
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

    // Now User A completes their stroke (still using captured scene 0)
    manager.write(strokeA);
    await manager.processCommandsImmediate?.();

    // The stroke should be in scene 0, so it shouldn't be visible in current scene 1
    expect(manager.currentSnapshot.scene).toBe(1);
    expect(manager.currentSnapshot.strokes.length).toBe(0); // Not visible in scene 1

    manager.destroy();
  });

  it('should handle rate limiting for ExtendTTL', async () => {
    const roomId = 'test-room-rate';
    const manager = RoomDocManagerRegistry.get(roomId);

    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // First ExtendTTL should succeed
    manager.extendTTL();
    await manager.processCommandsImmediate?.();

    // Second ExtendTTL immediately after should be rate limited
    manager.extendTTL();

    expect(consoleSpy).toHaveBeenCalledWith('[RoomDocManager] Command rejected:', 'ExtendTTL');

    consoleSpy.mockRestore();
    manager.destroy();
  });
});
