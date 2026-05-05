/**
 * Run a teardown function on a possibly-null resource and return null so the
 * caller can reassign in one line: `this.x = dispose(this.x, (v) => v.destroy())`.
 *
 * Errors during teardown are swallowed — call sites already chain multiple
 * teardowns and a throw mid-chain leaks the rest.
 */
export function dispose<T>(value: T | null, fn: (v: T) => void): null {
  if (value !== null) {
    try {
      fn(value);
    } catch {
      /* swallow during teardown */
    }
  }
  return null;
}
