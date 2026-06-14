/**
 * Binary Heap Implementation for A* Priority Queue
 *
 * Generic min-heap with manual swap (no destructuring allocation) and `clear()`
 * for reuse across calls. The single consumer (`routing-astar`) instantiates it
 * as `MinHeap<number>` storing node indices, comparator reading parallel typed
 * arrays.
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

  /** Reset the heap for reuse without releasing the backing array. */
  clear(): void {
    this.items.length = 0;
  }

  private bubbleUp(idx: number): void {
    const items = this.items;
    while (idx > 0) {
      const parentIdx = (idx - 1) >> 1;
      if (this.compareFn(items[idx], items[parentIdx]) >= 0) break;
      const tmp = items[idx];
      items[idx] = items[parentIdx];
      items[parentIdx] = tmp;
      idx = parentIdx;
    }
  }

  private bubbleDown(idx: number): void {
    const items = this.items;
    const len = items.length;
    while (true) {
      const leftIdx = 2 * idx + 1;
      const rightIdx = 2 * idx + 2;
      let smallest = idx;

      if (leftIdx < len && this.compareFn(items[leftIdx], items[smallest]) < 0) smallest = leftIdx;
      if (rightIdx < len && this.compareFn(items[rightIdx], items[smallest]) < 0) smallest = rightIdx;

      if (smallest === idx) break;
      const tmp = items[idx];
      items[idx] = items[smallest];
      items[smallest] = tmp;
      idx = smallest;
    }
  }
}
