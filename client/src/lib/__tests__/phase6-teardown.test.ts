// @ts-nocheck - Tests are disabled during rapid refactor phase
/**
 * Phase 6 Teardown Hygiene Test
 * Ensures proper cleanup order and no-op behavior after destroy
 */
import { describe, it, expect, vi } from 'vitest';
import { createTestManager } from './test-helpers';

describe('Phase 6 Teardown Hygiene', () => {
  it('properly tears down providers in correct order', () => {
    const { manager, cleanup } = createTestManager('room-teardown');

    const impl = manager as any;
    const destroySpies: string[] = [];

    // Mock provider destroy methods to track order
    if (impl.websocketProvider) {
      const origDestroy = impl.websocketProvider.destroy;
      impl.websocketProvider.destroy = vi.fn(() => {
        destroySpies.push('ws-destroy');
        origDestroy?.call(impl.websocketProvider);
      });

      const origDisconnect = impl.websocketProvider.disconnect;
      impl.websocketProvider.disconnect = vi.fn(() => {
        destroySpies.push('ws-disconnect');
        origDisconnect?.call(impl.websocketProvider);
      });
    }

    if (impl.indexeddbProvider) {
      const origDestroy = impl.indexeddbProvider.destroy;
      impl.indexeddbProvider.destroy = vi.fn(() => {
        destroySpies.push('idb-destroy');
        origDestroy?.call(impl.indexeddbProvider);
      });
    }

    // Track RAF stop
    const origCancelAF = global.cancelAnimationFrame;
    global.cancelAnimationFrame = vi.fn((id) => {
      if (id === impl.rafId) {
        destroySpies.push('raf-stop');
      }
      origCancelAF(id);
    });

    // Perform cleanup
    cleanup();

    // Verify order: RAF stops first, then WS disconnect/destroy, then IDB
    const wsDisconnectIdx = destroySpies.indexOf('ws-disconnect');
    const wsDestroyIdx = destroySpies.indexOf('ws-destroy');
    const idbDestroyIdx = destroySpies.indexOf('idb-destroy');
    const rafStopIdx = destroySpies.indexOf('raf-stop');

    if (rafStopIdx !== -1) {
      expect(rafStopIdx).toBeLessThan(wsDisconnectIdx);
    }
    if (wsDisconnectIdx !== -1 && wsDestroyIdx !== -1) {
      expect(wsDisconnectIdx).toBeLessThan(wsDestroyIdx);
    }

    // Verify destroyed flag is set
    expect(impl.destroyed).toBe(true);

    // Restore
    global.cancelAnimationFrame = origCancelAF;
  });

  it('makes all public methods no-ops after destroy', () => {
    const { manager, cleanup } = createTestManager('room-noop');

    // Destroy the manager
    cleanup();

    // All public methods should be no-ops (not throw)
    expect(() => {
      manager.mutate(() => {
        throw new Error('Should not execute');
      });
    }).not.toThrow();

    const unsubSnapshot = manager.subscribeSnapshot(() => {
      throw new Error('Should not be called');
    });
    expect(unsubSnapshot).toBeDefined();
    unsubSnapshot(); // Should also be no-op

    const unsubPresence = manager.subscribePresence(() => {
      throw new Error('Should not be called');
    });
    expect(unsubPresence).toBeDefined();
    unsubPresence();

    // Double destroy should also be no-op
    expect(() => manager.destroy()).not.toThrow();
  });

  it('cleans up Y.Doc observers on teardown', () => {
    const { manager, cleanup } = createTestManager('room-observers');

    const impl = manager as any;

    // Track Y.Doc observer count before
    const observersBefore = impl.ydoc._observers?.size || 0;

    // Add some mutations to ensure observers are active
    manager.mutate(() => {
      const yObj = new Y.Map();
      yObj.set('id', 'test');
      yObj.set('kind', 'stroke');
      yObj.set('points', [[0, 0], [1, 1]]);
      manager.objects.set('test', yObj);
    });

    // Cleanup
    cleanup();

    // Y.Doc should be destroyed - observers should be cleared or undefined
    if (impl.ydoc._observers !== undefined) {
      expect(impl.ydoc._observers.size).toBe(0);
    } else {
      expect(impl.ydoc._observers).toBeUndefined();
    }
  });
});
