import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RoomDocManagerRegistry } from '../room-doc-manager';
import { DrawStrokeCommit, AddText, ClearBoard, EraseObjects } from '@avlo/shared';

/**
 * WARNING: These tests use processCommandsImmediate() which BYPASSES the actual
 * command processing timing and batch windows. They don't test real backpressure,
 * rate limiting under actual timing conditions, or the CommandBus batch processing.
 * 
 * See phase-2.5-distributed-systems.test.ts for proper distributed systems testing.
 * 
 * TODO: Remove or refactor to test actual async command processing.
 */
describe.skip('Phase 2.5 Integration (FALSE POSITIVES - SKIPPED)', () => {
  let originalNavigator: any;
  let originalWindow: any;

  beforeEach(() => {
    RoomDocManagerRegistry.destroyAll();
    // Save original navigator and window
    originalNavigator = global.navigator;
    originalWindow = global.window;
  });

  afterEach(() => {
    RoomDocManagerRegistry.destroyAll();
    // Restore original navigator and window
    global.navigator = originalNavigator;
    if (originalWindow) {
      Object.defineProperty(global, 'window', {
        value: originalWindow,
        writable: true,
      });
    }
    vi.clearAllMocks();
  });

  it.skip('should process commands through WriteQueue and CommandBus (FALSE POSITIVE)', async () => {
    const roomId = 'test-room-2.5';
    const manager = RoomDocManagerRegistry.get(roomId);

    // Subscribe to snapshot updates
    const unsubscribe = manager.subscribeSnapshot(() => {
      // Snapshot updated
    });

    // Send a DrawStrokeCommit command
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
      scene: 0, // CRITICAL: Scene captured at pointer-down
    };

    manager.write(strokeCmd);

    // Process command immediately for testing
    await manager.processCommandsImmediate?.();

    // Check that snapshot was updated
    const snapshot = manager.currentSnapshot;
    expect(snapshot.strokes.length).toBe(1);
    expect(snapshot.strokes[0].id).toBe('stroke-1');
    expect(snapshot.strokes[0].scene).toBe(0); // Verify scene was preserved

    // Send AddText command
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
      scene: 0, // CRITICAL: Scene captured at placement start
    };

    manager.write(textCmd);

    // Process command immediately for testing
    await manager.processCommandsImmediate?.();

    // Check text was added
    const snapshot2 = manager.currentSnapshot;
    expect(snapshot2.texts.length).toBe(1);
    expect(snapshot2.texts[0].id).toBe('text-1');
    expect(snapshot2.texts[0].scene).toBe(0); // Verify scene was preserved

    // Clean up
    unsubscribe();
    manager.destroy();
  });

  it('should handle ClearBoard correctly', async () => {
    const roomId = 'test-room-clear';
    const manager = RoomDocManagerRegistry.get(roomId);

    // Add initial stroke
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

    // Verify stroke is in scene 0
    expect(manager.currentSnapshot.scene).toBe(0);
    expect(manager.currentSnapshot.strokes.length).toBe(1);

    // Clear board (increments scene)
    const clearCmd: ClearBoard = {
      type: 'ClearBoard',
      idempotencyKey: `clear-${Date.now()}`,
    };

    manager.write(clearCmd);
    await manager.processCommandsImmediate?.();

    // Verify scene incremented and strokes hidden
    expect(manager.currentSnapshot.scene).toBe(1);
    expect(manager.currentSnapshot.strokes.length).toBe(0); // No strokes visible in scene 1

    // Add new stroke in scene 1
    const strokeCmd2: DrawStrokeCommit = {
      type: 'DrawStrokeCommit',
      id: 'stroke-2',
      tool: 'pen',
      color: '#ff0000',
      size: 5,
      opacity: 1,
      points: [50, 50, 60, 60],
      bbox: [50, 50, 60, 60],
      startedAt: Date.now(),
      finishedAt: Date.now(),
      scene: 1, // New stroke in scene 1
    };

    manager.write(strokeCmd2);
    await manager.processCommandsImmediate?.();

    // Verify only scene 1 stroke is visible
    expect(manager.currentSnapshot.strokes.length).toBe(1);
    expect(manager.currentSnapshot.strokes[0].id).toBe('stroke-2');
    expect(manager.currentSnapshot.strokes[0].scene).toBe(1);

    manager.destroy();
  });

  it('should handle EraseObjects correctly', async () => {
    const roomId = 'test-room-erase';
    const manager = RoomDocManagerRegistry.get(roomId);

    // Add multiple objects
    const strokeCmd1: DrawStrokeCommit = {
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

    const strokeCmd2: DrawStrokeCommit = {
      type: 'DrawStrokeCommit',
      id: 'stroke-2',
      tool: 'pen',
      color: '#ff0000',
      size: 3,
      opacity: 1,
      points: [20, 20, 30, 30],
      bbox: [20, 20, 30, 30],
      startedAt: Date.now(),
      finishedAt: Date.now(),
      scene: 0,
    };

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

    manager.write(strokeCmd1);
    await manager.processCommandsImmediate?.();
    manager.write(strokeCmd2);
    await manager.processCommandsImmediate?.();
    manager.write(textCmd);
    await manager.processCommandsImmediate?.();

    // Verify all objects exist
    expect(manager.currentSnapshot.strokes.length).toBe(2);
    expect(manager.currentSnapshot.texts.length).toBe(1);

    // Erase stroke-1 and text-1
    const eraseCmd: EraseObjects = {
      type: 'EraseObjects',
      ids: ['stroke-1', 'text-1'],
      idempotencyKey: `erase-${Date.now()}`,
    };

    manager.write(eraseCmd);
    await manager.processCommandsImmediate?.();

    // Verify objects were erased
    expect(manager.currentSnapshot.strokes.length).toBe(1);
    expect(manager.currentSnapshot.strokes[0].id).toBe('stroke-2');
    expect(manager.currentSnapshot.texts.length).toBe(0);

    manager.destroy();
  });

  it('should reject commands on mobile', () => {
    // Mock mobile detection
    Object.defineProperty(global, 'navigator', {
      value: { userAgent: 'iPhone' },
      writable: true,
    });
    Object.defineProperty(global, 'window', {
      value: {
        navigator: { userAgent: 'iPhone' },
        ontouchstart: null,
        innerWidth: 375,
      },
      writable: true,
    });

    const roomId = 'test-room-mobile';
    const manager = RoomDocManagerRegistry.get(roomId);

    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

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

    // Verify command was rejected
    expect(consoleSpy).toHaveBeenCalledWith(
      '[WriteQueue] Validation failed:',
      expect.objectContaining({
        valid: false,
        reason: 'view_only',
        details: 'Mobile devices are view-only',
      }),
    );

    consoleSpy.mockRestore();
    manager.destroy();
    // Navigator restoration handled in afterEach
  });

  it('should handle scene capture for causal consistency', async () => {
    const roomId = 'test-room-scene';
    const manager = RoomDocManagerRegistry.get(roomId);

    // User A starts drawing in Scene 0
    const strokeCmdA: DrawStrokeCommit = {
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
      idempotencyKey: 'clear-1',
    };

    // Process clear first
    manager.write(clearCmd);
    await manager.processCommandsImmediate?.();

    // Verify scene incremented
    expect(manager.currentSnapshot.scene).toBe(1);

    // Now User A completes their stroke (still using captured scene 0)
    manager.write(strokeCmdA);
    await manager.processCommandsImmediate?.();

    // The stroke should be in scene 0, so it shouldn't be visible in current scene 1
    expect(manager.currentSnapshot.scene).toBe(1);
    expect(manager.currentSnapshot.strokes.length).toBe(0); // Not visible in scene 1

    // If we could go back to scene 0, the stroke would be there
    // This is the critical distributed systems invariant:
    // Objects remain in the scene where they were created

    manager.destroy();
  });

  it('should enforce rate limiting', async () => {
    const roomId = 'test-room-rate';
    const manager = RoomDocManagerRegistry.get(roomId);

    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // First ExtendTTL should succeed
    manager.extendTTL();

    // Second ExtendTTL immediately after should be rate limited
    manager.extendTTL();

    // The WriteQueue logs the validation failure internally,
    // and RoomDocManager logs the rejection
    expect(consoleSpy).toHaveBeenCalled();

    // Check that at least one of the calls was about rate limiting
    const calls = consoleSpy.mock.calls;
    const hasRateLimitWarning = calls.some(
      (call) =>
        (call[0] === '[WriteQueue] Validation failed:' && call[1]?.reason === 'rate_limited') ||
        (call[0] === '[RoomDocManager] Command rejected:' && call[1] === 'ExtendTTL'),
    );
    expect(hasRateLimitWarning).toBe(true);

    consoleSpy.mockRestore();
    manager.destroy();
  });
});
