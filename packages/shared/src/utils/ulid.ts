/**
 * Simple ULID generator for unique identifiers
 * This is a basic implementation - can be replaced with the ulid package later
 */

// ULID alphabet (Crockford's base32)
const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * Generate a ULID (Universally Unique Lexicographically Sortable Identifier)
 * Format: TTTTTTTTTTRRRRRRRRRRRRRRR
 * - T: Timestamp (10 chars)
 * - R: Randomness (16 chars)
 */
export function ulid(seedTime?: number): string {
  const time = seedTime ?? Date.now();
  const timestamp = encodeTime(time, 10);
  const randomness = encodeRandom(16);
  return timestamp + randomness;
}

function encodeTime(now: number, len: number): string {
  let str = '';
  for (let i = len - 1; i >= 0; i--) {
    const mod = now % 32;
    str = ENCODING[mod] + str;
    now = Math.floor(now / 32);
  }
  return str;
}

function encodeRandom(len: number): string {
  let str = '';
  for (let i = 0; i < len; i++) {
    str += ENCODING[Math.floor(Math.random() * 32)];
  }
  return str;
}