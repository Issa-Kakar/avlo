import { vi } from 'vitest';
import type { RoomId, Snapshot, PresenceView, RoomStats } from '@avlo/shared';
import { 
  RoomDocManagerRegistry, 
  createRoomDocManagerRegistry,
  RoomDocManager,
  __testonly
} from '../room-doc-manager';
import { TestClock, TestFrameScheduler } from '../timing-abstractions';

/**
 * Test helper for creating an isolated RoomDocManager with test dependencies
 * Each test gets its own registry instance to ensure complete isolation
 */
export function createTestManager(roomId: RoomId = 'test-room') {
  // Create test dependencies
  const clock = new TestClock();
  const frames = new TestFrameScheduler();
  
  // Create a fresh registry for this test
  const registry = createRoomDocManagerRegistry();
  registry.setDefaultOptions({ clock, frames });
  
  // Create an isolated manager through the registry
  const manager = registry.createIsolated(roomId, { clock, frames });
  
  return { 
    manager, 
    clock, 
    frames, 
    registry,
    // Helper to clean up everything
    cleanup: () => {
      manager.destroy();
      registry.reset();
    }
  };
}

/**
 * Test helper for creating a manager through the registry (singleton per room)
 * Useful for testing registry behavior
 */
export function createTestRegistry() {
  const clock = new TestClock();
  const frames = new TestFrameScheduler();
  const registry = createRoomDocManagerRegistry();
  
  registry.setDefaultOptions({ clock, frames });
  
  return { 
    registry, 
    clock, 
    frames,
    cleanup: () => registry.reset()
  };
}

/**
 * Helper to observe Y.Doc events in tests
 * Returns a cleanup function to remove observers
 */
export function observeDocEvents(
  manager: RoomDocManager,
  onEvent: (event: string, data?: unknown) => void
): () => void {
  if (!__testonly?.attachDocObserver) {
    throw new Error('Test-only exports not available. Ensure NODE_ENV=test');
  }
  
  return __testonly.attachDocObserver(manager, onEvent);
}

/**
 * Helper to wait for next snapshot publication
 */
export async function waitForSnapshot(
  manager: RoomDocManager,
  frames: TestFrameScheduler,
  clock: TestClock
): Promise<Snapshot> {
  return new Promise((resolve) => {
    const unsub = manager.subscribeSnapshot((snap) => {
      unsub();
      resolve(snap);
    });
    frames.advanceFrame(clock.now());
  });
}

/**
 * Helper to collect multiple snapshots over time
 */
export function collectSnapshots(
  manager: RoomDocManager,
  frames: TestFrameScheduler,
  clock: TestClock,
  count: number
): Snapshot[] {
  const snapshots: Snapshot[] = [];
  const unsub = manager.subscribeSnapshot((snap) => {
    snapshots.push(snap);
  });
  
  // Advance frames to trigger publications
  for (let i = 0; i < count; i++) {
    frames.advanceFrame(clock.now());
  }
  
  unsub();
  return snapshots;
}

/**
 * Helper to test presence updates with timing control
 */
export function collectPresenceUpdates(
  manager: RoomDocManager,
  clock: TestClock,
  duration: number,
  interval: number = 10
): PresenceView[] {
  const updates: PresenceView[] = [];
  const unsub = manager.subscribePresence((p) => {
    updates.push(p);
  });
  
  // Advance time in small intervals
  const steps = Math.floor(duration / interval);
  for (let i = 0; i < steps; i++) {
    clock.advance(interval);
  }
  
  unsub();
  return updates;
}

/**
 * Helper to simulate persist_ack message
 */
export function simulatePersistAck(
  manager: RoomDocManager,
  sizeBytes: number,
  timestamp: string = new Date().toISOString()
) {
  // Access the handlePersistAck method if it exists
  const impl = manager as any;
  if (impl.handlePersistAck) {
    impl.handlePersistAck({ sizeBytes, timestamp });
  }
}

/**
 * Helper to track subscription callbacks
 */
export class SubscriptionTracker<T> {
  private values: T[] = [];
  private callback = vi.fn((value: T) => {
    this.values.push(value);
  });
  
  get fn() { return this.callback; }
  get callCount() { return this.callback.mock.calls.length; }
  get lastValue() { return this.values[this.values.length - 1]; }
  get allValues() { return [...this.values]; }
  
  clear() {
    this.values = [];
    this.callback.mockClear();
  }
}

/**
 * Helper to verify no memory leaks after cleanup
 */
export function verifyCleanup(testContext: ReturnType<typeof createTestManager>) {
  const { manager, registry, cleanup } = testContext;
  
  // Create subscriptions
  const snapUnsub = manager.subscribeSnapshot(() => {});
  const presUnsub = manager.subscribePresence(() => {});
  const statsUnsub = manager.subscribeRoomStats(() => {});
  
  // Clean up subscriptions
  snapUnsub();
  presUnsub();
  statsUnsub();
  
  // Clean up manager and registry
  cleanup();
  
  // Verify registry is empty
  return registry.size() === 0;
}

/**
 * Mock navigator for mobile testing
 */
export function mockNavigator(userAgent: string) {
  Object.defineProperty(window, 'navigator', {
    value: { userAgent },
    writable: true,
    configurable: true
  });
}

/**
 * Reset navigator to default
 */
export function resetNavigator() {
  // @ts-expect-error - resetting navigator
  delete window.navigator;
}

// Common user agents for testing
export const USER_AGENTS = {
  DESKTOP: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  MOBILE_IOS: 'Mozilla/5.0 (iPhone; CPU iPhone OS 14_0 like Mac OS X) AppleWebKit/605.1.15',
  MOBILE_ANDROID: 'Mozilla/5.0 (Linux; Android 11; Pixel 5) AppleWebKit/537.36',
  TABLET_IPAD: 'Mozilla/5.0 (iPad; CPU OS 14_0 like Mac OS X) AppleWebKit/605.1.15'
};