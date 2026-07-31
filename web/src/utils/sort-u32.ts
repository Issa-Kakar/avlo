/**
 * In-place ascending sort of a `Uint32Array` sub-range — the comparator-free
 * ordering primitive for hot paths (renderer z-sort, picker key sort). Native
 * `TypedArray#sort` would need a per-frame `.subarray()` view (allocation);
 * this takes `(arr, from, to)` directly.
 *
 * Iterative quicksort: median-of-3 pivot + insertion-sort cutoff (≤16) +
 * smaller-partition-first (bounds the explicit stack at one pair per halving).
 * Median-of-3 is load-bearing, not stylistic — the renderer feeds
 * frame-coherent, near-sorted input every frame, the classic O(n²) trap for a
 * naive-pivot quicksort (500 near-sorted candidates at O(n²) ≈ 125k compares
 * per frame).
 *
 * U32 reads surface as non-negative JS numbers, so plain `<`/`>` covers the
 * full range including keys ≥ 2^31. No comparator, no per-call allocation.
 */

const INSERTION_CUTOFF = 16;

// Pending-partition stack: 2 ints per entry. Smaller-partition-first caps the
// depth at log2(n) pairs — 32 pairs covers any addressable length.
const _stack = new Int32Array(64);

/** Sort `arr[from..to)` ascending, in place. Elements outside the range are untouched. */
export function sortU32Range(arr: Uint32Array, from: number, to: number): void {
  let top = 0;
  let lo = from;
  let hi = to - 1;

  for (;;) {
    if (hi - lo < INSERTION_CUTOFF) {
      for (let i = lo + 1; i <= hi; i++) {
        const v = arr[i];
        let j = i - 1;
        while (j >= lo && arr[j] > v) {
          arr[j + 1] = arr[j];
          j--;
        }
        arr[j + 1] = v;
      }
      if (top === 0) return;
      hi = _stack[--top];
      lo = _stack[--top];
      continue;
    }

    // Median-of-3: order arr[lo] ≤ arr[mid] ≤ arr[hi], then park the pivot at
    // hi-1 (Sedgewick). arr[lo] bounds the j-scan, arr[hi-1] bounds the i-scan
    // — both inner loops run unguarded.
    const mid = (lo + hi) >>> 1;
    let a = arr[lo];
    let b = arr[mid];
    let c = arr[hi];
    if (a > b) {
      const t = a;
      a = b;
      b = t;
    }
    if (b > c) {
      const t = b;
      b = c;
      c = t;
      if (a > b) {
        const t2 = a;
        a = b;
        b = t2;
      }
    }
    arr[lo] = a;
    arr[hi] = c;
    arr[mid] = arr[hi - 1];
    arr[hi - 1] = b;
    const pivot = b;

    let i = lo;
    let j = hi - 1;
    for (;;) {
      while (arr[++i] < pivot) {}
      while (arr[--j] > pivot) {}
      if (i >= j) break;
      const t = arr[i];
      arr[i] = arr[j];
      arr[j] = t;
    }
    arr[hi - 1] = arr[i];
    arr[i] = pivot;

    // Loop on the smaller partition, stack the larger.
    if (i - lo < hi - i) {
      _stack[top++] = i + 1;
      _stack[top++] = hi;
      hi = i - 1;
    } else {
      _stack[top++] = lo;
      _stack[top++] = i - 1;
      lo = i + 1;
    }
  }
}
