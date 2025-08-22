/**
 * ULID generator for unique identifiers
 * Uses the official ulid package for production-quality ID generation
 * Critical for distributed systems causal consistency
 */

import { ulid as generateULID } from 'ulid';

/**
 * Generate a ULID (Universally Unique Lexicographically Sortable Identifier)
 * Format: TTTTTTTTTTRRRRRRRRRRRRRRR
 * - T: Timestamp (10 chars, millisecond precision)
 * - R: Randomness (16 chars, 80 bits)
 *
 * Properties:
 * - Lexicographically sortable
 * - 128-bit compatibility with UUID
 * - 1.21e+24 unique IDs per millisecond
 * - Case-insensitive and URL-safe (Crockford's base32)
 *
 * @param seedTime Optional timestamp in milliseconds
 * @returns A 26-character ULID string
 */
export function ulid(seedTime?: number): string {
  return generateULID(seedTime);
}

