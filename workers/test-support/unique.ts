/**
 * Uniqueness allocators. Test files run in PARALLEL workerd runners against one shared
 * Miniflare, so anything that lands in a shared binding (edge cache, R2, KV) needs ids
 * unique across files, not just within one — a per-file counter alone collides when two
 * files start from the same seed. The time suffix covers the cross-file axis.
 */

let seq = 0;

/** Unique public-looking URL (`.example` TLD keeps SSRF guards quiet). */
export const uniqueUrl = (path = '/page'): string => `https://site-${++seq}-${Date.now().toString(36)}.example${path}`;
