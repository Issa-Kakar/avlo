/**
 * Phase 6 Gate Tests - Minimal, surgical tests for IndexedDB and WebSocket gates
 * Tests the 2s IDB timeout and gate opening behavior
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createTestManager } from './test-helpers';

describe('Phase 6 Gates - Minimal Tests', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  describe('IndexedDB Gate (G_IDB_READY)', () => {
    it('opens G_IDB_READY after 2s timeout even without IDB', () => {
      const { manager, cleanup } = createTestManager('room-idb-timeout');

      // Access private implementation for surgical testing
      const impl = manager as any;

      // Initially gate should be closed
      expect(impl.gates.G_IDB_READY).toBe(false);

      // Advance time by 1.9s - gate should still be closed
      vi.advanceTimersByTime(1900);
      expect(impl.gates.G_IDB_READY).toBe(false);

      // Advance to 2s - gate should open
      vi.advanceTimersByTime(100);
      expect(impl.gates.G_IDB_READY).toBe(true);

      cleanup();
    });

    it('opens G_IDB_READY immediately on IDB sync', () => {
      const { manager, cleanup } = createTestManager('room-idb-sync');

      const impl = manager as any;

      // Initially closed
      expect(impl.gates.G_IDB_READY).toBe(false);

      // Simulate IDB provider sync
      if (impl.indexeddbProvider?.whenSynced) {
        // Trigger the promise resolution
        impl.markIdbReady();
        expect(impl.gates.G_IDB_READY).toBe(true);
      }

      cleanup();
    });
  });

  describe('WebSocket Gates', () => {
    it('tracks G_WS_CONNECTED and G_WS_SYNCED states', () => {
      const { manager, cleanup } = createTestManager('room-ws-gates');

      const impl = manager as any;

      // Initially both gates closed
      expect(impl.gates.G_WS_CONNECTED).toBe(false);
      expect(impl.gates.G_WS_SYNCED).toBe(false);

      // Simulate WebSocket connection
      if (impl.websocketProvider) {
        impl.websocketProvider.emit('status', { status: 'connected' });
        expect(impl.gates.G_WS_CONNECTED).toBe(true);
        expect(impl.gates.G_WS_SYNCED).toBe(false);

        // Simulate sync completion
        impl.websocketProvider.emit('sync', { synced: true });
        expect(impl.gates.G_WS_SYNCED).toBe(true);
      }

      cleanup();
    });
  });
});
