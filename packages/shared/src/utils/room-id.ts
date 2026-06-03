import type { RoomId } from '../types/identifiers';

/**
 * Crockford base32, uppercase canonical, 12 chars (~60 bits). Gates BOTH the
 * client redirect and the worker edge pre-filter (`onBeforeConnect`) from one
 * source — a cheap DoS/format guard, NOT a security boundary (existence +
 * permission still resolve in the DO, §13).
 */
export const ROOM_ID_RE = /^[0-9A-HJKMNP-TV-Z]{12}$/;

// Crockford base32 alphabet — excludes I, L, O, U (ambiguity). 32 chars, so a
// `byte & 31` index is uniform.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ID_LEN = 12;

/**
 * Mint a fresh canonical room id from CSPRNG bytes. Client-mintable (runs in the
 * browser), which is what enables optimistic + offline room creation (§12/§13).
 */
export function generateRoomId(): RoomId {
  const bytes = new Uint8Array(ID_LEN);
  crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < ID_LEN; i++) out += ALPHABET[bytes[i] & 31];
  return out as RoomId;
}

/**
 * Uppercase-canonicalize + validate. Returns the brand or null. Crockford
 * ambiguity folding (I/L→1, O→0) is intentionally NOT applied — ids are reached
 * via copied canonical links, not retyped, so a malformed id redirects home (§13).
 */
export function normalizeRoomId(raw: string): RoomId | null {
  const up = raw.toUpperCase();
  return ROOM_ID_RE.test(up) ? (up as RoomId) : null;
}

/**
 * Brand a string already verified as a canonical room id at a trust boundary —
 * the room DO's `this.name` (gated by `ROOM_ID_RE` in `onBeforeConnect` before the
 * request ever reaches the DO) or a `ROOM_ID_RE`-validated queue/HTTP body. The
 * `asUserId` analog for rooms, minus the re-validation the boundary already did.
 * Never call on untrusted input — that's `normalizeRoomId`'s checked job.
 */
export function asRoomId(raw: string): RoomId {
  return raw as RoomId;
}
