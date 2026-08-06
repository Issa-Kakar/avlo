/**
 * Minimal VALID image byte builders — real magic bytes + dimensions parseable by
 * `@avlo/shared`'s `validateImage`/`parseImageDimensions`. Dependency-free (shared by
 * the unfurl and images suites, which sit in different pnpm dependency graphs).
 */

/** GIF89a: magic + LE dims at bytes 6-9. */
export function gifBytes(width = 4, height = 3): Uint8Array {
  const b = new Uint8Array(16);
  b.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]); // GIF89a
  b[6] = width & 0xff;
  b[7] = width >> 8;
  b[8] = height & 0xff;
  b[9] = height >> 8;
  return b;
}

/** PNG: signature + IHDR with big-endian dims at 16/20. */
export function pngBytes(width = 8, height = 6): Uint8Array {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const dv = new DataView(b.buffer);
  dv.setUint32(8, 13); // IHDR length
  b.set([0x49, 0x48, 0x44, 0x52], 12); // 'IHDR'
  dv.setUint32(16, width);
  dv.setUint32(20, height);
  return b;
}

/** JPEG: SOI + APP0 stub — validateImage needs only FF D8 FF (+ ≥12 bytes). */
export function jpegBytes(): Uint8Array {
  const b = new Uint8Array(16);
  b.set([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
  return b;
}

/** WebP: RIFF….WEBP container header. */
export function webpBytes(): Uint8Array {
  const b = new Uint8Array(16);
  b.set([0x52, 0x49, 0x46, 0x46, 0x08, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]); // RIFF + size + WEBP
  return b;
}

/** ICO: reserved=0, type=1, one 16×16 entry. */
export function icoBytes(width = 16, height = 16): Uint8Array {
  const b = new Uint8Array(22);
  b.set([0x00, 0x00, 0x01, 0x00, 0x01, 0x00]); // header + count 1
  b[6] = width === 256 ? 0 : width;
  b[7] = height === 256 ? 0 : height;
  return b;
}

export const svgBytes = (): Uint8Array => new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>');

/*
 * Uniqueness allocators. Content-addressing makes byte uniqueness the entire isolation
 * story: distinct bytes ⇒ distinct sha256 ⇒ distinct R2/edge-cache keys ⇒ no cross-test
 * collisions — no hand-picked per-test dimensions to keep globally unique by comment.
 * Two axes (mirrors `unique.ts`): a monotonic counter (the width) separates calls within
 * a file; a per-module random tag stamped into header bytes the validators never read
 * (GIF 10-15, PNG 24-29 — `validateImage`/`parseImageDimensions` stop at magic + dims)
 * separates PARALLEL test files, whose fresh module registries restart the counter from
 * the same seed. Tag bytes are forced odd (never zero), so allocator output can never
 * equal a hand-built `gifBytes`/`pngBytes` twin, whose tag region is all zeros.
 */

let seq = 0;
const tag = crypto.getRandomValues(new Uint8Array(6)).map((b) => b | 1);

/** Unique valid GIF — counter-derived width + per-file random tag. */
export function uniqueGif(): Uint8Array {
  const b = gifBytes(++seq, 1);
  b.set(tag, 10);
  return b;
}

/** Unique valid PNG — counter-derived width + per-file random tag. */
export function uniquePng(): Uint8Array {
  const b = pngBytes(++seq, 1);
  b.set(tag, 24);
  return b;
}
