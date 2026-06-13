/**
 * SpmcRing — single-producer / multi-consumer lock-free ring of fixed-width
 * integer records over a shared `Int32Array`.
 *
 *   Producer (exactly one thread — the main thread): `tryPush` writes the record
 *     body, then a single `Atomics.store` advances `tail` to publish it.
 *   Consumers (N worker threads): `tryPop` claims the next index with a
 *     `compareExchange` on `head`, then reads the record body.
 *
 * `head` / `tail` are MONOTONIC i32 cursors held in the shared header (never
 * wrapped); `& mask` maps them to storage, so `capacity` MUST be a power of two.
 * Live count = `tail - head` ≤ capacity.
 *
 * Single-producer is what keeps this lock-free yet correct: only `head` is
 * contended (CAS between consumers); `tail` has one writer. For a consumer to
 * read a record the producer is overwriting, the producer would have to lap it by
 * a full `capacity` between the consumer's CAS and its read — impossible at these
 * sizes and rates — and even then the SLOT TABLE, not the ring, is the source of
 * truth, so a torn `[slot, gen]` degrades to "re-check that slot, find nothing to
 * do" rather than corruption.
 */
export class SpmcRing {
  private readonly mask: number;

  constructor(
    private readonly ctrl: Int32Array,
    private readonly headIndex: number,
    private readonly tailIndex: number,
    private readonly recordsOffset: number,
    private readonly capacity: number,
    private readonly recWords: number,
  ) {
    this.mask = capacity - 1;
  }

  /** True when no records are queued. Non-claiming — for the futex empty re-check. */
  isEmpty(): boolean {
    return Atomics.load(this.ctrl, this.headIndex) >= Atomics.load(this.ctrl, this.tailIndex);
  }

  /**
   * Producer-only. Append `rec[0..recWords)`. Returns false if full — the caller
   * retries next frame, the slot table still holding the desired state.
   */
  tryPush(rec: ArrayLike<number>): boolean {
    const tail = Atomics.load(this.ctrl, this.tailIndex);
    const head = Atomics.load(this.ctrl, this.headIndex);
    if (tail - head >= this.capacity) return false; // full
    const base = this.recordsOffset + (tail & this.mask) * this.recWords;
    for (let i = 0; i < this.recWords; i++) Atomics.store(this.ctrl, base + i, rec[i]);
    Atomics.store(this.ctrl, this.tailIndex, tail + 1); // publish (release)
    return true;
  }

  /** Consumer. Claims and copies the next record into `out`. Returns false if empty. */
  tryPop(out: Int32Array): boolean {
    for (;;) {
      const head = Atomics.load(this.ctrl, this.headIndex);
      const tail = Atomics.load(this.ctrl, this.tailIndex);
      if (head >= tail) return false; // empty
      if (Atomics.compareExchange(this.ctrl, this.headIndex, head, head + 1) !== head) continue; // lost CAS — retry
      const base = this.recordsOffset + (head & this.mask) * this.recWords;
      for (let i = 0; i < this.recWords; i++) out[i] = Atomics.load(this.ctrl, base + i);
      return true;
    }
  }

  /** Producer-only teardown: drop all queued records (head := tail). */
  reset(): void {
    Atomics.store(this.ctrl, this.headIndex, Atomics.load(this.ctrl, this.tailIndex));
  }
}
