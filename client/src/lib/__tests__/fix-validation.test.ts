// Simple test to validate the fix
import { describe, it, expect, beforeEach } from 'vitest';
import { RoomDocManagerRegistry } from '../room-doc-manager';

describe('Fix Validation', () => {
  beforeEach(() => {
    RoomDocManagerRegistry.destroyAll();
  });

  it('should not hang on simple command', () => {
    console.log('Creating manager...');
    const manager = RoomDocManagerRegistry.get('test-fix-room');

    console.log('Manager created');

    const strokeCmd = {
      type: 'DrawStrokeCommit' as const,
      id: 'stroke-fix-test',
      tool: 'pen' as const,
      color: '#000000',
      size: 3,
      opacity: 1,
      points: [0, 0, 10, 10],
      bbox: [0, 0, 10, 10] as [number, number, number, number],
      startedAt: Date.now(),
      finishedAt: Date.now(),
      scene: 0,
    };

    console.log('Sending command...');
    manager.write(strokeCmd);

    console.log('Command sent, checking snapshot immediately...');

    // Debug: Let's force a RAF cycle to publish
    if (window && window.requestAnimationFrame) {
      let rafCompleted = false;
      window.requestAnimationFrame(() => {
        rafCompleted = true;
      });
      // Busy wait for RAF (only for testing)
      while (!rafCompleted) {
        // Wait for RAF to complete
      }
    }

    const snapshot = manager.currentSnapshot;
    console.log('Strokes:', snapshot.strokes.length);
    console.log('Scene:', snapshot.scene);

    // Test passes if we get here without hanging
    expect(snapshot).toBeDefined();

    console.log('Destroying manager...');
    manager.destroy();

    console.log('Test completed successfully');
  });
});
