/**
 * Timing abstractions for deterministic testing
 * Allows injection of test implementations to control time and frame scheduling
 */

// Type for frame callbacks (compatible with requestAnimationFrame)
type FrameCallback = (time: number) => void;

/**
 * Clock interface for monotonic time source
 */
export interface Clock {
  now(): number; // Returns monotonic time in milliseconds
}

/**
 * Frame scheduler interface for requestAnimationFrame
 */
export interface FrameScheduler {
  request(callback: FrameCallback): number;
  cancel(id: number): void;
}

/**
 * Browser implementation using performance.now()
 */
export class BrowserClock implements Clock {
  now(): number {
    return performance.now();
  }
}

/**
 * Browser implementation using native requestAnimationFrame
 */
export class BrowserFrameScheduler implements FrameScheduler {
  request(callback: FrameCallback): number {
    return requestAnimationFrame(callback);
  }

  cancel(id: number): void {
    cancelAnimationFrame(id);
  }
}

/**
 * Test clock implementation with manual time control
 */
export class TestClock implements Clock {
  private t = 0;

  now(): number {
    return this.t;
  }

  advance(ms: number): void {
    if (ms < 0) {
      throw new Error('Cannot advance time backwards');
    }
    this.t += ms;
  }

  set(ms: number): void {
    if (ms < 0) {
      throw new Error('Time cannot be negative');
    }
    this.t = ms;
  }

  reset(): void {
    this.t = 0;
  }
}

/**
 * Test frame scheduler with manual frame advancement
 */
export class TestFrameScheduler implements FrameScheduler {
  private queue: Array<{ id: number; callback: FrameCallback }> = [];
  private nextId = 1;
  private cancelledIds = new Set<number>();

  request(callback: FrameCallback): number {
    const id = this.nextId++;
    this.queue.push({ id, callback });
    return id;
  }

  cancel(id: number): void {
    this.cancelledIds.add(id);
    // Remove from queue if present
    const index = this.queue.findIndex((item) => item.id === id);
    if (index !== -1) {
      this.queue.splice(index, 1);
    }
  }

  /**
   * Advance one frame, executing the oldest pending callback
   */
  advanceFrame(time: number = 0): void {
    if (this.queue.length === 0) return;

    const item = this.queue.shift();
    if (!item) return;

    // Check if it was cancelled
    if (this.cancelledIds.has(item.id)) {
      this.cancelledIds.delete(item.id);
      return;
    }

    // Execute callback with provided time
    item.callback(time);
  }

  /**
   * Advance all pending frames
   */
  advanceAllFrames(time: number = 0): void {
    while (this.queue.length > 0) {
      this.advanceFrame(time);
    }
  }

  /**
   * Get number of pending frames
   */
  get pending(): number {
    return this.queue.length;
  }

  /**
   * Get queue length (alias for pending)
   */
  getQueueLength(): number {
    return this.queue.length;
  }

  /**
   * Clear all pending frames
   */
  clear(): void {
    this.queue = [];
    this.cancelledIds.clear();
    this.nextId = 1;
  }

  /**
   * Flush all pending frames (alias for advanceAllFrames)
   * Added for test compatibility
   */
  flush(time: number = 0): void {
    this.advanceAllFrames(time);
  }
}

/**
 * Options for RoomDocManager timing configuration
 */
export interface TimingOptions {
  clock?: Clock;
  frames?: FrameScheduler;
  batchWindowMs?: number;
  pendingCap?: number;
}

/**
 * Create default timing options for browser environment
 */
export function createBrowserTimingOptions(): Required<TimingOptions> {
  return {
    clock: new BrowserClock(),
    frames: new BrowserFrameScheduler(),
    batchWindowMs: 20,
    pendingCap: 100,
  };
}

/**
 * Create test timing options for deterministic tests
 */
export function createTestTimingOptions(): Required<TimingOptions> & {
  clock: TestClock;
  frames: TestFrameScheduler;
} {
  return {
    clock: new TestClock(),
    frames: new TestFrameScheduler(),
    batchWindowMs: 20,
    pendingCap: 100,
  };
}