/**
 * Ring buffer implementation for pending updates
 * Provides O(1) push with automatic oldest-drop on overflow
 * Prevents unbounded memory growth from rapid updates
 */
export class UpdateRing<T> {
  private buf: T[];
  private head = 0;
  private count = 0;
  private droppedCount = 0;

  constructor(private cap: number) {
    if (cap <= 0) {
      throw new Error('Ring buffer capacity must be positive');
    }
    this.buf = new Array(cap);
  }

  get length(): number {
    return this.count;
  }

  get capacity(): number {
    return this.cap;
  }

  get dropped(): number {
    return this.droppedCount;
  }

  /**
   * Push an item to the ring buffer
   * @returns true if an item was dropped, false otherwise
   */
  push(x: T): boolean {
    if (this.count < this.cap) {
      // Buffer not full yet, add at the end
      this.buf[(this.head + this.count) % this.cap] = x;
      this.count++;
      return false; // no drop
    }

    // Buffer is full - drop oldest (at head), add new at head position
    this.buf[this.head] = x;
    this.head = (this.head + 1) % this.cap;
    this.droppedCount++;
    return true; // dropped oldest
  }

  /**
   * Convert ring buffer to array in order (oldest to newest)
   */
  toArray(): T[] {
    const out = new Array(this.count);
    for (let i = 0; i < this.count; i++) {
      out[i] = this.buf[(this.head + i) % this.cap];
    }
    return out;
  }

  /**
   * Clear the ring buffer
   */
  clear(): void {
    this.head = 0;
    this.count = 0;
    // Don't reset droppedCount - keep it for metrics
  }

  /**
   * Reset everything including metrics
   * AUDIT NOTE: Creating new array is fine in JS - old array is garbage collected
   * No explicit memory cleanup needed beyond removing references
   */
  reset(): void {
    this.head = 0;
    this.count = 0;
    this.droppedCount = 0;
    // Clear references for GC
    this.buf = new Array(this.cap);
  }

  /**
   * Get the oldest item without removing it
   */
  peekOldest(): T | undefined {
    if (this.count === 0) return undefined;
    return this.buf[this.head];
  }

  /**
   * Get the newest item without removing it
   */
  peekNewest(): T | undefined {
    if (this.count === 0) return undefined;
    const newestIndex = (this.head + this.count - 1) % this.cap;
    return this.buf[newestIndex];
  }
}
