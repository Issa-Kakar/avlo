/**
 * Futex — async wake/sleep over a single i32 "sequence" cell in shared memory.
 *
 * One producer `signal()`s (bump seq + notify); ALL idle consumers parked on the
 * same cell wake — no per-consumer routing. Consumers re-derive their work from
 * the real source (rings / slot table) after waking, so a coalesced burst of
 * signals collapses into a single wake of each idle worker.
 *
 * Lost-wakeup-free when consumers follow the discipline:
 *
 *     const seq = futex.loadSeq();
 *     if (stillHasWork()) continue;   // re-check AFTER snapshotting seq
 *     await futex.wait(seq);          // 'not-equal' short-circuits the gap
 *
 * If the producer bumped seq between the snapshot and the wait, `waitAsync`
 * returns synchronously ('not-equal') and the consumer re-loops instead of
 * sleeping through the wakeup.
 *
 * `Atomics.waitAsync` keeps the event loop live (unlike the blocking
 * `Atomics.wait`, which is illegal on a window agent anyway) so a parked worker
 * still services `postMessage` (ingest / upload / unfurl) and runs
 * `createImageBitmap`. Requires `crossOriginIsolated` (asserted at pool init).
 */
export class Futex {
  constructor(
    private readonly ctrl: Int32Array,
    private readonly seqIndex: number,
  ) {}

  /** Producer: publish a wake. Bump seq (so a racing waiter sees 'not-equal'), then notify. */
  signal(): void {
    Atomics.add(this.ctrl, this.seqIndex, 1);
    Atomics.notify(this.ctrl, this.seqIndex);
  }

  /** Snapshot seq to pass to a subsequent `wait()` (see lost-wakeup discipline above). */
  loadSeq(): number {
    return Atomics.load(this.ctrl, this.seqIndex);
  }

  /** Park until seq moves off `expected`. Resolves immediately if it already has. */
  async wait(expected: number): Promise<void> {
    const r = Atomics.waitAsync(this.ctrl, this.seqIndex, expected);
    if (r.async) await r.value;
  }
}
