/**
 * Poll `fn` (sync or async) until truthy (10 ms cadence). Throws with `what` on timeout.
 * The suites' ONLY waiting primitive — never an arbitrary sleep: a passing test costs
 * one cadence tick, and a failing one names what it was waiting for.
 */
export async function until<T>(fn: () => T | Promise<T>, what = 'condition', timeoutMs = 5000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}
