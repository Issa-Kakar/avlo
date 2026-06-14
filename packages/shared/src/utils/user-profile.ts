/**
 * Identity display derivation — name + color from a `userId`, deterministic so a
 * user reads the same name/color across devices and the cookie (the `userId`) is
 * the sole source of truth (§2). The auth worker's `/me` derives both server-side,
 * so server and client always agree on a given id's name/color.
 */
import type { UserId } from '../types/identifiers';

const ADJECTIVES = [
  'Swift',
  'Bright',
  'Happy',
  'Clever',
  'Bold',
  'Calm',
  'Eager',
  'Gentle',
  'Keen',
  'Lively',
  'Noble',
  'Quick',
  'Sharp',
  'Wise',
  'Zesty',
] as const;

const ANIMALS = [
  'Fox',
  'Bear',
  'Wolf',
  'Eagle',
  'Owl',
  'Hawk',
  'Lion',
  'Tiger',
  'Lynx',
  'Otter',
  'Seal',
  'Whale',
  'Raven',
  'Swan',
  'Deer',
] as const;

/** The 16-color presence palette (§2). A `userId` maps to a stable index → one color. */
export const PRESENCE_COLORS = [
  '#E8915A', // warm orange
  '#5B8DEF', // blue
  '#E05D6F', // rose
  '#4CAF7D', // green
  '#C77DDB', // purple
  '#D4A843', // gold
  '#47B5B5', // teal
  '#E57BA1', // pink
  '#7E8CE0', // indigo
  '#6BBF6B', // lime
  '#C96B4F', // terra cotta
  '#5DADE2', // sky blue
  '#B5854E', // bronze
  '#8FBC5A', // olive
  '#DB7093', // hot pink
  '#7DAFCB', // steel blue
] as const;

// FNV-1a — small, stable, dependency-free 32-bit string hash.
function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Stable palette color for a userId (§2 — userId-hashed, identical across devices). */
export function colorForUserId(userId: UserId): string {
  return PRESENCE_COLORS[hash32(userId) % PRESENCE_COLORS.length];
}

/** Stable "Adjective Animal" display name for a userId — two independent hashes. */
export function nameForUserId(userId: UserId): string {
  const adj = ADJECTIVES[hash32(userId) % ADJECTIVES.length];
  const animal = ANIMALS[hash32(`${userId}~`) % ANIMALS.length];
  return `${adj} ${animal}`;
}

export interface UserProfile {
  name: string;
  color: string;
}

/** Full display profile for a userId — name + color, both deterministic. */
export function userProfileFor(userId: UserId): UserProfile {
  return { name: nameForUserId(userId), color: colorForUserId(userId) };
}
