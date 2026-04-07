// Setup file for vitest

// Set NODE_ENV to test for test-only exports
process.env.NODE_ENV = 'test';

// Polyfill IndexedDB for Node.js test environment
import 'fake-indexeddb/auto';

// Polyfill requestAnimationFrame for jsdom environment
// Note: Tests using RoomDocManager should use TestFrameScheduler for control
// This polyfill is just for other components that may use RAF directly
if (typeof window !== 'undefined' && !window.requestAnimationFrame) {
  let rafId = 0;
  const callbacks = new Map<number, (time: number) => void>();

  const raf = (callback: (time: number) => void): number => {
    const id = ++rafId;
    callbacks.set(id, callback);
    // Use setTimeout for tests that don't need precise control
    setTimeout(() => {
      const cb = callbacks.get(id);
      if (cb) {
        callbacks.delete(id);
        cb(performance.now());
      }
    }, 16); // ~60fps
    return id;
  };

  const caf = (id: number): void => {
    callbacks.delete(id);
  };

  window.requestAnimationFrame = raf;
  window.cancelAnimationFrame = caf;

  // Also set on globalThis for the polyfill check
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).requestAnimationFrame = raf;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).cancelAnimationFrame = caf;
}

// Mock navigator for mobile detection
if (typeof navigator === 'undefined') {
  Object.defineProperty(globalThis, 'navigator', {
    value: {
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    },
    writable: true,
    configurable: true,
  });
}

// Mock document.hidden for visibility tests
Object.defineProperty(document, 'hidden', {
  writable: true,
  value: false,
});

Object.defineProperty(document, 'visibilityState', {
  writable: true,
  value: 'visible',
});
