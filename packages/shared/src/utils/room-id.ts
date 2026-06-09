import { customAlphabet } from 'nanoid';
import type { RoomId } from '../types/identifiers';

/**
 * Base62, case-SENSITIVE, 14 chars (~83 bits). Gates BOTH the client redirect
 * and the worker edge pre-filter (`onBeforeConnect`) from one source — a cheap
 * DoS/format guard, NOT a security boundary (existence + permission still
 * resolve in the DO, §13).
 */
export const ROOM_ID_RE = /^[0-9A-Za-z]{14}$/;

// nanoid customAlphabet — CSPRNG-backed, uniform over the 62-char alphabet.
const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const ID_LEN = 14;
const nano = customAlphabet(ALPHABET, ID_LEN);

/**
 * Mint a fresh room id. Client-mintable (runs in the browser), which is what
 * enables optimistic + offline room creation (§12/§13).
 */
export function generateRoomId(): RoomId {
  return nano() as RoomId;
}

/**
 * Validate + brand. Returns the brand or null. Base62 is case-sensitive, so
 * there is NO case folding — ids are reached via copied canonical links, not
 * retyped, so a malformed id redirects home (§13).
 */
export function normalizeRoomId(raw: string): RoomId | null {
  return ROOM_ID_RE.test(raw) ? (raw as RoomId) : null;
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
