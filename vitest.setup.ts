// Setup file for vitest

// Polyfill IndexedDB for Node.js test environment
import 'fake-indexeddb/auto';

// Mock requestAnimationFrame for jsdom environment
// Ensure it's available on both window and globalThis
if (typeof window !== 'undefined') {
  let rafId = 0;
  const callbacks = new Map<number, (time: number) => void>();

  const raf = (callback: (time: number) => void): number => {
    const id = ++rafId;
    callbacks.set(id, callback);
    // Execute immediately in test environment for faster tests
    Promise.resolve().then(() => {
      const cb = callbacks.get(id);
      if (cb) {
        callbacks.delete(id);
        cb(performance.now());
      }
    });
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

// Mock document.hidden for visibility tests
Object.defineProperty(document, 'hidden', {
  writable: true,
  value: false,
});

Object.defineProperty(document, 'visibilityState', {
  writable: true,
  value: 'visible',
});
