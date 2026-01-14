/**
 * Binary Heap Implementation for A* Priority Queue
 *
 * Generic min-heap that can be used with any comparable type.
 * Provides O(log n) push/pop operations.
 *
 * @module lib/connectors/binary-heap
 */

/**
 * Min-heap priority queue.
 *
 * @template T - Element type
 */
export class MinHeap<T> {
  private items: T[] = [];

  /**
   * Create a new min-heap.
   *
   * @param compareFn - Comparison function (returns negative if a < b)
   */
  constructor(private compareFn: (a: T, b: T) => number) {}

  /**
   * Insert an item into the heap.
   *
   * @param item - Item to insert
   */
  push(item: T): void {
    this.items.push(item);
    this.bubbleUp(this.items.length - 1);
  }

  /**
   * Remove and return the minimum item.
   *
   * @returns Minimum item or undefined if empty
   */
  pop(): T | undefined {
    if (this.items.length === 0) return undefined;
    const result = this.items[0];
    const last = this.items.pop()!;
    if (this.items.length > 0) {
      this.items[0] = last;
      this.bubbleDown(0);
    }
    return result;
  }

  /**
   * Check if the heap is empty.
   */
  isEmpty(): boolean {
    return this.items.length === 0;
  }

  private bubbleUp(idx: number): void {
    while (idx > 0) {
      const parentIdx = Math.floor((idx - 1) / 2);
      if (this.compareFn(this.items[idx], this.items[parentIdx]) >= 0) break;
      [this.items[idx], this.items[parentIdx]] = [this.items[parentIdx], this.items[idx]];
      idx = parentIdx;
    }
  }

  private bubbleDown(idx: number): void {
    while (true) {
      const leftIdx = 2 * idx + 1;
      const rightIdx = 2 * idx + 2;
      let smallest = idx;

      if (
        leftIdx < this.items.length &&
        this.compareFn(this.items[leftIdx], this.items[smallest]) < 0
      ) {
        smallest = leftIdx;
      }
      if (
        rightIdx < this.items.length &&
        this.compareFn(this.items[rightIdx], this.items[smallest]) < 0
      ) {
        smallest = rightIdx;
      }

      if (smallest === idx) break;
      [this.items[idx], this.items[smallest]] = [this.items[smallest], this.items[idx]];
      idx = smallest;
    }
  }
}
