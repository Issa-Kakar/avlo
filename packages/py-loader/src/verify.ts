// Dependency-free verification predicates — kept OUT of index.ts so
// lock-free consumers (py-executor via the `./verify` subpath) get the exact
// shipped code without index's JSON lock import (Node ESM demands import
// attributes there; bundlers don't). Other consumers use the index re-exports.

/** Lowercase-hex sha256 of a buffer (WebCrypto — window, workers, SW, Node). */
export async function sha256Hex(bytes: BufferSource): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Do these bytes match a lock entry? Size first (free), then the sha —
 * the single verification predicate for every lock-gated consumer
 * (supervisor tar/glue checks, SW core-artifact route, the web
 * py-integration suite). */
export async function matchesLockEntry(bytes: ArrayBuffer, entry: { readonly sha256: string; readonly size: number }): Promise<boolean> {
  return bytes.byteLength === entry.size && (await sha256Hex(bytes)) === entry.sha256;
}
