/**
 * Hex ↔ bytes — cross-runtime (client, web worker, server). Lowercase output.
 *
 * Backs the image SAB control plane: the main thread writes a 32-byte SHA-256
 * into shared memory on slot alloc (`hexToBytesInto`, zero-alloc); the decode
 * worker reads it back to a hex `assetId` (`bytesToHex`) to build the cache URL —
 * so the SAB is self-describing and needs no per-asset registration message.
 * Also the single home for the image worker's `sha256Hex` byte→hex conversion.
 *
 * `bytesToHex`/`hexToBytes` delegate to the native `Uint8Array` hex methods.
 * `hexToBytesInto` stays hand-rolled: its whole reason to exist is the zero-alloc
 * decode into a caller-owned buffer, and native `setFromHex` returns a
 * `{ read, written }` result object that would defeat that guarantee.
 */

/** Bytes → lowercase hex string. */
export function bytesToHex(bytes: Uint8Array): string {
  return bytes.toHex();
}

// '0'-'9' = 48-57 → 0-9 ; 'a'-'f' = 97-102 → 10-15. Lowercase hex only.
function nibble(code: number): number {
  return code <= 57 ? code - 48 : code - 87;
}

/** Decode lowercase hex into `out` (writes `hex.length / 2` bytes). Zero-alloc. */
export function hexToBytesInto(hex: string, out: Uint8Array): void {
  const n = hex.length >> 1;
  for (let i = 0; i < n; i++) {
    out[i] = (nibble(hex.charCodeAt(i << 1)) << 4) | nibble(hex.charCodeAt((i << 1) | 1));
  }
}

/** Decode lowercase hex into a fresh `Uint8Array`. */
export function hexToBytes(hex: string): Uint8Array {
  return Uint8Array.fromHex(hex);
}
